/**
 * Persistence of the app-wide brush preset library. The list (order, names, settings) lives in local storage; the
 * pixels of sampled tips (up to 2500² bytes each, beyond local storage quotas) live in IndexedDB. In the Tauri shell
 * both belong to the webview's data directory, so the library survives restarts on every host. Built-in presets
 * are stored by id (their tips are regenerated), so they can be renamed, reordered and deleted like user presets.
 */

import { openDB, type IDBPDatabase } from 'idb';
import { defaultBrushPresets, parseBrushPresets, serializeBrushPresets, validBrushPreset, type BrushPreset } from '../../core/brush/presets';
import { validTipImage, type BrushTipImage } from '../../core/brush/tip';

export const PRESET_LIST_KEY = 'fernwork.brushPresets';

export interface KeyValueStore { getItem(key: string): string | null; setItem(key: string, value: string): void }
export interface TipStore {
  get(id: string): Promise<BrushTipImage | null>;
  put(image: BrushTipImage): Promise<void>;
  delete(id: string): Promise<void>;
  ids(): Promise<string[]>;
}

/** Tips each store already holds, so a rename does not rewrite megabytes of tip pixels. */
const writtenTips = new WeakMap<TipStore, Set<string>>();

type StoredEntry = { readonly builtIn: string; readonly name: string } | { readonly preset: unknown; readonly tip?: { id: string; width: number; height: number } };
interface StoredList { readonly version: 1; readonly entries: readonly StoredEntry[] }

/** IndexedDB tip store; null where IndexedDB is unavailable. */
export function indexedDbTipStore(): TipStore | null {
  if (typeof indexedDB === 'undefined') return null;
  let database: Promise<IDBPDatabase> | null = null;
  const db = () => (database ??= openDB('fernwork-brush-tips', 1, { upgrade(value) { value.createObjectStore('tips'); } }));
  return {
    async get(id) {
      const value: unknown = await (await db()).get('tips', id);
      return validTipImage(value) ? value : null;
    },
    async put(image) { await (await db()).put('tips', { id: image.id, width: image.width, height: image.height, data: image.data }, image.id); },
    async delete(id) { await (await db()).delete('tips', id); },
    async ids() { return (await (await db()).getAllKeys('tips')).map(String); },
  };
}

export function memoryTipStore(): TipStore {
  const tips = new Map<string, BrushTipImage>();
  return {
    async get(id) { return tips.get(id) ?? null; },
    async put(image) { tips.set(image.id, image); },
    async delete(id) { tips.delete(id); },
    async ids() { return [...tips.keys()]; },
  };
}

function readList(store: KeyValueStore | null): StoredList | null {
  try {
    const text = store?.getItem(PRESET_LIST_KEY);
    if (!text) return null;
    const value = JSON.parse(text) as StoredList;
    return value && value.version === 1 && Array.isArray(value.entries) ? value : null;
  } catch { return null; }
}

/**
 * Loads the library. `immediate` has every preset whose data is already at hand (built-ins, round tips, inline
 * tips); `complete` resolves with the full list once sampled tips are read. A first run gets the default set.
 */
export function loadBrushLibrary(store: KeyValueStore | null, tips: TipStore | null): { immediate: BrushPreset[]; complete: Promise<BrushPreset[]> } {
  const list = readList(store);
  if (!list) { const all = [...defaultBrushPresets()]; return { immediate: all, complete: Promise.resolve(all) }; }
  const builtIns = new Map(defaultBrushPresets().map((preset) => [preset.id, preset]));
  const slots: (BrushPreset | Promise<BrushPreset | null> | null)[] = list.entries.map((entry) => {
    if ('builtIn' in entry) {
      const preset = builtIns.get(entry.builtIn);
      return preset && typeof entry.name === 'string' ? { ...preset, name: entry.name.slice(0, 256) } : null;
    }
    const parsed = parseBrushPresets({ format: 'fernwork-brush-presets', version: 1, presets: [entry.preset] })[0];
    if (parsed) return parsed;
    // A sampled tip kept outside the list: rebuild the preset once its pixels are read.
    const reference = entry.tip, raw = entry.preset as { tip?: { kind?: string; angle?: number; roundness?: number } } | null;
    if (!reference || !tips || raw?.tip?.kind !== 'sampled') return null;
    return tips.get(reference.id).then((image) => {
      if (!image) return null;
      const preset = { ...(raw as object), tip: { kind: 'sampled', angle: raw.tip!.angle, roundness: raw.tip!.roundness, image } } as BrushPreset;
      return validBrushPreset(preset) ? preset : null;
    }, () => null);
  });
  const immediate = slots.filter((slot): slot is BrushPreset => !!slot && !(slot instanceof Promise));
  const complete = Promise.all(slots).then((values) => values.filter((value): value is BrushPreset => !!value));
  return { immediate, complete };
}

/** Saves the library; sampled tips go to the tip store (inline in the list when there is none), unused tips are removed. */
export async function saveBrushLibrary(presets: readonly BrushPreset[], store: KeyValueStore | null, tips: TipStore | null): Promise<void> {
  const builtIns = new Map(defaultBrushPresets().map((preset) => [preset.id, preset]));
  const entries: StoredEntry[] = [];
  const keep = new Set<string>();
  for (const preset of presets) {
    const builtIn = builtIns.get(preset.id);
    if (builtIn && builtIn.tip === preset.tip && builtIn.diameter === preset.diameter && builtIn.hardness === preset.hardness
      && builtIn.opacity === preset.opacity && JSON.stringify(builtIn.dynamics) === JSON.stringify(preset.dynamics)) {
      entries.push({ builtIn: preset.id, name: preset.name });
      continue;
    }
    if (preset.tip.kind === 'sampled' && tips) {
      const image = preset.tip.image;
      keep.add(image.id);
      let stored = writtenTips.get(tips);
      if (!stored) { stored = new Set(); writtenTips.set(tips, stored); }
      if (!stored.has(image.id)) { await tips.put(image); stored.add(image.id); }
      const { image: _image, ...tip } = preset.tip;
      entries.push({ preset: { ...preset, tip }, tip: { id: image.id, width: image.width, height: image.height } });
    } else entries.push({ preset: serializeBrushPresets([preset]).presets[0] });
  }
  store?.setItem(PRESET_LIST_KEY, JSON.stringify({ version: 1, entries } satisfies StoredList));
  if (tips) for (const id of await tips.ids()) if (!keep.has(id)) { await tips.delete(id); writtenTips.get(tips)?.delete(id); }
}
