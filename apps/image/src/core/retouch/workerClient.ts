import type { LayerTransform, Point } from '../geometry';
import type { Raster } from '../raster';
import type { DocumentSelection } from '../selection';
import { rasterToTransfer } from '../transfer';
import type { RetouchMode, RetouchSettings } from './index';
import type { RetouchReplayRequest, RetouchReplayResponse } from './workerProtocol';

export let lastRetouchWorkerTiming = 0;

export function replayRetouchInBackground(source: Raster, transform: LayerTransform, mode: RetouchMode,
  settings: RetouchSettings, selection: DocumentSelection | null,
  batches: readonly (readonly Point[])[]): Promise<Raster> | null {
  if (typeof Worker === 'undefined') return null;
  let worker: Worker;
  try { worker = new Worker(new URL('./retouchWorker.ts', import.meta.url), { type: 'module', name: 'retouch-replay' }); }
  catch { return null; }
  const request: RetouchReplayRequest = {
    source: { ...rasterToTransfer(source), source: null }, transform, mode, settings,
    selection: selection ? { ...selection, mask: { ...rasterToTransfer(selection.mask), source: null } } : null,
    batches,
  };
  return new Promise<Raster>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<RetouchReplayResponse>) => {
      worker.terminate();
      if (event.data.type === 'error') { reject(new Error(event.data.message)); return; }
      const response = event.data;
      lastRetouchWorkerTiming = response.timingMs;
      resolve(source.withTileUpdates(response.tiles.map((tile) => ({ index: tile.index,
        tile: tile.data ? (response.format === 'rgba16' ? new Uint16Array(tile.data) : new Uint8Array(tile.data)) : null }))));
    };
    worker.onerror = (event) => { worker.terminate(); reject(new Error(event.message || 'Retouch worker failed')); };
    worker.postMessage(request);
  });
}
