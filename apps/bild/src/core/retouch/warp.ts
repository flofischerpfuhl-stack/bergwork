import type { Point, Rect } from '../geometry';
import { Raster } from '../raster';
import type { PixelArray } from '../pixel/format';
import type { DocumentSelection } from '../selection';
import { RasterMapping, selectionCoverage, unionRects, validPoint } from './common';
import type { LayerTransform } from '../geometry';

export type WarpMode = 'smudge' | 'liquify';

export interface WarpSettings {
  readonly diameter: number;
  readonly hardness: number;
  /** Upstream opacity keys control Smudge carry / Liquify displacement strength. */
  readonly strength: number;
}

export interface RetouchStroke {
  addPoints(points: readonly Point[]): Rect[];
  currentRaster(): Raster;
  finish(): Raster;
  cancel(): Raster;
}

/**
 * Tiled port of SmudgeLiquify.swift (`WarpStroke`). Work is restricted to each dab's
 * touched region instead of allocating the upstream document-sized CGContext.
 */
export class WarpStroke implements RetouchStroke {
  readonly diameter: number;
  readonly hardness: number;
  readonly strength: number;
  private readonly mapping: RasterMapping;
  private working: Raster;
  private last: Point | null = null;
  private carried = new Float32Array(0);
  private ended = false;

  constructor(readonly original: Raster, transform: LayerTransform, readonly mode: WarpMode,
    settings: WarpSettings, private readonly selection: DocumentSelection | null = null) {
    if (original.channels !== 4) throw new Error('Smudge and Liquify require an RGBA raster');
    this.diameter = Math.min(2000, Math.max(2, Number.isFinite(settings.diameter) ? settings.diameter : 2));
    this.hardness = Math.min(0.98, Math.max(0, Number.isFinite(settings.hardness) ? settings.hardness : 0));
    this.strength = Math.min(1, Math.max(0.01, Number.isFinite(settings.strength) ? settings.strength : 1));
    this.mapping = new RasterMapping(original, transform);
    this.working = original;
  }

  addPoints(points: readonly Point[]): Rect[] {
    if (this.ended) return [];
    const dirty: Rect[] = [];
    for (const point of points) {
      if (!validPoint(point)) continue;
      const from = this.last;
      if (!from) {
        this.last = { ...point };
        if (this.mode === 'smudge') this.pickUp(point);
        continue;
      }
      const distance = Math.hypot(point.x - from.x, point.y - from.y);
      const spacing = Math.max(1, this.diameter * (this.mode === 'smudge' ? 0.08 : 0.025));
      if (distance < spacing) continue;
      const steps = Math.ceil(distance / spacing);
      let previous = from;
      let combined: Rect | null = null;
      for (let step = 1; step <= steps; step++) {
        const t = step / steps;
        const next = { x: from.x + (point.x - from.x) * t, y: from.y + (point.y - from.y) * t };
        const changed = this.mode === 'smudge' ? this.smudge(next) : this.push(previous, next);
        if (changed) combined = unionRects(combined, changed);
        previous = next;
      }
      this.last = { ...point };
      if (combined) dirty.push(this.mapping.documentBounds(combined));
    }
    return dirty;
  }

  currentRaster(): Raster { return this.working; }
  finish(): Raster { this.ended = true; return this.working; }
  cancel(): Raster { this.ended = true; this.working = this.original; return this.original; }

  /** SmudgeLiquify.swift `WarpStroke.weight`. */
  private weight(u: number): number {
    if (u >= 1) return 0;
    if (u <= this.hardness) return 1;
    const t = (1 - u) / (1 - this.hardness);
    return t * t * (3 - 2 * t);
  }

  private pickUp(center: Point): void {
    const r = Math.ceil(this.diameter / 2), side = 2 * r + 1;
    this.carried = new Float32Array(side * side * 4);
    const local = this.mapping.pixelPoint(center), cx = Math.round(local.x), cy = Math.round(local.y);
    const pixels = this.working.readRegionNative(cx - r, cy - r, side, side);
    for (let i = 0; i < side * side; i++) this.readPremultiplied(pixels, i * 4, this.carried, i * 4);
  }

  private smudge(center: Point): Rect | null {
    const bounds = this.mapping.circleBounds(center, this.diameter / 2);
    if (!bounds) return null;
    const data = this.working.readRegionNative(bounds.x, bounds.y, bounds.width, bounds.height);
    const r = Math.ceil(this.diameter / 2), side = 2 * r + 1;
    const local = this.mapping.pixelPoint(center), cx = Math.round(local.x), cy = Math.round(local.y);
    for (let y = 0; y < bounds.height; y++) {
      const py = bounds.y + y;
      for (let x = 0; x < bounds.width; x++) {
        const px = bounds.x + x;
        // WarpStroke indexes the document CGContext by integer pixel coordinates.
        const doc = this.mapping.documentPoint({ x: px, y: py });
        let w = this.weight(Math.hypot(doc.x - center.x, doc.y - center.y) / (this.diameter / 2));
        w *= selectionCoverage(this.selection, doc);
        if (w <= 0) continue;
        const ci = ((py - cy + r) * side + px - cx + r) * 4;
        if (ci < 0 || ci + 3 >= this.carried.length) continue;
        const di = (y * bounds.width + x) * 4;
        const oldAlphaByte = data[di + 3]!, oldAlpha = oldAlphaByte / this.original.maximum;
        const carriedAlpha = this.carried[ci + 3]!;
        const paintedAlpha = oldAlphaByte + (carriedAlpha - oldAlphaByte) * w;
        this.carried[ci + 3] = paintedAlpha + (carriedAlpha - paintedAlpha) * this.strength;
        data[di + 3] = clampSample(paintedAlpha, this.original.maximum);
        if (paintedAlpha <= 0) { data[di] = 0; data[di + 1] = 0; data[di + 2] = 0; continue; }
        for (let k = 0; k < 3; k++) {
          const under = data[di + k]! * oldAlpha;
          const carried = this.carried[ci + k]!;
          const painted = under + (carried - under) * w;
          this.carried[ci + k] = painted + (carried - painted) * this.strength;
          data[di + k] = clampSample(painted * this.original.maximum / paintedAlpha, this.original.maximum);
        }
      }
    }
    this.working = this.working.withRegion(bounds.x, bounds.y, bounds.width, bounds.height, data);
    return bounds;
  }

