/** CPU raster resampling used by Image Size and Distort. */

import type { Affine } from './geometry';
import { Raster, TILE, type Channels } from './raster';
import type { LayerSampling } from './geometry';

interface AxisWeights {
  readonly offsets: Int32Array;
  readonly indices: Int32Array;
  readonly weights: Float32Array;
}

function sinc(x: number): number {
  if (Math.abs(x) < 1e-7) return 1;
  const p = Math.PI * x;
  return Math.sin(p) / p;
}

function lanczos(x: number): number {
  const ax = Math.abs(x);
  return ax < 3 ? sinc(x) * sinc(x / 3) : 0;
}

function axisWeights(source: number, target: number): AxisWeights {
  const scale = target / source;
  const supportScale = Math.max(1, 1 / scale);
  const support = 3 * supportScale;
  const offsets = new Int32Array(target + 1);
  const indices: number[] = [];
  const weights: number[] = [];
  for (let out = 0; out < target; out++) {
    offsets[out] = indices.length;
    const position = (out + 0.5) / scale - 0.5;
    const first = Math.ceil(position - support);
    const last = Math.floor(position + support);
    let total = 0;
    const start = weights.length;
    for (let sample = first; sample <= last; sample++) {
      const weight = lanczos((position - sample) / supportScale);
      if (weight === 0) continue;
      indices.push(sample);
      weights.push(weight);
      total += weight;
    }
    if (Math.abs(total) > 1e-12) {
      for (let i = start; i < weights.length; i++) weights[i] = weights[i]! / total;
    }
  }
  offsets[target] = indices.length;
  return { offsets, indices: Int32Array.from(indices), weights: Float32Array.from(weights) };
}

function makeTile(width: number, height: number, channels: Channels): Uint8Array {
  return new Uint8Array(width * height * channels);
}

function nonzero(data: Uint8Array): Uint8Array | null {
  for (let i = 0; i < data.length; i++) if (data[i] !== 0) return data;
  return null;
}

function storePremultiplied(out: Uint8Array, offset: number, channels: Channels,
  c0: number, c1 = 0, c2 = 0, alpha = 255): void {
  if (channels === 1) {
    out[offset] = Math.max(0, Math.min(255, Math.round(c0)));
    return;
  }
  // AdjustPixels.c rgba_clamp_premultiplied: ringing must not put colour above alpha.
  const a = Math.max(0, Math.min(255, alpha));
  const r = Math.max(0, Math.min(a, c0));
  const g = Math.max(0, Math.min(a, c1));
  const b = Math.max(0, Math.min(a, c2));
  const unpremultiply = a > 0 ? 255 / a : 0;
  out[offset] = Math.round(r * unpremultiply);
  out[offset + 1] = Math.round(g * unpremultiply);
  out[offset + 2] = Math.round(b * unpremultiply);
  out[offset + 3] = Math.round(a);
}

/**
 * Separable Lanczos3 scaling. It filters premultiplied RGBA and writes straight RGBA, matching
 * Core Graphics' alpha handling while avoiding a canvas-sized intermediate buffer.
 */
function resizeLanczos(raster: Raster, width: number, height: number): Raster {
  const ch = raster.channels;
  const xWeights = axisWeights(raster.width, width);
  const yWeights = axisWeights(raster.height, height);
  const cols = Math.ceil(width / TILE), rows = Math.ceil(height / TILE);
  const tiles: (Uint8Array | null)[] = new Array(cols * rows).fill(null);

  for (let tileRow = 0; tileRow < rows; tileRow++) {
    const y0 = tileRow * TILE, bandHeight = Math.min(TILE, height - y0);
    const horizontal = new Map<number, Float32Array>();
    for (let y = y0; y < y0 + bandHeight; y++) {
      const begin = yWeights.offsets[y]!, end = yWeights.offsets[y + 1]!;
      for (let tap = begin; tap < end; tap++) {
        const sy = yWeights.indices[tap]!;
        if (horizontal.has(sy)) continue;
        const source = raster.readRegion(0, Math.max(0, Math.min(raster.height - 1, sy)), raster.width, 1);
        const row = new Float32Array(width * ch);
        for (let x = 0; x < width; x++) {
          const xb = xWeights.offsets[x]!, xe = xWeights.offsets[x + 1]!;
          let v0 = 0, v1 = 0, v2 = 0, va = 0;
          for (let xt = xb; xt < xe; xt++) {
            const sx = xWeights.indices[xt]!;
            const w = xWeights.weights[xt]!;
            const p = Math.max(0, Math.min(raster.width - 1, sx)) * ch;
            if (ch === 1) v0 += source[p]! * w;
            else {
              const a = source[p + 3]!;
              const premultiply = a / 255 * w;
              v0 += source[p]! * premultiply;
              v1 += source[p + 1]! * premultiply;
              v2 += source[p + 2]! * premultiply;
              va += a * w;
            }
          }
          const p = x * ch;
          row[p] = v0;
          if (ch === 4) { row[p + 1] = v1; row[p + 2] = v2; row[p + 3] = va; }
        }
        horizontal.set(sy, row);
      }
    }

    const bandTiles: Uint8Array[] = [];
    for (let col = 0; col < cols; col++) bandTiles.push(makeTile(Math.min(TILE, width - col * TILE), bandHeight, ch));
    for (let localY = 0; localY < bandHeight; localY++) {
      const y = y0 + localY;
      const yb = yWeights.offsets[y]!, ye = yWeights.offsets[y + 1]!;
      for (let x = 0; x < width; x++) {
        let v0 = 0, v1 = 0, v2 = 0, va = 0;
        const p = x * ch;
        for (let yt = yb; yt < ye; yt++) {
          const row = horizontal.get(yWeights.indices[yt]!);
          if (!row) continue;
          const w = yWeights.weights[yt]!;
          v0 += row[p]! * w;
          if (ch === 4) { v1 += row[p + 1]! * w; v2 += row[p + 2]! * w; va += row[p + 3]! * w; }
        }
        const col = Math.floor(x / TILE), tw = Math.min(TILE, width - col * TILE);
        const offset = (localY * tw + x - col * TILE) * ch;
        storePremultiplied(bandTiles[col]!, offset, ch, v0, v1, v2, va);
      }
    }
    for (let col = 0; col < cols; col++) tiles[tileRow * cols + col] = nonzero(bandTiles[col]!);
  }
  return new Raster(width, height, ch, tiles);
}

