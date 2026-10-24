import { beginStroke } from './brush/stroke';
import { layerFromTransfer, rasterFromTransfer, rasterToTransfer } from './transfer';
import type { HealCoverageReplayRequest, HealCoverageReplayResponse } from './healCoverageProtocol';

const scope = globalThis as unknown as DedicatedWorkerGlobalScope;

scope.addEventListener('message', (event: MessageEvent<HealCoverageReplayRequest>) => {
  try {
    const request = event.data;
    const stroke = beginStroke({ layer: layerFromTransfer(request.layer), canvas: request.canvas,
      settings: request.settings, pixelLimit: request.pixelLimit,
      selection: request.selection ? { ...request.selection, mask: rasterFromTransfer(request.selection.mask) } : null });
    for (const update of request.updates) stroke.addPoints(update.points,
      update.pressure === undefined ? undefined : { pressure: update.pressure });
    const result = stroke.finish(), raster = rasterToTransfer(result.raster);
    const transfers: Transferable[] = [];
    for (const tile of raster.tiles) if (tile?.buffer instanceof ArrayBuffer) transfers.push(tile.buffer);
    const response: HealCoverageReplayResponse = { type: 'result', raster, transform: result.transform,
      bounds: result.bounds, sourceRect: result.sourceRect };
    scope.postMessage(response, transfers);
  } catch (cause) {
    const response: HealCoverageReplayResponse = { type: 'error', message: cause instanceof Error ? cause.message : String(cause) };
    scope.postMessage(response);
  }
});
