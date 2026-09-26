/**
 * Lazily loaded half of the Type tool (textFeature.tsx loads it): the engine runtime, the canvas editor and the
 * React controls. One instance per editor controller.
 */

import type { EditorController } from '../../ui/controller';
import type { EditorSession } from '../../core/session';
import type { ToolHandler } from '../../ui/canvas/tools';
import { TextRuntime } from './runtime';
import { TextEditor } from './editor';
import { MissingFontsPanel, TextControls } from './controls';

export interface TextUi {
  readonly runtime: TextRuntime;
  readonly editor: TextEditor;
  readonly tool: ToolHandler;
  paint(context: CanvasRenderingContext2D, session: EditorSession): void;
  /** A double-click at a canvas point (view points) with another tool. */
  doubleClick(point: { x: number; y: number }): void;
  /** Edits a text layer with the Type tool; 'all' selects its whole text (double-click on the thumbnail). */
  editLayer(session: EditorSession, layerId: string, selection: number | 'all'): void;
  /** Finishes loading fonts and shaping before pixels are read (export, merges). */
  settle(session: EditorSession): Promise<void>;
}

const instances = new WeakMap<EditorController, TextUi>();

export function createTextUi(controller: EditorController): TextUi {
  const existing = instances.get(controller);
  if (existing) return existing;
  let reported = false;
  // Installed fonts only where the profile maps a font feature to the host's FontHost (A0/A10).
  const fonts = Object.values(controller.profile.hostFeatures).includes('fonts') ? controller.capabilities.fonts ?? null : null;
  const runtime = new TextRuntime(fonts, (session) => session.notify('ui'), (error) => {
    if (reported) return;
    reported = true;
    controller.reportError('text-engine-failed', error, controller.t('Text can’t be drawn'));
  });
  const editor = new TextEditor(controller, runtime);
  const watched = new Map<EditorSession, () => void>();
  const watch = () => {
    const open = new Set(controller.workspace.tabs.map((tab) => tab.session));
    for (const session of open) {
      if (!watched.has(session)) watched.set(session, session.subscribe((kind) => { if (kind !== 'view') editor.check(); }));
    }
    // Closed tabs give their shaped layouts (CanvasKit memory) back.
    for (const [session, unsubscribe] of watched) {
      if (open.has(session)) continue;
      unsubscribe();
      watched.delete(session);
      runtime.release(session);
    }
    editor.check();
  };
  controller.workspace.subscribe(watch);
  watch();
  // The controls show whether the engine is ready; every tab redraws its text once it is.
  void runtime.ready.then(() => { for (const tab of controller.workspace.tabs) tab.session.notify('ui'); });
  let accent: string | null = null;
  const ui: TextUi = {
    runtime, editor, tool: editor.tool,
    paint: (context, session) => {
      accent ??= getComputedStyle(context.canvas).getPropertyValue('--cmp-canvas-accent').trim() || '#0a84ff';
      editor.paint(context, session, accent);
    },
    doubleClick: (point) => editor.doubleClick(point),
    editLayer: (session, layerId, selection) => {
      if (session.tool !== 'text') session.selectTool('text');
      editor.startExisting(session, layerId, selection);
      editor.focusInput();
    },
    settle: (session) => runtime.settle(session),
  };
  instances.set(controller, ui);
  return ui;
}

export function TextBar({ controller }: { controller: EditorController }) {
  return <TextControls controller={controller} ui={createTextUi(controller)} />;
}

export function TextPanels({ controller }: { controller: EditorController }) {
  const ui = instances.get(controller);
  return ui ? <MissingFontsPanel controller={controller} ui={ui} /> : null;
}
