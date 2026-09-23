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

test('right-drag resizes the brush from its size at the press; with Shift it changes the hardness', async ({ page }) => {
  await mountForTest(page);
  await page.getByTestId('widthInput').fill('400');
  await page.getByTestId('heightInput').fill('400');
  await page.getByTestId('createCanvas').click();
  await page.getByTestId('tool-brush').click();
  const settings = () => page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const brush = await load('/src/core/brush/index.ts');
    const s = brush.getBrushSettings((window as any).__editorForTests.session);
    return { diameter: s.diameter, hardness: s.hardness };
  });
  const before = await settings();
  const ppp = await page.evaluate(() => (window as any).__editorForTests.session.viewport.pointsPerPixel);
  const pane = (await page.getByTestId('canvas-pane').boundingBox())!;
  const start = { x: pane.x + pane.width / 2, y: pane.y + pane.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(start.x + 30, start.y, { steps: 4 });
  await page.mouse.up({ button: 'right' });
  const after = await settings();
  expect(after.diameter).toBe(Math.round(before.diameter + 2 * 30 / ppp));
  expect(after.hardness).toBe(before.hardness);
  // Nothing was painted.
  expect((await manifest(page)).layers[0].assetId ?? null).toBeNull();

  await page.mouse.move(start.x, start.y);
  await page.keyboard.down('Shift');
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(start.x - 50, start.y, { steps: 4 });
  await page.mouse.up({ button: 'right' });
  await page.keyboard.up('Shift');
  const shifted = await settings();
  expect(shifted.diameter).toBe(after.diameter);
  expect(shifted.hardness).toBeCloseTo(Math.max(0, after.hardness - 50 / 200), 5);
});

test('the color picker is a panel: canvas clicks sample into it, only OK commits, shorthand hex works', async ({ page }) => {
  await mountForTest(page);
  await page.getByTestId('widthInput').fill('100');
  await page.getByTestId('heightInput').fill('100');
  await page.getByTestId('createCanvas').click();
  await importThroughMenu(page, [{ name: 'blue.png', mimeType: 'image/png', buffer: solidPng(100, 100, [20, 40, 220, 255]) }]);
  const palette = () => page.evaluate(() => {
    const c = (window as any).__editorForTests.session.paletteColor(false);
    return [c.red, c.green, c.blue].map((v: number) => Math.round(v * 255));
  });
  const before = await palette();
  await page.getByRole('button', { name: 'Foreground color' }).first().click();
  const picker = page.getByTestId('color-picker');
  await expect(picker).toBeVisible();
  // No modal backdrop: the canvas takes the click and samples the composite.
  const at = await canvasMapper(page, 100);
  const p = at(50, 50);
  await page.mouse.click(p.x, p.y);
  await expect(page.getByTestId('color-hex')).toHaveValue('1428DC');
  expect(await palette()).toEqual(before);
  await page.getByTestId('color-cancel').click();
  expect(await palette()).toEqual(before);
  // Shorthand hex, committed with OK.
  await page.getByRole('button', { name: 'Foreground color' }).first().click();
  await page.getByTestId('color-hex').fill('#f80');
  await page.getByTestId('color-hex').press('Enter');
  await page.getByTestId('color-ok').click();
  await expect(picker).toHaveCount(0);
  expect(await palette()).toEqual([255, 136, 0]);
});

test('Option with the brush samples the foreground color instead of painting', async ({ page }) => {
  await mountForTest(page);
  await page.getByTestId('widthInput').fill('100');
  await page.getByTestId('heightInput').fill('100');
  await page.getByTestId('createCanvas').click();
  await importThroughMenu(page, [{ name: 'blue.png', mimeType: 'image/png', buffer: solidPng(100, 100, [20, 40, 220, 255]) }]);
  await page.getByTestId('tool-brush').click();
  const at = await canvasMapper(page, 100);
  const p = at(50, 50);
  await page.keyboard.down('Alt');
  await page.mouse.click(p.x, p.y);
  await page.keyboard.up('Alt');
  const color = await page.evaluate(() => {
    const c = (window as any).__editorForTests.session.paletteColor(false);
    return [c.red, c.green, c.blue].map((v: number) => Math.round(v * 255));
  });
  expect(color).toEqual([20, 40, 220]);
  expect(await page.evaluate(() => (window as any).__editorForTests.session.history.canUndo)).toBe(true);
  // Only the import is undoable: nothing was painted.
  await page.getByTestId('compositor-editor').press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  expect((await manifest(page)).layers).toHaveLength(1);
});
