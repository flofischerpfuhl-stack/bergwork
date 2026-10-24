/// <reference lib="webworker" />

import { colourRangeMask } from '../core/refine/colourRange';
import { refineEdge } from '../core/refine/engine';
import type { RefineWorkerRequest, RefineWorkerResponse } from './refineProtocol';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const cancelled = new Set<number>();
scope.onmessage = (event: MessageEvent<RefineWorkerRequest>) => {
  const request = event.data;
  if (request.op === 'cancel') { cancelled.add(request.id); return; }
  cancelled.delete(request.id);
  try {
    if (request.op === 'colourRange') {
      const mask = colourRangeMask(request.rgba, request.width, request.height, request.settings);
      if (cancelled.has(request.id)) return;
      scope.postMessage({ id: request.id, type: 'mask', mask } satisfies RefineWorkerResponse, [mask.buffer]);
      return;
    }
    const result = refineEdge(request.rgba, request.width, request.height, request.mask, request.settings);
    if (cancelled.has(request.id)) return;
    const transfer: Transferable[] = [result.mask.buffer];
    if (result.decontaminatedRgba) transfer.push(result.decontaminatedRgba.buffer);
    scope.postMessage({ id: request.id, type: 'result', result } satisfies RefineWorkerResponse, transfer);
  } catch (error) {
    scope.postMessage({ id: request.id, type: 'error', error: error instanceof Error ? error.message : String(error) } satisfies RefineWorkerResponse);
  } finally { cancelled.delete(request.id); }
};
