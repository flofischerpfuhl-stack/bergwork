import { describe, expect, it } from 'vitest';
import { defaultLevels } from '../../src/core/adjustments';
import { newLayer, type CanvasDocument, type Layer, type LayerAdjustment } from '../../src/core/document';
import { makeTransform } from '../../src/core/geometry';
import { Raster } from '../../src/core/raster';
import { applyRecipeToLayers, createRecipe, type Recipe } from '../../src/core/recipes';
import {
  batchFileStem, flattenTarget, patternIsUnique, pendingState, processBatchItem, retryFailed, runBatch, summarize, uniqueName,
  zipDestination, type BatchItem, type BatchItemState, type BatchServices, type BatchSettings,
} from '../../src/io/batch';
import { cpuExportRenderer, planExport, renderExportItem, runExport, type ExportFile, type ExportRequest } from '../../src/io/exportPipeline';
import { decodePng } from '../../src/io/png';
import { readZipEntries } from '../../src/io/zipStream';

const renderer = cpuExportRenderer();

function gradient(width: number, height: number, seed: number): Raster {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    data.set([(x * 9 + seed * 17) & 255, (y * 7 + seed * 5) & 255, (x * y + seed) & 255, 255], (y * width + x) * 4);
  }
  return Raster.fromPixels(width, height, 4, data);
}
const layerOf = (id: string, raster: Raster, x = 0, y = 0): Layer =>
  newLayer({ id, name: id, raster, transform: makeTransform({ x, y }, { width: raster.width, height: raster.height }) });
const imageDocument = (width: number, height: number, seed: number): CanvasDocument => ({
  id: `image-${seed}`, width, height, resolution: 72, selection: null, artboards: [], layers: [layerOf('pixels', gradient(width, height, seed))],
});

const levels: LayerAdjustment = (() => {
  const settings = defaultLevels();
  return { kind: 'Levels', schemaVersion: 1, parameters: { ...settings, ranges: settings.ranges.map((r, i) => (i === 0 ? { ...r, white: 150 } : r)) } };
})();
const brighten: Recipe = createRecipe('Brighten', [
  { kind: 'filter', filter: { kind: 'gaussianBlur', schemaVersion: 1, enabled: true, radius: 1 } },
  { kind: 'adjustment', name: 'Levels', adjustment: levels, opacity: 1, blendMode: 'normal' },
]);

const fileItem = (name: string, id = name): BatchItem => ({ id, name, source: { kind: 'file', read: async () => new Blob([name]) } });

/** Services over in-memory "files": documents by name, a name → Error map for unreadable ones, the CPU renderer. */
function memoryServices(documents: Map<string, CanvasDocument>, written: Map<string, ExportFile>,
  hooks: { beforeExport?: (name: string) => void } = {}): BatchServices & { opened: string[] } {
  const opened: string[] = [];
  return {
    opened,
    async open(item) {
      opened.push(item.name);
      const document = documents.get(item.name);
      if (!document) throw new Error(`The image could not be read. It may be damaged or unavailable.`);
      return { document, target: { kind: 'document' }, name: item.name.replace(/\.[^.]+$/, '') };
    },
    flatten: (document, target, deep) => flattenTarget(document, target, renderer, deep),
    export: (document, request, signal) => { hooks.beforeExport?.(request.baseName ?? ''); return runExport(document, request, renderer, { signal }); },
    async write(name, file) {
      const unique = await uniqueName(name, (candidate) => written.has(candidate));
      written.set(unique, file);
      return unique;
    },
  };
}

const settingsOf = (recipe: Recipe | null, extra: Partial<BatchSettings> = {}): BatchSettings => ({
  recipe, export: { format: 'png', sizes: [{ scale: 1 }], metadata: { colorProfile: 'strip', resolution: false, info: null } }, pattern: '{name}', ...extra,
});

