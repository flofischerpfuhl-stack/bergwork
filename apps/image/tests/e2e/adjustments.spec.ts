import { expect, test, type Page } from '@playwright/test';
import { encodePng } from '../../src/io/png';
import { exportedPixels, importThroughMenu, manifest, mountForTest, solidPng } from './helpers';

test.use({ viewport: { width: 1440, height: 900 } });

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

async function canvasWith(page: Page, name: string, png: Buffer, size = 60): Promise<void> {
  await mountForTest(page);
  await page.getByTestId('widthInput').fill(String(size));
  await page.getByTestId('heightInput').fill(String(size));
  await page.getByTestId('createCanvas').click();
  await importThroughMenu(page, [{ name, mimeType: 'image/png', buffer: png }]);
  await expect.poll(async () => (await manifest(page)).layers.length).toBe(2);
}

const pixelAt = (pixels: { width: number; data: number[] }, x: number, y: number) =>
  pixels.data.slice((y * pixels.width + x) * 4, (y * pixels.width + x) * 4 + 4);

test('Levels changes the layer pixels in one undo step; Escape cancels without a trace', async ({ page }) => {
  await canvasWith(page, 'gray.png', solidPng(60, 60, [100, 100, 100, 255]));
  const editor = page.getByTestId('compositor-editor');
  await editor.press(`${mod}+l`);
  const panel = page.getByTestId('adjustment-panel');
  await expect(panel).toBeVisible();
  // The histogram arrives from the worker.
  await expect(panel.getByText('Loading histogram…')).toHaveCount(0, { timeout: 15_000 });
  // While the panel is open the document is read-only.
  expect(await page.evaluate(() => (window as any).__editorForTests.session.canEditLayers)).toBe(false);
  await page.getByTestId('levelsInputwhite').fill('200');
  // The live preview is a transient clipped GPU adjustment, not copied into the stored document.
  await expect.poll(() => page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const editing = await load('/src/core/adjust/editing.ts');
    const session = (window as any).__editorForTests.session;
    const preview = editing.documentWithPixelAdjustmentPreview(session, session.document);
    return { overrides: session.rasterOverrides.size,
      stored: session.document.layers.some((layer: any) => layer.id.startsWith('__fw-adjust-preview:')),
      preview: preview.layers.some((layer: any) => layer.id.startsWith('__fw-adjust-preview:')) };
  })).toEqual({ overrides: 0, stored: false, preview: true });
  await page.getByTestId('adjustment-ok').click();
  await expect(panel).toHaveCount(0);
  const pixels = await exportedPixels(page);
  const [r, g, b, a] = pixelAt(pixels, 30, 30);
  expect(Math.abs(r! - 128)).toBeLessThanOrEqual(1);
  expect(g).toBe(r);
  expect(b).toBe(r);
  expect(a).toBe(255);
  await editor.press(`${mod}+z`);
  expect(pixelAt(await exportedPixels(page), 30, 30)).toEqual([100, 100, 100, 255]);

  // Escape closes the panel and leaves the layer untouched.
  await editor.press(`${mod}+l`);
  await page.getByTestId('levelsInputwhite').fill('150');
  await page.getByTestId('levelsInputwhite').press('Enter');
  await editor.focus();
  await editor.press('Escape');
  await expect(panel).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__editorForTests.session.rasterOverrides.size)).toBe(0);
  expect(pixelAt(await exportedPixels(page), 30, 30)).toEqual([100, 100, 100, 255]);
});

