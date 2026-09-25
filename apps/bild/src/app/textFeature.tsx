/**
 * The Type tool (T; PRODUCT-PLAN A5, 6.6, P11). Only this small part is in the start bundle: the tool button and key,
 * its context bar and panel slots, and the triggers that load the rest (text/textUi.tsx with the CanvasKit engine)
 * when the tool is chosen or a document contains text.
 */

import { lazy, Suspense } from 'react';
import styles from '../ui/editor.module.css';
import type { EditorController } from '../ui/controller';
import type { ToolContext, ToolHandler } from '../ui/canvas/tools';
import type { CanvasDocument } from '../core/document';
import type { EditorSession } from '../core/session';
import type { TextUi } from './text/textUi';

const withText = new WeakMap<CanvasDocument, boolean>();
function hasText(document: CanvasDocument | null): boolean {
  if (!document) return false;
  let value = withText.get(document);
  if (value === undefined) { value = document.layers.some((layer) => layer.kind === 'text'); withText.set(document, value); }
  return value;
}

const loading = new WeakMap<EditorController, Promise<TextUi>>();
const loaded = new WeakMap<EditorController, TextUi>();

function loadTextUi(controller: EditorController): Promise<TextUi> {
  let promise = loading.get(controller);
  if (!promise) {
    promise = import('./text/textUi').then(({ createTextUi }) => {
      const ui = createTextUi(controller);
      loaded.set(controller, ui);
      controller.session.notify('ui');
      return ui;
    });
    promise.catch((error: unknown) => controller.reportError('text-tool-failed', error));
    loading.set(controller, promise);
  }
  return promise;
}

const LazyBar = lazy(() => import('./text/textUi').then((module) => ({ default: module.TextBar })));
const LazyPanels = lazy(() => import('./text/textUi').then((module) => ({ default: module.TextPanels })));

/** Stands in for the Type tool until its module has loaded (the tool choice itself starts loading it). */
class TextToolProxy implements ToolHandler {
  constructor(private readonly controller: EditorController) {}
  private get tool(): ToolHandler | null { return loaded.get(this.controller)?.tool ?? null; }
  down(c: ToolContext): void { if (this.tool) this.tool.down(c); else void loadTextUi(this.controller); }
  move(c: ToolContext): void { this.tool?.move(c); }
  up(c: ToolContext): void { this.tool?.up(c); }
  cancel(session: EditorSession): void { this.tool?.cancel(session); }
  hover(c: ToolContext): string { return this.tool?.hover?.(c) ?? 'text'; }
  overlayOnly(session: EditorSession): boolean { return this.tool?.overlayOnly?.(session) ?? true; }
}

export function installText(controller: EditorController): void {
  controller.availableTools.add('text');
  const t = controller.t;
  const proxy = new TextToolProxy(controller);
  controller.canvasSetups.push((view) => {
    view.tools.text = proxy;
    view.painters.push((context, session) => loaded.get(controller)?.paint(context, session));
    view.element.addEventListener('dblclick', (event) => {
      const ui = loaded.get(controller);
      if (!ui || event.button !== 0) return;
      const rect = view.element.getBoundingClientRect();
      ui.doubleClick({ x: event.clientX - rect.left, y: event.clientY - rect.top });
    });
  });
  controller.contextBars.text = () => (
    <Suspense fallback={<span className={styles.headerTitle}>{t('Text')}</span>}><LazyBar controller={controller} /></Suspense>
  );
  controller.panels.push(() => (loaded.has(controller) ? <Suspense fallback={null}><LazyPanels controller={controller} /></Suspense> : null));
  controller.statusHints.text = () => t('Click to add text · Click a path to type along it · Drag for a text box · Click text to edit it · Escape or ⌘Enter commits');
  controller.keyHandlers.push((event) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.key.toLowerCase() !== 't' || !controller.availableTools.has('text')) return false;
    if (!event.repeat) controller.session.selectTool('text');
    return true;
  });
  controller.features.editActiveText = {
    enabled: () => controller.session.activeLayer?.kind === 'text',
    run: () => {
      const session = controller.session, id = session.activeLayerId;
      if (id) void loadTextUi(controller).then((ui) => ui.editLayer(session, id, 'all'));
    },
  };
  // The engine loads with the tool or with the first document that contains text; exports wait for its shaping.
  controller.workspace.subscribe(() => {
    if (loading.has(controller)) return;
    if (controller.workspace.tabs.some((tab) => tab.session.tool === 'text' || hasText(tab.session.document))) void loadTextUi(controller);
  });
  controller.renderPreparers.push(async (session) => {
    if (!hasText(session.document)) return;
    await (await loadTextUi(controller)).settle(session);
  });
}
