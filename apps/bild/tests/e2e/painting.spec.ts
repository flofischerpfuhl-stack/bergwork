import { expect, test, type Page } from '@playwright/test';
import { exportedPixels, importThroughMenu, manifest, mountForTest, solidPng } from './helpers';

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
test.use({ viewport: { width: 1440, height: 900 } });

async function canvasMapper(page: Page, size: number) {
  const pane = (await page.getByTestId('canvas-pane').boundingBox())!;
  const zoom = parseFloat((await page.getByTestId('zoomStatus').textContent())!) / 100 / (await page.evaluate(() => devicePixelRatio));
  const origin = { x: pane.x + pane.width / 2 - size / 2 * zoom, y: pane.y + pane.height / 2 - size / 2 * zoom };
  return (x: number, y: number) => ({ x: origin.x + x * zoom, y: origin.y + y * zoom });
}

test('brush paints on the blank layer, eraser clears, shape adds a layer, gradient fills, eyedropper samples', async ({ page }) => {
  await mountForTest(page);
  await page.getByTestId('widthInput').fill('100');
  await page.getByTestId('heightInput').fill('100');
  await page.getByTestId('createCanvas').click();
  const at = await canvasMapper(page, 100);
  const px = (pixels: { width: number; data: number[] }, x: number, y: number) => pixels.data.slice((y * pixels.width + x) * 4, (y * pixels.width + x) * 4 + 4);

  // Brush (B) on the blank "Layer 1": a horizontal stroke in black, hardness 100%.
  await page.getByTestId('tool-brush').click();
  let p = at(10, 50);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  for (const x of [20, 40, 60, 80]) { p = at(x, 50); await page.mouse.move(p.x, p.y, { steps: 3 }); }
  await page.mouse.up();
  let pixels = await exportedPixels(page);
  expect(px(pixels, 50, 50)).toEqual([0, 0, 0, 255]);
  expect(px(pixels, 50, 5)[3]).toBe(0);
  let m = await manifest(page);
  expect(m.layers[0].assetId).toBeTruthy();

  // Eraser (E) through the middle of the stroke.
  await page.getByTestId('compositor-editor').press('e');
  p = at(50, 30);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  p = at(50, 70);
  await page.mouse.move(p.x, p.y, { steps: 6 });
  await page.mouse.up();
  pixels = await exportedPixels(page);
  expect(px(pixels, 50, 50)[3]).toBe(0);
  expect(px(pixels, 20, 50)[3]).toBe(255);

  // Undo restores the erased pixels.
  await page.getByTestId('compositor-editor').press(`${mod}+z`);
  pixels = await exportedPixels(page);
  expect(px(pixels, 50, 50)).toEqual([0, 0, 0, 255]);

  // Shape (U): a rectangle on a new layer.
  await page.getByTestId('tool-shape').click();
  p = at(60, 60);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  p = at(90, 90);
  await page.mouse.move(p.x, p.y, { steps: 4 });
  await page.mouse.up();
  m = await manifest(page);
  expect(m.layers).toHaveLength(2);
  expect(m.layers[1].kind).toBe('shape');
  pixels = await exportedPixels(page);
  expect(px(pixels, 75, 75)).toEqual([0, 0, 0, 255]);

  // Eyedropper samples the black stroke into the foreground colour (already black) — use a white import to check.
  await importThroughMenu(page, [{ name: 'orange.png', mimeType: 'image/png', buffer: solidPng(20, 20, [250, 117, 39, 255]) }]);
  await page.getByTestId('tool-eyedropper').click();
  p = at(50, 50);
  await page.mouse.click(p.x, p.y);
  const fg = await page.getByRole('button', { name: 'Foreground color' }).first().evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(fg).toBe('rgb(250, 117, 39)');

  // Gradient (G) on a new blank layer: foreground (orange) to transparent, left to right; Enter applies.
  await page.getByTestId('addBlankLayer').click();
  await page.getByTestId('tool-gradient').click();
  p = at(0, 10);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  p = at(100, 10);
  await page.mouse.move(p.x, p.y, { steps: 5 });
  await page.mouse.up();
  await page.getByTestId('compositor-editor').press('Enter');
  pixels = await exportedPixels(page);
  const left = px(pixels, 2, 10), right = px(pixels, 97, 10);
  expect(left[3]).toBeGreaterThan(240);
  expect(Math.abs(left[0]! - 250)).toBeLessThanOrEqual(3);
  expect(right[3]).toBeLessThan(15);
  m = await manifest(page);
  expect(m.layers).toHaveLength(4);
});

test('clone stamp copies from an Option-click source', async ({ page }) => {
  await mountForTest(page);
  await page.getByTestId('widthInput').fill('100');
  await page.getByTestId('heightInput').fill('100');
  await page.getByTestId('createCanvas').click();
  await importThroughMenu(page, [{ name: 'half.png', mimeType: 'image/png', buffer: (() => {
    // Left half red, right half white, generated independently of the editor.
    return solidPng(100, 100, [255, 255, 255, 255]);
  })() }]);
  // Paint red on the left with the brush first so the source differs from the destination.
  await page.getByTestId('tool-brush').click();
  await page.evaluate(() => { const w = window as any; void w; });
  const at = await canvasMapper(page, 100);
  let p = at(20, 20);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  p = at(22, 22);
  await page.mouse.move(p.x, p.y, { steps: 2 });
  await page.mouse.up();
  await page.getByTestId('tool-cloneStamp').click();
  p = at(20, 20);
  await page.keyboard.down('Alt');
  await page.mouse.click(p.x, p.y);
  await page.keyboard.up('Alt');
  p = at(70, 70);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  p = at(72, 72);
  await page.mouse.move(p.x, p.y, { steps: 2 });
  await page.mouse.up();
  const pixels = await exportedPixels(page);
  const c = pixels.data.slice((70 * 100 + 70) * 4, (70 * 100 + 70) * 4 + 4);
  expect(c[0]).toBeLessThan(60);
});
