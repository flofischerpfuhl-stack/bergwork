import { Raster, TILE, TileNotResidentError, type RasterTileStorage } from '../raster';
import type { Rect } from '../geometry';
import type { PixelArray, RasterFormat } from '../pixel/format';
import { TileCache, type TileAsset, type TileEvictionClass } from './tileCache';

export interface StoredRasterTiles {
  readonly width: number;
  readonly height: number;
  readonly channels: 1 | 4;
  readonly format: RasterFormat;
  readonly id: string;
  readonly tiles: readonly (TileAsset | null)[];
}

export interface ResidentLease {
  readonly rasters: readonly Raster[];
  release(): void;
}

interface ManagedSlot {
  asset: TileAsset | null;
  value: PixelArray | null;
  readonly owner: object;
}

function arrayIndex(property: string | symbol): number | null {
  if (typeof property !== 'string' || !/^(0|[1-9]\d*)$/.test(property)) return null;
  const value = Number(property);
  return Number.isSafeInteger(value) ? value : null;
}

/** Array-compatible synchronous view which faults loudly instead of treating swapped data as zero. */
class ManagedRasterTileStorage implements RasterTileStorage {
  readonly tiles: ReadonlyArray<PixelArray | null>;

  constructor(readonly slots: ManagedSlot[], readonly format: RasterFormat) {
    // Do not proxy a real Array: React's development inspector eagerly walks arrays found on
    // component values, which would turn harmless inspection into a synchronous tile fault.
    const target = { length: slots.length };
    let proxy: ReadonlyArray<PixelArray | null>;
    proxy = new Proxy(target, {
      get: (object, property, receiver) => {
        const index = arrayIndex(property);
        if (index === null) {
          if (property === Symbol.iterator) return Array.prototype[Symbol.iterator].bind(proxy);
          const method = Reflect.get(Array.prototype, property);
          if (typeof method === 'function') return method.bind(proxy);
          return Reflect.get(object, property, receiver);
        }
        const slot = this.slots[index];
        if (!slot) return undefined;
        if (slot.asset && !slot.value) throw new TileNotResidentError(index);
        return slot.value;
      },
      set: () => { throw new TypeError('Raster tiles are immutable'); },
    }) as unknown as ReadonlyArray<PixelArray | null>;
    this.tiles = proxy;
  }

  validateFormat(format: RasterFormat): void {
    if (format !== this.format) throw new RangeError(`Pixel format ${format} does not match tile storage ${this.format}`);
  }

  residency(index: number): 'zero' | 'resident' | 'swapped' {
    const slot = this.slots[index];
    if (!slot?.asset) return 'zero';
    return slot.value ? 'resident' : 'swapped';
  }
}

function tileIndices(raster: Raster, rect?: Rect): number[] {
  if (!rect) return Array.from({ length: raster.cols * raster.rows }, (_, index) => index);
  const left = Math.max(0, Math.floor(rect.x));
  const top = Math.max(0, Math.floor(rect.y));
  const right = Math.min(raster.width, Math.ceil(rect.x + rect.width));
  const bottom = Math.min(raster.height, Math.ceil(rect.y + rect.height));
  if (right <= left || bottom <= top) return [];
  const indices: number[] = [];
  for (let row = Math.floor(top / TILE); row <= Math.floor((bottom - 1) / TILE); row++) {
    for (let col = Math.floor(left / TILE); col <= Math.floor((right - 1) / TILE); col++) indices.push(row * raster.cols + col);
  }
  return indices;
}

/** Owns the asynchronous boundary between synchronous kernels and ScratchHost-backed rasters. */
export class RasterResidency {
  private readonly managed = new WeakMap<Raster, ManagedRasterTileStorage>();

  constructor(readonly cache: TileCache) {}

  async manage(raster: Raster, evictionClass: TileEvictionClass = 'offscreen'): Promise<StoredRasterTiles> {
    const existing = this.managed.get(raster);
    if (existing) {
      this.setEvictionClass(raster, evictionClass);
      return this.describe(raster);
    }
    // The preview must be complete before any registration can trigger an eviction.
    raster.makeReducedCopy();
    const source = raster.tiles.slice();
    const slots: ManagedSlot[] = source.map((value) => ({ asset: null, value, owner: {} }));
    const storage = new ManagedRasterTileStorage(slots, raster.format);
    this.managed.set(raster, storage);
    raster.adoptTileStorage(storage);
    for (let index = 0; index < slots.length; index++) {
      const slot = slots[index]!;
      const tile = source[index];
      if (!tile) continue;
      slot.asset = await this.cache.store(tile, raster.format, {
        owner: slot.owner, evictionClass, evicted: () => { slot.value = null; },
      });
    }
    return this.describe(raster);
  }

