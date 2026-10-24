/**
 * Document geometry. Ported from Compositor/Document/LayerTransform.swift, LayerFlip.swift and
 * BrushStroke.swift (`BrushRaster.pixelToDocument`).
 *
 * Coordinates are document pixels, origin top-left, x right, y down. Affine transforms use the
 * CoreGraphics convention `x' = a*x + c*y + tx`, `y' = b*x + d*y + ty`, which is also the
 * `Matrix2D` tuple order `[a, b, c, d, e, f]` of the shared contract.
 */

export interface Point { x: number; y: number }
export interface Size { width: number; height: number }
export interface Rect { x: number; y: number; width: number; height: number }

export interface Affine { a: number; b: number; c: number; d: number; tx: number; ty: number }

export const IDENTITY: Affine = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };

export function apply(m: Affine, p: Point): Point {
  return { x: m.a * p.x + m.c * p.y + m.tx, y: m.b * p.x + m.d * p.y + m.ty };
}

/** `first` then `second`, like `first.concatenating(second)` in CoreGraphics. */
export function concat(first: Affine, second: Affine): Affine {
  return {
    a: first.a * second.a + first.b * second.c,
    b: first.a * second.b + first.b * second.d,
    c: first.c * second.a + first.d * second.c,
    d: first.c * second.b + first.d * second.d,
    tx: first.tx * second.a + first.ty * second.c + second.tx,
    ty: first.tx * second.b + first.ty * second.d + second.ty,
  };
}

export function invert(m: Affine): Affine {
  const det = m.a * m.d - m.b * m.c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-300) return m;
  const a = m.d / det, b = -m.b / det, c = -m.c / det, d = m.a / det;
  return { a, b, c, d, tx: -(a * m.tx + c * m.ty), ty: -(b * m.tx + d * m.ty) };
}

export function translation(x: number, y: number): Affine { return { a: 1, b: 0, c: 0, d: 1, tx: x, ty: y }; }
export function scaling(x: number, y: number): Affine { return { a: x, b: 0, c: 0, d: y, tx: 0, ty: 0 }; }
export function rotation(radians: number): Affine {
  const cos = Math.cos(radians), sin = Math.sin(radians);
  return { a: cos, b: sin, c: -sin, d: cos, tx: 0, ty: 0 };
}

export function toMatrix(m: Affine): [number, number, number, number, number, number] {
  return [m.a, m.b, m.c, m.d, m.tx, m.ty];
}
export function fromMatrix(m: readonly number[]): Affine {
  return { a: m[0]!, b: m[1]!, c: m[2]!, d: m[3]!, tx: m[4]!, ty: m[5]! };
}

export function rectUnion(a: Rect | null, b: Rect): Rect {
  if (!a) return { ...b };
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}
export function rectIntersection(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.width, b.x + b.width), bottom = Math.min(a.y + a.height, b.y + b.height);
  return r > x && bottom > y ? { x, y, width: r - x, height: bottom - y } : null;
}
export function integralRect(r: Rect): Rect {
  const x = Math.floor(r.x), y = Math.floor(r.y);
  return { x, y, width: Math.ceil(r.x + r.width) - x, height: Math.ceil(r.y + r.height) - y };
}

export type LayerSampling = 'Nearest' | 'Smooth' | 'High quality';
export const LAYER_SAMPLINGS: readonly LayerSampling[] = ['Nearest', 'Smooth', 'High quality'];

/** Unrotated bounds in document pixels; rotation is clockwise (degrees) around their center. */
export interface LayerTransform {
  readonly origin: Point;
  readonly size: Size;
  readonly rotation: number;
  readonly flipX: boolean;
  readonly flipY: boolean;
  readonly sampling: LayerSampling;
}

export function makeTransform(origin: Point, size: Size, extra: Partial<LayerTransform> = {}): LayerTransform {
  return { origin, size, rotation: 0, flipX: false, flipY: false, sampling: 'High quality', ...extra };
}

