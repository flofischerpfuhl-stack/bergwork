/** UI-only state (dialogs, sheets, panel sizes). Document state lives in the core session. */

import { createStore } from 'zustand/vanilla';

export type Dialog =
  /** File > Export As… (the one export dialog). */
  | { kind: 'export' }
  | { kind: 'proofSetup' }
  | { kind: 'alert'; title: string; message: string }
  | { kind: 'confirm'; title: string; message: string; buttons: { label: string; value: string; role?: 'cancel' | 'default' | 'destructive' }[]; resolve: (value: string) => void }
  | { kind: 'rename'; layerId: string }
  | { kind: 'canvasSize' }
  | { kind: 'imageSize' }
  | { kind: 'newCanvas' }
  /** A dialog registered by a feature module under `controller.dialogs[name]`. */
  | { kind: 'custom'; name: string };

export interface UiState {
  /** Incremented when a lazy feature extends controller-owned UI registries. */
  featureRevision: number;
  dialog: Dialog | null;
  openMenu: string | null;
  layersWidth: number;
  /** Phone layout: which bottom sheet is open. */
  sheet: 'layers' | 'properties' | null;
  compact: boolean;
  spaceHeld: boolean;
  pointerOverCanvas: boolean;
  /** Which tab of the side panel shows: layers, history, or a module's tab (controller.sidePanels, e.g. 'color'). */
  sidePanel: 'layers' | 'history' | (string & {});
}

export type UiStore = ReturnType<typeof createUiStore>;

export function createUiStore() {
  const saved = Number(globalThis.localStorage?.getItem('compositor.layersPanelWidth') ?? '');
  return createStore<UiState>(() => ({
    featureRevision: 0,
    dialog: null,
    openMenu: null,
    layersWidth: Number.isFinite(saved) && saved >= 202 && saved <= 352 ? saved : 252,
    sheet: null,
    compact: false,
    spaceHeld: false,
    pointerOverCanvas: false,
    sidePanel: 'layers',
  }));
}
