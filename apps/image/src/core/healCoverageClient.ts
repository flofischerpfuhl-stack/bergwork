import type { Layer } from './document';
import type { Point, Size } from './geometry';
import type { DocumentSelection } from './selection';
import { rasterFromTransfer, rasterToTransfer, type LayerTransfer } from './transfer';
import type { BrushSettings } from './brush/settings';
import type { StrokeResult } from './brush/stroke';
import type { HealCoverageReplayRequest, HealCoverageReplayResponse } from './healCoverageProtocol';

export interface HealCoverageUpdate {
  readonly points: readonly Point[];
  readonly pressure?: number | readonly number[];
}

export function replayHealCoverageInBackground(layer: Layer, canvas: Size, settings: BrushSettings,
  selection: DocumentSelection | null, pixelLimit: number,
  updates: readonly HealCoverageUpdate[]): Promise<StrokeResult> | null {
  if (typeof Worker === 'undefined' || !layer.raster) return null;
  let worker: Worker;
  try { worker = new Worker(new URL('./healCoverageWorker.ts', import.meta.url), { type: 'module', name: 'heal-coverage-replay' }); }
  catch { return null; }
  const request: HealCoverageReplayRequest = {
    layer: { ...layer, raster: { ...rasterToTransfer(layer.raster), source: null }, mask: null } as LayerTransfer,
    canvas, settings, pixelLimit,
    selection: selection ? { ...selection, mask: { ...rasterToTransfer(selection.mask), source: null } } : null,
    updates,
  };
  return new Promise<StrokeResult>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<HealCoverageReplayResponse>) => {
      worker.terminate();
      if (event.data.type === 'error') { reject(new Error(event.data.message)); return; }
      resolve({ raster: rasterFromTransfer(event.data.raster), transform: event.data.transform,
        bounds: event.data.bounds, sourceRect: event.data.sourceRect });
    };
    worker.onerror = (event) => { worker.terminate(); reject(new Error(event.message || 'Healing coverage worker failed')); };
    worker.postMessage(request);
  });
}
