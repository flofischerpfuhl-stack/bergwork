import type { LayerTransform, Point, Rect } from '../geometry';
import { Raster } from '../raster';
import { makePixelArray, type PixelArray } from '../pixel/format';
import type { DocumentSelection } from '../selection';
import { RasterMapping, clampByte, selectionCoverage, unionRects, validPoint } from './common';
import type { RetouchStroke } from './warp';

export interface BlurSettings {
  readonly diameter: number;
  readonly hardness: number;
  /** The stroke-wide opacity cap, set by the 1–0 opacity keys. */
  readonly strength: number;
}

/** BlurTool.swift `blurSample`, painted through BrushStroke coverage without a full-canvas copy. */
export class BlurStroke implements RetouchStroke {
  readonly diameter: number;
  readonly hardness: number;
  readonly strength: number;
  readonly sigma: number;
  private readonly mapping: RasterMapping;
  private working: Raster;
  private coverage: Raster;
  private previous: Point | null = null;
  private distanceToNext = 0;
  private ended = false;

  constructor(readonly original: Raster, transform: LayerTransform, settings: BlurSettings,
    private readonly selection: DocumentSelection | null = null) {
    this.diameter = Math.min(2000, Math.max(1, Number.isFinite(settings.diameter) ? settings.diameter : 1));
    this.hardness = Math.min(1, Math.max(0, Number.isFinite(settings.hardness) ? settings.hardness : 0));
    this.strength = Math.min(1, Math.max(0.01, Number.isFinite(settings.strength) ? settings.strength : 1));
    // BlurTool.swift: sigma = clamp(diameter / 10, 1.5...30), in document pixels.
    this.sigma = Math.min(30, Math.max(1.5, this.diameter / 10));
    this.mapping = new RasterMapping(original, transform);
    this.working = original;
    this.coverage = Raster.blank(original.width, original.height, 1);
  }

  addPoints(points: readonly Point[]): Rect[] {
    if (this.ended) return [];
    const dirty: Rect[] = [];
    for (const point of points) {
      if (!validPoint(point)) continue;
      const dabs: Point[] = [];
      const spacing = Math.max(0.25, this.diameter * (this.hardness >= 1 ? 0.015 : 0.025));
      if (!this.previous) {
        dabs.push(point);
        this.distanceToNext = spacing;
      } else {
        const dx = point.x - this.previous.x, dy = point.y - this.previous.y, length = Math.hypot(dx, dy);
        let distance = this.distanceToNext;
        while (distance <= length) {
          dabs.push({ x: this.previous.x + dx * distance / length, y: this.previous.y + dy * distance / length });
          distance += spacing;
        }
        this.distanceToNext = distance - length;
      }
      this.previous = { ...point };
      const changed = this.applyDabs(dabs);
      if (changed) dirty.push(this.mapping.documentBounds(changed));
    }
    return dirty;
  }

  currentRaster(): Raster { return this.working; }
  finish(): Raster { this.ended = true; return this.working; }
  cancel(): Raster { this.ended = true; this.working = this.original; return this.original; }

  private applyDabs(dabs: readonly Point[]): Rect | null {
    let affected: Rect | null = null;
    for (const center of dabs) {
      const bounds = this.mapping.circleBounds(center, this.diameter / 2);
      if (!bounds) continue;
      const values = this.coverage.readRegion(bounds.x, bounds.y, bounds.width, bounds.height);
      for (let y = 0; y < bounds.height; y++) {
        for (let x = 0; x < bounds.width; x++) {
          const doc = this.mapping.documentPoint({ x: bounds.x + x + 0.5, y: bounds.y + y + 0.5 });
          const u = Math.hypot(doc.x - center.x, doc.y - center.y) / (this.diameter / 2);
          let tip = this.tip(u) * selectionCoverage(this.selection, doc);
          if (tip <= 0) continue;
          const i = y * bounds.width + x, old = values[i]! / 255;
          // BrushStroke uses screen for soft coverage and lighten for a hard tip.
          tip = this.hardness >= 1 ? Math.max(old, tip) : 1 - (1 - old) * (1 - tip);
          values[i] = clampByte(tip * 255);
        }
      }
      this.coverage = this.coverage.withRegion(bounds.x, bounds.y, bounds.width, bounds.height, values);
      affected = unionRects(affected, bounds);
    }
    if (!affected) return null;
    const scale = this.mapping.documentScale();
    const boundary = this.original.channels === 1 ? maskBackground(this.original) : 0;
    const blurred = gaussianRegion(this.original, affected,
      this.sigma / Math.max(1e-9, scale.x), this.sigma / Math.max(1e-9, scale.y), boundary);
    const base = this.original.readRegionNative(affected.x, affected.y, affected.width, affected.height);
    const mask = this.coverage.readRegion(affected.x, affected.y, affected.width, affected.height);
    const channels = this.original.channels;
    for (let i = 0; i < mask.length; i++) {
      const amount = mask[i]! / 255 * this.strength;
      if (amount <= 0) continue;
      const offset = i * channels;
      for (let channel = 0; channel < channels; channel++) {
        base[offset + channel] = clampSample(base[offset + channel]!
          + (blurred[offset + channel]! - base[offset + channel]!) * amount, this.original.maximum);
      }
    }
    this.working = this.working.withRegion(affected.x, affected.y, affected.width, affected.height, base);
    return affected;
  }

