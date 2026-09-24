import { describe, expect, it } from 'vitest';
import { Raster, TileNotResidentError } from '../../src/core/raster';
import { RasterResidency, loadRasterTiles, storeRasterTiles, TileCache } from '../../src/core/storage';
import { CrashJournal } from '../../src/platform/journal';
import { MemoryScratchHost } from '../../src/platform/memoryScratchHost';
import { RecoveryStore } from '../../src/platform/recovery';
import { EditorSession, type RasterCommandKind } from '../../src/core/session';
import { makeTransform } from '../../src/core/geometry';
import { newLayer, PRO_DOCUMENT_LIMITS, LITE_DOCUMENT_LIMITS } from '../../src/core/document';
import { decodeImageFile, ImageImportError } from '../../src/io/imageImport';
import { readArchive, ProjectError } from '../../src/io/project';
import { zipSync } from 'fflate';

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
    const expected = source.toPixelsNative();
    const cache = new TileCache(new MemoryScratchHost(), 0);
    const stored = await storeRasterTiles(source, cache);
    expect(cache.residentBytes).toBe(0);
    const loaded = await loadRasterTiles(stored, cache);
    expect(loaded.id).toBe('raster-16');
    expect(loaded.toPixelsNative()).toEqual(expected);
  });

  it('throws TileNotResidentError until the exact swapped tile is hydrated and pinned', async () => {
    const raster = Raster.fromPixels(2, 1, 4, new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255]));
    const residency = new RasterResidency(new TileCache(new MemoryScratchHost(), 0));
    await residency.manage(raster);
    expect(() => raster.pixel(0, 0)).toThrow(TileNotResidentError);
    const lease = await residency.ensureResident([raster], { x: 0, y: 0, width: 1, height: 1 });
    expect(raster.pixel(0, 0)).toEqual([1, 2, 3, 255]);
    lease.release();
    await residency.cache.trim();
    expect(() => raster.tiles[0]).toThrow(/ensureResident/);
  });

  it('evicts history before hidden and visible tiles regardless of recency', async () => {
    const host = new MemoryScratchHost();
    const cache = new TileCache(host, 4);
    let historyEvicted = 0, visibleEvicted = 0;
    await cache.store(new Uint8Array([1, 1, 1, 1]), 'rgba8', {
      owner: {}, evictionClass: 'visible', evicted: () => { visibleEvicted++; },
    });
    const history = await cache.store(new Uint8Array([2, 2, 2, 2]), 'rgba8', {
      owner: {}, evictionClass: 'history', evicted: () => { historyEvicted++; },
    });
    expect(historyEvicted).toBe(1);
    expect(visibleEvicted).toBe(0);
    expect(await host.read(history.key)).toEqual(new Uint8Array([2, 2, 2, 2]));
  });
});

