/**
 * The Shape (U), Pen (P) and Direct/Path Selection (A) tools, and their overlay (PRODUCT-PLAN A5, 6.6). Photoshop
 * muscle memory: shapes drag out (Shift constrains, Option/Alt from the centre); the Pen clicks corners, drags smooth
 * points, closes on the first point, Option/Alt-drag breaks a handle and ⌘/Ctrl is the Direct Selection tool while held;
 * Direct Selection moves anchors and handles, marquee-selects anchors and converts points with Option/Alt.
 */

import { renderLayers } from '../../core/document';
import type { VectorPath } from '../../core/model';
import { apply, invert, roundHalfAway, type Point, type Rect } from '../../core/geometry';
import type { EditorSession } from '../../core/session';
import { shapeDragRect } from '../../core/shape';
import { pathsToSvg, primitivePaths } from '../../core/vector';
import type { ToolContext, ToolHandler } from '../../ui/canvas/tools';
import type { TextEngine } from '../../text';
import {
  addPathLayer, addShapeLayer, addToTarget, layerToDocument, LiveEdit, pointsEqual, replaceLayer, translatePaths, withTargetPaths,
} from './edits';
import {
  pathTarget, selectedAnchors, shapeRecord, targetPaths, toolStyle, vectorState, type PathTarget, type PenPoint, type ShapeKind,
} from './state';

export interface VectorToolHost {
  readonly t: (text: string) => string;
  engine(): TextEngine | null;
  loadEngine(): Promise<TextEngine | null>;
}

const HIT = 6;
const tolerance = (session: EditorSession, points = HIT) => points / Math.max(session.viewport.pointsPerPixel, 1e-6);

// MARK: Geometry helpers

function cubic(a: Point, b: Point, c: Point, d: Point, t: number): Point {
  const u = 1 - t, aa = u * u * u, bb = 3 * u * u * t, cc = 3 * u * t * t, dd = t * t * t;
  return { x: aa * a.x + bb * b.x + cc * c.x + dd * d.x, y: aa * a.y + bb * b.y + cc * c.y + dd * d.y };
}
function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy;
  const t = length > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

export type Hit =
  | { kind: 'handle'; path: number; point: number; handle: 'in' | 'out' }
  | { kind: 'anchor'; path: number; point: number }
  | { kind: 'segment'; path: number; segment: number }
  | { kind: 'inside'; path: number };

let probe: CanvasRenderingContext2D | null = null;
function insidePath(path: VectorPath, point: Point): boolean {
  if (!path.closed && path.points.length < 3) return false;
  try {
    probe ??= document.createElement('canvas').getContext('2d');
    return !!probe?.isPointInPath(new Path2D(pathsToSvg([{ ...path, closed: true }])), point.x, point.y, path.fillRule === 'evenodd' ? 'evenodd' : 'nonzero');
  } catch { return false; }
}

/** What lies under a layer-space point: visible handles first, then anchors, segments and fills. */
export function hitPaths(paths: readonly VectorPath[], point: Point, tol: number, selected: ReadonlySet<string>): Hit | null {
  let best: Hit | null = null, distance = tol;
  for (const key of selected) {
    const [p, i] = key.split(':').map(Number) as [number, number];
    const value = paths[p]?.points[i];
    if (!value) continue;
    for (const handle of ['in', 'out'] as const) {
      if (pointsEqual(value[handle], value.anchor)) continue;
      const d = Math.hypot(value[handle].x - point.x, value[handle].y - point.y);
      if (d <= distance) { distance = d; best = { kind: 'handle', path: p, point: i, handle }; }
    }
  }
  if (best) return best;
  paths.forEach((path, p) => path.points.forEach((value, i) => {
    const d = Math.hypot(value.anchor.x - point.x, value.anchor.y - point.y);
    if (d <= distance) { distance = d; best = { kind: 'anchor', path: p, point: i }; }
  }));
  if (best) return best;
  paths.forEach((path, p) => {
    const count = path.closed ? path.points.length : path.points.length - 1;
    for (let s = 0; s < count; s++) {
      const a = path.points[s]!, b = path.points[(s + 1) % path.points.length]!;
      let previous = a.anchor;
      for (let step = 1; step <= 32; step++) {
        const next = cubic(a.anchor, a.out, b.in, b.anchor, step / 32);
        const d = distanceToSegment(point, previous, next);
        if (d <= distance) { distance = d; best = { kind: 'segment', path: p, segment: s }; }
        previous = next;
      }
    }
  });
  if (best) return best;
  for (let p = paths.length - 1; p >= 0; p--) if (insidePath(paths[p]!, point)) return { kind: 'inside', path: p };
  return null;
}

