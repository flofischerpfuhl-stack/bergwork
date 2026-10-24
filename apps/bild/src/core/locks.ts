import type { CanvasDocument, Layer, LayerLocks } from './document';
import { concat, invert, pixelToDocument, type LayerTransform } from './geometry';
import { Raster, TILE } from './raster';
import { makePixelArray, type PixelArray } from './pixel/format';

export type LayerEditKind = 'pixels' | 'position' | 'appearance';
export type LayerLockBlockerCode = 'layer-lock-all' | 'layer-lock-pixels' | 'layer-lock-position';

export interface LayerLockBlocker {
  readonly code: LayerLockBlockerCode;
  readonly message: string;
  readonly layerId: string;
  readonly sourceLayerId: string;
}

const UNLOCKED: LayerLocks = { transparency: false, pixels: false, position: false, all: false };

/** Photoshop-style effective locks: a locked folder protects every descendant. */
export function effectiveLayerLocks(document: CanvasDocument, id: string): LayerLocks {
  const byId = new Map(document.layers.map((layer) => [layer.id, layer]));
  let layer = byId.get(id), depth = 0;
  let transparency = false, pixels = false, position = false, all = false;
  while (layer && depth++ < 65) {
    all ||= layer.locks.all;
    transparency ||= layer.locks.transparency;
    pixels ||= layer.locks.pixels;
    position ||= layer.locks.position;
    layer = layer.parentId ? byId.get(layer.parentId) : undefined;
  }
  return all ? { transparency: true, pixels: true, position: true, all: true }
    : { transparency, pixels, position, all: false };
}

/** Returns a stable machine code and translatable English fallback for a prohibited edit. */
export function layerLockBlocker(document: CanvasDocument, id: string, kind: LayerEditKind): LayerLockBlocker | null {
  const byId = new Map(document.layers.map((layer) => [layer.id, layer]));
  let layer = byId.get(id), depth = 0;
  while (layer && depth++ < 65) {
    const locks = layer.locks;
    if (locks.all) return blocker('layer-lock-all', 'The layer is fully locked.', id, layer.id);
    if (kind === 'pixels' && locks.pixels) {
      return blocker('layer-lock-pixels', 'The layer pixels are locked.', id, layer.id);
    }
    if (kind === 'position' && locks.position) {
      return blocker('layer-lock-position', 'The layer position is locked.', id, layer.id);
    }
    layer = layer.parentId ? byId.get(layer.parentId) : undefined;
  }
  return null;
}

function blocker(code: LayerLockBlockerCode, message: string, layerId: string, sourceLayerId: string): LayerLockBlocker {
  return { code, message, layerId, sourceLayerId };
}

export function layerLocks(layer: Layer | null | undefined): LayerLocks { return layer?.locks ?? UNLOCKED; }

/**
 * Lock Transparency keeps the pre-edit alpha in document space. The common unchanged-grid path
 * copies only tiles whose alpha was altered; expanded brush/filter grids sample the old alpha at
 * the corresponding pixel centre and remain transparent outside the old layer.
 */
export function preserveLayerTransparency(before: Raster, beforeTransform: LayerTransform,
  after: Raster, afterTransform: LayerTransform): Raster {
  if (before.channels !== 4 || after.channels !== 4) return after;
  const direct = before.width === after.width && before.height === after.height
    && beforeTransform === afterTransform;
  const mapping = direct ? null
    : concat(pixelToDocument(afterTransform, after.width, after.height),
      invert(pixelToDocument(beforeTransform, before.width, before.height)));
  const tiles = after.tiles.slice();
  let changed = false;
  for (let row = 0; row < after.rows; row++) for (let col = 0; col < after.cols; col++) {
    const index = row * after.cols + col;
    const tw = after.tileWidth(col), th = after.tileHeight(row);
    const current = after.tiles[index];
    let output: PixelArray | null = null;
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
      const gx = col * TILE + x, gy = row * TILE + y;
      let sx = gx, sy = gy;
      if (mapping) {
        sx = Math.floor(mapping.a * (gx + 0.5) + mapping.c * (gy + 0.5) + mapping.tx);
        sy = Math.floor(mapping.b * (gx + 0.5) + mapping.d * (gy + 0.5) + mapping.ty);
      }
      const alpha = sampleAlpha(before, sx, sy);
      const offset = (y * tw + x) * 4;
      const present = current?.[offset + 3] ?? 0;
      if (present === alpha) continue;
      if (!output) output = current ? current.slice() : makePixelArray(after.format, tw * th * 4);
      output[offset + 3] = alpha;
      if (alpha === 0) { output[offset] = 0; output[offset + 1] = 0; output[offset + 2] = 0; }
    }
    if (output) { tiles[index] = nonzero(output) ? output : null; changed = true; }
  }
  return changed ? new Raster(after.width, after.height, 4, tiles, { format: after.format }) : after;
}

function sampleAlpha(raster: Raster, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= raster.width || y >= raster.height) return 0;
  const col = Math.floor(x / TILE), row = Math.floor(y / TILE), tile = raster.tiles[row * raster.cols + col];
  if (!tile) return 0;
  return tile[((y - row * TILE) * raster.tileWidth(col) + x - col * TILE) * 4 + 3]!;
}

function nonzero(values: PixelArray): boolean {
  for (let index = 0; index < values.length; index++) if (values[index]) return true;
  return false;
}
