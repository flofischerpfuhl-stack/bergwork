import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const CMYK = path.resolve('tests/fixtures/psd/corpus/blend-modes/cmyk-blend-modes.psd');
const GRAY = path.resolve('tests/fixtures/psd/corpus/blend-modes/gray-blend-modes.psd');

test('20 MP CMYK Difference navigation stays on the GPU', async ({ page }, testInfo) => {
  const bytes = Array.from(fs.readFileSync(CMYK));
  const baseline = process.env.CMYKGPU_BASELINE === '1', rgbOnly = process.env.CMYKGPU_RGB_ONLY === '1';
  const iterations = baseline ? 2 : 24, rgbIterations = baseline && !rgbOnly ? 2 : 24;
  await page.goto('/?harness=gpu');
  const result = await page.evaluate(async ({ source, iterations, rgbIterations, baseline, rgbOnly }) => {
    const load = (module: string): Promise<any> => import(/* @vite-ignore */ module);
    const [{ GpuCompositor, DEFAULT_HOOKS }, { Raster, TILE }, { newLayer }, { makeTransform },
      { readPsdDocumentInBackground }, { installPsdColorTransfer }, brush] = await Promise.all([
      load('/src/render/gpuCompositor.ts'), load('/src/core/raster.ts'), load('/src/core/document.ts'),
      load('/src/core/geometry.ts'), load('/src/workers/psdClient.ts'), load('/src/io/psd/reader.ts'),
      load('/src/core/brush/index.ts'),
    ]);
    const setupStarted = performance.now();
    const imported = await readPsdDocumentInBackground(new Uint8Array(source));
    const documentReadyMs = performance.now() - setupStarted;
    if (!imported.colorTransferReady) throw new Error('Managed fixture has no deferred CMYK transfer');
    const width = 5_000, height = 4_000, cols = Math.ceil(width / TILE), rows = Math.ceil(height / TILE);
    const makeTile = (red: number, green: number, blue: number) => {
      const tile = new Uint8Array(TILE * TILE * 4);
      for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
        const at = (y * TILE + x) * 4;
        tile[at] = (red + x * 3 + y) & 255; tile[at + 1] = (green + x + y * 5) & 255;
        tile[at + 2] = (blue + (x ^ y)) & 255; tile[at + 3] = 255;
      }
      return tile;
    };
    const lower = new Raster(width, height, 4, new Array(cols * rows).fill(makeTile(31, 97, 181)));
    const upper = new Raster(width, height, 4, new Array(cols * rows).fill(makeTile(207, 53, 119)));
    const transform = makeTransform({ x: 0, y: 0 }, { width, height });
    const layers = [
      newLayer({ id: 'lower', name: 'Lower', raster: lower, transform }),
      newLayer({ id: 'upper', name: 'Difference', raster: upper, transform, blendMode: 'difference', opacity: 0.72 }),
    ];
    const progressiveDocument = { id: 'cmyk-gpu-20mp', width, height, resolution: 300, selection: null,
      psdColorMode: 4, psdColorTransferKey: imported.document.psdColorTransferKey,
      psdProgressivePreview: imported.document.psdProgressivePreview,
      psdOpaqueCanvas: imported.document.psdOpaqueCanvas, layers };
    const rgbDocument = { id: 'rgb-gpu-20mp', width, height, resolution: 300, selection: null, layers };
    const canvas = globalThis.document.createElement('canvas'); globalThis.document.body.append(canvas);
    const gpu = await GpuCompositor.create(canvas, 800, 640);
    const finish = (subject: any, view: any, hooks?: any) => {
      const start = performance.now(), target = gpu.composite(subject, view, hooks); gpu.gl.finish();
      const elapsed = performance.now() - start; gpu.releaseTarget(target); return elapsed;
    };
    const sorted = (values: number[]) => [...values].sort((a, b) => a - b);
    const timing = (values: number[]) => { const valuesSorted = sorted(values); return {
      median: valuesSorted[Math.floor(valuesSorted.length / 2)]!,
      p95: valuesSorted[Math.floor(valuesSorted.length * 0.95)]!, max: valuesSorted.at(-1)!,
    }; };
    const base = { width: 800, height: 640,
      viewToDoc: { a: 6.25, b: 0, c: 0, d: 6.25, tx: 0, ty: 0 }, scale: 0.16, snap: false, cache: true };
    const firstFrame = finish(progressiveDocument, base);
    const progressiveSample = Array.from(gpu.readView(progressiveDocument, 1, 1,
      { a: 1, b: 0, c: 0, d: 1, tx: 2_500, ty: 2_000 }, 1));
    const preview = progressiveDocument.psdProgressivePreview;
    const expectedProgressiveSample = preview.pixel(Math.floor(preview.width / 2), Math.floor(preview.height / 2));
    if (expectedProgressiveSample[3] === 0) expectedProgressiveSample.fill(0);
    const firstTransferUploads = gpu.performanceCounters.cmykTransferUploads;
    const ready = await imported.colorTransferReady;
    const transferReadyMs = performance.now() - setupStarted;
    const document = installPsdColorTransfer(progressiveDocument, ready);
    if (!document.psdCmykTransfer) throw new Error('CMYK transfer was not installed');
    const exactFirstFrame = finish(document, base);
    const warmStarted = performance.now();
    const warmImported = await readPsdDocumentInBackground(new Uint8Array(source));
    const warmDocumentReadyMs = performance.now() - warmStarted;
    if (!warmImported.colorTransferReady) throw new Error('Warm CMYK transfer was not deferred');
    const warmReady = await warmImported.colorTransferReady;
    const warmReadyMs = performance.now() - warmStarted;
    const coldSetup = { documentReadyMs, firstFrame, progressiveSample, expectedProgressiveSample,
      firstTransferUploads, transferReadyMs, exactFirstFrame,
      warmDocumentReadyMs, warmReadyMs, buildMs: ready.buildMs, warmBuildMs: warmReady.buildMs,
      firstCached: ready.cached, warmCached: warmReady.cached };
    if (rgbOnly) {
      const cold = finish(rgbDocument, base);
      const rgbPanValues = Array.from({ length: rgbIterations }, (_, index) => finish(rgbDocument,
        { ...base, viewToDoc: { ...base.viewToDoc, tx: 62.5 + index * 6.25, ty: 50 } }));
      const rgbPan = timing(rgbPanValues), gl = gpu.gl as WebGL2RenderingContext;
      const extension = gl.getExtension('WEBGL_debug_renderer_info');
      const renderer = String(extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
      const counters = gpu.performanceCounters; gpu.destroy(); canvas.remove();
      return { renderer, cold, coldSetup, pan: rgbPan, zoom: rgbPan, unchanged: rgbPan, rgbPan,
        brushPreview: null, sample: [0, 0, 0, 255], counters, unchangedHits: 0 };
    }
    const cold = exactFirstFrame;
    const pan: number[] = [], zoom: number[] = [];
    for (let index = 0; index < iterations; index++) {
      pan.push(finish(document,
        { ...base, viewToDoc: { ...base.viewToDoc, tx: 62.5 + index * 6.25, ty: 50 } }));
      const scale = 6.25 - (index % 6) * 0.08;
      zoom.push(finish(document,
        { ...base, viewToDoc: { a: scale, b: 0, c: 0, d: scale, tx: 120, ty: 80 }, scale: 1 / scale }));
    }
    const cachedView = base;
    finish(document, cachedView);
    const beforeHit = gpu.performanceCounters;
    const unchanged = Array.from({ length: iterations }, () => finish(document, cachedView));
    const afterHit = gpu.performanceCounters;
    const rgbPan = Array.from({ length: rgbIterations }, (_, index) => finish(rgbDocument,
      { ...base, viewToDoc: { ...base.viewToDoc, tx: 62.5 + index * 6.25, ty: 50 } }));
    let brushPreview: ReturnType<typeof timing> | null = null;
    if (!baseline) {
      const paint = newLayer({ id: 'paint', name: 'Paint', raster: Raster.fromPixels(800, 640, 4,
        new Uint8Array(800 * 640 * 4)), transform });
      const brushDocument = { ...document, id: 'cmyk-gpu-brush-20mp', layers: [...layers, paint] };
      const stroke = new brush.RecordedBrushStroke({ layer: paint, canvas: { width, height }, settings: {
        ...brush.DEFAULT_BRUSH_SETTINGS, diameter: 120, hardness: 0.7, opacity: 0.8,
        red: 0.9, green: 0.15, blue: 0.35,
      } });
      const hooks = { ...DEFAULT_HOOKS, brush: stroke.gpuPreview };
      stroke.addPoints([{ x: 320, y: 480 }]); finish(brushDocument, base, hooks);
      const brushTimes: number[] = [];
      for (let index = 0; index < iterations; index++) {
        stroke.addPoints([{ x: 400 + index * 54, y: 480 + (index % 5) * 42 }]);
        brushTimes.push(finish(brushDocument, base, hooks));
      }
      stroke.cancel(); brushPreview = timing(brushTimes);
    }
    const sample = Array.from(gpu.readView(document, 1, 1,
      { a: 1, b: 0, c: 0, d: 1, tx: 2_500, ty: 2_000 }, 1));
    const gl = gpu.gl as WebGL2RenderingContext, extension = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = String(extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    const counters = gpu.performanceCounters;
    gpu.destroy(); canvas.remove();
    return { renderer, cold, coldSetup, pan: timing(pan), zoom: timing(zoom), unchanged: timing(unchanged),
      rgbPan: timing(rgbPan), brushPreview, sample, counters,
      unchangedHits: afterHit.unchangedFrameHits - beforeHit.unchangedFrameHits };
  }, { source: bytes, iterations, rgbIterations, baseline, rgbOnly });
  console.log(`CMYKGPU ${testInfo.project.name} ${JSON.stringify(result)}`);
  expect(result.sample[3]).toBe(255);
  if (!baseline) {
    expect(result.coldSetup.firstCached).toBe(false);
    expect(result.coldSetup.warmCached).toBe(true);
    expect(result.coldSetup.warmBuildMs).toBeLessThan(5);
    expect(result.coldSetup.firstTransferUploads).toBe(0);
    expect(result.coldSetup.progressiveSample).toEqual(result.coldSetup.expectedProgressiveSample);
    expect(result.counters.progressiveColorFrames).toBeGreaterThan(0);
    expect(result.counters.progressivePreviewFrames).toBeGreaterThan(0);
    expect(result.counters.cmykTransferUploads).toBe(1);
    expect(result.counters.nativeCmykFrames).toBeGreaterThan(0);
    expect(result.counters.cpuDocumentFallbacks).toBe(0);
    expect(result.unchangedHits).toBe(iterations);
    expect(result.counters.panReprojections).toBeGreaterThanOrEqual(iterations);
  }
  const software = /swiftshader|llvmpipe|softpipe|software/i.test(result.renderer);
  if (!baseline && testInfo.project.name === 'perf-gpu' && !software) {
    expect(result.pan.p95, JSON.stringify(result)).toBeLessThanOrEqual(33);
    expect(result.zoom.p95, JSON.stringify(result)).toBeLessThanOrEqual(33);
    expect(result.brushPreview?.p95, JSON.stringify(result)).toBeLessThanOrEqual(33);
  }
});

test('20 MP grayscale setup presents progressively and reuses its profile table', async ({ page }, testInfo) => {
  const bytes = Array.from(fs.readFileSync(GRAY));
  await page.goto('/?harness=gpu');
  const result = await page.evaluate(async (source) => {
    const load = (module: string): Promise<any> => import(/* @vite-ignore */ module);
    const [{ GpuCompositor }, { Raster, TILE }, { newLayer }, { makeTransform },
      { readPsdDocumentInBackground }, { installPsdColorTransfer }, { cpuCompositeView }] = await Promise.all([
      load('/src/render/gpuCompositor.ts'), load('/src/core/raster.ts'), load('/src/core/document.ts'),
      load('/src/core/geometry.ts'), load('/src/workers/psdClient.ts'), load('/src/io/psd/reader.ts'),
      load('/src/render/cpuRender.ts'),
    ]);
    const setupStarted = performance.now();
    const imported = await readPsdDocumentInBackground(new Uint8Array(source));
    const documentReadyMs = performance.now() - setupStarted;
    if (!imported.colorTransferReady) throw new Error('Managed fixture has no deferred grayscale transfer');
    const width = 5_000, height = 4_000, cols = Math.ceil(width / TILE), rows = Math.ceil(height / TILE);
    const tile = new Uint8Array(TILE * TILE * 4);
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const at = (y * TILE + x) * 4, value = (x * 3 + y * 5) & 255;
      tile.set([value, value, value, 255], at);
    }
    const raster = new Raster(width, height, 4, new Array(cols * rows).fill(tile));
    const transform = makeTransform({ x: 0, y: 0 }, { width, height });
    const pixels = newLayer({ id: 'gray', name: 'Gray', raster, transform });
    const threshold = Object.assign({ kind: 'Threshold', schemaVersion: 1, parameters: { level: 117 } },
      { psdColorMode: 1, psdBitsPerChannel: 8 });
    const adjustment = newLayer({ id: 'threshold', name: 'Threshold', adjustment: threshold, transform });
    const progressive = { id: 'gray-cold-20mp', width, height, resolution: 300, selection: null,
      psdColorMode: 1, psdColorTransferKey: imported.document.psdColorTransferKey,
      psdProgressivePreview: imported.document.psdProgressivePreview,
      psdOpaqueCanvas: imported.document.psdOpaqueCanvas, layers: [pixels, adjustment] };
    const canvas = globalThis.document.createElement('canvas'); globalThis.document.body.append(canvas);
    const gpu = await GpuCompositor.create(canvas, 800, 640);
    const view = { width: 800, height: 640,
      viewToDoc: { a: 6.25, b: 0, c: 0, d: 6.25, tx: 0, ty: 0 }, scale: 0.16, snap: false, cache: true };
    const finish = (document: any) => { const started = performance.now(), target = gpu.composite(document, view);
      gpu.gl.finish(); const elapsed = performance.now() - started; gpu.releaseTarget(target); return elapsed; };
    const firstFrame = finish(progressive);
    const progressiveSample = Array.from(gpu.readView(progressive, 1, 1,
      { a: 1, b: 0, c: 0, d: 1, tx: 2_500, ty: 2_000 }, 1));
    const preview = progressive.psdProgressivePreview;
    const expectedProgressiveSample = preview.pixel(Math.floor(preview.width / 2), Math.floor(preview.height / 2));
    if (expectedProgressiveSample[3] === 0) expectedProgressiveSample.fill(0);
    const ready = await imported.colorTransferReady;
    const transferReadyMs = performance.now() - setupStarted;
    const exact = installPsdColorTransfer(progressive, ready);
    const exactFirstFrame = finish(exact);
    const sampleView = { a: 1, b: 0, c: 0, d: 1, tx: 2_400, ty: 1_900 };
    const actual = gpu.readView(exact, 16, 16, sampleView, 1);
    const expected = cpuCompositeView(exact, 16, 16, sampleView);
    let maximumDifference = 0;
    for (let index = 0; index < actual.length; index++) {
      maximumDifference = Math.max(maximumDifference, Math.abs(actual[index] - expected[index]));
    }
    const warmStarted = performance.now();
    const warmImported = await readPsdDocumentInBackground(new Uint8Array(source));
    const warmDocumentReadyMs = performance.now() - warmStarted;
    if (!warmImported.colorTransferReady) throw new Error('Warm grayscale transfer was not deferred');
    const warmReady = await warmImported.colorTransferReady;
    const counters = gpu.performanceCounters;
    gpu.destroy(); canvas.remove();
    return { documentReadyMs, firstFrame, progressiveSample, expectedProgressiveSample,
      transferReadyMs, exactFirstFrame, maximumDifference,
      buildMs: ready.buildMs, firstCached: ready.cached, warmDocumentReadyMs,
      warmReadyMs: performance.now() - warmStarted, warmBuildMs: warmReady.buildMs, warmCached: warmReady.cached, counters };
  }, bytes);
  console.log(`CMYKCOLD-GRAY ${testInfo.project.name} ${JSON.stringify(result)}`);
  expect(result.firstCached).toBe(false);
  expect(result.warmCached).toBe(true);
  expect(result.warmBuildMs).toBeLessThan(5);
  expect(result.progressiveSample).toEqual(result.expectedProgressiveSample);
  expect(result.maximumDifference).toBeLessThanOrEqual(1);
  expect(result.counters.progressiveColorFrames).toBeGreaterThan(0);
  expect(result.counters.progressivePreviewFrames).toBeGreaterThan(0);
  expect(result.counters.nativeGrayFrames).toBeGreaterThan(0);
});
