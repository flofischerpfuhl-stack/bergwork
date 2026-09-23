import { expect, test } from '@playwright/test';
import { exportedPixels, importThroughMenu, manifest, mountForTest, solidPng } from './helpers';

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

test.use({ viewport: { width: 1440, height: 900 } });

test('marquee selection clears and fills pixels, lasso polygon adds, all undoable', async ({ page }) => {
  await mountForTest(page);
  await page.getByTestId('widthInput').fill('100');
  await page.getByTestId('heightInput').fill('100');
  await page.getByTestId('createCanvas').click();
  await importThroughMenu(page, [{ name: 'white.png', mimeType: 'image/png', buffer: solidPng(100, 100, [255, 255, 255, 255]) }]);
  const pane = (await page.getByTestId('canvas-pane').boundingBox())!;
  const zoom = parseFloat((await page.getByTestId('zoomStatus').textContent())!) / 100 / (await page.evaluate(() => devicePixelRatio));
  const origin = { x: pane.x + pane.width / 2 - 50 * zoom, y: pane.y + pane.height / 2 - 50 * zoom };
  const at = (x: number, y: number) => ({ x: origin.x + x * zoom, y: origin.y + y * zoom });

  await page.getByTestId('tool-marquee').click();
  let p = at(10, 10);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  p = at(40, 30);
  await page.mouse.move(p.x, p.y, { steps: 5 });
  await page.mouse.up();
  // Delete clears the selected pixels of the active layer.
  await page.getByTestId('compositor-editor').press('Backspace');
  let pixels = await exportedPixels(page);
  const px = (x: number, y: number) => pixels.data.slice((y * 100 + x) * 4, (y * 100 + x) * 4 + 4);
  expect(px(20, 20)[3]).toBe(0);
  expect(px(50, 50)).toEqual([255, 255, 255, 255]);
  expect(px(5, 5)).toEqual([255, 255, 255, 255]);

  // Fill with the foreground colour (black) via the Edit menu.
  await page.getByTestId('menu-Edit').click();
  await page.getByRole('menuitem', { name: /Fill with Foreground Color/ }).click();
  pixels = await exportedPixels(page);
  expect(px(20, 20)).toEqual([0, 0, 0, 255]);

  // Polygonal lasso in Add mode: three corners and Enter.
  await page.getByTestId('tool-lasso').click();
  await page.getByRole('radio', { name: 'Polygonal' }).click();
  await page.getByRole('radio', { name: 'Add' }).click();
  for (const [x, y] of [[60, 60], [90, 60], [90, 90]] as const) { const q = at(x, y); await page.mouse.click(q.x, q.y); }
  await page.getByTestId('compositor-editor').press('Enter');
  await page.getByTestId('compositor-editor').press('Backspace');
  pixels = await exportedPixels(page);
  expect(px(85, 65)[3]).toBe(0);
  expect(px(20, 20)[3]).toBe(0);
  expect(px(62, 88)).toEqual([255, 255, 255, 255]);

  // Deselect, then undo three times brings back the black fill.
  await page.getByTestId('compositor-editor').press(`${mod}+d`);
  await page.getByTestId('compositor-editor').press(`${mod}+z`);
  await page.getByTestId('compositor-editor').press(`${mod}+z`);
  await page.getByTestId('compositor-editor').press(`${mod}+z`);
  pixels = await exportedPixels(page);
  expect(px(20, 20)).toEqual([0, 0, 0, 255]);
  expect(px(85, 65)).toEqual([255, 255, 255, 255]);
  const m = await manifest(page);
  expect(m.layers).toHaveLength(2);
});

test('add mask from a selection hides the selected area', async ({ page }) => {
  await mountForTest(page);
  await page.getByTestId('widthInput').fill('60');
  await page.getByTestId('heightInput').fill('40');
  await page.getByTestId('createCanvas').click();
  await importThroughMenu(page, [{ name: 'red.png', mimeType: 'image/png', buffer: solidPng(60, 40, [255, 0, 0, 255]) }]);
  await page.getByTestId('compositor-editor').press(`${mod}+a`);
  await page.getByTestId('addMask').click();
  const m = await manifest(page);
  expect(m.layers[1].mask).toBeTruthy();
  const pixels = await exportedPixels(page);
  // A white mask made from a selection has the selected area black: everything hidden.
  expect(pixels.data[3]).toBe(0);
});
