import type { Layer } from '../document';
import { maskTransform } from '../document';
import {
  apply, invert, pixelToDocument, type Affine, type LayerTransform, type Point, type Rect, type Size,
} from '../geometry';
import { Raster, TILE } from '../raster';
import type { DocumentSelection } from '../selection';
import { falloff, validateBrushSettings, type BrushSettings } from './settings';

interface Segment {
  x0: number; y0: number; x1: number; y1: number; pressure: number;
  vx: number; vy: number; length: number; ux: number; uy: number;
}
interface IntRect { x: number; y: number; width: number; height: number }
interface CoverageTile {
  readonly permanent: Float32Array;
  readonly base: Uint8Array;
  output: Uint8Array;
}

const QUADRATURE_NODES = [0.1834346425, 0.5255324099, 0.7966664774, 0.9602898565] as const;
const QUADRATURE_WEIGHTS = [0.3626837834, 0.3137066459, 0.2223810345, 0.1012285363] as const;
const COVERAGE_LUT_SIZE = 16_384;
const COVERAGE_LUT = new Float32Array(COVERAGE_LUT_SIZE + 1);
for (let i = 0; i <= COVERAGE_LUT_SIZE; i++) COVERAGE_LUT[i] = 1 - Math.exp(-20 * i / COVERAGE_LUT_SIZE);

export interface CloneSample {
  /** Straight-alpha sRGB at a document point, or transparent outside the source. */
  sample(point: Point): readonly [number, number, number, number];
  /** Source minus destination in document pixels. */
  readonly offset: Size;
  /** Copy transparent source pixels too (Blur uses this upstream; Clone Stamp normally does not). */
  readonly replace?: boolean;
}

export interface BeginStrokeOptions {
  readonly layer: Layer;
  readonly canvas: Size;
  readonly settings: BrushSettings;
  readonly target?: 'pixels' | 'mask';
  readonly selection?: DocumentSelection | null;
  readonly clone?: CloneSample;
  readonly pixelLimit?: number;
}

export interface StrokeUpdate { readonly dirty: Rect[] }

export interface StrokeResult {
  readonly raster: Raster;
  readonly transform?: LayerTransform;
  /** Working-grid bounds retained by the result; useful when expanding an attached mask. */
  readonly bounds: Rect;
  readonly sourceRect: Rect;
}

export interface Stroke {
  addPoints(points: readonly Point[], options?: { readonly pressure?: number | readonly number[] }): StrokeUpdate;
  currentRaster(): Raster;
  /** Where `currentRaster()` sits on the document (the working grid may extend past the layer). */
  currentTransform(): LayerTransform;
  finish(): StrokeResult;
  cancel(): void;
}

/** CPU port of MetalBrushCoverage.continuousBrush and BrushStroke's replaceable tail. */
export function beginStroke(options: BeginStrokeOptions): Stroke {
  return new ContinuousBrushStroke(options);
}

class ContinuousBrushStroke implements Stroke {
  private readonly settings: BrushSettings;
  private readonly selection: DocumentSelection | null;
  private readonly clone: CloneSample | undefined;
  private readonly isMask: boolean;
  private readonly canvas: Size;
  private readonly mapping: Affine;
  private readonly inverse: Affine;
  private readonly paintTransform: LayerTransform;
  private readonly coverage = new Map<number, CoverageTile>();
  private readonly originalSource: Raster | null;
  private readonly maxPixels: number;
  private readonly densityLut: Float32Array | null;
  private readonly radiusSquared: number;
  private readonly depositionSpacing: number;
  private samples: Point[] = [];
  private samplePressures: number[] = [];
  private tailAreas = new Map<number, IntRect>();
  private raster: Raster;
  private done = false;
  readonly sourceRect: Rect;