describe('batch naming (PRODUCT-PLAN 6.9)', () => {
  it('fills {name} {index} {w} {h}, pads the index to the queue length and sanitises', () => {
    const values = { name: 'IMG_0007', index: 3, total: 12, width: 1080, height: 1350 };
    expect(batchFileStem('{name}', values)).toBe('IMG_0007');
    expect(batchFileStem('Hochzeit-{index}_{w}x{h}', values)).toBe('Hochzeit-03_1080x1350');
    expect(batchFileStem('{index}', { ...values, total: 50 })).toBe('03');
    expect(batchFileStem('{index}', { ...values, total: 120 })).toBe('003');
    expect(batchFileStem('{index}', { ...values, total: 9 })).toBe('3');
    expect(batchFileStem('a/b:{name}?', values)).toBe('a-b-IMG_0007-');
    expect(batchFileStem('   ', values)).toBe('IMG_0007');
    expect(batchFileStem('{nope}', values)).toBe('{nope}');
    expect(patternIsUnique('{name}-web')).toBe(true);
    expect(patternIsUnique('Serie {index}')).toBe(true);
    expect(patternIsUnique('Serie {w}')).toBe(false);
  });

  it('never reuses a taken name', async () => {
    const taken = new Set(['a.png', 'a 2.png']);
    expect(await uniqueName('a.png', (n) => taken.has(n))).toBe('a 3.png');
    expect(await uniqueName('b.png', (n) => taken.has(n))).toBe('b.png');
    expect(await uniqueName('noext', (n) => n === 'noext')).toBe('noext 2');
  });
});

