import { expect, test } from '@playwright/test';
import { mountForTest } from './helpers';

test('P2 Basic, LUT and Colour GPU programs stay within one RGBA8 step of CPU', async ({ page }) => {
  await page.goto('/?harness=gpu-adjust-p2');
  const results = await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const [{ GpuCompositor }, { applyAdjustment }, { Raster }, { newLayer }, { makeTransform }, adjustments] = await Promise.all([
      load('/src/render/gpuCompositor.ts'), load('/src/core/adjust/apply.ts'), load('/src/core/raster.ts'),
      load('/src/core/document.ts'), load('/src/core/geometry.ts'), load('/src/core/adjustments.ts'),
    ]);
    const width = 8, height = 4, pixels = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) pixels.set([(i * 43) % 256, (i * 79) % 256, (i * 131) % 256, 255], i * 4);
    const cube = new TextEncoder().encode('LUT_3D_SIZE 2\n0 0 0\n1 0 .1\n0 1 0\n1 1 .1\n.1 0 1\n1 0 1\n.1 1 1\n1 1 1\n');
    const resources = [{ id: 'lut', role: 'lut', mime: 'application/x-cube', bytes: cube }];
    const colour = adjustments.defaultColour();
    const settings = [
      { kind: 'Basic', schemaVersion: 1, parameters: { ...adjustments.defaultBasic(), exposure: 0.6, contrast: 22,
        highlights: -18, shadows: 25, vibrance: 30, temperature: 15 } },
      { kind: 'Colour Lookup', schemaVersion: 1, parameters: { resourceId: 'lut', interpolation: 'tetrahedral' } },
      { kind: 'Colour', schemaVersion: 1, parameters: { ...colour, colourBalance: { ...colour.colourBalance, enabled: true,
        shadows: { cyanRed: 15, magentaGreen: -5, yellowBlue: 10 } }, selectiveColour: { mode: 'relative',
        ranges: { Reds: { cyan: -20, magenta: 10, yellow: 5, black: 0 } } } } },
    ];
    const canvas = document.createElement('canvas'); document.body.append(canvas);
    const gpu = await GpuCompositor.create(canvas, width, height), transform = makeTransform({ x: 0, y: 0 }, { width, height });
    const output = [];
    for (const adjustment of settings) {
      const base = newLayer({ id: `base-${adjustment.kind}`, name: 'base', raster: Raster.fromPixels(width, height, 4, pixels), transform });
      const live = newLayer({ id: `live-${adjustment.kind}`, name: adjustment.kind, adjustment, transform });
      const documentValue = { id: 'p2', width, height, resolution: 72, layers: [base, live], resources, selection: null };
      const fromGpu = gpu.readRegion(documentValue, 0, 0, width, height);
      const input = new Float32Array(pixels.length); for (let i = 0; i < pixels.length; i++) input[i] = pixels[i]! / 255;
      const fromCpu = Array.from(applyAdjustment(adjustment, input, width, height, 0, 0, resources), (v: number) => Math.round(v * 255));
      output.push({ kind: adjustment.kind, gpu: Array.from(fromGpu), cpu: fromCpu });
    }
    gpu.destroy(); return output;
  }) as { kind: string; gpu: number[]; cpu: number[] }[];
  for (const result of results) result.gpu.forEach((value, index) => {
    expect(Math.abs(value - result.cpu[index]!), `${result.kind} channel ${index}`).toBeLessThanOrEqual(1);
  });
});