  constructor(options: BeginStrokeOptions) {
    validateBrushSettings(options.settings);
    if (!Number.isInteger(options.canvas.width) || !Number.isInteger(options.canvas.height)
      || options.canvas.width < 1 || options.canvas.height < 1) throw new RangeError('Invalid canvas size');
    this.settings = options.settings;
    this.selection = options.selection ?? null;
    this.clone = options.clone;
    this.isMask = options.target === 'mask';
    this.canvas = options.canvas;
    this.maxPixels = options.pixelLimit ?? 100_000_000;
    this.densityLut = options.settings.hardness < 1 ? makeDensityLut(options.settings.hardness) : null;
    this.radiusSquared = (options.settings.diameter / 2) ** 2;
    this.depositionSpacing = Math.max(0.25, options.settings.diameter * 0.025);

    const placedMask = this.isMask && options.layer.mask?.placement ? options.layer.mask : null;
    const baseTransform = placedMask ? maskTransform(options.layer) : options.layer.transform;
    const layerRaster = options.layer.raster;
    const source = this.isMask ? options.layer.mask?.raster ?? null : layerRaster;
    const originalWidth = placedMask?.raster.width ?? layerRaster?.width ?? Math.max(1, Math.round(options.layer.transform.size.width));
    const originalHeight = placedMask?.raster.height ?? layerRaster?.height ?? Math.max(1, Math.round(options.layer.transform.size.height));
    const originalMapping = pixelToDocument(baseTransform, originalWidth, originalHeight);
    const originalBounds: Rect = { x: 0, y: 0, width: originalWidth, height: originalHeight };
    const canvasInPixels = transformedBounds(invert(originalMapping), { x: 0, y: 0, ...options.canvas });
    const extent = this.isMask ? originalBounds : integralUnion(originalBounds, canvasInPixels);
    const width = extent.width, height = extent.height;
    if (width < 1 || height < 1 || width > 1_000_000_000 || height > 1_000_000_000
      || originalWidth > 30_000 || originalHeight > 30_000 || width * height > this.maxPixels) {
      throw new RangeError('Brush raster exceeds the pixel limit');
    }
    this.sourceRect = { x: -extent.x, y: -extent.y, width: originalWidth, height: originalHeight };
    this.mapping = translatedInput(originalMapping, extent.x, extent.y);
    this.inverse = invert(this.mapping);
    this.paintTransform = transformForBounds(baseTransform, originalWidth, originalHeight, originalMapping, extent);
    this.originalSource = source;
    this.raster = initialRaster(width, height, this.isMask ? 1 : 4, source, this.sourceRect, this.isMask);
  }

