import { expect, test } from '@playwright/test';
import { encodePng } from '../../src/io/png';
import { exportedPixels, importThroughMenu, manifest, mountForTest } from './helpers';

test.use({ viewport: { width: 1440, height: 900 } });

/** 100×100: red left half, blue right half, with a 6 px black dot at (70, 50). */
function testImage(): Buffer {
  const data = new Uint8Array(100 * 100 * 4);
  for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) {
    const o = (y * 100 + x) * 4;
    const dot = Math.hypot(x - 70, y - 50) < 3;
    data.set(dot ? [0, 0, 0, 255] : x < 50 ? [220, 20, 20, 255] : [20, 20, 220, 255], o);
  }
  return Buffer.from(encodePng(data, 100, 100, 4));
}

test('magic wand selects the red half; content-aware fill and spot healing remove the dot', async ({ page }) => {
  await mountForTest(page);
  await page.getByTestId('widthInput').fill('100');
  await page.getByTestId('heightInput').fill('100');
  await page.getByTestId('createCanvas').click();
  await importThroughMenu(page, [{ name: 'halves.png', mimeType: 'image/png', buffer: testImage() }]);
  const pane = (await page.getByTestId('canvas-pane').boundingBox())!;
  const zoom = parseFloat((await page.getByTestId('zoomStatus').textContent())!) / 100 / (await page.evaluate(() => devicePixelRatio));
  const origin = { x: pane.x + pane.width / 2 - 50 * zoom, y: pane.y + pane.height / 2 - 50 * zoom };
  const at = (x: number, y: number) => ({ x: origin.x + x * zoom, y: origin.y + y * zoom });

  // Magic Wand on the red half, then Delete clears exactly that half.
  await page.getByTestId('tool-wand').click();
  let p = at(20, 20);
  await page.mouse.click(p.x, p.y);
  await expect.poll(() => page.evaluate(() => !!(window as any).__editorForTests.session.selection)).toBe(true);
  await page.getByTestId('compositor-editor').press('Backspace');
  let pixels = await exportedPixels(page);
  const px = (x: number, y: number) => pixels.data.slice((y * 100 + x) * 4, (y * 100 + x) * 4 + 4);
  expect(px(20, 20)[3]).toBe(0);
  expect(px(49, 90)[3]).toBe(0);
  expect(px(80, 20)).toEqual([20, 20, 220, 255]);
  await page.getByTestId('compositor-editor').press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');

  // Select around the dot with the marquee and run Content-Aware Fill (Shift-Delete).
  await page.getByTestId('tool-marquee').click();
  p = at(64, 44);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  p = at(76, 56);
  await page.mouse.move(p.x, p.y, { steps: 4 });
  await page.mouse.up();
  await page.getByTestId('compositor-editor').press('Shift+Backspace');
  await expect(page.getByTestId('content-fill-apply')).toBeEnabled({ timeout: 30_000 });
  await page.getByTestId('content-fill-apply').click();
  await expect(page.getByTestId('content-fill-panel')).toHaveCount(0);
  pixels = await exportedPixels(page);
  const filled = px(70, 50);
  expect(filled[2]).toBeGreaterThan(150);
  expect(filled[0]).toBeLessThan(80);
  const m = await manifest(page);
  expect(m.layers).toHaveLength(2);
  await page.getByTestId('compositor-editor').press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await page.getByTestId('compositor-editor').press(process.platform === 'darwin' ? 'Meta+d' : 'Control+d');

  // Spot Healing Brush over the dot.
  await page.getByTestId('tool-spotHealing').click();
  p = at(68, 50);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  p = at(72, 50);
  await page.mouse.move(p.x, p.y, { steps: 3 });
  await page.mouse.up();
  await expect.poll(async () => { pixels = await exportedPixels(page); return px(70, 50)[2]!; }, { timeout: 30_000 }).toBeGreaterThan(150);
});
