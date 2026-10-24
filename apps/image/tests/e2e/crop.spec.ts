import { expect, test } from '@playwright/test';
import { encodePng } from '../../src/io/png';
import { exportedPixels, importThroughMenu, mountForTest } from './helpers';

function colourStrip(): Buffer {
  return Buffer.from(encodePng(Uint8Array.from([
    255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255,
  ]), 4, 1, 4));
}

test('Crop defaults to preserving pixels and a larger second crop restores them', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await mountForTest(page, { locale: 'de' });
  await page.getByTestId('widthInput').fill('4');
  await page.getByTestId('heightInput').fill('1');
  await page.getByTestId('createCanvas').click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Ablage', exact: true }).click();
  await page.getByRole('menuitem', { name: /Bilder importieren/ }).click();
  await (await chooser).setFiles([{ name: 'farben.png', mimeType: 'image/png', buffer: colourStrip() }]);

  await page.getByTestId('tool-crop').click();
  const deletion = page.getByTestId('delete-cropped-pixels');
  await expect(deletion).not.toBeChecked();
  await expect(deletion.locator('..')).toContainText('Ausgeschnittene Pixel löschen');
  await page.evaluate(() => {
    const session = (window as any).__editorForTests.session;
    session.cropRect = { x: 1, y: 0, width: 2, height: 1 }; session.notify('document');
  });
  await expect.poll(() => page.evaluate(() => (window as any).__editorForTests.session.cropRect))
    .toEqual({ x: 1, y: 0, width: 2, height: 1 });
  await page.getByTestId('applyCrop').click();
  await expect(page.getByTestId('canvasDimensions')).toHaveText('2 × 1 px');
  const cropped = await exportedPixels(page);
  expect(cropped).toEqual({ width: 2, height: 1, data: [0, 255, 0, 255, 0, 0, 255, 255] });

  await page.getByTestId('tool-crop').click();
  await page.evaluate(() => {
    const session = (window as any).__editorForTests.session;
    session.cropRect = { x: -1, y: 0, width: 4, height: 1 }; session.notify('document');
  });
  await page.getByTestId('applyCrop').click();
  await expect(page.getByTestId('canvasDimensions')).toHaveText('4 × 1 px');
  const restored = await exportedPixels(page);
  expect(restored).toEqual({ width: 4, height: 1, data: [
    255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255,
  ] });

  await page.getByRole('button', { name: 'Bild', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Alles einblenden', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Ebene', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Auf Auswahl zuschneiden', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Zuschnitt entfernen', exact: true })).toBeVisible();
});

test('layer crop pixels agree between WebGL2 and the CPU renderer within one byte', async ({ page }) => {
  await page.goto('/?harness=gpu');
  const result = await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const { GpuCompositor } = await load('/src/render/gpuCompositor.ts');
    const { compositeRegion } = await load('/src/core/composite.ts');
    const { newLayer } = await load('/src/core/document.ts');
    const { makeTransform } = await load('/src/core/geometry.ts');
    const { Raster } = await load('/src/core/raster.ts');
    const width = 8, height = 6, bytes = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      bytes.set([20 + x * 20, 30 + y * 25, 180, 255], (y * width + x) * 4);
    }
    const layer = newLayer({ id: 'embedded', name: 'Embedded', kind: 'embedded',
      raster: Raster.fromPixels(width, height, 4, bytes),
      transform: makeTransform({ x: 0, y: 0 }, { width, height }, { sampling: 'Nearest' }),
      crop: { rect: { x: 1, y: 1, width: 6, height: 4 }, feather: 2 },
      content: { mode: 'embedded', mediaType: 'image', sourceName: 'test.png' } });
    const document = { id: 'crop-gpu', width, height, resolution: 72, selection: null, layers: [layer] };
    const canvas = globalThis.document.createElement('canvas'); globalThis.document.body.append(canvas);
    const gpu = await GpuCompositor.create(canvas, width, height);
    const actual = gpu.readRegion(document, 0, 0, width, height) as Uint8Array;
    const expected = compositeRegion(document, { x: 0, y: 0, width, height }).rgba as Uint8Array;
    let maximum = 0;
    for (let index = 0; index < actual.length; index++) maximum = Math.max(maximum, Math.abs(actual[index]! - expected[index]!));
    gpu.destroy();
    return { maximum, gpu: Array.from(actual), cpu: Array.from(expected) };
  }) as { maximum: number; gpu: number[]; cpu: number[] };
  expect(result.maximum).toBeLessThanOrEqual(1);
  expect(result.gpu.some((value, index) => value !== 0 && result.cpu[index] !== undefined)).toBe(true);
});

test('an active artboard is cropped without resizing the document', async ({ page }) => {
  await mountForTest(page);
  await page.getByTestId('widthInput').fill('4');
  await page.getByTestId('heightInput').fill('1');
  await page.getByTestId('createCanvas').click();
  await importThroughMenu(page, [{ name: 'strip.png', mimeType: 'image/png', buffer: colourStrip() }]);
  await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const { createArtboard } = await load('/src/core/artboardCommands.ts');
    const session = (window as any).__editorForTests.session;
    createArtboard(session, { rect: { x: 0, y: 0, width: 4, height: 1 }, name: 'Board' });
  });
  await page.getByTestId('artboard-row').click();
  await expect(page.getByTestId('artboard-row')).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId('tool-crop').click();
  await expect.poll(() => page.evaluate(() => (window as any).__editorForTests.session.cropRect))
    .toEqual({ x: 0, y: 0, width: 4, height: 1 });
  await page.evaluate(() => {
    const session = (window as any).__editorForTests.session;
    session.cropRect = { x: 1, y: 0, width: 2, height: 1 }; session.notify('document');
  });
  await expect.poll(() => page.evaluate(() => (window as any).__editorForTests.session.cropRect))
    .toEqual({ x: 1, y: 0, width: 2, height: 1 });
  await page.getByTestId('applyCrop').click();
  await expect.poll(() => page.evaluate(() => (window as any).__editorForTests.session.cropRect)).toBeNull();
  const state = await page.evaluate(() => {
    const document = (window as any).__editorForTests.session.document;
    return { width: document.width, height: document.height, rect: document.artboards[0].rect,
      origin: document.layers.find((layer: any) => layer.name === 'strip').transform.origin };
  });
  expect(state).toEqual({ width: 4, height: 1, rect: { x: 1, y: 0, width: 2, height: 1 }, origin: { x: 0, y: 0 } });
});