  addPoints(points: readonly Point[], options: { readonly pressure?: number | readonly number[] } = {}): StrokeUpdate {
    this.assertActive();
    const dirty: Rect[] = [];
    for (let i = 0; i < points.length; i++) {
      const point = points[i]!;
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || Math.abs(point.x) > 10_000_000
        || Math.abs(point.y) > 10_000_000 || samePoint(this.samples.at(-1), point)) continue;
      const pressureOption = options.pressure;
      const rawPressure = typeof pressureOption === 'number' ? pressureOption : pressureOption?.[i] ?? 1;
      const pressure = Number.isFinite(rawPressure) ? Math.min(1, Math.max(0, rawPressure)) : 1;
      this.samples.push({ ...point });
      this.samplePressures.push(pressure);
      if (this.samples.length > 4) { this.samples.shift(); this.samplePressures.shift(); }
      const n = this.samples.length;
      let settled: Segment[] = [];
      if (n === 1) settled = [segment(point, point, pressure)];
      else if (n >= 3) {
        settled = continuousCurve(this.samples[n - 3]!, this.samples[n - 2]!, this.samples[Math.max(0, n - 4)]!, point,
          this.samplePressures[n - 3]!, this.samplePressures[n - 2]!);
      }
      const nextTail = n >= 2
        ? [segment(this.samples[n - 2]!, point, (this.samplePressures[n - 2]! + pressure) / 2)] : [];
      dirty.push(...this.render(settled, nextTail));
    }
    return { dirty };
  }

  currentRaster(): Raster { return this.raster; }
  currentTransform(): LayerTransform { return this.paintTransform; }

  finish(): StrokeResult {
    this.assertActive();
    const n = this.samples.length;
    if (n >= 2) {
      const settled = continuousCurve(this.samples[n - 2]!, this.samples[n - 1]!, this.samples[Math.max(0, n - 3)]!,
        this.samples[n - 1]!, this.samplePressures[n - 2]!, this.samplePressures[n - 1]!);
      this.render(settled, []);
      this.samples = [this.samples[n - 1]!];
      this.samplePressures = [this.samplePressures[n - 1]!];
    }
    this.done = true;
    if (this.isMask) {
      const bounds = { x: 0, y: 0, width: this.raster.width, height: this.raster.height };
      return { raster: this.raster, bounds, sourceRect: this.sourceRect };
    }
    const painted = this.paintedBounds();
    const sourceBounds = this.originalSource ? this.sourceRect : null;
    const crop = painted ? integralUnion(sourceBounds, painted) : sourceBounds
      ?? { x: 0, y: 0, width: this.raster.width, height: this.raster.height };
    const raster = crop.x === 0 && crop.y === 0 && crop.width === this.raster.width && crop.height === this.raster.height
      ? this.raster : cropTiled(this.raster, crop);
    return { raster, transform: this.transform(crop), bounds: crop, sourceRect: this.sourceRect };
  }

  cancel(): void {
    this.done = true;
    this.coverage.clear();
    this.tailAreas.clear();
  }

  private assertActive(): void {
    if (this.done) throw new Error('Brush stroke is no longer active');
  }

  private transform(bounds: Rect): LayerTransform {
    const center = apply(this.mapping, { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 });
    const size = {
      width: bounds.width * this.paintTransform.size.width / this.raster.width,
      height: bounds.height * this.paintTransform.size.height / this.raster.height,
    };
    return { ...this.paintTransform, size, origin: { x: center.x - size.width / 2, y: center.y - size.height / 2 } };
  }

  /** BrushStroke.paintSnapshot scans changed tiles only; existing source bounds are already known. */
  private paintedBounds(): Rect | null {
    let bounds: Rect | null = null;
    for (const [key, state] of this.coverage) {
      const col = key % this.raster.cols, row = Math.floor(key / this.raster.cols);
      const tw = this.raster.tileWidth(col), th = this.raster.tileHeight(row);
      let left = tw, right = 0, top = th, bottom = 0;
      for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
        if (state.output[(y * tw + x) * 4 + 3]) {
          if (x < left) left = x;
          if (x + 1 > right) right = x + 1;
          if (y < top) top = y;
          if (y + 1 > bottom) bottom = y + 1;
        }
      }
      if (right > left) bounds = integralUnion(bounds, {
        x: col * TILE + left, y: row * TILE + top, width: right - left, height: bottom - top,
      });
    }
    return bounds;
  }

  private render(settled: readonly Segment[], tail: readonly Segment[]): Rect[] {
    const settledAreas = this.areas(settled);
    const tailAreas = this.areas(tail);
    const changed = mergeAreaMaps(this.tailAreas, settledAreas, tailAreas);
    if (!changed.size) { this.tailAreas = tailAreas; return []; }

    for (const [key, rect] of settledAreas) {
      const tile = this.tile(key);
      this.accumulate(tile.permanent, key, rect, settled);
    }

    const tiles = this.raster.tiles.slice();
    const dirty: Rect[] = [];
    for (const [key, rect] of changed) {
      const state = this.tile(key);
      const col = key % this.raster.cols, row = Math.floor(key / this.raster.cols);
      // A Raster already handed to the renderer must remain immutable while the tail moves.
      state.output = state.output.slice();
      this.compose(state, key, rect, tail);
      tiles[key] = isZero(state.output) ? null : state.output;
      dirty.push({ x: col * TILE + rect.x, y: row * TILE + rect.y, width: rect.width, height: rect.height });
    }
    this.raster = new Raster(this.raster.width, this.raster.height, this.raster.channels, tiles);
    this.tailAreas = tailAreas;
    return dirty;
  }

  private areas(segments: readonly Segment[]): Map<number, IntRect> {
    const result = new Map<number, IntRect>();
    const reach = this.settings.diameter / 2 + 2;
    for (const s of segments) {
      const documentRect = intersectRect({
        x: Math.min(s.x0, s.x1) - reach,
        y: Math.min(s.y0, s.y1) - reach,
        width: Math.abs(s.x1 - s.x0) + reach * 2,
        height: Math.abs(s.y1 - s.y0) + reach * 2,
      }, { x: 0, y: 0, ...this.canvas });
      if (!documentRect) continue;
      const pixels = intersectRect(integralBounds(transformedBounds(this.inverse, documentRect)),
        { x: 0, y: 0, width: this.raster.width, height: this.raster.height });
      if (!pixels) continue;
      const x0 = Math.floor(pixels.x / TILE), x1 = Math.floor((pixels.x + pixels.width - 1) / TILE);
      const y0 = Math.floor(pixels.y / TILE), y1 = Math.floor((pixels.y + pixels.height - 1) / TILE);
      for (let row = y0; row <= y1; row++) for (let col = x0; col <= x1; col++) {
        const tileGlobal = { x: col * TILE, y: row * TILE, width: this.raster.tileWidth(col), height: this.raster.tileHeight(row) };
        const overlap = intersectRect(pixels, tileGlobal);
        if (!overlap) continue;
        const local = { x: overlap.x - tileGlobal.x, y: overlap.y - tileGlobal.y, width: overlap.width, height: overlap.height };
        const key = row * this.raster.cols + col;
        result.set(key, unionInt(result.get(key), local));
      }
    }
    return result;
  }

  private tile(key: number): CoverageTile {
    let state = this.coverage.get(key);
    if (state) return state;
    const col = key % this.raster.cols, row = Math.floor(key / this.raster.cols);
    const width = this.raster.tileWidth(col), height = this.raster.tileHeight(row);
    const existing = this.raster.tiles[key];
    const base = existing ? existing.slice() : new Uint8Array(width * height * this.raster.channels);
    state = { permanent: new Float32Array(width * height), base, output: base.slice() };
    this.coverage.set(key, state);
    return state;
  }

  private accumulate(density: Float32Array, key: number, rect: IntRect, segments: readonly Segment[]): void {
    const col = key % this.raster.cols, row = Math.floor(key / this.raster.cols);
    const tw = this.raster.tileWidth(col);
    const hard = this.settings.hardness >= 1;
    const m = this.mapping;
    for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) {
      const gx = col * TILE + x + 0.5, gy = row * TILE + y + 0.5;
      const px = m.a * gx + m.c * gy + m.tx, py = m.b * gx + m.d * gy + m.ty;
      if (!insideCanvasXY(px, py, this.canvas)) continue;
      const index = y * tw + x;
      if (hard) {
        let value = density[index]!;
        for (const s of segments) value = Math.max(value, hardSegmentCoverageXY(px, py, s, this.settings, this.mapping));
        density[index] = value;
      } else {
        let value = density[index]!;
        for (const s of segments) value += segmentDensityXY(px, py, s, this.radiusSquared, this.depositionSpacing, this.densityLut!);
        density[index] = Math.min(value, 20);
      }
    }
  }

  private compose(state: CoverageTile, key: number, rect: IntRect, tail: readonly Segment[]): void {
    const col = key % this.raster.cols, row = Math.floor(key / this.raster.cols);
    const tw = this.raster.tileWidth(col), ch = this.raster.channels;
    const hard = this.settings.hardness >= 1;
    const m = this.mapping;
    for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) {
      const gx = col * TILE + x + 0.5, gy = row * TILE + y + 0.5;
      const px = m.a * gx + m.c * gy + m.tx, py = m.b * gx + m.d * gy + m.ty;
      const pixel = y * tw + x;
      let coverage = state.permanent[pixel]!;
      if (insideCanvasXY(px, py, this.canvas)) {
        if (hard) {
          for (const s of tail) coverage = Math.max(coverage, hardSegmentCoverageXY(px, py, s, this.settings, this.mapping));
        } else {
          let tailDensity = 0;
          for (const s of tail) tailDensity += segmentDensityXY(px, py, s, this.radiusSquared, this.depositionSpacing, this.densityLut!);
          coverage = densityCoverage(coverage + tailDensity);
        }
      } else coverage = 0;
      coverage *= this.selectionCoverageXY(px, py) * this.settings.opacity;
      const offset = pixel * ch;
      if (ch === 1) this.composeMask(state, offset, coverage);
      else this.composeColour(state, offset, coverage, px, py);
    }
  }

  private selectionCoverageXY(px: number, py: number): number {
    if (!this.selection) return 1;
    const x = Math.floor(px - this.selection.x), y = Math.floor(py - this.selection.y);
    return rasterChannel(this.selection.mask, x, y, 0) / 255;
  }

  private composeMask(state: CoverageTile, offset: number, alpha: number): void {
    const base = state.base[offset]!;
    const paint = Math.round(this.settings.red * 255);
    state.output[offset] = clampByte(paint * alpha + base * (1 - alpha));
  }

  private composeColour(state: CoverageTile, offset: number, alpha: number, px: number, py: number): void {
    const ba = state.base[offset + 3]! / 255;
    if (this.settings.mode === 'erase') {
      const outA = ba * (1 - alpha);
      state.output[offset] = outA > 0 ? state.base[offset]! : 0;
      state.output[offset + 1] = outA > 0 ? state.base[offset + 1]! : 0;
      state.output[offset + 2] = outA > 0 ? state.base[offset + 2]! : 0;
      state.output[offset + 3] = clampByte(outA * 255);
      return;
    }
    let sr = this.settings.red * 255, sg = this.settings.green * 255, sb = this.settings.blue * 255, sa = alpha;
    if (this.clone) {
      const sampled = this.clone.sample({ x: px + this.clone.offset.width, y: py + this.clone.offset.height });
      sr = sampled[0]; sg = sampled[1]; sb = sampled[2]; sa *= sampled[3] / 255;
      if (this.clone.replace) {
        const mix = alpha;
        state.output[offset] = clampByte(sr * mix + state.base[offset]! * (1 - mix));
        state.output[offset + 1] = clampByte(sg * mix + state.base[offset + 1]! * (1 - mix));
        state.output[offset + 2] = clampByte(sb * mix + state.base[offset + 2]! * (1 - mix));
        state.output[offset + 3] = clampByte(sampled[3] * mix + state.base[offset + 3]! * (1 - mix));
        return;
      }
    }
    if (ba === 0) {
      if (sa <= 0) state.output.fill(0, offset, offset + 4);
      else {
        state.output[offset] = clampByte(sr);
        state.output[offset + 1] = clampByte(sg);
        state.output[offset + 2] = clampByte(sb);
        state.output[offset + 3] = clampByte(sa * 255);
      }
      return;
    }
    const outA = sa + ba * (1 - sa);
    if (outA <= 0) {
      state.output.fill(0, offset, offset + 4);
      return;
    }
    const keep = ba * (1 - sa);
    state.output[offset] = clampByte((sr * sa + state.base[offset]! * keep) / outA);
    state.output[offset + 1] = clampByte((sg * sa + state.base[offset + 1]! * keep) / outA);
    state.output[offset + 2] = clampByte((sb * sa + state.base[offset + 2]! * keep) / outA);
    state.output[offset + 3] = clampByte(outA * 255);
  }
}

