import { expect, test } from '@playwright/test';

const EXPECTED_VECTOR_SHA256 = 'a23be007056cc04d679179f3f3090a930681930f33c2d42ba849f75cf7a1e19b';

test('vector rendering is deterministic, zoom-rasterized and 1,000-anchor cached p95 <= 16 ms', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/');
  const result = await page.evaluate(async () => {
    type TextModule = typeof import('../../src/text');
    type VectorModule = typeof import('../../src/core/vector');
    const loadText = (url: string): Promise<TextModule> => import(/* @vite-ignore */ url) as Promise<TextModule>;
    const loadVector = (url: string): Promise<VectorModule> => import(/* @vite-ignore */ url) as Promise<VectorModule>;
    const [{ loadTextEngine }, vector] = await Promise.all([
      loadText('/src/text/index.ts'), loadVector('/src/core/vector/index.ts'),
    ]);
    const engine = await loadTextEngine();
    const primitives = [
      vector.rectanglePath(96, 80, [4, 12, 20, 8]), vector.ellipsePath(96, 80),
      vector.polygonPath(96, 80, 7, 3), vector.starPath(96, 80, 5, 0.45, 2), vector.linePath(96, 80),
    ];
    const style = { schemaVersion: 1 as const,
      fill: { kind: 'gradient' as const, schemaVersion: 1 as const, angle: 23, stops: [
        { offset: 0, color: { red: 1, green: 0.1, blue: 0 }, opacity: 1 },
        { offset: 1, color: { red: 0, green: 0.2, blue: 1 }, opacity: 0.8 },
      ] },
      stroke: { color: { red: 0.1, green: 0.9, blue: 0.3 }, width: 5, alignment: 'center' as const,
        cap: 'round' as const, join: 'bevel' as const, dash: [9, 4], dashOffset: 2,
        startMarker: 'circle' as const, endMarker: 'arrow' as const, markerSize: 3 } };
    const outputs = primitives.map((primitive) => vector.renderVector(engine, [primitive], style, 120, 100));
    const bytes = new Uint8Array(outputs.reduce((total, raster) => total + raster.toPixels().length, 0));
    let offset = 0;
    for (const raster of outputs) { const pixels = raster.toPixels(); bytes.set(pixels, offset); offset += pixels.length; }
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hash = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');

    const thousand = vector.polygonPath(256, 256, 1000), paths = [thousand];
    const perfStyle = { schemaVersion: 1 as const, fill: { kind: 'solid' as const, schemaVersion: 1 as const,
      color: { red: 0.25, green: 0.5, blue: 0.75 } }, stroke: null };
    vector.renderVector(engine, paths, perfStyle, 256, 256);
    const times: number[] = [];
    for (let i = 0; i < 100; i++) {
      const start = performance.now(); vector.renderVector(engine, paths, perfStyle, 256, 256); times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    const coldTimes: number[] = [];
    for (let i = 0; i < 20; i++) {
      const start = performance.now(); vector.renderVector(engine, [thousand], perfStyle, 256, 256); coldTimes.push(performance.now() - start);
    }
    coldTimes.sort((a, b) => a - b);
    const one = vector.renderVector(engine, paths, perfStyle, 256, 256, 1);
    const two = vector.renderVector(engine, paths, perfStyle, 256, 256, 2);
    engine.dispose();
    return { hash, p95: times[Math.floor(times.length * 0.95)]!, coldP95: coldTimes[Math.floor(coldTimes.length * 0.95)]!,
      sizes: [[one.width, one.height], [two.width, two.height]] };
  });
  console.log(`${test.info().project.name} vector hash ${result.hash}, 1,000-anchor p95 cached ${result.p95.toFixed(3)} ms, cold ${result.coldP95.toFixed(3)} ms`);
  expect(result.hash).toBe(EXPECTED_VECTOR_SHA256);
  expect(result.p95).toBeLessThanOrEqual(16);
  expect(result.sizes).toEqual([[256, 256], [512, 512]]);
});

test('GPU compositor applies a vector mask without a raster mask', async ({ page }) => {
  await page.goto('/?harness=gpu');
  const alpha = await page.evaluate(async () => {
    const load = (url: string): Promise<any> => import(/* @vite-ignore */ url);
    const [{ loadTextEngine }, vector, { GpuCompositor }, { vectorCompositeHooks }, { newLayer }, { makeTransform }] = await Promise.all([
      load('/src/text/index.ts'), load('/src/core/vector/index.ts'), load('/src/render/gpuCompositor.ts'),
      load('/src/render/vectorRasterCache.ts'), load('/src/core/document.ts'), load('/src/core/geometry.ts'),
    ]);
    const engine = await loadTextEngine(), canvas = document.createElement('canvas'); document.body.append(canvas);
    const layer = newLayer({ id: 'v', name: 'Vector', kind: 'vector',
      transform: makeTransform({ x: 0, y: 0 }, { width: 20, height: 10 }), paths: [vector.rectanglePath(20, 10)],
      style: { schemaVersion: 1, fill: { kind: 'solid', schemaVersion: 1, color: { red: 1, green: 0, blue: 0 } }, stroke: null },
      vectorMask: { schemaVersion: 1, enabled: true, inverted: false, density: 1, feather: 0,
        paths: [vector.rectanglePath(10, 10)] } });
    const cache = new vector.VectorRasterCache(engine); cache.prepare([layer], 1);
    const gpu = await GpuCompositor.create(canvas, 4, 4);
    const pixels = gpu.readRegion({ id: 'd', width: 20, height: 10, resolution: 72, layers: [layer], selection: null },
      0, 0, 20, 10, vectorCompositeHooks(cache));
    const result = [pixels[(5 * 20 + 5) * 4 + 3], pixels[(5 * 20 + 15) * 4 + 3]];
    gpu.destroy(); engine.dispose(); return result;
  });
  expect(alpha).toEqual([255, 0]);
});
