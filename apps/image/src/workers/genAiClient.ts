import type { ContentFillInference } from '../core/contentFill';
import type { GenAiStage, GenAiWorkerRequest, GenAiWorkerResponse } from './genAiProtocol';

export interface GenAiResult {
  readonly rgba: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly backend: 'webgpu' | 'wasm';
  readonly inferenceMs: number;
}

interface Pending {
  readonly resolve: (result: GenAiResult) => void;
  readonly reject: (error: Error) => void;
  readonly progress?: (stage: GenAiStage, value: number, backend: 'webgpu' | 'wasm') => void;
}

let nextId = 1;

/** Lazy ONNX worker shared by Remove and Upscale. It is not constructed until an already-resolved local model is run. */
export class GenAiClient {
  private worker: Worker | null = null;
  private readonly pending = new Map<number, Pending>();

  inpaint(modelUrl: string, rgba: Uint8Array, mask: Uint8Array, width: number, height: number,
    progress?: Pending['progress'], signal?: AbortSignal): Promise<GenAiResult> {
    return this.start({ op: 'inpaint', id: nextId++, modelUrl, rgba, mask, width, height }, progress, signal);
  }

  upscale(modelUrl: string, rgba: Uint8Array, width: number, height: number, scale: 2 | 4, strength: number,
    progress?: Pending['progress'], signal?: AbortSignal): Promise<GenAiResult> {
    return this.start({ op: 'upscale', id: nextId++, modelUrl, rgba, width, height, scale, strength }, progress, signal);
  }

  contentFill(modelUrl: string, progress?: Pending['progress'], complete?: (result: GenAiResult) => void): ContentFillInference {
    return { run: async (rgba, mask, width, height, signal) => {
      const result = await this.inpaint(modelUrl, rgba, mask, width, height, progress, signal);
      complete?.(result); return result.rgba;
    } };
  }

  destroy(): void {
    this.worker?.terminate(); this.worker = null;
    for (const pending of this.pending.values()) pending.reject(abortError());
    this.pending.clear();
  }

  private start(request: Exclude<GenAiWorkerRequest, { op: 'cancel' }>, progress?: Pending['progress'],
    signal?: AbortSignal): Promise<GenAiResult> {
    if (signal?.aborted) return Promise.reject(abortError());
    const worker = this.ensureWorker(), id = request.id;
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.pending.delete(id); worker.postMessage({ op: 'cancel', id } satisfies GenAiWorkerRequest); reject(abortError());
      };
      this.pending.set(id, { resolve: (value) => { signal?.removeEventListener('abort', abort); resolve(value); },
        reject: (error) => { signal?.removeEventListener('abort', abort); reject(error); }, progress });
      signal?.addEventListener('abort', abort, { once: true });
      const transfers: Transferable[] = [request.rgba.buffer];
      if (request.op === 'inpaint') transfers.push(request.mask.buffer);
      worker.postMessage(request, transfers);
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    if (typeof Worker === 'undefined') throw new Error('Local AI requires module Worker support.');
    const worker = new Worker(new URL('./genAiWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<GenAiWorkerResponse>) => this.receive(event.data);
    worker.onerror = () => {
      for (const pending of this.pending.values()) pending.reject(new Error('The local-AI worker stopped unexpectedly.'));
      this.pending.clear(); this.worker = null;
    };
    this.worker = worker; return worker;
  }

  private receive(message: GenAiWorkerResponse): void {
    const pending = this.pending.get(message.id); if (!pending) return;
    if (message.type === 'progress') { pending.progress?.(message.stage, message.value, message.backend); return; }
    this.pending.delete(message.id);
    if (message.type === 'error') pending.reject(new Error(message.error));
    else pending.resolve(message);
  }
}

function abortError(): Error {
  return typeof DOMException === 'undefined' ? new Error('Local AI was cancelled.') : new DOMException('Local AI was cancelled.', 'AbortError');
}

export const genAiInference = new GenAiClient();
