import { expect, test, type Page } from '@playwright/test';
import { mountForTest } from './helpers';

/**
 * Engine-level export through the running editor (its real canvas renderer and export workers):
 * artboards made with the artboard commands, exported at @1x/@2x in every format and decoded again
 * with the editor's own decoders (not the browser's), so the check is the same in every browser.
 */

async function setUp(page: Page): Promise<void> {
  await mountForTest(page, { fileTargets: true });
  await page.waitForFunction(() => !!(window as any).__editorForTests?.canvasView?.gpu, null, { timeout: 30_000 });
  await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const { Raster } = await load('/src/core/raster.ts');
    const { createArtboard } = await load('/src/core/artboardCommands.ts');
    const w = window as any;
    await w.__handle.newProject({ name: 'Campaign', width: 40, height: 30 });
    const session = w.__editorForTests.session;
    const solid = (width: number, height: number, rgba: number[]) => {
      const data = new Uint8Array(width * height * 4);
      for (let i = 0; i < width * height; i++) data.set(rgba, i * 4);
      return Raster.fromPixels(width, height, 4, data);
    };
    // Post (0…40, white): red square centred at (10, 10). Story (60…100, transparent): blue bar
    // reaching into Post's area, which must not appear in Post's export.
    createArtboard(session, { rect: { x: 0, y: 0, width: 40, height: 30 }, name: 'Post' });
    createArtboard(session, { rect: { x: 60, y: 0, width: 40, height: 30 }, name: 'Story',
      background: { red: 1, green: 1, blue: 1, alpha: 0 } });
    session.setActiveLayer(null);
    session.insertRaster(solid(10, 10, [255, 0, 0, 255]), 'Red', { x: 10, y: 10 });
    session.setActiveLayer(null);
    session.insertRaster(solid(70, 6, [0, 0, 255, 255]), 'Blue', { x: 65, y: 23 });
  });
}

for (const format of ['png', 'jpeg', 'webp', 'avif', 'tiff'] as const) {
  test(`exports an artboard at @1x and @2x as ${format} and decodes it`, async ({ page }) => {
    test.setTimeout(120_000);
    await setUp(page);
    const result = await page.evaluate(async (format) => {
      const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
      const controller = (window as any).__editorForTests;
      const post = controller.session.document.artboards.find((a: { name: string }) => a.name === 'Post');
      const files = await controller.exportFiles({ targets: [{ kind: 'artboard', id: post.id }], format,
        sizes: [{ scale: 1 }, { scale: 2 }], ...(format === 'webp' ? { lossless: true } : {}), ...(format === 'avif' ? { quality: 0.95, speed: 10 } : {}) });
      const decode = async (bytes: Uint8Array, width: number, height: number): Promise<Uint8Array> => {
        if (format === 'png') return (await load('/src/io/png.ts')).decodePngNativeRGBA(bytes).data;
        if (format === 'tiff') return (await (await load('/src/io/tiff.ts')).decodeTiffNative(bytes)).data;
        if (format === 'webp') return (await load('/src/wasm/webp/index.ts')).decodeWebpWasm(bytes, width, height);
        if (format === 'avif') return (await (await load('/src/wasm/avif/index.ts')).decodeAvifWasm(bytes)).data;
        const jpeg = await (await load('/src/io/jpeg.ts')).decodeJpegSamples(bytes);
        const rgba = new Uint8Array(jpeg.width * jpeg.height * 4);
        for (let i = 0; i < jpeg.width * jpeg.height; i++) rgba.set([jpeg.data[i * 3], jpeg.data[i * 3 + 1], jpeg.data[i * 3 + 2], 255], i * 4);
        return rgba;
      };
      const out = [];
      for (const [index, file] of files.entries()) {
        const scale = index + 1, width = 40 * scale, height = 30 * scale;
        const data = await decode(file.bytes, width, height);
        const at = (x: number, y: number) => Array.from(data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4));
        out.push({ name: file.name, width: file.width, height: file.height, bytes: file.bytes.length,
          red: at(10 * scale, 10 * scale), background: at(25 * scale, 8 * scale), bar: at(35 * scale, 23 * scale) });
      }
      return out;
    }, format);
    const extension = format === 'jpeg' ? 'jpg' : format === 'tiff' ? 'tif' : format;
    expect(result.map((r) => [r.name, r.width, r.height])).toEqual([[`Post.${extension}`, 40, 30], [`Post@2x.${extension}`, 80, 60]]);
    const tolerance = format === 'png' || format === 'tiff' || format === 'webp' ? 0 : 12;
    for (const file of result) {
      for (const [actual, expected] of [[file.red, [255, 0, 0, 255]], [file.background, [255, 255, 255, 255]], [file.bar, [255, 255, 255, 255]]]) {
        actual!.forEach((value, c) => expect(Math.abs(value - expected![c]!), `${file.name} ${actual} vs ${expected}`).toBeLessThanOrEqual(tolerance));
      }
    }
  });
}

