import type { Layer } from '../document';
import { maskTransform } from '../document';
import {
  apply, invert, pixelToDocument, type Affine, type LayerTransform, type Point, type Rect, type Size,
} from '../geometry';
import { Raster, TILE } from '../raster';
import type { DocumentSelection } from '../selection';
import { falloff, validateBrushSettings, type BrushSettings } from './settings';

export interface BrushSegment {
  x0: number; y0: number; x1: number; y1: number; pressure: number;
  vx: number; vy: number; length: number; ux: number; uy: number;
}
type Segment = BrushSegment;
interface IntRect { x: number; y: number; width: number; height: number }
interface CoverageTile {
  readonly permanent: Float32Array;
  tail: Float32Array | null;
  readonly base: Uint8Array | null;
  readonly baseIsZero: boolean;
  readonly baseIsOpaque: boolean;
  output: Uint8Array;
}

const COVERAGE_LUT_SIZE = 16_384;
const COVERAGE_LUT = new Float32Array(COVERAGE_LUT_SIZE + 1);
for (let i = 0; i <= COVERAGE_LUT_SIZE; i++) COVERAGE_LUT[i] = 1 - Math.exp(-20 * i / COVERAGE_LUT_SIZE);

interface IntegralDensityTable { readonly values: Float32Array; readonly rows: number; readonly columns: number }
interface TailDensityTemplate {
  readonly segment: Segment;
  readonly x: number; readonly y: number; readonly width: number; readonly height: number;
  readonly values: Float32Array;
}
const INTEGRAL_ROWS = 512;
const INTEGRAL_COLUMNS = 2048;
const integralDensityCache = new Map<number, IntegralDensityTable>();

/** Prepares the expensive soft-tip prefix table while a persistent brush worker is idle. */
export function warmBrushDensity(hardness: number): void {
  if (!(hardness >= 0 && hardness < 1) || integralDensityCache.has(hardness)) return;
  const density = makeDensityLut(hardness);
  integralDensityTable(hardness, density);
}

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
  /** Internal worker sharding: this rasterizer owns tile keys congruent to `index` modulo `count`. */
  readonly tilePartition?: { readonly index: number; readonly count: number };
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

/** Exact rasterizer used by the browser worker after geometry has been settled on the main thread. */
export interface SettledStroke {
  addSettled(segments: readonly BrushSegment[]): StrokeUpdate;
  currentRaster(): Raster;
  finish(finalSegments: readonly BrushSegment[]): StrokeResult;
  cancel(): void;
}

/** CPU port of MetalBrushCoverage.continuousBrush and BrushStroke's replaceable tail. */
export function beginStroke(options: BeginStrokeOptions): Stroke {
  return new ContinuousBrushStroke(options);
}

/** MetalBrushCoverage.swift's permanent/tail split, with only permanent segments accepted here. */
export function beginSettledStroke(options: BeginStrokeOptions): SettledStroke {
  const stroke = new ContinuousBrushStroke(options);
  return {
    addSettled: (segments) => stroke.addSettled(segments),
    currentRaster: () => stroke.currentRaster(),
    finish: (segments) => stroke.finishSettled(segments),
    cancel: () => stroke.cancel(),
  };
}

