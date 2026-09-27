/// <reference lib="webworker" />

import { buildPsdColorTransfer, readPsdDocumentManaged, writePsdDocument, type PsdWriteOptions } from '../io/psd';
import {
  packPsdValue, psdWireMetrics, psdWireTransfers, unpackPsdValue,
  type PsdWorkerRequest, type PsdWorkerResponse,
} from './psdProtocol';
import type { CanvasDocument } from '../core/document';

const scope = self as unknown as DedicatedWorkerGlobalScope;
let queue = Promise.resolve();

scope.onmessage = (event: MessageEvent<PsdWorkerRequest>) => {
  queue = queue.then(() => run(event.data), () => run(event.data));
};

async function run(request: PsdWorkerRequest): Promise<void> {
  try {
    if (request.type === 'read') {
      const codecStart = performance.now();
      const result = await readPsdDocumentManaged(request.bytes, { deferColorTransfer: true });
      const codecMs = performance.now() - codecStart, tileStart = performance.now();
      const packed = packPsdValue(result, false), tileMs = performance.now() - tileStart;
      const metrics = psdWireMetrics(packed);
      const response: PsdWorkerResponse = { id: request.id, ok: true, type: 'read', result: packed,
        timing: { operation: 'read', codecMs, tileMs, ...metrics } };
      scope.postMessage(response, psdWireTransfers(packed));
      return;
    }
    if (request.type === 'color-transfer') {
      const result = await buildPsdColorTransfer(request.spec);
      // Keep the immutable cached arrays in this long-lived worker; structured clone copies only ~467 KiB.
      scope.postMessage({ id: request.id, ok: true, type: 'color-transfer', result } satisfies PsdWorkerResponse);
      return;
    }
    const tileStart = performance.now();
    const document = unpackPsdValue<CanvasDocument>(request.document), tileMs = performance.now() - tileStart;
    const codecStart = performance.now();
    const written = writePsdDocument(document, request.options as PsdWriteOptions);
    const codecMs = performance.now() - codecStart, metrics = psdWireMetrics(request.document);
    const response: PsdWorkerResponse = { id: request.id, ok: true, type: 'write', bytes: written.bytes,
      format: written.format, bitsPerChannel: written.bitsPerChannel, notices: written.notices,
      timing: { operation: 'write', codecMs, tileMs, ...metrics } };
    scope.postMessage(response, [written.bytes.buffer as ArrayBuffer]);
  } catch (error) {
    scope.postMessage({ id: request.id, ok: false,
      error: error instanceof Error ? error.message : String(error) } satisfies PsdWorkerResponse);
  }
}
