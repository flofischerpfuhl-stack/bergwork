import type { PixelArray, RasterFormat } from '../pixel/format';
import { sha256Hex } from '../../io/sha256';
import type { ScratchHost } from '../../platform/scratchHost';
import { LITE_TILE_BUDGET, PRO_TILE_BUDGET } from '../../platform/scratchHost';

export interface TileAsset {
  readonly key: string;
  readonly format: RasterFormat;
  readonly byteLength: number;
}

interface Entry extends TileAsset {
  value: PixelArray | null;
  persisted: boolean;
  lastUsed: number;
  pins: number;
}

function bytesOf(tile: PixelArray): Uint8Array {
  return new Uint8Array(tile.buffer, tile.byteOffset, tile.byteLength);
}

/**
 * LRU for immutable decoded tiles. A dirty state is deliberately absent: each tile is written at
 * most once, before its first eviction, and reads never require write-back.
 */
export class TileCache {
  private readonly entries = new Map<string, Entry>();
  private residentBytesValue = 0;
  private clock = 0;

  constructor(readonly host: ScratchHost, readonly byteBudget = LITE_TILE_BUDGET) {
    if (!Number.isSafeInteger(byteBudget) || byteBudget < 0) throw new RangeError('Invalid tile-cache budget');
  }

  get residentBytes(): number { return this.residentBytesValue; }
  get size(): number { return this.entries.size; }

  /** Registers immutable tile bytes and returns their content-addressed storage identity. */
  async store(tile: PixelArray, format: RasterFormat): Promise<TileAsset> {
    const hash = sha256Hex(bytesOf(tile));
    const key = `tiles/${format}-${hash}.bin`;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { key, format, byteLength: tile.byteLength, value: tile, persisted: false, lastUsed: ++this.clock, pins: 0 };
      this.entries.set(key, entry);
      this.residentBytesValue += tile.byteLength;
    } else entry.lastUsed = ++this.clock;
    await this.evict();
    return { key, format, byteLength: tile.byteLength };
  }

  async load(asset: TileAsset): Promise<PixelArray> {
    let entry = this.entries.get(asset.key);
    if (entry?.value) { entry.lastUsed = ++this.clock; return entry.value; }
    const bytes = await this.host.read(asset.key);
    if (!bytes || bytes.byteLength !== asset.byteLength) throw new Error(`Scratch tile is missing or truncated: ${asset.key}`);
    const value = asset.format === 'rgba16'
      ? new Uint16Array(bytes.slice().buffer)
      : bytes.slice();
    entry ??= { ...asset, value: null, persisted: true, lastUsed: 0, pins: 0 };
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

  private async evict(except?: string): Promise<void> {
    while (this.residentBytesValue > this.byteBudget) {
      let cold: Entry | null = null;
      for (const entry of this.entries.values()) {
        if (!entry.value || entry.pins || entry.key === except) continue;
        if (!cold || entry.lastUsed < cold.lastUsed) cold = entry;
      }
      if (!cold?.value) return;
      if (!cold.persisted) {
        await this.host.write(cold.key, bytesOf(cold.value));
        cold.persisted = true;
      }
      this.residentBytesValue -= cold.value.byteLength;
      cold.value = null;
    }
  }
}

export function defaultTileBudget(profile: 'lite' | 'pro'): number {
  return profile === 'pro' ? PRO_TILE_BUDGET : LITE_TILE_BUDGET;
}