function keysOfPath(paths: readonly VectorPath[], p: number): string[] {
  return paths[p]?.points.map((_, i) => `${p}:${i}`) ?? [];
}

/** A shape from a drag: Shift squares (or snaps a line to 45°), Option/Alt draws from the centre. */
export function shapeGeometry(kind: ShapeKind, from: Point, to: Point, shift: boolean, option: boolean): { rect: Rect; from: Point; to: Point } {
  if (kind === 'Line') {
    let end = to;
    if (shift) {
      const angle = Math.round(Math.atan2(to.y - from.y, to.x - from.x) / (Math.PI / 4)) * (Math.PI / 4);
      const length = Math.hypot(to.x - from.x, to.y - from.y);
      end = { x: from.x + Math.cos(angle) * length, y: from.y + Math.sin(angle) * length };
    }
    const start = option ? { x: 2 * from.x - end.x, y: 2 * from.y - end.y } : from;
    return { rect: { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) }, from: start, to: end };
  }
  return { rect: shapeDragRect(from, to, shift, option), from, to };
}

export function linePath(from: Point, to: Point): VectorPath {
  return { schemaVersion: 1, closed: false, fillRule: 'nonzero', points: [
    { anchor: from, in: from, out: from, kind: 'corner' }, { anchor: to, in: to, out: to, kind: 'corner' }] };
}

/** Document-space paths of a shape draft. */
export function draftPaths(session: EditorSession, draft: NonNullable<ReturnType<typeof vectorState>['shapeDraft']>): VectorPath[] {
  if (draft.kind === 'Line') return [linePath(draft.from, draft.to)];
  const shape = shapeRecord(vectorState(session), draft.kind, session.foregroundColor);
  return translatePaths(primitivePaths(shape, draft.rect.width, draft.rect.height), draft.rect.x, draft.rect.y);
}

/** Where new paths go: into the targeted vector mask, into the active shape with a path operation, or a new layer. */
function drawTarget(session: EditorSession): { target: PathTarget; operation: 'unite' | 'subtract' | 'intersect' | 'exclude' } | null {
  const state = vectorState(session), target = pathTarget(session);
  if (!target) return null;
  // Into a vector mask only when its thumbnail was chosen (Photoshop); otherwise shapes go onto shape layers.
  if (target.mask) return state.maskTarget === target.layer.id ? { target, operation: state.operation === 'new' ? 'unite' : state.operation } : null;
  return state.operation === 'new' ? null : { target, operation: state.operation };
}

function addPaths(session: EditorSession, host: VectorToolHost, paths: VectorPath[], onNewLayer: () => string | null, name: string): void {
  const into = drawTarget(session);
  const state = vectorState(session);
  if (!into) { const id = onNewLayer(); if (id) state.pathLayerId = id; return; }
  const run = (engine: TextEngine | null) => {
    if (addToTarget(session, engine, into.target, paths, into.operation, name) && !into.target.mask) state.pathLayerId = into.target.layer.id;
  };
  if (into.operation === 'unite' || host.engine()) run(host.engine());
  else void host.loadEngine().then(run);
}

// MARK: Shape tool

export class ShapeTool implements ToolHandler {
  constructor(private readonly host: VectorToolHost) {}
  private anchor: Point | null = null;

