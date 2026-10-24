import type { BackgroundSettings } from '../core/subject/maskProcessing';
import type { SubjectModel } from '../core/subject/models';
import type { SubjectStage, SubjectTiming, SubjectWorkerRequest, SubjectWorkerResponse } from './subjectProtocol';

export interface SubjectInferenceResult {
  readonly mask: Uint8Array;
  readonly timing: SubjectTiming;
  readonly componentCount: number;
}
export interface SubjectProgress {
  readonly stage: SubjectStage;
  readonly progress: number;
  readonly downloadedBytes?: number;
  readonly totalBytes?: number | null;
}

export class SubjectInferenceError extends Error {
  constructor(message: string) { super(message); this.name = 'SubjectInferenceError'; }
}

interface Pending {
  readonly resolve: (value: SubjectInferenceResult) => void;
  readonly reject: (error: Error) => void;
  readonly progress?: (value: SubjectProgress) => void;
}

let nextId = 1;

/** One module worker owns the lazy model session and its most recent full-size raw masks. */
export class SubjectInferenceClient {
  private worker: Worker | null = null;
  private readonly pending = new Map<number, Pending>();

  infer(cacheKey: string, rgba: Uint8Array, width: number, height: number, settings: BackgroundSettings,
    refinementLimit: number, model: SubjectModel,
    resolvedModel: { readonly bytes: Uint8Array; readonly cacheHit: boolean; readonly resolveMs: number },
    progress?: (value: SubjectProgress) => void, signal?: AbortSignal): Promise<SubjectInferenceResult> {
    // Ownership moves to the worker. Callers use a fresh Raster.toPixels() copy, avoiding a second
    // contiguous allocation for a 100 Mpx layer.
    const request: SubjectWorkerRequest = { op: 'infer', id: nextId++, cacheKey, model,
      modelBytes: resolvedModel.bytes, modelCacheHit: resolvedModel.cacheHit, modelResolveMs: resolvedModel.resolveMs,
      width, height, rgba, settings, refinementLimit };
    return this.send(request, progress, signal, [request.rgba.buffer, request.modelBytes.buffer]);
  }

  refine(cacheKey: string, settings: BackgroundSettings, refinementLimit: number,
    progress?: (value: SubjectProgress) => void, signal?: AbortSignal): Promise<SubjectInferenceResult> {
    return this.send({ op: 'refine', id: nextId++, cacheKey, settings, refinementLimit }, progress, signal);
  }

  cancelAll(): void {
    for (const [id, pending] of this.pending) {
      this.worker?.postMessage({ op: 'cancel', id } satisfies SubjectWorkerRequest);
      pending.reject(abortError());
    }
    this.pending.clear();
  }

  destroy(): void { this.cancelAll(); this.worker?.terminate(); this.worker = null; }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    if (typeof Worker === 'undefined') throw new Error('Background removal requires a browser with module Worker support.');
    const worker = new Worker(new URL('./subjectWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<SubjectWorkerResponse>) => this.receive(event.data);
    worker.onerror = () => {
      for (const pending of this.pending.values()) pending.reject(new Error('The background-removal worker stopped unexpectedly.'));
      this.pending.clear(); this.worker = null;
    };
    this.worker = worker;
    return worker;
  }

  private send(request: Exclude<SubjectWorkerRequest, { op: 'cancel' }>, progress?: (value: SubjectProgress) => void,
    signal?: AbortSignal, transfer: Transferable[] = []): Promise<SubjectInferenceResult> {
    if (signal?.aborted) return Promise.reject(abortError());
    let target: Worker;
    try { target = this.ensureWorker(); } catch (error) { return Promise.reject(error); }
    return new Promise((resolve, reject) => {
      const abort = (): void => {
        this.pending.delete(request.id);
        target.postMessage({ op: 'cancel', id: request.id } satisfies SubjectWorkerRequest);
        reject(abortError());
      };
      this.pending.set(request.id, {
        resolve: (value) => { signal?.removeEventListener('abort', abort); resolve(value); },
        reject: (error) => { signal?.removeEventListener('abort', abort); reject(error); }, progress,
      });
      signal?.addEventListener('abort', abort, { once: true });
      target.postMessage(request, transfer);
    });
  }

  private receive(message: SubjectWorkerResponse): void {
    const pending = this.pending.get(message.id);
    if (!pending) return; // A cancelled or superseded result is intentionally discarded.
    if (message.type === 'progress') {
      pending.progress?.({ stage: message.stage, progress: message.progress, downloadedBytes: message.downloadedBytes,
        totalBytes: message.totalBytes });
      return;
    }
    this.pending.delete(message.id);
    if (message.type === 'error') pending.reject(new SubjectInferenceError(message.error));
    else pending.resolve({ mask: message.mask, timing: message.timing, componentCount: message.componentCount });
  }
}

function abortError(): Error {
  return typeof DOMException === 'undefined' ? new Error('Background removal was cancelled.')
    : new DOMException('Background removal was cancelled.', 'AbortError');
}

export const subjectInference = new SubjectInferenceClient();
