/**
 * Colour app state (PRODUCT-PLAN 6.1/6.4): recent colours, the swatch library, eyedropper options and panel choices.
 * None of it is document state, so none of it makes undo steps; it is kept per editor and persisted in local
 * storage (in the Tauri shell the webview's local storage lives in the app's data directory).
 */

import { createStore, type StoreApi } from 'zustand/vanilla';
import type { RGB } from '../../core/model/types';
import type { EditorController } from '../../ui/controller';
import { onColorUsed, pushRecentColor, validRecentColors } from '../../core/color/recent';
import { validSwatchGroups, normalizeSwatchGroups, newSwatch, type SwatchGroup } from '../../core/color/swatches';
import { DEFAULT_EYEDROPPER, type EyedropperSettings } from '../../core/color/sample';
import { rgbFrom8 } from '../../core/color/convert';

export type SliderModel = 'hsb' | 'rgb';
export type SwatchScope = 'document' | 'library';

export interface ColorAppState {
  readonly recent: readonly RGB[];
  readonly library: readonly SwatchGroup[];
  readonly eyedropper: EyedropperSettings;
  readonly sliderModel: SliderModel;
  readonly scope: SwatchScope;
  /** Which chip the Colour panel edits. */
  readonly target: 'foreground' | 'background';
  /** The next canvas click samples into the panel's target (screen eyedropper fallback). */
  readonly canvasPickArmed: boolean;
}

const KEYS = { recent: 'fernwork.recentColors', library: 'fernwork.swatchLibrary', eyedropper: 'fernwork.eyedropper', panel: 'fernwork.colorPanel' } as const;

function load<T>(key: string, valid: (value: unknown) => value is T): T | null {
  try {
    const text = globalThis.localStorage?.getItem(key);
    if (!text) return null;
    const value: unknown = JSON.parse(text);
    return valid(value) ? value : null;
  } catch { return null; }
}
function save(key: string, value: unknown): void {
  try { globalThis.localStorage?.setItem(key, JSON.stringify(value)); } catch { /* storage full or unavailable: stays in memory */ }
}

const validEyedropper = (value: unknown): value is EyedropperSettings => {
  const v = value as EyedropperSettings | null;
  return !!v && typeof v === 'object' && [1, 3, 5].includes(v.size) && typeof v.allLayers === 'boolean';
};
const validPanel = (value: unknown): value is { sliderModel: SliderModel; scope: SwatchScope } => {
  const v = value as { sliderModel?: unknown; scope?: unknown } | null;
  return !!v && typeof v === 'object' && (v.sliderModel === 'hsb' || v.sliderModel === 'rgb') && (v.scope === 'document' || v.scope === 'library');
};

/** First-run library: Photoshop-like basics (named in the UI language of the first run; user data afterwards). */
export function defaultLibrary(t: (text: string) => string): SwatchGroup[] {
  const basics: [string, number, number, number][] = [
    ['Black', 0, 0, 0], ['White', 255, 255, 255], ['Dark Gray', 64, 64, 64], ['Gray', 128, 128, 128], ['Light Gray', 192, 192, 192],
    ['Red', 255, 0, 0], ['Orange', 255, 128, 0], ['Yellow', 255, 255, 0], ['Green', 0, 166, 81], ['Cyan', 0, 174, 239],
    ['Blue', 0, 84, 166], ['Magenta', 236, 0, 140],
  ];
  return [{ id: 'basic-colors', name: t('Basic Colors'), swatches: basics.map(([name, r, g, b]) => newSwatch(rgbFrom8(r, g, b), t(name))) }];
}

const stores = new WeakMap<EditorController, StoreApi<ColorAppState>>();

export function colorState(controller: EditorController): StoreApi<ColorAppState> {
  let store = stores.get(controller);
  if (store) return store;
  const panel = load(KEYS.panel, validPanel);
  const library = load(KEYS.library, validSwatchGroups);
  store = createStore<ColorAppState>(() => ({
    recent: load(KEYS.recent, validRecentColors) ?? [],
    library: library ? normalizeSwatchGroups(library) : defaultLibrary(controller.t),
    eyedropper: load(KEYS.eyedropper, validEyedropper) ?? DEFAULT_EYEDROPPER,
    sliderModel: panel?.sliderModel ?? 'hsb',
    scope: panel?.scope ?? 'document',
    target: 'foreground',
    canvasPickArmed: false,
  }));
  const persisted = store;
  store.subscribe((state, previous) => {
    if (state.recent !== previous.recent) save(KEYS.recent, state.recent);
    if (state.library !== previous.library) save(KEYS.library, state.library);
    if (state.eyedropper !== previous.eyedropper) save(KEYS.eyedropper, state.eyedropper);
    if (state.sliderModel !== previous.sliderModel || state.scope !== previous.scope) save(KEYS.panel, { sliderModel: state.sliderModel, scope: state.scope });
  });
  // Colours applied to this editor's documents become recent colours. The listener holds the editor weakly, so a
  // destroyed editor is not kept alive by the engine's listener list.
  const editor = new WeakRef(controller);
  const off = onColorUsed((source, color) => {
    const current = editor.deref();
    if (!current) { off(); return; }
    if (!current.workspace.tabs.some((tab) => tab.session === source)) return;
    const recent = pushRecentColor(persisted.getState().recent, color);
    if (recent !== persisted.getState().recent) persisted.setState({ recent });
  });
  stores.set(controller, store);
  return store;
}
