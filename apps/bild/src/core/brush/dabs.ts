/**
 * Exact CPU rasterizer for dab brushes (PRODUCT-PLAN 6.3). It runs on the main thread (synchronous fallback, clone and
 * selection strokes) and in the brush workers (settled segments, tile partitions). Both feed the same segment stream
 * through `DabPlacer`, and every pixel receives its dabs in list order, so the worker commit equals the synchronous
 * replay byte for byte. Coverage builds up per dab (c ← c + a·(1 − c)), capped by the opacity at composition, which
 * is what the GPU preview does with "over" blending of the same dabs.
 */

import { maskTransform } from '../document';
import { apply, invert, pixelToDocument, type Affine, type LayerTransform, type Point, type Rect, type Size } from '../geometry';
import { Raster, TILE } from '../raster';
import { makePixelArray, type PixelArray } from '../pixel/format';
import type { DocumentSelection } from '../selection';
import { validateBrushSettings, type BrushSettings } from './settings';
import {
  brushModeColor, brushSegment, continuousBrushCurve, cropTiled, initialRaster,
  type BeginStrokeOptions, type BrushSegment, type CloneSample, type SettledStroke, type Stroke, type StrokeResult, type StrokeUpdate,
} from './stroke';
import { DabPlacer, prepareDab, dabCoverage, type BrushTip, type PreparedDab } from './tip';

interface IntRect { x: number; y: number; width: number; height: number }
interface DabTile {
  readonly permanent: Float32Array;
  tail: Float32Array | null;
  readonly base: PixelArray | null;
  readonly baseIsZero: boolean;
  readonly output: PixelArray;
}

/** Curve tolerance of RecordedBrushStroke/ContinuousBrushStroke, so every path settles identical segments. */
export function dabCurveTolerance(options: BeginStrokeOptions): number {
  return options.target !== 'mask' && options.settings.mode === 'paint' && !options.clone && !options.selection
    && options.settings.diameter >= 256 ? 0.3 : 0.2;
}

export class DabBrushStroke implements Stroke {
  private readonly settings: BrushSettings;
  private readonly tip: BrushTip | undefined;
  private readonly selection: DocumentSelection | null;
  private readonly clone: CloneSample | undefined;
  private readonly isMask: boolean;
  private readonly canvas: Size;
  private readonly mapping: Affine;
  private readonly inverse: Affine;
  private readonly paintTransform: LayerTransform;
  private readonly antialias: number;
  private readonly maximum: 255 | 65535;
  private readonly paintRed: number;
  private readonly paintGreen: number;
  private readonly paintBlue: number;
  private readonly tolerance: number;
  private readonly tilePartition: BeginStrokeOptions['tilePartition'];
  private readonly placer: DabPlacer;
  private readonly tiles = new Map<number, DabTile>();
  private readonly pendingSnapshotKeys = new Set<number>();
  private readonly settledOnlyAreas = new Map<number, IntRect>();
  private readonly originalSource: Raster | null;
  private samples: Point[] = [];
  private pressures: number[] = [];
  private tilts: (number | undefined)[] = [];
  private tailAreas = new Map<number, IntRect>();
  private raster: Raster;
  private done = false;
  readonly sourceRect: Rect;