test('asks for the destination before encoding: one file by name, several as one ZIP', async ({ page }) => {
  await setUp(page);
  const writes = await page.evaluate(async () => {
    const controller = (window as any).__editorForTests;
    const ids = controller.session.document.artboards.map((a: { id: string }) => a.id);
    await controller.exportWith({ targets: [{ kind: 'artboard', id: ids[1] }], format: 'webp', sizes: [{ scale: 2 }] });
    await controller.exportWith({ targets: ids.map((id: string) => ({ kind: 'artboard', id })), format: 'png', sizes: [{ scale: 1 }, { scale: 3 }], baseName: 'Campaign' });
    return (window as any).__targetWrites;
  });
  expect(writes.map((w: { op: string; name: string; kind?: string }) => [w.op, w.name, w.kind ?? null])).toEqual([
    ['as', 'Story@2x.webp', 'webp'], ['to', 'Story@2x.webp', null], ['as', 'Campaign export.zip', 'zip'], ['to', 'Campaign export.zip', null],
  ]);
  expect(await page.evaluate(() => (window as any).__errors)).toEqual([]);
});

test('file-size preview: estimate vs real size, and cancellation', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'accuracy is measured once, in Chromium');
  test.setTimeout(180_000);
  await mountForTest(page);
  await page.waitForFunction(() => !!(window as any).__editorForTests?.canvasView?.gpu, null, { timeout: 30_000 });
  const result = await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const { Raster } = await load('/src/core/raster.ts');
    const w = window as any, controller = w.__editorForTests;
    const width = 3000, height = 2000;
    await w.__handle.newProject({ name: 'Photo', width, height });
    // Photo-like content: gradients, soft shapes and grain; plus a flat-graphics half.
    const data = new Uint8Array(width * height * 4);
    let seed = 11;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const grain = x < width / 2 ? ((seed >> 16) % 11) - 5 : 0, at = (y * width + x) * 4;
      const flat = x >= width / 2 ? ((Math.floor(x / 150) + Math.floor(y / 150)) % 2) * 120 : 0;
      data[at] = Math.max(0, Math.min(255, x * 255 / width + grain + flat));
      data[at + 1] = Math.max(0, Math.min(255, 128 + 90 * Math.sin(x / 130) * Math.cos(y / 110) + grain));
      data[at + 2] = Math.max(0, Math.min(255, y * 255 / height + grain));
      data[at + 3] = 255;
    }
    controller.session.setActiveLayer(null);
    controller.session.insertRaster(Raster.fromPixels(width, height, 4, data), 'Photo');
    const rows: Record<string, { estimate: number; real: number; ratio: number; estimateMs: number }> = {};
    for (const request of [{ format: 'png' }, { format: 'jpeg', quality: 0.85 }, { format: 'webp', quality: 0.8 }, { format: 'avif', quality: 0.6 }, { format: 'tiff' }]) {
      const full = { targets: [{ kind: 'document' }], ...request };
      const start = performance.now();
      const [estimate] = await controller.estimateExport(full);
      const estimateMs = performance.now() - start;
      const [file] = await controller.exportFiles(full);
      rows[request.format] = { estimate: estimate.bytes, real: file.bytes.length, ratio: estimate.bytes / file.bytes.length, estimateMs: Math.round(estimateMs) };
    }
    const abort = new AbortController();
    const pending = controller.estimateExport({ targets: [{ kind: 'document' }], format: 'avif', speed: 0 }, { signal: abort.signal });
    setTimeout(() => abort.abort(), 50);
    const cancelled = await pending.then(() => 'finished', (error: Error) => error.name);
    return { rows, cancelled };
  });
  console.info('File-size preview (3000×2000, half photo-like, half flat):', JSON.stringify(result.rows));
  expect(result.cancelled).toBe('AbortError');
  for (const row of Object.values(result.rows)) expect(Math.abs(row.ratio - 1)).toBeLessThan(0.25);
});