  /** Rebuilds a lazy raster from durable tile references; no full-resolution bytes are read. */
  restore(stored: StoredRasterTiles, reduced?: Raster): Raster {
    const slots: ManagedSlot[] = stored.tiles.map((asset) => ({ asset, value: null, owner: {} }));
    const storage = new ManagedRasterTileStorage(slots, stored.format);
    const raster = new Raster(stored.width, stored.height, stored.channels, storage,
      { id: stored.id, format: stored.format });
    if (reduced) raster.installReducedCopy(reduced);
    this.managed.set(raster, storage);
    for (const slot of slots) if (slot.asset) {
      this.cache.bind(slot.asset, { owner: slot.owner, evictionClass: 'history', evicted: () => { slot.value = null; } });
    }
    return raster;
  }

  isManaged(raster: Raster): boolean { return this.managed.has(raster); }

  describe(raster: Raster): StoredRasterTiles {
    const storage = this.managed.get(raster);
    if (!storage) throw new Error(`Raster ${raster.id} is not managed by this residency store`);
    return { width: raster.width, height: raster.height, channels: raster.channels, format: raster.format,
      id: raster.id, tiles: storage.slots.map((slot) => slot.asset) };
  }

  setEvictionClass(raster: Raster, evictionClass: TileEvictionClass): void {
    const storage = this.managed.get(raster);
    if (!storage) return;
    for (const slot of storage.slots) if (slot.asset) this.cache.setEvictionClass(slot.owner, evictionClass);
  }

  /** Hydrates and pins only the requested tile rectangle until the synchronous operation finishes. */
  async ensureResident(rasters: Iterable<Raster>, rect?: Rect): Promise<ResidentLease> {
    const unique = [...new Set(rasters)];
    const releases: (() => void)[] = [];
    try {
      for (const raster of unique) {
        if (!this.managed.has(raster)) await this.manage(raster, 'visible');
        const storage = this.managed.get(raster)!;
        for (const index of tileIndices(raster, rect)) {
          const slot = storage.slots[index]!;
          if (!slot.asset) continue;
          const lease = await this.cache.pin(slot.asset);
          slot.value = lease.tile;
          releases.push(lease.release);
        }
      }
    } catch (error) {
      for (const release of releases) release();
      await this.cache.trim();
      throw error;
    }
    let released = false;
    return { rasters: unique, release: () => {
      if (released) return;
      released = true;
      for (const release of releases) release();
      void this.cache.trim();
    } };
  }

  async persist(rasters: Iterable<Raster>): Promise<void> {
    for (const raster of new Set(rasters)) {
      if (!this.managed.has(raster)) await this.manage(raster);
      for (const asset of this.describe(raster).tiles) if (asset) await this.cache.persist(asset);
    }
    await this.cache.host.flush();
  }
}

/** Stores each non-zero immutable tile without ever materialising a full contiguous raster. */
export async function storeRasterTiles(raster: Raster, cache: TileCache): Promise<StoredRasterTiles> {
  const residency = new RasterResidency(cache);
  return residency.manage(raster);
}

/** Compatibility loader. New recovery code uses `RasterResidency.restore` for lazy hydration. */
export async function loadRasterTiles(stored: StoredRasterTiles, cache: TileCache): Promise<Raster> {
  const tiles: (PixelArray | null)[] = new Array(stored.tiles.length).fill(null);
  for (let index = 0; index < stored.tiles.length; index++) {
    const asset = stored.tiles[index];
    if (asset) tiles[index] = await cache.load(asset);
  }
  return new Raster(stored.width, stored.height, stored.channels, tiles,
    { id: stored.id, format: stored.format });
}

export async function ensureResident(residency: RasterResidency, rasters: Iterable<Raster>, rect?: Rect): Promise<ResidentLease> {
  return residency.ensureResident(rasters, rect);
}