  constructor(options: BeginStrokeOptions) {
    validateBrushSettings(options.settings);
    if (!Number.isInteger(options.canvas.width) || !Number.isInteger(options.canvas.height)
      || options.canvas.width < 1 || options.canvas.height < 1) throw new RangeError('Invalid canvas size');
    this.settings = options.settings;
    this.tip = options.settings.tip;
    this.selection = options.selection ?? null;
    this.clone = options.clone;
    this.isMask = options.target === 'mask';
    this.canvas = options.canvas;
    this.tilePartition = options.tilePartition;
    this.tolerance = dabCurveTolerance(options);
    this.placer = new DabPlacer(options.settings);
    const sourceFormat = this.isMask ? 'gray8' : options.layer.raster?.format ?? 'rgba8';
    this.maximum = sourceFormat === 'rgba16' ? 65535 : 255;
    this.paintRed = clampSample(options.settings.red * this.maximum, this.maximum);
    this.paintGreen = clampSample(options.settings.green * this.maximum, this.maximum);
    this.paintBlue = clampSample(options.settings.blue * this.maximum, this.maximum);

    // BrushStroke.init's working grid, as in ContinuousBrushStroke.
    const placedMask = this.isMask && options.layer.mask?.placement ? options.layer.mask : null;
    const baseTransform = placedMask ? maskTransform(options.layer) : options.layer.transform;
    const layerRaster = options.layer.raster ?? null;
    const source = this.isMask ? options.layer.mask?.raster ?? null : layerRaster;
    const originalWidth = placedMask?.raster.width ?? layerRaster?.width ?? Math.max(1, Math.round(options.layer.transform.size.width));
    const originalHeight = placedMask?.raster.height ?? layerRaster?.height ?? Math.max(1, Math.round(options.layer.transform.size.height));
    const originalMapping = pixelToDocument(baseTransform, originalWidth, originalHeight);
    const originalBounds: Rect = { x: 0, y: 0, width: originalWidth, height: originalHeight };
    const canvasInPixels = transformedBounds(invert(originalMapping), { x: 0, y: 0, ...options.canvas });
    const extent = this.isMask ? originalBounds : integralUnion(originalBounds, canvasInPixels);
    const maxPixels = options.pixelLimit ?? 100_000_000;
    if (extent.width < 1 || extent.height < 1 || extent.width > 1_000_000_000 || extent.height > 1_000_000_000
      || originalWidth > 30_000 || originalHeight > 30_000 || extent.width * extent.height > maxPixels) {
      throw new RangeError('Brush raster exceeds the pixel limit');
    }
    this.sourceRect = { x: -extent.x, y: -extent.y, width: originalWidth, height: originalHeight };
    this.mapping = translatedInput(originalMapping, extent.x, extent.y);
    this.inverse = invert(this.mapping);
    const middle = apply(originalMapping, { x: extent.x + extent.width / 2, y: extent.y + extent.height / 2 });
    const size = { width: extent.width * baseTransform.size.width / originalWidth, height: extent.height * baseTransform.size.height / originalHeight };
    this.paintTransform = { ...baseTransform, size, origin: { x: middle.x - size.width / 2, y: middle.y - size.height / 2 } };
    this.antialias = Math.max(0.001, Math.min(Math.hypot(this.mapping.a, this.mapping.b), Math.hypot(this.mapping.c, this.mapping.d)));
    this.originalSource = source;
    this.raster = initialRaster(extent.width, extent.height, this.isMask ? 1 : 4, source, this.sourceRect, this.isMask);
  }

