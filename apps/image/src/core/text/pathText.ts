/**
 * Text on a path (PRODUCT-PLAN 6.6, Phase 3): arc-length measurement of a cubic path and the placement of shaped glyph
 * clusters along it. Pure geometry, no CanvasKit: the engine shapes a line (kerning, ligatures), this module decides
 * where each cluster sits and how it turns. Photoshop's model: the text runs between a start and an end marker,
 * alignment is taken within that range, "flip" puts it on the other side running the other way, and baseline shift
 * lifts it off the path. New product work; the upstream editor has no text on paths.
 */

import type { Point, TextOnPath, VectorPath } from '../model';

type Cubic = readonly [Point, Point, Point, Point];
export interface PathSample { readonly point: Point; readonly tangent: Point }

function cubicPoint([a, b, c, d]: Cubic, t: number): Point {
  const u = 1 - t, aa = u * u * u, bb = 3 * u * u * t, cc = 3 * u * t * t, dd = t * t * t;
  return { x: aa * a.x + bb * b.x + cc * c.x + dd * d.x, y: aa * a.y + bb * b.y + cc * c.y + dd * d.y };
}
function cubicDerivative([a, b, c, d]: Cubic, t: number): Point {
  const u = 1 - t;
  return { x: 3 * u * u * (b.x - a.x) + 6 * u * t * (c.x - b.x) + 3 * t * t * (d.x - c.x),
    y: 3 * u * u * (b.y - a.y) + 6 * u * t * (c.y - b.y) + 3 * t * t * (d.y - c.y) };
}
function unit(v: Point): Point | null {
  const length = Math.hypot(v.x, v.y);
  return length > 1e-9 ? { x: v.x / length, y: v.y / length } : null;
}

/** A path measured by arc length (Skia's SkContourMeasure, in TypeScript so it can be unit-tested and reused). */
export class PathMeasure {
  readonly length: number;
  readonly closed: boolean;
  private readonly segments: Cubic[] = [];
  /** Cumulative arc length at each sample; `segment` and `t` locate the sample on its cubic. */
  private readonly lengths: number[] = [];
  private readonly segmentOf: number[] = [];
  private readonly ts: number[] = [];
  private readonly points: Point[] = [];

  constructor(path: VectorPath, scale = 1) {
    const p = (value: Point): Point => ({ x: value.x * scale, y: value.y * scale });
    const anchors = path.points;
    this.closed = path.closed && anchors.length > 1;
    const count = this.closed ? anchors.length : Math.max(0, anchors.length - 1);
    for (let i = 0; i < count; i++) {
      const a = anchors[i]!, b = anchors[(i + 1) % anchors.length]!;
      this.segments.push([p(a.anchor), p(a.out), p(b.in), p(b.anchor)]);
    }
    let total = 0;
    const first = this.segments[0]?.[0] ?? (anchors[0] ? p(anchors[0].anchor) : { x: 0, y: 0 });
    this.push(0, 0, 0, first);
    this.segments.forEach((segment, index) => {
      const hull = Math.hypot(segment[1].x - segment[0].x, segment[1].y - segment[0].y)
        + Math.hypot(segment[2].x - segment[1].x, segment[2].y - segment[1].y) + Math.hypot(segment[3].x - segment[2].x, segment[3].y - segment[2].y);
      // About one sample per 1.5 px of hull: chord error stays far below a hundredth of a pixel on type-size curves.
      const steps = Math.max(8, Math.min(1024, Math.ceil(hull / 1.5)));
      let previous = segment[0];
      for (let step = 1; step <= steps; step++) {
        const t = step / steps, point = cubicPoint(segment, t);
        total += Math.hypot(point.x - previous.x, point.y - previous.y);
        this.push(total, index, t, point);
        previous = point;
      }
    });
    this.length = total;
  }

  private push(length: number, segment: number, t: number, point: Point): void {
    this.lengths.push(length); this.segmentOf.push(segment); this.ts.push(t); this.points.push(point);
  }

  private tangentOf(segment: number, t: number): Point {
    const cubic = this.segments[segment];
    if (!cubic) return { x: 1, y: 0 };
    // Straight segments and cusps have a zero derivative at their ends: step inside, then fall back to the chord.
    return unit(cubicDerivative(cubic, t))
      ?? unit({ x: cubicPoint(cubic, Math.min(1, t + 1e-3)).x - cubicPoint(cubic, Math.max(0, t - 1e-3)).x,
        y: cubicPoint(cubic, Math.min(1, t + 1e-3)).y - cubicPoint(cubic, Math.max(0, t - 1e-3)).y })
      ?? unit({ x: cubic[3].x - cubic[0].x, y: cubic[3].y - cubic[0].y }) ?? { x: 1, y: 0 };
  }

