import { expect, test } from '@playwright/test';

test('4096² cached drop shadow, stroke and outer glow stay within the GPU frame budget', async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto('/?harness=gpu');
  const measured = await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const { GpuCompositor } = await load('/src/render/gpuCompositor.ts');
    const { Raster, TILE } = await load('/src/core/raster.ts');
    const { newLayer } = await load('/src/core/document.ts');
    const { makeTransform } = await load('/src/core/geometry.ts');
    const side = 4096, cols = Math.ceil(side / TILE), rows = Math.ceil(side / TILE);
    const tiles: (Uint8Array | null)[] = new Array(cols * rows).fill(null);
    for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
      const tw = Math.min(TILE, side - col * TILE), th = Math.min(TILE, side - row * TILE), tile = new Uint8Array(tw * th * 4);
      for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
        const globalX = col * TILE + x, globalY = row * TILE + y, pixel = y * tw + x;
        tile[pixel * 4] = 180; tile[pixel * 4 + 1] = 90; tile[pixel * 4 + 2] = 40;
        tile[pixel * 4 + 3] = globalX >= side / 8 && globalX < side * 7 / 8
          && globalY >= side / 8 && globalY < side * 7 / 8 ? 255 : 0;
      }
      tiles[row * cols + col] = tile;
    }
    const raster = new Raster(side, side, 4, tiles);
    const effects = [
      { kind: 'dropShadow', schemaVersion: 1, enabled: true, opacity: 0.7, angle: 120, distance: 20,
        blur: 50, size: 50, spread: 15, color: { red: 0, green: 0, blue: 0 }, blendMode: 'multiply' },
      { kind: 'stroke', schemaVersion: 1, enabled: true, width: 10, position: 'outside',
        color: { red: 1, green: 0.2, blue: 0 }, blendMode: 'normal', opacity: 1 },
      { kind: 'outerGlow', schemaVersion: 1, enabled: true, opacity: 0.6, color: { red: 0.1, green: 0.4, blue: 1 },
        blendMode: 'screen', spread: 10, size: 30, contour: 'linear', noise: 0 },
    ];
    const layer = newLayer({ id: 'styled', name: 'Styled', raster, effects,
      transform: makeTransform({ x: 0, y: 0 }, { width: side, height: side }) });
    const document = { id: 'perf-effects', width: side, height: side, resolution: 72, layers: [layer], selection: null };
    const canvas = globalThis.document.createElement('canvas'); globalThis.document.body.append(canvas);
    const gpu = await GpuCompositor.create(canvas, 1000, 700);
    const view = { width: 1000, height: 700,
      viewToDoc: { a: side / 700, b: 0, c: 0, d: side / 700, tx: 0, ty: 0 }, scale: 700 / side, snap: false };
    let target = gpu.composite(document, view); gpu.gl.finish(); gpu.releaseTarget(target);
    const countersBefore = gpu.performanceCounters;
    const times: number[] = [];
    for (let i = 0; i < 60; i++) {
      const start = performance.now(); target = gpu.composite(document, view); gpu.gl.finish();
      times.push(performance.now() - start); gpu.releaseTarget(target);
    }
    const gl = gpu.gl as WebGL2RenderingContext, extension = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    const countersAfter = gpu.performanceCounters;
    times.sort((a, b) => a - b); gpu.destroy();
    return { renderer: String(renderer), median: times[Math.floor(times.length / 2)]!, p95: times[Math.floor(times.length * 0.95)]!,
      unchangedFrames: { effectRegenerations: countersAfter.effectRegenerations - countersBefore.effectRegenerations,
        textureUploads: countersAfter.textureUploads - countersBefore.textureUploads } };
  });
  console.log('Layer styles GPU performance', measured);
  expect(measured.unchangedFrames).toEqual({ effectRegenerations: 0, textureUploads: 0 });
  expect(measured.p95).toBeGreaterThan(0);
  if (!/swiftshader|llvmpipe|softpipe|software/i.test(measured.renderer)) expect(measured.p95).toBeLessThanOrEqual(16);
});