function scalar(raster: Raster, x: number, y: number, channel: number): number {
  if (x < 0 || y < 0 || x >= raster.width || y >= raster.height) return 0;
  const col = Math.floor(x / TILE), row = Math.floor(y / TILE);
  const tile = raster.tiles[row * raster.cols + col];
  if (!tile) return 0;
  const offset = ((y - row * TILE) * raster.tileWidth(col) + x - col * TILE) * raster.channels;
  return tile[offset + channel]!;
}

/** Scales a raster to an exact pixel size. High quality is Lanczos3, the browser substitute for CG `.high`. */
export function resampleRaster(raster: Raster, width: number, height: number,
  sampling: LayerSampling = 'High quality'): Raster {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError(`Invalid raster size ${width}×${height}`);
  }
  if (width === raster.width && height === raster.height) return raster;
  if (sampling === 'High quality') return resizeLanczos(raster, width, height);
  const map: Affine = { a: raster.width / width, b: 0, c: 0, d: raster.height / height, tx: 0, ty: 0 };
  return resampleAffine(raster, width, height, map, sampling);
}

/**
 * Rasterizes through a target-pixel to source-pixel affine. Coordinates are pixel-edge coordinates;
 * the destination pixel centre is mapped before sampling.
 */
export function resampleAffine(raster: Raster, width: number, height: number, targetToSource: Affine,
  sampling: LayerSampling, outside = 0): Raster {
  const ch = raster.channels, cols = Math.ceil(width / TILE), rows = Math.ceil(height / TILE);
  const tiles: (Uint8Array | null)[] = new Array(cols * rows).fill(null);
  const high = sampling === 'High quality';
  const radiusX = high ? 3 * Math.max(1, Math.hypot(targetToSource.a, targetToSource.c)) : 1;
  const radiusY = high ? 3 * Math.max(1, Math.hypot(targetToSource.b, targetToSource.d)) : 1;
  for (let row = 0; row < rows; row++) {
    const th = Math.min(TILE, height - row * TILE);
    for (let col = 0; col < cols; col++) {
      const tw = Math.min(TILE, width - col * TILE);
      const tile = makeTile(tw, th, ch);
      for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
        const gx = col * TILE + x + 0.5, gy = row * TILE + y + 0.5;
        const sx = targetToSource.a * gx + targetToSource.c * gy + targetToSource.tx - 0.5;
        const sy = targetToSource.b * gx + targetToSource.d * gy + targetToSource.ty - 0.5;
        let v0 = 0, v1 = 0, v2 = 0, va = ch === 4 ? 0 : 255;
        if (sampling === 'Nearest') {
          const ix = Math.round(sx), iy = Math.round(sy);
          if (ix < 0 || iy < 0 || ix >= raster.width || iy >= raster.height) v0 = outside;
          else if (ch === 1) v0 = scalar(raster, ix, iy, 0);
          else {
            va = scalar(raster, ix, iy, 3);
            const pm = va / 255;
            v0 = scalar(raster, ix, iy, 0) * pm; v1 = scalar(raster, ix, iy, 1) * pm; v2 = scalar(raster, ix, iy, 2) * pm;
          }
        } else {
          const x0 = high ? Math.ceil(sx - radiusX) : Math.floor(sx);
          const x1 = high ? Math.floor(sx + radiusX) : x0 + 1;
          const y0 = high ? Math.ceil(sy - radiusY) : Math.floor(sy);
          const y1 = high ? Math.floor(sy + radiusY) : y0 + 1;
          let total = 0;
          for (let iy = y0; iy <= y1; iy++) for (let ix = x0; ix <= x1; ix++) {
            const wx = high ? lanczos((sx - ix) / (radiusX / 3)) : 1 - Math.abs(sx - ix);
            const wy = high ? lanczos((sy - iy) / (radiusY / 3)) : 1 - Math.abs(sy - iy);
            const w = wx * wy;
            if (w === 0) continue;
            total += w;
            if (ix < 0 || iy < 0 || ix >= raster.width || iy >= raster.height) { if (ch === 1) v0 += outside * w; continue; }
            if (ch === 1) v0 += scalar(raster, ix, iy, 0) * w;
            else {
              const a = scalar(raster, ix, iy, 3), pm = a / 255 * w;
              v0 += scalar(raster, ix, iy, 0) * pm; v1 += scalar(raster, ix, iy, 1) * pm;
              v2 += scalar(raster, ix, iy, 2) * pm; va += a * w;
            }
          }
          if (Math.abs(total) > 1e-12) { v0 /= total; v1 /= total; v2 /= total; va /= total; }
        }
        storePremultiplied(tile, (y * tw + x) * ch, ch, v0, v1, v2, va);
      }
      tiles[row * cols + col] = nonzero(tile);
    }
  }
  return new Raster(width, height, ch, tiles);
}
