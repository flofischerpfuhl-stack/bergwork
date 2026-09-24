import type { Layer } from '../document';
import { maskTransform } from '../document';
import {
  apply, invert, pixelToDocument, type Affine, type LayerTransform, type Point, type Rect,
} from '../geometry';
import type { Raster } from '../raster';
import {
  beginStroke, brushSegment, continuousBrushCurve, type BeginStrokeOptions, type BrushSegment,
  type Stroke, type StrokeResult, type StrokeUpdate,
} from './stroke';
import { validateBrushSettings, type BrushSettings } from './settings';
import { BrushRasterWorker } from './workerClient';

interface RecordedUpdate {
  readonly points: readonly Point[];
  readonly pressure?: number | readonly number[];
}

/** Geometry consumed by GpuCompositor while the exact CPU stroke remains deferred. */
export interface GpuBrushPreview {
  readonly layerId: string;
  readonly layer: Layer;
  readonly target: 'pixels' | 'mask';
  readonly settings: BrushSettings;
  readonly canvas: { readonly width: number; readonly height: number };
  readonly width: number;
  readonly height: number;
  readonly mapping: Affine;
  readonly transform: LayerTransform;
  readonly sourceRect: Rect;
  readonly source: Raster | null;
  readonly settled: readonly BrushSegment[];
  readonly tail: readonly BrushSegment[];
  readonly revision: number;
}

interface TargetGeometry {
  readonly width: number;
  readonly height: number;
  readonly mapping: Affine;
  readonly transform: LayerTransform;
  readonly sourceRect: Rect;
  readonly source: Raster | null;
}

/**
 * BrushStroke.appendContinuous without its per-pixel work. MetalBrushCoverage.swift receives the
 * same settled spline chords and replaceable straight tail; CPU replay remains the source of truth.
 */
export class RecordedBrushStroke implements Stroke {
  readonly gpuPreview: GpuBrushPreview;
  private readonly updates: RecordedUpdate[] = [];
  private readonly samples: Point[] = [];
  private readonly pressures: number[] = [];
  private cpu: Stroke | null = null;
  private readonly background: BrushRasterWorker | null;
  private replayed = 0;
  private done = false;
  private finalSegments: readonly BrushSegment[] | null = null;

  constructor(private readonly options: BeginStrokeOptions) {
    validateBrushSettings(options.settings);
    const target = targetGeometry(options);
    const settled: BrushSegment[] = [], tail: BrushSegment[] = [];
    this.gpuPreview = {
      layerId: options.layer.id, layer: options.layer, target: options.target === 'mask' ? 'mask' : 'pixels', settings: options.settings,
      canvas: options.canvas, width: target.width, height: target.height, mapping: target.mapping,
      transform: target.transform, sourceRect: target.sourceRect, source: target.source,
      settled, tail, revision: 0,
    };
    this.background = BrushRasterWorker.create(options, target);
  }

  addPoints(points: readonly Point[], options: { readonly pressure?: number | readonly number[] } = {}): StrokeUpdate {
    this.assertActive();
    this.updates.push({ points: points.map((p) => ({ ...p })), pressure: clonePressure(options.pressure) });
    const dirty: Rect[] = [];
    const settledForWorker: BrushSegment[] = [];
    let changed = false;
    for (let i = 0; i < points.length; i++) {
      const point = points[i]!;
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || Math.abs(point.x) > 10_000_000
        || Math.abs(point.y) > 10_000_000 || samePoint(this.samples.at(-1), point)) continue;
      const option = options.pressure;
      const raw = typeof option === 'number' ? option : option?.[i] ?? 1;
      const pressure = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 1;
      this.samples.push({ ...point });
      this.pressures.push(pressure);
      if (this.samples.length > 4) { this.samples.shift(); this.pressures.shift(); }
      const n = this.samples.length;
      const newlySettled = n === 1
        ? [brushSegment(point, point, pressure)]
        : n >= 3
          ? continuousBrushCurve(this.samples[n - 3]!, this.samples[n - 2]!, this.samples[Math.max(0, n - 4)]!, point,
            this.pressures[n - 3]!, this.pressures[n - 2]!, this.curveTolerance())
          : [];
      const nextTail = n >= 2
        ? [brushSegment(this.samples[n - 2]!, point, (this.pressures[n - 2]! + pressure) / 2)] : [];
      const mutable = this.gpuPreview as Mutable<GpuBrushPreview>;
      const previousTail = [...mutable.tail];
      (mutable.settled as BrushSegment[]).push(...newlySettled);
      settledForWorker.push(...newlySettled);
      (mutable.tail as BrushSegment[]).splice(0, mutable.tail.length, ...nextTail);
      mutable.revision++;
      changed = true;
      dirty.push(...documentDirty([...previousTail, ...newlySettled, ...nextTail], this.options.settings.diameter,
        this.options.canvas));
    }
    this.background?.addSettled(settledForWorker);
    if (this.cpu) this.replayCpu();
    return { dirty: changed && !dirty.length ? [{ x: 0, y: 0, width: 1, height: 1 }] : dirty };
  }

  currentRaster(): Raster { this.replayCpu(); return this.cpu!.currentRaster(); }
  currentTransform(): LayerTransform { return this.gpuPreview.transform; }

  finish(): StrokeResult {
    this.assertActive();
    this.prepareFinalSegments();
    this.background?.cancel();
    this.done = true;
    return this.finishCpu();
  }

  /** Starts the exact worker tail flush. Null means this environment uses the synchronous fallback. */
  finishInBackground(): Promise<StrokeResult> | null {
    this.assertActive();
    if (!this.background) return null;
    const final = this.prepareFinalSegments();
    this.done = true;
    return this.background.finish(final).catch(() => this.finishCpu());
  }

  get usesBackgroundWorker(): boolean { return this.background !== null; }

  cancel(): void { this.done = true; this.background?.cancel(); this.cpu?.cancel(); }

  private prepareFinalSegments(): readonly BrushSegment[] {
    if (this.finalSegments) return this.finalSegments;
    const n = this.samples.length;
    this.finalSegments = n >= 2
      ? continuousBrushCurve(this.samples[n - 2]!, this.samples[n - 1]!, this.samples[Math.max(0, n - 3)]!,
        this.samples[n - 1]!, this.pressures[n - 2]!, this.pressures[n - 1]!, this.curveTolerance()) : [];
    const mutable = this.gpuPreview as Mutable<GpuBrushPreview>;
    (mutable.settled as BrushSegment[]).push(...this.finalSegments);
    (mutable.tail as BrushSegment[]).splice(0);
    mutable.revision++;
    return this.finalSegments;
  }

  private curveTolerance(): number {
    return this.options.target !== 'mask' && this.options.settings.mode === 'paint' && !this.options.clone
      && !this.options.selection && this.options.settings.diameter >= 256 ? 0.3 : 0.2;
  }

  private finishCpu(): StrokeResult {
    this.replayCpu();
    return this.cpu!.finish();
  }

  private replayCpu(): void {
    if (!this.cpu) this.cpu = beginStroke(this.options);
    while (this.replayed < this.updates.length) {
      const update = this.updates[this.replayed++]!;
      this.cpu.addPoints(update.points, update.pressure === undefined ? undefined : { pressure: update.pressure });
    }
  }

  private assertActive(): void {
    if (this.done) throw new Error('Brush stroke is no longer active');
  }
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function clonePressure(value: number | readonly number[] | undefined): number | readonly number[] | undefined {
  return Array.isArray(value) ? [...value] : value;
}