/** Straightforward pixel-major path used to prove optimized irregular-stroke equivalence. */
export function beginReferenceStroke(options: BeginStrokeOptions): Stroke {
  return new ContinuousBrushStroke(options, true);
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
  private readonly pendingSnapshotKeys = new Set<number>();
  private readonly originalSource: Raster | null;
  private readonly maxPixels: number;
  private readonly densityLut: Float32Array | null;
  private readonly integralDensity: IntegralDensityTable | null;
  private readonly radius: number;
  private readonly radiusSquared: number;
  private readonly depositionSpacing: number;
  private readonly rowSpan = new Int32Array(2);
  private readonly paintRed: number;
  private readonly paintGreen: number;
  private readonly paintBlue: number;
  private readonly blankSaturationDensity: number | null;
  private readonly fastRgbaPaint: boolean;
  private readonly curveTolerance: number;
  private readonly tilePartition: BeginStrokeOptions['tilePartition'];
  private samples: Point[] = [];
  private samplePressures: number[] = [];
  private tailSegments: Segment[] = [];
  private tailAreas = new Map<number, IntRect>();
  private tailDensityTemplate: TailDensityTemplate | null = null;
  private readonly settledOnlyAreas = new Map<number, IntRect>();
  private raster: Raster;
  private done = false;
  readonly sourceRect: Rect;

  constructor(options: BeginStrokeOptions, private readonly reference = false) {
    validateBrushSettings(options.settings);
    if (!Number.isInteger(options.canvas.width) || !Number.isInteger(options.canvas.height)
      || options.canvas.width < 1 || options.canvas.height < 1) throw new RangeError('Invalid canvas size');
    this.settings = options.settings;
    this.selection = options.selection ?? null;
    this.clone = options.clone;
    this.isMask = options.target === 'mask';
    this.canvas = options.canvas;
    this.maxPixels = options.pixelLimit ?? 100_000_000;
    this.tilePartition = options.tilePartition;
    this.densityLut = options.settings.hardness < 1 ? makeDensityLut(options.settings.hardness) : null;
    this.integralDensity = this.densityLut ? integralDensityTable(options.settings.hardness, this.densityLut) : null;
    this.radius = options.settings.diameter / 2;
    this.radiusSquared = this.radius * this.radius;
    this.depositionSpacing = Math.max(0.25, options.settings.diameter * 0.025);
    this.paintRed = clampByte(options.settings.red * 255);
    this.paintGreen = clampByte(options.settings.green * 255);
    this.paintBlue = clampByte(options.settings.blue * 255);
    const maximumAlpha = clampByte(COVERAGE_LUT[COVERAGE_LUT_SIZE]! * options.settings.opacity * 255);
    const saturationCoverage = (maximumAlpha - 0.499) / (options.settings.opacity * 255);
    this.blankSaturationDensity = options.settings.hardness < 1 && options.settings.mode === 'paint'
      && !options.clone && !options.selection && saturationCoverage > 0 && saturationCoverage < 1
      ? -Math.log(1 - saturationCoverage) : null;
    this.fastRgbaPaint = !this.reference && !this.isMask && options.settings.mode === 'paint'
      && !options.clone && !options.selection;
    this.curveTolerance = this.fastRgbaPaint && this.radius >= 128 ? 0.3 : 0.2;

    const placedMask = this.isMask && options.layer.mask?.placement ? options.layer.mask : null;
    const baseTransform = placedMask ? maskTransform(options.layer) : options.layer.transform;
    const layerRaster = options.layer.raster;
    const source = this.isMask ? options.layer.mask?.raster ?? null : layerRaster;
    if (source?.format === 'rgba16') {
      throw new Error('The existing 8-bit brush kernel cannot paint an rgba16 layer yet.');
    }
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
          this.samplePressures[n - 3]!, this.samplePressures[n - 2]!, this.curveTolerance);
      }
      const nextTail = n >= 2
        ? [segment(this.samples[n - 2]!, point, (this.samplePressures[n - 2]! + pressure) / 2)] : [];
      dirty.push(...this.render(settled, nextTail));
    }
    return { dirty };
  }

  addSettled(segments: readonly BrushSegment[]): StrokeUpdate {
    this.assertActive();
    if (!segments.length) return { dirty: [] };
    const areas = this.areas(segments), dirty: Rect[] = [];
    for (const [key, rect] of areas) {
      this.accumulate(this.tile(key).permanent, key, rect, segments);
      this.settledOnlyAreas.set(key, unionInt(this.settledOnlyAreas.get(key), rect));
      const col = key % this.raster.cols, row = Math.floor(key / this.raster.cols);
      dirty.push({ x: col * TILE + rect.x, y: row * TILE + rect.y, width: rect.width, height: rect.height });
    }
    return { dirty };
  }

  currentRaster(): Raster {
    this.publishSnapshot();
    return this.raster;
  }
  currentTransform(): LayerTransform { return this.paintTransform; }

  finish(): StrokeResult {
    this.assertActive();
    const n = this.samples.length;
    if (n >= 2) {
      const settled = continuousCurve(this.samples[n - 2]!, this.samples[n - 1]!, this.samples[Math.max(0, n - 3)]!,
        this.samples[n - 1]!, this.samplePressures[n - 2]!, this.samplePressures[n - 1]!, this.curveTolerance);
      this.render(settled, []);
      this.samples = [this.samples[n - 1]!];
      this.samplePressures = [this.samplePressures[n - 1]!];
    }
    return this.finishedResult();
  }

  finishSettled(finalSegments: readonly BrushSegment[]): StrokeResult {
    this.assertActive();
    if (finalSegments.length) this.addSettled(finalSegments);
    for (const [key, rect] of this.settledOnlyAreas) {
      if (this.compose(this.tile(key), key, rect, [], false, null)) this.pendingSnapshotKeys.add(key);
    }
    return this.finishedResult();
  }

  private finishedResult(): StrokeResult {
    this.publishSnapshot();
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
    this.pendingSnapshotKeys.clear();
    this.tailSegments = [];
    this.tailAreas.clear();
    this.tailDensityTemplate = null;
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
    const promotesTail = settled.length > 0 && segmentsEqual(settled, this.tailSegments);
    const changed = promotesTail ? tailAreas : mergeAreaMaps(this.tailAreas, settledAreas, tailAreas);
    let templateShift: Point | null = null;

    if (promotesTail && tail.length === 1 && this.tailSegments.length === 1
      && translatedSegments(this.tailSegments[0]!, tail[0]!, this.canvas, this.settings.diameter / 2 + 2)) {
      if (!this.templateShift(this.tailSegments[0]!)) this.captureTailDensity(this.tailSegments[0]!, this.tailAreas);
      templateShift = this.templateShift(tail[0]!);
    }

    if (promotesTail) {
      for (const [key, rect] of this.tailAreas) this.promoteTail(this.tile(key), key, rect, this.tailSegments[0]!);
    } else {
      for (const [key, rect] of settledAreas) {
        const tile = this.tile(key);
        this.accumulate(tile.permanent, key, rect, settled);
      }
    }

    if (!changed.size) { this.tailSegments = [...tail]; this.tailAreas = tailAreas; return []; }

    const dirty: Rect[] = [];
    for (const [key, rect] of changed) {
      const state = this.tile(key);
      const col = key % this.raster.cols, row = Math.floor(key / this.raster.cols);
      const changedOutput = this.compose(state, key, rect, tail, promotesTail, templateShift);
      if (!changedOutput) continue;
      this.pendingSnapshotKeys.add(key);
      dirty.push({ x: col * TILE + rect.x, y: row * TILE + rect.y, width: rect.width, height: rect.height });
    }
    for (const key of this.tailAreas.keys()) {
      if (!tailAreas.has(key)) {
        const state = this.coverage.get(key);
        if (state) state.tail = null;
      }
    }
    this.tailSegments = [...tail];
    this.tailAreas = tailAreas;
    return dirty;
  }

  /** Reuse an identical translated tail's density; regular pointer sampling often repeats its chord exactly. */
  private captureTailDensity(segment: Segment, areas: ReadonlyMap<number, IntRect>): void {
    let left = this.raster.width, top = this.raster.height, right = 0, bottom = 0;
    for (const [key, rect] of areas) {
      const col = key % this.raster.cols, row = Math.floor(key / this.raster.cols);
      left = Math.min(left, col * TILE + rect.x); top = Math.min(top, row * TILE + rect.y);
      right = Math.max(right, col * TILE + rect.x + rect.width);
      bottom = Math.max(bottom, row * TILE + rect.y + rect.height);
    }
    if (right <= left || bottom <= top) return;
    const width = right - left, height = bottom - top;
    const values = new Float32Array(width * height);
    for (const [key, rect] of areas) {
      const state = this.coverage.get(key), tail = state?.tail;
      if (!tail) continue;
      const col = key % this.raster.cols, row = Math.floor(key / this.raster.cols), tw = this.raster.tileWidth(col);
      const gx = col * TILE + rect.x, gy = row * TILE + rect.y;
      for (let y = 0; y < rect.height; y++) {
        const source = (rect.y + y) * tw + rect.x;
        const destination = (gy + y - top) * width + gx - left;
        values.set(tail.subarray(source, source + rect.width), destination);
      }
    }
    this.tailDensityTemplate = { segment, x: left, y: top, width, height, values };
  }

  private templateShift(segment: Segment): Point | null {
    const template = this.tailDensityTemplate;
    if (!template || template.segment.vx !== segment.vx || template.segment.vy !== segment.vy
      || template.segment.pressure !== segment.pressure) return null;
    const dx = segment.x0 - template.segment.x0, dy = segment.y0 - template.segment.y0;
    const gx = this.inverse.a * dx + this.inverse.c * dy, gy = this.inverse.b * dx + this.inverse.d * dy;
    const x = Math.round(gx), y = Math.round(gy);
    return Math.abs(gx - x) < 1e-9 && Math.abs(gy - y) < 1e-9 ? { x, y } : null;
  }

  /** RasterSnapshot-style handoff: working tiles stay owned; published tiles never mutate. */
  private publishSnapshot(): void {
    if (!this.pendingSnapshotKeys.size) return;
    const tiles = this.raster.tiles.slice();
    for (const key of this.pendingSnapshotKeys) {
      const output = this.coverage.get(key)!.output;
      tiles[key] = isZero(output) ? null : output.slice();
    }
    this.raster = new Raster(this.raster.width, this.raster.height, this.raster.channels, tiles);
    this.pendingSnapshotKeys.clear();
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
        if (this.tilePartition && (col * 31 + row * 17) % this.tilePartition.count !== this.tilePartition.index) continue;
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
    const native = this.raster.tiles[key];
    if (native instanceof Uint16Array) throw new Error('The existing 8-bit brush kernel cannot paint an rgba16 layer yet.');
    const existing = native;
    // Raster tiles are immutable, so BrushStroke.allocateTile's base snapshot can retain the
    // original tile instead of copying it.
    const base = existing ?? null;
    state = { permanent: new Float32Array(width * height), tail: null,
      base, baseIsZero: !existing, baseIsOpaque: this.raster.channels === 4 && !!base && isOpaqueRgba(base),
      output: base ? base.slice() : new Uint8Array(width * height * this.raster.channels) };
    this.coverage.set(key, state);
    return state;
  }

  private accumulate(density: Float32Array, key: number, rect: IntRect, segments: readonly Segment[]): void {
    if (this.reference) { this.accumulateReference(density, key, rect, segments); return; }
    const col = key % this.raster.cols, row = Math.floor(key / this.raster.cols);
    const tw = this.raster.tileWidth(col), m = this.mapping;
    const hard = this.settings.hardness >= 1;
    const tileX = col * TILE, tileY = row * TILE;
    // MetalBrushCoverage.continuousBrush adds every settled segment. Segment-major spans avoid
    // re-testing every spline chord in the empty corners of their shared bounding rectangle.
    for (const s of segments) {
      const reach = this.radius + (hard ? 2 : 0);
      for (let y = rect.y; y < rect.y + rect.height; y++) {
        if (!capsuleRowSpan(m, col, row, y, rect, s, reach, this.rowSpan)) continue;
        const gy = tileY + y + 0.5;
        let gx = tileX + this.rowSpan[0]! + 0.5;
        let px = m.a * gx + m.c * gy + m.tx, py = m.b * gx + m.d * gy + m.ty;
        let index = y * tw + this.rowSpan[0]!;
        if (hard || s.length < 1e-6) {
          for (let x = this.rowSpan[0]!; x < this.rowSpan[1]!; x++, index++, px += m.a, py += m.b) {
            if (!insideCanvasXY(px, py, this.canvas)) continue;
            const value = density[index]!;
            if (hard) density[index] = Math.max(value, hardSegmentCoverageXY(px, py, s, this.settings, m));
            else if (value < 20) density[index] = Math.min(20, value + segmentDensityXY(px, py, s,
              this.radius, this.radiusSquared, this.depositionSpacing, this.densityLut!, this.integralDensity!));
          }
          continue;
        }
        const dx = px - s.x0, dy = py - s.y0;
        let projection = dx * s.ux + dy * s.uy;
        let perpendicular = -dx * s.uy + dy * s.ux;
        const projectionStep = m.a * s.ux + m.b * s.uy;
        const perpendicularStep = -m.a * s.uy + m.b * s.ux;
        const scale = this.radius / this.depositionSpacing * s.pressure;
        // A 6-pixel cubic reconstruction of the smooth soft-tip field reduces CPU integral
        // queries; the irregular reference test bounds the RGBA8 deviation to the preview's two-byte budget.
        const interpolate = this.fastRgbaPaint && this.radius >= 128 && Math.hypot(m.a, m.b) <= 1
          && segmentInsideCanvas(s, this.canvas, reach);
        if (interpolate) {
          const start = this.rowSpan[0]!, end = this.rowSpan[1]!, gridStart = Math.floor(start / 6) * 6;
          projection -= (start - gridStart) * projectionStep;
          perpendicular -= (start - gridStart) * perpendicularStep;
          let previous = integralSegmentDensity(projection - 6 * projectionStep,
            Math.abs(perpendicular - 6 * perpendicularStep), s.length, this.radius, this.radiusSquared, scale,
            this.integralDensity!);
          let first = integralSegmentDensity(projection, Math.abs(perpendicular), s.length,
            this.radius, this.radiusSquared, scale, this.integralDensity!);
          let second = integralSegmentDensity(projection + 6 * projectionStep,
            Math.abs(perpendicular + 6 * perpendicularStep), s.length, this.radius, this.radiusSquared, scale,
            this.integralDensity!);
          for (let x = gridStart; x < end; x += 6) {
            const third = integralSegmentDensity(projection + 12 * projectionStep,
              Math.abs(perpendicular + 12 * perpendicularStep), s.length, this.radius, this.radiusSquared, scale,
              this.integralDensity!);
            for (let offset = 0; offset < 6; offset++) {
              const at = x + offset;
              if (at < start || at >= end) continue;
              const pixel = y * tw + at;
              const t = offset / 6;
              const t2 = t * t, t3 = t2 * t;
              const estimate = 0.5 * (2 * first + (-previous + second) * t
                + (2 * previous - 5 * first + 4 * second - third) * t2
                + (-previous + 3 * first - 3 * second + third) * t3);
              if (density[pixel]! < 20) density[pixel] = Math.min(20, density[pixel]! + Math.max(0, estimate));
            }
            previous = first; first = second; second = third;
            projection += 6 * projectionStep;
            perpendicular += 6 * perpendicularStep;
          }
          continue;
        }
        for (let x = this.rowSpan[0]!; x < this.rowSpan[1]!;
          x++, index++, px += m.a, py += m.b, projection += projectionStep, perpendicular += perpendicularStep) {
          if (!insideCanvasXY(px, py, this.canvas) || density[index]! >= 20) continue;
          const value = integralSegmentDensity(projection, Math.abs(perpendicular), s.length,
            this.radius, this.radiusSquared, scale, this.integralDensity!);
          density[index] = Math.min(20, density[index]! + value);
        }
      }
    }
  }

  private accumulateReference(density: Float32Array, key: number, rect: IntRect, segments: readonly Segment[]): void {
    const col = key % this.raster.cols, row = Math.floor(key / this.raster.cols), tw = this.raster.tileWidth(col);
    const hard = this.settings.hardness >= 1, m = this.mapping;
    for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) {
      const gx = col * TILE + x + 0.5, gy = row * TILE + y + 0.5;
      const px = m.a * gx + m.c * gy + m.tx, py = m.b * gx + m.d * gy + m.ty;
      if (!insideCanvasXY(px, py, this.canvas)) continue;
      const index = y * tw + x;
      if (hard) {
        let value = density[index]!;
        for (const s of segments) value = Math.max(value, hardSegmentCoverageXY(px, py, s, this.settings, m));
        density[index] = value;
      } else {
        let value = density[index]!;
        for (const s of segments) value += segmentDensityXY(px, py, s, this.radius, this.radiusSquared,
          this.depositionSpacing, this.densityLut!, this.integralDensity!);
        density[index] = Math.min(value, 20);
      }
    }
  }

  /** A straight provisional tail becomes the identical settled spline without re-integrating it. */
  private promoteTail(state: CoverageTile, key: number, rect: IntRect, segment: Segment): void {
    const tailBuffer = state.tail;
    if (!tailBuffer) return;
    const col = key % this.raster.cols, row = Math.floor(key / this.raster.cols), tw = this.raster.tileWidth(col);
    const hard = this.settings.hardness >= 1;
    const radius = this.settings.diameter / 2 + (hard ? 2 : 0);
    for (let y = rect.y; y < rect.y + rect.height; y++) {
      if (!capsuleRowSpan(this.mapping, col, row, y, rect, segment, radius, this.rowSpan)) continue;
      for (let x = this.rowSpan[0]!; x < this.rowSpan[1]!; x++) {
        const index = y * tw + x, tail = tailBuffer[index]!;
        if (tail === 0) continue;
        const permanent = state.permanent[index]!;
        state.permanent[index] = hard ? Math.max(permanent, tail)
          : permanent >= 20 ? 20 : Math.min(20, permanent + tail);
        tailBuffer[index] = 0;
      }
    }
    state.tail = null;
  }

  private compose(state: CoverageTile, key: number, rect: IntRect, tail: readonly Segment[], tailOnly: boolean,
    templateShift: Point | null): boolean {
    const col = key % this.raster.cols, row = Math.floor(key / this.raster.cols);
    const tw = this.raster.tileWidth(col), ch = this.raster.channels;
    const hard = this.settings.hardness >= 1;
    const m = this.mapping;
    const opaquePaint = ch === 4 && state.baseIsOpaque && !this.clone && !this.selection && this.settings.mode === 'paint';
    const saturatedOpaquePaint = opaquePaint && this.settings.opacity === 1;
    const tailBuffer = state.tail ?? new Float32Array(tw * this.raster.tileHeight(row));
    state.tail = tailBuffer;
    if (!hard && tailOnly && tail.length === 1 && templateShift && saturatedOpaquePaint) {
      return this.composeOpaqueTemplate(state, col, row, rect, tail[0]!, tailBuffer, templateShift);
    }
    let changed = false;
    for (let y = rect.y; y < rect.y + rect.height; y++) {
      const hasSpan = tailOnly && tail.length === 1 && capsuleRowSpan(m, col, row, y, rect, tail[0]!,
        this.settings.diameter / 2 + (hard ? 2 : 0), this.rowSpan);
      if (tailOnly && !hasSpan) continue;
      const startX = hasSpan ? this.rowSpan[0]! : rect.x;
      const endX = hasSpan ? this.rowSpan[1]! : rect.x + rect.width;
      const gy = row * TILE + y + 0.5;
      const gx = col * TILE + startX + 0.5;
      let px = m.a * gx + m.c * gy + m.tx, py = m.b * gx + m.d * gy + m.ty;
      const singleTail = tail.length === 1 && tail[0]!.length >= 1e-6 ? tail[0]! : null;
      let tailProjection = 0, tailPerpendicular = 0, projectionStep = 0, perpendicularStep = 0;
      if (singleTail) {
        const dx = px - singleTail.x0, dy = py - singleTail.y0;
        tailProjection = dx * singleTail.ux + dy * singleTail.uy;
        tailPerpendicular = -dx * singleTail.uy + dy * singleTail.ux;
        projectionStep = m.a * singleTail.ux + m.b * singleTail.uy;
        perpendicularStep = -m.a * singleTail.uy + m.b * singleTail.ux;
      }
      for (let x = startX; x < endX;
        x++, px += m.a, py += m.b, tailProjection += projectionStep, tailPerpendicular += perpendicularStep) {
        const pixel = y * tw + x;
        const offset = pixel * ch;
        let coverage = state.permanent[pixel]!;
        if (!hard && this.fastRgbaPaint && this.radius >= 128 && this.settings.opacity === 1
          && this.blankSaturationDensity !== null && coverage >= this.blankSaturationDensity) {
          tailBuffer[pixel] = 0;
          if (state.output[offset] !== this.paintRed || state.output[offset + 1] !== this.paintGreen
            || state.output[offset + 2] !== this.paintBlue || state.output[offset + 3] !== 255) {
            state.output[offset] = this.paintRed; state.output[offset + 1] = this.paintGreen;
            state.output[offset + 2] = this.paintBlue; state.output[offset + 3] = 255; changed = true;
          }
          continue;
        }
        const saturatedBlank = !hard && state.baseIsZero && this.blankSaturationDensity !== null
          && coverage >= this.blankSaturationDensity;
        // BrushStroke composes once from stroke coverage over the immutable base. Once an opaque
        // pixel has reached the paint colour, more coverage cannot change its RGBA8 result.
        const saturatedOpaque = saturatedOpaquePaint && state.output[offset] === this.paintRed
          && state.output[offset + 1] === this.paintGreen && state.output[offset + 2] === this.paintBlue;
        if (tailOnly && ((hard && coverage >= 1) || (!hard && coverage >= 20) || saturatedBlank || saturatedOpaque)) {
          tailBuffer[pixel] = 0;
          continue;
        }
        if (insideCanvasXY(px, py, this.canvas)) {
          if (hard) {
            let tailCoverage = 0;
            for (const s of tail) tailCoverage = Math.max(tailCoverage, hardSegmentCoverageXY(px, py, s, this.settings, this.mapping));
            tailBuffer[pixel] = tailCoverage;
            coverage = Math.max(coverage, tailCoverage);
          } else {
            let tailDensity = 0;
            const template = this.tailDensityTemplate;
            if (templateShift && template) {
              const tx = col * TILE + x - templateShift.x - template.x;
              const ty = row * TILE + y - templateShift.y - template.y;
              if (tx >= 0 && ty >= 0 && tx < template.width && ty < template.height) {
                tailDensity = template.values[ty * template.width + tx]!;
              }
            } else {
              if (singleTail) {
                tailDensity = integralSegmentDensity(tailProjection, Math.abs(tailPerpendicular), singleTail.length,
                  this.radius, this.radiusSquared, this.radius / this.depositionSpacing * singleTail.pressure,
                  this.integralDensity!);
              }
              else for (const s of tail) tailDensity += segmentDensityXY(px, py, s, this.radius, this.radiusSquared,
                this.depositionSpacing, this.densityLut!, this.integralDensity!);
            }
            tailBuffer[pixel] = tailDensity;
            coverage = densityCoverage(coverage + tailDensity);
          }
        } else { coverage = 0; tailBuffer[pixel] = 0; }
        coverage *= this.selectionCoverageXY(px, py) * this.settings.opacity;
        if (ch === 1) changed = this.composeMask(state, offset, coverage) || changed;
        else if (state.baseIsZero && !this.clone && this.settings.mode === 'paint') {
          const alpha = coverage <= 0 ? 0 : clampByte(coverage * 255);
          if (state.output[offset + 3] !== alpha) {
            changed = true;
            if (alpha === 0) state.output.fill(0, offset, offset + 4);
            else {
              state.output[offset] = this.paintRed;
              state.output[offset + 1] = this.paintGreen;
              state.output[offset + 2] = this.paintBlue;
              state.output[offset + 3] = alpha;
            }
          }
        }
        else if (opaquePaint) {
          const base = state.base!;
          const keep = 1 - coverage;
          const r = clampByte(this.settings.red * 255 * coverage + base[offset]! * keep);
          const g = clampByte(this.settings.green * 255 * coverage + base[offset + 1]! * keep);
          const b = clampByte(this.settings.blue * 255 * coverage + base[offset + 2]! * keep);
          if (r !== state.output[offset] || g !== state.output[offset + 1] || b !== state.output[offset + 2]) {
            state.output[offset] = r; state.output[offset + 1] = g; state.output[offset + 2] = b;
            changed = true;
          }
        } else {
          const r = state.output[offset]!, g = state.output[offset + 1]!, b = state.output[offset + 2]!, a = state.output[offset + 3]!;
          this.composeColour(state, offset, coverage, px, py);
          changed ||= r !== state.output[offset] || g !== state.output[offset + 1]
            || b !== state.output[offset + 2] || a !== state.output[offset + 3];
        }
      }
    }
    return changed;
  }

  private composeOpaqueTemplate(state: CoverageTile, col: number, row: number, rect: IntRect, segment: Segment,
    tailBuffer: Float32Array, shift: Point): boolean {
    const template = this.tailDensityTemplate!;
    const tw = this.raster.tileWidth(col), permanent = state.permanent, output = state.output, base = state.base!;
    const tileX = col * TILE, tileY = row * TILE;
    const lookupX = tileX - shift.x - template.x, lookupY = tileY - shift.y - template.y;
    const lutScale = COVERAGE_LUT_SIZE / 20;
    let changed = false;
    for (let y = rect.y; y < rect.y + rect.height; y++) {
      if (!capsuleRowSpan(this.mapping, col, row, y, rect, segment, this.radius, this.rowSpan)) continue;
      const rowOffset = y * tw, templateRow = (lookupY + y) * template.width + lookupX;
      for (let x = this.rowSpan[0]!; x < this.rowSpan[1]!; x++) {
        const pixel = rowOffset + x, offset = pixel * 4;
        if (output[offset] === this.paintRed && output[offset + 1] === this.paintGreen
          && output[offset + 2] === this.paintBlue) {
          tailBuffer[pixel] = 0;
          continue;
        }
        const tailDensity = template.values[templateRow + x]!;
        tailBuffer[pixel] = tailDensity;
        const density = permanent[pixel]! + tailDensity;
        const coverage = density <= 0 ? 0 : density >= 20 ? COVERAGE_LUT[COVERAGE_LUT_SIZE]!
          : COVERAGE_LUT[Math.round(density * lutScale)]!;
        const keep = 1 - coverage;
        const r = clampByte(this.settings.red * 255 * coverage + base[offset]! * keep);
        const g = clampByte(this.settings.green * 255 * coverage + base[offset + 1]! * keep);
        const b = clampByte(this.settings.blue * 255 * coverage + base[offset + 2]! * keep);
        if (r !== output[offset] || g !== output[offset + 1] || b !== output[offset + 2]) {
          output[offset] = r; output[offset + 1] = g; output[offset + 2] = b;
          changed = true;
        }
      }
    }
    return changed;
  }

  private selectionCoverageXY(px: number, py: number): number {
    if (!this.selection) return 1;
    const x = Math.floor(px - this.selection.x), y = Math.floor(py - this.selection.y);
    return rasterChannel(this.selection.mask, x, y, 0) / 255;
  }

  private composeMask(state: CoverageTile, offset: number, alpha: number): boolean {
    const base = state.base?.[offset] ?? 0;
    const paint = Math.round(this.settings.red * 255);
    const value = clampByte(paint * alpha + base * (1 - alpha));
    if (state.output[offset] === value) return false;
    state.output[offset] = value;
    return true;
  }

  private composeColour(state: CoverageTile, offset: number, alpha: number, px: number, py: number): void {
    const base = state.base;
    const ba = (base?.[offset + 3] ?? 0) / 255;
    if (this.settings.mode === 'erase') {
      const outA = ba * (1 - alpha);
      state.output[offset] = outA > 0 ? base?.[offset] ?? 0 : 0;
      state.output[offset + 1] = outA > 0 ? base?.[offset + 1] ?? 0 : 0;
      state.output[offset + 2] = outA > 0 ? base?.[offset + 2] ?? 0 : 0;
      state.output[offset + 3] = clampByte(outA * 255);
      return;
    }
    let sr = this.settings.red * 255, sg = this.settings.green * 255, sb = this.settings.blue * 255, sa = alpha;
    if (this.clone) {
      const sampled = this.clone.sample({ x: px + this.clone.offset.width, y: py + this.clone.offset.height });
      sr = sampled[0]; sg = sampled[1]; sb = sampled[2]; sa *= sampled[3] / 255;
      if (this.clone.replace) {
        const mix = alpha;
        state.output[offset] = clampByte(sr * mix + (base?.[offset] ?? 0) * (1 - mix));
        state.output[offset + 1] = clampByte(sg * mix + (base?.[offset + 1] ?? 0) * (1 - mix));
        state.output[offset + 2] = clampByte(sb * mix + (base?.[offset + 2] ?? 0) * (1 - mix));
        state.output[offset + 3] = clampByte(sampled[3] * mix + (base?.[offset + 3] ?? 0) * (1 - mix));
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
    state.output[offset] = clampByte((sr * sa + (base?.[offset] ?? 0) * keep) / outA);
    state.output[offset + 1] = clampByte((sg * sa + (base?.[offset + 1] ?? 0) * keep) / outA);
    state.output[offset + 2] = clampByte((sb * sa + (base?.[offset + 2] ?? 0) * keep) / outA);
    state.output[offset + 3] = clampByte(outA * 255);
  }
}

export function brushSegment(a: Point, b: Point, pressure: number): BrushSegment {
  const vx = b.x - a.x, vy = b.y - a.y, length = Math.hypot(vx, vy);
  return { x0: a.x, y0: a.y, x1: b.x, y1: b.y, pressure, vx, vy, length,
    ux: length > 0 ? vx / length : 0, uy: length > 0 ? vy / length : 0 };
}

const segment = brushSegment;

/** Centripetal Catmull-Rom with BrushStroke's 0.2-document-pixel adaptive chords. */
export function continuousBrushCurve(start: Point, end: Point, before: Point, after: Point,
  startPressure: number, endPressure: number,
  tolerance: number): Segment[] {
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
    if (deviation <= tolerance || depth >= 10) {
      result.push(segment(a, b, (startPressure * (1 - (lo + hi) / 2) + endPressure * ((lo + hi) / 2))));
      return;
    }
    subdivide(a, m, lo, mid, depth + 1);
    subdivide(m, b, mid, hi, depth + 1);
  };
  subdivide(start, end, 0, 1, 0);
  return result;
}