test('live unsharp stack is rendered by GPU and software compositors without baking', async ({ page }) => {
  await page.goto('/?harness=live-filter-p2');
  const result = await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const [{ GpuCompositor }, { SoftwareCompositor }, { Raster }, { newLayer }, { makeTransform }] = await Promise.all([
      load('/src/render/gpuCompositor.ts'), load('/src/render/softwareCompositor.ts'), load('/src/core/raster.ts'),
      load('/src/core/document.ts'), load('/src/core/geometry.ts'),
    ]);
    const pixels = new Uint8Array(9 * 4);
    for (let x = 0; x < 9; x++) pixels.set([x < 4 ? 30 : 180, x < 4 ? 30 : 180, x < 4 ? 30 : 180, 255], x * 4);
    const raster = Raster.fromPixels(9, 1, 4, pixels), transform = makeTransform({ x: 0, y: 0 }, { width: 9, height: 1 });
    const layer = newLayer({ id: 'filtered', name: 'filtered', raster, transform,
      filters: [{ kind: 'unsharpMask', schemaVersion: 1, enabled: true, amount: 120, radius: 1, threshold: 0 }] });
    const documentValue = { id: 'filters', width: 9, height: 1, resolution: 72, layers: [layer], selection: null };
    const gpuCanvas = document.createElement('canvas'), cpuCanvas = new OffscreenCanvas(9, 1);
    const gpu = await GpuCompositor.create(gpuCanvas, 9, 1), software = await SoftwareCompositor.create(cpuCanvas, 9, 1);
    const a = gpu.readRegion(documentValue, 0, 0, 9, 1), b = software.readRegion(documentValue, 0, 0, 9, 1);
    gpu.destroy(); software.destroy(); return { gpu: Array.from(a), cpu: Array.from(b), stored: Array.from(layer.raster.toPixels()) };
  });
  expect(result.gpu).toEqual(result.cpu);
  expect(result.gpu).not.toEqual(result.stored);
});

test('Dodge, Burn and Sponge GPU previews match CPU replay and worker commit', async ({ page }) => {
  await mountForTest(page);
  await page.waitForFunction(() => !!(window as any).__editorForTests?.canvasView?.gpu);
  const results = await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const [brush, { Raster }] = await Promise.all([
      load('/src/core/brush/index.ts'), load('/src/core/raster.ts'),
    ]);
    const editor = (window as any).__editorForTests, session = editor.session, gpu = editor.canvasView.gpu;
    const size = 64, bytes = new Uint8Array(size * size * 4);
    for (let i = 0; i < size * size; i++) bytes.set([48 + i % 96, 90, 160, 255], i * 4);
    const output: { mode: string; previewMax: number; commitMax: number }[] = [];
    for (const mode of ['dodge', 'burn', 'sponge'] as const) {
      session.createNewProject(size, size);
      session.tool = 'brush';
      const layer = session.activeLayer;
      session.replaceDocument({ ...session.document, layers: [{ ...layer,
        raster: Raster.fromPixels(size, size, 4, bytes) }] });
      const settings = { ...brush.DEFAULT_BRUSH_SETTINGS, mode, diameter: 19, hardness: 0.55,
        opacity: 0.72, range: 'midtones', exposure: 0.6, spongeMode: 'saturate', flow: 0.65, vibrance: true };
      brush.beginBrushStroke(session, { x: 20.5, y: 20.5 }, { settings });
      brush.extendBrushStroke(session, { x: 43.5, y: 43.5 });
      const cpu = brush.currentBrushPreview(session), active = brush.currentGpuBrushPreview(session);
      const hooks = { transform: (value: any) => value.transform, raster: (value: any) => value.raster,
        maskRaster: (value: any) => value.mask?.raster ?? null, maskPlacement: () => null,
        blendMode: (value: any) => value.blendMode, brush: active };
      const live = gpu.readRegion(session.document, 0, 0, size, size, hooks);
      const expected = gpu.readRegion(session.document, 0, 0, size, size, { ...hooks, brush: null,
        transform: (value: any) => value.id === cpu.layerId ? cpu.transform : value.transform,
        raster: (value: any) => value.id === cpu.layerId ? cpu.raster : value.raster });
      brush.finishBrushStroke(session);
      await brush.waitForBrushStroke(session);
      const committed = gpu.readRegion(session.document, 0, 0, size, size);
      let previewMax = 0, commitMax = 0;
      for (let i = 0; i < live.length; i++) {
        const difference = Math.abs(live[i] - expected[i]);
        previewMax = Math.max(previewMax, difference);
        commitMax = Math.max(commitMax, Math.abs(committed[i] - expected[i]));
      }
      output.push({ mode, previewMax, commitMax });
    }
    return output;
  }) as { mode: string; previewMax: number; commitMax: number }[];
  console.log('P2 brush mode parity', results);
  for (const result of results) {
    expect(result.previewMax, `${result.mode} live preview`).toBeLessThanOrEqual(2);
    expect(result.commitMax, `${result.mode} worker commit`).toBe(0);
  }
});
