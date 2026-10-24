import { expect, test } from '@playwright/test';

test('A3 GPU and CPU float pipelines retain a 16-bit adjusted gradient where RGBA8 bands', async ({ page }) => {
  await page.goto('/?harness=gpu');
  const result = await page.evaluate(async () => {
    // Browser-evaluated Vite modules cannot carry their TypeScript declarations across Playwright's RPC boundary.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const [{ GpuCompositor }, { compositeRegionFloat }, { applyAdjustment }, adjustments,
      { newLayer }, { makeTransform }, { Raster }] = await Promise.all([
      load('/src/render/gpuCompositor.ts'), load('/src/core/composite.ts'), load('/src/core/adjust/apply.ts'),
      load('/src/core/adjustments.ts'), load('/src/core/document.ts'), load('/src/core/geometry.ts'),
      load('/src/core/raster.ts'),
    ]);
    const width = 4096;
    const makeDocument = (bits: 8 | 16) => {
      const maximum = bits === 16 ? 65535 : 255;
      const pixels = bits === 16 ? new Uint16Array(width * 4) : new Uint8Array(width * 4);
      for (let x = 0; x < width; x++) {
        const value = Math.round(x / (width - 1) * maximum), offset = x * 4;
        pixels[offset] = value; pixels[offset + 1] = value; pixels[offset + 2] = value; pixels[offset + 3] = maximum;
      }
      const transform = makeTransform({ x: 0, y: 0 }, { width, height: 1 }, { sampling: 'Nearest' });
      const base = newLayer({ id: `gradient-${bits}`, name: 'gradient', transform,
        raster: Raster.fromPixels(width, 1, 4, pixels, { format: bits === 16 ? 'rgba16' : 'rgba8' }) });
      const levelRange = adjustments.defaultLevelRange;
      const levels = { ...adjustments.defaultAdjustment('Levels', { red: 0, green: 0, blue: 0 }, { red: 1, green: 1, blue: 1 }),
        parameters: { channel: 'RGB', ranges: [{ ...levelRange(), black: 24, gamma: 0.58, white: 238 },
          levelRange(), levelRange(), levelRange()] } };
      const points = [{ x: 0, y: 0 }, { x: 48, y: 6 }, { x: 112, y: 44 },
        { x: 176, y: 224 }, { x: 224, y: 250 }, { x: 255, y: 255 }];
      const identity = [{ x: 0, y: 0 }, { x: 255, y: 255 }];
      const curves = { ...adjustments.defaultAdjustment('Curves', { red: 0, green: 0, blue: 0 }, { red: 1, green: 1, blue: 1 }),
        parameters: { channel: 'RGB', channels: [points, identity, identity, identity] } };
      return { id: `banding-${bits}`, width, height: 1, resolution: 72, selection: null, layers: [base,
        newLayer({ id: `levels-${bits}`, name: 'levels', transform, adjustment: levels }),
        newLayer({ id: `curves-${bits}`, name: 'curves', transform, adjustment: curves }),
      ] };
    };
    const metrics = (rgba: Float32Array) => {
      const levels = new Set<number>();
      let maxStep = 0, zeroSteps = 0, previous = -1;
      for (let x = 0; x < width; x++) {
        const value = rgba[x * 4]!;
        levels.add(Math.round(value * 65535));
        if (x) {
          const step = Math.abs(value - previous);
          if (step === 0) zeroSteps++;
          maxStep = Math.max(maxStep, step);
        }
        previous = value;
      }
      return { distinct: levels.size, maxStep, zeroSteps };
    };
    const documents = { rgba8: makeDocument(8), rgba16: makeDocument(16) };
    const cpu = {
      rgba8: compositeRegionFloat(documents.rgba8, { x: 0, y: 0, width, height: 1 }, { adjust: applyAdjustment }).rgba,
      rgba16: compositeRegionFloat(documents.rgba16, { x: 0, y: 0, width, height: 1 }, { adjust: applyAdjustment }).rgba,
    };
    const canvas = document.createElement('canvas'); document.body.append(canvas);
    const gpu = await GpuCompositor.create(canvas, 1, 1);
    const floatTargets = gpu.floatTargets;
    const gpu8 = gpu.readRegionFloat(documents.rgba8, 0, 0, width, 1);
    const gpu16 = gpu.readRegionFloat(documents.rgba16, 0, 0, width, 1);
    gpu.destroy();
    return { floatTargets, cpu: { rgba8: metrics(cpu.rgba8), rgba16: metrics(cpu.rgba16) },
      gpu: { rgba8: metrics(gpu8), rgba16: metrics(gpu16) } };
  });
  console.log('A3 banding metrics', JSON.stringify(result));
  expect(result.floatTargets).toBe(true);
  for (const pipeline of [result.cpu, result.gpu]) {
    expect(pipeline.rgba8.distinct).toBeLessThanOrEqual(256);
    expect(pipeline.rgba8.zeroSteps).toBeGreaterThan(3000);
    expect(pipeline.rgba16.distinct).toBeGreaterThan(1500);
    expect(pipeline.rgba16.zeroSteps).toBeLessThan(pipeline.rgba8.zeroSteps / 2);
    expect(pipeline.rgba16.maxStep).toBeLessThanOrEqual(1 / 255 + 0.0001);
  }
});

test('semi-transparent 16-bit layers composite the same on the GPU as on the CPU (premultiplied upload)', async ({ page }) => {
  await page.goto('/?harness=gpu16alpha');
  const result = await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const { GpuCompositor } = await load('/src/render/gpuCompositor.ts');
    const { compositeRegionFloat } = await load('/src/core/composite.ts');
    const { Raster } = await load('/src/core/raster.ts');
    const { newLayer } = await load('/src/core/document.ts');
    const { makeTransform } = await load('/src/core/geometry.ts');
    const w = 64, h = 16, back = new Uint16Array(w * h * 4), front = new Uint16Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      back.set([12000, 40000, 65535, 65535], o);
      front.set([Math.round(x / w * 65535), 65535 - y * 4000, 20000, Math.round((x + y * w) / (w * h) * 65535)], o);
    }
    const layer = (id: string, data: Uint16Array) => newLayer({ id, name: id, raster: Raster.fromPixels(w, h, 4, data, { format: 'rgba16' }),
      transform: makeTransform({ x: 0, y: 0 }, { width: w, height: h }) });
    const doc = { id: 'd', width: w, height: h, resolution: 72, selection: null, layers: [layer('back', back), layer('front', front)] };
    const cpu = compositeRegionFloat(doc, { x: 0, y: 0, width: w, height: h }).rgba as Float32Array;
    const canvas = document.createElement('canvas'); document.body.append(canvas);
    const gpu = await GpuCompositor.create(canvas, 1, 1);
    const out = gpu.readRegionFloat(doc, 0, 0, w, h) as Float32Array;
    gpu.destroy();
    let max = 0;
    for (let i = 0; i < out.length; i++) max = Math.max(max, Math.abs(out[i]! - cpu[i]!));
    return { max };
  });
  console.log('16-bit alpha GPU vs CPU max', result.max);
  expect(result.max).toBeLessThan(2 / 255);
});
