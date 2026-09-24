import { Raster } from '../raster';
import type { PixelArray, RasterFormat } from '../pixel/format';
import { TileCache, type TileAsset } from './tileCache';

export interface StoredRasterTiles {
  readonly width: number;
  readonly height: number;
  readonly channels: 1 | 4;
  readonly format: RasterFormat;
  readonly id: string;
  readonly tiles: readonly (TileAsset | null)[];
}

/** Stores each non-zero immutable tile without ever materialising a full contiguous raster. */
export async function storeRasterTiles(raster: Raster, cache: TileCache): Promise<StoredRasterTiles> {
  const tiles: (TileAsset | null)[] = new Array(raster.tiles.length).fill(null);
  for (let index = 0; index < raster.tiles.length; index++) {
    const tile = raster.tiles[index];
    if (tile) tiles[index] = await cache.store(tile, raster.format);
  }
  return { width: raster.width, height: raster.height, channels: raster.channels, format: raster.format,
    id: raster.id, tiles };
}

/** Reloads tile assets into the ordinary synchronous Raster contract used by kernels and renderers. */
export async function loadRasterTiles(stored: StoredRasterTiles, cache: TileCache): Promise<Raster> {
  const tiles: (PixelArray | null)[] = new Array(stored.tiles.length).fill(null);
  for (let index = 0; index < stored.tiles.length; index++) {
    const asset = stored.tiles[index];
    if (asset) tiles[index] = await cache.load(asset);
  }
  return new Raster(stored.width, stored.height, stored.channels, tiles,
    { id: stored.id, format: stored.format });
}
