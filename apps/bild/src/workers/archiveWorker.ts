/// <reference lib="webworker" />
/**
 * Encodes project archives off the main thread: PNG compression and SHA-256 of every asset take
 * seconds for large documents. Returns the archive and the encoded assets so the main thread can
 * cache them for manifests.
 */
import { documentFromTransfer, type DocumentTransfer } from '../core/transfer';
import { encodedAsset, writeArchive } from '../io/project';

self.onmessage = (event: MessageEvent<{ id: number; document: DocumentTransfer; name: string; activeLayerId: string | null }>) => {
  const { id, name, activeLayerId } = event.data;
  try {
    const document = documentFromTransfer(event.data.document);
    const { blob } = writeArchive(document, name, activeLayerId);
    const assets: Record<string, { mime: string; sha256: string; bytes: Uint8Array }> = {};
    for (const layer of document.layers) {
      for (const raster of [layer.raster, layer.mask?.raster]) {
        if (raster && !raster.source && !assets[raster.id]) assets[raster.id] = encodedAsset(raster);
      }
    }
    (self as unknown as Worker).postMessage({ id, ok: true, blob, assets });
  } catch (error) {
    (self as unknown as Worker).postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