  down(c: ToolContext): void {
    const session = c.session;
    if (!session.canEditLayers || !session.document) return;
    const state = vectorState(session);
    this.anchor = state.kind === 'Line' ? { x: roundHalfAway(c.pixel.x * 2) / 2, y: roundHalfAway(c.pixel.y * 2) / 2 }
      : { x: roundHalfAway(c.pixel.x), y: roundHalfAway(c.pixel.y) };
    state.shapeDraft = { kind: state.kind, rect: { ...this.anchor, width: 0, height: 0 }, from: this.anchor, to: this.anchor };
    session.notify('overlay');
  }
  move(c: ToolContext): void {
    const state = vectorState(c.session);
    if (!this.anchor || !state.shapeDraft) return;
    const to = state.kind === 'Line' ? { x: roundHalfAway(c.pixel.x * 2) / 2, y: roundHalfAway(c.pixel.y * 2) / 2 } : c.pixel;
    state.shapeDraft = { kind: state.shapeDraft.kind, ...shapeGeometry(state.shapeDraft.kind, this.anchor, to, c.modifiers.shift, c.modifiers.option) };
    c.session.notify('overlay');
  }
  up(c: ToolContext): void {
    const session = c.session, state = vectorState(session), draft = state.shapeDraft;
    this.anchor = null;
    state.shapeDraft = null;
    if (!draft) return;
    const t = this.host.t;
    if (draft.kind === 'Line') {
      if (Math.hypot(draft.to.x - draft.from.x, draft.to.y - draft.from.y) < 1) { session.notify('overlay'); return; }
      const style = toolStyle(state, 'Line', session.foregroundColor);
      addPaths(session, this.host, [linePath(draft.from, draft.to)], () => addPathLayer(session, [linePath(draft.from, draft.to)], style, t('Line'), 'Create Line'), 'Create Line');
    } else {
      if (draft.rect.width < 1 || draft.rect.height < 1) { session.notify('overlay'); return; }
      const shape = shapeRecord(state, draft.kind, session.foregroundColor);
      addPaths(session, this.host, draftPaths(session, draft),
        () => addShapeLayer(session, shape, draft.rect, toolStyle(state, draft.kind, session.foregroundColor), t(draft.kind)), `Create ${draft.kind}`);
    }
    session.notify('overlay');
  }
  cancel(session: EditorSession): void {
    this.anchor = null;
    vectorState(session).shapeDraft = null;
    session.notify('overlay');
  }
  hover(): string { return 'crosshair'; }
  overlayOnly(session: EditorSession): boolean { return vectorState(session).shapeDraft !== null; }
}

// MARK: Direct / Path Selection

interface SelectDrag {
  mode: 'move' | 'handle' | 'convert' | 'marquee';
  target: PathTarget | null;
  paths: readonly VectorPath[];
  start: Point;
  startView: Point;
  moved: boolean;
  hit?: Extract<Hit, { kind: 'handle' | 'anchor' }>;
  additive: boolean;
  before: Set<string>;
}

export class DirectSelectTool implements ToolHandler {
  private drag: SelectDrag | null = null;
  private live: LiveEdit | null = null;
  constructor(private readonly host: VectorToolHost) {}

  /** A shape layer under the point, top-most first, when the current target has nothing there. */
  private pick(session: EditorSession, pixel: Point): PathTarget | null {
    const document = session.document;
    if (!document) return null;
    const tol = tolerance(session);
    for (const layer of [...renderLayers(document.layers)].reverse()) {
      if (layer.kind !== 'vector' || !layer.paths.length) continue;
      const local = apply(invert(layerToDocument(layer)), pixel);
      if (hitPaths(layer.paths, local, tol, new Set())) return { layer, mask: false };
    }
    return null;
  }

