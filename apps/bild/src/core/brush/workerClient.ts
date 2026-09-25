import type { Layer } from '../document';
import { Raster, TILE } from '../raster';
import type { LayerTransfer, RasterTransfer } from '../transfer';
import { apply, invert, type Affine, type Rect } from '../geometry';
import type { BeginStrokeOptions, BrushSegment, StrokeResult } from './stroke';
import type { BrushWorkerRequest, BrushWorkerResponse } from './workerProtocol';
import { brushReach } from './tip';
import type { BrushSettings } from './settings';

const PREWARM_WORKERS = typeof Worker === 'undefined' ? 0
  : Math.min(8, Math.max(1, globalThis.navigator?.hardwareConcurrency ?? 1));
const workerPool: Worker[] = [];
export let lastBrushWorkerTiming: readonly { init: number; settled: number; finish: number }[] = [];

function makeWorker(index: number): Worker {
  return new Worker(new URL('./brushWorker.ts', import.meta.url), { type: 'module', name: `brush-raster-${index}` });
}

if (PREWARM_WORKERS) {
  try { for (let index = 0; index < PREWARM_WORKERS; index++) workerPool.push(makeWorker(index)); }
  catch { for (const worker of workerPool.splice(0)) worker.terminate(); }
}

/** Sampled tip images each pooled worker already holds, so a 2500 px tip is copied to a worker once, not per stroke. */
const workerTips = new WeakMap<Worker, Set<string>>();
const EMPTY_TIP = new Uint8Array(0);
function settingsFor(worker: Worker, settings: BrushSettings): BrushSettings {
  const tip = settings.tip;
  if (tip?.kind !== 'sampled') return settings;
  let held = workerTips.get(worker);
  if (!held) { held = new Set(); workerTips.set(worker, held); }
  if (held.has(tip.image.id)) return { ...settings, tip: { ...tip, image: { ...tip.image, data: EMPTY_TIP } } };
  held.add(tip.image.id);
  // The worker keeps a few recent tips (brushWorker.ts); forget ours when it may have evicted one.
  if (held.size > 4) { held.clear(); held.add(tip.image.id); }
  return settings;
}

function takeWorker(index: number): Worker { return workerPool.pop() ?? makeWorker(index); }
function releaseWorker(worker: Worker): void {
  worker.onmessage = null; worker.onerror = null;
  workerPool.push(worker);
}

interface WorkerGeometry {
  readonly width: number;
  readonly height: number;
  readonly sourceRect: Rect;
  readonly source: Raster | null;
  readonly mapping: Affine;
}

function rasterTransfer(raster: Raster, pixels = true): RasterTransfer {
  return { id: raster.id, width: raster.width, height: raster.height, channels: raster.channels,
    format: raster.format,
    tiles: pixels ? raster.tiles.slice() : new Array(raster.tiles.length).fill(null), source: null };
}

function layerTransfer(layer: Layer, target: 'pixels' | 'mask', pixels: boolean): LayerTransfer {
  const mask = layer.mask ? { ...layer.mask, raster: rasterTransfer(layer.mask.raster, pixels && target === 'mask') } : null;
  switch (layer.kind) {
    case 'pixel': return { ...layer, raster: layer.raster ? rasterTransfer(layer.raster, pixels && target === 'pixels') : null, mask };
    case 'vector': return { ...layer, raster: layer.raster ? rasterTransfer(layer.raster, pixels && target === 'pixels') : null, mask };
    case 'text': return { ...layer, raster: layer.raster ? rasterTransfer(layer.raster, pixels && target === 'pixels') : null, mask };
    case 'embedded': return { ...layer, raster: layer.raster ? rasterTransfer(layer.raster, pixels && target === 'pixels') : null, mask };
    case 'group': return { ...layer, mask };
    case 'adjustment': return { ...layer, mask };
    case 'fill': return { ...layer, mask };
  }
}

