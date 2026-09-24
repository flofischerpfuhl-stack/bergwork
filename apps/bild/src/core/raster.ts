/**
 * Immutable tiled pixel storage.
 *
 * Colour rasters are straight-alpha sRGB RGBA8 or RGBA16. Masks remain single-channel 8-bit
 * coverage (255 reveals, 0 hides); gray16 is deliberately omitted because the document model's
 * masks and selections are defined as 8-bit coverage.
 *
 * Upstream keeps immutable CGImages that history snapshots share, and paints into 256 px tiles
 * (BrushStroke.swift, RasterSnapshot.swift). Here a raster is a grid of 256 px tiles; an edit
 * produces a new raster that shares every untouched tile, so undo retains only changed tiles and
 * the GPU uploads only tiles whose identity changed.
 */

import { uuid } from './ids';
import {
  formatFor, makePixelArray, maximumFor, rgba16To8, type PixelArray, type RasterFormat,
} from './pixel/format';

export const TILE = 256;

export type Channels = 1 | 4;

export class TileNotResidentError extends Error {
  override readonly name = 'TileNotResidentError';
  constructor(readonly tileIndex: number) {
    super(`Raster tile ${tileIndex} is swapped out; call ensureResident() before synchronous pixel access.`);
  }
}

/** The encoded bytes a raster was decoded from, kept while its pixels are unchanged. */
export interface EncodedSource {
  readonly bytes: Uint8Array;
  readonly mime: string;
  readonly sha256: string;
}
export type ArchivedSource = Omit<EncodedSource, 'bytes'>;

/** Storage indirection kept synchronous for existing kernels; swapped stores hydrate before use. */
export interface RasterTileStorage {
  readonly tiles: ReadonlyArray<PixelArray | null>;
  /** Lets lazy stores validate metadata without faulting every tile in during construction. */
  validateFormat?(format: RasterFormat): void;
  residency?(index: number): 'zero' | 'resident' | 'swapped';
}

export interface RasterTileOverlay {
  readonly source: Raster;
  readonly updates: ReadonlyMap<number, PixelArray | null>;
}

class OverlayRasterTileStorage implements RasterTileStorage {
  readonly tiles: ReadonlyArray<PixelArray | null>;
  constructor(readonly overlay: RasterTileOverlay) {
    const target = { length: overlay.source.cols * overlay.source.rows };
    let proxy: ReadonlyArray<PixelArray | null>;
    proxy = new Proxy(target, {
      get: (object, property, receiver) => {
        if (property === Symbol.iterator) return Array.prototype[Symbol.iterator].bind(proxy);
        if (property === 'length') return target.length;
        if (typeof property === 'string' && /^\d+$/.test(property)) {
          const index = Number(property);
          return overlay.updates.has(index) ? overlay.updates.get(index) : overlay.source.tiles[index];
        }
        const method = Reflect.get(Array.prototype, property);
        return typeof method === 'function' ? method.bind(proxy) : Reflect.get(object, property, receiver);
      },
      has: (object, property) => typeof property === 'string' && /^\d+$/.test(property)
        ? Number(property) < target.length : Reflect.has(object, property),
      set: () => { throw new TypeError('Raster tiles are immutable'); },
    }) as unknown as ReadonlyArray<PixelArray | null>;
    this.tiles = proxy;
  }
  validateFormat(format: RasterFormat): void {
    if (format !== this.overlay.source.format) throw new RangeError('Overlay pixel format does not match its source');
  }
  residency(index: number): 'zero' | 'resident' | 'swapped' {
    if (!this.overlay.updates.has(index)) return this.overlay.source.tileResidency(index);
    return this.overlay.updates.get(index) ? 'resident' : 'zero';
  }
}

export class ResidentTileStorage implements RasterTileStorage {
  constructor(readonly tiles: ReadonlyArray<PixelArray | null>) {}
}

let nextSerial = 1;

export class Raster {
  /** Unique per pixel content instance; also the project asset id once saved. */
  readonly id: string;
  readonly serial: number;
  readonly width: number;
  readonly height: number;
  readonly channels: Channels;
  readonly format: RasterFormat;
  readonly maximum: 255 | 65535;
  readonly cols: number;
  readonly rows: number;
  private tileStorage: RasterTileStorage;
  private reducedValue: Raster | null = null;
  /** Row-major sample arrays; null means every sample of the tile is zero. Never mutated after construction. */
  get tiles(): ReadonlyArray<PixelArray | null> { return this.tileStorage.tiles; }
  /** Original encoded bytes, when these pixels are exactly the decoded file. */
  readonly source: EncodedSource | null;
  /** Original archive identity retained when its bytes were decoded directly into scratch tiles. */
  readonly archivedSource: ArchivedSource | null;
  private readonly overlayValue: RasterTileOverlay | null;

