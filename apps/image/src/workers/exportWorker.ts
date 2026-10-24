/// <reference lib="webworker" />
/**
 * Export encoding off the main thread: whole-file encodes (all formats) and PNG bands for the
 * parallel PNG path (PRODUCT-PLAN A6 export budget). Codecs load lazily inside the worker.
 */
import { encodePixels, pngCompressBandAsync, type EncodeSpec } from '../io/exportEncode';

export type ExportWorkerRequest =
  | { readonly id: number; readonly type: 'encode'; readonly pixels: Uint8Array | Uint16Array; readonly width: number;
      readonly height: number; readonly spec: EncodeSpec }
  | { readonly id: number; readonly type: 'png-band'; readonly pixels: Uint8Array | Uint16Array; readonly width: number;
      readonly from: number; readonly to: number; readonly channels: 3 | 4; readonly level: EncodeSpec['level']; readonly final: boolean };

export type ExportWorkerResponse =
  | { readonly id: number; readonly ok: true; readonly bytes: Uint8Array; readonly adler?: number; readonly length?: number }
  | { readonly id: number; readonly ok: false; readonly error: string };

const scope = self as unknown as Worker;

self.onmessage = async (event: MessageEvent<ExportWorkerRequest>) => {
  const message = event.data;
  try {
    if (message.type === 'encode') {
      const bytes = await encodePixels(message.pixels, message.width, message.height, message.spec);
      scope.postMessage({ id: message.id, ok: true, bytes } satisfies ExportWorkerResponse, [bytes.buffer]);
    } else {
      const band = await pngCompressBandAsync(message.pixels, message.width, message.from, message.to, message.channels, message.level, message.final);
      scope.postMessage({ id: message.id, ok: true, bytes: band.chunk, adler: band.adler, length: band.length } satisfies ExportWorkerResponse,
        [band.chunk.buffer]);
    }
  } catch (error) {
    scope.postMessage({ id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) } satisfies ExportWorkerResponse);
  }
};