function segment(a: Point, b: Point, pressure: number): Segment {
  const vx = b.x - a.x, vy = b.y - a.y, length = Math.hypot(vx, vy);
  return { x0: a.x, y0: a.y, x1: b.x, y1: b.y, pressure, vx, vy, length,
    ux: length > 0 ? vx / length : 0, uy: length > 0 ? vy / length : 0 };
}

/** Centripetal Catmull-Rom with BrushStroke's 0.2-document-pixel adaptive chords. */
function continuousCurve(start: Point, end: Point, before: Point, after: Point, startPressure: number, endPressure: number): Segment[] {
  const knot = (t: number, a: Point, b: Point) => t + Math.max(0.0001, Math.sqrt(Math.hypot(b.x - a.x, b.y - a.y)));
  const mix = (a: Point, b: Point, ta: number, tb: number, t: number): Point => {
    const wa = (tb - t) / (tb - ta), wb = (t - ta) / (tb - ta);
    return { x: a.x * wa + b.x * wb, y: a.y * wa + b.y * wb };
  };
  const t0 = 0, t1 = knot(t0, before, start), t2 = knot(t1, start, end), t3 = knot(t2, end, after);
  const point = (u: number): Point => {
    if (u === 0) return start;
    if (u === 1) return end;
    const t = t1 + (t2 - t1) * u;
    const a = mix(before, start, t0, t1, t), b = mix(start, end, t1, t2, t), c = mix(end, after, t2, t3, t);
    return mix(mix(a, b, t0, t2, t), mix(b, c, t1, t3, t), t1, t2, t);
  };
  const result: Segment[] = [];
  const subdivide = (a: Point, b: Point, lo: number, hi: number, depth: number): void => {
    const dx = b.x - a.x, dy = b.y - a.y, lengthSquared = dx * dx + dy * dy;
    const error = (p: Point): number => {
      const projected = lengthSquared > 0 ? Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared)) : 0;
      return Math.hypot(p.x - a.x - projected * dx, p.y - a.y - projected * dy);
    };
    const mid = (lo + hi) / 2, m = point(mid);
    const deviation = Math.max(error(m), error(point((lo + mid) / 2)), error(point((mid + hi) / 2)));
    if (deviation <= 0.2 || depth >= 10) {
      result.push(segment(a, b, (startPressure * (1 - (lo + hi) / 2) + endPressure * ((lo + hi) / 2))));
      return;
    }
    subdivide(a, m, lo, mid, depth + 1);
    subdivide(m, b, mid, hi, depth + 1);
  };
  subdivide(start, end, 0, 1, 0);
  return result;
}

