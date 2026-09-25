/**
 * Canvas tool handlers. Each tool turns pointer gestures into session commands; the handlers are
 * ports of EditorCanvas.swift's mouseDown/mouseDragged/mouseUp branches.
 */

import { dragCorners, dragUpdated, HANDLES, radians, roundedTransform, unitPoint, type Point, type Rect, type TransformDrag } from '../../core/geometry';
import { effectiveVisibleIds, renderLayers } from '../../core/document';
import { containsPoint } from '../../core/geometry';
import type { EditorSession, Tool } from '../../core/session';
import type { CanvasViewport } from '../../core/viewport';

export interface Modifiers {
  shift: boolean;
  /** Option / Alt. */
  option: boolean;
  /** Command on macOS, Control elsewhere. */
  command: boolean;
  /** Control on macOS only (Command elsewhere is taken). */
  control: boolean;
}

export interface ToolContext {
  readonly session: EditorSession;
  /** Pointer position in view points. */
  readonly point: Point;
  /** Pointer position in document pixels. */
  readonly pixel: Point;
  readonly modifiers: Modifiers;
  readonly pointerType: string;
  /** Pen pressure 0…1, or null for mouse and touch. */
  readonly pressure: number | null;
  /** Touch alternative for Cmd-drag distortion (context-bar toggle). */
  readonly distortArmed: boolean;
  redraw(): void;
  setCursor(cursor: string): void;
}

export interface ToolHandler {
  down(context: ToolContext): void;
  move(context: ToolContext): void;
  up(context: ToolContext): void;
  cancel(session: EditorSession): void;
  /** Document-pixel input bounds for one pointer sample, including the tool kernel's read margin. */
  hydrationBounds?(context: ToolContext): Rect;
  /** Cursor while hovering without a button pressed. */
  hover?(context: ToolContext): string;
  /** Whether the last move changed only the overlay, so the composite need not be redrawn (CropTests.cropDraggingRedrawsOnlyTheOverlay). */
  overlayOnly?(session: EditorSession): boolean;
  /** Whether the current gesture scrolls the canvas when the pointer nears its edge (EditorCanvas.updateMarqueeAutoscroll). */
  autoscrolls?(session: EditorSession): boolean;
}

// MARK: Transform overlay geometry (TransformOverlay.swift)

export interface OverlayGeometry {
  handles: Point[];
  rotationHandle: Point;
  showsRotation: boolean;
}

export function overlayGeometry(session: EditorSession): OverlayGeometry | null {
  const document = session.document;
  if (session.tool !== 'move' || !(session.showsTransformControls || session.transformEdit?.persistent) || !document) return null;
  const view = (p: Point) => session.viewport.viewPoint(p, document);
  const fromCorners = (corners: readonly Point[]): OverlayGeometry => {
    const v = corners.map(view);
    const mid = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    const handles = [v[0]!, mid(v[0]!, v[1]!), v[1]!, mid(v[1]!, v[2]!), v[2]!, mid(v[2]!, v[3]!), v[3]!, mid(v[3]!, v[0]!)];
    return { handles, rotationHandle: handles[1]!, showsRotation: false };
  };
  const fromTransform = (t: Parameters<typeof unitPoint>[0]): OverlayGeometry => {
    const handles = HANDLES.map((h) => view(unitPoint(t, h)));
    const r = radians(t);
    return { handles, rotationHandle: { x: handles[1]!.x + Math.sin(r) * 28, y: handles[1]!.y - Math.cos(r) * 28 }, showsRotation: true };
  };
  const edit = session.transformEdit;
  if (edit?.group || (!edit && session.transformsAsGroup)) {
    if (edit?.corners) return fromCorners(edit.corners);
    const box = edit?.draft ?? session.groupTransformBox;
    return box ? fromTransform(box) : null;
  }
  const layer = session.activeLayer;
  if (!layer || !session.displayedRaster(layer) || layer.kind === 'group' || !effectiveVisibleIds(document.layers).has(layer.id)) return null;
  if (edit && edit.layerId === layer.id && edit.corners) return fromCorners(edit.corners);
  return fromTransform(session.editedTransform(layer));
}

export type HitMode = TransformDrag['mode'];

export function hitOverlay(geometry: OverlayGeometry, point: Point, radius = 10): HitMode | null {
  const near = (p: Point) => Math.hypot(point.x - p.x, point.y - p.y) <= radius;
  if (geometry.showsRotation && near(geometry.rotationHandle)) return { kind: 'rotate' };
  const index = geometry.handles.findIndex(near);
  if (index >= 0) return { kind: 'resize', handle: index };
  for (const [start, end, handle] of [[0, 2, 1], [2, 4, 3], [4, 6, 5], [6, 0, 7]] as const) {
    const a = geometry.handles[start]!, b = geometry.handles[end]!;
    const dx = b.x - a.x, dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared <= 0) continue;
    const t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared;
    if (t >= 0 && t <= 1 && Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy) <= radius) return { kind: 'resize', handle };
  }
  return null;
}

