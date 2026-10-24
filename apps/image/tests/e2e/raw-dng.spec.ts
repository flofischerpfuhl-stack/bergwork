import { expect, test } from '@playwright/test';
import { makeDng } from '../helpers/dngFixture';
import { exportedPixels, importThroughMenu, manifest, mountForTest } from './helpers';

test('imports a generated lossless-JPEG Bayer DNG through RAW settings as a 16-bit layer', async ({ page }) => {
  await mountForTest(page);
  await importThroughMenu(page, [{ name: 'known-patches.dng', mimeType: 'image/x-adobe-dng', buffer: Buffer.from(makeDng('bayer', 'lossless-jpeg')) }]);
  await expect(page.getByTestId('raw-import-dialog')).toBeVisible();
  await page.getByTestId('raw-exposure').fill('0.5');
  await page.getByTestId('raw-import-apply').click();
  await expect.poll(async () => (await manifest(page)).layers.length).toBe(1);
  const state = await page.evaluate(() => {
    const controller = (window as any).__editorForTests;
    return { format: controller.session.activeLayer.raster.format, width: controller.session.document.width, height: controller.session.document.height };
  });
  expect(state).toEqual({ format: 'rgba16', width: 18, height: 10 });
  const output = await exportedPixels(page);
  const at = (x: number, y: number) => output.data.slice((y * output.width + x) * 4, (y * output.width + x) * 4 + 3);
  const red = at(2, 5), green = at(8, 5), blue = at(15, 5);
  expect(red[0]).toBeGreaterThan(red[1]! * 3); expect(red[0]).toBeGreaterThan(red[2]! * 3);
  expect(green[1]).toBeGreaterThan(green[0]! * 3); expect(green[1]).toBeGreaterThan(green[2]! * 3);
  expect(blue[2]).toBeGreaterThan(blue[0]! * 3); expect(blue[2]).toBeGreaterThan(blue[1]! * 3);
  expect(await page.evaluate(() => (window as any).__errors)).toEqual([]);
});
