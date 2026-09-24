/**
 * The lazily loaded part of the vector tools (vectorFeature.tsx holds the start-bundle stubs): the Shape, Pen and
 * Direct/Path Selection tools, their context bars, overlay, key handling and menu commands, vector-mask thumbnails, and
 * the CanvasKit runtime that draws vector layers and masks (runtime.ts).
 */

import { useEffect, useRef, type ReactNode } from 'react';
import styles from '../../ui/editor.module.css';
import type { EditorController } from '../../ui/controller';
import type { FeatureRegistry } from '../../ui/menus';
import type { IconName } from '../../ui/icons';
import type { ToolHandler } from '../../ui/canvas/tools';
import { CanvasThumbnail, fittedSize } from '../../ui/Thumbnail';
import type { EditorSession } from '../../core/session';
import type { Layer } from '../../core/document';
import type { Point } from '../../core/geometry';
import { getBrushSettings } from '../../core/brush';
import { mergeVectorLayers, type VectorBooleanOperation } from '../../core/vector';
import type { TextEngine } from '../../text';
import { VectorRuntime } from './runtime';
import { DirectSelectTool, PenTool, ShapeTool, commitPen, deleteSelectedAnchors, nudgeSelectedAnchors, paintVectorOverlay, type VectorToolHost } from './tools';
import { DirectSelectBar, PenBar, ShapeBar, type VectorBarCommands } from './controls';
import {
  canCombineShapes, combinableLayers, combineShapes, currentPathLayer, documentPaths, emptyMask, loadSelectionFromPaths, maskFromPath,
  paintPathsOnLayer, selectionSourcePaths, setVectorMaskOf,
} from './edits';
import { SHAPE_KINDS, pathTarget, selectedAnchors, solid, strokeOf, vectorState } from './state';

export type VectorTool = 'shape' | 'pen' | 'directSelect';

export interface VectorUi {
  readonly tools: Record<VectorTool, ToolHandler>;
  readonly features: FeatureRegistry;
  paint(context: CanvasRenderingContext2D, session: EditorSession, hover: Point | null): void;
  bar(tool: VectorTool, session: EditorSession): ReactNode;
  statusHint(tool: VectorTool, session: EditorSession): string;
  toolIcon(tool: string): IconName | null;
  toolKey(key: 'u' | 'a', shift: boolean): void;
  key(event: KeyboardEvent): boolean;
  thumb(session: EditorSession, layer: Layer): ReactNode;
  track(): void;
  prepare(session: EditorSession): Promise<void>;
  undo(session: EditorSession): boolean;
}

function VectorMaskThumb({ controller, runtime, session, layer }: { controller: EditorController; runtime: VectorRuntime; session: EditorSession; layer: Layer }) {
  const t = controller.t;
  const ref = useRef<HTMLDivElement>(null);
  const state = vectorState(session);
  const targeted = session.activeLayerId === layer.id && session.selectedLayerIds.size === 1 && (state.maskTarget === layer.id || layer.kind !== 'vector');
  // Choosing the layer's own thumbnail (or its raster mask) targets it instead of the vector mask.
  useEffect(() => {
    const row = ref.current?.closest('[data-testid="layer-row"]');
    if (!row) return;
    const down = (event: Event) => {
      const target = event.target as Element;
      if (target.closest('[data-thumb]') && !target.closest('[data-vector-mask-thumb]') && state.maskTarget === layer.id) state.maskTarget = null;
    };
    row.addEventListener('pointerdown', down, true);
    return () => row.removeEventListener('pointerdown', down, true);
  }, [layer.id, state]);
  const mask = layer.vectorMask!;
  const canvas = { width: session.document!.width, height: session.document!.height };
  return (
    <div ref={ref} className={styles.maskSlot} style={{ marginLeft: 5 }}>
      <button type="button" data-thumb data-vector-mask-thumb className={`${styles.thumb} ${targeted && state.maskTarget === layer.id ? styles.thumbTarget : ''}`}
        style={fittedSize(canvas, 30)} aria-label={`${t('Select vector mask')}: ${layer.name}`} data-testid="vector-mask-thumb"
        title={t('Select the vector mask to edit its path; Shift-click to enable or disable it')}
        onClick={(event) => {
          if (event.shiftKey) {
            setVectorMaskOf(session, layer.id, { ...mask, enabled: !mask.enabled }, mask.enabled ? 'Disable Vector Mask' : 'Enable Vector Mask');
            return;
          }
          session.selectLayer(layer.id);
          state.maskTarget = layer.id;
          session.notify('ui');
          session.notify('overlay');
        }}>
        <CanvasThumbnail raster={runtime.maskThumbnail(layer)} transform={layer.transform} canvasSize={canvas} box={30} mask />
      </button>
      {!mask.enabled ? <span className={styles.maskDisabled}>╱</span> : null}
    </div>
  );
}

