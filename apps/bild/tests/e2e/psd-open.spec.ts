import path from 'node:path';
import { expect, test } from '@playwright/test';

const PSD = path.resolve('tests/fixtures/psd/corpus/1layer.psd');

test('opens a corpus PSD through Open as a layered document', async ({ page }) => {
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

test('PSD isolated knockout groups match on the GPU and CPU compositors', async ({ page }) => {
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
      psdIsolated: true, psdKnockout: true };
    const blue = newLayer({ id: 'blue', name: 'Blue', parentId: 'group', transform, raster: pixel([0, 0, 255, 255]) });
    const document = { id: 'psd-groups', width: 1, height: 1, resolution: 72,
      layers: [background, red, group, blue], selection: null };
    const cpu = compositeRegion(document, { x: 0, y: 0, width: 1, height: 1 }).rgba;
    const canvas = globalThis.document.createElement('canvas'); globalThis.document.body.append(canvas);
    const gpu = await GpuCompositor.create(canvas, 1, 1), gpuPixels = gpu.readRegion(document, 0, 0, 1, 1);
    gpu.destroy(); return { cpu: Array.from(cpu), gpu: Array.from(gpuPixels) };
  }) as { cpu: number[]; gpu: number[] };
  expect(result.cpu).toEqual([128, 128, 255, 255]);
  result.gpu.forEach((value, index) => expect(Math.abs(value - result.cpu[index]!), `channel ${index}`).toBeLessThanOrEqual(1));
});