  /** Point and unit tangent at arc length `s`: a closed path wraps; an open one continues straight past its ends. */
  at(s: number): PathSample {
    if (!this.segments.length || !(this.length > 0)) return { point: this.points[0] ?? { x: 0, y: 0 }, tangent: { x: 1, y: 0 } };
    let distance = s;
    if (this.closed) distance = ((s % this.length) + this.length) % this.length;
    else if (s < 0 || s > this.length) {
      const end = s > this.length, sample = this.at(end ? this.length : 0), beyond = end ? s - this.length : s;
      return { point: { x: sample.point.x + sample.tangent.x * beyond, y: sample.point.y + sample.tangent.y * beyond }, tangent: sample.tangent };
    }
    let low = 1, high = this.lengths.length - 1;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.lengths[middle]! < distance) low = middle + 1; else high = middle;
    }
    const i = low, segment = this.segmentOf[i]!, cubic = this.segments[segment]!;
    const from = this.lengths[i - 1]!;
    const t0 = this.segmentOf[i - 1] === segment ? this.ts[i - 1]! : 0, t1 = this.ts[i]!;
    // Within one sample interval the arc is its chord; the cubic's parameter is not proportional to length (a straight
    // segment with retracted handles eases in and out), so find the parameter whose chord matches by bisection.
    const origin = cubicPoint(cubic, t0), wanted = distance - from;
    let lo = t0, hi = t1;
    for (let k = 0; k < 30 && hi - lo > 1e-12; k++) {
      const middle = (lo + hi) / 2, p = cubicPoint(cubic, middle);
      if (Math.hypot(p.x - origin.x, p.y - origin.y) < wanted) lo = middle; else hi = middle;
    }
    const t = (lo + hi) / 2;
    return { point: cubicPoint(cubic, t), tangent: this.tangentOf(segment, t) };
  }

  /** The nearest point of the path to `query`: its arc length and the signed distance along the right-hand normal. */
  project(query: Point): { s: number; point: Point; normalDistance: number } {
    let best = Infinity, bestIndex = 1, bestS = 0, bestPoint = this.points[0] ?? { x: 0, y: 0 };
    for (let i = 1; i < this.points.length; i++) {
      const a = this.points[i - 1]!, b = this.points[i]!;
      const dx = b.x - a.x, dy = b.y - a.y, squared = dx * dx + dy * dy;
      const t = squared > 0 ? Math.max(0, Math.min(1, ((query.x - a.x) * dx + (query.y - a.y) * dy) / squared)) : 0;
      const x = a.x + dx * t, y = a.y + dy * t, d = Math.hypot(query.x - x, query.y - y);
      if (d < best) { best = d; bestIndex = i; bestS = this.lengths[i - 1]! + (this.lengths[i]! - this.lengths[i - 1]!) * t; bestPoint = { x, y }; }
    }
    const segment = this.segmentOf[bestIndex], cubic = segment === undefined ? undefined : this.segments[segment];
    if (segment === undefined || !cubic) return { s: bestS, point: bestPoint, normalDistance: 0 };
    // Refine on the true curve within the nearest sample interval (ternary search on the distance).
    const t0 = this.segmentOf[bestIndex - 1] === segment ? this.ts[bestIndex - 1]! : 0, t1 = this.ts[bestIndex]!;
    let lo = t0, hi = t1;
    const distanceAt = (t: number) => { const p = cubicPoint(cubic, t); return Math.hypot(query.x - p.x, query.y - p.y); };
    for (let k = 0; k < 40 && hi - lo > 1e-12; k++) {
      const a = lo + (hi - lo) / 3, b = hi - (hi - lo) / 3;
      if (distanceAt(a) < distanceAt(b)) hi = b; else lo = a;
    }
    const t = (lo + hi) / 2, point = cubicPoint(cubic, t), origin = cubicPoint(cubic, t0);
    const s = this.lengths[bestIndex - 1]! + Math.hypot(point.x - origin.x, point.y - origin.y);
    const tangent = this.tangentOf(segment, t);
    return { s, point, normalDistance: (query.x - point.x) * -tangent.y + (query.y - point.y) * tangent.x };
  }
}

/** One shaped line as the placement needs it (layout coordinates of the engine's paragraph). */
export interface PathTextLine {
  readonly top: number;
  readonly bottom: number;
  readonly baseline: number;
  /** Extent of the line's glyph advances. */
  readonly left: number;
  readonly right: number;
  readonly alignment: 'left' | 'center' | 'right' | 'justify';
}

/** Affine `[a, b, c, d, tx, ty]`: x' = a·x + c·y + tx, y' = b·x + d·y + ty. */
export type Matrix = readonly [number, number, number, number, number, number];

export interface PathTextOptions {
  readonly start: number;
  readonly end: number;
  readonly flipped: boolean;
  /** Layout pixels; positive lifts the text away from the path. */
  readonly baselineOffset: number;
}

/**
 * Where laid-out text goes on the path. Layout x runs along the text range (after the line's alignment within it),
 * layout y below the first baseline runs along the right-hand normal, so every glyph cluster keeps its shaped advance
 * and turns with the path's tangent at its centre.
 */
