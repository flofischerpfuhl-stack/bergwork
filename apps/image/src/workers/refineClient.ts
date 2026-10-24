import type { ColourRangeSettings } from '../core/refine/colourRange';
import type { RefineEdgeResult, RefineEdgeSettings } from '../core/refine/engine';
import type { RefineWorkerRequest, RefineWorkerResponse } from './refineProtocol';

let nextId = 1;
export class RefineEdgeClient {
  private worker: Worker | null = null;
  private readonly pending = new Map<number, { resolve(value: RefineEdgeResult | Uint8Array): void; reject(error: Error): void }>();

  refine(rgba: Uint8Array, width: number, height: number, mask: Uint8Array,
    settings: Partial<RefineEdgeSettings>, signal?: AbortSignal): Promise<RefineEdgeResult> {
    return this.post({ op: 'refine', id: nextId++, rgba, width, height, mask, settings }, [rgba.buffer, mask.buffer], signal) as Promise<RefineEdgeResult>;
  }

  /** Select › Color Range off the main thread; the RGBA buffer is transferred. */
  colourRange(rgba: Uint8Array, width: number, height: number, settings: ColourRangeSettings, signal?: AbortSignal): Promise<Uint8Array> {
    return this.post({ op: 'colourRange', id: nextId++, rgba, width, height, settings }, [rgba.buffer], signal) as Promise<Uint8Array>;
  }

  private post(request: Exclude<RefineWorkerRequest, { op: 'cancel' }>, transfer: Transferable[], signal?: AbortSignal): Promise<RefineEdgeResult | Uint8Array> {
    if (signal?.aborted) return Promise.reject(abortError());
    const worker = this.ensureWorker(), id = request.id;
    return new Promise((resolve, reject) => {
      const abort = (): void => { this.pending.delete(id); worker.postMessage({ op: 'cancel', id } satisfies RefineWorkerRequest); reject(abortError()); };
      this.pending.set(id, { resolve: (value) => { signal?.removeEventListener('abort', abort); resolve(value); },
        reject: (error) => { signal?.removeEventListener('abort', abort); reject(error); } });
      signal?.addEventListener('abort', abort, { once: true }); worker.postMessage(request, transfer);
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
      if (event.data.type === 'error') pending.reject(new Error(event.data.error));
      else pending.resolve(event.data.type === 'mask' ? event.data.mask : event.data.result);
    };
    worker.onerror = () => { for (const pending of this.pending.values()) pending.reject(new Error('The Refine Edge worker stopped unexpectedly.')); this.pending.clear(); this.worker = null; };
    this.worker = worker; return worker;
  }
}

function abortError(): Error { return typeof DOMException === 'undefined' ? new Error('Refine Edge was cancelled.') : new DOMException('Refine Edge was cancelled.', 'AbortError'); }
export const refineEdgeWorker = new RefineEdgeClient();
