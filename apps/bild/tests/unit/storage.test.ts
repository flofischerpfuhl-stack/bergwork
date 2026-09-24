import { describe, expect, it } from 'vitest';
import { Raster } from '../../src/core/raster';
import { loadRasterTiles, storeRasterTiles, TileCache } from '../../src/core/storage';
import { CrashJournal } from '../../src/platform/journal';
import { MemoryScratchHost } from '../../src/platform/memoryScratchHost';
import { RecoveryStore } from '../../src/platform/recovery';

describe('scratch tile storage', () => {
  it('evicts the least-recently-used immutable tile and reloads its exact bytes', async () => {
    const host = new MemoryScratchHost();
    const cache = new TileCache(host, 4);
    const first = await cache.store(new Uint8Array([1, 2, 3, 4]), 'rgba8');
    const second = await cache.store(new Uint8Array([5, 6, 7, 8]), 'rgba8');
    expect(cache.residentBytes).toBe(4);
    expect(await host.read(first.key)).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(await cache.load(first)).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(await host.read(second.key)).toEqual(new Uint8Array([5, 6, 7, 8]));
    expect(cache.residentBytes).toBe(4);
  });

  it('round-trips an rgba16 tiled raster without flattening it', async () => {
    const source = Raster.fromPixels(257, 2, 4, new Uint16Array(257 * 2 * 4).map((_, index) => index % 65536),
      { format: 'rgba16', id: 'raster-16' });
    const cache = new TileCache(new MemoryScratchHost(), 0);
    const stored = await storeRasterTiles(source, cache);
    expect(cache.residentBytes).toBe(0);
    const loaded = await loadRasterTiles(stored, cache);
    expect(loaded.id).toBe('raster-16');
    expect(loaded.toPixelsNative()).toEqual(source.toPixelsNative());
  });
});

describe('append-only crash journal', () => {
  it('deduplicates assets, fsyncs each commit, and ignores a torn tail', async () => {
    const host = new MemoryScratchHost();
    const journal = new CrashJournal(host, 'recovery/tab.fwj');
    const bytes = new Uint8Array([9, 8, 7]);
    await journal.append(bytes, { name: 'Poster', time: 10, instance: 'old', command: 'Paint' });
    const firstSize = (await host.read('recovery/tab.fwj'))!.byteLength;
    await journal.append(bytes, { name: 'Poster', time: 20, instance: 'old', command: 'Move' });
    const secondSize = (await host.read('recovery/tab.fwj'))!.byteLength;
    expect(secondSize - firstSize).toBeLessThan(firstSize);
    expect(host.flushCount).toBe(2);
    await host.write('recovery/tab.fwj', new Uint8Array([0x46, 0x57]), { append: true });
    const latest = await journal.latest('new');
    expect(latest?.commit.command).toBe('Move');
    expect(latest?.bytes).toEqual(bytes);
  });

  it('offers only journals committed by a previous editor instance', async () => {
    const host = new MemoryScratchHost();
    const old = new RecoveryStore(host);
    await old.put({ id: 'one', name: 'Recovered', savedAt: 42, size: 3,
      archive: new Blob([new Uint8Array([1, 2, 3])]) });
    expect(await old.previous()).toHaveLength(0);
    const restarted = new RecoveryStore(host);
    const records = await restarted.previous();
    expect(records.map((record) => [record.id, record.name, record.savedAt])).toEqual([['one', 'Recovered', 42]]);
    expect(new Uint8Array(await records[0]!.archive.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });
});