describe('command hydration inputs', () => {
  it('includes active pixels, mask, clip base and selection for synchronous pixel commands', () => {
    const session = new EditorSession();
    const base = Raster.fromPixels(1, 1, 4, new Uint8Array([10, 0, 0, 255]));
    const target = Raster.fromPixels(1, 1, 4, new Uint8Array([20, 0, 0, 255]));
    const mask = Raster.fromPixels(1, 1, 1, new Uint8Array([200]));
    const selection = Raster.fromPixels(1, 1, 1, new Uint8Array([255]));
    const baseLayer = newLayer({ id: 'base', name: 'base', raster: base, transform: makeTransform({ x: 0, y: 0 }, { width: 1, height: 1 }) });
    const targetLayer = newLayer({ id: 'target', name: 'target', raster: target, mask: { raster: mask, enabled: true, linked: true, placement: null },
      maskSourceId: 'base', transform: makeTransform({ x: 0, y: 0 }, { width: 1, height: 1 }) });
    session.installProject({ id: 'doc', width: 1, height: 1, resolution: 72, layers: [baseLayer, targetLayer], artboards: [],
      selection: { mask: selection, x: 0, y: 0, antialiased: false } }, 'target', 'inputs');
    const local: RasterCommandKind[] = ['brush', 'fill', 'filter', 'transform', 'clipboard'];
    for (const kind of local) expect(new Set(session.rastersForCommand(kind))).toEqual(new Set([target, mask, base, selection]));
    for (const kind of ['adjustment', 'clipboardMerged', 'export', 'save'] as const) {
      expect(new Set(session.rastersForCommand(kind))).toEqual(new Set([base, target, mask, selection]));
    }
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

  it('replays granular tile/state commits with undo after a torn tail', async () => {
    const host = new MemoryScratchHost();
    const cache = new TileCache(host, 0);
    const residency = new RasterResidency(cache);
    const session = new EditorSession();
    session.createNewProject(2, 1, 'Granular');
    session.insertRaster(Raster.fromPixels(2, 1, 4, new Uint8Array([7, 8, 9, 255, 1, 2, 3, 255])), 'pixels');
    const old = new RecoveryStore(host);
    await old.putState({ id: 'granular', name: 'Granular', savedAt: 50, document: session.document!,
      activeLayerId: session.activeLayerId, history: session.history.exportState(), command: 'Import Image' }, residency);
    await host.write('recovery/granular.fwj', new Uint8Array([0x46, 0x57, 0x4a]), { append: true });
    const restarted = new RecoveryStore(host);
    const record = (await restarted.previous()).find((value) => value.id === 'granular')!;
    expect(record.kind).toBe('state');
    const restoredResidency = new RasterResidency(new TileCache(host, 1024));
    const loaded = await restarted.recover(record, restoredResidency);
    const restored = new EditorSession();
    restored.installProject(loaded.document, loaded.activeLayerId, loaded.name, loaded.history);
    const pixels = restored.activeLayer!.raster!;
    const lease = await restoredResidency.ensureResident([pixels]);
    expect(pixels.toPixels()).toEqual(new Uint8Array([7, 8, 9, 255, 1, 2, 3, 255]));
    lease.release();
    expect(restored.undo()).toBe(true);
    expect(restored.document!.layers).toHaveLength(1);
  });
});

describe('document limit profiles', () => {
  it('keeps Lite at 100 MP / 30,000 px and enables Pro 300 MP / 60,000 px', () => {
    expect(LITE_DOCUMENT_LIMITS).toEqual({ maxSide: 30_000, maxPixels: 100_000_000 });
    expect(PRO_DOCUMENT_LIMITS).toEqual({ maxSide: 60_000, maxPixels: 300_000_000 });
    const lite = new EditorSession(undefined, { enabled: false });
    lite.createDocument(20_000, 10_000);
    expect(lite.document).toBeNull();
    const pro = new EditorSession({ flatten: async () => Raster.blank(1, 1, 4), bakeLiveMask: async () => null,
      limits: PRO_DOCUMENT_LIMITS }, { enabled: false });
    pro.createDocument(20_000, 10_000);
    expect(pro.document).not.toBeNull();
    pro.clearProject();
    pro.createDocument(60_001, 1);
    expect(pro.document).toBeNull();
  });

  it('applies the selected profile to image imports and project archives', async () => {
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x40, 0x9c, 0x01, 0x00, 0, 0, 0,
      0x2c, 0, 0, 0, 0, 0x40, 0x9c, 0x01, 0x00, 0]); // 40,000 × 1, minimal image descriptor
    const decoder = async () => ({ width: 40_000, height: 1, data: new Uint8Array(40_000 * 4) });
    await expect(decodeImageFile(gif, LITE_DOCUMENT_LIMITS.maxPixels,
      { maxSide: LITE_DOCUMENT_LIMITS.maxSide, nativeDecoder: decoder })).rejects.toBeInstanceOf(ImageImportError);
    const imported = await decodeImageFile(gif, PRO_DOCUMENT_LIMITS.maxPixels,
      { maxSide: PRO_DOCUMENT_LIMITS.maxSide, nativeDecoder: decoder });
    expect(imported.width).toBe(40_000);

    const manifest = { format: 'fernwork-image', version: 2, id: 'large', name: 'large', width: 20_000, height: 10_000,
      resolution: 72, colorSpace: 'srgb', activeLayerId: null, layers: [], artboards: [], assets: [] };
    const archive = new Blob([zipSync({ 'manifest.json': new TextEncoder().encode(JSON.stringify(manifest)) }) as BlobPart]);
    const noDecode = async () => { throw new Error('unexpected decode'); };
    await expect(readArchive(archive, noDecode, LITE_DOCUMENT_LIMITS)).rejects.toBeInstanceOf(ProjectError);
    expect((await readArchive(archive, noDecode, PRO_DOCUMENT_LIMITS)).document.width).toBe(20_000);
  });
});
