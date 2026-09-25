/** Product PSD I/O. ag-psd, channel conversion, tiling and PSD writing all run in one lazy worker. */
import type { CanvasDocument } from '../core/document';
import {
  readPsdDocumentManaged, writePsdDocument, type PsdReadResult, type PsdWriteOptions, type PsdWriteResult,
} from '../io/psd';
import {
  packPsdValue, psdWireMetrics, psdWireTransfers, unpackPsdValue,
  type PsdWorkerRequest, type PsdWorkerResponse, type PsdWorkerTiming,
} from './psdProtocol';

export interface BackgroundPsdTiming extends PsdWorkerTiming {
  readonly totalMs: number;
  readonly mainThreadMs: number;
  /** Input PSD copy for read, or copied live raster tiles for write. */
  readonly copiedBytes: number;
}

const recentTimings: BackgroundPsdTiming[] = [];
export function backgroundPsdTimings(): readonly BackgroundPsdTiming[] { return [...recentTimings]; }
export function clearBackgroundPsdTimings(): void { recentTimings.length = 0; }

interface Pending {
  readonly resolve: (response: Extract<PsdWorkerResponse, { ok: true }>) => void;
  readonly reject: (error: Error) => void;
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function ensureWorker(): Worker | null {
  if (worker) return worker;
  if (typeof Worker === 'undefined') return null;
  try {
    const created = new Worker(new URL('./psdWorker.ts', import.meta.url), { type: 'module' });
    created.onmessage = (event: MessageEvent<PsdWorkerResponse>) => {
      const job = pending.get(event.data.id);
      if (!job) return;
      pending.delete(event.data.id);
      if (event.data.ok) job.resolve(event.data); else job.reject(new Error(event.data.error));
    };
    created.onerror = () => {
      for (const job of pending.values()) job.reject(new Error('The background PSD worker stopped unexpectedly.'));
      pending.clear(); worker = null; created.terminate();
    };
    worker = created;
    return worker;
  } catch { return null; }
}

function send(request: PsdWorkerRequest, transfers: Transferable[]): Promise<Extract<PsdWorkerResponse, { ok: true }>> | null {
  const target = ensureWorker();
  if (!target) return null;
  return new Promise((resolve, reject) => {
    pending.set(request.id, { resolve, reject });
    target.postMessage(request, transfers);
  });
}

function remember(started: number, mainThreadMs: number, copiedBytes: number, timing: PsdWorkerTiming): void {
  recentTimings.push({ ...timing, copiedBytes, mainThreadMs, totalMs: performance.now() - started });
  if (recentTimings.length > 32) recentTimings.shift();
}

export async function readPsdDocumentInBackground(bytes: Uint8Array): Promise<PsdReadResult> {
  const started = performance.now(), owned = bytes.slice();
  const responsePromise = send({ id: nextId++, type: 'read', bytes: owned }, [owned.buffer]);
  if (!responsePromise) return readPsdDocumentManaged(bytes);
  const response = await responsePromise;
  if (response.type !== 'read') throw new Error('PSD worker returned the wrong result kind.');
  const mainStart = performance.now(), result = unpackPsdValue<PsdReadResult>(response.result);
  remember(started, performance.now() - mainStart, bytes.byteLength, response.timing);
  return result;
}

export async function writePsdDocumentInBackground(document: CanvasDocument,
  options: Omit<PsdWriteOptions, 'hooks'> = {}): Promise<PsdWriteResult> {
  const started = performance.now(), mainStart = performance.now();
  const packed = packPsdValue(document, true), metrics = psdWireMetrics(packed);
  const mainPackMs = performance.now() - mainStart;
  const responsePromise = send({ id: nextId++, type: 'write', document: packed, options }, psdWireTransfers(packed));
  if (!responsePromise) return writePsdDocument(document, options);
  const response = await responsePromise;
  if (response.type !== 'write') throw new Error('PSD worker returned the wrong result kind.');
  const finalizeStart = performance.now();
  const result = { bytes: response.bytes, format: response.format, bitsPerChannel: response.bitsPerChannel,
    notices: response.notices };
  remember(started, mainPackMs + performance.now() - finalizeStart, metrics.tileBytes, response.timing);
  return result;
}
