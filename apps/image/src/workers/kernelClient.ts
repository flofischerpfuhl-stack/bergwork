import { KernelError, loadKernels, type Kernels } from '../wasm/kernels.js';
import {
  invokeKernel,
  type KernelCallMap,
  type KernelMethod,
  type KernelRequest,
  type KernelWorkerOutput,
} from './kernelProtocol';

export type KernelJob<T> = Promise<T> & { readonly id: number };
export type KernelProgress = { readonly id: number; readonly phase: 'start' | 'end' };

export class KernelCancelledError extends Error {
  constructor() { super('Kernel job cancelled'); this.name = 'KernelCancelledError'; }
}

export interface KernelClientOptions {
  /** Defaults to true when the Worker global exists. Set false for the main-thread fallback. */
  readonly useWorker?: boolean;
  readonly onProgress?: (progress: KernelProgress) => void;
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
}

/** Promise-based mirror of Kernels. Worker inputs are cloned, then their cloned buffers are transferred. */
export class KernelClient {
  private readonly worker: Worker | null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;

  constructor(private readonly options: KernelClientOptions = {}) {
    const enabled = options.useWorker ?? typeof Worker !== 'undefined';
    this.worker = enabled && typeof Worker !== 'undefined'
      ? new Worker(new URL('./kernelWorker.ts', import.meta.url), { type: 'module' })
      : null;
    this.worker?.addEventListener('message', (event: MessageEvent<KernelWorkerOutput>) => this.receive(event.data));
  }

  get usesWorker(): boolean { return this.worker !== null; }