  private push(from: Point, to: Point): Rect | null {
    const moveX = (to.x - from.x) * this.strength, moveY = (to.y - from.y) * this.strength;
    const margin = Math.ceil(Math.max(Math.abs(moveX), Math.abs(moveY))) + 2;
    const bounds = this.mapping.circleBounds(to, this.diameter / 2, margin);
    const paint = this.mapping.circleBounds(to, this.diameter / 2);
    if (!bounds || !paint) return null;
    const source = this.working.readRegionNative(bounds.x, bounds.y, bounds.width, bounds.height);
    const output = source.slice();
    const rgba = new Float32Array(4);
    for (let py = paint.y; py < paint.y + paint.height; py++) {
      for (let px = paint.x; px < paint.x + paint.width; px++) {
        const doc = this.mapping.documentPoint({ x: px, y: py });
        let w = this.weight(Math.hypot(doc.x - to.x, doc.y - to.y) / (this.diameter / 2));
        w *= selectionCoverage(this.selection, doc);
        if (w <= 0) continue;
        const behind = this.mapping.pixelPoint({ x: doc.x - moveX * w, y: doc.y - moveY * w });
        this.samplePremultiplied(source, bounds, behind.x, behind.y, rgba);
        const di = ((py - bounds.y) * bounds.width + px - bounds.x) * 4;
        this.writePremultiplied(output, di, rgba, 0);
      }
    }
    this.working = this.working.withRegion(bounds.x, bounds.y, bounds.width, bounds.height, output);
    return paint;
  }

  private samplePremultiplied(source: PixelArray, bounds: Rect, x: number, y: number, out: Float32Array): void {
    const sx = Math.min(bounds.x + bounds.width - 1, Math.max(bounds.x, x));
    const sy = Math.min(bounds.y + bounds.height - 1, Math.max(bounds.y, y));
    const x0 = Math.floor(sx), y0 = Math.floor(sy);
    const x1 = Math.min(bounds.x + bounds.width - 1, x0 + 1), y1 = Math.min(bounds.y + bounds.height - 1, y0 + 1);
    const fx = sx - x0, fy = sy - y0;
    const i00 = ((y0 - bounds.y) * bounds.width + x0 - bounds.x) * 4;
    const i10 = ((y0 - bounds.y) * bounds.width + x1 - bounds.x) * 4;
    const i01 = ((y1 - bounds.y) * bounds.width + x0 - bounds.x) * 4;
    const i11 = ((y1 - bounds.y) * bounds.width + x1 - bounds.x) * 4;
    for (let k = 0; k < 4; k++) {
      const p00 = k === 3 ? source[i00 + 3]! : source[i00 + k]! * source[i00 + 3]! / this.original.maximum;
      const p10 = k === 3 ? source[i10 + 3]! : source[i10 + k]! * source[i10 + 3]! / this.original.maximum;
      const p01 = k === 3 ? source[i01 + 3]! : source[i01 + k]! * source[i01 + 3]! / this.original.maximum;
      const p11 = k === 3 ? source[i11 + 3]! : source[i11 + k]! * source[i11 + 3]! / this.original.maximum;
      const top = p00 + (p10 - p00) * fx;
      const bottom = p01 + (p11 - p01) * fx;
      out[k] = top + (bottom - top) * fy;
    }
  }

  private readPremultiplied(source: PixelArray, si: number, target: Float32Array, ti: number): void {
    const alpha = source[si + 3]! / this.original.maximum;
    target[ti] = source[si]! * alpha; target[ti + 1] = source[si + 1]! * alpha;
    target[ti + 2] = source[si + 2]! * alpha; target[ti + 3] = source[si + 3]!;
  }

  private writePremultiplied(target: PixelArray, ti: number, source: Float32Array, si: number): void {
    const alpha = clampSample(source[si + 3]!, this.original.maximum);
    target[ti + 3] = alpha;
    if (alpha === 0) { target[ti] = 0; target[ti + 1] = 0; target[ti + 2] = 0; return; }
    const unpremultiply = this.original.maximum / alpha;
    target[ti] = clampSample(source[si]! * unpremultiply, this.original.maximum);
    target[ti + 1] = clampSample(source[si + 1]! * unpremultiply, this.original.maximum);
    target[ti + 2] = clampSample(source[si + 2]! * unpremultiply, this.original.maximum);
  }
}

function clampSample(value: number, maximum: number): number {
  return Math.min(maximum, Math.max(0, Math.round(value)));
}
