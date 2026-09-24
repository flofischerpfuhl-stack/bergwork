import type { RefineEdgeResult, RefineEdgeSettings } from '../core/refine/engine';
import type { RefineWorkerRequest, RefineWorkerResponse } from './refineProtocol';

let nextId = 1;
export class RefineEdgeClient {
  private worker: Worker | null = null;
  private readonly pending = new Map<number, { resolve(value: RefineEdgeResult): void; reject(error: Error): void }>();

  refine(rgba: Uint8Array, width: number, height: number, mask: Uint8Array,
    settings: Partial<RefineEdgeSettings>, signal?: AbortSignal): Promise<RefineEdgeResult> {
    if (signal?.aborted) return Promise.reject(abortError());
    const worker = this.ensureWorker(), id = nextId++;
    const request: RefineWorkerRequest = { op: 'refine', id, rgba, width, height, mask, settings };
    return new Promise((resolve, reject) => {
      const abort = (): void => { this.pending.delete(id); worker.postMessage({ op: 'cancel', id } satisfies RefineWorkerRequest); reject(abortError()); };
      this.pending.set(id, { resolve: (value) => { signal?.removeEventListener('abort', abort); resolve(value); },
        reject: (error) => { signal?.removeEventListener('abort', abort); reject(error); } });
      signal?.addEventListener('abort', abort, { once: true }); worker.postMessage(request, [rgba.buffer, mask.buffer]);
    });
  }
  destroy(): void { this.worker?.terminate(); this.worker = null; this.pending.clear(); }
  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    if (typeof Worker === 'undefined') throw new Error('Refine Edge requires module Worker support.');
    const worker = new Worker(new URL('./refineWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<RefineWorkerResponse>) => {
      const pending = this.pending.get(event.data.id); if (!pending) return;
      this.pending.delete(event.data.id);
      if (event.data.type === 'error') pending.reject(new Error(event.data.error)); else pending.resolve(event.data.result);
    };
    worker.onerror = () => { for (const pending of this.pending.values()) pending.reject(new Error('The Refine Edge worker stopped unexpectedly.')); this.pending.clear(); this.worker = null; };
    this.worker = worker; return worker;
  }
}

function abortError(): Error { return typeof DOMException === 'undefined' ? new Error('Refine Edge was cancelled.') : new DOMException('Refine Edge was cancelled.', 'AbortError'); }
export const refineEdgeWorker = new RefineEdgeClient();
