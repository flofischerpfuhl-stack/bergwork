/// <reference lib="webworker" />

import { refineEdge } from '../core/refine/engine';
import type { RefineWorkerRequest, RefineWorkerResponse } from './refineProtocol';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const cancelled = new Set<number>();
scope.onmessage = (event: MessageEvent<RefineWorkerRequest>) => {
  const request = event.data;
  if (request.op === 'cancel') { cancelled.add(request.id); return; }
  cancelled.delete(request.id);
  try {
    const result = refineEdge(request.rgba, request.width, request.height, request.mask, request.settings);
    if (cancelled.has(request.id)) return;
    const transfer: Transferable[] = [result.mask.buffer];
    if (result.decontaminatedRgba) transfer.push(result.decontaminatedRgba.buffer);
    scope.postMessage({ id: request.id, type: 'result', result } satisfies RefineWorkerResponse, transfer);
  } catch (error) {
    scope.postMessage({ id: request.id, type: 'error', error: error instanceof Error ? error.message : String(error) } satisfies RefineWorkerResponse);
  } finally { cancelled.delete(request.id); }
};