  down(c: ToolContext): void {
    const session = c.session;
    if (!session.document) return;
    const state = vectorState(session);
    let target = pathTarget(session);
    const tol = tolerance(session);
    const hitIn = (value: PathTarget | null) => {
      if (!value) return null;
      return hitPaths(targetPaths(value), apply(invert(layerToDocument(value.layer)), c.pixel), tol, value === target ? selectedAnchors(session) : new Set());
    };
    let hit = hitIn(target);
    if (!hit || hit.kind === 'inside') {
      const other = this.pick(session, c.pixel);
      if (other && other.layer.id !== target?.layer.id) {
        session.selectLayer(other.layer.id);
        state.maskTarget = null;
        target = pathTarget(session);
        hit = hitIn(target);
      }
    }
    if (target && !target.mask) state.pathLayerId = target.layer.id;
    const selected = selectedAnchors(session);
    const base: SelectDrag = { mode: 'marquee', target, paths: target ? targetPaths(target) : [], start: c.pixel, startView: c.point, moved: false,
      additive: c.modifiers.shift, before: new Set(selected) };
    if (!hit || !target) {
      if (!c.modifiers.shift) selected.clear();
      this.drag = base;
      state.marquee = { x: c.pixel.x, y: c.pixel.y, width: 0, height: 0 };
      session.notify('overlay');
      return;
    }
    const pathMode = state.selectMode === 'path';
    if (hit.kind === 'handle') { this.drag = { ...base, mode: 'handle', hit }; return; }
    if (hit.kind === 'anchor' && c.modifiers.option && !pathMode) { this.drag = { ...base, mode: 'convert', hit }; return; }
    const keys = pathMode || hit.kind === 'inside' ? keysOfPath(base.paths, hit.path)
      : hit.kind === 'anchor' ? [`${hit.path}:${hit.point}`]
        : [`${hit.path}:${hit.segment}`, `${hit.path}:${(hit.segment + 1) % base.paths[hit.path]!.points.length}`];
    const already = keys.every((key) => selected.has(key));
    if (c.modifiers.shift) {
      if (already && hit.kind === 'anchor' && !pathMode) selected.delete(keys[0]!); else for (const key of keys) selected.add(key);
    } else if (!already) {
      selected.clear();
      for (const key of keys) selected.add(key);
    }
    this.drag = { ...base, mode: 'move' };
    session.notify('overlay');
  }

  move(c: ToolContext): void {
    const drag = this.drag, session = c.session;
    if (!drag) return;
    if (!drag.moved && Math.hypot(c.point.x - drag.startView.x, c.point.y - drag.startView.y) < 2) return;
    drag.moved = true;
    if (drag.mode === 'marquee') {
      const state = vectorState(session);
      state.marquee = { x: Math.min(drag.start.x, c.pixel.x), y: Math.min(drag.start.y, c.pixel.y),
        width: Math.abs(c.pixel.x - drag.start.x), height: Math.abs(c.pixel.y - drag.start.y) };
      this.marqueeSelect(session, drag);
      session.notify('overlay');
      return;
    }
    const target = drag.target;
    if (!target || !session.canEditLayers || !session.document) return;
    if (!this.live) {
      if (session.refuseLayerEdit(target.layer.id, target.mask ? 'appearance' : 'pixels')) { this.drag = null; return; }
      this.live = new LiveEdit(session);
      if (!this.live.begin(drag.mode === 'move' ? 'Move Anchor' : drag.mode === 'handle' ? 'Drag Handle' : 'Convert Point')) { this.live = null; return; }
    }
    const inverse = invert(layerToDocument(target.layer));
    const local = apply(inverse, c.pixel), start = apply(inverse, drag.start);
    const paths = drag.paths.map((path) => ({ ...path, points: path.points.map((point) => ({ ...point })) }));
    if (drag.mode === 'move') {
      const dx = local.x - start.x, dy = local.y - start.y;
      for (const key of selectedAnchors(session)) {
        const [p, i] = key.split(':').map(Number) as [number, number];
        const point = paths[p]?.points[i];
        if (!point) continue;
        const shift = (q: Point) => ({ x: q.x + dx, y: q.y + dy });
        paths[p]!.points[i] = { ...point, anchor: shift(point.anchor), in: shift(point.in), out: shift(point.out) };
      }
    } else if (drag.hit) {
      const { path: p, point: i } = drag.hit, point = paths[p]!.points[i]!;
      if (drag.mode === 'handle' && drag.hit.kind === 'handle') {
        const handle = drag.hit.handle, opposite = handle === 'in' ? 'out' : 'in';
        if (c.modifiers.option) paths[p]!.points[i] = { ...point, [handle]: local, kind: 'corner' };
        else if ((point.kind ?? 'corner') === 'smooth') {
          const length = Math.hypot(point[opposite].x - point.anchor.x, point[opposite].y - point.anchor.y);
          const dx = local.x - point.anchor.x, dy = local.y - point.anchor.y, d = Math.max(1e-12, Math.hypot(dx, dy));
          paths[p]!.points[i] = { ...point, [handle]: local, [opposite]: { x: point.anchor.x - dx / d * length, y: point.anchor.y - dy / d * length } };
        } else paths[p]!.points[i] = { ...point, [handle]: local };
      } else if (drag.mode === 'convert') {
        // Convert Point: dragging from an anchor pulls out symmetric handles.
        const mirrored = { x: 2 * point.anchor.x - local.x, y: 2 * point.anchor.y - local.y };
        paths[p]!.points[i] = { ...point, out: local, in: mirrored, kind: 'smooth' };
      }
    }
    this.live.replace(replaceLayer(session.document, withTargetPaths(target, paths)));
  }

