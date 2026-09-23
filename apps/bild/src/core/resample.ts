import type { Affine, LayerSampling, LayerTransform } from './geometry';
import { concat, invert, pixelToDocument } from './geometry';
import { Raster, TILE, type Channels } from './raster';

/** Premultiplied RGBA8 (or gray) pyramid level; see Rendering/DownsampleCache.swift. */
interface Level { readonly width: number; readonly height: number; readonly channels: Channels; readonly bytes: Uint8Array }

export interface RasterSampler {
  readonly raster: Raster;
  readonly width: number;
  readonly height: number;
  readonly channels: Channels;
  readonly level: number;
  readonly sampling: LayerSampling;
  readonly reduced: Level | null;
}

const pyramids = new WeakMap<Raster, Level[]>();

function sourceByte(raster: Raster, x: number, y: number, channel: number): number {
  const col = Math.floor(x / TILE), row = Math.floor(y / TILE);
  const tile = raster.tiles[row * raster.cols + col];
  if (!tile) return 0;
  return tile[((y - row * TILE) * raster.tileWidth(col) + x - col * TILE) * raster.channels + channel]!;
}

function levelByte(level: Level, x: number, y: number, channel: number): number {
  return level.bytes[(y * level.width + x) * level.channels + channel]!;
}

function byteAt(sampler: RasterSampler, x: number, y: number, channel: number): number {
  const xx = Math.min(sampler.width - 1, Math.max(0, x));
  const yy = Math.min(sampler.height - 1, Math.max(0, y));
  return sampler.reduced ? levelByte(sampler.reduced, xx, yy, channel) : sourceByte(sampler.raster, xx, yy, channel);
}

function makeHalf(raster: Raster, previous: Level | null): Level {
  const sw = previous?.width ?? raster.width, sh = previous?.height ?? raster.height;
  const channels = raster.channels, width = Math.ceil(sw / 2), height = Math.ceil(sh / 2);
  const bytes = new Uint8Array(width * height * channels);
  const get = (x: number, y: number, c: number): number => {
    if (channels === 1) {
      const xx = Math.min(sw - 1, x), yy = Math.min(sh - 1, y);
      return previous ? levelByte(previous, xx, yy, c) : sourceByte(raster, xx, yy, c);
    }
    if (x >= sw || y >= sh) return 0;
    if (previous) return levelByte(previous, x, y, c);
    const value = sourceByte(raster, x, y, c);
    return c === 3 ? value : Math.round(value * sourceByte(raster, x, y, 3) / 255);
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = x * 2, sy = y * 2, out = (y * width + x) * channels;
      if (channels === 1) {
        bytes[out] = Math.round((get(sx, sy, 0) + get(sx + 1, sy, 0)
          + get(sx, sy + 1, 0) + get(sx + 1, sy + 1, 0)) / 4);
      } else {
        let alpha = 0, red = 0, green = 0, blue = 0;
        for (let oy = 0; oy < 2; oy++) for (let ox = 0; ox < 2; ox++) {
          alpha += get(sx + ox, sy + oy, 3);
          red += get(sx + ox, sy + oy, 0);
          green += get(sx + ox, sy + oy, 1);
          blue += get(sx + ox, sy + oy, 2);
        }
        bytes[out + 3] = Math.round(alpha / 4);
        bytes[out] = Math.round(red / 4); bytes[out + 1] = Math.round(green / 4); bytes[out + 2] = Math.round(blue / 4);
      }
    }
  }
  return { width, height, channels, bytes };
}

/** DownsampleCache.level: at most six sharp halvings, and none from half-size upward. */
export function downsampleLevel(factor: number): number {
  return Number.isFinite(factor) && factor > 0 && factor < 0.5
    ? Math.min(6, Math.floor(Math.log2(1 / factor))) : 0;
}

/** Selects/builds the sharp halving used by LayerRenderer.reduced and DownsampleCache.level. */
export function prepareSampler(raster: Raster, sampling: LayerSampling, drawnWidth: number): RasterSampler {
  const wanted = sampling === 'Nearest' ? 0 : downsampleLevel(drawnWidth / Math.max(1, raster.width));
  if (wanted === 0) return { raster, width: raster.width, height: raster.height, channels: raster.channels,
    level: 0, sampling, reduced: null };
  let levels = pyramids.get(raster);
  if (!levels) { levels = []; pyramids.set(raster, levels); }
  while (levels.length < wanted) levels.push(makeHalf(raster, levels.at(-1) ?? null));
  const reduced = levels[wanted - 1]!;
  return { raster, width: reduced.width, height: reduced.height, channels: raster.channels,
    level: wanted, sampling, reduced };
}

