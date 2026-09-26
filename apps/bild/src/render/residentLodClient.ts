import type { PixelArray } from '../core/pixel/format';
import { Raster } from '../core/raster';
import { rasterFromTransfer } from '../core/transfer';
import type { ResidentLodWorkerRequest, ResidentLodWorkerResponse } from './residentLodWorkerProtocol';

export interface ResidentLodTiming { readonly mainThreadCopyMs: number; readonly workerMs: number; readonly totalMs: number }
export let lastResidentLodTiming: ResidentLodTiming | null = null;
const jobs = new WeakMap<Raster, Promise<Raster>>();

const yieldTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Copies at most 2 MiB per task; all averaging/premultiplication runs in the module worker. */
export function buildResidentLodInBackground(source: Raster): Promise<Raster> | null {
  if (typeof Worker === 'undefined') return null;
  const existing = jobs.get(source);
  if (existing) return existing;
  const promise = new Promise<Raster>((resolve, reject) => {
    const worker = new Worker(new URL('./residentLodWorker.ts', import.meta.url), { type: 'module', name: 'resident-lod' });
    const started = performance.now();
    let copyMs = 0;
    worker.onmessage = (event: MessageEvent<ResidentLodWorkerResponse>) => {
      worker.terminate();
      if (!event.data.ok) { reject(new Error(event.data.error)); return; }
      lastResidentLodTiming = { mainThreadCopyMs: copyMs, workerMs: event.data.workerMs, totalMs: performance.now() - started };
      resolve(rasterFromTransfer(event.data.raster));
    };
    worker.onerror = (event) => { worker.terminate(); reject(new Error(event.message || 'Resident LOD worker failed')); };
    worker.postMessage({ type: 'init', width: source.width, height: source.height, channels: source.channels,
      format: source.format, tileCount: source.tiles.length } satisfies ResidentLodWorkerRequest);
    void (async () => {
      const grouped = new Map<PixelArray, number[]>();
      for (let index = 0; index < source.tiles.length; index++) {
        const tile = source.tiles[index];
        if (tile) { const indices = grouped.get(tile); if (indices) indices.push(index); else grouped.set(tile, [index]); }
      }
      let bytes = 0;
      for (const [tile, indices] of grouped) {
        const before = performance.now(), data = tile.slice();
        copyMs += performance.now() - before; bytes += data.byteLength;
        worker.postMessage({ type: 'tile', indices, data } satisfies ResidentLodWorkerRequest, [data.buffer as ArrayBuffer]);
        if (bytes >= 2 * 1024 * 1024) { bytes = 0; await yieldTask(); }
      }
      worker.postMessage({ type: 'finish' } satisfies ResidentLodWorkerRequest);
    })().catch((cause: unknown) => { worker.terminate(); reject(cause); });
  });
  jobs.set(source, promise);
  promise.catch(() => jobs.delete(source));
  return promise;
}