  /** BrushRaster.falloff; hardness is the full-strength inner radius. */
  private tip(u: number): number {
    if (u >= 1) return 0;
    if (u <= this.hardness) return 1;
    const v = (u - this.hardness) / (1 - this.hardness), k = 2.5;
    return Math.max(0, (Math.exp(-k * v * v) - Math.exp(-k)) / (1 - Math.exp(-k)));
  }
}

/** Separable Gaussian over one output region; RGBA is convolved premultiplied. */
export function gaussianRegion(source: Raster, region: Rect, sigmaX: number, sigmaY: number, boundary = 0): PixelArray {
  const kx = gaussianKernel(sigmaX), ky = gaussianKernel(sigmaY);
  const rx = (kx.length - 1) >> 1, ry = (ky.length - 1) >> 1;
  const expandedX = region.x - rx, expandedY = region.y - ry;
  const expandedWidth = region.width + rx * 2, expandedHeight = region.height + ry * 2;
  const channels = source.channels;
  let input: PixelArray;
  if (channels === 1 && boundary !== 0
      && (expandedX < 0 || expandedY < 0 || expandedX + expandedWidth > source.width || expandedY + expandedHeight > source.height)) {
    input = new Uint8Array(expandedWidth * expandedHeight); input.fill(boundary);
    const x0 = Math.max(0, expandedX), y0 = Math.max(0, expandedY);
    const x1 = Math.min(source.width, expandedX + expandedWidth), y1 = Math.min(source.height, expandedY + expandedHeight);
    if (x1 > x0 && y1 > y0) {
      const inside = source.readRegion(x0, y0, x1 - x0, y1 - y0);
      for (let y = 0; y < y1 - y0; y++) input.set(inside.subarray(y * (x1 - x0), (y + 1) * (x1 - x0)),
        (y + y0 - expandedY) * expandedWidth + x0 - expandedX);
    }
  } else input = source.readRegionNative(expandedX, expandedY, expandedWidth, expandedHeight);
  const horizontal = new Float32Array(region.width * expandedHeight * channels);
  for (let y = 0; y < expandedHeight; y++) {
    for (let x = 0; x < region.width; x++) {
      for (let k = -rx; k <= rx; k++) {
        const sx = x + rx + k, weight = kx[k + rx]!;
        const si = (y * expandedWidth + sx) * channels, hi = (y * region.width + x) * channels;
        if (channels === 4) {
          const a = input[si + 3]! / source.maximum;
          horizontal[hi] = horizontal[hi]! + input[si]! * a * weight;
          horizontal[hi + 1] = horizontal[hi + 1]! + input[si + 1]! * a * weight;
          horizontal[hi + 2] = horizontal[hi + 2]! + input[si + 2]! * a * weight;
          horizontal[hi + 3] = horizontal[hi + 3]! + input[si + 3]! * weight;
        } else horizontal[hi] = horizontal[hi]! + input[si]! * weight;
      }
    }
  }
  const output = makePixelArray(source.format, region.width * region.height * channels);
  for (let y = 0; y < region.height; y++) {
    for (let x = 0; x < region.width; x++) {
      const oi = (y * region.width + x) * channels;
      if (channels === 4) {
        let pr = 0, pg = 0, pb = 0, alpha = 0;
        for (let k = -ry; k <= ry; k++) {
          const hi = ((y + ry + k) * region.width + x) * 4, weight = ky[k + ry]!;
          pr += horizontal[hi]! * weight; pg += horizontal[hi + 1]! * weight;
          pb += horizontal[hi + 2]! * weight; alpha += horizontal[hi + 3]! * weight;
        }
        output[oi + 3] = clampSample(alpha, source.maximum);
        if (alpha > 0) {
          const unpremultiply = source.maximum / alpha;
          output[oi] = clampSample(pr * unpremultiply, source.maximum);
          output[oi + 1] = clampSample(pg * unpremultiply, source.maximum);
          output[oi + 2] = clampSample(pb * unpremultiply, source.maximum);
        }
      } else {
        let value = 0;
        for (let k = -ry; k <= ry; k++) value += horizontal[(y + ry + k) * region.width + x]! * ky[k + ry]!;
        output[oi] = clampSample(value, source.maximum);
      }
    }
  }
  return output;
}

function clampSample(value: number, maximum: number): number {
  return Math.min(maximum, Math.max(0, Math.round(value)));
}

/** LayerMask.background(of:): black or white, whichever covers most of the outer edge. */
function maskBackground(source: Raster): number {
  const top = source.readRegion(0, 0, source.width, 1);
  const bottom = source.height > 1 ? source.readRegion(0, source.height - 1, source.width, 1) : new Uint8Array(0);
  const left = source.height > 2 ? source.readRegion(0, 1, 1, source.height - 2) : new Uint8Array(0);
  const right = source.width > 1 && source.height > 2 ? source.readRegion(source.width - 1, 1, 1, source.height - 2) : new Uint8Array(0);
  let total = 0, count = 0;
  for (const edge of [top, bottom, left, right]) for (let i = 0; i < edge.length; i++) { total += edge[i]!; count++; }
  return total * 2 >= count * 255 ? 255 : 0;
}

function gaussianKernel(sigma: number): Float32Array {
  const safe = Math.max(0.01, sigma), radius = Math.max(1, Math.ceil(safe * 3));
  const result = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let x = -radius; x <= radius; x++) { const value = Math.exp(-(x * x) / (2 * safe * safe)); result[x + radius] = value; sum += value; }
  for (let i = 0; i < result.length; i++) result[i] = result[i]! / sum;
  return result;
}
