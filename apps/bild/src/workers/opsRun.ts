/** Runs one document operation; shared by the worker and the in-thread fallback. */

import { cropDocument, resizeCanvas, resizeImage } from '../core/canvasOps';
import { warpMask, warpRasterTrimmed } from '../core/distort';
import { documentFromTransfer, documentToTransfer, rasterFromTransfer, rasterToTransfer } from '../core/transfer';
import type { OpsRequest, OpsResponse } from './opsProtocol';

export function runOp(request: OpsRequest, id: number): OpsResponse {
  try {
    if (request.op === 'warp') {
      const raster = rasterFromTransfer(request.raster);
      if (request.mask) {
        const result = warpMask(raster, request.transform, request.corners, request.background);
        return { id, ok: true, raster: rasterToTransfer(result.raster), transform: result.transform };
      }
      const result = warpRasterTrimmed(raster, request.transform, request.corners);
      return { id, ok: true, raster: rasterToTransfer(result.raster), transform: result.transform };
    }
    const document = documentFromTransfer(request.document);
    const next = request.op === 'imageSize' ? resizeImage(document, request.width, request.height, request.resolution, request.resample)
      : request.op === 'canvasSize' ? resizeCanvas(document, request.width, request.height, request.anchor, request.options)
        : cropDocument(document, request.rect, request.options);
    return { id, ok: true, document: documentToTransfer(next) };
  } catch (error) {
    return { id, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
