/// <reference lib="webworker" />
import { documentFromTransfer, rasterToTransfer } from '../transfer';
import { beginStroke } from './stroke';
import { cloneSample } from './clone';
import type { CloneWorkerRequest, CloneWorkerResponse } from './cloneWorkerProtocol';

const scope = self as unknown as Worker;

self.onmessage = (event: MessageEvent<CloneWorkerRequest>) => {
  const started = performance.now();
  try {
    const request = event.data;
    const document = documentFromTransfer(request.document);
    const layer = document.layers.find((candidate) => candidate.id === request.activeLayerId);
    if (!layer) throw new Error('Clone Stamp source layer is no longer available');
    const clone = cloneSample(document, layer, request.offset, request.allLayers);
    const stroke = beginStroke({ layer, canvas: request.canvas, settings: request.settings, target: request.target,
      selection: document.selection, clone, pixelLimit: request.pixelLimit });
    for (const update of request.updates) stroke.addPoints(update.points, update.options);
    const result = stroke.finish();
    const raster = rasterToTransfer(result.raster);
    // The worker owns these result tiles. Transfer them rather than cloning the completed patch back.
    const transfers: Transferable[] = [];
    const transferred = new Set<ArrayBuffer>();
    raster.tiles = raster.tiles.map((tile) => {
      if (!tile) return null;
      const owned = tile.byteOffset === 0 && tile.byteLength === tile.buffer.byteLength ? tile : tile.slice();
      const buffer = owned.buffer as ArrayBuffer;
      if (!transferred.has(buffer)) { transferred.add(buffer); transfers.push(buffer); }
      return owned;
    });
    scope.postMessage({ ok: true, raster, transform: result.transform, bounds: result.bounds,
      sourceRect: result.sourceRect, workerMs: performance.now() - started } satisfies CloneWorkerResponse, transfers);
  } catch (cause) {
    scope.postMessage({ ok: false, error: cause instanceof Error ? cause.message : String(cause) } satisfies CloneWorkerResponse);
  }
};
