/// <reference lib="webworker" />

import { TILE } from '../core/raster';
import { decodeImageAsset, ImageImportError } from '../io/imageImport';
import { sha256Hex } from '../io/sha256';
import type { ImageDecodeWorkerRequest, ImageDecodeWorkerResponse } from './imageDecodeProtocol';

const scope = self as unknown as DedicatedWorkerGlobalScope;

function tilesFrom(data: Uint8Array | Uint16Array, width: number, height: number): (Uint8Array | Uint16Array | null)[] {
  const cols = Math.ceil(width / TILE), rows = Math.ceil(height / TILE);
  const tiles: (Uint8Array | Uint16Array | null)[] = [];
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
    const tileWidth = Math.min(TILE, width - col * TILE), tileHeight = Math.min(TILE, height - row * TILE);
    const tile = data instanceof Uint16Array ? new Uint16Array(tileWidth * tileHeight * 4) : new Uint8Array(tileWidth * tileHeight * 4);
    for (let y = 0; y < tileHeight; y++) {
      const source = ((row * TILE + y) * width + col * TILE) * 4;
      tile.set(data.subarray(source, source + tileWidth * 4), y * tileWidth * 4);
    }
    // Preserve the sparse-tile invariant for completely transparent/zero imports without making
    // the common non-zero path pay a per-sample JS copy on the UI thread.
    tiles.push(tile.some((value) => value !== 0) ? tile : null);
  }
  return tiles;
}

scope.onmessage = (event: MessageEvent<ImageDecodeWorkerRequest>) => {
  void run(event.data);
};

async function run(request: ImageDecodeWorkerRequest): Promise<void> {
  try {
    const decodeStart = performance.now();
    const decoded = await decodeImageAsset(request.bytes, request.remainingPixels, { maxSide: request.maxSide });
    const decodeMs = performance.now() - decodeStart;
    if (request.mode === 'asset') {
      const response: ImageDecodeWorkerResponse = { id: request.id, ok: true, mode: 'asset', width: decoded.width,
        height: decoded.height, bitDepth: decoded.bitDepth, mime: decoded.mime, data: decoded.data,
        timing: { decodeMs, tileMs: 0, decodedBytes: decoded.data.byteLength, tileBytes: 0 } };
      scope.postMessage(response, [decoded.data.buffer as ArrayBuffer]);
      return;
    }
    const tileStart = performance.now();
    const tiles = tilesFrom(decoded.data, decoded.width, decoded.height);
    const tileMs = performance.now() - tileStart;
    const sha256 = sha256Hex(request.bytes);
    const tileBytes = tiles.reduce((sum, tile) => sum + (tile?.byteLength ?? 0), 0);
    const response: ImageDecodeWorkerResponse = { id: request.id, ok: true, mode: 'tiles', width: decoded.width,
      height: decoded.height, format: decoded.bitDepth === 16 ? 'rgba16' : 'rgba8', mime: decoded.mime, sha256, tiles,
      timing: { decodeMs, tileMs, decodedBytes: decoded.data.byteLength, tileBytes } };
    scope.postMessage(response, tiles.flatMap((tile) => tile ? [tile.buffer as ArrayBuffer] : []));
  } catch (error) {
    const response: ImageDecodeWorkerResponse = { id: request.id, ok: false,
      ...(error instanceof ImageImportError ? { code: error.code } : {}),
      error: error instanceof Error ? error.message : String(error) };
    scope.postMessage(response);
  }
}