function brushCoverage(distanceSquared: number, settings: BrushSettings, mapping: Affine): number {
  const distance = Math.sqrt(distanceSquared), radius = settings.diameter / 2;
  if (settings.hardness >= 1) {
    const antialias = Math.max(0.001, Math.min(Math.hypot(mapping.a, mapping.b), Math.hypot(mapping.c, mapping.d)));
    return Math.min(1, Math.max(0, (radius - distance) / antialias + 0.5));
  }
  const u = Math.min(1, Math.max(0, (distance / radius - settings.hardness) / (1 - settings.hardness)));
  return falloff(u);
}

function distanceSquaredToSegmentXY(px: number, py: number, s: Segment): number {
  const lengthSquared = s.length * s.length;
  const t = Math.min(1, Math.max(0, ((px - s.x0) * s.vx + (py - s.y0) * s.vy) / Math.max(lengthSquared, 1e-12)));
  const dx = px - (s.x0 + t * s.vx), dy = py - (s.y0 + t * s.vy);
  return dx * dx + dy * dy;
}

function hardSegmentCoverageXY(px: number, py: number, s: Segment, settings: BrushSettings, mapping: Affine): number {
  return brushCoverage(distanceSquaredToSegmentXY(px, py, s), settings, mapping) * s.pressure;
}

