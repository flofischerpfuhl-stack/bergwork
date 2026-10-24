import type { CanvasDocument } from '../document';
import { documentToTransfer, rasterFromTransfer } from '../transfer';
import type { BeginStrokeOptions, StrokeResult } from './stroke';
import type { CloneWorkerRequest, CloneWorkerResponse, CloneWorkerUpdate } from './cloneWorkerProtocol';

export let lastCloneWorkerTiming: { readonly dispatchMs: number; readonly workerMs: number; readonly totalMs: number } | null = null;

export function finishCloneInWorker(options: BeginStrokeOptions, updates: readonly CloneWorkerUpdate[]): Promise<StrokeResult> | null {
  const source = options.clone?.workerSource;
  if (typeof Worker === 'undefined' || !source) return null;
  const active = source.document.layers.find((layer) => layer.id === source.activeLayerId);
  if (!active) return null;
  // This Layer needs only the immutable target/source layer. All Layers retains the rendered stack.
  const snapshot: CanvasDocument = source.allLayers ? source.document : { ...source.document, layers: [active] };
  const document = documentToTransfer(snapshot);
  // Lossless-save encoded sources are unrelated to sampling and can be tens of megabytes.
  for (const layer of document.layers) {
    if ('raster' in layer && layer.raster) layer.raster.source = null;
    if (layer.mask) layer.mask.raster.source = null;
  }
  if (document.selection) document.selection.mask.source = null;
  const request: CloneWorkerRequest = {
    document, activeLayerId: source.activeLayerId, allLayers: source.allLayers,
    offset: options.clone.offset, canvas: options.canvas, settings: options.settings,
    target: options.target ?? 'pixels', pixelLimit: options.pixelLimit ?? 100_000_000, updates,
  };
  const worker = new Worker(new URL('./cloneWorker.ts', import.meta.url), { type: 'module', name: 'clone-stamp-commit' });
  const started = performance.now();
  return new Promise<StrokeResult>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<CloneWorkerResponse>) => {
      worker.terminate();
      if (!event.data.ok) { reject(new Error(event.data.error)); return; }
      lastCloneWorkerTiming = { dispatchMs: dispatched - started, workerMs: event.data.workerMs,
        totalMs: performance.now() - started };
      resolve({ raster: rasterFromTransfer(event.data.raster), transform: event.data.transform,
        bounds: event.data.bounds, sourceRect: event.data.sourceRect });
    };
    worker.onerror = (event) => { worker.terminate(); reject(new Error(event.message || 'Clone Stamp worker failed')); };
    worker.postMessage(request);
    const dispatched = performance.now();
  });
}
