import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const PSD = path.resolve('tests/fixtures/psd/corpus/1layer.psd');
const PROFILE_ADJUSTMENTS = ['invert_grayscale.psd', 'invert_cmyk.psd', 'brightnesscontrast_cmyk.psd',
  'curves_cmyk.psd', 'levels_cmyk.psd', 'threshold_cmyk.psd'].map((name) =>
  path.resolve('tests/fixtures/psd/corpus/adjustments', name));
const PSD_NATIVE_GPU_FIXTURES = ['mask-density-layermask.psd', 'effects/stroke-composite.psd'].map((name) =>
  path.resolve('tests/fixtures/psd/corpus', name));
const PSD_CACHELESS_FILL = path.resolve('tests/fixtures/psd/corpus/vector-mask2.psd');

test('opens a corpus PSD through Open as a layered document', async ({ page }) => {
  // The psd-tools corpus is fetched by scripts/fetch-psd-corpus.sh and not committed (E5); without it there is nothing to open.
  test.skip(!fs.existsSync(PSD), 'PSD corpus not fetched (scripts/fetch-psd-corpus.sh)');
  await page.goto('/');
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open project' }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles(PSD);
  await page.waitForFunction(() => (window as any).__editorForTests?.session.document?.width === 101);
  const opened = await page.evaluate(() => {
    const session = (window as any).__editorForTests.session;
    const document = session.document;
    const layer = document.layers.find((candidate: any) => candidate.raster);
    return { width: document.width, height: document.height, layers: document.layers.map((candidate: any) => candidate.name),
      pixel: layer.raster.pixel(0, 0), projectName: session.projectName };
  });
  expect(opened).toEqual({ width: 101, height: 55, layers: ['Фон'], pixel: [255, 255, 255, 255], projectName: '1layer' });
});

