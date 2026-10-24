/// <reference lib="webworker" />
import { makePixelArray, type PixelArray, type RasterFormat } from '../core/pixel/format';
import { Raster, TILE, type Channels } from '../core/raster';
import { rasterToTransfer } from '../core/transfer';
import type { ResidentLodWorkerRequest, ResidentLodWorkerResponse } from './residentLodWorkerProtocol';

const scope = self as unknown as Worker;
let metadata: { width: number; height: number; channels: Channels; format: RasterFormat } | null = null;
let tiles: (PixelArray | null)[] = [];
let started = 0;

function halveRgba(source: PixelArray, width: number, height: number, format: RasterFormat,
  maximum: number, premultiplied: boolean): PixelArray {
  const nw = Math.ceil(width / 2), nh = Math.ceil(height / 2), next = makePixelArray(format, nw * nh * 4);
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
    const target = (y * nw + x) * 4;
    for (let channel = 0; channel < 4; channel++) {
      let sum = 0;
      for (let oy = 0; oy < 2; oy++) for (let ox = 0; ox < 2; ox++) {
        const sx = x * 2 + ox, sy = y * 2 + oy;
        if (sx >= width || sy >= height) continue;
        const at = (sy * width + sx) * 4;
        sum += !premultiplied && channel < 3
          ? Math.round(source[at + channel]! * source[at + 3]! / maximum) : source[at + channel]!;
      }
      next[target + channel] = Math.round(sum / 4);
    }
  }
  return next;
}

function halveMask(source: PixelArray, width: number, height: number): Uint8Array {
  const nw = Math.ceil(width / 2), nh = Math.ceil(height / 2), next = new Uint8Array(nw * nh);
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
    let sum = 0;
    for (let oy = 0; oy < 2; oy++) for (let ox = 0; ox < 2; ox++) {
      const sx = x * 2 + ox, sy = y * 2 + oy;
      if (sx < width && sy < height) sum += source[sy * width + sx]!;
    }
    next[y * nw + x] = Math.round(sum / 4);
  }
  return next;
}

function opaque(tile: PixelArray, maximum: number): boolean {
  for (let index = 3; index < tile.length; index += 4) if (tile[index] !== maximum) return false;
  return true;
}

function build(source: Raster): Raster {
  const factor = 8, width = Math.ceil(source.width / factor), height = Math.ceil(source.height / factor);
  const cols = Math.ceil(width / TILE), output: (PixelArray | null)[] = new Array(cols * Math.ceil(height / TILE)).fill(null);
  const destination = (col: number, row: number): PixelArray => {
    const index = row * cols + col;
    return output[index] ??= makePixelArray(source.format,
      Math.min(TILE, width - col * TILE) * Math.min(TILE, height - row * TILE) * source.channels);
  };
  for (let sr = 0; sr < source.rows; sr++) for (let sc = 0; sc < source.cols; sc++) {
    const tile = source.tiles[sr * source.cols + sc];
    if (!tile) continue;
    let current = tile, tw = source.tileWidth(sc), th = source.tileHeight(sr);
    let premultiplied = source.channels === 4 && opaque(tile, source.maximum);
    for (let step = 0; step < 3; step++) {
      current = source.channels === 4 ? halveRgba(current, tw, th, source.format, source.maximum, premultiplied)
        : halveMask(current, tw, th);
      tw = Math.ceil(tw / 2); th = Math.ceil(th / 2); premultiplied = true;
    }
    const originX = sc * (TILE / factor), originY = sr * (TILE / factor);
    for (let row = 0; row < th; row++) {
      const y = originY + row, dc = Math.floor(originX / TILE), dr = Math.floor(y / TILE);
      const localX = originX - dc * TILE, localY = y - dr * TILE, target = destination(dc, dr);
      const targetWidth = Math.min(TILE, width - dc * TILE);
      target.set(current.subarray(row * tw * source.channels, (row + 1) * tw * source.channels),
        (localY * targetWidth + localX) * source.channels);
    }
  }
  return new Raster(width, height, source.channels, output, { format: source.format });
}

self.onmessage = (event: MessageEvent<ResidentLodWorkerRequest>) => {
  try {
    const request = event.data;
    if (request.type === 'init') {
      metadata = request; tiles = new Array(request.tileCount).fill(null); started = performance.now(); return;
    }
    if (request.type === 'tile') {
      for (const index of request.indices) tiles[index] = request.data;
      return;
    }
    if (!metadata) throw new Error('Resident LOD worker was not initialized');
    const raster = rasterToTransfer(build(new Raster(metadata.width, metadata.height, metadata.channels, tiles, { format: metadata.format })));
    const transfers: Transferable[] = [];
    raster.tiles = raster.tiles.map((tile) => {
      if (!tile) return null;
      const owned = tile.byteOffset === 0 && tile.byteLength === tile.buffer.byteLength ? tile : tile.slice();
      transfers.push(owned.buffer as ArrayBuffer); return owned;
    });
    scope.postMessage({ ok: true, raster, workerMs: performance.now() - started } satisfies ResidentLodWorkerResponse, transfers);
    metadata = null; tiles = [];
  } catch (cause) {
    scope.postMessage({ ok: false, error: cause instanceof Error ? cause.message : String(cause) } satisfies ResidentLodWorkerResponse);
  }
};
