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

test('Cmd-drag inside the selection moves its pixels as one undo step', async ({ page }) => {
  await mountForTest(page);
  await page.getByTestId('widthInput').fill('100');
  await page.getByTestId('heightInput').fill('100');
  await page.getByTestId('createCanvas').click();
  await importThroughMenu(page, [{ name: 'blue.png', mimeType: 'image/png', buffer: solidPng(20, 20, [0, 0, 255, 255]) }]);
  const pane = (await page.getByTestId('canvas-pane').boundingBox())!;
  const zoom = parseFloat((await page.getByTestId('zoomStatus').textContent())!) / 100 / (await page.evaluate(() => devicePixelRatio));
  const origin = { x: pane.x + pane.width / 2 - 50 * zoom, y: pane.y + pane.height / 2 - 50 * zoom };
  const at = (x: number, y: number) => ({ x: origin.x + x * zoom, y: origin.y + y * zoom });
  // The imported square sits at 40…60; select it with the marquee.
  await page.getByTestId('tool-marquee').click();
  let p = at(40, 40);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  p = at(60, 60);
  await page.mouse.move(p.x, p.y, { steps: 4 });
  await page.mouse.up();
  // Cmd/Ctrl-drag from inside by +30 px horizontally.
  p = at(50, 50);
  await page.mouse.move(p.x, p.y);
  await page.keyboard.down(mod);
  await page.mouse.down();
  p = at(80, 50);
  await page.mouse.move(p.x, p.y, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up(mod);
  let pixels = await exportedPixels(page);
  const px = (x: number, y: number) => pixels.data.slice((y * 100 + x) * 4, (y * 100 + x) * 4 + 4);
  expect(px(85, 50)).toEqual([0, 0, 255, 255]);
  expect(px(45, 50)[3]).toBe(0);
  await page.getByTestId('compositor-editor').press(`${mod}+z`);
  pixels = await exportedPixels(page);
  expect(px(45, 50)).toEqual([0, 0, 255, 255]);
  expect(px(85, 50)[3]).toBe(0);
});

test('Option-dragging a mask thumbnail onto another layer copies the mask as one undo step', async ({ page }) => {
  await mountForTest(page);
  await page.getByTestId('widthInput').fill('40');
  await page.getByTestId('heightInput').fill('40');
  await page.getByTestId('createCanvas').click();
  await importThroughMenu(page, [{ name: 'green.png', mimeType: 'image/png', buffer: solidPng(40, 40, [0, 200, 0, 255]) }]);
  await expect.poll(async () => (await manifest(page)).layers.length).toBe(2);
  const rows = page.getByTestId('layer-row');
  await rows.first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Add Black Mask' }).click();
  await expect(page.getByTestId('mask-thumb')).toHaveCount(1);
  const thumb = (await page.getByTestId('mask-thumb').boundingBox())!;
  const target = (await rows.nth(1).boundingBox())!;
  await page.keyboard.down('Alt');
  await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await expect(page.getByTestId('mask-thumb')).toHaveCount(2);
  const m = await manifest(page);
  expect(m.layers[0].mask).toBeTruthy();
  expect(m.layers[1].mask).toBeTruthy();
  expect(m.layers).toHaveLength(2);
  await page.getByTestId('compositor-editor').press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await expect(page.getByTestId('mask-thumb')).toHaveCount(1);
});

test('dragging a marquee past the canvas edge scrolls the view and keeps growing the box', async ({ page }) => {
  await mountForTest(page);
  await page.getByTestId('widthInput').fill('3000');
  await page.getByTestId('heightInput').fill('1000');
  await page.getByTestId('createCanvas').click();
  await page.evaluate(() => (window as any).__editorForTests.session.zoomTo(1));
  await page.getByTestId('tool-marquee').click();
  const pane = (await page.getByTestId('canvas-pane').boundingBox())!;
  const docX = (x: number) => page.evaluate(([vx, vy]) => {
    const s = (window as any).__editorForTests.session;
    return s.viewport.documentPoint({ x: vx, y: vy }, s.document).x;
  }, [x - pane.x, pane.height / 2]);
  const edgeBefore = await docX(pane.x + pane.width);
  await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2);
  await page.mouse.down();
  await page.mouse.move(pane.x + pane.width + 30, pane.y + pane.height / 2 + 40, { steps: 5 });
  await page.waitForTimeout(600);
  await page.mouse.up();
  const selection = await page.evaluate(() => {
    const s = (window as any).__editorForTests.session.selection;
    return { right: s.x + s.mask.width };
  });
  expect(selection.right).toBeGreaterThan(edgeBefore + 100);
});