/** Eight-point Gauss-Legendre integration from MetalBrushCoverage.segmentDensity. */
function segmentDensityXY(px: number, py: number, s: Segment, radiusSquared: number, spacing: number,
  densityLut: Float32Array): number {
  if (s.pressure <= 0) return 0;
  if (s.length < 1e-6) return densityLookup(densityLut, ((px - s.x0) ** 2 + (py - s.y0) ** 2) / radiusSquared) * s.pressure;
  const projection = (px - s.x0) * s.ux + (py - s.y0) * s.uy;
  const perpendicularX = px - s.x0 - projection * s.ux, perpendicularY = py - s.y0 - projection * s.uy;
  const perpendicularSquared = perpendicularX * perpendicularX + perpendicularY * perpendicularY;
  if (perpendicularSquared >= radiusSquared) return 0;
  const reach = Math.sqrt(radiusSquared - perpendicularSquared);
  const lo = Math.max(0, projection - reach), hi = Math.min(s.length, projection + reach);
  if (hi <= lo) return 0;
  const midpoint = (lo + hi) / 2, halfLength = (hi - lo) / 2;
  let integral = 0;
  for (let i = 0; i < 4; i++) {
    const a = midpoint - halfLength * QUADRATURE_NODES[i]! - projection;
    const b = midpoint + halfLength * QUADRATURE_NODES[i]! - projection;
    integral += QUADRATURE_WEIGHTS[i]! * (densityLookup(densityLut, (perpendicularSquared + a * a) / radiusSquared)
      + densityLookup(densityLut, (perpendicularSquared + b * b) / radiusSquared));
  }
  return integral * halfLength / spacing * s.pressure;
}

