import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const CMYK = path.resolve('tests/fixtures/psd/corpus/blend-modes/cmyk-blend-modes.psd');

test('CMYK brush, adjustment and filter previews remain GPU-native', async ({ page }) => {
  await page.goto('/?harness=gpu');
  const source = Array.from(fs.readFileSync(CMYK));
  const result = await page.evaluate(async (fixture) => {
    const load = (module: string): Promise<any> => import(/* @vite-ignore */ module);
    const [{ GpuCompositor, DEFAULT_HOOKS }, { Raster }, { newLayer }, { makeTransform }, brush, filters,
      { cpuCompositeRegion }, { readPsdDocumentManaged }] = await Promise.all([
      load('/src/render/gpuCompositor.ts'), load('/src/core/raster.ts'), load('/src/core/document.ts'),
      load('/src/core/geometry.ts'), load('/src/core/brush/index.ts'), load('/src/core/filters/live.ts'),
      load('/src/render/cpuRender.ts'), load('/src/io/psd/reader.ts'),
    ]);
    const imported = await readPsdDocumentManaged(new Uint8Array(fixture));
    const transfer = imported.document.psdCmykTransfer;
    if (!transfer) throw new Error('Managed fixture has no CMYK transfer');
    const width = 96, height = 96, transform = makeTransform({ x: 0, y: 0 }, { width, height });
    const pixels = (offset: number) => {
      const data = new Uint8Array(width * height * 4);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const at = (y * width + x) * 4;
        data[at] = (offset + x * 3 + y) & 255; data[at + 1] = (offset * 3 + x + y * 2) & 255;
        data[at + 2] = (offset * 5 + (x ^ y)) & 255; data[at + 3] = 255;
      }
      return Raster.fromPixels(width, height, 4, data);
    };
    const background = newLayer({ id: 'background', name: 'Background', transform, raster: pixels(17) });
    const difference = newLayer({ id: 'difference', name: 'Difference', transform,
      raster: pixels(79), blendMode: 'difference' });
    const paint = newLayer({ id: 'paint', name: 'Paint', transform, raster: null });
    const baseDocument = { id: 'preview-cmyk', width, height, resolution: 300, selection: null,
      psdColorMode: 4, psdCmykTransfer: transfer, layers: [background, difference, paint] };
    const black = new Uint8Array(width * height * 4);
    for (let index = 3; index < black.length; index += 4) black[index] = 255;
    const brushBackground = newLayer({ id: 'brush-background', name: 'Brush background', transform,
      raster: Raster.fromPixels(width, height, 4, black) });
    const brushDocument = { ...baseDocument, id: 'brush-cmyk', layers: [brushBackground, paint] };
    const canvas = globalThis.document.createElement('canvas'); globalThis.document.body.append(canvas);
    const gpu = await GpuCompositor.create(canvas, width, height);
    const view = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
    const baseBefore = gpu.readView(baseDocument, width, height, view, 1);
    const before = gpu.readView(brushDocument, width, height, view, 1);

    const stroke = new brush.RecordedBrushStroke({ layer: paint, canvas: { width, height }, settings: {
      ...brush.DEFAULT_BRUSH_SETTINGS, diameter: 19, hardness: 1, opacity: 1,
      red: 0.9, green: 0.15, blue: 0.35,
    } });
    for (const point of [{ x: 12, y: 24 }, { x: 36, y: 50 }, { x: 68, y: 32 }, { x: 86, y: 72 }]) {
      stroke.addPoints([point]);
    }
    const live = gpu.readView(brushDocument, width, height, view, 1, { ...DEFAULT_HOOKS, brush: stroke.gpuPreview });
    const exactRaster = stroke.currentRaster(), exactTransform = stroke.currentTransform();
    const exact = gpu.readView(brushDocument, width, height, view, 1, { ...DEFAULT_HOOKS,
      transform: (layer: any) => layer.id === paint.id ? exactTransform : DEFAULT_HOOKS.transform(layer),
      raster: (layer: any) => layer.id === paint.id ? exactRaster : layer.raster, brush: null });
    stroke.cancel();

    const invert = Object.assign({ kind: 'Invert', schemaVersion: 1, parameters: {} },
      { psdColorMode: 4, psdBitsPerChannel: 8, psdCmykTransfer: transfer });
    const adjustment = newLayer({ id: 'adjustment', name: 'Invert', transform, adjustment: invert });
    const adjustedDocument = { ...baseDocument, id: 'adjusted-cmyk', layers: [...baseDocument.layers, adjustment] };
    const adjustedGpu = gpu.readView(adjustedDocument, width, height, view, 1);
    const adjustedCpu = cpuCompositeRegion(adjustedDocument, { x: 0, y: 0, width, height });

    const blur = { ...filters.defaultLiveFilter('gaussianBlur'), radius: 1.25 };
    const filteredDifference = { ...difference, filters: [blur] };
    const filteredDocument = { ...baseDocument, id: 'filtered-cmyk', layers: [background, filteredDifference, paint] };
    const filteredGpu = gpu.readView(filteredDocument, width, height, view, 1);
    const filteredCpu = cpuCompositeRegion(filteredDocument, { x: 0, y: 0, width, height });
    const compare = (actual: Uint8Array, expected: Uint8Array) => {
      let maximum = 0, changed = 0;
      for (let index = 0; index < actual.length; index++) {
        const delta = Math.abs(actual[index]! - expected[index]!);
        maximum = Math.max(maximum, delta); if (delta) changed++;
      }
      return { maximum, changed };
    };
    const comparePremultiplied = (actual: Uint8Array, expected: Uint8Array) => {
      let maximum = 0, changed = 0;
      for (let index = 0; index < actual.length; index++) {
        const channel = index & 3;
        const a = channel === 3 ? actual[index]! : actual[index]! * actual[index | 3]! / 255;
        const e = channel === 3 ? expected[index]! : expected[index]! * expected[index | 3]! / 255;
        const delta = Math.abs(a - e); maximum = Math.max(maximum, delta); if (delta) changed++;
      }
      return { maximum, changed };
    };
    const painted = compare(live, before), brushExact = comparePremultiplied(live, exact);
    const counters = gpu.performanceCounters;
    gpu.destroy(); canvas.remove();
    return { painted, brushExact, adjustment: compare(adjustedGpu, adjustedCpu),
      filter: compare(filteredGpu, filteredCpu), filterEffect: compare(filteredGpu, baseBefore), counters };
  }, source);
  expect(result.painted.changed, JSON.stringify(result)).toBeGreaterThan(0);
  expect(result.brushExact.maximum, JSON.stringify(result)).toBeLessThanOrEqual(2);
  expect(result.adjustment.maximum, JSON.stringify(result)).toBeLessThanOrEqual(1);
  expect(result.filter.maximum, JSON.stringify(result)).toBeLessThanOrEqual(1);
  expect(result.filterEffect.changed, JSON.stringify(result)).toBeGreaterThan(0);
  expect(result.counters.nativeCmykFrames).toBeGreaterThanOrEqual(5);
  expect(result.counters.cpuDocumentFallbacks).toBe(0);
});