/** The CSS cursor for a resize handle, following the box's rotation (resizeCursor(for:)). */
export function resizeCursor(geometry: OverlayGeometry, index: number): string {
  const angle = Math.atan2(geometry.handles[2]!.y - geometry.handles[0]!.y, geometry.handles[2]!.x - geometry.handles[0]!.x);
  const offsets = [Math.PI / 4, Math.PI / 2, 3 * Math.PI / 4, 0, Math.PI / 4, Math.PI / 2, 3 * Math.PI / 4, 0];
  const direction = ((Math.round((angle + offsets[index]!) / (Math.PI / 4)) % 4) + 4) % 4;
  return ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'][direction]!;
}

// MARK: Move / Transform

/** Which layer a Move press targets (EditorCanvas.transformPressLayer). */
function transformPressLayer(session: EditorSession, pixel: Point, modifiers: Modifiers): { id: string; picked: boolean } | null {
  const document = session.document;
  if (!(session.canEditLayers || session.transformEdit) || !document) return null;
  const visible = effectiveVisibleIds(document.layers);
  const underPointer = [...renderLayers(document.layers)].reverse().find((l) => session.displayedRaster(l) && containsPoint(l.transform, pixel))?.id ?? null;
  const activeLayer = session.activeLayer;
  const active = activeLayer && session.displayedRaster(activeLayer) && activeLayer.kind !== 'group' && visible.has(activeLayer.id) ? activeLayer : null;
  const picks = session.transformEdit === null;
  if (modifiers.command && picks && underPointer) return { id: underPointer, picked: true };
  if (session.transformsAsGroup && session.activeLayerId) {
    const box = session.transformEdit?.draft ?? session.groupTransformBox;
    if ((box && containsPoint(box, pixel)) || !(picks && session.transformAutoSelect) || !underPointer) return { id: session.activeLayerId, picked: false };
  }
  if (active && containsPoint(session.editedTransform(active), pixel)) return { id: active.id, picked: false };
  if (picks && (session.transformAutoSelect || modifiers.command) && underPointer) return { id: underPointer, picked: true };
  return active ? { id: active.id, picked: false } : null;
}

export class MoveTool implements ToolHandler {
  private drag: TransformDrag | null = null;
  private duplicatesOnDrag = false;
  /** The press was refused by a position lock; releasing repeats the notice so it outlasts the drag. */
  private refused = false;

  down(c: ToolContext): void {
    const session = c.session;
    if (!(session.canEditLayers || session.transformEdit) || !session.document) return;
    const geometry = overlayGeometry(session);
    let mode: HitMode | null = geometry ? hitOverlay(geometry, c.point, c.pointerType === 'touch' ? 22 : 10) : null;
    if (!mode) {
      const target = transformPressLayer(session, c.pixel, c.modifiers);
      if (target) {
        if (target.picked) session.selectLayer(target.id);
        mode = { kind: 'move' };
      }
    }
    if (!mode) return;
    this.duplicatesOnDrag = mode.kind === 'move' && c.modifiers.option;
    if (!session.transformEdit) {
      session.beginTransform(false);
      // A position-locked target refuses the drag with the lock notice, like a refused brush stroke.
      if (!session.transformEdit) { this.refused = session.refuseTransform(); return; }
    }
    if (mode.kind === 'resize' && (c.modifiers.command || c.distortArmed || session.transformEdit?.corners)) {
      session.beginDistort();
      if (session.transformEdit?.corners) mode = { kind: 'distort', handle: mode.handle };
    }
    const edit = session.transformEdit;
    if (!edit) return;
    this.drag = { original: edit.draft, start: c.pixel, mode, originalCorners: edit.corners };
    c.setCursor(mode.kind === 'move' ? (this.duplicatesOnDrag ? 'copy' : 'move') : mode.kind === 'rotate' ? 'grabbing'
      : mode.kind === 'distort' ? 'crosshair' : geometry ? resizeCursor(geometry, mode.handle) : 'default');
  }

