import type { ObjectSelectionInference } from '../core/objectSelect/selection';
import type { ObjectPrompt, ObjectSelectResult, ObjectSelectStage } from '../core/objectSelect/types';
import type { ObjectSelectWorkerRequest, ObjectSelectWorkerResponse } from './objectSelectProtocol';

interface Pending {
  readonly resolve: (result: ObjectSelectResult) => void;
  readonly reject: (error: Error) => void;
  readonly progress?: (stage: ObjectSelectStage, value: number) => void;
}

let nextId = 1;

/** Lazy worker: construction and model loading happen only after explicit UI enablement and a prompt. */
export class ObjectSelectClient implements ObjectSelectionInference {
  private worker: Worker | null = null;
  private readonly pending = new Map<number, Pending>();

  select(cacheKey: string, rgba: Uint8Array, width: number, height: number, prompts: readonly ObjectPrompt[],
    modelUrls: { readonly encoder: string; readonly decoder: string },
    progress?: (stage: ObjectSelectStage, value: number) => void, signal?: AbortSignal): Promise<ObjectSelectResult> {
    if (signal?.aborted) return Promise.reject(abortError());
    const worker = this.ensureWorker(), id = nextId++;
    const request: ObjectSelectWorkerRequest = { op: 'select', id, cacheKey, rgba, width, height, prompts, modelUrls };
    return new Promise((resolve, reject) => {
      const abort = (): void => { this.pending.delete(id); worker.postMessage({ op: 'cancel', id } satisfies ObjectSelectWorkerRequest); reject(abortError()); };
      this.pending.set(id, { resolve: (value) => { signal?.removeEventListener('abort', abort); resolve(value); },
        reject: (error) => { signal?.removeEventListener('abort', abort); reject(error); }, progress });
      signal?.addEventListener('abort', abort, { once: true });
      worker.postMessage(request, [rgba.buffer]);
    });
  }

  destroy(): void { this.worker?.terminate(); this.worker = null; for (const pending of this.pending.values()) pending.reject(abortError()); this.pending.clear(); }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    if (typeof Worker === 'undefined') throw new Error('Object selection requires module Worker support.');
    const worker = new Worker(new URL('./objectSelectWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<ObjectSelectWorkerResponse>) => this.receive(event.data);
    worker.onerror = () => { for (const pending of this.pending.values()) pending.reject(new Error('The object-selection worker stopped unexpectedly.')); this.pending.clear(); this.worker = null; };
    this.worker = worker; return worker;
  }

  private receive(message: ObjectSelectWorkerResponse): void {
    const pending = this.pending.get(message.id); if (!pending) return;
    if (message.type === 'progress') { pending.progress?.(message.stage, message.value); return; }
    this.pending.delete(message.id);
    if (message.type === 'error') pending.reject(new Error(message.error)); else pending.resolve(message.result);
  }
}

function abortError(): Error { return typeof DOMException === 'undefined' ? new Error('Object selection was cancelled.') : new DOMException('Object selection was cancelled.', 'AbortError'); }

export const objectSelectInference = new ObjectSelectClient();
