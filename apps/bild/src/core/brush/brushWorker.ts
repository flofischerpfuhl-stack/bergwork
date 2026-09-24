import { rasterFromTransfer } from '../transfer';
import type { Layer } from '../document';
import type { Raster } from '../raster';
import { beginSettledStroke, warmBrushDensity, type SettledStroke, type StrokeResult } from './stroke';
import type {
  BrushTileTransfer, BrushWorkerRequest, BrushWorkerResponse,
} from './workerProtocol';

const scope = globalThis as unknown as DedicatedWorkerGlobalScope;
let stroke: SettledStroke | null = null;
let previous: Raster | null = null;
let patchable = false;
let sourceTiles: (Uint8Array | null)[] | null = null;
let timing = { init: 0, settled: 0, finish: 0 };

// The common fully soft brush table is ready before the first pointer sample reaches this worker.
warmBrushDensity(0);

function post(message: BrushWorkerResponse, transfers: Transferable[] = []): void {
  scope.postMessage(message, transfers);
}

function layerFromTransfer(value: Extract<BrushWorkerRequest, { type: 'init' }>['options']['layer']): Layer {
  return {
    ...value,
    raster: value.raster ? rasterFromTransfer(value.raster) : null,
    mask: value.mask ? { ...value.mask, raster: rasterFromTransfer(value.mask.raster) } : null,
  };
}

function changedTiles(next: Raster, reset: boolean): { tiles: BrushTileTransfer[]; transfers: Transferable[] } {
  const tiles: BrushTileTransfer[] = [], transfers: Transferable[] = [];
  const compare = !reset && previous?.width === next.width && previous.height === next.height
    && previous.channels === next.channels ? previous : null;
  for (let index = 0; index < next.tiles.length; index++) {
    const tile = next.tiles[index] ?? null;
    if (compare && compare.tiles[index] === tile) continue;
    if (!tile) { tiles.push({ index, data: null }); continue; }
    const data = new Uint8Array(tile).buffer;
    tiles.push({ index, data });
    transfers.push(data);
  }
  previous = next;
  return { tiles, transfers };
}

function snapshot(): void {
  if (!stroke) return;
  const raster = stroke.currentRaster();
  const reset = !patchable || !previous || previous.width !== raster.width || previous.height !== raster.height
    || previous.channels !== raster.channels;
  const changed = changedTiles(raster, reset);
  post({ type: 'snapshot', width: raster.width, height: raster.height, channels: raster.channels,
    reset, tiles: changed.tiles }, changed.transfers);
}

function finished(result: StrokeResult): void {
  const raster = result.raster;
  const reset = !patchable || !previous || previous.width !== raster.width || previous.height !== raster.height
    || previous.channels !== raster.channels;
  const changed = changedTiles(raster, reset);
  post({ type: 'finished', width: raster.width, height: raster.height, channels: raster.channels,
    reset, tiles: changed.tiles, transform: result.transform, bounds: result.bounds, sourceRect: result.sourceRect,
    timing }, changed.transfers);
}

scope.addEventListener('message', (event: MessageEvent<BrushWorkerRequest>) => {
  const request = event.data;
  try {
    if (request.type === 'init') {
      const started = performance.now();
      const options = request.options;
      const source = options.target === 'mask' ? options.layer.mask?.raster : options.layer.raster;
      if (source?.format === 'rgba16') throw new Error('The existing 8-bit brush worker cannot paint an rgba16 layer yet.');
      sourceTiles = options.patchable && source ? source.tiles as (Uint8Array | null)[] : null;
      stroke = beginSettledStroke({ layer: layerFromTransfer(options.layer), canvas: options.canvas,
        settings: options.settings, target: options.target, pixelLimit: options.pixelLimit, tilePartition: options.partition });
      previous = stroke.currentRaster();
      patchable = options.patchable;
      timing = { init: performance.now() - started, settled: 0, finish: 0 };
    } else if (request.type === 'settled') {
      const started = performance.now();
      if (!stroke) throw new Error('Brush worker was not initialized');
      for (const base of request.bases) if (sourceTiles) sourceTiles[base.index] = base.data;
      stroke.addSettled(request.segments);
      timing.settled += performance.now() - started;
    } else if (request.type === 'finish') {
      const started = performance.now();
      if (!stroke) throw new Error('Brush worker was not initialized');
      for (const base of request.bases) if (sourceTiles) sourceTiles[base.index] = base.data;
      const current = stroke;
      stroke = null;
      const result = current.finish(request.segments);
      timing.finish += performance.now() - started;
      finished(result);
    } else {
      stroke?.cancel();
      stroke = null;
      previous = null;
      sourceTiles = null;
    }
  } catch (cause) {
    post({ type: 'error', message: cause instanceof Error ? cause.message : String(cause) });
    stroke = null;
  }
});
