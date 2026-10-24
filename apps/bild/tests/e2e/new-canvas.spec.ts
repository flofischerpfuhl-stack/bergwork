import { expect, test, type Page } from '@playwright/test';
import { manifest, mountForTest, solidPng } from './helpers';

test.use({ viewport: { width: 1440, height: 900 } });

const session = (page: Page) => page.evaluate(() => {
  const s = (window as any).__editorForTests.session, d = s.document;
  return d ? { width: d.width, height: d.height, resolution: d.resolution, layers: d.layers.map((l: any) => l.name),
    corner: d.layers[0]?.raster ? [...d.layers[0].raster.pixel(0, 0)] : null } : null;
});

test('a preset fills the size, and a print preset switches to 300 ppi', async ({ page }) => {
  await mountForTest(page);
  await page.getByTestId('canvasPreset').selectOption('instagram-story');
  await expect(page.getByTestId('widthInput')).toHaveValue('1080');
  await expect(page.getByTestId('heightInput')).toHaveValue('1920');
  await page.getByTestId('canvasPreset').selectOption('a4');
  await expect(page.getByTestId('canvasResolution')).toHaveValue('300');
  await page.getByTestId('canvasUnit').selectOption('mm');
  await expect(page.getByTestId('widthInput')).toHaveValue('209.97');
  await expect(page.getByTestId('canvasPreset')).toHaveValue('a4');
  await expect(page.getByTestId('canvasSummary')).toContainText('2480 × 3508 px');
  await page.getByTestId('createCanvas').click();
  await expect.poll(() => session(page)).toMatchObject({ width: 2480, height: 3508, resolution: 300, layers: ['Layer 1'] });
});

test('typed centimetres follow the resolution; a black canvas starts with a Background layer', async ({ page }) => {
  await mountForTest(page);
  await page.getByTestId('canvasUnit').selectOption('cm');
  await page.getByTestId('canvasResolution').selectOption('150');
  await page.getByTestId('widthInput').fill('10');
  await page.getByTestId('heightInput').fill('5,08');
  await page.getByTestId('canvasBackground').selectOption('black');
  await expect(page.getByTestId('canvasSummary')).toContainText('Black canvas · 591 × 300 px');
  await page.getByTestId('createCanvas').click();
  await expect.poll(() => session(page)).toEqual({ width: 591, height: 300, resolution: 150, layers: ['Background'], corner: [0, 0, 0, 255] });
});

test('an image pasted on the New Canvas screen opens as the canvas', async ({ page }) => {
  await mountForTest(page);
  const png = [...solidPng(64, 48, [0, 120, 255, 255])];
  await page.evaluate((bytes) => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array(bytes)], 'image.png', { type: 'image/png' }));
    document.querySelector('[data-testid="compositor-editor"]')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
  }, png);
  await expect.poll(async () => (await session(page))?.width).toBe(64);
  expect((await session(page))!.height).toBe(48);
  expect((await manifest(page)).layers).toHaveLength(1);
});
