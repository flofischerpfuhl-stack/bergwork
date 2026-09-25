/**
 * Browser image decoding off the UI thread. The encoded input is copied once because the live
 * Raster retains it for lossless project saves; decoded pixels or 256 px tiles come back by transfer,
 * never structured-cloned. HEIC/RAW stay in-thread because their optional host codecs are not
 * transferable capabilities.
 */

import { Raster } from '../core/raster';
import { decodeImageAsset, decodeImageFile, ImageImportError, sniffImage,
  type DecodedImageAsset, type ImageDecodeOptions } from '../io/imageImport';
import type { ImageDecodeWorkerRequest, ImageDecodeWorkerResponse, ImageDecodeWorkerTiming } from './imageDecodeProtocol';

export interface BackgroundImageDecodeTiming extends ImageDecodeWorkerTiming {
  readonly mode: 'asset' | 'tiles';
  readonly totalMs: number;
  readonly mainThreadFinalizeMs: number;
  readonly inputBytes: number;
  /** Bytes copied before transfer because the retained encoded source must remain live. */
  readonly copiedInputBytes: number;
}

const recentTimings: BackgroundImageDecodeTiming[] = [];
export function backgroundImageDecodeTimings(): readonly BackgroundImageDecodeTiming[] { return [...recentTimings]; }
export function clearBackgroundImageDecodeTimings(): void { recentTimings.length = 0; }

interface Pending {
  readonly resolve: (response: Extract<ImageDecodeWorkerResponse, { ok: true }>) => void;
  readonly reject: (error: Error) => void;
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function ensureWorker(): Worker | null {
  if (worker) return worker;
  if (typeof Worker === 'undefined') return null;
  try {
    const created = new Worker(new URL('./imageDecodeWorker.ts', import.meta.url), { type: 'module' });
    created.onmessage = (event: MessageEvent<ImageDecodeWorkerResponse>) => {
      const job = pending.get(event.data.id);
      if (!job) return;
      pending.delete(event.data.id);
      if (event.data.ok) job.resolve(event.data);
      else job.reject(new ImageImportError(event.data.code ?? 'unreadable', event.data.error));
    };
    created.onerror = () => {
      for (const job of pending.values()) job.reject(new Error('The background image decoder stopped unexpectedly.'));
      pending.clear(); worker = null; created.terminate();
    };
    worker = created;
    return worker;
  } catch { return null; }
}

function workerSafe(bytes: Uint8Array, options: ImageDecodeOptions): boolean {
  const kind = sniffImage(bytes);
  return !!kind && kind !== 'image/heic' && kind !== 'image/x-adobe-dng'
    && options.nativeDecoder === undefined && !options.raw;
}

function send(mode: 'asset' | 'tiles', bytes: Uint8Array, remainingPixels: number,
  options: ImageDecodeOptions): Promise<Extract<ImageDecodeWorkerResponse, { ok: true }>> | null {
  if (!workerSafe(bytes, options)) return null;
  const target = ensureWorker();
  if (!target) return null;
  const id = nextId++, owned = bytes.slice();
  const request: ImageDecodeWorkerRequest = { id, mode, bytes: owned, remainingPixels,
    maxSide: options.maxSide ?? 30_000 };
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    target.postMessage(request, [owned.buffer]);
  });
}

function remember(mode: 'asset' | 'tiles', started: number, inputBytes: number, workerTiming: ImageDecodeWorkerTiming,
  finalizeStart: number): void {
  recentTimings.push({ ...workerTiming, mode, inputBytes, copiedInputBytes: inputBytes,
    mainThreadFinalizeMs: performance.now() - finalizeStart, totalMs: performance.now() - started });
  if (recentTimings.length > 32) recentTimings.shift();
}

export async function decodeImageAssetInBackground(bytes: Uint8Array, remainingPixels: number,
  options: ImageDecodeOptions = {}): Promise<DecodedImageAsset> {
  const started = performance.now();
  const result = send('asset', bytes, remainingPixels, options);
  if (!result) return decodeImageAsset(bytes, remainingPixels, options);
  const response = await result;
  if (response.mode !== 'asset') throw new Error('Image decoder returned the wrong result kind.');
  const finalizeStart = performance.now();
  const decoded: DecodedImageAsset = { width: response.width, height: response.height, channels: 4,
    data: response.data, bitDepth: response.bitDepth, mime: response.mime };
  remember('asset', started, bytes.byteLength, response.timing, finalizeStart);
  return decoded;
}

export async function decodeImageFileInBackground(bytes: Uint8Array, remainingPixels: number,
  options: ImageDecodeOptions = {}): Promise<Raster> {
  const started = performance.now();
  const result = send('tiles', bytes, remainingPixels, options);
  if (!result) return decodeImageFile(bytes, remainingPixels, options);
  const response = await result;
  if (response.mode !== 'tiles') throw new Error('Image decoder returned the wrong result kind.');
  const finalizeStart = performance.now();
  const raster = new Raster(response.width, response.height, 4, response.tiles,
    { format: response.format, source: { bytes, mime: response.mime, sha256: response.sha256 } });
  remember('tiles', started, bytes.byteLength, response.timing, finalizeStart);
  return raster;
}