  constructor(width: number, height: number, channels: Channels, tiles: ReadonlyArray<PixelArray | null> | RasterTileStorage,
    options: { id?: string; source?: EncodedSource | null; archivedSource?: ArchivedSource | null; format?: RasterFormat;
      overlay?: RasterTileOverlay | null } = {}) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      throw new RangeError(`Invalid raster size ${width}×${height}`);
    }
    this.width = width;
    this.height = height;
    this.channels = channels;
    this.format = formatFor(channels, options.format);
    this.maximum = maximumFor(this.format);
    this.cols = Math.ceil(width / TILE);
    this.rows = Math.ceil(height / TILE);
    this.tileStorage = Array.isArray(tiles) ? new ResidentTileStorage(tiles) : tiles as RasterTileStorage;
    if (this.tiles.length !== this.cols * this.rows) throw new RangeError('Tile count does not match raster size');
    if (this.tileStorage.validateFormat) this.tileStorage.validateFormat(this.format);
    else {
      const sixteen = this.format === 'rgba16';
      for (const tile of this.tiles) {
        if (tile && sixteen !== (tile instanceof Uint16Array)) {
          throw new RangeError(`Pixel format ${this.format} uses the wrong tile array type`);
        }
      }
    }
    this.serial = nextSerial++;
    this.id = options.id ?? uuid();
    this.source = options.source ?? null;
    this.archivedSource = options.archivedSource ?? null;
    this.overlayValue = options.overlay ?? null;
  }

  get tileOverlay(): RasterTileOverlay | null { return this.overlayValue; }

  /** Applies sparse worker results without reading unrelated swapped tiles. */
  withTileUpdates(updates: Iterable<{ readonly index: number; readonly tile: PixelArray | null }>): Raster {
    const base = this.overlayValue?.source ?? this;
    const merged = new Map(this.overlayValue?.updates ?? []);
    for (const update of updates) {
      if (!Number.isInteger(update.index) || update.index < 0 || update.index >= this.cols * this.rows) {
        throw new RangeError('Tile update index is outside the raster');
      }
      if (update.tile && (this.format === 'rgba16') !== (update.tile instanceof Uint16Array)) {
        throw new RangeError(`Tile update type does not match pixel format ${this.format}`);
      }
      merged.set(update.index, update.tile);
    }
    const overlay = { source: base, updates: merged } satisfies RasterTileOverlay;
    return new Raster(this.width, this.height, this.channels, new OverlayRasterTileStorage(overlay),
      { format: this.format, overlay });
  }

  tileWidth(col: number): number { return Math.min(TILE, this.width - col * TILE); }
  tileHeight(row: number): number { return Math.min(TILE, this.height - row * TILE); }

  /** Storage-layer hook. Pixel content and raster identity do not change. */
  adoptTileStorage(storage: RasterTileStorage): void {
    if (storage.tiles.length !== this.cols * this.rows) throw new RangeError('Tile count does not match raster size');
    storage.validateFormat?.(this.format);
    this.tileStorage = storage;
  }

  tileResidency(index: number): 'zero' | 'resident' | 'swapped' {
    if (index < 0 || index >= this.cols * this.rows) throw new RangeError('Tile index is outside the raster');
    return this.tileStorage.residency?.(index) ?? (this.tiles[index] ? 'resident' : 'zero');
  }

  get hasSwappedTiles(): boolean {
    if (!this.tileStorage.residency) return false;
    for (let index = 0; index < this.cols * this.rows; index++) {
      if (this.tileStorage.residency(index) === 'swapped') return true;
    }
    return false;
  }

  hasSwappedTilesIn(rect?: { x: number; y: number; width: number; height: number }): boolean {
    if (!this.tileStorage.residency) return false;
    const left = rect ? Math.max(0, Math.floor(rect.x)) : 0;
    const top = rect ? Math.max(0, Math.floor(rect.y)) : 0;
    const right = rect ? Math.min(this.width, Math.ceil(rect.x + rect.width)) : this.width;
    const bottom = rect ? Math.min(this.height, Math.ceil(rect.y + rect.height)) : this.height;
    if (right <= left || bottom <= top) return false;
    for (let row = Math.floor(top / TILE); row <= Math.floor((bottom - 1) / TILE); row++) {
      for (let col = Math.floor(left / TILE); col <= Math.floor((right - 1) / TILE); col++) {
        if (this.tileStorage.residency(row * this.cols + col) === 'swapped') return true;
      }
    }
    return false;
  }

  /** Always-resident navigation copy. It is populated by the storage layer before first eviction. */
  get reducedCopy(): Raster | null { return this.reducedValue; }
  installReducedCopy(reduced: Raster): void {
    if (reduced.channels !== this.channels) throw new RangeError('Reduced raster channels do not match');
    this.reducedValue = reduced;
  }

  /** Builds the fixed 1/8 navigation LOD tile-wise without materialising the full raster. */
  makeReducedCopy(factor = 8): Raster {
    if (!Number.isInteger(factor) || factor < 2) throw new RangeError('Invalid reduced-raster factor');
    if (this.reducedValue) return this.reducedValue;
    const width = Math.max(1, Math.ceil(this.width / factor));
    const height = Math.max(1, Math.ceil(this.height / factor));
    const data = makePixelArray(this.format, width * height * this.channels);
    const ch = this.channels;
    for (let y = 0; y < height; y++) {
      const sy = Math.min(this.height - 1, y * factor);
      for (let x = 0; x < width; x++) {
        const sx = Math.min(this.width - 1, x * factor);
        const col = Math.floor(sx / TILE), row = Math.floor(sy / TILE);
        const tile = this.tiles[row * this.cols + col];
        if (!tile) continue;
        const source = ((sy - row * TILE) * this.tileWidth(col) + (sx - col * TILE)) * ch;
        const target = (y * width + x) * ch;
        for (let channel = 0; channel < ch; channel++) data[target + channel] = tile[source + channel]!;
      }
    }
    this.reducedValue = Raster.fromPixels(width, height, ch, data, { format: this.format });
    return this.reducedValue;
  }

  static blank(width: number, height: number, channels: Channels,
    options: { format?: RasterFormat } = {}): Raster {
    return new Raster(width, height, channels, new Array(Math.ceil(width / TILE) * Math.ceil(height / TILE)).fill(null), options);
  }

  /** A 1×1 mask, all white (reveal) or black (hide), as LayerMask.solid. */
  static solidMask(revealing: boolean): Raster {
    return new Raster(1, 1, 1, [revealing ? new Uint8Array([255]) : null]);
  }

  /** Builds a raster from contiguous pixels (`width * channels` samples per row). The data is copied. */
  static fromPixels(width: number, height: number, channels: Channels, data: ArrayLike<number>,
    options: { id?: string; source?: EncodedSource | null; format?: RasterFormat } = {}): Raster {
    if (data.length !== width * height * channels) throw new RangeError('Pixel buffer size mismatch');
    const format = formatFor(channels, options.format);
    const cols = Math.ceil(width / TILE), rows = Math.ceil(height / TILE);
    const tiles: (PixelArray | null)[] = [];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const tw = Math.min(TILE, width - col * TILE), th = Math.min(TILE, height - row * TILE);
        const tile = makePixelArray(format, tw * th * channels);
        let any = false;
        for (let y = 0; y < th; y++) {
          const src = ((row * TILE + y) * width + col * TILE) * channels;
          const dst = y * tw * channels;
          for (let i = 0; i < tw * channels; i++) {
            const v = data[src + i]!;
            tile[dst + i] = v;
            if (v) any = true;
          }
        }
        tiles.push(any ? tile : null);
      }
    }
    return new Raster(width, height, channels, tiles, { ...options, format });
  }

  /** Full-precision contiguous copy of a region; pixels outside the raster read as zero. */
  readRegionNative(x: number, y: number, width: number, height: number): PixelArray {
    const ch = this.channels;
    const out = makePixelArray(this.format, width * height * ch);
    const x0 = Math.max(0, x), y0 = Math.max(0, y);
    const x1 = Math.min(this.width, x + width), y1 = Math.min(this.height, y + height);
    if (x1 <= x0 || y1 <= y0) return out;
    for (let row = Math.floor(y0 / TILE); row <= Math.floor((y1 - 1) / TILE); row++) {
      for (let col = Math.floor(x0 / TILE); col <= Math.floor((x1 - 1) / TILE); col++) {
        const tile = this.tiles[row * this.cols + col];
        if (!tile) continue;
        const tw = this.tileWidth(col);
        const tx0 = Math.max(x0, col * TILE), tx1 = Math.min(x1, col * TILE + tw);
        const ty0 = Math.max(y0, row * TILE), ty1 = Math.min(y1, row * TILE + this.tileHeight(row));
        const span = (tx1 - tx0) * ch;
        for (let py = ty0; py < ty1; py++) {
          const src = ((py - row * TILE) * tw + (tx0 - col * TILE)) * ch;
          const dst = ((py - y) * width + (tx0 - x)) * ch;
          out.set(tile.subarray(src, src + span), dst);
        }
      }
    }
    return out;
  }

  /** RGBA8 compatibility view. RGBA16 is rounded, never truncated. */
  readRegion(x: number, y: number, width: number, height: number): Uint8Array {
    const native = this.readRegionNative(x, y, width, height);
    return native instanceof Uint16Array ? rgba16To8(native) : native;
  }

  toPixels(): Uint8Array { return this.readRegion(0, 0, this.width, this.height); }
  toPixelsNative(): PixelArray { return this.readRegionNative(0, 0, this.width, this.height); }

  toPixels16(): Uint16Array {
    const pixels = this.toPixelsNative();
    if (!(pixels instanceof Uint16Array)) throw new RangeError('toPixels16 requires an rgba16 raster');
    return pixels;
  }

  /** Pixel value(s) at integer coordinates; zeros outside. */
  pixel(x: number, y: number): number[] {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return new Array(this.channels).fill(0);
    const col = Math.floor(x / TILE), row = Math.floor(y / TILE);
    const tile = this.tiles[row * this.cols + col];
    if (!tile) return new Array(this.channels).fill(0);
    const offset = ((y - row * TILE) * this.tileWidth(col) + (x - col * TILE)) * this.channels;
    return Array.from(tile.subarray(offset, offset + this.channels));
  }

  /**
   * A new raster with `data` (contiguous, `width * channels` samples per row) written at (x, y).
   * Only the tiles the region touches are copied; all others are shared.
   */
  withRegion(x: number, y: number, width: number, height: number, data: PixelArray): Raster {
    const ch = this.channels;
    if (data.length !== width * height * ch) throw new RangeError('Pixel buffer size mismatch');
    if ((this.format === 'rgba16') !== (data instanceof Uint16Array)) {
      throw new RangeError(`Pixel buffer type does not match raster format ${this.format}`);
    }
    const tiles = this.tiles.slice();
    const x0 = Math.max(0, x), y0 = Math.max(0, y);
    const x1 = Math.min(this.width, x + width), y1 = Math.min(this.height, y + height);
    if (x1 <= x0 || y1 <= y0) return this;
    for (let row = Math.floor(y0 / TILE); row <= Math.floor((y1 - 1) / TILE); row++) {
      for (let col = Math.floor(x0 / TILE); col <= Math.floor((x1 - 1) / TILE); col++) {
        const index = row * this.cols + col;
        const tw = this.tileWidth(col), th = this.tileHeight(row);
        const tile = tiles[index] ? tiles[index]!.slice() : makePixelArray(this.format, tw * th * ch);
        const tx0 = Math.max(x0, col * TILE), tx1 = Math.min(x1, col * TILE + tw);
        const ty0 = Math.max(y0, row * TILE), ty1 = Math.min(y1, row * TILE + th);
        const span = (tx1 - tx0) * ch;
        for (let py = ty0; py < ty1; py++) {
          const dst = ((py - row * TILE) * tw + (tx0 - col * TILE)) * ch;
          const src = ((py - y) * width + (tx0 - x)) * ch;
          tile.set(data.subarray(src, src + span), dst);
        }
        tiles[index] = isZero(tile) ? null : tile;
      }
    }
    return new Raster(this.width, this.height, ch, tiles, { format: this.format });
  }

  /** Bytes of tile storage (null tiles are free). */
  get byteSize(): number {
    let bytes = 0;
    for (const tile of this.tiles) if (tile) bytes += tile.byteLength;
    return bytes;
  }

  /** Whether every pixel is identical (used for 1×1 and uniform masks). */
  uniformValue(): number | null {
    if (this.width !== 1 || this.height !== 1) return null;
    return this.pixel(0, 0)[0]!;
  }
}