  private marqueeSelect(session: EditorSession, drag: SelectDrag): void {
    const state = vectorState(session), rect = state.marquee, target = drag.target;
    const selected = selectedAnchors(session);
    selected.clear();
    if (drag.additive) for (const key of drag.before) selected.add(key);
    if (!rect || !target) return;
    const map = layerToDocument(target.layer);
    drag.paths.forEach((path, p) => path.points.forEach((point, i) => {
      const at = apply(map, point.anchor);
      if (at.x >= rect.x && at.x <= rect.x + rect.width && at.y >= rect.y && at.y <= rect.y + rect.height) {
        if (state.selectMode === 'path') for (const key of keysOfPath(drag.paths, p)) selected.add(key);
        else selected.add(`${p}:${i}`);
      }
    }));
  }

  up(c: ToolContext): void {
    const drag = this.drag, session = c.session;
    this.drag = null;
    if (!drag) return;
    if (drag.mode === 'marquee') { vectorState(session).marquee = null; session.notify('overlay'); return; }
    if (drag.mode === 'convert' && !drag.moved && drag.target && drag.hit && session.document && session.canEditLayers) {
      this.convert(session, drag.target, drag.hit.path, drag.hit.point);
    }
    this.live?.end();
    this.live = null;
    session.notify('overlay');
  }

  /** Option/Alt-click on an anchor: a smooth point becomes a corner without handles, a corner becomes smooth. */
  private convert(session: EditorSession, target: PathTarget, p: number, i: number): void {
    if (session.refuseLayerEdit(target.layer.id, target.mask ? 'appearance' : 'pixels')) return;
    const paths = targetPaths(target).map((path) => ({ ...path, points: [...path.points] }));
    const path = paths[p], point = path?.points[i];
    if (!path || !point) return;
    const hasHandles = !pointsEqual(point.in, point.anchor) || !pointsEqual(point.out, point.anchor);
    if ((point.kind ?? 'corner') === 'smooth' || hasHandles) {
      path.points[i] = { ...point, in: point.anchor, out: point.anchor, kind: 'corner' };
    } else {
      const count = path.points.length;
      const previous = path.points[(i - 1 + count) % count]!.anchor, next = path.points[(i + 1) % count]!.anchor;
      const first = !path.closed && i === 0, last = !path.closed && i === count - 1;
      const from = first ? point.anchor : previous, to = last ? point.anchor : next;
      let dx = to.x - from.x, dy = to.y - from.y;
      const d = Math.hypot(dx, dy) || 1;
      dx /= d; dy /= d;
      const back = Math.hypot(point.anchor.x - previous.x, point.anchor.y - previous.y) / 3;
      const ahead = Math.hypot(next.x - point.anchor.x, next.y - point.anchor.y) / 3;
      path.points[i] = { ...point, in: { x: point.anchor.x - dx * back, y: point.anchor.y - dy * back },
        out: { x: point.anchor.x + dx * ahead, y: point.anchor.y + dy * ahead }, kind: 'smooth' };
    }
    session.edit('Convert Point', () => session.replaceDocument(replaceLayer(session.document!, withTargetPaths(target, paths))));
  }

  cancel(session: EditorSession): void {
    this.live?.cancel();
    this.live = null;
    this.drag = null;
    vectorState(session).marquee = null;
    session.notify('overlay');
  }

