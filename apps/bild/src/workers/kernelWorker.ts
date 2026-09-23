/// <reference lib="webworker" />

import { KernelError, loadKernels } from '../wasm/kernels.js';
import { invokeKernel, type KernelRequest, type KernelWorkerInput, type KernelWorkerOutput } from './kernelProtocol';

const scope = globalThis as unknown as DedicatedWorkerGlobalScope;
const cancelled = new Set<number>();

function post(message: KernelWorkerOutput, transfer: Transferable[] = []): void {
  scope.postMessage(message, transfer);
}

function transfers(value: unknown): Transferable[] {
  if (ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer) return [value.buffer];
  if (value && typeof value === 'object') {
    const found: Transferable[] = [];
    for (const child of Object.values(value)) found.push(...transfers(child));
    return found;
  }
  return [];
}

async function run(request: KernelRequest): Promise<void> {
  post({ type: 'progress', id: request.id, phase: 'start' });
  try {
    const result = invokeKernel(await loadKernels(), request);
    // C calls are synchronous and cannot be interrupted. The client also discards immediately on cancel,
    // while this check handles cancellation received during async module loading.
    if (!cancelled.has(request.id)) {
      post({ type: 'progress', id: request.id, phase: 'end' });
      post({ type: 'result', id: request.id, result }, transfers(result));
    }
  } catch (cause) {
    if (!cancelled.has(request.id)) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      post({ type: 'error', id: request.id, error: {
        name: error.name,
        message: error.message,
        ...(error instanceof KernelError ? { code: error.code } : {}),
      } });
    }
  } finally { cancelled.delete(request.id); }
}

scope.addEventListener('message', (event: MessageEvent<KernelWorkerInput>) => {
  if (event.data.type === 'cancel') { cancelled.add(event.data.id); return; }
  void run(event.data);
});