export function createVectorUi(controller: EditorController): VectorUi {
  const t = controller.t;
  const runtime = new VectorRuntime(() => {
    for (const tab of controller.workspace.tabs) tab.session.notify('document');
  }, (error) => controller.reportError('vector-engine-failed', error));
  const host: VectorToolHost = { t, engine: () => runtime.engine, loadEngine: () => runtime.load() };
  const withEngine = (run: (engine: TextEngine) => void) => {
    if (runtime.engine) run(runtime.engine);
    else void runtime.load().then((engine) => { if (engine) run(engine); });
  };

  const tools: Record<VectorTool, ToolHandler> = { shape: new ShapeTool(host), directSelect: new DirectSelectTool(host), pen: new PenTool(host, new DirectSelectTool(host)) };

  // MARK: Commands

  const f: FeatureRegistry = {};
  const combineOperations: Record<VectorBooleanOperation, string> = { unite: 'combineUnite', subtract: 'combineSubtract', intersect: 'combineIntersect', exclude: 'combineExclude' };
  const combineNames: Record<VectorBooleanOperation, string> = { unite: 'Unite Shapes', subtract: 'Subtract Front Shape', intersect: 'Intersect Shape Areas', exclude: 'Exclude Overlapping Shapes' };
  const canMerge = () => {
    const session = controller.session, layers = combinableLayers(session);
    return session.canEditLayers && layers.length >= 2 && layers.length === session.selectedLayerIds.size;
  };
  const commands: VectorBarCommands = {
    combine: (operation) => withEngine((engine) => { combineShapes(controller.session, engine, operation, combineNames[operation]); }),
    canCombine: () => canCombineShapes(controller.session),
    merge: () => { const session = controller.session; mergeVectorLayers(session, combinableLayers(session).map((layer) => layer.id), session.label('Merged Shapes')); },
    canMerge,
  };
  for (const [operation, key] of Object.entries(combineOperations) as [VectorBooleanOperation, string][]) {
    f[key] = { enabled: commands.canCombine, run: () => commands.combine(operation) };
  }
  f.mergeShapes = { enabled: canMerge, run: commands.merge };

  const maskable = () => {
    const session = controller.session, layer = session.activeLayer;
    return session.canEditLayers && session.selectedLayerIds.size === 1 && !!layer && layer.kind !== 'adjustment';
  };
  const addMask = (inverted: boolean) => {
    const session = controller.session, layer = session.activeLayer;
    if (!layer) return;
    if (setVectorMaskOf(session, layer.id, { ...emptyMask(inverted), paths: layer.vectorMask?.paths ?? [] }, 'Add Vector Mask')) {
      vectorState(session).maskTarget = layer.id;
      withEngine(() => undefined);
    }
  };
  f.vectorMaskRevealAll = { enabled: maskable, run: () => addMask(true) };
  f.vectorMaskHideAll = { enabled: maskable, run: () => addMask(false) };
  f.vectorMaskCurrentPath = {
    enabled: () => maskable() && !!currentPathLayer(controller.session, controller.session.activeLayerId),
    run: () => {
      const session = controller.session, layer = session.activeLayer, source = currentPathLayer(session, session.activeLayerId);
      if (layer && source && maskFromPath(session, layer.id, source, 'Add Vector Mask')) vectorState(session).maskTarget = layer.id;
    },
  };
  f.vectorMaskToggle = {
    enabled: () => maskable() && !!controller.session.activeLayer?.vectorMask,
    run: () => {
      const session = controller.session, layer = session.activeLayer, mask = layer?.vectorMask;
      if (layer && mask) setVectorMaskOf(session, layer.id, { ...mask, enabled: !mask.enabled }, mask.enabled ? 'Disable Vector Mask' : 'Enable Vector Mask');
    },
  };
  f.vectorMaskDelete = {
    enabled: () => maskable() && !!controller.session.activeLayer?.vectorMask,
    run: () => {
      const session = controller.session, layer = session.activeLayer;
      if (layer && setVectorMaskOf(session, layer.id, null, 'Delete Vector Mask')) vectorState(session).maskTarget = null;
    },
  };
  f.selectionFromPath = {
    enabled: () => controller.session.canEditLayers && !!selectionSourcePaths(controller.session, pathTarget(controller.session)),
    run: () => withEngine((engine) => {
      const session = controller.session, paths = selectionSourcePaths(session, pathTarget(session));
      if (paths) loadSelectionFromPaths(session, engine, paths, 'Load Selection from Path');
    }),
  };
  const paintable = () => {
    const session = controller.session, layer = session.activeLayer;
    return session.canEditLayers && session.selectedLayerIds.size === 1 && layer?.kind === 'pixel' && !session.isMaskSelected && !!currentPathLayer(session, layer.id);
  };
  const paintPath = (stroke: boolean) => withEngine((engine) => {
    const session = controller.session, layer = session.activeLayer, source = currentPathLayer(session, layer?.id ?? null);
    if (!layer || !source) return;
    const color = solid(session.foregroundColor), width = Math.max(1, getBrushSettings(session).diameter);
    const style = stroke
      ? { schemaVersion: 1 as const, fill: null, stroke: strokeOf(color, { ...vectorState(session).stroke, width, alignment: 'center', cap: 'round', join: 'round', dash: [],
        startMarker: 'none', endMarker: 'none' }) }
      : { schemaVersion: 1 as const, fill: color, stroke: null };
    paintPathsOnLayer(session, engine, layer.id, documentPaths(source), style, stroke ? 'Stroke Path' : 'Fill Path');
  });
  f.fillPath = { enabled: paintable, run: () => paintPath(false) };
  f.strokePath = { enabled: paintable, run: () => paintPath(true) };

  // MARK: Bars, hints and keys

  const hints = {} as Record<VectorTool, (s: EditorSession) => string>;
  hints.shape = (s) => `${t('Drag to draw a shape')} · ${t(vectorState(s).kind === 'Line' ? 'Shift snaps to 45°' : 'Shift constrains proportions')} · ${t('Option from center · Shift-U switches · Escape cancel · Space to pan')}`;
  hints.pen = () => t('Click for corners · Drag for curves · Click the first point to close · Option-drag breaks a handle · ⌘ Direct Selection · Enter finishes');
  hints.directSelect = (s) => (vectorState(s).selectMode === 'path'
    ? t('Click a path to select it · Drag to move it · Delete removes it · Shift-A Direct Selection')
    : t('Drag anchors or handles · Drag a frame to select anchors · Option-click converts a point · Delete removes anchors · Shift-A Path Selection'));

  const keyU = (shift: boolean) => {
    const session = controller.session, state = vectorState(session);
    if (shift && session.tool === 'shape') {
      state.kind = SHAPE_KINDS[(SHAPE_KINDS.indexOf(state.kind) + 1) % SHAPE_KINDS.length]!;
      state.shapeDraft = null;
      session.notify('ui');
    } else session.selectTool('shape');
  };
  const keyA = (shift: boolean) => {
    const session = controller.session, state = vectorState(session);
    if (shift && session.tool === 'directSelect') { state.selectMode = state.selectMode === 'direct' ? 'path' : 'direct'; session.notify('ui'); }
    else session.selectTool('directSelect');
  };
  const key = (event: KeyboardEvent): boolean => {
    const session = controller.session;
    if (event.metaKey || event.ctrlKey || event.altKey) return false;
    const state = vectorState(session);
    if ((event.key === 'Enter' || event.key === 'Escape') && state.pen) { commitPen(session, host); return true; }
    if ((event.key === 'Delete' || event.key === 'Backspace') && (session.tool === 'directSelect' || session.tool === 'pen') && selectedAnchors(session).size) {
      return deleteSelectedAnchors(session);
    }
    if (session.tool === 'directSelect' && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) && selectedAnchors(session).size) {
      const step = event.shiftKey ? 10 : 1;
      return nudgeSelectedAnchors(session, event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0,
        event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0);
    }
    return false;
  };

  // MARK: Session tracking

  const lastTools = new WeakMap<EditorSession, string>();
  const track = () => {
    for (const tab of controller.workspace.tabs) {
      const session = tab.session, state = vectorState(session);
      // Another tool finishes the Pen's path (Photoshop keeps it).
      if (lastTools.get(session) === 'pen' && session.tool !== 'pen' && state.pen) commitPen(session, host);
      lastTools.set(session, session.tool);
      const active = session.activeLayer;
      if (state.maskTarget && (session.activeLayerId !== state.maskTarget || !active?.vectorMask)) state.maskTarget = null;
      if (active?.kind === 'vector' && session.selectedLayerIds.size === 1) state.pathLayerId = active.id;
      if (!runtime.engine && (session.tool === 'shape' || session.tool === 'pen' || session.tool === 'directSelect' || runtime.needs(session))) void runtime.load();
    }
  };
  // Undo while drawing with the Pen removes the last anchor (Photoshop).
  const undo = (session: EditorSession): boolean => {
    const state = vectorState(session), pen = state.pen;
    if (!pen) return false;
    pen.points.pop();
    pen.closed = false;
    if (!pen.points.length) state.pen = null;
    session.notify('overlay');
    return true;
  };
  return {
    tools, features: f, undo, track, key,
    paint: (context, session, hover) => paintVectorOverlay(context, session, hover),
    bar: (tool, session) => (tool === 'shape' ? <ShapeBar controller={controller} session={session} />
      : tool === 'pen' ? <PenBar controller={controller} session={session} /> : <DirectSelectBar controller={controller} session={session} commands={commands} />),
    statusHint: (tool, session) => hints[tool](session),
    toolIcon: (tool) => (tool === 'directSelect' && vectorState(controller.session).selectMode === 'path' ? 'pathSelect' : null),
    toolKey: (name, shift) => (name === 'u' ? keyU(shift) : keyA(shift)),
    thumb: (session, layer) => (layer.vectorMask && session.document
      ? <VectorMaskThumb controller={controller} runtime={runtime} session={session} layer={layer} /> : null),
    prepare: async (session) => { if (runtime.needs(session)) await runtime.load(); },
  };
}