describe('batch queue (PRODUCT-PLAN 6.9, core task 14)', () => {
  it('reports a failing item and goes on with the rest', async () => {
    const documents = new Map([['a.png', imageDocument(12, 8, 1)], ['c.png', imageDocument(10, 10, 3)]]);
    const written = new Map<string, ExportFile>();
    const services = memoryServices(documents, written);
    const items = ['a.png', 'broken.png', 'c.png'].map((name) => pendingState(fileItem(name)));
    const snapshots: (readonly BatchItemState[])[] = [];
    const states = await runBatch(items, settingsOf(brighten), services, { onChange: (s) => snapshots.push(s) });
    expect(states.map((s) => s.status)).toEqual(['done', 'failed', 'done']);
    expect(String((states[1]!.error as Error).message)).toMatch(/could not be read/);
    expect(states.map((s) => s.outputs)).toEqual([['a.png'], [], ['c.png']]);
    expect([...written.keys()]).toEqual(['a.png', 'c.png']);
    expect(summarize(states)).toEqual({ done: 2, failed: 1, pending: 0 });
    // Every item was running once before it finished, one at a time.
    expect(snapshots.filter((s) => s.filter((x) => x.status === 'running').length > 1)).toHaveLength(0);
    expect(snapshots.map((s) => s.findIndex((x) => x.status === 'running')).filter((i) => i >= 0)).toEqual([0, 1, 2]);
    // Retrying only touches the failed item.
    const retried = retryFailed(states);
    expect(retried.map((s) => s.status)).toEqual(['done', 'pending', 'done']);
    documents.set('broken.png', imageDocument(4, 4, 9));
    const again = await runBatch(retried, settingsOf(null), services);
    expect(again.map((s) => s.status)).toEqual(['done', 'done', 'done']);
    expect(services.opened).toEqual(['a.png', 'broken.png', 'c.png', 'broken.png']);
  });

  it('cancels mid-queue, keeps the rest pending, and resumes with the same numbering', async () => {
    const names = ['1.png', '2.png', '3.png', '4.png'];
    const documents = new Map(names.map((name, i) => [name, imageDocument(6, 4, i)]));
    const written = new Map<string, ExportFile>();
    const abort = new AbortController();
    // Cancelled while the second file is being exported (the encoder rejects with AbortError).
    const services = memoryServices(documents, written, { beforeExport: (name) => { if (name === '2') abort.abort(); } });
    const settings = settingsOf(null, { pattern: 'Serie-{index}' });
    const states = await runBatch(names.map((n) => pendingState(fileItem(n))), settings, services, { signal: abort.signal });
    expect(states.map((s) => s.status)).toEqual(['done', 'pending', 'pending', 'pending']);
    expect([...written.keys()]).toEqual(['Serie-1.png']);
    expect(services.opened).toEqual(['1.png', '2.png']);
    const resumed = await runBatch(states, settings, memoryServices(documents, written));
    expect(resumed.map((s) => s.status)).toEqual(['done', 'done', 'done', 'done']);
    expect([...written.keys()]).toEqual(['Serie-1.png', 'Serie-2.png', 'Serie-3.png', 'Serie-4.png']);
  });

  it('exports each file with the recipe applied, through the export pipeline', async () => {
    const document = imageDocument(20, 14, 5);
    const written = new Map<string, ExportFile>();
    const services = memoryServices(new Map([['photo.jpg', document]]), written);
    const names = await processBatchItem(fileItem('photo.jpg'), 1, 1, settingsOf(brighten), services, new AbortController().signal);
    expect(names).toEqual(['photo.png']);
    const png = decodePng(written.get('photo.png')!.bytes);
    expect([png.width, png.height]).toEqual([20, 14]);
    // The same pixels as the recipe applied to the layer in the editor and exported there.
    const expected = applyRecipeToLayers(document, ['pixels'], brighten).document;
    const request: ExportRequest = { targets: [{ kind: 'document' }], format: 'png' };
    const reference = renderExportItem(expected, planExport(expected, request)[0]!, request, renderer);
    expect(png.data).toEqual(reference);
    // …and not the untouched image.
    const plain = renderExportItem(document, planExport(document, request)[0]!, request, renderer);
    expect(png.data).not.toEqual(plain);
  });

  it('crops, resizes and names every size of an item', async () => {
    const recipe = createRecipe('Web', brighten.steps, { crop: { width: 1, height: 1 }, resize: { mode: 'longEdge', pixels: 16 } });
    const written = new Map<string, ExportFile>();
    const services = memoryServices(new Map([['wide.png', imageDocument(40, 20, 2)]]), written);
    const settings = settingsOf(recipe, { pattern: '{name}_{w}x{h}', export: { format: 'png', sizes: [{ scale: 1 }, { scale: 2 }] } });
    const names = await processBatchItem(fileItem('wide.png'), 1, 1, settings, services, new AbortController().signal);
    expect(names).toEqual(['wide_16x16.png', 'wide_32x32@2x.png']);
    expect(names.map((n) => [written.get(n)!.width, written.get(n)!.height])).toEqual([[16, 16], [32, 32]]);
  });

  it('flattens a multi-layer file (and an artboard) before the recipe goes on', async () => {
    const back = layerOf('back', gradient(16, 16, 7));
    const spot = layerOf('spot', Raster.fromPixels(4, 4, 4, new Uint8Array(64).fill(255)), 6, 6);
    const document: CanvasDocument = { id: 'psd', width: 16, height: 16, resolution: 72, selection: null, layers: [back, spot],
      artboards: [{ id: 'ab', name: 'Post', rect: { x: 4, y: 4, width: 8, height: 8 }, background: { red: 1, green: 1, blue: 1, alpha: 1 }, colorLabel: 'none' }] };
    const written = new Map<string, ExportFile>();
    const services = memoryServices(new Map([['layers.psd', document]]), written);
    await processBatchItem(fileItem('layers.psd'), 1, 1, settingsOf(brighten), services, new AbortController().signal);
    const flat = await flattenTarget(document, { kind: 'document' }, renderer, false);
    expect(flat.layers).toHaveLength(1);
    const expected = applyRecipeToLayers(flat, [flat.layers[0]!.id], brighten).document;
    const request: ExportRequest = { targets: [{ kind: 'document' }], format: 'png' };
    expect(decodePng(written.get('layers.png')!.bytes).data).toEqual(renderExportItem(expected, planExport(expected, request)[0]!, request, renderer));
    // An artboard of the open document: flattened to its own size.
    const artboardServices: BatchServices = { ...services, open: async () => ({ document, target: { kind: 'artboard', id: 'ab' }, name: 'Post' }) };
    const [name] = await processBatchItem({ id: 'ab', name: 'Post', source: { kind: 'artboard', id: 'ab' } }, 1, 1, settingsOf(brighten), artboardServices,
      new AbortController().signal);
    expect([written.get(name!)!.width, written.get(name!)!.height]).toEqual([8, 8]);
  });

  it('collects the files of a run in one ZIP when the host has no folder picker', async () => {
    let saved: { blob: Blob; name: string } | null = null;
    const destination = zipDestination('Batch export.zip', async (blob, name) => { saved = { blob, name }; });
    const file = (bytes: number[]): ExportFile => ({ name: 'x', mime: 'image/png', bytes: new Uint8Array(bytes), width: 1, height: 1, bitDepth: 8,
      item: null as never, warnings: [] });
    const signal = new AbortController().signal;
    expect(await destination.write('a.png', file([1, 2, 3]), signal)).toBe('a.png');
    expect(await destination.write('a.png', file([4, 5]), signal)).toBe('a 2.png');
    await destination.finish();
    expect(saved!.name).toBe('Batch export.zip');
    const entries: [string, number[]][] = [];
    for await (const entry of readZipEntries(saved!.blob)) {
      const parts: number[] = [];
      for await (const chunk of entry.chunks) parts.push(...chunk);
      entries.push([entry.name, parts]);
    }
    expect(entries).toEqual([['a.png', [1, 2, 3]], ['a 2.png', [4, 5]]]);
  });
});