function samePoint(a: Point | undefined, b: Point): boolean { return !!a && a.x === b.x && a.y === b.y; }

function documentDirty(segments: readonly BrushSegment[], diameter: number,
  canvas: { readonly width: number; readonly height: number }): Rect[] {
  const reach = diameter / 2 + 2, result: Rect[] = [];
  for (const segment of segments) {
    const x = Math.max(0, Math.min(segment.x0, segment.x1) - reach);
    const y = Math.max(0, Math.min(segment.y0, segment.y1) - reach);
    const right = Math.min(canvas.width, Math.max(segment.x0, segment.x1) + reach);
    const bottom = Math.min(canvas.height, Math.max(segment.y0, segment.y1) + reach);
    if (right > x && bottom > y) result.push({ x, y, width: right - x, height: bottom - y });
  }
  return result;
}

/** BrushStroke.init's working grid and expansion rules. */
function targetGeometry(options: BeginStrokeOptions): TargetGeometry {
  const isMask = options.target === 'mask';
  const placedMask = isMask && options.layer.mask?.placement ? options.layer.mask : null;
  const base = placedMask ? maskTransform(options.layer) : options.layer.transform;
  const layerRaster = options.layer.raster ?? null;
  const source = isMask ? options.layer.mask?.raster ?? null : layerRaster;
  const originalWidth = placedMask?.raster.width ?? layerRaster?.width
    ?? Math.max(1, Math.round(options.layer.transform.size.width));
  const originalHeight = placedMask?.raster.height ?? layerRaster?.height
    ?? Math.max(1, Math.round(options.layer.transform.size.height));
  const originalMapping = pixelToDocument(base, originalWidth, originalHeight);
  const originalBounds = { x: 0, y: 0, width: originalWidth, height: originalHeight };
  const canvasPixels = transformedBounds(invert(originalMapping), { x: 0, y: 0, ...options.canvas });
  const extent = isMask ? originalBounds : integralUnion(originalBounds, canvasPixels);
  const maxPixels = options.pixelLimit ?? 100_000_000;
  if (extent.width < 1 || extent.height < 1 || extent.width > 1_000_000_000 || extent.height > 1_000_000_000
    || originalWidth > 30_000 || originalHeight > 30_000 || extent.width * extent.height > maxPixels) {
    throw new RangeError('Brush raster exceeds the pixel limit');
  }
  const sourceRect = { x: -extent.x, y: -extent.y, width: originalWidth, height: originalHeight };
  const mapping = translatedInput(originalMapping, extent.x, extent.y);
  const middle = apply(originalMapping, { x: extent.x + extent.width / 2, y: extent.y + extent.height / 2 });
  const size = { width: extent.width * base.size.width / originalWidth, height: extent.height * base.size.height / originalHeight };
  const transform = { ...base, size, origin: { x: middle.x - size.width / 2, y: middle.y - size.height / 2 } };
  return { width: extent.width, height: extent.height, mapping, transform, sourceRect, source };
}

function transformedBounds(transform: Affine, rect: Rect): Rect {
  const points = [
    apply(transform, { x: rect.x, y: rect.y }), apply(transform, { x: rect.x + rect.width, y: rect.y }),
    apply(transform, { x: rect.x, y: rect.y + rect.height }),
    apply(transform, { x: rect.x + rect.width, y: rect.y + rect.height }),
  ];
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

function integralUnion(a: Rect, b: Rect): Rect {
  const x = Math.floor(Math.min(a.x, b.x)), y = Math.floor(Math.min(a.y, b.y));
  return { x, y, width: Math.ceil(Math.max(a.x + a.width, b.x + b.width)) - x,
    height: Math.ceil(Math.max(a.y + a.height, b.y + b.height)) - y };
}

function translatedInput(m: Affine, x: number, y: number): Affine {
  return { ...m, tx: m.tx + m.a * x + m.c * y, ty: m.ty + m.b * x + m.d * y };
}
