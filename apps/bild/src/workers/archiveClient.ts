/** Project archives encoded in a worker, with an in-thread fallback where workers are unavailable. */

import type { CanvasDocument } from '../core/document';
import type { Raster } from '../core/raster';
import { documentToTransfer } from '../core/transfer';
import { rememberEncodedAsset, writeArchive } from '../io/project';

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (blob: Blob) => void; reject: (error: Error) => void; rasters: Map<string, Raster> }>();

function ensureWorker(): Worker | null {
  if (worker) return worker;
  if (typeof Worker === 'undefined') return null;
  try {
    worker = new Worker(new URL('./archiveWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<{ id: number; ok: boolean; blob?: Blob; error?: string; assets?: Record<string, { mime: string; sha256: string; bytes: Uint8Array }> }>) => {
      const entry = pending.get(event.data.id);
      pending.delete(event.data.id);
      if (!entry) return;
      if (!event.data.ok || !event.data.blob) { entry.reject(new Error(event.data.error ?? 'The project could not be saved.')); return; }
      for (const [id, asset] of Object.entries(event.data.assets ?? {})) {
        const raster = entry.rasters.get(id);
        if (raster) rememberEncodedAsset(raster, asset);
      }
      entry.resolve(event.data.blob);
    };
    worker.onerror = () => {
      for (const entry of pending.values()) entry.reject(new Error('The background worker stopped unexpectedly.'));
      pending.clear();
      worker = null;
    };
    return worker;
  } catch { return null; }
}

export function encodeArchive(document: CanvasDocument, name: string, activeLayerId: string | null): Promise<Blob> {
  const target = ensureWorker();
  if (!target) return Promise.resolve(writeArchive(document, name, activeLayerId).blob);
  const rasters = new Map<string, Raster>();
  for (const layer of document.layers) {
    if (layer.raster) rasters.set(layer.raster.id, layer.raster);
    if (layer.mask) rasters.set(layer.mask.raster.id, layer.mask.raster);
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, rasters });
    target.postMessage({ id, document: documentToTransfer({ ...document, selection: null }), name, activeLayerId });
  });
}