function isZero(data: PixelArray): boolean {
  for (let i = 0; i < data.length; i++) if (data[i]) return false;
  return true;
}

/** Tight bounds of pixels with non-zero alpha (BrushPixels.c `brush_alpha_bounds`), or null when empty. */
export function alphaBounds(raster: Raster): { x: number; y: number; width: number; height: number } | null {
  if (raster.channels !== 4) return { x: 0, y: 0, width: raster.width, height: raster.height };
  let left = raster.width, right = 0, top = raster.height, bottom = 0;
  for (let row = 0; row < raster.rows; row++) {
    for (let col = 0; col < raster.cols; col++) {
      const tile = raster.tiles[row * raster.cols + col];
      if (!tile) continue;
      const tw = raster.tileWidth(col), th = raster.tileHeight(row);
      for (let y = 0; y < th; y++) {
        for (let x = 0; x < tw; x++) {
          if (tile[(y * tw + x) * 4 + 3]) {
            const gx = col * TILE + x, gy = row * TILE + y;
            if (gx < left) left = gx;
            if (gx + 1 > right) right = gx + 1;
            if (gy < top) top = gy;
            if (gy + 1 > bottom) bottom = gy + 1;
          }
        }
      }
    }
  }
  return right > left ? { x: left, y: top, width: right - left, height: bottom - top } : null;
}

/** A sub-rectangle as its own raster. */
export function cropRaster(raster: Raster, x: number, y: number, width: number, height: number): Raster {
  return Raster.fromPixels(width, height, raster.channels, raster.readRegionNative(x, y, width, height),
    { format: raster.format });
}