test('PSD knockout groups and ordinary layers match on the GPU and CPU compositors', async ({ page }) => {
  await page.goto('/?harness=gpu');
  const result = await page.evaluate(async () => {
    const load = (module: string): Promise<any> => import(/* @vite-ignore */ module);
    const { GpuCompositor } = await load('/src/render/gpuCompositor.ts');
    const { compositeRegion } = await load('/src/core/composite.ts');
    const { newLayer } = await load('/src/core/document.ts');
    const { makeTransform } = await load('/src/core/geometry.ts');
    const { Raster } = await load('/src/core/raster.ts');
    const transform = makeTransform({ x: 0, y: 0 }, { width: 1, height: 1 });
    const pixel = (rgba: number[]) => Raster.fromPixels(1, 1, 4, new Uint8Array(rgba));
    const background = newLayer({ id: 'background', name: 'Background', transform,
      raster: pixel([255, 255, 255, 255]), locks: { transparency: true, pixels: false, position: false, all: false } });
    const red = newLayer({ id: 'red', name: 'Red', transform, raster: pixel([255, 0, 0, 255]) });
    const group = { ...newLayer({ id: 'group', name: 'Knockout', kind: 'group', transform, fillOpacity: 0.5 }),
      psdIsolated: true, psdKnockout: 'deep' };
    const blue = newLayer({ id: 'blue', name: 'Blue', parentId: 'group', transform, raster: pixel([0, 0, 255, 255]) });
    const deep = { id: 'psd-groups', width: 1, height: 1, resolution: 72,
      layers: [background, red, group, blue], selection: null };
    const outer = { ...newLayer({ id: 'outer', name: 'Pass through', kind: 'group', transform }), psdIsolated: false };
    const green = newLayer({ id: 'green', name: 'Green', parentId: outer.id, transform, raster: pixel([0, 255, 0, 255]) });
    const shallowGroup = { ...newLayer({ id: 'shallow', name: 'Shallow', parentId: outer.id,
      kind: 'group', transform, fillOpacity: 128 / 255 }), psdIsolated: true, psdKnockout: 'shallow' };
    const shallowBlue = newLayer({ id: 'shallow-blue', name: 'Blue', parentId: shallowGroup.id,
      transform, raster: pixel([0, 0, 255, 255]) });
    const shallow = { id: 'psd-shallow-group', width: 1, height: 1, resolution: 72,
      layers: [{ ...background, raster: pixel([255, 0, 0, 255]) }, outer, green, shallowGroup, shallowBlue], selection: null };
    const render = async (document: any) => {
      const cpu = compositeRegion(document, { x: 0, y: 0, width: 1, height: 1 }).rgba;
      const canvas = globalThis.document.createElement('canvas'); globalThis.document.body.append(canvas);
      const gpu = await GpuCompositor.create(canvas, 1, 1), gpuPixels = gpu.readRegion(document, 0, 0, 1, 1);
      gpu.destroy(); canvas.remove(); return { cpu: Array.from(cpu), gpu: Array.from(gpuPixels) };
    };
    const layerGreen = newLayer({ id: 'layer-green', name: 'Green', parentId: outer.id, transform,
      raster: pixel([0, 255, 0, 255]) });
    const layerBlue = { ...newLayer({ id: 'layer-blue', name: 'Blue', parentId: outer.id, transform,
      raster: pixel([0, 0, 255, 255]), blendMode: 'multiply' }), psdKnockout: 'shallow' };
    const ordinary = { id: 'psd-ordinary-knockout', width: 1, height: 1, resolution: 72,
      layers: [background, outer, layerGreen, layerBlue], selection: null };
    return { deep: await render(deep), shallow: await render(shallow), ordinary: await render(ordinary) };
  }) as Record<'deep' | 'shallow' | 'ordinary', { cpu: number[]; gpu: number[] }>;
  expect(result.deep.cpu).toEqual([128, 128, 255, 255]);
  expect(result.shallow.cpu).toEqual([127, 0, 128, 255]);
  expect(result.ordinary.cpu).toEqual([0, 0, 255, 255]);
  for (const pair of [result.deep, result.shallow, result.ordinary]) pair.gpu.forEach((value, index) =>
    expect(Math.abs(value - pair.cpu[index]!), `channel ${index}`).toBeLessThanOrEqual(1));
});

test('PSD native masks and clipped effects match on GPU and CPU within one byte', async ({ page }) => {
  test.skip(PSD_NATIVE_GPU_FIXTURES.some((fixture) => !fs.existsSync(fixture)), 'PSD corpus not fetched');
  await page.goto('/?harness=gpu');
  for (const fixture of PSD_NATIVE_GPU_FIXTURES) {
    const bytes = Array.from(fs.readFileSync(fixture));
    const result = await page.evaluate(async (source) => {
      const load = (module: string): Promise<any> => import(/* @vite-ignore */ module);
      const [{ GpuCompositor }, { cpuCompositeRegion }, { readPsdDocument }] = await Promise.all([
        load('/src/render/gpuCompositor.ts'), load('/src/render/cpuRender.ts'), load('/src/io/psd/reader.ts'),
      ]);
      const imported = readPsdDocument(new Uint8Array(source));
      const cpu = cpuCompositeRegion(imported.document,
        { x: 0, y: 0, width: imported.document.width, height: imported.document.height });
      const canvas = globalThis.document.createElement('canvas'); globalThis.document.body.append(canvas);
      const gpu = await GpuCompositor.create(canvas, imported.document.width, imported.document.height);
      const pixels = gpu.readRegion(imported.document, 0, 0, imported.document.width, imported.document.height);
      let maximum = 0, changed = 0, maximumIndex = 0;
      for (let index = 0; index < pixels.length; index++) {
        const pixel = index - index % 4;
        const gpuValue = index % 4 === 3 ? pixels[index]! : Math.round(pixels[index]! * pixels[pixel + 3]! / 255);
        const cpuValue = index % 4 === 3 ? cpu[index]! : Math.round(cpu[index]! * cpu[pixel + 3]! / 255);
        const difference = Math.abs(gpuValue - cpuValue);
        if (difference > maximum) { maximum = difference; maximumIndex = index; }
        if (difference) changed++;
      }
      gpu.destroy(); canvas.remove();
      const pixel = maximumIndex - maximumIndex % 4;
      return { maximum, changed, pixels: pixels.length, layers: imported.document.layers.length,
        maximumPixel: pixel / 4, gpu: Array.from(pixels.slice(pixel, pixel + 4)), cpu: Array.from(cpu.slice(pixel, pixel + 4)) };
    }, bytes);
    console.log('PSD native GPU vs CPU', path.basename(fixture), JSON.stringify(result));
    expect(result.pixels, path.basename(fixture)).toBeGreaterThan(0);
    expect(result.layers, path.basename(fixture)).toBeGreaterThan(1);
    expect(result.maximum, `${path.basename(fixture)} ${JSON.stringify(result)}`).toBeLessThanOrEqual(1);
  }
});

