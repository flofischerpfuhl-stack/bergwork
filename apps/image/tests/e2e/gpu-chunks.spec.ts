import { expect, test } from '@playwright/test';

test('large raster readback stays full resolution across chunks and the device texture limit', async ({ page }) => {
  await page.goto('/?harness=gpu');
  const result = await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const [{ GpuCompositor }, { Raster }, { newLayer }, { makeTransform }, { compositeRegion }] = await Promise.all([
      load('/src/render/gpuCompositor.ts'), load('/src/core/raster.ts'), load('/src/core/document.ts'),
      load('/src/core/geometry.ts'), load('/src/core/composite.ts'),
    ]);
    const width = 10_000, height = 300;
    const pixels = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4, value = (x + y) % 2 ? 255 : 0;
      pixels[o] = value; pixels[o + 1] = 255 - value; pixels[o + 2] = value; pixels[o + 3] = 255;
    }
    const raster = Raster.fromPixels(width, height, 4, pixels);
    const layer = newLayer({ id: 'large', name: 'large', raster,
      transform: makeTransform({ x: 0, y: 0 }, { width, height }) });
    const document = { id: 'd', width, height, resolution: 72, layers: [layer], selection: null };
    const canvas = globalThis.document.createElement('canvas'); globalThis.document.body.append(canvas);
    const gpu = await GpuCompositor.create(canvas, 4, 4);
    const rendered = gpu.readRegion(document, 0, 0, width, height);
    const samples = [0, 1, 1791, 1792, 1793, 3583, 3584, 8191, 8192, 9999].map((x) => {
      const o = (137 * width + x) * 4;
      return { x, actual: Array.from(rendered.slice(o, o + 4)), expected: Array.from(pixels.slice(o, o + 4)) };
    });

    // TiledLayerTests exercises transformed pieces; compare a transformed region near the far end.
    const transformed = { ...layer, transform: makeTransform({ x: 40, y: 50 }, { width: 11_500, height: 345 },
      { rotation: 2, sampling: 'Smooth' }) };
    const transformedDocument = { ...document, width: 12_000, height: 800, layers: [transformed] };
    const region = { x: 9_300, y: 330, width: 96, height: 64 };
    const gpuRegion = gpu.readRegion(transformedDocument, region.x, region.y, region.width, region.height);
    const cpuRegion = compositeRegion(transformedDocument, region).rgba;
    let maxDiff = 0, sumDiff = 0, compared = 0;
    for (let i = 0; i < gpuRegion.length; i++) {
      const p = i - i % 4;
      if (gpuRegion[p + 3] === 0 && cpuRegion[p + 3] === 0) continue;
      const difference = Math.abs(gpuRegion[i] - cpuRegion[i]);
      maxDiff = Math.max(maxDiff, difference); sumDiff += difference; compared++;
    }
    const info = { maxTextureSize: gpu.maxTextureSize, chunks: gpu.textureChunkCount, bytes: gpu.textureBytes };
    gpu.destroy();
    return { samples, transformed: { maxDiff, meanDiff: sumDiff / Math.max(1, compared) }, info };
  });
  for (const sample of result.samples) expect(sample.actual, `x=${sample.x}`).toEqual(sample.expected);
  expect(result.transformed.meanDiff).toBeLessThan(0.5);
  expect(result.transformed.maxDiff).toBeLessThanOrEqual(4);
  expect(result.info.chunks).toBeGreaterThan(1);
  console.log('large chunks', result.info, result.transformed);
});