/** Samples colour as premultiplied sRGB floats. */
export function sampleRgba(sampler: RasterSampler, x: number, y: number, out: Float32Array): void {
  const scale = 2 ** sampler.level, rx = x / scale, ry = y / scale;
  if (sampler.sampling === 'Nearest') {
    const ix = Math.floor(rx), iy = Math.floor(ry), a = byteAt(sampler, ix, iy, 3) / 255;
    out[3] = a;
    out[0] = byteAt(sampler, ix, iy, 0) / 255 * a;
    out[1] = byteAt(sampler, ix, iy, 1) / 255 * a;
    out[2] = byteAt(sampler, ix, iy, 2) / 255 * a;
    return;
  }
  const px = rx - 0.5, py = ry - 0.5, x0 = Math.floor(px), y0 = Math.floor(py);
  const fx = px - x0, fy = py - y0;
  out.fill(0);
  for (let oy = 0; oy < 2; oy++) for (let ox = 0; ox < 2; ox++) {
    const weight = (ox ? fx : 1 - fx) * (oy ? fy : 1 - fy);
    const a = byteAt(sampler, x0 + ox, y0 + oy, 3) / 255;
    out[3]! += a * weight;
    const premultiplied = sampler.reduced !== null;
    out[0]! += byteAt(sampler, x0 + ox, y0 + oy, 0) / 255 * (premultiplied ? 1 : a) * weight;
    out[1]! += byteAt(sampler, x0 + ox, y0 + oy, 1) / 255 * (premultiplied ? 1 : a) * weight;
    out[2]! += byteAt(sampler, x0 + ox, y0 + oy, 2) / 255 * (premultiplied ? 1 : a) * weight;
  }
}

export function sampleMask(sampler: RasterSampler, x: number, y: number): number {
  if (sampler.width === 1 && sampler.height === 1) return byteAt(sampler, 0, 0, 0) / 255;
  const scale = 2 ** sampler.level, rx = x / scale, ry = y / scale;
  if (sampler.sampling === 'Nearest') return byteAt(sampler, Math.floor(rx), Math.floor(ry), 0) / 255;
  const px = rx - 0.5, py = ry - 0.5, x0 = Math.floor(px), y0 = Math.floor(py);
  const fx = px - x0, fy = py - y0;
  return (byteAt(sampler, x0, y0, 0) * (1 - fx) * (1 - fy)
    + byteAt(sampler, x0 + 1, y0, 0) * fx * (1 - fy)
    + byteAt(sampler, x0, y0 + 1, 0) * (1 - fx) * fy
    + byteAt(sampler, x0 + 1, y0 + 1, 0) * fx * fy) / 255;
}

export interface PlacementSample {
  readonly x: number;
  readonly y: number;
  readonly coverage: number;
}

export interface PreparedPlacement {
  readonly inverse: Affine;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly width: number;
  readonly height: number;
  readonly nearest: boolean;
}

export function preparePlacement(transform: LayerTransform, gridWidth: number, gridHeight: number,
  documentToOutput?: Affine): PreparedPlacement {
  const map = pixelToDocument(transform, gridWidth, gridHeight);
  const device = documentToOutput ? concat(map, documentToOutput) : map;
  return { inverse: invert(map), scaleX: Math.hypot(device.a, device.b), scaleY: Math.hypot(device.c, device.d),
    width: gridWidth, height: gridHeight, nearest: transform.sampling === 'Nearest' };
}

/** Writes local x, local y and edge coverage without allocating in a pixel loop. */
export function mapPlacement(placement: PreparedPlacement, documentX: number, documentY: number,
  out: Float64Array): void {
  const m = placement.inverse;
  const x = m.a * documentX + m.c * documentY + m.tx;
  const y = m.b * documentX + m.d * documentY + m.ty;
  out[0] = x; out[1] = y;
  if (placement.nearest) {
    out[2] = x >= 0 && x < placement.width && y >= 0 && y < placement.height ? 1 : 0;
    return;
  }
  const cx = Math.min(1, Math.max(0, 0.5 + Math.min(x, placement.width - x) * placement.scaleX));
  const cy = Math.min(1, Math.max(0, 0.5 + Math.min(y, placement.height - y) * placement.scaleY));
  out[2] = cx * cy;
}

/** Inverse placement and LayerRenderer's per-axis one-pixel edge antialias coverage. */
export function placedSample(transform: LayerTransform, gridWidth: number, gridHeight: number,
  documentX: number, documentY: number): PlacementSample {
  const values = new Float64Array(3);
  mapPlacement(preparePlacement(transform, gridWidth, gridHeight), documentX, documentY, values);
  return { x: values[0]!, y: values[1]!, coverage: values[2]! };
}

/** LayerMask.background, using full-resolution edge pixels in this port. */
export function maskBackground(raster: Raster): number {
  let total = 0, count = 0;
  for (let y = 0; y < raster.height; y++) for (let x = 0; x < raster.width; x++) {
    if (y === 0 || y === raster.height - 1 || x === 0 || x === raster.width - 1) {
      total += sourceByte(raster, x, y, 0); count++;
    }
  }
  return total * 2 >= count * 255 ? 1 : 0;
}
