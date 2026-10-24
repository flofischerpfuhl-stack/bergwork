import { expect, test } from '@playwright/test';

test('4096² Basic + LUT + Colour + live unsharp warm-frame p95', async ({ page }, info) => {
  test.setTimeout(300_000);
  await page.goto('/?harness=adjust-perf-p2');
  const result = await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const [{ GpuCompositor }, { Raster }, { newLayer }, { makeTransform }, adjustments] = await Promise.all([
      load('/src/render/gpuCompositor.ts'), load('/src/core/raster.ts'), load('/src/core/document.ts'),
      load('/src/core/geometry.ts'), load('/src/core/adjustments.ts'),
    ]);
    const size = 4096, data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4; data[i] = x & 255; data[i + 1] = y & 255; data[i + 2] = (x ^ y) & 255; data[i + 3] = 255;
    }
    const transform = makeTransform({ x: 0, y: 0 }, { width: size, height: size });
    const base = newLayer({ id: 'base', name: 'base', raster: Raster.fromPixels(size, size, 4, data), transform,
      filters: [{ kind: 'unsharpMask', schemaVersion: 1, enabled: true, amount: 80, radius: 1, threshold: 2 }] });
    const basic = newLayer({ id: 'basic', name: 'Basic', adjustment: { kind: 'Basic', schemaVersion: 1,
      parameters: { ...adjustments.defaultBasic(), exposure: 0.25, shadows: 12, vibrance: 18 } }, transform });
    const cubeBytes = new TextEncoder().encode('LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n');
    const lut = newLayer({ id: 'lut-layer', name: 'LUT', adjustment: { kind: 'Colour Lookup', schemaVersion: 1,
      parameters: { resourceId: 'lut', interpolation: 'tetrahedral' } }, transform });
    const colourSettings = adjustments.defaultColour();
    const colour = newLayer({ id: 'colour', name: 'Colour', adjustment: { kind: 'Colour', schemaVersion: 1,
      parameters: { ...colourSettings, colourBalance: { ...colourSettings.colourBalance, enabled: true,
        midtones: { cyanRed: 8, magentaGreen: -4, yellowBlue: 3 } } } }, transform });
    const documentValue = { id: 'perf', width: size, height: size, resolution: 72, layers: [base, basic, lut, colour],
      resources: [{ id: 'lut', role: 'lut', mime: 'application/x-cube', bytes: cubeBytes }], selection: null };
    const canvas = document.createElement('canvas'); document.body.append(canvas);
    const gpu = await GpuCompositor.create(canvas, 1024, 768);
    const view = { width: 1024, height: 768, viewToDoc: { a: 4, b: 0, c: 0, d: 4, tx: 0, ty: 512 }, scale: 0.25, snap: false };
    let target = gpu.composite(documentValue, view); gpu.gl.finish(); gpu.releaseTarget(target); // compile, filter, upload
    const times: number[] = [];
    for (let i = 0; i < 40; i++) { const start = performance.now(); target = gpu.composite(documentValue, view);
      gpu.gl.finish(); times.push(performance.now() - start); gpu.releaseTarget(target); }
    times.sort((a, b) => a - b);
    const gl = gpu.gl as WebGL2RenderingContext, ext = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    gpu.destroy(); return { renderer: String(renderer), median: times[20]!, p95: times[38]!, max: times[39]! };
  });
  console.log('P2 adjustment performance', JSON.stringify(result));
  expect(result.p95).toBeGreaterThan(0);
  const software = /swiftshader|llvmpipe|softpipe|software/i.test(result.renderer);
  if (info.project.name === 'perf-gpu' && !software) expect(result.p95).toBeLessThanOrEqual(16);
});