  hover(c: ToolContext): string {
    const target = pathTarget(c.session);
    if (!target) return 'default';
    const hit = hitPaths(targetPaths(target), apply(invert(layerToDocument(target.layer)), c.pixel), tolerance(c.session), selectedAnchors(c.session));
    if (hit?.kind === 'anchor' && c.modifiers.option) return 'crosshair';
    return hit ? 'pointer' : 'default';
  }
  overlayOnly(session: EditorSession): boolean { return this.drag?.mode === 'marquee' || !this.live; }
}

/** Deletes the selected anchors (Delete/Backspace); subpaths left with too few points go too. One undo step. */
export function deleteSelectedAnchors(session: EditorSession): boolean {
  const target = pathTarget(session), selected = selectedAnchors(session);
  if (!target || !selected.size || !session.canEditLayers || session.refuseLayerEdit(target.layer.id, target.mask ? 'appearance' : 'pixels')) return false;
  const paths: VectorPath[] = [];
  targetPaths(target).forEach((path, p) => {
    const points = path.points.filter((_, i) => !selected.has(`${p}:${i}`));
    if (points.length >= (path.closed ? 3 : 2)) paths.push({ ...path, points });
    else if (points.length === path.points.length) paths.push(path);
  });
  selected.clear();
  session.edit('Delete Anchor', () => session.replaceDocument(replaceLayer(session.document!, withTargetPaths(target, paths))));
  return true;
}

/** Arrow keys nudge the selected anchors by a document pixel (Shift: 10). */
export function nudgeSelectedAnchors(session: EditorSession, dx: number, dy: number): boolean {
  const target = pathTarget(session), selected = selectedAnchors(session);
  if (!target || !selected.size || !session.canEditLayers || session.refuseLayerEdit(target.layer.id, target.mask ? 'appearance' : 'pixels')) return false;
  const map = invert(layerToDocument(target.layer));
  const origin = apply(map, { x: 0, y: 0 }), moved = apply(map, { x: dx, y: dy });
  const lx = moved.x - origin.x, ly = moved.y - origin.y;
  const paths = targetPaths(target).map((path, p) => ({ ...path, points: path.points.map((point, i) => (selected.has(`${p}:${i}`)
    ? { ...point, anchor: { x: point.anchor.x + lx, y: point.anchor.y + ly }, in: { x: point.in.x + lx, y: point.in.y + ly }, out: { x: point.out.x + lx, y: point.out.y + ly } }
    : point)) }));
  session.edit('Nudge Anchors', () => session.replaceDocument(replaceLayer(session.document!, withTargetPaths(target, paths))));
  return true;
}

// MARK: Pen tool

export class PenTool implements ToolHandler {
  private dragging: { index: number; start: Point; startView: Point; closing: boolean } | null = null;
  private delegate: ToolHandler | null = null;
  constructor(private readonly host: VectorToolHost, private readonly direct: DirectSelectTool) {}

  down(c: ToolContext): void {
    const session = c.session;
    if (c.modifiers.command) {
      // ⌘/Ctrl held: the Direct Selection tool, after finishing the path being drawn.
      commitPen(session, this.host);
      this.delegate = this.direct;
      this.direct.down(c);
      return;
    }
    if (!session.canEditLayers || !session.document) return;
    const state = vectorState(session);
    const pen = state.pen ??= { points: [], closed: false };
    const first = pen.points[0];
    if (first && pen.points.length >= 2 && Math.hypot(first.anchor.x - c.pixel.x, first.anchor.y - c.pixel.y) <= tolerance(session)) {
      pen.closed = true;
      this.dragging = { index: 0, start: first.anchor, startView: c.point, closing: true };
      session.notify('overlay');
      return;
    }
    const anchor = { x: c.pixel.x, y: c.pixel.y };
    pen.points.push({ anchor, in: anchor, out: anchor, kind: 'corner' });
    this.dragging = { index: pen.points.length - 1, start: anchor, startView: c.point, closing: false };
    session.notify('overlay');
  }