test('PSD cache-less generated fill matches on GPU and CPU within one output byte', async ({ page }) => {
  test.skip(!fs.existsSync(PSD_CACHELESS_FILL), 'PSD corpus not fetched');
  await page.goto('/?harness=gpu');
  const bytes = Array.from(fs.readFileSync(PSD_CACHELESS_FILL));
  const result = await page.evaluate(async (source) => {
    const load = (module: string): Promise<any> => import(/* @vite-ignore */ module);
    const [{ GpuCompositor }, { cpuCompositeRegion }, { readPsdDocument }] = await Promise.all([
      load('/src/render/gpuCompositor.ts'), load('/src/render/cpuRender.ts'), load('/src/io/psd/reader.ts'),
    ]);
    const imported = readPsdDocument(new Uint8Array(source));
    const candidates = imported.document.layers.filter((layer: any) => layer.kind === 'vector'
      && layer.raster && layer.style?.fill === null && layer.paths?.length);
    if (!candidates.length) throw new Error('No descriptor-rendered cache-less vector layer');
    const document = { ...imported.document, psdOpaqueCanvas: false,
      layers: candidates.map((layer: any) => ({ ...layer, parentId: null, maskSourceId: null })) };
    const cpu = cpuCompositeRegion(document,
      { x: 0, y: 0, width: document.width, height: document.height });
    const canvas = globalThis.document.createElement('canvas'); globalThis.document.body.append(canvas);
    const gpu = await GpuCompositor.create(canvas, document.width, document.height);
    const pixels = gpu.readRegion(document, 0, 0, document.width, document.height);
    let maximum = 0, changed = 0, nontransparent = 0;
    for (let index = 0; index < pixels.length; index++) {
      const difference = Math.abs(pixels[index]! - cpu[index]!);
      maximum = Math.max(maximum, difference);
      if (difference) changed++;
      if (index % 4 === 3 && pixels[index]) nontransparent++;
    }
    gpu.destroy(); canvas.remove();
    return { maximum, changed, nontransparent, pixels: pixels.length, candidates: candidates.length };
  }, bytes);
  console.log('PSD cache-less fill GPU vs CPU', JSON.stringify(result));
  expect(result.pixels).toBeGreaterThan(0);
  expect(result.candidates).toBeGreaterThan(0);
  expect(result.nontransparent).toBeGreaterThan(0);
  expect(result.maximum, JSON.stringify(result)).toBeLessThanOrEqual(1);
});