const continuousCurve = continuousBrushCurve;

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

/** The same clipped optical-density line integral as MetalBrushCoverage.segmentDensity. */
function segmentDensityXY(px: number, py: number, s: Segment, radius: number, radiusSquared: number, spacing: number,
  densityLut: Float32Array, integral: IntegralDensityTable): number {
  if (s.pressure <= 0) return 0;
  if (s.length < 1e-6) return densityLookup(densityLut, ((px - s.x0) ** 2 + (py - s.y0) ** 2) / radiusSquared) * s.pressure;
  const dx = px - s.x0, dy = py - s.y0;
  const projection = dx * s.ux + dy * s.uy;
  const perpendicular = Math.abs(-dx * s.uy + dy * s.ux);
  return integralSegmentDensity(projection, perpendicular, s.length, radius, radiusSquared,
    radius / spacing * s.pressure, integral);
}

function integralSegmentDensity(projection: number, perpendicular: number, length: number, radius: number,
  radiusSquared: number, scale: number, integral: IntegralDensityTable): number {
  if (perpendicular * perpendicular >= radiusSquared) return 0;
  // The prefix table is zero outside the round tip's support, so integrating the whole segment
  // avoids solving its circle intersections independently for every pixel.
  const a = -projection / radius, b = (length - projection) / radius;
  return Math.max(0, integralDifference(integral, perpendicular / radius, a, b)) * scale;
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

/** Prefix integral of tip density along a unit-radius chord, cached by hardness. */
function integralDensityTable(hardness: number, density: Float32Array): IntegralDensityTable {
  const cached = integralDensityCache.get(hardness);
  if (cached) return cached;
  const stride = INTEGRAL_COLUMNS + 1;
  const values = new Float32Array((INTEGRAL_ROWS + 1) * stride);
  const dx = 2 / INTEGRAL_COLUMNS;
  for (let row = 0; row <= INTEGRAL_ROWS; row++) {
    const d = row / INTEGRAL_ROWS, d2 = d * d, base = row * stride;
    let previous = densityLookup(density, d2 + 1);
    let sum = 0;
    for (let column = 1; column <= INTEGRAL_COLUMNS; column++) {
      const x = -1 + column * dx;
      const next = densityLookup(density, d2 + x * x);
      sum += (previous + next) * dx / 2;
      values[base + column] = sum;
      previous = next;
    }
  }
  const result = { values, rows: INTEGRAL_ROWS, columns: INTEGRAL_COLUMNS };
  integralDensityCache.set(hardness, result);
  // UI drags can produce many hardness values; retain only the four most recent tables.
  if (integralDensityCache.size > 4) integralDensityCache.delete(integralDensityCache.keys().next().value!);
  return result;
}

function integralDifference(table: IntegralDensityTable, perpendicular: number, from: number, to: number): number {
  const row = Math.min(table.rows, Math.max(0, Math.round(perpendicular * table.rows)));
  const fromPosition = (Math.min(1, Math.max(-1, from)) + 1) / 2 * table.columns;
  const toPosition = (Math.min(1, Math.max(-1, to)) + 1) / 2 * table.columns;
  const fromColumn = Math.min(table.columns - 1, Math.floor(fromPosition));
  const toColumn = Math.min(table.columns - 1, Math.floor(toPosition));
  const fromFraction = fromPosition - fromColumn, toFraction = toPosition - toColumn;
  const offset = row * (table.columns + 1);
  const fromValue = table.values[offset + fromColumn]! * (1 - fromFraction)
    + table.values[offset + fromColumn + 1]! * fromFraction;
  const toValue = table.values[offset + toColumn]! * (1 - toFraction)
    + table.values[offset + toColumn + 1]! * toFraction;
  return toValue - fromValue;
}

function densityCoverage(density: number): number {
  if (density <= 0) return 0;
  if (density >= 20) return COVERAGE_LUT[COVERAGE_LUT_SIZE]!;
  return COVERAGE_LUT[Math.round(density / 20 * COVERAGE_LUT_SIZE)]!;
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

function segmentsEqual(a: readonly Segment[], b: readonly Segment[]): boolean {
  return a.length === b.length && a.every((segment, index) => {
    const other = b[index]!;
    return segment.x0 === other.x0 && segment.y0 === other.y0 && segment.x1 === other.x1
      && segment.y1 === other.y1 && segment.pressure === other.pressure;
  });
}

function translatedSegments(a: Segment, b: Segment, canvas: Size, reach: number): boolean {
  if (a.vx !== b.vx || a.vy !== b.vy || a.pressure !== b.pressure) return false;
  return segmentInsideCanvas(a, canvas, reach) && segmentInsideCanvas(b, canvas, reach);
}

function segmentInsideCanvas(s: Segment, canvas: Size, reach: number): boolean {
  return Math.min(s.x0, s.x1) - reach >= 0 && Math.min(s.y0, s.y1) - reach >= 0
    && Math.max(s.x0, s.x1) + reach <= canvas.width && Math.max(s.y0, s.y1) + reach <= canvas.height;
}

/** Integer pixel-centre span where one raster row intersects a document-space round-tip sweep. */
function capsuleRowSpan(mapping: Affine, col: number, row: number, y: number, rect: IntRect,
  segment: Segment, radius: number, output: Int32Array): boolean {
  if (segment.pressure <= 0) return false;
  const gx = col * TILE + 0.5, gy = row * TILE + y + 0.5;
  const px = mapping.a * gx + mapping.c * gy + mapping.tx;
  const py = mapping.b * gx + mapping.d * gy + mapping.ty;
  const vx = mapping.a, vy = mapping.b;
  const a = vx * vx + vy * vy;
  let lo = Infinity, hi = -Infinity;
  let dx = px - segment.x0, dy = py - segment.y0;
  let b = 2 * (dx * vx + dy * vy), c = dx * dx + dy * dy - radius * radius;
  let discriminant = b * b - 4 * a * c;
  if (a > 1e-20 && discriminant >= 0) {
    const root = Math.sqrt(discriminant);
    lo = (-b - root) / (2 * a); hi = (-b + root) / (2 * a);
  }
  if (segment.length > 1e-12) {
    dx = px - segment.x1; dy = py - segment.y1;
    b = 2 * (dx * vx + dy * vy); c = dx * dx + dy * dy - radius * radius;
    discriminant = b * b - 4 * a * c;
    if (a > 1e-20 && discriminant >= 0) {
      const root = Math.sqrt(discriminant);
      lo = Math.min(lo, (-b - root) / (2 * a));
      hi = Math.max(hi, (-b + root) / (2 * a));
    }
    dx = px - segment.x0; dy = py - segment.y0;
    const projectionValue = dx * segment.ux + dy * segment.uy;
    const projectionDelta = vx * segment.ux + vy * segment.uy;
    const perpendicularValue = -dx * segment.uy + dy * segment.ux;
    const perpendicularDelta = -vx * segment.uy + vy * segment.ux;
    let stripLo = -Infinity, stripHi = Infinity;
    if (Math.abs(projectionDelta) < 1e-20) {
      if (projectionValue < 0 || projectionValue > segment.length) stripLo = Infinity;
    } else {
      const p0 = -projectionValue / projectionDelta;
      const p1 = (segment.length - projectionValue) / projectionDelta;
      stripLo = Math.max(stripLo, Math.min(p0, p1)); stripHi = Math.min(stripHi, Math.max(p0, p1));
    }
    if (Math.abs(perpendicularDelta) < 1e-20) {
      if (perpendicularValue < -radius || perpendicularValue > radius) stripLo = Infinity;
    } else {
      const p0 = (-radius - perpendicularValue) / perpendicularDelta;
      const p1 = (radius - perpendicularValue) / perpendicularDelta;
      stripLo = Math.max(stripLo, Math.min(p0, p1)); stripHi = Math.min(stripHi, Math.max(p0, p1));
    }
    if (stripHi >= stripLo) {
      lo = Math.min(lo, stripLo); hi = Math.max(hi, stripHi);
    }
  }
  if (!(hi >= lo)) return false;
  const start = Math.max(rect.x, Math.ceil(lo - 1e-9));
  const end = Math.min(rect.x + rect.width, Math.floor(hi + 1e-9) + 1);
  if (end <= start) return false;
  output[0] = start; output[1] = end;
  return true;
}

function samePoint(a: Point | undefined, b: Point): boolean { return !!a && a.x === b.x && a.y === b.y; }
function insideCanvasXY(x: number, y: number, canvas: Size): boolean { return x >= 0 && y >= 0 && x < canvas.width && y < canvas.height; }
function clampByte(value: number): number { return Math.min(255, Math.max(0, Math.round(value))); }
function isZero(data: Uint8Array): boolean { for (let i = 0; i < data.length; i++) if (data[i]) return false; return true; }
function isOpaqueRgba(data: Uint8Array): boolean {
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return false;
  return true;
}

function rasterChannel(raster: Raster, x: number, y: number, channel: number): number {
  if (x < 0 || y < 0 || x >= raster.width || y >= raster.height) return 0;
  const col = Math.floor(x / TILE), row = Math.floor(y / TILE);
  const tile = raster.tiles[row * raster.cols + col];
  if (!tile) return 0;
  const offset = ((y - row * TILE) * raster.tileWidth(col) + (x - col * TILE)) * raster.channels + channel;
  return tile[offset] ?? 0;
}