  addPoints(points: readonly Point[], options: { readonly pressure?: number | readonly number[]; readonly tilt?: number | readonly number[] } = {}): StrokeUpdate {
    this.assertActive();
    const dirty: Rect[] = [];
    for (let i = 0; i < points.length; i++) {
      const point = points[i]!;
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || Math.abs(point.x) > 10_000_000
        || Math.abs(point.y) > 10_000_000 || samePoint(this.samples.at(-1), point)) continue;
      const pressure = penValue(options.pressure, i) ?? 1;
      const tilt = penValue(options.tilt, i);
      this.samples.push({ ...point }); this.pressures.push(pressure); this.tilts.push(tilt);
      if (this.samples.length > 4) { this.samples.shift(); this.pressures.shift(); this.tilts.shift(); }
      const n = this.samples.length, s = this.samples, p = this.pressures, t = this.tilts;
      let settled: BrushSegment[] = [];
      if (n === 1) settled = [brushSegment(point, point, pressure, tilt)];
      else if (n >= 3) settled = continuousBrushCurve(s[n - 3]!, s[n - 2]!, s[Math.max(0, n - 4)]!, point, p[n - 3]!, p[n - 2]!,
        this.tolerance, t[n - 3], t[n - 2]);
      const tail = n >= 2 ? [brushSegment(s[n - 2]!, point, (p[n - 2]! + pressure) / 2, averageTilt(t[n - 2], tilt))] : [];
      dirty.push(...this.render(settled, tail));
    }
    return { dirty };
  }

  addSettled(segments: readonly BrushSegment[]): StrokeUpdate {
    this.assertActive();
    const dirty: Rect[] = [];
    for (const dab of this.prepared(this.placer.place(segments))) {
      for (const [key, rect] of this.dabAreas(dab)) {
        this.accumulate(this.tile(key).permanent, key, rect, dab);
        this.settledOnlyAreas.set(key, unionInt(this.settledOnlyAreas.get(key), rect));
        dirty.push(this.globalRect(key, rect));
      }
    }
    return { dirty };
  }

  currentRaster(): Raster { this.publishSnapshot(); return this.raster; }
  currentTransform(): LayerTransform { return this.paintTransform; }

  finish(): StrokeResult {
    this.assertActive();
    const n = this.samples.length, s = this.samples, p = this.pressures, t = this.tilts;
    if (n >= 2) {
      this.render(continuousBrushCurve(s[n - 2]!, s[n - 1]!, s[Math.max(0, n - 3)]!, s[n - 1]!, p[n - 2]!, p[n - 1]!,
        this.tolerance, t[n - 2], t[n - 1]), []);
    } else this.render([], []);
    return this.finishedResult();
  }

  finishSettled(finalSegments: readonly BrushSegment[]): StrokeResult {
    this.assertActive();
    if (finalSegments.length) this.addSettled(finalSegments);
    for (const [key, rect] of this.settledOnlyAreas) if (this.compose(this.tile(key), key, rect)) this.pendingSnapshotKeys.add(key);
    return this.finishedResult();
  }

  cancel(): void {
    this.done = true;
    this.tiles.clear();
    this.pendingSnapshotKeys.clear();
    this.tailAreas.clear();
  }

  private render(settled: readonly BrushSegment[], tail: readonly BrushSegment[]): Rect[] {
    const settledDabs = this.prepared(this.placer.place(settled));
    const tailDabs = this.prepared(this.placer.peek(tail));
    const changed = new Map<number, IntRect>();
    for (const dab of settledDabs) for (const [key, rect] of this.dabAreas(dab)) {
      this.accumulate(this.tile(key).permanent, key, rect, dab);
      changed.set(key, unionInt(changed.get(key), rect));
    }
    // The replaceable tail: clear the old provisional coverage, then lay down the new tail's dabs.
    for (const [key, rect] of this.tailAreas) {
      const state = this.tiles.get(key);
      if (state?.tail) clearRect(state.tail, this.raster.tileWidth(key % this.raster.cols), rect);
      changed.set(key, unionInt(changed.get(key), rect));
    }
    const nextTail = new Map<number, IntRect>();
    for (const dab of tailDabs) for (const [key, rect] of this.dabAreas(dab)) {
      const state = this.tile(key);
      state.tail ??= new Float32Array(state.permanent.length);
      this.accumulate(state.tail, key, rect, dab);
      nextTail.set(key, unionInt(nextTail.get(key), rect));
      changed.set(key, unionInt(changed.get(key), rect));
    }
    this.tailAreas = nextTail;
    const dirty: Rect[] = [];
    for (const [key, rect] of changed) {
      if (!this.compose(this.tile(key), key, rect)) continue;
      this.pendingSnapshotKeys.add(key);
      dirty.push(this.globalRect(key, rect));
    }
    return dirty;
  }

  private prepared(dabs: readonly import('./tip').BrushDab[]): PreparedDab[] {
    return dabs.map((dab) => prepareDab(dab, this.tip, this.antialias));
  }

  private globalRect(key: number, rect: IntRect): Rect {
    const col = key % this.raster.cols, row = Math.floor(key / this.raster.cols);
    return { x: col * TILE + rect.x, y: row * TILE + rect.y, width: rect.width, height: rect.height };
  }

  /** Tile-local rectangles a dab touches (this partition's tiles only). */
  private dabAreas(dab: PreparedDab): Map<number, IntRect> {
    const result = new Map<number, IntRect>();
    const documentRect = intersectRect({ x: dab.x - dab.reach, y: dab.y - dab.reach, width: dab.reach * 2, height: dab.reach * 2 },
      { x: 0, y: 0, ...this.canvas });
    if (!documentRect) return result;
    const pixels = intersectRect(integralBounds(transformedBounds(this.inverse, documentRect)),
      { x: 0, y: 0, width: this.raster.width, height: this.raster.height });
    if (!pixels) return result;
    const x0 = Math.floor(pixels.x / TILE), x1 = Math.floor((pixels.x + pixels.width - 1) / TILE);
    const y0 = Math.floor(pixels.y / TILE), y1 = Math.floor((pixels.y + pixels.height - 1) / TILE);
    for (let row = y0; row <= y1; row++) for (let col = x0; col <= x1; col++) {
      if (this.tilePartition && (col * 31 + row * 17) % this.tilePartition.count !== this.tilePartition.index) continue;
      const tile = { x: col * TILE, y: row * TILE, width: this.raster.tileWidth(col), height: this.raster.tileHeight(row) };
      const overlap = intersectRect(pixels, tile);
      if (overlap) result.set(row * this.raster.cols + col,
        { x: overlap.x - tile.x, y: overlap.y - tile.y, width: overlap.width, height: overlap.height });
    }
    return result;
  }

  private tile(key: number): DabTile {
    let state = this.tiles.get(key);
    if (state) return state;
    const col = key % this.raster.cols, row = Math.floor(key / this.raster.cols);
    const width = this.raster.tileWidth(col), height = this.raster.tileHeight(row);
    const existing = this.raster.tiles[key] ?? null;
    state = { permanent: new Float32Array(width * height), tail: null, base: existing, baseIsZero: !existing,
      output: existing ? existing.slice() : makePixelArray(this.raster.format, width * height * this.raster.channels) };
    this.tiles.set(key, state);
    return state;
  }

  private accumulate(buffer: Float32Array, key: number, rect: IntRect, dab: PreparedDab): void {
    const col = key % this.raster.cols, row = Math.floor(key / this.raster.cols), tw = this.raster.tileWidth(col), m = this.mapping;
    const hardness = this.settings.hardness;
    for (let y = rect.y; y < rect.y + rect.height; y++) {
      const gy = row * TILE + y + 0.5;
      let gx = col * TILE + rect.x + 0.5;
      for (let x = rect.x, index = y * tw + rect.x; x < rect.x + rect.width; x++, index++, gx++) {
        const px = m.a * gx + m.c * gy + m.tx, py = m.b * gx + m.d * gy + m.ty;
        if (px < 0 || py < 0 || px >= this.canvas.width || py >= this.canvas.height) continue;
        const a = dabCoverage(dab, px, py, hardness, this.antialias) * dab.alpha;
        if (a <= 0) continue;
        const value = buffer[index]!;
        buffer[index] = value + a * (1 - value);
      }
    }
  }

  private compose(state: DabTile, key: number, rect: IntRect): boolean {
    const col = key % this.raster.cols, row = Math.floor(key / this.raster.cols);
    const tw = this.raster.tileWidth(col), ch = this.raster.channels, m = this.mapping;
    const output = state.output, maximum = this.maximum, mode = this.settings.mode;
    let changed = false;
    for (let y = rect.y; y < rect.y + rect.height; y++) {
      const gy = row * TILE + y + 0.5;
      for (let x = rect.x; x < rect.x + rect.width; x++) {
        const pixel = y * tw + x, offset = pixel * ch;
        const gx = col * TILE + x + 0.5;
        const px = m.a * gx + m.c * gy + m.tx, py = m.b * gx + m.d * gy + m.ty;
        const tail = state.tail?.[pixel] ?? 0;
        let coverage = tail > 0 ? 1 - (1 - state.permanent[pixel]!) * (1 - tail) : state.permanent[pixel]!;
        coverage *= this.selectionCoverage(px, py) * this.settings.opacity;
        if (ch === 1) {
          const base = state.base?.[offset] ?? 0;
          const value = clampSample(Math.round(this.settings.red * 255) * coverage + base * (1 - coverage), 255);
          if (output[offset] !== value) { output[offset] = value; changed = true; }
          continue;
        }
        const r = output[offset]!, g = output[offset + 1]!, b = output[offset + 2]!, a = output[offset + 3]!;
        if (state.baseIsZero && !this.clone && mode === 'paint') {
          const alpha = coverage <= 0 ? 0 : clampSample(coverage * maximum, maximum);
          if (alpha === 0) output.fill(0, offset, offset + 4);
          else { output[offset] = this.paintRed; output[offset + 1] = this.paintGreen; output[offset + 2] = this.paintBlue; output[offset + 3] = alpha; }
        } else this.composeColour(state, offset, coverage, px, py);
        changed ||= r !== output[offset] || g !== output[offset + 1] || b !== output[offset + 2] || a !== output[offset + 3];
      }
    }
    return changed;
  }

  /** ContinuousBrushStroke.composeColour: the same straight-alpha paint, erase, toning and clone rules. */
  private composeColour(state: DabTile, offset: number, alpha: number, px: number, py: number): void {
    const base = state.base, output = state.output, maximum = this.maximum;
    const ba = (base?.[offset + 3] ?? 0) / maximum;
    const mode = this.settings.mode;
    if (mode === 'erase') {
      const outA = ba * (1 - alpha);
      output[offset] = outA > 0 ? base?.[offset] ?? 0 : 0;
      output[offset + 1] = outA > 0 ? base?.[offset + 1] ?? 0 : 0;
      output[offset + 2] = outA > 0 ? base?.[offset + 2] ?? 0 : 0;
      output[offset + 3] = clampSample(outA * maximum, maximum);
      return;
    }
    if (mode === 'dodge' || mode === 'burn' || mode === 'sponge') {
      if (ba <= 0) { output.fill(0, offset, offset + 4); return; }
      const adjusted = brushModeColor((base?.[offset] ?? 0) / maximum, (base?.[offset + 1] ?? 0) / maximum,
        (base?.[offset + 2] ?? 0) / maximum, this.settings, alpha);
      output[offset] = clampSample(adjusted[0] * maximum, maximum);
      output[offset + 1] = clampSample(adjusted[1] * maximum, maximum);
      output[offset + 2] = clampSample(adjusted[2] * maximum, maximum);
      output[offset + 3] = base?.[offset + 3] ?? 0;
      return;
    }
    let sr = this.settings.red * maximum, sg = this.settings.green * maximum, sb = this.settings.blue * maximum, sa = alpha;
    if (this.clone) {
      const sampled = this.clone.sample({ x: px + this.clone.offset.width, y: py + this.clone.offset.height });
      const sampleMaximum = this.clone.maximum ?? 255, scale = maximum / sampleMaximum;
      sr = sampled[0] * scale; sg = sampled[1] * scale; sb = sampled[2] * scale;
      sa = alpha * sampled[3] / sampleMaximum;
      if (this.clone.replace) {
        output[offset] = clampSample(sr * alpha + (base?.[offset] ?? 0) * (1 - alpha), maximum);
        output[offset + 1] = clampSample(sg * alpha + (base?.[offset + 1] ?? 0) * (1 - alpha), maximum);
        output[offset + 2] = clampSample(sb * alpha + (base?.[offset + 2] ?? 0) * (1 - alpha), maximum);
        output[offset + 3] = clampSample(sampled[3] * scale * alpha + (base?.[offset + 3] ?? 0) * (1 - alpha), maximum);
        return;
      }
    }
    if (ba === 0) {
      if (sa <= 0) output.fill(0, offset, offset + 4);
      else {
        output[offset] = clampSample(sr, maximum); output[offset + 1] = clampSample(sg, maximum);
        output[offset + 2] = clampSample(sb, maximum); output[offset + 3] = clampSample(sa * maximum, maximum);
      }
      return;
    }
    const outA = sa + ba * (1 - sa);
    if (outA <= 0) { output.fill(0, offset, offset + 4); return; }
    const keep = ba * (1 - sa);
    output[offset] = clampSample((sr * sa + (base?.[offset] ?? 0) * keep) / outA, maximum);
    output[offset + 1] = clampSample((sg * sa + (base?.[offset + 1] ?? 0) * keep) / outA, maximum);
    output[offset + 2] = clampSample((sb * sa + (base?.[offset + 2] ?? 0) * keep) / outA, maximum);
    output[offset + 3] = clampSample(outA * maximum, maximum);
  }

  private selectionCoverage(px: number, py: number): number {
    const selection = this.selection;
    if (!selection) return 1;
    const x = Math.floor(px - selection.x), y = Math.floor(py - selection.y), mask = selection.mask;
    if (x < 0 || y < 0 || x >= mask.width || y >= mask.height) return 0;
    const col = Math.floor(x / TILE), row = Math.floor(y / TILE);
    const tile = mask.tiles[row * mask.cols + col];
    if (!tile) return 0;
    return (tile[((y - row * TILE) * mask.tileWidth(col) + (x - col * TILE)) * mask.channels] ?? 0) / 255;
  }

  private publishSnapshot(): void {
    if (!this.pendingSnapshotKeys.size) return;
    const tiles = this.raster.tiles.slice();
    for (const key of this.pendingSnapshotKeys) {
      const output = this.tiles.get(key)!.output;
      tiles[key] = isZero(output) ? null : output.slice();
    }
    this.raster = new Raster(this.raster.width, this.raster.height, this.raster.channels, tiles, { format: this.raster.format });
    this.pendingSnapshotKeys.clear();
  }

  private finishedResult(): StrokeResult {
    this.publishSnapshot();
    this.done = true;
    if (this.isMask) return { raster: this.raster, bounds: { x: 0, y: 0, width: this.raster.width, height: this.raster.height }, sourceRect: this.sourceRect };
    let painted: Rect | null = null;
    for (const [key, state] of this.tiles) {
      const col = key % this.raster.cols, row = Math.floor(key / this.raster.cols);
      const tw = this.raster.tileWidth(col), th = this.raster.tileHeight(row);
      let left = tw, right = 0, top = th, bottom = 0;
      for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
        if (!state.output[(y * tw + x) * 4 + 3]) continue;
        if (x < left) left = x;
        if (x + 1 > right) right = x + 1;
        if (y < top) top = y;
        if (y + 1 > bottom) bottom = y + 1;
      }
      if (right > left) painted = integralUnion(painted, { x: col * TILE + left, y: row * TILE + top, width: right - left, height: bottom - top });
    }
    const sourceBounds = this.originalSource ? this.sourceRect : null;
    const crop = painted ? integralUnion(sourceBounds, painted) : sourceBounds ?? { x: 0, y: 0, width: this.raster.width, height: this.raster.height };
    const raster = crop.x === 0 && crop.y === 0 && crop.width === this.raster.width && crop.height === this.raster.height
      ? this.raster : cropTiled(this.raster, crop);
    const center = apply(this.mapping, { x: crop.x + crop.width / 2, y: crop.y + crop.height / 2 });
    const size = { width: crop.width * this.paintTransform.size.width / this.raster.width,
      height: crop.height * this.paintTransform.size.height / this.raster.height };
    return { raster, transform: { ...this.paintTransform, size, origin: { x: center.x - size.width / 2, y: center.y - size.height / 2 } },
      bounds: crop, sourceRect: this.sourceRect };
  }

  private assertActive(): void {
    if (this.done) throw new Error('Brush stroke is no longer active');
  }
}