const DENSITY_LUT_SIZE = 4096;
function makeDensityLut(hardness: number): Float32Array {
  const result = new Float32Array(DENSITY_LUT_SIZE + 1);
  for (let i = 0; i <= DENSITY_LUT_SIZE; i++) {
    const normalizedDistance = Math.sqrt(i / DENSITY_LUT_SIZE);
    const u = Math.min(1, Math.max(0, (normalizedDistance - hardness) / (1 - hardness)));
    result[i] = -Math.log(Math.max(1 - falloff(u), 0.001));
  }
  return result;
}

function densityLookup(table: Float32Array, normalizedSquared: number): number {
  if (normalizedSquared >= 1) return 0;
  if (normalizedSquared <= 0) return table[0]!;
  const position = normalizedSquared * DENSITY_LUT_SIZE;
  const index = Math.floor(position), fraction = position - index;
  return table[index]! * (1 - fraction) + table[index + 1]! * fraction;
}

function densityCoverage(density: number): number {
  if (density <= 0) return 0;
  if (density >= 20) return COVERAGE_LUT[COVERAGE_LUT_SIZE]!;
  const position = density / 20 * COVERAGE_LUT_SIZE;
  const index = Math.floor(position), fraction = position - index;
  return COVERAGE_LUT[index]! * (1 - fraction) + COVERAGE_LUT[index + 1]! * fraction;
}

function initialRaster(width: number, height: number, channels: 1 | 4, source: Raster | null, sourceRect: Rect, mask: boolean): Raster {
  if (source && source.width === width && source.height === height && source.channels === channels
    && sourceRect.x === 0 && sourceRect.y === 0) return source;
  const cols = Math.ceil(width / TILE), rows = Math.ceil(height / TILE);
  const tiles: (Uint8Array | null)[] = new Array(cols * rows).fill(null);
  if (!source) return new Raster(width, height, channels, tiles);
  const uniform = source.width === 1 && source.height === 1 ? source.pixel(0, 0) : null;
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
    const tw = Math.min(TILE, width - col * TILE), th = Math.min(TILE, height - row * TILE);
    const tile = new Uint8Array(tw * th * channels);
    let nonzero = false;
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
      const gx = col * TILE + x, gy = row * TILE + y;
      const sx = Math.floor((gx - sourceRect.x) * source.width / sourceRect.width);
      const sy = Math.floor((gy - sourceRect.y) * source.height / sourceRect.height);
      let values: number[];
      if (sx >= 0 && sy >= 0 && sx < source.width && sy < source.height) values = uniform ?? source.pixel(sx, sy);
      else values = mask ? [255] : [0, 0, 0, 0];
      const offset = (y * tw + x) * channels;
      for (let c = 0; c < channels; c++) { const value = values[c] ?? 0; tile[offset + c] = value; nonzero ||= value !== 0; }
    }
    if (nonzero) tiles[row * cols + col] = tile;
  }
  return new Raster(width, height, channels, tiles);
}