export class PathTextMapping {
  readonly rangeStart: number;
  readonly rangeLength: number;
  private readonly firstBaseline: number;

  constructor(readonly measure: PathMeasure, readonly options: PathTextOptions, readonly lines: readonly PathTextLine[]) {
    const length = measure.length;
    const start = Math.max(0, Math.min(1, options.start)), end = Math.max(0, Math.min(1, options.end));
    this.rangeStart = start * length;
    if (measure.closed) {
      const span = ((end - start) % 1 + 1) % 1;
      this.rangeLength = (span < 1e-9 ? 1 : span) * length;
    } else {
      this.rangeLength = Math.max(0, end - start) * length;
    }
    this.firstBaseline = lines[0]?.baseline ?? 0;
  }

  lineAt(y: number): number {
    let best = 0, distance = Infinity;
    this.lines.forEach((line, index) => {
      const d = y < line.top ? line.top - y : y > line.bottom ? y - line.bottom : 0;
      if (d < distance) { distance = d; best = index; }
    });
    return best;
  }

  /** Arc position within the text range of layout x on a line (alignment within the range, Photoshop). */
  relative(x: number, line: number): number {
    const value = this.lines[line];
    if (!value) return x;
    const width = value.right - value.left;
    const offset = value.alignment === 'center' ? (this.rangeLength - width) / 2 - value.left
      : value.alignment === 'right' ? this.rangeLength - width - value.left : -value.left;
    return offset + x;
  }

  /** Point and text direction at a position within the range (reversed when flipped). */
  along(r: number): PathSample {
    const sample = this.measure.at(this.options.flipped ? this.rangeStart + this.rangeLength - r : this.rangeStart + r);
    return this.options.flipped ? { point: sample.point, tangent: { x: -sample.tangent.x, y: -sample.tangent.y } } : sample;
  }

  /** Whether a cluster spanning layout x0…x1 fits inside the text range; overflowing glyphs are hidden (Photoshop). */
  fits(x0: number, x1: number, line: number): boolean {
    const r0 = this.relative(Math.min(x0, x1), line), r1 = this.relative(Math.max(x0, x1), line);
    const slack = 1e-3 * Math.max(1, this.rangeLength);
    return r0 >= -slack && r1 <= this.rangeLength + slack;
  }

  /** Placement of a cluster whose advance is centred at layout x `middle`: a rotation about the path point there. */
  clusterMatrix(middle: number, line: number): Matrix {
    const { point, tangent } = this.along(this.relative(middle, line));
    const normal = { x: -tangent.y, y: tangent.x }, lift = this.firstBaseline + this.options.baselineOffset;
    return [tangent.x, tangent.y, normal.x, normal.y,
      point.x - tangent.x * middle - normal.x * lift, point.y - tangent.y * middle - normal.y * lift];
  }

  /** A layout point on the bent text (caret and selection geometry). */
  map(point: Point): Point {
    const line = this.lineAt(point.y);
    const { point: on, tangent } = this.along(this.relative(point.x, line));
    const offset = point.y - this.firstBaseline - this.options.baselineOffset;
    return { x: on.x - tangent.y * offset, y: on.y + tangent.x * offset };
  }

  /** The layout point whose mapped position is nearest to `point` (hit testing). */
  inverse(point: Point): Point {
    const hit = this.measure.project(point);
    const length = this.measure.length;
    let r = this.options.flipped ? this.rangeStart + this.rangeLength - hit.s : hit.s - this.rangeStart;
    if (this.measure.closed && length > 0) {
      r = ((r % length) + length) % length;
      if (r > this.rangeLength + (length - this.rangeLength) / 2) r -= length;
    }
    const normal = this.options.flipped ? -hit.normalDistance : hit.normalDistance;
    const y = normal + this.firstBaseline + this.options.baselineOffset;
    const line = this.lineAt(y);
    return { x: r - this.relative(0, line), y };
  }
}

/** Frame-pixel path data scaled onto layout pixels, with the model's start/end/flip/baseline settings. */
export function pathTextOptions(settings: TextOnPath, baselineOffsetPixels: number): PathTextOptions {
  return { start: settings.start, end: settings.end, flipped: settings.flipped, baselineOffset: baselineOffsetPixels };
}

export function validTextOnPath(value: TextOnPath): boolean {
  const finitePoint = (point: Point) => Number.isFinite(point.x) && Number.isFinite(point.y);
  return value.schemaVersion === 1 && value.path.points.length >= 2
    && value.path.points.every((point) => finitePoint(point.anchor) && finitePoint(point.in) && finitePoint(point.out))
    && Number.isFinite(value.start) && value.start >= 0 && value.start <= 1
    && Number.isFinite(value.end) && value.end >= 0 && value.end <= 1
    && typeof value.flipped === 'boolean' && Number.isFinite(value.baselineOffset) && Math.abs(value.baselineOffset) <= 12_000;
}