/** The worker-side view of a dab stroke (only settled segments arrive there). */
export function beginSettledDabStroke(options: BeginStrokeOptions): SettledStroke {
  const stroke = new DabBrushStroke(options);
  return {
    addSettled: (segments) => stroke.addSettled(segments),
    currentRaster: () => stroke.currentRaster(),
    finish: (segments) => stroke.finishSettled(segments),
    cancel: () => stroke.cancel(),
  };
}

export function penValue(value: number | readonly number[] | undefined, index: number): number | undefined {
  const raw = typeof value === 'number' ? value : value?.[index];
  if (raw === undefined) return undefined;
  return Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 1;
}

export function averageTilt(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined || b === undefined ? undefined : (a + b) / 2;
}

function clearRect(buffer: Float32Array, width: number, rect: IntRect): void {
  for (let y = rect.y; y < rect.y + rect.height; y++) buffer.fill(0, y * width + rect.x, y * width + rect.x + rect.width);
}
function samePoint(a: Point | undefined, b: Point): boolean { return !!a && a.x === b.x && a.y === b.y; }
function clampSample(value: number, maximum: number): number { return Math.min(maximum, Math.max(0, Math.round(value))); }
function isZero(data: PixelArray): boolean { for (let i = 0; i < data.length; i++) if (data[i]) return false; return true; }
function translatedInput(m: Affine, x: number, y: number): Affine { return { ...m, tx: m.tx + m.a * x + m.c * y, ty: m.ty + m.b * x + m.d * y }; }
function unionInt(a: IntRect | undefined, b: IntRect): IntRect {
  if (!a) return { ...b };
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}
function intersectRect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width), bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}
function integralBounds(rect: Rect): Rect {
  const x = Math.floor(rect.x), y = Math.floor(rect.y);
  return { x, y, width: Math.ceil(rect.x + rect.width) - x, height: Math.ceil(rect.y + rect.height) - y };
}
function integralUnion(a: Rect | null, b: Rect): Rect {
  if (!a) return integralBounds(b);
  const x = Math.floor(Math.min(a.x, b.x)), y = Math.floor(Math.min(a.y, b.y));
  return { x, y, width: Math.ceil(Math.max(a.x + a.width, b.x + b.width)) - x, height: Math.ceil(Math.max(a.y + a.height, b.y + b.height)) - y };
}
function transformedBounds(transform: Affine, rect: Rect): Rect {
  const points = [apply(transform, { x: rect.x, y: rect.y }), apply(transform, { x: rect.x + rect.width, y: rect.y }),
    apply(transform, { x: rect.x, y: rect.y + rect.height }), apply(transform, { x: rect.x + rect.width, y: rect.y + rect.height })];
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}