export function center(t: LayerTransform): Point {
  return { x: t.origin.x + t.size.width / 2, y: t.origin.y + t.size.height / 2 };
}

/** Swift `truncatingRemainder` keeps the sign of the dividend, as JavaScript `%` does. */
export function radians(t: LayerTransform): number {
  return (t.rotation % 360) * Math.PI / 180;
}

export function isValidTransform(t: LayerTransform): boolean {
  const values = [t.origin.x, t.origin.y, t.size.width, t.size.height, t.rotation];
  return values.every(Number.isFinite)
    && t.size.width >= 1 && t.size.width <= 300_000 && t.size.height >= 1 && t.size.height <= 300_000
    && Math.abs(t.origin.x) <= 1_000_000 && Math.abs(t.origin.y) <= 1_000_000;
}

export function transformsEqual(a: LayerTransform, b: LayerTransform): boolean {
  return a === b || (a.origin.x === b.origin.x && a.origin.y === b.origin.y && a.size.width === b.size.width
    && a.size.height === b.size.height && a.rotation === b.rotation && a.flipX === b.flipX && a.flipY === b.flipY
    && a.sampling === b.sampling);
}

/** The same place on the document, whatever the sampling. */
export function samePlacement(a: LayerTransform, b: LayerTransform): boolean {
  return transformsEqual({ ...a, sampling: b.sampling }, b);
}

/** A point of the unit square (0…1) on the document; flips do not move handles. */
export function unitPoint(t: LayerTransform, unit: Point): Point {
  const c = center(t), r = radians(t);
  const x = (unit.x - 0.5) * t.size.width, y = (unit.y - 0.5) * t.size.height;
  return { x: c.x + x * Math.cos(r) - y * Math.sin(r), y: c.y + x * Math.sin(r) + y * Math.cos(r) };
}

export function containsPoint(t: LayerTransform, p: Point): boolean {
  const c = center(t), r = radians(t);
  const x = p.x - c.x, y = p.y - c.y;
  return Math.abs(x * Math.cos(r) + y * Math.sin(r)) <= t.size.width / 2
    && Math.abs(-x * Math.sin(r) + y * Math.cos(r)) <= t.size.height / 2;
}

/** Maps a `width` × `height` pixel grid onto the document where `t` places it (BrushRaster.pixelToDocument). */
export function pixelToDocument(t: LayerTransform, width: number, height: number): Affine {
  const c = center(t);
  const sx = t.size.width / width * (t.flipX ? -1 : 1);
  const sy = t.size.height / height * (t.flipY ? -1 : 1);
  return concat(concat(concat(translation(-width / 2, -height / 2), scaling(sx, sy)), rotation(radians(t))), translation(c.x, c.y));
}

export function unitToDocument(t: LayerTransform): Affine { return pixelToDocument(t, 1, 1); }

/** The four corners in handle order TL, TR, BR, BL (DistortWarp.corners). */
export function corners(t: LayerTransform): Point[] {
  return [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }].map((u) => unitPoint(t, u));
}