test('PSD profile-space adjustments agree between GPU and CPU within one byte', async ({ page }) => {
  test.skip(PROFILE_ADJUSTMENTS.some((fixture) => !fs.existsSync(fixture)), 'PSD corpus not fetched');
  for (const fixture of PROFILE_ADJUSTMENTS) {
    await page.goto('/');
    const chooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Open project' }).click();
    const chooser = await chooserPromise; await chooser.setFiles(fixture);
    await page.waitForFunction(() => (window as any).__editorForTests?.session.document?.layers
      .some((layer: any) => layer.adjustment?.psdColorMode === 1 || layer.adjustment?.psdColorMode === 4));
    const result = await page.evaluate(async () => {
      const load = (module: string): Promise<any> => import(/* @vite-ignore */ module);
      const [{ GpuCompositor }, { compositeRegion }, { cpuCompositeRegion }, { adjustmentProgram }, { Raster }, { newLayer }, { makeTransform }] = await Promise.all([
        load('/src/render/gpuCompositor.ts'), load('/src/core/composite.ts'), load('/src/render/cpuRender.ts'), load('/src/render/adjustPrograms.ts'),
        load('/src/core/raster.ts'), load('/src/core/document.ts'), load('/src/core/geometry.ts'),
      ]);
      const imported = (window as any).__editorForTests.session.document;
      const adjustmentIndex = imported.layers.findIndex((layer: any) => layer.adjustment?.psdColorMode === 1
        || layer.adjustment?.psdColorMode === 4);
      const importedAdjustment = imported.layers[adjustmentIndex].adjustment;
      const region = { x: 0, y: 0, width: imported.width, height: imported.height };
      const input = compositeRegion({ ...imported, layers: imported.layers.slice(0, adjustmentIndex) }, region).rgba;
      const transform = makeTransform({ x: 0, y: 0 }, { width: imported.width, height: imported.height });
      const base = newLayer({ id: 'profile-base', name: 'Profile base', transform,
        raster: Raster.fromPixels(imported.width, imported.height, 4, input) });
      const adjustment = newLayer({ id: 'profile-adjustment', name: 'Profile adjustment', transform,
        adjustment: importedAdjustment });
      const document = { id: 'profile-adjustment', width: imported.width, height: imported.height,
        resolution: imported.resolution, layers: [base, adjustment], selection: null };
      const cpu = cpuCompositeRegion(document, region);
      const canvas = globalThis.document.createElement('canvas'); globalThis.document.body.append(canvas);
      const gpu = await GpuCompositor.create(canvas, document.width, document.height);
      gpu.adjustmentPrograms = adjustmentProgram;
      const program = adjustmentProgram(adjustment, document), lut = program?.lut?.(adjustment);
      const pixels = gpu.readRegion(document, 0, 0, document.width, document.height);
      let maximum = 0, changed = 0, maximumIndex = 0;
      for (let index = 0; index < pixels.length; index++) {
        const difference = Math.abs(pixels[index]! - cpu[index]!);
        if (difference > maximum) { maximum = difference; maximumIndex = index; }
        if (difference) changed++;
      }
      const cpuAtMaximum = cpu[maximumIndex], gpuAtMaximum = pixels[maximumIndex];
      const diagnostics = { floatTargets: gpu.floatTargets, glError: gpu.gl.getError(), program: program?.key,
        lut: lut ? { width: lut.width, height: lut.height, first: Array.from(lut.data.slice(0, 4)),
          middle: Array.from(lut.data.slice(lut.data.length >>> 1, (lut.data.length >>> 1) + 4)) } : null,
        cpuFirst: Array.from(cpu.slice(0, 20)), gpuFirst: Array.from(pixels.slice(0, 20)),
        inputFirst: Array.from(input.slice(0, 20)) };
      gpu.destroy(); canvas.remove();
      return { maximum, changed, pixels: pixels.length, maximumIndex, cpuAtMaximum, gpuAtMaximum, diagnostics };
    });
    expect(result.pixels).toBeGreaterThan(0);
    expect(result.maximum, `${path.basename(fixture)} ${JSON.stringify(result)}`).toBeLessThanOrEqual(1);
  }
});

