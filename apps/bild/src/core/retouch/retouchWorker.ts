import { rasterFromTransfer } from '../transfer';
import { BlurStroke } from './blur';
import { WarpStroke, type RetouchStroke } from './warp';
import { changedRetouchTiles, type RetouchReplayRequest, type RetouchReplayResponse } from './workerProtocol';

const scope = globalThis as unknown as DedicatedWorkerGlobalScope;

scope.addEventListener('message', (event: MessageEvent<RetouchReplayRequest>) => {
  try {
    const started = performance.now(), request = event.data;
    const source = rasterFromTransfer(request.source);
    const selection = request.selection ? { ...request.selection, mask: rasterFromTransfer(request.selection.mask) } : null;
    const stroke: RetouchStroke = request.mode === 'blur'
      ? new BlurStroke(source, request.transform, request.settings, selection)
      : new WarpStroke(source, request.transform, request.mode, request.settings, selection);
    for (const points of request.batches) stroke.addPoints(points);
    const result = stroke.finish(), changed = changedRetouchTiles(source.tiles, result.tiles);
    const response: RetouchReplayResponse = { type: 'result', format: result.format,
      tiles: changed.tiles, timingMs: performance.now() - started };
    scope.postMessage(response, changed.transfers);
  } catch (cause) {
    const response: RetouchReplayResponse = { type: 'error', message: cause instanceof Error ? cause.message : String(cause) };
    scope.postMessage(response);
  }
});