test('blank 12000 square raster allocates only the touched chunk', async ({ page }) => {
  await page.goto('/?harness=gpu');
  const result = await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const [{ GpuCompositor }, { Raster }, { newLayer }, { makeTransform }] = await Promise.all([
      load('/src/render/gpuCompositor.ts'), load('/src/core/raster.ts'), load('/src/core/document.ts'), load('/src/core/geometry.ts'),
    ]);
    const stroke = new Uint8Array(16 * 16 * 4); stroke.fill(255);
    const raster = Raster.blank(12_000, 12_000, 4).withRegion(100, 100, 16, 16, stroke);
    const layer = newLayer({ id: 'sparse', name: 'sparse', raster,
      transform: makeTransform({ x: 0, y: 0 }, { width: 12_000, height: 12_000 }) });
    const document = { id: 'd', width: 12_000, height: 12_000, resolution: 72, layers: [layer], selection: null };
    const canvas = globalThis.document.createElement('canvas'); globalThis.document.body.append(canvas);
    const gpu = await GpuCompositor.create(canvas, 4, 4);
    const pixel = Array.from(gpu.readRegion(document, 100, 100, 1, 1));
    const result = { pixel, chunks: gpu.textureChunkCount, bytes: gpu.textureBytes };
    gpu.destroy();
    return result;
  });
  expect(result.pixel).toEqual([255, 255, 255, 255]);
  expect(result.chunks).toBe(1);
  expect(result.bytes).toBeLessThan(100 * 1024 * 1024);
  console.log('sparse chunk', result);
});

test('chunk seams match CPU bilinear sampling at 150 and 37 percent', async ({ page }) => {
  await page.goto('/?harness=gpu');
  const results = await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const [{ GpuCompositor }, { Raster }, { newLayer }, { makeTransform }, { compositeRegion }] = await Promise.all([
      load('/src/render/gpuCompositor.ts'), load('/src/core/raster.ts'), load('/src/core/document.ts'),
      load('/src/core/geometry.ts'), load('/src/core/composite.ts'),
    ]);
    const width = 10_000, height = 8, pixels = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      pixels[o] = (x * 17 + y * 11) & 255; pixels[o + 1] = (x * 29 + 31) & 255;
      pixels[o + 2] = (x * 7 + y * 43) & 255; pixels[o + 3] = 80 + ((x * 13 + y * 5) % 176);
    }
    const raster = Raster.fromPixels(width, height, 4, pixels);
    const canvas = globalThis.document.createElement('canvas'); globalThis.document.body.append(canvas);
    const gpu = await GpuCompositor.create(canvas, 4, 4);
    const results: Array<{ zoom: number; maxDiff: number; meanDiff: number; over3: number; total: number }> = [];
    for (const zoom of [1.5, 0.37]) {
      const transformedWidth = width * zoom, transformedHeight = height * zoom;
      const layer = newLayer({ id: `seam-${zoom}`, name: 'seam', raster,
        transform: makeTransform({ x: 0, y: 2 }, { width: transformedWidth, height: transformedHeight }, { sampling: 'Smooth' }) });
      const seam = gpu.textureChunkSize * zoom;
      const region = { x: Math.floor(seam) - 20, y: 0, width: 48, height: Math.ceil(transformedHeight) + 4 };
      const document = { id: 'd', width: Math.ceil(transformedWidth), height: region.height, resolution: 72, layers: [layer], selection: null };
      const actual = gpu.readRegion(document, region.x, region.y, region.width, region.height);
      const expected = compositeRegion(document, region).rgba;
      let maxDiff = 0, sumDiff = 0, over3 = 0, total = 0;
      for (let i = 0; i < actual.length; i++) {
        const p = i - i % 4;
        if (actual[p + 3] === 0 && expected[p + 3] === 0) continue;
        const difference = Math.abs(actual[i] - expected[i]);
        maxDiff = Math.max(maxDiff, difference); sumDiff += difference; total++;
        if (difference > 3) over3++;
      }
      results.push({ zoom, maxDiff, meanDiff: sumDiff / Math.max(1, total), over3, total });
    }
    gpu.destroy();
    return results;
  });
  console.log('chunk seams', results);
  for (const result of results) {
    expect(result.maxDiff, `${result.zoom}x`).toBeLessThanOrEqual(3);
    expect(result.over3, `${result.zoom}x`).toBe(0);
  }
});
