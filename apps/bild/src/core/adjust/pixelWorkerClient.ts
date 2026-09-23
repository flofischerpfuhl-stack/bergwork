/** Cancellable worker boundary for full-raster adjustment and filter previews/commits. */
import type { LayerAdjustment } from '../document';
import type { LayerTransform } from '../geometry';
import { Raster } from '../raster';
import type { DocumentSelection } from '../selection';
import { adjustRaster } from './raster';
import { levelsHistogram } from './raster';
import { applyFilter, type FilterResult } from '../filters/apply';
import type { FilterKind, FilterSettings } from '../filters/settings';

export interface SerializedSelection { readonly pixels: Uint8Array; readonly width: number; readonly height: number; readonly x: number; readonly y: number; readonly antialiased: boolean }
export type PixelWorkerRequest =
  | { readonly id: number; readonly operation: 'adjust'; readonly pixels: Uint8Array; readonly width: number; readonly height: number;
      readonly transform: LayerTransform; readonly adjustment: LayerAdjustment; readonly selection: SerializedSelection | null }
  | { readonly id: number; readonly operation: 'filter'; readonly pixels: Uint8Array; readonly width: number; readonly height: number;
      readonly transform: LayerTransform; readonly kind: FilterKind; readonly settings: FilterSettings; readonly selection: SerializedSelection | null;
      readonly seed: number; readonly expand: boolean }
  | { readonly id: number; readonly operation: 'histogram'; readonly pixels: Uint8Array; readonly width: number; readonly height: number;
      readonly transform: LayerTransform; readonly selection: SerializedSelection | null };
export type PixelWorkerResponse = { readonly id: number; readonly pixels: Uint8Array; readonly width: number; readonly height: number;
  readonly transform: LayerTransform } | { readonly id: number; readonly bins: Float64Array[] } | { readonly id: number; readonly error: string };
export interface PixelJob { readonly promise: Promise<FilterResult>; cancel(): void }
export interface HistogramJob { readonly promise: Promise<Float64Array[]>; cancel(): void }

let nextId = 1;
function serializeSelection(selection: DocumentSelection | null): SerializedSelection | null {
  return selection ? { pixels: selection.mask.toPixels(), width: selection.mask.width, height: selection.mask.height,
    x: selection.x, y: selection.y, antialiased: selection.antialiased } : null;
}
function job(request: PixelWorkerRequest, fallback: () => FilterResult): PixelJob {
  if (typeof Worker === 'undefined') {
    let cancelled = false;
    return { promise: Promise.resolve().then(() => { if (cancelled) throw new Error('Pixel job cancelled'); return fallback(); }), cancel: () => { cancelled = true; } };
  }
  const worker = new Worker(new URL('./pixelWorker.ts', import.meta.url), { type: 'module' });
  let rejectPromise!: (reason: unknown) => void;
  const promise = new Promise<FilterResult>((resolve, reject) => {
    rejectPromise = reject;
    worker.addEventListener('message', (event: MessageEvent<PixelWorkerResponse>) => {
      if (event.data.id !== request.id) return;
      worker.terminate();
      if ('error' in event.data) reject(new Error(event.data.error));
      else if ('pixels' in event.data) resolve({ raster: Raster.fromPixels(event.data.width, event.data.height, 4, event.data.pixels), transform: event.data.transform });
      else reject(new Error('Unexpected pixel worker response'));
    });
    worker.addEventListener('error', (event) => { worker.terminate(); reject(new Error(event.message)); });
  });
  worker.postMessage(request, [request.pixels.buffer, ...(request.selection ? [request.selection.pixels.buffer] : [])]);
  return { promise, cancel: () => { worker.terminate(); rejectPromise(new Error('Pixel job cancelled')); } };
}

export function adjustmentPixelJob(raster: Raster, transform: LayerTransform, adjustment: LayerAdjustment,
  selection: DocumentSelection | null): PixelJob {
  const request: PixelWorkerRequest = { id: nextId++, operation: 'adjust', pixels: raster.toPixels(), width: raster.width,
    height: raster.height, transform, adjustment, selection: serializeSelection(selection) };
  return job(request, () => ({ raster: adjustRaster(raster, transform, adjustment, selection), transform }));
}
export function filterPixelJob(kind: FilterKind, raster: Raster, transform: LayerTransform, settings: FilterSettings,
  selection: DocumentSelection | null, seed: number, expand: boolean): PixelJob {
  const request: PixelWorkerRequest = { id: nextId++, operation: 'filter', pixels: raster.toPixels(), width: raster.width,
    height: raster.height, transform, kind, settings, selection: serializeSelection(selection), seed, expand };
  return job(request, () => applyFilter(kind, raster, transform, settings, { selection, seed, expand }));
}

export function histogramPixelJob(raster: Raster, transform: LayerTransform, selection: DocumentSelection | null): HistogramJob {
  const request: PixelWorkerRequest = { id: nextId++, operation: 'histogram', pixels: raster.toPixels(), width: raster.width,
    height: raster.height, transform, selection: serializeSelection(selection) };
  if (typeof Worker === 'undefined') {
    let cancelled = false;
    return { promise: Promise.resolve().then(() => { if (cancelled) throw new Error('Pixel job cancelled'); return levelsHistogram(raster, transform, selection); }),
      cancel: () => { cancelled = true; } };
  }
  const worker = new Worker(new URL('./pixelWorker.ts', import.meta.url), { type: 'module' });
  let rejectPromise!: (reason: unknown) => void;
  const promise = new Promise<Float64Array[]>((resolve, reject) => {
    rejectPromise = reject;
    worker.addEventListener('message', (event: MessageEvent<PixelWorkerResponse>) => {
      if (event.data.id !== request.id) return; worker.terminate();
      if ('error' in event.data) reject(new Error(event.data.error));
      else if ('bins' in event.data) resolve(event.data.bins);
      else reject(new Error('Unexpected pixel worker response'));
    });
    worker.addEventListener('error', (event) => { worker.terminate(); reject(new Error(event.message)); });
  });
  worker.postMessage(request, [request.pixels.buffer, ...(request.selection ? [request.selection.pixels.buffer] : [])]);
  return { promise, cancel: () => { worker.terminate(); rejectPromise(new Error('Pixel job cancelled')); } };
}