function cropTiled(source: Raster, rect: Rect): Raster {
  const cols = Math.ceil(rect.width / TILE), rows = Math.ceil(rect.height / TILE);
  const tiles: (Uint8Array | null)[] = [];
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
    const width = Math.min(TILE, rect.width - col * TILE), height = Math.min(TILE, rect.height - row * TILE);
    const bytes = source.readRegion(rect.x + col * TILE, rect.y + row * TILE, width, height);
    tiles.push(isZero(bytes) ? null : bytes);
  }
  return new Raster(rect.width, rect.height, source.channels, tiles);
}

function transformForBounds(base: LayerTransform, originalWidth: number, originalHeight: number, mapping: Affine, bounds: Rect): LayerTransform {
  const middle = apply(mapping, { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 });
  const size = { width: bounds.width * base.size.width / originalWidth, height: bounds.height * base.size.height / originalHeight };
  return { ...base, size, origin: { x: middle.x - size.width / 2, y: middle.y - size.height / 2 } };
}

function transformedBounds(transform: Affine, rect: Rect): Rect {
  const points = [
    apply(transform, { x: rect.x, y: rect.y }), apply(transform, { x: rect.x + rect.width, y: rect.y }),
    apply(transform, { x: rect.x, y: rect.y + rect.height }), apply(transform, { x: rect.x + rect.width, y: rect.y + rect.height }),
  ];
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

function integralBounds(rect: Rect): Rect {
  const x = Math.floor(rect.x), y = Math.floor(rect.y);
  return { x, y, width: Math.ceil(rect.x + rect.width) - x, height: Math.ceil(rect.y + rect.height) - y };
}

function integralUnion(a: Rect | null, b: Rect): Rect {
  if (!a) return integralBounds(b);
  const x = Math.floor(Math.min(a.x, b.x)), y = Math.floor(Math.min(a.y, b.y));
  return { x, y, width: Math.ceil(Math.max(a.x + a.width, b.x + b.width)) - x,
    height: Math.ceil(Math.max(a.y + a.height, b.y + b.height)) - y };
}

function translatedInput(m: Affine, x: number, y: number): Affine {
  return { ...m, tx: m.tx + m.a * x + m.c * y, ty: m.ty + m.b * x + m.d * y };
}

function intersectRect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width), bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

function unionInt(a: IntRect | undefined, b: IntRect): IntRect {
  if (!a) return b;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

function mergeAreaMaps(...maps: ReadonlyMap<number, IntRect>[]): Map<number, IntRect> {
  const result = new Map<number, IntRect>();
  for (const map of maps) for (const [key, rect] of map) result.set(key, unionInt(result.get(key), rect));
  return result;
}

function samePoint(a: Point | undefined, b: Point): boolean { return !!a && a.x === b.x && a.y === b.y; }
function insideCanvasXY(x: number, y: number, canvas: Size): boolean { return x >= 0 && y >= 0 && x < canvas.width && y < canvas.height; }
function clampByte(value: number): number { return Math.min(255, Math.max(0, Math.round(value))); }
function isZero(data: Uint8Array): boolean { for (let i = 0; i < data.length; i++) if (data[i]) return false; return true; }

function rasterChannel(raster: Raster, x: number, y: number, channel: number): number {
  if (x < 0 || y < 0 || x >= raster.width || y >= raster.height) return 0;
  const col = Math.floor(x / TILE), row = Math.floor(y / TILE);
  const tile = raster.tiles[row * raster.cols + col];
  if (!tile) return 0;
  const offset = ((y - row * TILE) * raster.tileWidth(col) + (x - col * TILE)) * raster.channels + channel;
  return tile[offset] ?? 0;
}
