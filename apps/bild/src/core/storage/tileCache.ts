import type { PixelArray, RasterFormat } from '../pixel/format';
import { sha256Hex } from '../../io/sha256';

/** Engine-side storage contract; browser and native hosts implement it outside the engine package. */
export interface TileScratchHost {
  readonly kind: 'memory' | 'opfs' | 'indexeddb' | 'tauri';
  read(key: string): Promise<Uint8Array | null>;
  write(key: string, bytes: Uint8Array, options?: { append?: boolean }): Promise<void>;
  remove(key: string): Promise<void>;
  list(prefix?: string): Promise<readonly string[]>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export const LITE_TILE_BUDGET = 1536 * 1024 * 1024;
export const PRO_TILE_BUDGET = 4 * 1024 * 1024 * 1024;

export interface TileAsset {
  readonly key: string;
  readonly format: RasterFormat;
  readonly byteLength: number;
}

/** Larger values are deliberately evicted first. */
export type TileEvictionClass = 'visible' | 'offscreen' | 'hidden' | 'history';

const PRIORITY: Record<TileEvictionClass, number> = {
  visible: 0, offscreen: 1, hidden: 2, history: 3,
};

export interface TileBinding {
  readonly owner: object;
  readonly evictionClass: TileEvictionClass;
  evicted(): void;
}

interface Entry extends TileAsset {
  value: PixelArray | null;
  persisted: boolean;
  lastUsed: number;
  pins: number;
  readonly bindings: Map<object, TileBinding>;
}

function bytesOf(tile: PixelArray): Uint8Array {
  return new Uint8Array(tile.buffer, tile.byteOffset, tile.byteLength);
}

/**
 * Content-addressed LRU for immutable decoded tiles. Cache entries are shared by every raster and
 * history snapshot with the same bytes. Eviction invalidates those bindings atomically; there is
 * no dirty/write-back state because a tile is persisted before its first eviction.
 */
export class TileCache {
  private readonly entries = new Map<string, Entry>();
  private readonly ownerEntries = new WeakMap<object, Set<Entry>>();
  private residentBytesValue = 0;
  private clock = 0;

  constructor(readonly host: TileScratchHost, readonly byteBudget = LITE_TILE_BUDGET) {
    if (!Number.isSafeInteger(byteBudget) || byteBudget < 0) throw new RangeError('Invalid tile-cache budget');
  }

  get residentBytes(): number { return this.residentBytesValue; }
  get persistedBytes(): number {
    let bytes = 0;
    for (const entry of this.entries.values()) if (entry.persisted) bytes += entry.byteLength;
    return bytes;
  }
  get size(): number { return this.entries.size; }

  /** Registers immutable tile bytes and returns their content-addressed storage identity. */
  async store(tile: PixelArray, format: RasterFormat, binding?: TileBinding): Promise<TileAsset> {
    const hash = sha256Hex(bytesOf(tile));
    const key = `tiles/${format}-${hash}.bin`;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { key, format, byteLength: tile.byteLength, value: tile, persisted: false,
        lastUsed: ++this.clock, pins: 0, bindings: new Map() };
      this.entries.set(key, entry);
      this.residentBytesValue += tile.byteLength;
    } else {
      if (entry.format !== format || entry.byteLength !== tile.byteLength) throw new Error(`Tile hash collision: ${key}`);
      if (!entry.value) { entry.value = tile; this.residentBytesValue += tile.byteLength; }
      entry.lastUsed = ++this.clock;
    }
    if (binding) {
      entry.bindings.set(binding.owner, binding);
      let owned = this.ownerEntries.get(binding.owner);
      if (!owned) { owned = new Set(); this.ownerEntries.set(binding.owner, owned); }
      owned.add(entry);
    }
    await this.evict();
    return { key, format, byteLength: tile.byteLength };
  }

  /** Registers a recovered/swapped reference without reading its bytes. */
  bind(asset: TileAsset, binding: TileBinding): void {
    let entry = this.entries.get(asset.key);
    if (!entry) {
      entry = { ...asset, value: null, persisted: true, lastUsed: 0, pins: 0, bindings: new Map() };
      this.entries.set(asset.key, entry);
    }
    entry.bindings.set(binding.owner, binding);
    let owned = this.ownerEntries.get(binding.owner);
    if (!owned) { owned = new Set(); this.ownerEntries.set(binding.owner, owned); }
    owned.add(entry);
  }

  setEvictionClass(owner: object, evictionClass: TileEvictionClass): void {
    for (const entry of this.ownerEntries.get(owner) ?? []) {
      const binding = entry.bindings.get(owner);
      if (binding) entry.bindings.set(owner, { ...binding, evictionClass });
    }
  }

  async persist(asset: TileAsset): Promise<void> {
    const entry = this.entries.get(asset.key);
    if (!entry) throw new Error(`Unknown tile asset: ${asset.key}`);
    if (!entry.persisted) {
      if (!entry.value) throw new Error(`Tile bytes are unavailable: ${asset.key}`);
      await this.host.write(entry.key, bytesOf(entry.value));
      entry.persisted = true;
    }
  }

  async load(asset: TileAsset): Promise<PixelArray> {
    let entry = this.entries.get(asset.key);
    if (entry?.value) { entry.lastUsed = ++this.clock; return entry.value; }
    const bytes = await this.host.read(asset.key);
    if (!bytes || bytes.byteLength !== asset.byteLength) throw new Error(`Scratch tile is missing or truncated: ${asset.key}`);
    const value = asset.format === 'rgba16' ? new Uint16Array(bytes.slice().buffer) : bytes.slice();
    entry ??= { ...asset, value: null, persisted: true, lastUsed: 0, pins: 0, bindings: new Map() };
    entry.value = value;
    entry.persisted = true;
    entry.lastUsed = ++this.clock;
    this.entries.set(asset.key, entry);
    this.residentBytesValue += value.byteLength;
    await this.evict(asset.key);
    return value;
  }

  /** Prevents eviction while a synchronous renderer/kernel uses the returned typed array. */
  async pin(asset: TileAsset): Promise<{ readonly tile: PixelArray; release(): void }> {
    const tile = await this.load(asset);
    const entry = this.entries.get(asset.key)!;
    entry.pins++;
    let released = false;
    return { tile, release: () => { if (!released) { released = true; entry.pins--; } } };
  }

  async trim(): Promise<void> { await this.evict(); }

  private evictionPriority(entry: Entry): number {
    if (!entry.bindings.size) return PRIORITY.offscreen;
    // A tile shared with visible content inherits the most protected use.
    let priority = PRIORITY.history;
    for (const binding of entry.bindings.values()) priority = Math.min(priority, PRIORITY[binding.evictionClass]);
    return priority;
  }

  private async evict(except?: string): Promise<void> {
    while (this.residentBytesValue > this.byteBudget) {
      let cold: Entry | null = null;
      for (const entry of this.entries.values()) {
        if (!entry.value || entry.pins || entry.key === except) continue;
        if (!cold || this.evictionPriority(entry) > this.evictionPriority(cold)
          || (this.evictionPriority(entry) === this.evictionPriority(cold) && entry.lastUsed < cold.lastUsed)) cold = entry;
      }
      if (!cold?.value) return;
      const value = cold.value;
      await this.persist(cold);
      if (cold.value !== value) continue;
      this.residentBytesValue -= value.byteLength;
      cold.value = null;
      for (const binding of cold.bindings.values()) binding.evicted();
    }
  }
}

export function defaultTileBudget(profile: 'lite' | 'pro'): number {
  return profile === 'pro' ? PRO_TILE_BUDGET : LITE_TILE_BUDGET;
}
