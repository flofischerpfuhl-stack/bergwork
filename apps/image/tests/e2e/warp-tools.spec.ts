import { expect, test } from '@playwright/test';
import { mountBare } from './qa-helpers';

test.use({ viewport: { width: 1440, height: 900 } });

test('mesh warp GPU tessellation matches the CPU inverse bicubic compositor', async ({ page }) => {
  await page.goto('/?harness=gpu');
  const result = await page.evaluate(async () => {
    const load = (module: string): Promise<any> => import(/* @vite-ignore */ module);
    const { GpuCompositor } = await load('/src/render/gpuCompositor.ts');
    const { compositeRegion } = await load('/src/core/composite.ts');
    const { newLayer } = await load('/src/core/document.ts');
    const { makeTransform } = await load('/src/core/geometry.ts');
    const { meshPreset } = await load('/src/core/meshWarp.ts');
    const { Raster } = await load('/src/core/raster.ts');
    const bytes = new Uint8Array(16 * 16 * 4);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) bytes.set([(x * 17) & 255, (y * 17) & 255, ((x + y) * 9) & 255, 255], (y * 16 + x) * 4);
    const transform = makeTransform({ x: 8, y: 8 }, { width: 16, height: 16 }, { sampling: 'High quality' });
    const layer = newLayer({ id: 'mesh', name: 'Mesh', raster: Raster.fromPixels(16, 16, 4, bytes), transform,
      warp: meshPreset(transform, 'bulge', 0.35) });
    const document = { id: 'mesh', width: 32, height: 32, resolution: 72, layers: [layer], selection: null };
    const cpu = compositeRegion(document, { x: 0, y: 0, width: 32, height: 32 }).rgba;
    const canvas = globalThis.document.createElement('canvas'); globalThis.document.body.append(canvas);
    const gpu = await GpuCompositor.create(canvas, 32, 32), gpuPixels = gpu.readRegion(document, 0, 0, 32, 32);
    gpu.destroy();
    let max = 0, mean = 0, compared = 0;
    for (let index = 0; index < cpu.length; index++) {
      if (cpu[index - index % 4 + 3] === 0 && gpuPixels[index - index % 4 + 3] === 0) continue;
      const delta = Math.abs(cpu[index]! - gpuPixels[index]!); max = Math.max(max, delta); mean += delta; compared++;
    }
    return { max, mean: mean / compared, opaque: cpu.filter((_value: number, index: number) => index % 4 === 3 && cpu[index] > 0).length };
  });
  console.log('Mesh GPU vs CPU', result);
  expect(result.opaque).toBeGreaterThan(150);
  expect(result.mean).toBeLessThanOrEqual(1.25);
  expect(result.max).toBeLessThanOrEqual(8);
});

test('Warp, Perspective, Straighten and Liquify expose working UI hooks', async ({ page }) => {
  await mountBare(page, { width: 64, height: 64 });
  await page.evaluate(async () => {
    const load = (module: string): Promise<any> => import(/* @vite-ignore */ module);
    const { Raster } = await load('/src/core/raster.ts');
    const session = (window as any).__editorForTests.session;
    const pixels = new Uint8Array(32 * 32 * 4);
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) pixels.set([x * 8, y * 8, 120, 255], (y * 32 + x) * 4);
    session.insertRaster(Raster.fromPixels(32, 32, 4, pixels), 'Package face', { x: 32, y: 32 });
  });

  await page.getByTestId('menu-Edit').click();
  await page.getByRole('menuitem', { name: /^Transform/ }).click();
  await page.getByRole('menuitem', { name: 'Warp', exact: true }).click();
  await expect(page.getByTestId('context-bar')).toContainText('Warp');
  await page.getByTestId('warp-preset').selectOption('arc');
  await expect.poll(() => page.evaluate(() => (window as any).__editorForTests.session.activeLayer.warp?.kind)).toBe('mesh');
  expect(await page.evaluate(() => (window as any).__editorForTests.session.history.undoName)).toBe('Warp');

  await page.getByTestId('menu-Edit').click();
  await page.getByRole('menuitem', { name: /^Transform/ }).click();
  await page.getByRole('menuitem', { name: 'Perspective', exact: true }).click();
  await expect(page.getByTestId('context-bar')).toContainText('Perspective');
  await page.getByRole('button', { name: 'Cancel' }).click();

  await page.getByTestId('menu-Image').click();
  await page.getByRole('menuitem', { name: 'Straighten', exact: true }).click();
  await expect(page.getByTestId('straighten-auto')).toBeVisible();

  await page.getByTestId('menu-Filter').click();
  await page.getByRole('menuitem', { name: 'Liquify…', exact: true }).click();
  await expect(page.getByTestId('liquify-panel')).toBeVisible();
  await page.getByTestId('liquify-bloat').click();
  await page.getByTestId('liquify-apply').click();
  await expect(page.getByTestId('liquify-panel')).toHaveCount(0);
});
