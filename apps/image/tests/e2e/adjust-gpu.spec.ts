import { expect, test } from '@playwright/test';

test('all live adjustment GLSL variants agree with the CPU applier', async ({ page }) => {
  await page.goto('/?harness=gpu-adjust');
  const results = await page.evaluate(async () => {
    // Runtime Vite imports inside the browser context cannot carry Node-side module types.
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const [{ GpuCompositor }, { adjustmentProgram }, { applyAdjustment }, { Raster }, { newLayer }, { makeTransform }, adjustments] = await Promise.all([
      load('/src/render/gpuCompositor.ts'), load('/src/render/adjustPrograms.ts'), load('/src/core/adjust/apply.ts'),
      load('/src/core/raster.ts'), load('/src/core/document.ts'), load('/src/core/geometry.ts'), load('/src/core/adjustments.ts'),
    ]);
    const width = 4, height = 3;
    const pixels = new Uint8Array([
      0, 0, 0, 255, 255, 255, 255, 255, 255, 0, 0, 255, 0, 255, 0, 255,
      0, 0, 255, 255, 128, 128, 128, 255, 40, 100, 220, 255, 220, 170, 20, 255,
      10, 240, 170, 255, 200, 30, 160, 255, 75, 90, 105, 255, 250, 120, 60, 255,
    ]);
    const hsv = adjustments.defaultHueSaturation(73, 28, -14);
    const settings = [
      { kind: 'Hue/Saturation', schemaVersion: 1, parameters: { hue: 73, saturation: 28, lightness: -14, colorize: false, settings: hsv } },
      (() => { const v = adjustments.defaultLevels(), r = v.ranges.slice(); r[0] = { black: 12, gamma: 1.7, white: 235, outputBlack: 5, outputWhite: 246 }; return { kind: 'Levels', schemaVersion: 1, parameters: { ...v, ranges: r } }; })(),
      (() => { const v = adjustments.defaultCurves(), c = v.channels.map((x: unknown[]) => x.slice()); c[0] = [{ x: 0, y: 10 }, { x: 80, y: 45 }, { x: 180, y: 225 }, { x: 255, y: 250 }]; return { kind: 'Curves', schemaVersion: 1, parameters: { ...v, channels: c } }; })(),
      { kind: 'Exposure', schemaVersion: 1, parameters: { exposure: 0.7, offset: 0.03, gamma: 1.3 } },
      { kind: 'Gradient Map', schemaVersion: 1, parameters: { shadows: { red: 0.8, green: 0.1, blue: 0.2 }, highlights: { red: 0.1, green: 0.6, blue: 0.9 }, reversed: false } },
      { kind: 'Grain', schemaVersion: 1, parameters: { amount: 48, size: 2.5, roughness: 35, seed: 0xf1234567 } },
    ];
    const canvas = document.createElement('canvas'); document.body.append(canvas);
    const gpu = await GpuCompositor.create(canvas, width, height); gpu.adjustmentPrograms = adjustmentProgram;
    const transform = makeTransform({ x: 0, y: 0 }, { width, height });
    const out: { kind: string; gpu: number[]; cpu: number[] }[] = [];
    for (const adjustment of settings) {
      const base = newLayer({ id: `base-${adjustment.kind}`, name: 'base', raster: Raster.fromPixels(width, height, 4, pixels), transform });
      const layer = newLayer({ id: `adjust-${adjustment.kind}`, name: adjustment.kind, adjustment, transform });
      const doc = { id: 'd', width, height, resolution: 72, layers: [base, layer], selection: null };
      const gpuBytes = gpu.readRegion(doc, 0, 0, width, height);
      const input = new Float32Array(pixels.length); for (let i = 0; i < pixels.length; i++) input[i] = pixels[i]! / 255;
      const cpuFloat = applyAdjustment(adjustment, input, width, height, 0, 0), cpu = Array.from(cpuFloat, (v: number) => Math.round(v * 255));
      out.push({ kind: adjustment.kind, gpu: Array.from(gpuBytes), cpu });
    }
    gpu.destroy(); return out;
  });
  for (const result of results) {
    expect(result.gpu.length).toBe(result.cpu.length);
    result.gpu.forEach((value, i) => expect(Math.abs(value - result.cpu[i]!), `${result.kind} channel ${i}: GPU ${value}, CPU ${result.cpu[i]}`).toBeLessThanOrEqual(2));
  }
});