  move(c: ToolContext): void {
    if (this.delegate) { this.delegate.move(c); return; }
    const drag = this.dragging, pen = vectorState(c.session).pen;
    if (!drag || !pen) return;
    const point = pen.points[drag.index];
    if (!point) return;
    if (Math.hypot(c.point.x - drag.startView.x, c.point.y - drag.startView.y) < 2) return;
    const out = drag.closing ? { x: 2 * point.anchor.x - c.pixel.x, y: 2 * point.anchor.y - c.pixel.y } : c.pixel;
    const mirrored = { x: 2 * point.anchor.x - out.x, y: 2 * point.anchor.y - out.y };
    if (drag.closing) {
      // Dragging on the first point shapes the closing segment: its incoming handle follows the pointer.
      pen.points[drag.index] = c.modifiers.option ? { ...point, in: c.pixel, kind: 'corner' } : { ...point, in: c.pixel, out, kind: 'smooth' };
    } else {
      // Option/Alt breaks the handle pair: only the outgoing handle follows.
      pen.points[drag.index] = c.modifiers.option ? { ...point, out, kind: 'corner' } : { ...point, out, in: mirrored, kind: 'smooth' };
    }
    c.session.notify('overlay');
  }

  up(c: ToolContext): void {
    if (this.delegate) { const delegate = this.delegate; this.delegate = null; delegate.up(c); return; }
    const drag = this.dragging;
    this.dragging = null;
    if (drag?.closing) commitPen(c.session, this.host);
    c.session.notify('overlay');
  }

  cancel(session: EditorSession): void {
    if (this.delegate) { this.delegate.cancel(session); this.delegate = null; }
    this.dragging = null;
  }

  hover(c: ToolContext): string {
    if (c.modifiers.command) return this.direct.hover(c);
    const pen = vectorState(c.session).pen, first = pen?.points[0];
    if (first && pen!.points.length >= 2 && Math.hypot(first.anchor.x - c.pixel.x, first.anchor.y - c.pixel.y) <= tolerance(c.session)) return 'cell';
    return 'crosshair';
  }
  overlayOnly(session: EditorSession): boolean { return this.delegate ? this.delegate.overlayOnly?.(session) ?? false : true; }
}

/** Finishes the Pen's path (Enter, Escape, closing, another tool): a new shape layer or into the target. */
export function commitPen(session: EditorSession, host: VectorToolHost): boolean {
  const state = vectorState(session), pen = state.pen;
  state.pen = null;
  if (!pen) return false;
  session.notify('overlay');
  const points = pen.points;
  if (points.length < 2 || (pen.closed && points.length < 2)) return false;
  const path: VectorPath = { schemaVersion: 1, closed: pen.closed, fillRule: 'nonzero',
    points: points.map((point: PenPoint) => ({ anchor: point.anchor, in: point.in, out: point.out, kind: point.kind })) };
  addPaths(session, host, [path], () => addPathLayer(session, [path], toolStyle(state, 'Path', session.foregroundColor, !pen.closed), host.t('Shape'), 'Pen Path'), 'Pen Path');
  return true;
}

// MARK: Overlay

function tracePath(context: CanvasRenderingContext2D, path: VectorPath, view: (p: Point) => Point): void {
  const points = path.points;
  if (!points.length) return;
  const start = view(points[0]!.anchor);
  context.moveTo(start.x, start.y);
  const count = path.closed ? points.length : points.length - 1;
  for (let i = 0; i < count; i++) {
    const a = points[i]!, b = points[(i + 1) % points.length]!;
    const c1 = view(a.out), c2 = view(b.in), end = view(b.anchor);
    context.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, end.x, end.y);
  }
  if (path.closed) context.closePath();
}

function drawAnchor(context: CanvasRenderingContext2D, p: Point, selected: boolean, accent: string): void {
  const half = matchMedia('(pointer: coarse)').matches ? 5 : 3.5;
  const x = Math.round(p.x) + 0.5, y = Math.round(p.y) + 0.5;
  context.fillStyle = selected ? accent : '#fff';
  context.strokeStyle = selected ? '#fff' : accent;
  context.lineWidth = 1;
  context.fillRect(x - half, y - half, half * 2, half * 2);
  context.strokeRect(x - half, y - half, half * 2, half * 2);
}

