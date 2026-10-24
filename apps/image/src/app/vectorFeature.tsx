/**
 * Vector tools (PRODUCT-PLAN A5, 6.2, 6.6, M12): the Shape tool (U, Shift-U cycles Rectangle, Ellipse, Polygon, Star,
 * Line), the Pen (P) and Direct/Path Selection (A, Shift-A switches); Layer › Combine Shapes and Vector Mask, Select ›
 * Load Selection from Path, Edit › Fill Path and Stroke Path; vector-mask thumbnails in the Layers panel.
 *
 * Only this stub is in the start bundle: tool buttons and keys, menu entries, and the triggers that load the rest
 * (vector/ui.tsx with the CanvasKit runtime) when a vector tool is chosen or a document contains vector content. A
 * gesture made while that module loads is replayed once it is there.
 */

import styles from '../ui/editor.module.css';
import type { EditorController } from '../ui/controller';
import type { ToolContext, ToolHandler } from '../ui/canvas/tools';
import type { CanvasDocument } from '../core/document';
import { pendingUndoHandlers, type EditorSession } from '../core/session';
import type { VectorTool, VectorUi } from './vector/ui';

const VECTOR_TOOLS: readonly VectorTool[] = ['shape', 'pen', 'directSelect'];
const TITLES: Record<VectorTool, string> = { shape: 'Shape', pen: 'Pen', directSelect: 'Direct Selection' };

const withVectors = new WeakMap<CanvasDocument, boolean>();
function hasVectors(document: CanvasDocument | null): boolean {
  if (!document) return false;
  let value = withVectors.get(document);
  if (value === undefined) {
    value = document.layers.some((layer) => layer.kind === 'vector' || !!layer.vectorMask);
    withVectors.set(document, value);
  }
  return value;
}

const loading = new WeakMap<EditorController, Promise<VectorUi>>();
const loaded = new WeakMap<EditorController, VectorUi>();

function loadVectorUi(controller: EditorController): Promise<VectorUi> {
  let promise = loading.get(controller);
  if (!promise) {
    promise = import('./vector/ui').then(({ createVectorUi }) => {
      const ui = createVectorUi(controller);
      loaded.set(controller, ui);
      ui.track();
      for (const tab of controller.workspace.tabs) tab.session.notify('ui');
      return ui;
    });
    promise.catch((error: unknown) => controller.reportError('vector-tools-failed', error));
    loading.set(controller, promise);
  }
  return promise;
}

/** Stands in for a vector tool until its module has loaded; the pending gesture is replayed then. */
class VectorToolProxy implements ToolHandler {
  private pending: { kind: 'down' | 'move' | 'up'; context: ToolContext }[] = [];
  constructor(private readonly controller: EditorController, private readonly name: VectorTool) {}
  private get tool(): ToolHandler | null { return loaded.get(this.controller)?.tools[this.name] ?? null; }
  private queue(kind: 'down' | 'move' | 'up', context: ToolContext): void {
    if (kind === 'down') this.pending = [];
    this.pending.push({ kind, context });
    void loadVectorUi(this.controller).then((ui) => {
      const events = this.pending;
      this.pending = [];
      const tool = ui.tools[this.name];
      for (const event of events) tool[event.kind](event.context);
      events.at(-1)?.context.redraw();
    });
  }
  down(c: ToolContext): void { if (this.tool) this.tool.down(c); else this.queue('down', c); }
  move(c: ToolContext): void { if (this.tool) this.tool.move(c); else if (this.pending.length) this.queue('move', c); }
  up(c: ToolContext): void { if (this.tool) this.tool.up(c); else if (this.pending.length) this.queue('up', c); }
  cancel(session: EditorSession): void { this.pending = []; this.tool?.cancel(session); }
  hover(c: ToolContext): string { return this.tool?.hover?.(c) ?? (this.name === 'directSelect' ? 'default' : 'crosshair'); }
  overlayOnly(session: EditorSession): boolean { return this.tool?.overlayOnly?.(session) ?? true; }
}

export function installVector(controller: EditorController): void {
  const t = controller.t;
  for (const tool of VECTOR_TOOLS) controller.availableTools.add(tool);
  const proxies = Object.fromEntries(VECTOR_TOOLS.map((tool) => [tool, new VectorToolProxy(controller, tool)])) as Record<VectorTool, VectorToolProxy>;
  controller.canvasSetups.push((view) => {
    for (const tool of VECTOR_TOOLS) view.tools[tool] = proxies[tool];
    view.painters.push((context, session) => loaded.get(controller)?.paint(context, session, view.hoverPoint));
  });
  const previousIcon = controller.toolIcon;
  controller.toolIcon = (tool) => loaded.get(controller)?.toolIcon(tool) ?? previousIcon?.(tool) ?? null;
  for (const tool of VECTOR_TOOLS) {
    controller.contextBars[tool] = (session) => loaded.get(controller)?.bar(tool, session) ?? <span className={styles.headerTitle}>{t(TITLES[tool])}</span>;
    controller.statusHints[tool] = (session) => loaded.get(controller)?.statusHint(tool, session) ?? '';
  }
  for (const key of ['u', 'a'] as const) {
    controller.toolKeyHandlers[key] = (shift) => {
      const ui = loaded.get(controller);
      if (ui) ui.toolKey(key, shift);
      else { controller.session.selectTool(key === 'u' ? 'shape' : 'directSelect'); void loadVectorUi(controller); }
    };
  }
  controller.keyHandlers.push((event) => loaded.get(controller)?.key(event) ?? false);
  pendingUndoHandlers.push((session) => loaded.get(controller)?.undo(session) ?? false);

  // Menu commands: without vector content only a new vector mask applies; the module loads on first use.
  const maskable = () => {
    const session = controller.session, layer = session.activeLayer;
    return session.canEditLayers && session.selectedLayerIds.size === 1 && !!layer && layer.kind !== 'adjustment';
  };
  for (const key of ['combineUnite', 'combineSubtract', 'combineIntersect', 'combineExclude', 'mergeShapes', 'vectorMaskRevealAll', 'vectorMaskHideAll',
    'vectorMaskCurrentPath', 'vectorMaskToggle', 'vectorMaskDelete', 'selectionFromPath', 'fillPath', 'strokePath']) {
    controller.features[key] = {
      enabled: () => {
        const feature = loaded.get(controller)?.features[key];
        return feature ? feature.enabled() : (key === 'vectorMaskRevealAll' || key === 'vectorMaskHideAll') && maskable();
      },
      run: () => { void loadVectorUi(controller).then((ui) => ui.features[key]?.run()); },
    };
  }
  controller.layerThumbs.push((session, layer) => (layer.vectorMask ? loaded.get(controller)?.thumb(session, layer) ?? null : null));

  controller.workspace.subscribe(() => {
    const ui = loaded.get(controller);
    if (ui) { ui.track(); return; }
    if (loading.has(controller)) return;
    if (controller.workspace.tabs.some((tab) => VECTOR_TOOLS.includes(tab.session.tool as VectorTool) || hasVectors(tab.session.document))) {
      void loadVectorUi(controller);
    }
  });
  controller.renderPreparers.push(async (session) => {
    if (!hasVectors(session.document)) return;
    await (await loadVectorUi(controller)).prepare(session);
  });
}
