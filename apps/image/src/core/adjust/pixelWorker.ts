/// <reference lib="webworker" />
import { Raster } from '../raster.js';
import type { DocumentSelection } from '../selection.js';
import { adjustRaster } from './raster.js';
import { levelsHistogram } from './raster.js';
import { applyFilter } from '../filters/apply.js';
import type { PixelWorkerRequest, PixelWorkerResponse, SerializedSelection } from './pixelWorkerClient.js';

const scope = globalThis as unknown as DedicatedWorkerGlobalScope;
function selection(value: SerializedSelection | null): DocumentSelection | null {
  return value ? { mask: Raster.fromPixels(value.width, value.height, 1, value.pixels), x: value.x, y: value.y, antialiased: value.antialiased } : null;
}
scope.addEventListener('message', (event: MessageEvent<PixelWorkerRequest>) => {
  const request = event.data;
  try {
    const raster = Raster.fromPixels(request.width, request.height, 4, request.pixels, { format: request.format });
    const selected = selection(request.selection);
    if (request.operation === 'histogram') {
      const bins = levelsHistogram(raster, request.transform, selected);
      const response: PixelWorkerResponse = { id: request.id, bins };
      scope.postMessage(response, bins.map((value) => value.buffer)); return;
    }
    const made = request.operation === 'adjust'
      ? { raster: adjustRaster(raster, request.transform, request.adjustment, selected), transform: request.transform }
      : applyFilter(request.kind, raster, request.transform, request.settings,
        { selection: selected, seed: request.seed, expand: request.expand });
    const tiles = made.raster.tiles.map((tile) => tile ? tile.buffer as ArrayBuffer : null);
    const response: PixelWorkerResponse = { id: request.id, tiles, format: made.raster.format,
      width: made.raster.width, height: made.raster.height, transform: made.transform };
    scope.postMessage(response, [...new Set(tiles.filter((tile): tile is ArrayBuffer => tile !== null))]);
  } catch (cause) {
    const response: PixelWorkerResponse = { id: request.id, error: cause instanceof Error ? cause.message : String(cause) };
    scope.postMessage(response);
  }
});
