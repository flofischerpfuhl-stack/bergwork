/** UI-only state (dialogs, sheets, panel sizes). Document state lives in the core session. */

import { createStore } from 'zustand/vanilla';

export type Dialog =
  /** File > Export As… (the one export dialog). */
  | { kind: 'export' }
  | { kind: 'proofSetup' }
  | { kind: 'about' }
  | { kind: 'licenses' }
  | { kind: 'alert'; title: string; message: string }
  | { kind: 'confirm'; title: string; message: string; buttons: { label: string; value: string; role?: 'cancel' | 'default' | 'destructive' }[]; resolve: (value: string) => void }
  | { kind: 'rename'; layerId: string }
  | { kind: 'canvasSize' }
  | { kind: 'imageSize' }
  | { kind: 'newCanvas' }
  /** View > Search Commands… (Compositor 1.4.6). */
  | { kind: 'commandPalette' }
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
  /** Tab (Photoshop): tools, options bar, panels and status bar hidden; only the top bar floats over the canvas. */
  chromeHidden: boolean;
  /** The floating panel stack on the right (Layers, History, Colour…); Shift+Tab or the top bar's Layers button. */
  panelsOpen: boolean;
  /** Current colour theme (mount option, overridden by the host page's html[data-theme]). */
  theme: 'dark' | 'light';
}

/** Width limits of the floating panel stack; the tab rail takes 48 px (Builder side panels are 320 px). */
export const LAYERS_WIDTH_MIN = 268;
export const LAYERS_WIDTH_MAX = 440;

export type UiStore = ReturnType<typeof createUiStore>;

export function createUiStore() {
  const saved = Number(globalThis.localStorage?.getItem('compositor.layersPanelWidth') ?? '');
  let panelsOpen = true;
  try { panelsOpen = globalThis.localStorage?.getItem('compositor.panelsOpen') !== 'false'; } catch { /* storage blocked */ }
  return createStore<UiState>(() => ({
    featureRevision: 0,
    dialog: null,
    openMenu: null,
    layersWidth: Number.isFinite(saved) && saved >= LAYERS_WIDTH_MIN && saved <= LAYERS_WIDTH_MAX ? saved : 320,
    sheet: null,
    compact: false,
    spaceHeld: false,
    pointerOverCanvas: false,
    sidePanel: 'layers',
    chromeHidden: false,
    panelsOpen,
    theme: 'dark',
  }));
}