  move(c: ToolContext): void {
    const drag = this.drag;
    const session = c.session;
    if (!drag) return;
    if (this.duplicatesOnDrag) {
      this.duplicatesOnDrag = false;
      session.beginDuplicateTransform();
    }
    const corners = dragCorners(drag, c.pixel, c.modifiers.shift);
    if (corners) {
      if (session.perspectiveConstrained && drag.mode.kind === 'distort' && drag.mode.handle % 2 === 0 && drag.originalCorners) {
        const corner = drag.mode.handle / 2, original = drag.originalCorners;
        const dx = corners[corner]!.x - original[corner]!.x, dy = corners[corner]!.y - original[corner]!.y;
        if (Math.abs(dx) >= Math.abs(dy)) {
          corners[corner] = { x: corners[corner]!.x, y: original[corner]!.y };
          const pair = corner ^ 1; corners[pair] = { x: original[pair]!.x - dx, y: original[pair]!.y };
        } else {
          corners[corner] = { x: original[corner]!.x, y: corners[corner]!.y };
          const pair = corner ^ 3; corners[pair] = { x: original[pair]!.x, y: original[pair]!.y - dy };
        }
      }
      session.previewCorners(corners); return;
    }
    let draft = roundedTransform(dragUpdated(drag, c.pixel, session.locksTransformRatio, c.modifiers.shift, c.modifiers.option));
    if (drag.mode.kind === 'move' && !c.modifiers.control) {
      const edit = session.transformEdit;
      const moving = new Set(edit?.group ? [...edit.group.originals.keys()] : edit ? [edit.layerId] : []);
      draft = session.snappedMove(draft, moving, 10 / Math.max(session.viewport.pointsPerPixel, 0.0001));
    }
    session.previewTransform(draft);
  }

  up(c: ToolContext): void {
    if (this.refused) { this.refused = false; c.session.refuseTransform(); return; }
    if (!this.drag) return;
    this.drag = null;
    this.duplicatesOnDrag = false;
    c.session.snapGuides = { xs: [], ys: [] };
    if (c.session.transformEdit && !c.session.transformEdit.persistent) c.session.commitTransform();
    else c.session.notify('document');
  }

  cancel(session: EditorSession): void {
    this.refused = false;
    if (!this.drag) return;
    session.previewTransform(this.drag.original);
    if (session.transformEdit && !session.transformEdit.persistent) session.cancelTransform();
    this.drag = null;
    this.duplicatesOnDrag = false;
  }

  hover(c: ToolContext): string {
    const geometry = overlayGeometry(c.session);
    const mode = geometry ? hitOverlay(geometry, c.point) : null;
    if (mode?.kind === 'rotate') return 'grab';
    if (mode?.kind === 'resize' && geometry) return c.modifiers.command || c.session.transformEdit?.corners ? 'crosshair' : resizeCursor(geometry, mode.handle);
    return c.modifiers.option ? 'copy' : 'move';
  }
}

// MARK: Hand and Zoom

export class HandTool implements ToolHandler {
  private last: Point | null = null;
  down(c: ToolContext): void { this.last = c.point; c.setCursor('grabbing'); }
  move(c: ToolContext): void {
    if (!this.last) return;
    c.session.viewport.translate(c.point.x - this.last.x, c.point.y - this.last.y);
    this.last = c.point;
    c.session.notify('view');
  }
  up(): void { this.last = null; }
  cancel(): void { this.last = null; }
  hover(): string { return 'grab'; }
}

/** Click zooms in (Option: out); dragging right or left zooms smoothly, doubling per 100 points. */
export class ZoomTool implements ToolHandler {
  private drag: { start: Point; zoom: number; moved: boolean } | null = null;
  down(c: ToolContext): void { this.drag = { start: c.point, zoom: c.session.viewport.zoom, moved: false }; }
  move(c: ToolContext): void {
    const drag = this.drag;
    if (!drag) return;
    const dx = c.point.x - drag.start.x;
    if (Math.abs(dx) >= 3) drag.moved = true;
    if (drag.moved) c.session.zoomTo(drag.zoom * 2 ** (dx / 100), drag.start);
  }
  up(c: ToolContext): void {
    const drag = this.drag;
    this.drag = null;
    if (drag && !drag.moved) c.session.zoomTo(c.session.viewport.zoom * (c.modifiers.option ? 0.5 : 2), drag.start);
  }
  cancel(): void { this.drag = null; }
  hover(c: ToolContext): string { return c.modifiers.option ? 'zoom-out' : 'zoom-in'; }
}

export class IdleTool implements ToolHandler {
  down(): void {}
  move(): void {}
  up(): void {}
  cancel(): void {}
  hover(): string { return 'default'; }
}

export type ToolRegistry = Partial<Record<Tool, ToolHandler>>;

export function defaultTools(): ToolRegistry {
  return { move: new MoveTool(), hand: new HandTool(), zoom: new ZoomTool(), idle: new IdleTool() };
}

export function viewportDocumentPoint(viewport: CanvasViewport, point: Point, size: { width: number; height: number }): Point {
  return viewport.documentPoint(point, size);
}