test('PSD opaque-canvas declarations match on GPU and CPU for an empty layer stack', async ({ page }) => {
  await page.goto('/?harness=gpu');
  const result = await page.evaluate(async () => {
    const load = (module: string): Promise<any> => import(/* @vite-ignore */ module);
    const { GpuCompositor } = await load('/src/render/gpuCompositor.ts');
    const { compositeRegion } = await load('/src/core/composite.ts');
    const render = async (opaque: boolean) => {
      const document = { id: `psd-empty-${opaque}`, width: 1, height: 1, resolution: 72,
        layers: [], selection: null, psdOpaqueCanvas: opaque };
      const cpu = compositeRegion(document, { x: 0, y: 0, width: 1, height: 1 }).rgba;
      const canvas = globalThis.document.createElement('canvas'); globalThis.document.body.append(canvas);
      const gpu = await GpuCompositor.create(canvas, 1, 1), pixels = gpu.readRegion(document, 0, 0, 1, 1);
      gpu.destroy(); canvas.remove(); return { cpu: Array.from(cpu), gpu: Array.from(pixels) };
    };
    return { opaque: await render(true), transparent: await render(false) };
  }) as Record<'opaque' | 'transparent', { cpu: number[]; gpu: number[] }>;
  expect(result.opaque.cpu).toEqual([255, 255, 255, 255]);
  expect(result.transparent.cpu).toEqual([0, 0, 0, 0]);
  for (const pair of [result.opaque, result.transparent]) {
    pair.gpu.forEach((value, index) => expect(Math.abs(value - pair.cpu[index]!), `channel ${index}`).toBeLessThanOrEqual(1));
  }
});

test('PSD Smart Object perspective quads match in GPU and CPU rendering', async ({ page }) => {
  await page.goto('/?harness=gpu');
  const result = await page.evaluate(async () => {
    const load = (module: string): Promise<any> => import(/* @vite-ignore */ module);
    const { GpuCompositor } = await load('/src/render/gpuCompositor.ts');
    const { compositeRegion } = await load('/src/core/composite.ts');
    const { newLayer } = await load('/src/core/document.ts');
    const { makeTransform } = await load('/src/core/geometry.ts');
    const { Raster } = await load('/src/core/raster.ts');
    const bytes = new Uint8Array(4 * 4 * 4);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) bytes.set([x * 70, y * 70, 180, 255], (y * 4 + x) * 4);
    const layer = newLayer({ id: 'smart', name: 'Smart Object', kind: 'embedded',
      content: { mode: 'embedded', mediaType: 'image', sourceName: 'smart.png', width: 4, height: 4 },
      raster: Raster.fromPixels(4, 4, 4, bytes),
      transform: makeTransform({ x: 0, y: 0 }, { width: 8, height: 8 }, { sampling: 'Nearest' }),
      warp: { kind: 'quad', schemaVersion: 1,
        corners: [{ x: 1, y: 1 }, { x: 7, y: 0 }, { x: 5, y: 7 }, { x: 1, y: 6 }] } });
    const document = { id: 'warp', width: 8, height: 8, resolution: 72, layers: [layer], selection: null };
    const cpu = compositeRegion(document, { x: 0, y: 0, width: 8, height: 8 }).rgba;
    const canvas = globalThis.document.createElement('canvas'); globalThis.document.body.append(canvas);
    const gpu = await GpuCompositor.create(canvas, 8, 8), gpuPixels = gpu.readRegion(document, 0, 0, 8, 8);
    gpu.destroy();
    return { cpu: Array.from(cpu), gpu: Array.from(gpuPixels) };
  }) as { cpu: number[]; gpu: number[] };
  expect(result.cpu[(3 * 8 + 3) * 4 + 3]).toBe(255);
  expect(result.cpu[(7 * 8 + 7) * 4 + 3]).toBe(0);
  result.gpu.forEach((value, index) => expect(Math.abs(value - result.cpu[index]!), `channel ${index}`).toBeLessThanOrEqual(1));
});