test('a Hue/Saturation adjustment layer desaturates live and stays editable', async ({ page }) => {
  await canvasWith(page, 'red.png', solidPng(60, 60, [200, 40, 40, 255]));
  await page.getByTestId('menu-Layer').click();
  await page.getByRole('menuitem', { name: 'New Adjustment Layer' }).hover();
  await page.getByRole('menuitem', { name: 'Hue/Saturation…' }).click();
  const panel = page.getByTestId('adjustment-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('Adjustment Layer');
  await page.getByTestId('hueSaturation').fill('-100');
  await page.getByTestId('adjustment-ok').click();
  await expect(panel).toHaveCount(0);
  const m = await manifest(page);
  expect(m.layers).toHaveLength(3);
  const adjustment = m.layers[2].parameters;
  expect(adjustment.kind).toBe('Hue/Saturation');
  expect(adjustment.hsvSettings.adjustments.Master.saturation).toBe(-100);
  // The GPU export applies the adjustment: a gray of the red's lightness.
  const [r, g, b] = pixelAt(await exportedPixels(page), 30, 30);
  expect(Math.abs(r! - g!)).toBeLessThanOrEqual(1);
  expect(Math.abs(g! - b!)).toBeLessThanOrEqual(1);
  expect(Math.abs(r! - 120)).toBeLessThanOrEqual(2);

  // Double-clicking the layer reopens its panel; Cancel restores the stored settings.
  await page.getByTestId('layer-row').first().dblclick();
  await expect(panel).toBeVisible();
  await page.getByTestId('hueSaturation').fill('0');
  await expect.poll(async () => (await manifest(page)).layers[2].parameters.hsvSettings.adjustments.Master.saturation).toBe(0);
  await page.getByTestId('adjustment-cancel').click();
  await expect(panel).toHaveCount(0);
  expect((await manifest(page)).layers[2].parameters.hsvSettings.adjustments.Master.saturation).toBe(-100);
});

test('Gaussian Blur softens an edge; Curves brightens midtones on an adjustment layer', async ({ page }) => {
  const data = new Uint8Array(60 * 60 * 4);
  for (let y = 0; y < 60; y++) for (let x = 0; x < 60; x++) data.set(x < 30 ? [0, 0, 0, 255] : [255, 255, 255, 255], (y * 60 + x) * 4);
  await canvasWith(page, 'edge.png', Buffer.from(encodePng(data, 60, 60, 4)));
  await page.getByTestId('menu-Filter').click();
  await page.getByRole('menuitem', { name: 'Gaussian Blur…' }).click();
  await page.getByTestId('blurRadius').fill('4');
  await page.getByTestId('adjustment-ok').click();
  await expect(page.getByTestId('adjustment-panel')).toHaveCount(0, { timeout: 30_000 });
  let pixels = await exportedPixels(page);
  const edge = pixelAt(pixels, 30, 30)[0]!;
  expect(edge).toBeGreaterThan(40);
  expect(edge).toBeLessThan(220);
  expect(pixelAt(pixels, 5, 30)[0]).toBeLessThan(5);

  // A Curves adjustment layer: pull the midpoint up.
  await page.getByTestId('menu-Layer').click();
  await page.getByRole('menuitem', { name: 'New Adjustment Layer' }).hover();
  await page.getByRole('menuitem', { name: 'Curves…' }).click();
  const graph = page.getByTestId('curves-graph');
  const box = (await graph.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.3, { steps: 4 });
  await page.mouse.up();
  await page.getByTestId('adjustment-ok').click();
  const curve = (await manifest(page)).layers[2].parameters.curves.channels[0];
  expect(curve).toHaveLength(3);
  expect(curve[1].y).toBeGreaterThan(160);
  pixels = await exportedPixels(page);
  expect(pixelAt(pixels, 30, 30)[0]).toBeGreaterThan(edge + 20);
  expect(pixelAt(pixels, 5, 30)[0]).toBeLessThan(5);
});

test('the Levels preview reaches the screen while dragging and Escape restores it (retained frame cache)', async ({ page, browserName }) => {
  // Playwright WebKit screenshots of the WebGL canvas trail one presented frame (before/preview/OK read 89/100/127 for
  // 100/128/128 at the integration commit before the retained cache), so the on-screen check runs in Chromium and Firefox.
  test.skip(browserName === 'webkit', 'WebKit screenshots of WebGL lag one frame');
  await canvasWith(page, 'gray.png', solidPng(60, 60, [100, 100, 100, 255]));
  const centre = async (): Promise<number> => {
    // The document is centred in the work area (canvas-pane), not on the full-bleed canvas surface.
    const box = (await page.getByTestId('canvas-pane').boundingBox())!;
    const png = await page.screenshot({ clip: { x: box.x + box.width / 2 - 2, y: box.y + box.height / 2 - 2, width: 4, height: 4 } });
    return page.evaluate(async (base64) => {
      const bytes = Uint8Array.from(atob(base64), (value) => value.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = Object.assign(document.createElement('canvas'), { width: bitmap.width, height: bitmap.height });
      const context = canvas.getContext('2d')!;
      context.drawImage(bitmap, 0, 0);
      return context.getImageData(1, 1, 1, 1).data[0]!;
    }, png.toString('base64'));
  };
  await expect.poll(centre).toBeLessThan(110);
  await page.getByTestId('compositor-editor').press(`${mod}+l`);
  const panel = page.getByTestId('adjustment-panel');
  await expect(panel.getByText('Loading histogram…')).toHaveCount(0, { timeout: 15_000 });
  // White point 200: grey 100 is shown as about 128 on screen before anything is committed.
  await page.getByTestId('levelsInputwhite').fill('200');
  await expect.poll(centre, { timeout: 10_000 }).toBeGreaterThan(120);
  await page.getByTestId('compositor-editor').press('Escape');
  await expect(panel).toHaveCount(0);
  await expect.poll(centre, { timeout: 10_000 }).toBeLessThan(110);
});