function drawHandle(context: CanvasRenderingContext2D, anchor: Point, handle: Point, accent: string): void {
  if (Math.hypot(anchor.x - handle.x, anchor.y - handle.y) < 0.5) return;
  context.strokeStyle = accent;
  context.lineWidth = 1;
  context.beginPath(); context.moveTo(anchor.x, anchor.y); context.lineTo(handle.x, handle.y); context.stroke();
  context.fillStyle = '#fff';
  context.beginPath(); context.arc(handle.x, handle.y, 3, 0, Math.PI * 2); context.fill(); context.stroke();
}

function outline(context: CanvasRenderingContext2D, paths: readonly VectorPath[], view: (p: Point) => Point, accent: string): void {
  context.beginPath();
  for (const path of paths) tracePath(context, path, view);
  context.strokeStyle = 'rgba(0,0,0,0.45)';
  context.lineWidth = 3;
  context.stroke();
  context.strokeStyle = accent;
  context.lineWidth = 1;
  context.stroke();
}

/** Paths, anchors and handles drawn in view points, so they stay crisp at every zoom. */
export function paintVectorOverlay(context: CanvasRenderingContext2D, session: EditorSession, hover: Point | null): void {
  const document = session.document, tool = session.tool;
  if (!document || (tool !== 'pen' && tool !== 'directSelect' && tool !== 'shape')) return;
  const accent = getComputedStyle(context.canvas).getPropertyValue('--cmp-accent').trim() || '#0a84ff';
  const state = vectorState(session);
  const toView = (p: Point) => session.viewport.viewPoint(p, document);
  const target = pathTarget(session);
  if (target) {
    const map = layerToDocument(target.layer), view = (p: Point) => toView(apply(map, p));
    const paths = targetPaths(target);
    outline(context, paths, view, accent);
    if (tool !== 'shape') {
      const selected = selectedAnchors(session);
      paths.forEach((path, p) => path.points.forEach((point, i) => {
        if (!selected.has(`${p}:${i}`)) return;
        const anchor = view(point.anchor);
        drawHandle(context, anchor, view(point.in), accent);
        drawHandle(context, anchor, view(point.out), accent);
      }));
      paths.forEach((path, p) => path.points.forEach((point, i) => drawAnchor(context, view(point.anchor), selected.has(`${p}:${i}`), accent)));
    }
  }
  const draft = state.shapeDraft;
  if (draft && (draft.rect.width > 0 || draft.rect.height > 0)) {
    const paths = draftPaths(session, draft);
    const style = toolStyle(state, draft.kind, session.foregroundColor);
    if (style.fill?.kind === 'solid' && draft.kind !== 'Line') {
      const c = style.fill.color;
      context.beginPath();
      for (const path of paths) tracePath(context, path, toView);
      context.fillStyle = `rgba(${Math.round(c.red * 255)},${Math.round(c.green * 255)},${Math.round(c.blue * 255)},0.5)`;
      context.fill();
    }
    outline(context, paths, toView, accent);
  }
  const pen = state.pen;
  if (pen && pen.points.length) {
    const path: VectorPath = { closed: pen.closed, points: pen.points };
    outline(context, [path], toView, accent);
    const last = pen.points.at(-1)!;
    if (hover && !pen.closed) {
      // The next segment as it would be placed by a click here.
      const end = session.viewport.documentPoint(hover, document);
      context.beginPath();
      tracePath(context, { closed: false, points: [last, { anchor: end, in: end, out: end }] }, toView);
      context.strokeStyle = accent;
      context.globalAlpha = 0.6;
      context.lineWidth = 1;
      context.stroke();
      context.globalAlpha = 1;
    }
    drawHandle(context, toView(last.anchor), toView(last.in), accent);
    drawHandle(context, toView(last.anchor), toView(last.out), accent);
    pen.points.forEach((point, i) => drawAnchor(context, toView(point.anchor), i === pen.points.length - 1, accent));
  }
  if (state.marquee && tool === 'directSelect') {
    const a = toView({ x: state.marquee.x, y: state.marquee.y });
    const b = toView({ x: state.marquee.x + state.marquee.width, y: state.marquee.y + state.marquee.height });
    context.setLineDash([4, 3]);
    context.strokeStyle = accent;
    context.lineWidth = 1;
    context.strokeRect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, Math.round(b.x - a.x), Math.round(b.y - a.y));
    context.setLineDash([]);
  }
}
