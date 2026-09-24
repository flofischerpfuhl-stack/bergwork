/**
 * Runs export encoders in workers with cancellation: aborting terminates the workers doing the job.
 * Large PNGs are split into row bands that are filtered and deflated in parallel and stitched into one
 * zlib stream (sync-flushed deflate blocks, combined Adler-32); other formats use one worker.
 * Without Worker support (Node tests), encoding runs in-thread.
 */

import type { EncodeSpec } from '../io/exportEncode';
import type { ExportEncoder } from '../io/exportPipeline';
import type { ExportWorkerRequest, ExportWorkerResponse } from './exportWorker';

type Success = Extract<ExportWorkerResponse, { ok: true }>;

const idle: Worker[] = [];
const MAX_IDLE = 8;
let nextId = 1;
/** PNGs from this many pixels up are encoded band-parallel. */
export const PARALLEL_PNG_PIXELS = 1_000_000;

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new DOMException('The export was cancelled.', 'AbortError');
}

function acquire(): Worker {
  return idle.pop() ?? new Worker(new URL('./exportWorker.ts', import.meta.url), { type: 'module' });
}

function release(worker: Worker): void {
  if (idle.length < MAX_IDLE) idle.push(worker); else worker.terminate();
}

function transferable(pixels: Uint8Array | Uint16Array): Uint8Array | Uint16Array {
  return pixels.byteOffset === 0 && pixels.byteLength === pixels.buffer.byteLength && pixels.buffer instanceof ArrayBuffer ? pixels : pixels.slice();
}

function run(message: ExportWorkerRequest, signal?: AbortSignal): Promise<Success> {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  const worker = acquire();
  return new Promise((resolve, reject) => {
    const cleanup = () => { worker.onmessage = null; worker.onerror = null; signal?.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); worker.terminate(); reject(abortError(signal)); };
    worker.onmessage = (event: MessageEvent<ExportWorkerResponse>) => {
      cleanup(); release(worker);
      if (event.data.ok) resolve(event.data); else reject(new Error(event.data.error));
    };
    worker.onerror = (event) => { cleanup(); worker.terminate(); reject(new Error(event.message || 'The export worker stopped unexpectedly.')); };
    signal?.addEventListener('abort', abort, { once: true });
    worker.postMessage(message, [message.pixels.buffer as ArrayBuffer]);
  });
}

async function encodePngParallel(pixels: Uint8Array | Uint16Array, width: number, height: number, spec: EncodeSpec,
  signal?: AbortSignal): Promise<Uint8Array> {
  const threads = Math.min(8, Math.max(2, (globalThis.navigator?.hardwareConcurrency ?? 4) - 1));
  const rowsPerBand = Math.ceil(height / Math.min(threads, Math.ceil(height / 64)));
  const channels = spec.alpha ? 4 : 3;
  // One controller for the job: a failed band or the caller's abort stops every band.
  const job = new AbortController();
  const forward = () => job.abort(abortError(signal));
  signal?.addEventListener('abort', forward, { once: true });
  try {
    const tasks: Promise<Success>[] = [];
    for (let from = 0; from < height; from += rowsPerBand) {
      const to = Math.min(height, from + rowsPerBand), start = Math.max(0, from - 1);
      const slice = pixels.slice(start * width * 4, to * width * 4);
      const task = run({ id: nextId++, type: 'png-band', pixels: slice, width, from: from - start, to: to - start, channels,
        level: spec.level, final: to === height }, job.signal);
      task.catch((error: unknown) => job.abort(error));
      tasks.push(task);
    }
    const bands = await Promise.all(tasks);
    const { assemblePng, pngHeader } = await import('../io/exportEncode');
    return assemblePng(pngHeader(width, height, pixels instanceof Uint16Array ? 16 : 8, spec),
      bands.map((band) => ({ chunk: band.bytes, adler: band.adler!, length: band.length! })));
  } finally { signal?.removeEventListener('abort', forward); }
}

/** In-thread encoder (no workers). */
export const inThreadExportEncoder: ExportEncoder = {
  async encode(pixels, width, height, spec, signal) {
    if (signal?.aborted) throw abortError(signal);
    const { encodePixels } = await import('../io/exportEncode');
    return encodePixels(pixels, width, height, spec);
  },
};

/** Worker encoder; the pixel buffer is transferred to the worker (callers must not reuse it). */
export const workerExportEncoder: ExportEncoder = {
  async encode(pixels, width, height, spec, signal) {
    if (spec.format === 'png' && width * height >= PARALLEL_PNG_PIXELS && height >= 128) {
      return encodePngParallel(pixels, width, height, spec, signal);
    }
    const result = await run({ id: nextId++, type: 'encode', pixels: transferable(pixels), width, height, spec }, signal);
    return result.bytes;
  },
};

export function defaultExportEncoder(): ExportEncoder {
  return typeof Worker === 'undefined' ? inThreadExportEncoder : workerExportEncoder;
}
