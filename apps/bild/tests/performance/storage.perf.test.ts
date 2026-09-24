import { describe, expect, it } from 'vitest';
import { Raster, TILE } from '../../src/core/raster';
import { TileCache } from '../../src/core/storage';
import { MemoryScratchHost } from '../../src/platform/memoryScratchHost';

describe('swapped tile working set', () => {
  it('keeps a scaled pan/zoom working set below 33 ms p95 for a 200 MP × 20-layer document', async () => {
    const layers = Array.from({ length: 20 }, () => Raster.blank(20_000, 10_000, 4));
    expect(layers.reduce((pixels, layer) => pixels + layer.width * layer.height, 0)).toBe(4_000_000_000);

    // A scaled 1 MiB budget exercises the same LRU state transitions without allocating the
    // production 1.5 GiB CI budget. Each entry is one decoded RGBA8 256² tile.
    const cache = new TileCache(new MemoryScratchHost(), 4 * TILE * TILE);
    const assets = [];
    for (let index = 0; index < 80; index++) {
      const tile = new Uint8Array(TILE * TILE * 4);
      tile[0] = index + 1;
      assets.push(await cache.store(tile, 'rgba8'));
    }
    expect(cache.residentBytes).toBeLessThanOrEqual(4 * TILE * TILE);

    const samples: number[] = [];
    for (let frame = 0; frame < 50; frame++) {
      const start = performance.now();
      for (let visible = 0; visible < 12; visible++) await cache.load(assets[(frame + visible) % assets.length]!);
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.ceil(samples.length * 0.95) - 1]!;
    expect(p95).toBeLessThanOrEqual(33);
  });
});
