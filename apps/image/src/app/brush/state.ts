/**
 * Brush preset app state (PRODUCT-PLAN 6.3): the library (persisted by storage.ts), the picker scope and the Brush
 * Settings panel. Not document state, so no undo steps; document presets live in the document (documentPresets.ts).
 */

import { createStore, type StoreApi } from 'zustand/vanilla';
import type { EditorController } from '../../ui/controller';
import type { EditorSession } from '../../core/session';
import { getBrushSettings, setBrushSettings } from '../../core/brush/commands';
import { applyBrushPreset, settingsMatchPreset, type BrushPreset } from '../../core/brush/presets';
import { canEditDocumentBrushPresets, documentBrushPresets, editDocumentBrushPresets } from '../../core/brush/documentPresets';
import { indexedDbTipStore, loadBrushLibrary, saveBrushLibrary, type KeyValueStore } from './storage';

export type PresetScope = 'library' | 'document';

export interface BrushAppState {
  readonly library: readonly BrushPreset[];
  readonly scope: PresetScope;
  /** The preset last chosen (comma/period step from it even after the size was changed). */
  readonly activeId: string | null;
  readonly settingsOpen: boolean;
}

const stores = new WeakMap<EditorController, StoreApi<BrushAppState>>();

function localStore(): KeyValueStore | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export function brushState(controller: EditorController): StoreApi<BrushAppState> {
  let store = stores.get(controller);
  if (store) return store;
  const kv = localStore(), tips = indexedDbTipStore();
  const loaded = loadBrushLibrary(kv, tips);
  const created = createStore<BrushAppState>(() => ({ library: loaded.immediate, scope: 'library', activeId: null, settingsOpen: false }));
  store = created;
  let ready = false, saving: Promise<void> = Promise.resolve();
  void loaded.complete.then((library) => {
    // Edits made before the tips arrived win; presets only known on disk are added in their stored order.
    const current = created.getState().library;
    const known = new Set(current.map((preset) => preset.id));
    const merged = current === loaded.immediate ? library : [...current, ...library.filter((preset) => !known.has(preset.id))];
    ready = true;
    created.setState({ library: merged });
  });
  created.subscribe((state, previous) => {
    if (state.library === previous.library || !ready) return;
    const snapshot = state.library;
    saving = saving.then(() => saveBrushLibrary(snapshot, kv, tips)).catch(() => { /* storage full or unavailable: stays in memory */ });
  });
  stores.set(controller, created);
  return created;
}

/** Presets of a scope and how to change them (document: one undo step; library: app state). */
export function presetScope(controller: EditorController, scope: PresetScope): {
  presets: readonly BrushPreset[]; editable: boolean;
  update: (stepName: string, change: (presets: readonly BrushPreset[]) => readonly BrushPreset[]) => boolean;
} {
  const session = controller.session;
  if (scope === 'document') {
    return { presets: documentBrushPresets(session.document), editable: canEditDocumentBrushPresets(session),
      update: (stepName, change) => editDocumentBrushPresets(session, stepName, change) };
  }
  const store = brushState(controller);
  return { presets: store.getState().library, editable: true, update: (_stepName, change) => {
    const next = change(store.getState().library);
    if (next === store.getState().library) return false;
    store.setState({ library: next });
    return true;
  } };
}

export function choosePreset(controller: EditorController, session: EditorSession, preset: BrushPreset): void {
  setBrushSettings(session, applyBrushPreset(getBrushSettings(session), preset));
  brushState(controller).setState({ activeId: preset.id });
  controller.canvasView?.redraw();
}

/** Photoshop's , and . (previous/next preset; with Shift the first/last) over the picker's current scope. */
export function stepPreset(controller: EditorController, forward: boolean, toEnd: boolean): boolean {
  const session = controller.session, store = brushState(controller);
  const { presets } = presetScope(controller, store.getState().scope);
  if (!presets.length) return false;
  const settings = getBrushSettings(session);
  let index = presets.findIndex((preset) => settingsMatchPreset(settings, preset));
  if (index < 0) index = presets.findIndex((preset) => preset.id === store.getState().activeId);
  const next = toEnd ? (forward ? presets.length - 1 : 0)
    : index < 0 ? (forward ? 0 : presets.length - 1) : (index + (forward ? 1 : presets.length - 1)) % presets.length;
  choosePreset(controller, session, presets[next]!);
  return true;
}
