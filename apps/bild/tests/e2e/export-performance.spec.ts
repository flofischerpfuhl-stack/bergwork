import { expect, test } from '@playwright/test';
import { mountForTest } from './helpers';

/**
 * PRODUCT-PLAN A6 export budget: a 46-megapixel PNG (Pro ≤ 3 s, Lite ≤ 8 s). Runs in the `perf-gpu`
 * project (real GPU readback): `npx playwright test tests/e2e/export-performance.spec.ts --project perf-gpu`.
 * Reports render (GPU readback), encode (band-parallel PNG workers) and end-to-end times, plus the
 * previous single-thread `encodePng` path on the same pixels for comparison.
 */
test('46 MP PNG export through the export pipeline', async ({ page }) => {
  test.setTimeout(600_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await mountForTest(page);
  await page.waitForFunction(() => !!(window as any).__editorForTests?.canvasView?.gpu, null, { timeout: 30_000 });
  const result = await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const { Raster } = await load('/src/core/raster.ts');
    const pipeline = await load('/src/io/exportPipeline.ts');
    const { workerExportEncoder } = await load('/src/workers/exportClient.ts');
    const { encodePng } = await load('/src/io/png.ts');
    const w = window as any, controller = w.__editorForTests;
    const width = 8256, height = 5568; // 45.97 MP (46 MP full-frame sensor)
    await w.__handle.newProject({ name: 'Large', width, height });
    const data = new Uint8Array(width * height * 4);
    let seed = 3;
    for (let y = 0; y < height; y++) {
      const gy = (y * 255 / height) | 0;
      for (let x = 0; x < width; x++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const grain = ((seed >> 16) & 7) - 3, at = (y * width + x) * 4;
        data[at] = Math.max(0, Math.min(255, ((x * 255 / width) | 0) + grain));
        data[at + 1] = Math.max(0, Math.min(255, 128 + ((x ^ y) & 31) + grain));
        data[at + 2] = Math.max(0, Math.min(255, gy + grain));
        data[at + 3] = 255;
      }
    }
    controller.session.setActiveLayer(null);
    controller.session.insertRaster(Raster.fromPixels(width, height, 4, data), 'Photo');
    const request = { targets: [{ kind: 'document' }], format: 'png' };
    const view = controller.canvasView;
    const renderer = { readView: (d: any, rw: number, rh: number, v: any, s: number) => view.readView(d, rw, rh, v, s) };
    const [item] = pipeline.planExport(controller.session.document, request);
    const runs: { total: number; render: number; encode: number; bytes: number }[] = [];
    let reference: Uint8Array | null = null;
    for (let run = 0; run < 3; run++) {
      const t0 = performance.now();
      const [file] = await controller.exportFiles(request);
      reference = file.bytes;
      const total = performance.now() - t0;
      const r0 = performance.now();
      const pixels = pipeline.renderExportItem(controller.session.document, item, request, renderer);
      const render = performance.now() - r0;
      const spec = { format: 'png', alpha: true, quality: 1, lossless: false, speed: 6, level: 6, tiffCompression: 'deflate', dpi: 72, icc: null, info: null };
      const e0 = performance.now();
      await workerExportEncoder.encode(pixels, width, height, spec);
      const encode = performance.now() - e0;
      runs.push({ total: Math.round(total), render: Math.round(render), encode: Math.round(encode), bytes: file.bytes.length });
    }
    let streamedBytes = 0, exact = true, chunks = 0, firstWrite = -1;
    const streamStart = performance.now();
    const streamed = await pipeline.runPngExportToSink(controller.session.document, request, renderer, async (chunk: Uint8Array) => {
      if (firstWrite < 0) firstWrite = performance.now() - streamStart;
      for (let index = 0; index < chunk.length; index++) if (chunk[index] !== reference![streamedBytes + index]) { exact = false; break; }
      streamedBytes += chunk.length; chunks++;
    });
    const streamTotal = performance.now() - streamStart;
    if (streamedBytes !== reference!.length) exact = false;
    const pixels = pipeline.renderExportItem(controller.session.document, item, request, renderer);
    const b0 = performance.now();
    const legacy = encodePng(pixels, width, height, 4, { dpi: 72 });
    const legacyEncode = performance.now() - b0;
    const [check] = await controller.exportFiles({ ...request, sizes: [{ scale: 0.05 }] });
    return { runs, stream: { total: Math.round(streamTotal), firstWrite: Math.round(firstWrite), chunks, bytes: streamedBytes,
        exact, metrics: streamed.metrics }, legacyEncode: Math.round(legacyEncode), legacyBytes: legacy.length, threads: navigator.hardwareConcurrency,
      renderer: controller.canvasView.rendererKind, checkSize: [check.width, check.height] };
  });
  console.info('46 MP PNG export (ms):', JSON.stringify(result));
  expect(result.checkSize).toEqual([413, 278]);
  expect(result.stream.exact).toBe(true);
  expect(result.stream.bytes).toBe(result.runs[0]!.bytes);
  expect(result.stream.metrics.avoidedOutputBytes).toBe(8256 * 5568 * 4);
  expect(Math.min(...result.runs.map((run) => run.total))).toBeLessThan(60_000);
});