export function boundingBox(t: LayerTransform): Rect {
  const points = corners(t);
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

export function scalePercent(t: LayerTransform, pixelSize: Size): number {
  return t.size.width / Math.max(1, pixelSize.width) * 100;
}

export function scaledToPercent(t: LayerTransform, percent: number, pixelSize: Size): LayerTransform {
  const c = center(t);
  const size = { width: pixelSize.width * percent / 100, height: pixelSize.height * percent / 100 };
  return { ...t, size, origin: { x: c.x - size.width / 2, y: c.y - size.height / 2 } };
}

/** Swift `rounded()` rounds half away from zero. */
export function roundHalfAway(v: number): number { return v < 0 ? -Math.round(-v) : Math.round(v); }

export function roundedTransform(t: LayerTransform): LayerTransform {
  return {
    ...t,
    origin: { x: roundHalfAway(t.origin.x), y: roundHalfAway(t.origin.y) },
    size: { width: Math.max(1, roundHalfAway(t.size.width)), height: Math.max(1, roundHalfAway(t.size.height)) },
    rotation: roundHalfAway(t.rotation),
  };
}

/** A transform placing the unit square as `map` does (shear dropped); keeps this sampling. */
export function placing(t: LayerTransform, map: Affine): LayerTransform {
  const sign = t.flipX ? -1 : 1;
  const angle = Math.atan2(map.b * sign, map.a * sign);
  const along = -map.c * Math.sin(angle) + map.d * Math.cos(angle);
  const middle = apply(map, { x: 0.5, y: 0.5 });
  const size = { width: Math.hypot(map.a, map.b), height: Math.abs(along) };
  const degrees = angle * 180 / Math.PI;
  return {
    ...t,
    size,
    rotation: degrees + roundHalfAway((t.rotation - degrees) / 360) * 360,
    flipY: along < 0,
    origin: { x: middle.x - size.width / 2, y: middle.y - size.height / 2 },
  };
}

/** This placement carried along as a layer moves from `from` to `to`. */
export function following(t: LayerTransform, from: LayerTransform, to: LayerTransform): LayerTransform {
  if (transformsEqual(from, to)) return t;
  if (from.size.width === to.size.width && from.size.height === to.size.height && from.rotation === to.rotation
    && from.flipX === to.flipX && from.flipY === to.flipY) {
    return { ...t, origin: { x: t.origin.x + to.origin.x - from.origin.x, y: t.origin.y + to.origin.y - from.origin.y } };
  }
  return placing(t, concat(concat(unitToDocument(t), invert(unitToDocument(from))), unitToDocument(to)));
}

/** Mirrored across a vertical line at `axis` (or a horizontal one when not `horizontally`). */
export function mirrored(t: LayerTransform, horizontally: boolean, axis: number): LayerTransform {
  const c = center(t);
  if (horizontally) {
    return { ...t, flipX: !t.flipX, origin: { x: 2 * axis - c.x - t.size.width / 2, y: t.origin.y }, rotation: -t.rotation };
  }
  return { ...t, flipY: !t.flipY, origin: { x: t.origin.x, y: 2 * axis - c.y - t.size.height / 2 }, rotation: -t.rotation };
}

/** Handle positions in unit coordinates, clockwise from top-left. */
export const HANDLES: readonly Point[] = [
  { x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 0.5 },
  { x: 1, y: 1 }, { x: 0.5, y: 1 }, { x: 0, y: 1 }, { x: 0, y: 0.5 },
];

export type TransformDragMode =
  | { kind: 'move' }
  | { kind: 'resize'; handle: number }
  | { kind: 'rotate' }
  | { kind: 'distort'; handle: number };

export interface TransformDrag {
  readonly original: LayerTransform;
  readonly start: Point;
  readonly mode: TransformDragMode;
  readonly originalCorners?: readonly Point[];
}

/** Corners after dragging to `point` (TransformDrag.corners). */
export function dragCorners(drag: TransformDrag, point: Point, shift = false): Point[] | null {
  if (!drag.originalCorners) return null;
  const result = drag.originalCorners.map((p) => ({ ...p }));
  let dx = point.x - drag.start.x, dy = point.y - drag.start.y;
  if (shift) { if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0; }
  let moved: number[];
  if (drag.mode.kind === 'distort') {
    const index = drag.mode.handle;
    moved = index % 2 === 0 ? [index / 2] : [(index - 1) / 2, ((index - 1) / 2 + 1) % 4];
  } else if (drag.mode.kind === 'move') moved = [0, 1, 2, 3];
  else return null;
  for (const corner of moved) { result[corner]!.x += dx; result[corner]!.y += dy; }
  return result;
}

/** TransformDrag.updated: the transform after dragging to `point`. */
export function dragUpdated(drag: TransformDrag, point: Point, lockRatio: boolean, shift: boolean, option = false): LayerTransform {
  const original = drag.original;
  let result: LayerTransform = original;
  switch (drag.mode.kind) {
    case 'distort': break;
    case 'move': {
      let dx = point.x - drag.start.x, dy = point.y - drag.start.y;
      if (shift) { if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0; }
      result = { ...original, origin: { x: original.origin.x + dx, y: original.origin.y + dy } };
      break;
    }
    case 'rotate': {
      const c = center(original);
      const delta = Math.atan2(point.y - c.y, point.x - c.x) - Math.atan2(drag.start.y - c.y, drag.start.x - c.x);
      let rotationDegrees = original.rotation + delta * 180 / Math.PI;
      if (shift) rotationDegrees = roundHalfAway(rotationDegrees / 15) * 15;
      result = { ...original, rotation: rotationDegrees };
      break;
    }
    case 'resize': {
      const handle = HANDLES[drag.mode.handle]!;
      const anchorUnit = option ? { x: 0.5, y: 0.5 } : { x: 1 - handle.x, y: 1 - handle.y };
      const anchor = unitPoint(original, anchorUnit);
      const initialHandle = unitPoint(original, handle);
      const dx = initialHandle.x + point.x - drag.start.x - anchor.x;
      const dy = initialHandle.y + point.y - drag.start.y - anchor.y;
      const span = option ? 2 : 1;
      const r = radians(original);
      const localX = (dx * Math.cos(r) + dy * Math.sin(r)) * span;
      const localY = (-dx * Math.sin(r) + dy * Math.cos(r)) * span;
      const sx = handle.x * 2 - 1, sy = handle.y * 2 - 1;
      let width = sx === 0 ? original.size.width : Math.max(1, localX * sx);
      let height = sy === 0 ? original.size.height : Math.max(1, localY * sy);
      if (lockRatio !== shift) {
        let factor: number;
        if (sx === 0) factor = height / original.size.height;
        else if (sy === 0) factor = width / original.size.width;
        else {
          const w = original.size.width, h = original.size.height;
          factor = Math.max(1 / Math.min(w, h), (localX * sx * w + localY * sy * h) / (w * w + h * h));
        }
        width = original.size.width * factor;
        height = original.size.height * factor;
      }
      const offsetX = (0.5 - anchorUnit.x) * width, offsetY = (0.5 - anchorUnit.y) * height;
      const c = { x: anchor.x + offsetX * Math.cos(r) - offsetY * Math.sin(r), y: anchor.y + offsetX * Math.sin(r) + offsetY * Math.cos(r) };
      result = { ...original, size: { width, height }, origin: { x: c.x - width / 2, y: c.y - height / 2 } };
      break;
    }
  }
  return isValidTransform(result) ? result : original;
}

/** TransformSnap: how close, in screen points, a guide comes before it snaps. */
export const SNAP_DISTANCE = 10;

export function snapOffset(box: Rect, xs: readonly number[], ys: readonly number[], tolerance: number):
  { dx: number; dy: number; x: number | null; y: number | null } {
  const shift = (guides: number[], targets: readonly number[]) => {
    let best: { move: number; target: number } | null = null;
    for (const guide of guides) {
      for (const target of targets) {
        const move = target - guide;
        if (Math.abs(move) > tolerance) continue;
        if (best && Math.abs(best.move) <= Math.abs(move)) continue;
        best = { move, target };
      }
    }
    return best;
  };
  const h = shift([box.x, box.x + box.width / 2, box.x + box.width], xs);
  const v = shift([box.y, box.y + box.height / 2, box.y + box.height], ys);
  return { dx: h?.move ?? 0, dy: v?.move ?? 0, x: h?.target ?? null, y: v?.target ?? null };
}