/** One exact raster job. Module workers are intentionally absent in Vitest, which keeps its synchronous path. */
export class BrushRasterWorker {
  private readonly workers: Worker[] = [];
  private latest: Raster | null;
  private resolve: ((result: StrokeResult) => void) | null = null;
  private reject: ((cause: Error) => void) | null = null;
  private finished = false;
  private readonly settled: BrushSegment[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly source: Raster | null;
  private readonly geometry: WorkerGeometry;
  private readonly reach: number;
  private readonly loadedBaseTiles = new Set<number>();
  private remaining = 0;
  private finalMetadata: Omit<StrokeResult, 'raster'> | null = null;
  private readonly timings: { init: number; settled: number; finish: number }[] = [];
  private failure: Error | null = null;

  static create(options: BeginStrokeOptions, geometry: WorkerGeometry): BrushRasterWorker | null {
    if (typeof Worker === 'undefined' || options.clone || options.selection) return null;
    try { return new BrushRasterWorker(options, geometry); } catch { return null; }
  }

  private constructor(options: BeginStrokeOptions, geometry: WorkerGeometry) {
    const target = options.target === 'mask' ? 'mask' : 'pixels';
    const source = geometry.source;
    const patchable = !source || (geometry.sourceRect.x === 0 && geometry.sourceRect.y === 0
      && geometry.sourceRect.width === geometry.width && geometry.sourceRect.height === geometry.height
      && source.width === geometry.width && source.height === geometry.height);
    this.latest = patchable ? source ?? Raster.blank(geometry.width, geometry.height, target === 'mask' ? 1 : 4) : null;
    this.source = patchable ? source : null;
    this.geometry = geometry;
    this.reach = brushReach(options.settings);
    const concurrency = Math.max(1, globalThis.navigator?.hardwareConcurrency ?? 1);
    const count = patchable && source ? Math.min(8, concurrency) : 1;
    for (let index = 0; index < count; index++) {
      const worker = takeWorker(index);
      worker.onmessage = (event: MessageEvent<BrushWorkerResponse>) => this.receive(event.data, worker);
      worker.onerror = (event) => { workerTips.delete(worker); this.fail(new Error(event.message || 'Brush worker failed')); };
      worker.postMessage({ type: 'init', options: { layer: layerTransfer(options.layer, target, !patchable), canvas: options.canvas,
        settings: settingsFor(worker, options.settings), target, pixelLimit: options.pixelLimit ?? 100_000_000, patchable,
        partition: { index, count } } } satisfies BrushWorkerRequest);
      this.workers.push(worker);
    }
  }

  addSettled(segments: readonly BrushSegment[]): void {
    if (!segments.length || this.finished) return;
    this.settled.push(...segments);
    // Pointer samples normally arrive faster than the CPU density pass. One short batch preserves
    // segment order while composing each changed tile once instead of once per DOM event.
    this.flushTimer ??= setTimeout(() => this.flushSettled(), 100);
  }

  finish(segments: readonly BrushSegment[]): Promise<StrokeResult> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.finished) return Promise.reject(new Error('Brush worker is no longer active'));
    if (this.flushTimer !== null) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    const pending = this.settled.splice(0);
    this.finished = true;
    this.remaining = this.workers.length;
    const promise = new Promise<StrokeResult>((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    queueMicrotask(() => {
      if (pending.length) this.postSettled(pending);
      for (let index = 0; index < this.workers.length; index++) {
        const bases = this.baseTiles(segments, index, this.workers.length);
        this.workers[index]!.postMessage({ type: 'finish', segments, bases } satisfies BrushWorkerRequest,
          bases.map((base) => base.data));
      }
    });
    return promise;
  }

  cancel(): void {
    if (this.finished && !this.resolve) return;
    this.finished = true;
    for (const worker of this.workers) {
      worker.postMessage({ type: 'cancel' } satisfies BrushWorkerRequest);
      releaseWorker(worker);
    }
    this.reject?.(new Error('Brush stroke cancelled'));
    this.resolve = null; this.reject = null;
  }

  currentRaster(): Raster | null { return this.latest; }

  private flushSettled(): void {
    this.flushTimer = null;
    if (!this.settled.length) return;
    const segments = this.settled.splice(0);
    this.postSettled(segments);
  }

  private postSettled(segments: readonly BrushSegment[]): void {
    for (let index = 0; index < this.workers.length; index++) {
      const bases = this.baseTiles(segments, index, this.workers.length);
      this.workers[index]!.postMessage({ type: 'settled', segments, bases } satisfies BrushWorkerRequest,
        bases.map((base) => base.data));
    }
  }

  private baseTiles(segments: readonly BrushSegment[], partition: number,
    partitionCount: number): { index: number; data: ArrayBuffer }[] {
    const source = this.source;
    if (!source) return [];
    const inverse = invert(this.geometry.mapping), reach = this.reach;
    const wanted = new Set<number>();
    for (const segment of segments) {
      const x = Math.min(segment.x0, segment.x1) - reach, y = Math.min(segment.y0, segment.y1) - reach;
      const width = Math.abs(segment.x1 - segment.x0) + reach * 2;
      const height = Math.abs(segment.y1 - segment.y0) + reach * 2;
      const points = [apply(inverse, { x, y }), apply(inverse, { x: x + width, y }),
        apply(inverse, { x, y: y + height }), apply(inverse, { x: x + width, y: y + height })];
      let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
      for (const point of points) {
        left = Math.min(left, point.x); top = Math.min(top, point.y);
        right = Math.max(right, point.x); bottom = Math.max(bottom, point.y);
      }
      const x0 = Math.max(0, Math.floor(left)), y0 = Math.max(0, Math.floor(top));
      const x1 = Math.min(this.geometry.width, Math.ceil(right)), y1 = Math.min(this.geometry.height, Math.ceil(bottom));
      if (x1 <= x0 || y1 <= y0) continue;
      for (let row = Math.floor(y0 / TILE); row <= Math.floor((y1 - 1) / TILE); row++) {
        for (let col = Math.floor(x0 / TILE); col <= Math.floor((x1 - 1) / TILE); col++) {
          const key = row * source.cols + col;
          if ((col * 31 + row * 17) % partitionCount === partition) wanted.add(key);
        }
      }
    }
    const result: { index: number; data: ArrayBuffer }[] = [];
    for (const index of wanted) {
      if (this.loadedBaseTiles.has(index)) continue;
      this.loadedBaseTiles.add(index);
      const tile = source.tiles[index];
      if (tile) result.push({ index, data: tile.slice().buffer });
    }
    return result;
  }

  private receive(message: BrushWorkerResponse, worker: Worker): void {
    if (message.type === 'error') { this.fail(new Error(message.message)); return; }
    const base = !message.reset && this.latest?.width === message.width && this.latest.height === message.height
      && this.latest.channels === message.channels && this.latest.format === message.format
      ? this.latest : Raster.blank(message.width, message.height, message.channels, { format: message.format });
    this.latest = base.withTileUpdates(message.tiles.map((tile) => ({
      index: tile.index,
      tile: tile.data ? (message.format === 'rgba16' ? new Uint16Array(tile.data) : new Uint8Array(tile.data)) : null,
    })));
    if (message.type !== 'finished') return;
    this.finalMetadata = { transform: message.transform, bounds: message.bounds, sourceRect: message.sourceRect };
    this.timings.push(message.timing);
    releaseWorker(worker);
    this.remaining--;
    if (this.remaining > 0) return;
    const resolve = this.resolve, metadata = this.finalMetadata;
    lastBrushWorkerTiming = this.timings.slice();
    this.resolve = null; this.reject = null;
    if (metadata) resolve?.({ raster: this.latest, ...metadata });
  }

  private fail(error: Error): void {
    const reject = this.reject;
    this.failure = error;
    this.resolve = null; this.reject = null;
    for (const worker of this.workers) worker.terminate();
    reject?.(error);
  }
}