test('16-bit PNG and TIFF exports keep more than 8 bits from a 16-bit layer', async ({ page }) => {
  await mountForTest(page);
  await page.waitForFunction(() => !!(window as any).__editorForTests?.canvasView?.gpu, null, { timeout: 30_000 });
  const result = await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const { Raster } = await load('/src/core/raster.ts');
    const w = window as any, controller = w.__editorForTests;
    await w.__handle.newProject({ name: 'Deep', width: 64, height: 4 });
    // A dark 16-bit ramp: 64 steps between 8-bit codes 16 and 20 (4096 … 5120 of 65535).
    const data = new Uint16Array(64 * 4 * 4);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 64; x++) data.set([4096 + x * 16, 4096 + x * 16, 4096 + x * 16, 65535], (y * 64 + x) * 4);
    controller.session.setActiveLayer(null);
    controller.session.insertRaster(Raster.fromPixels(64, 4, 4, data, { format: 'rgba16' }), 'Ramp');
    const [png] = await controller.exportFiles({ targets: [{ kind: 'document' }], format: 'png', bitDepth: 16 });
    const [tiff] = await controller.exportFiles({ targets: [{ kind: 'document' }], format: 'tiff', bitDepth: 16, metadata: { colorProfile: 'strip' } });
    const decodedPng = (await load('/src/io/png.ts')).decodePngNativeRGBA(png.bytes);
    const decodedTiff = await (await load('/src/io/tiff.ts')).decodeTiffNative(tiff.bytes);
    const row = (data: Uint16Array) => Array.from({ length: 64 }, (_, x) => data[(64 + x) * 4]!);
    return { pngDepth: decodedPng.bitDepth, tiffDepth: decodedTiff.bitDepth, png: row(decodedPng.data), tiff: row(decodedTiff.data),
      warnings: png.warnings, renderer: controller.canvasView.rendererKind, float: !!controller.canvasView.gpu.floatTargets };
  });
  expect([result.pngDepth, result.tiffDepth]).toEqual([16, 16]);
  const distinct = (values: number[]) => new Set(values).size;
  console.info(`16-bit export: renderer ${result.renderer}, float targets ${result.float}, distinct levels PNG ${distinct(result.png)} TIFF ${distinct(result.tiff)} (8-bit would give ≤ 5)`, result.warnings);
  if (result.warnings.length === 0) {
    expect(distinct(result.png)).toBeGreaterThan(16);
    for (let x = 0; x < 64; x++) expect(Math.abs(result.png[x]! - (4096 + x * 16))).toBeLessThanOrEqual(8);
  } else expect(result.warnings[0]).toMatch(/8-bit rendering/);
  expect(result.tiff).toEqual(result.png);
});

test('large PNGs (band-parallel workers, browser zlib) decode to the exact pixels', async ({ page }) => {
  test.setTimeout(120_000);
  await mountForTest(page);
  await page.waitForFunction(() => !!(window as any).__editorForTests?.canvasView?.gpu, null, { timeout: 30_000 });
  const result = await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const { Raster } = await load('/src/core/raster.ts');
    const { hasNativeDeflate } = await load('/src/io/exportEncode.ts');
    const w = window as any, controller = w.__editorForTests;
    const width = 1500, height = 1000;
    await w.__handle.newProject({ name: 'Large', width, height });
    const data = new Uint8Array(width * height * 4);
    let seed = 5;
    for (let i = 0; i < width * height; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      data.set([(i % width) & 255, (i / width) & 255, (seed >> 16) & 255, 255], i * 4);
    }
    controller.session.setActiveLayer(null);
    controller.session.insertRaster(Raster.fromPixels(width, height, 4, data), 'Noise');
    const [file] = await controller.exportFiles({ targets: [{ kind: 'document' }], format: 'png' });
    const decoded = (await load('/src/io/png.ts')).decodePngNativeRGBA(file.bytes);
    let mismatches = 0;
    for (let i = 0; i < data.length; i++) if (decoded.data[i] !== data[i]) mismatches++;
    return { mismatches, size: [decoded.width, decoded.height], native: hasNativeDeflate(), bytes: file.bytes.length };
  });
  expect(result.size).toEqual([1500, 1000]);
  expect(result.native).toBe(true);
  expect(result.mismatches).toBe(0);
});
