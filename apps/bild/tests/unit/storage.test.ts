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
import { readArchive, writeArchive, writeArchiveStreaming, ProjectError } from '../../src/io/project';
import { unzipSync, zipSync } from 'fflate';
import { beginBrushStroke, cancelBrushStroke } from '../../src/core/brush';
import { encodePngBandStream } from '../../src/io/png';
import { PngTileStreamDecoder, restoreStreamedPng } from '../../src/io/pngStream';
import { prepareStreamingSha256 } from '../../src/io/sha256';
import { readZipEntries, Zip64StreamWriter } from '../../src/io/zipStream';

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

  it('registers a sparse brush overlay without hydrating untouched source tiles', async () => {
    const source = Raster.fromPixels(512, 256, 4, new Uint8Array(512 * 256 * 4).fill(17));
    const residency = new RasterResidency(new TileCache(new MemoryScratchHost(), 0));
    await residency.manage(source);
    expect(source.tileResidency(0)).toBe('swapped');
    const changed = new Uint8Array(256 * 256 * 4).fill(91);
    const overlay = source.withTileUpdates([{ index: 1, tile: changed }]);
    await residency.manage(overlay);
    expect(overlay.tileResidency(0)).toBe('swapped');
    expect(overlay.tileResidency(1)).toBe('resident');
    const lease = await residency.ensureResident([overlay], { x: 256, y: 0, width: 1, height: 1 });
    expect(overlay.pixel(256, 0)).toEqual([91, 91, 91, 91]);
    lease.release();
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

  it('keeps committed tiles readable while residency registration overlaps a rapid successor stroke', async () => {
    let unblock!: () => void;
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    class DelayedScratchHost extends MemoryScratchHost {
      override async write(key: string, bytes: Uint8Array, options?: { append?: boolean }): Promise<void> {
        await gate;
        await super.write(key, bytes, options);
      }
    }
    const raster = Raster.fromPixels(2, 1, 4, new Uint8Array([9, 8, 7, 255, 6, 5, 4, 255]));
    const residency = new RasterResidency(new TileCache(new DelayedScratchHost(), 0));
    const first = residency.manage(raster);
    const second = residency.manage(raster);
    await Promise.resolve();
    expect(residency.isManaged(raster)).toBe(false);
    expect(raster.pixel(0, 0)).toEqual([9, 8, 7, 255]);
    unblock();
    await Promise.all([first, second]);
    expect(residency.isManaged(raster)).toBe(true);
    expect(() => raster.pixel(0, 0)).toThrow(TileNotResidentError);
    const lease = await residency.ensureResident([raster]);
    expect(raster.toPixels()).toEqual(new Uint8Array([9, 8, 7, 255, 6, 5, 4, 255]));
    expect(raster.tiles.slice()[0]).toEqual(new Uint8Array([9, 8, 7, 255, 6, 5, 4, 255]));
    lease.release();
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

  it('garbage-collects only content-addressed files with no journal or live reference', async () => {
    const host = new MemoryScratchHost();
    const journalKey = `tiles/rgba8-${'1'.repeat(64)}.bin`;
    const liveKey = `tiles/gray8-${'2'.repeat(64)}.bin`;
    const orphanKey = `assets/${'3'.repeat(64)}.bin`;
    await host.write(journalKey, new Uint8Array([1]));
    await host.write(liveKey, new Uint8Array([2]));
    await host.write(orphanKey, new Uint8Array([3]));
    await new CrashJournal(host, 'recovery/keep.fwj').appendState(
      new TextEncoder().encode(JSON.stringify({ tile: journalKey })),
      { name: 'Keep', time: 1, instance: 'old' });
    const store = new RecoveryStore(host);
    expect(await store.collectGarbage([liveKey])).toBe(1);
    expect(await host.read(journalKey)).toEqual(new Uint8Array([1]));
    expect(await host.read(liveKey)).toEqual(new Uint8Array([2]));
    expect(await host.read(orphanKey)).toBeNull();
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

  it('starts a brush stroke on a 200 MP Pro canvas without charging the other layers', () => {
    const pro = new EditorSession({ flatten: async () => Raster.blank(1, 1, 4), bakeLiveMask: async () => null,
      limits: PRO_DOCUMENT_LIMITS }, { enabled: false });
    pro.createNewProject(20_000, 10_000);
    pro.tool = 'brush';
    expect(beginBrushStroke(pro, { x: 9_000, y: 4_500 })).not.toBeNull();
    expect(cancelBrushStroke(pro)).toBe(true);
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

  it('applies the pixel ceiling per canvas and asset, not to the sum of streamed layers', async () => {
    const first = Raster.fromPixels(8, 8, 4, new Uint8Array(8 * 8 * 4).fill(31), { id: 'limit-first' });
    const second = Raster.fromPixels(8, 8, 4, new Uint8Array(8 * 8 * 4).fill(79), { id: 'limit-second' });
    const layers = [first, second].map((raster, index) => newLayer({ id: `limit-layer-${index}`, name: `Layer ${index}`,
      raster, transform: makeTransform({ x: 0, y: 0 }, { width: 8, height: 8 }) }));
    const document = { id: 'layer-limit-document', width: 10, height: 10, resolution: 72,
      layers, artboards: [], selection: null };
    const archive = writeArchive(document, 'Layer limits', layers[0]!.id).blob;
    const loaded = await readArchive(archive, async () => { throw new Error('unexpected external decoder'); },
      { maxSide: 10, maxPixels: 100 });
    expect(loaded.document.layers).toHaveLength(2);
    expect(loaded.document.layers[1]!.raster!.pixel(0, 0)).toEqual([79, 79, 79, 79]);
  });
});

describe('streaming project archive', () => {
  it('does not mistake a ZIP data-descriptor signature inside a stored asset for its end', async () => {
    const payload = new Uint8Array(1024);
    for (let index = 0; index < payload.length; index++) payload[index] = (index * 73 + 19) & 255;
    payload.set([0x50, 0x4b, 0x07, 0x08], 317);
    const writer = new Zip64StreamWriter();
    await writer.add('assets/signature.bin', (input) => input.push(payload, true));
    const archive = writer.finish();
    const restored: Uint8Array[] = [];
    for await (const entry of readZipEntries(archive)) {
      for await (const chunk of entry.chunks) restored.push(chunk);
    }
    const length = restored.reduce((sum, chunk) => sum + chunk.byteLength, 0), joined = new Uint8Array(length);
    let offset = 0;
    for (const chunk of restored) { joined.set(chunk, offset); offset += chunk.byteLength; }
    expect(joined).toEqual(payload);
  });

  it('decodes an incompressible PNG split at 4 MiB boundaries without truncating rows', async () => {
    const width = 2_048, height = 1_024, chunks: Uint8Array[] = [];
    await encodePngBandStream(width, height, 4, async (top, rows) => {
      const pixels = new Uint8Array(width * rows * 4), start = top * width * 4;
      for (let index = 0; index < pixels.length; index++) pixels[index] = ((start + index) * 29 + 17) & 255;
      return pixels;
    }, (chunk) => chunks.push(chunk.slice()), { filter: 'none', level: 1, limits: PRO_DOCUMENT_LIMITS });
    const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0), png = new Uint8Array(length);
    let at = 0;
    for (const chunk of chunks) { png.set(chunk, at); at += chunk.byteLength; }
    const residency = new RasterResidency(new TileCache(new MemoryScratchHost(), 64 * 1024 * 1024));
    const makeHasher = await prepareStreamingSha256();
    const decoder = new PngTileStreamDecoder(residency, PRO_DOCUMENT_LIMITS, makeHasher());
    for (let offset = 0; offset < png.byteLength; offset += 4 * 1024 * 1024) {
      decoder.push(png.subarray(offset, offset + 4 * 1024 * 1024));
      await decoder.idle();
    }
    const record = await decoder.finish(), raster = restoreStreamedPng(record, 'split-png', residency);
    const x = 1_500, y = 700, lease = await residency.ensureResident([raster], { x, y, width: 1, height: 1 });
    const start = (y * width + x) * 4;
    expect(raster.pixel(x, y)).toEqual([0, 1, 2, 3].map((channel) => ((start + channel) * 29 + 17) & 255));
    lease.release();
  }, 30_000);

  it('keeps the v2 format compatible in both synchronous and tile-band writer directions', async () => {
    const pixels = new Uint8Array(257 * 257 * 4);
    for (let index = 0; index < pixels.length; index++) pixels[index] = (index * 29 + 17) & 255;
    const raster = Raster.fromPixels(257, 257, 4, pixels, { id: 'streamed-raster' });
    const layer = newLayer({ id: 'streamed-layer', name: 'Streamed', raster,
      transform: makeTransform({ x: 0, y: 0 }, { width: 257, height: 257 }) });
    const document = { id: 'streamed-document', width: 257, height: 257, resolution: 144,
      layers: [layer], artboards: [], selection: null };
    const oldArchive = writeArchive(document, 'Compatibility', layer.id).blob;
    const residency = new RasterResidency(new TileCache(new MemoryScratchHost(), 256 * 256 * 4));
    await residency.manage(raster);
    const streamed = await writeArchiveStreaming(document, 'Compatibility', layer.id, residency);
    const decoder = async () => { throw new Error('PNG assets must use the built-in decoder'); };
    const [oldLoaded, streamedLoaded] = await Promise.all([
      readArchive(oldArchive, decoder), readArchive(streamed.blob, decoder),
    ]);
    expect(oldLoaded.document.layers[0]!.raster!.toPixels()).toEqual(pixels);
    expect(streamedLoaded.document.layers[0]!.raster!.toPixels()).toEqual(pixels);
    const files = unzipSync(new Uint8Array(await streamed.blob.arrayBuffer()));
    expect(JSON.parse(new TextDecoder().decode(files['manifest.json'])).format).toBe('fernwork-image');
  });

  it('opens old and streamed PNG entries directly into swapped tiles without a contiguous pixel buffer', async () => {
    const pixels = new Uint8Array(513 * 300 * 4);
    for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 73 + (i >>> 9) * 19) & 255;
    const raster = Raster.fromPixels(513, 300, 4, pixels, { id: 'open-stream' });
    const layer = newLayer({ id: 'open-layer', name: 'Open', raster,
      transform: makeTransform({ x: 0, y: 0 }, { width: 513, height: 300 }) });
    const document = { id: 'open-document', width: 513, height: 300, resolution: 72,
      layers: [layer], artboards: [], selection: null };
    const archives = [writeArchive(document, 'Old', layer.id).blob,
      (await writeArchiveStreaming(document, 'New', layer.id)).blob];
    for (const archive of archives) {
      const residency = new RasterResidency(new TileCache(new MemoryScratchHost(), 0));
      const loaded = await readArchive(archive, async () => { throw new Error('unexpected external decoder'); },
        LITE_DOCUMENT_LIMITS, residency);
      const restored = loaded.document.layers[0]!.raster!;
      expect(restored.hasSwappedTiles).toBe(true);
      expect(restored.reducedCopy).not.toBeNull();
      const lease = await residency.ensureResident([restored]);
      expect(restored.toPixels()).toEqual(pixels);
      lease.release();
    }
  });
});