  cancel(id: number): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.reject(new KernelCancelledError());
    this.worker?.postMessage({ type: 'cancel', id });
  }

  destroy(): void {
    this.worker?.terminate();
    for (const pending of this.pending.values()) pending.reject(new KernelCancelledError());
    this.pending.clear();
  }

  adjustGradientMap(...args: KernelCallMap['adjustGradientMap']['args']): KernelJob<KernelCallMap['adjustGradientMap']['result']> { return this.request('adjustGradientMap', args); }
  adjustGrain(...args: KernelCallMap['adjustGrain']['args']): KernelJob<KernelCallMap['adjustGrain']['result']> { return this.request('adjustGrain', args); }
  clampPremultiplied(...args: KernelCallMap['clampPremultiplied']['args']): KernelJob<KernelCallMap['clampPremultiplied']['result']> { return this.request('clampPremultiplied', args); }
  brushAlphaBounds(...args: KernelCallMap['brushAlphaBounds']['args']): KernelJob<KernelCallMap['brushAlphaBounds']['result']> { return this.request('brushAlphaBounds', args); }
  layerExtractAlpha(...args: KernelCallMap['layerExtractAlpha']['args']): KernelJob<KernelCallMap['layerExtractAlpha']['result']> { return this.request('layerExtractAlpha', args); }
  layerUnpremultiplyOpaque(...args: KernelCallMap['layerUnpremultiplyOpaque']['args']): KernelJob<KernelCallMap['layerUnpremultiplyOpaque']['result']> { return this.request('layerUnpremultiplyOpaque', args); }
  layerRestoreAlpha(...args: KernelCallMap['layerRestoreAlpha']['args']): KernelJob<KernelCallMap['layerRestoreAlpha']['result']> { return this.request('layerRestoreAlpha', args); }
  contentFill(...args: KernelCallMap['contentFill']['args']): KernelJob<KernelCallMap['contentFill']['result']> { return this.request('contentFill', args); }
  healCoverageBounds(...args: KernelCallMap['healCoverageBounds']['args']): KernelJob<KernelCallMap['healCoverageBounds']['result']> { return this.request('healCoverageBounds', args); }
  spotHeal(...args: KernelCallMap['spotHeal']['args']): KernelJob<KernelCallMap['spotHeal']['result']> { return this.request('spotHeal', args); }
  lensDistort(...args: KernelCallMap['lensDistort']['args']): KernelJob<KernelCallMap['lensDistort']['result']> { return this.request('lensDistort', args); }
  levelsApply(...args: KernelCallMap['levelsApply']['args']): KernelJob<KernelCallMap['levelsApply']['result']> { return this.request('levelsApply', args); }
  levelsHistogram(...args: KernelCallMap['levelsHistogram']['args']): KernelJob<KernelCallMap['levelsHistogram']['result']> { return this.request('levelsHistogram', args); }
  noiseAdd(...args: KernelCallMap['noiseAdd']['args']): KernelJob<KernelCallMap['noiseAdd']['result']> { return this.request('noiseAdd', args); }
  wandMask(...args: KernelCallMap['wandMask']['args']): KernelJob<KernelCallMap['wandMask']['result']> { return this.request('wandMask', args); }
  wandTrace(...args: KernelCallMap['wandTrace']['args']): KernelJob<KernelCallMap['wandTrace']['result']> { return this.request('wandTrace', args); }

  private request<M extends KernelMethod>(method: M, original: KernelCallMap[M]['args']): KernelJob<KernelCallMap[M]['result']> {
    const id = this.nextId++;
    let resolvePromise!: (value: KernelCallMap[M]['result']) => void;
    let rejectPromise!: (reason: unknown) => void;
    const promise = new Promise<KernelCallMap[M]['result']>((resolve, reject) => {
      resolvePromise = resolve; rejectPromise = reject;
    });
    this.pending.set(id, { resolve: value => resolvePromise(value as KernelCallMap[M]['result']), reject: rejectPromise });

    if (this.worker) {
      const copied = cloneArguments(original);
      const request = { type: 'request', id, method, args: copied.args } as unknown as KernelRequest;
      this.worker.postMessage(request, copied.transfer);
    } else {
      const request = { type: 'request', id, method, args: original } as unknown as KernelRequest;
      this.options.onProgress?.({ id, phase: 'start' });
      void loadKernels().then(kernels => invokeKernel(kernels, request)).then(
        result => this.complete(id, result),
        error => this.fail(id, error),
      );
    }
    return Object.assign(promise, { id });
  }

  private receive(message: KernelWorkerOutput): void {
    if (message.type === 'progress') { this.options.onProgress?.(message); return; }
    if (message.type === 'result') { this.complete(message.id, message.result); return; }
    const error = message.error.code === 'memory' || message.error.code === 'no-source' || message.error.code === 'too-detailed'
      ? new KernelError(message.error.code, message.error.message)
      : Object.assign(new Error(message.error.message), { name: message.error.name });
    this.fail(message.id, error);
  }

  private complete(id: number, result: unknown): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (!this.worker) this.options.onProgress?.({ id, phase: 'end' });
    pending.resolve(result);
  }

  private fail(id: number, error: unknown): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.reject(error);
  }
}

/** Explicit main-thread implementation for Node/Vitest or hosts that cannot create module workers. */
export function createMainThreadKernelClient(onProgress?: (progress: KernelProgress) => void): KernelClient {
  return new KernelClient({ useWorker: false, onProgress });
}

function cloneArguments(args: readonly unknown[]): { args: unknown[]; transfer: Transferable[] } {
  const cloned: unknown[] = [];
  const transfer: Transferable[] = [];
  for (const value of args) {
    if (ArrayBuffer.isView(value)) {
      const copy = cloneView(value);
      cloned.push(copy);
      if (copy.buffer instanceof ArrayBuffer) transfer.push(copy.buffer);
    } else cloned.push(value);
  }
  return { args: cloned, transfer };
}

function cloneView(view: ArrayBufferView): ArrayBufferView {
  if (view instanceof Uint8Array) return view.slice();
  if (view instanceof Float32Array) return view.slice();
  if (view instanceof Float64Array) return view.slice();
  if (view instanceof Int32Array) return view.slice();
  return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
}

// Compile-time check that the direct client stays aligned with the loaded synchronous surface.
type _AllMethodsMirrored = Exclude<keyof Kernels, keyof KernelClient> extends never ? true : never;
const allMethodsMirrored: _AllMethodsMirrored = true;
void allMethodsMirrored;
