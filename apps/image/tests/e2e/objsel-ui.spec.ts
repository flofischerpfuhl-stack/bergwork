import { existsSync, readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { encodePng } from '../../src/io/png';
import { importThroughMenu, manifest, mountForTest, solidPng } from './helpers';

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
test.use({ viewport: { width: 1440, height: 900 } });

/**
 * The pinned SlimSAM files, verified against the manifest hashes by the browser host. Tests serve them through a
 * route instead of the network; set FERNWORK_SLIMSAM_DIR to a folder with encoder.onnx and decoder.onnx.
 */
const MODEL_DIR = process.env.FERNWORK_SLIMSAM_DIR ?? '/tmp/slimsam.batbap';
const hasModel = existsSync(`${MODEL_DIR}/encoder.onnx`) && existsSync(`${MODEL_DIR}/decoder.onnx`);

// A generated scene (no photos): a textured blue ground with a red and a yellow ellipse.
const W = 256, H = 192;
const red = (x: number, y: number) => ((x - 78) / 42) ** 2 + ((y - 98) / 36) ** 2 <= 1;
const yellow = (x: number, y: number) => ((x - 184) / 34) ** 2 + ((y - 90) / 46) ** 2 <= 1;
function scenePng(): Buffer {
  const data = new Uint8Array(W * H * 4);
  let seed = 7;
  const noise = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed % 21) - 10; };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const n = noise(), stripe = Math.sin(x / 5 + y / 9) * 8, cx = x + 0.5, cy = y + 0.5;
    const rgb = red(cx, cy) ? [222 + n, 60 + n, 44 + n] : yellow(cx, cy) ? [236 + n, 206 + n, 48 + n] : [30 + n + stripe, 76 + n + stripe, 150 + n + stripe];
    data.set([...rgb.map((v) => Math.max(0, Math.min(255, Math.round(v)))), 255], (y * W + x) * 4);
  }
  return Buffer.from(encodePng(data, W, H, 4));
}

async function openScene(page: Page, buffer: Buffer, width: number, height: number, locale: 'en' | 'de' = 'en'): Promise<void> {
  await mountForTest(page, { locale });
  await page.getByTestId('widthInput').fill(String(width));
  await page.getByTestId('heightInput').fill(String(height));
  await page.getByTestId('createCanvas').click();
  if (locale === 'de') {
    // File is „Ablage“ in the German menu bar.
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('menu-Ablage').click();
    await page.getByTestId('menu-import').click();
    await (await chooser).setFiles([{ name: 'scene.png', mimeType: 'image/png', buffer }]);
  } else await importThroughMenu(page, [{ name: 'scene.png', mimeType: 'image/png', buffer }]);
  await expect.poll(async () => (await manifest(page)).layers.length).toBe(2);
}

/** Screen position of a document point. */
async function at(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  const offset = await page.evaluate(([px, py]) => {
    const controller = (window as any).__editorForTests;
    const session = controller.session;
    return session.viewport.viewPoint({ x: px, y: py }, session.document);
  }, [x, y] as const);
  // View points start at the work area (canvas-pane); the canvas surface reaches under the floating chrome.
  const box = (await page.getByTestId('canvas-pane').boundingBox())!;
  return { x: box.x + offset.x, y: box.y + offset.y };
}

/** The selection as a document-sized byte mask (0 when there is none). */
async function selectionMask(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const session = (window as any).__editorForTests.session;
    const { width, height } = session.document, out = new Array(width * height).fill(0), selection = session.selection;
    if (!selection) return out;
    const pixels = selection.mask.toPixels(), mw = selection.mask.width;
    for (let y = 0; y < selection.mask.height; y++) for (let x = 0; x < mw; x++) {
      const dx = x + selection.x, dy = y + selection.y;
      if (dx >= 0 && dy >= 0 && dx < width && dy < height) out[dy * width + dx] = pixels[y * mw + x];
    }
    return out;
  });
}

function iou(mask: number[], width: number, height: number, truth: (x: number, y: number) => boolean): number {
  let intersection = 0, union = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const a = mask[y * width + x]! >= 128, b = truth(x + 0.5, y + 0.5);
    if (a && b) intersection++;
    if (a || b) union++;
  }
  return union ? intersection / union : 0;
}

/** Requests that would leave the machine (blob: and the dev server are local). */
const external = (url: string) => /^https?:\/\//.test(url) && !/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url);

async function waitIdle(page: Page): Promise<void> {
  await expect(page.getByTestId('object-select-status')).toHaveCount(0, { timeout: 180_000 });
  await expect(page.getByTestId('object-select-error')).toHaveCount(0);
}

async function selectRectangle(page: Page, x0: number, y0: number, x1: number, y1: number): Promise<void> {
  await page.getByTestId('tool-marquee').click();
  const a = await at(page, x0, y0), b = await at(page, x1, y1);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await selectionMask(page))[Math.round((y0 + y1) / 2) * 120 + Math.round((x0 + x1) / 2)]).toBe(255);
}

test('Object Selection: the model downloads only after the click (progress, cancel), then click, Shift-click and Alt-click select objects', async ({ page, browserName }) => {
  test.skip(!hasModel, `SlimSAM model files are not available in ${MODEL_DIR}`);
  test.setTimeout(420_000);
  const requests: string[] = [];
  let hold = true;
  const release: (() => void)[] = [];
  page.on('request', (request) => { if (external(request.url())) requests.push(request.url()); });
  await page.route('https://huggingface.co/**', async (route) => {
    if (hold) { await new Promise<void>((resolve) => release.push(resolve)); await route.abort().catch(() => {}); return; }
    const file = route.request().url().includes('vision_encoder') ? 'encoder.onnx' : 'decoder.onnx';
    const body = readFileSync(`${MODEL_DIR}/${file}`);
    await route.fulfill({ status: 200, body, headers: { 'content-type': 'application/octet-stream', 'content-length': String(body.length) } });
  });
  await openScene(page, scenePng(), W, H);

  // W selects the Magic Wand slot; Shift-W cycles to the Object Selection tool.
  await page.getByTestId('compositor-editor').press('w');
  await expect(page.getByTestId('tool-wand')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('compositor-editor').press('Shift+W');
  await expect(page.getByTestId('tool-objectSelect')).toHaveAttribute('aria-pressed', 'true');
  const download = page.getByTestId('enable-object-selection');
  await expect(download).toHaveText('Download model (20 MB)');
  await expect(download).toBeEnabled();
  // Clicking the canvas before the download explains what is missing and fetches nothing.
  const redCenter = await at(page, 78, 98);
  await page.mouse.click(redCenter.x, redCenter.y);
  await expect(page.getByTestId('object-select-error')).toContainText('Download the model');
  await page.waitForTimeout(500);
  expect(requests).toEqual([]);

  // The download shows progress and can be cancelled.
  await download.click();
  await expect(page.getByTestId('object-select-download-progress')).toBeVisible();
  await expect.poll(() => requests.length).toBe(1);
  await page.getByTestId('object-select-cancel-download').click();
  await expect(download).toBeVisible();
  release.splice(0).forEach((resolve) => resolve());

  hold = false;
  await download.click();
  await expect(page.getByTestId('object-select-download-progress')).toHaveCount(0, { timeout: 60_000 });
  await expect(download).toHaveCount(0);
  expect(requests.filter((url) => url.includes('huggingface.co')).length).toBe(3);

  // One click selects the red object.
  await page.mouse.click(redCenter.x, redCenter.y);
  await waitIdle(page);
  let mask = await selectionMask(page);
  const redIoU = iou(mask, W, H, red);
  expect(redIoU).toBeGreaterThanOrEqual(0.9);
  const timing = await page.getByTestId('object-select-timing').evaluate((element) => ({ ...(element as HTMLElement).dataset }));

  // Shift-click adds the yellow object.
  const yellowCenter = await at(page, 184, 90);
  await page.keyboard.down('Shift');
  await page.mouse.click(yellowCenter.x, yellowCenter.y);
  await page.keyboard.up('Shift');
  await waitIdle(page);
  mask = await selectionMask(page);
  expect(iou(mask, W, H, (x, y) => red(x, y) || yellow(x, y))).toBeGreaterThanOrEqual(0.9);
  const cached = await page.getByTestId('object-select-timing').evaluate((element) => ({ ...(element as HTMLElement).dataset }));
  expect(cached.cacheHit).toBe('true');

  // Alt-click subtracts the red object again.
  await page.keyboard.down('Alt');
  await page.mouse.click(redCenter.x, redCenter.y);
  await page.keyboard.up('Alt');
  await waitIdle(page);
  mask = await selectionMask(page);
  expect(iou(mask, W, H, yellow)).toBeGreaterThanOrEqual(0.9);
  expect(await page.evaluate(() => (window as any).__editorForTests.session.history.undoName)).toBe('Object Selection');
  await page.getByTestId('compositor-editor').press(`${mod}+z`);
  mask = await selectionMask(page);
  expect(iou(mask, W, H, (x, y) => red(x, y) || yellow(x, y))).toBeGreaterThanOrEqual(0.9);
  console.log('Object selection timing (first click, cached click):', JSON.stringify({ first: timing, cached, redIoU }));

  // Offline afterwards: a reload finds the model in the host cache and fetches nothing. Playwright's ephemeral WebKit
  // context drops Cache Storage on reload (measured: put and match succeed, keys are empty after reload).
  if (browserName === 'webkit') {
    test.info().annotations.push({ type: 'note', description: 'offline-after-reload not checked: ephemeral WebKit Cache Storage' });
    return;
  }
  requests.length = 0;
  await page.unroute('https://huggingface.co/**');
  await page.route('https://huggingface.co/**', (route) => route.abort());
  await mountForTest(page);
  // The reloaded page offers to recover the unsaved scene first.
  await page.getByRole('button', { name: 'Discard' }).click();
  await page.getByTestId('createCanvas').click();
  await page.getByTestId('tool-objectSelect').click();
  await expect(page.getByRole('button', { name: 'Select Subject' })).toBeVisible();
  await expect(page.getByTestId('enable-object-selection')).toHaveCount(0);
  expect(requests).toEqual([]);
});

test('Select Subject uses the bundled subject model (no download) and makes one undo step', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'the subject model specs run in Chromium only (playwright.config.ts)');
  test.setTimeout(180_000);
  const requests: string[] = [];
  page.on('request', (request) => { if (external(request.url())) requests.push(request.url()); });
  await openScene(page, scenePng(), W, H);
  await page.getByTestId('tool-objectSelect').click();
  await page.getByTestId('select-subject').click();
  await waitIdle(page);
  await expect.poll(() => page.evaluate(() => (window as any).__editorForTests.session.history.undoName), { timeout: 120_000 }).toBe('Select Subject');
  const mask = await selectionMask(page);
  expect(mask[98 * W + 78]! >= 128 || mask[90 * W + 184]! >= 128).toBe(true);
  expect(mask[4 * W + 4]).toBeLessThan(128);
  expect(requests).toEqual([]);
});

test('Refine Edge: live preview in the view modes, Feather softens the edge, one undo step, Cancel restores', async ({ page }) => {
  await openScene(page, solidPng(120, 120, [200, 120, 40, 255]), 120, 120);
  await selectRectangle(page, 30, 30, 90, 90);
  const before = await selectionMask(page);
  expect(before[60 * 120 + 30]).toBe(255);
  expect(before[60 * 120 + 28]).toBe(0);

  // The context bar button and Select › Refine Edge… open the same panel.
  await page.getByTestId('refine-edge').click();
  const panel = page.getByTestId('refine-edge-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('refine-edge-ok')).toBeEnabled();
  await expect(page.getByTestId('refine-edge-status')).toHaveCount(0);
  // The view modes draw on the canvas: On Black paints what is not selected black.
  const overlayPixel = async (x: number, y: number) => {
    const p = await at(page, x, y), box = (await page.getByTestId('editor-canvas').boundingBox())!;
    return page.evaluate(([vx, vy]) => {
      const overlay = [...document.querySelectorAll('[data-testid=canvas-pane] canvas')].find((c) => (c as HTMLElement).dataset.testid !== 'editor-canvas') as HTMLCanvasElement;
      const scale = overlay.width / overlay.getBoundingClientRect().width;
      return Array.from(overlay.getContext('2d')!.getImageData(Math.round(vx * scale), Math.round(vy * scale), 1, 1).data);
    }, [p.x - box.x, p.y - box.y] as const);
  };
  await page.getByTestId('refine-edge-view').selectOption('onBlack');
  await expect.poll(() => overlayPixel(8, 8)).toEqual([0, 0, 0, 255]);
  await page.getByTestId('refine-edge-view').selectOption('onWhite');
  await expect.poll(() => overlayPixel(8, 8)).toEqual([255, 255, 255, 255]);
  await page.getByTestId('refine-edge-view').selectOption('blackWhite');
  await expect.poll(() => overlayPixel(60, 60)).toEqual([255, 255, 255, 255]);
  await page.getByTestId('refine-edge-view').selectOption('overlay');
  await expect.poll(async () => (await overlayPixel(8, 8))[0]).toBe(255);

  await page.getByTestId('refine-edge-radius').fill('0');
  await page.getByTestId('refine-edge-feather').fill('6');
  await page.getByTestId('refine-edge-ok').click();
  await expect(panel).toHaveCount(0);
  const after = await selectionMask(page);
  // The hard edge became a ramp: partially selected pixels on both sides of x = 30.
  expect(after[60 * 120 + 30]).toBeGreaterThan(20);
  expect(after[60 * 120 + 30]).toBeLessThan(235);
  expect(after[60 * 120 + 27]).toBeGreaterThan(0);
  expect(after[60 * 120 + 60]).toBe(255);
  expect(after[5 * 120 + 5]).toBe(0);
  expect(await page.evaluate(() => (window as any).__editorForTests.session.history.undoName)).toBe('Refine Edge');
  await page.getByTestId('compositor-editor').press(`${mod}+z`);
  expect(await selectionMask(page)).toEqual(before);

  // The Refine Edge brush recomputes the edge only where it paints.
  await page.getByTestId('refine-edge').click();
  await expect(page.getByTestId('refine-edge-ok')).toBeEnabled();
  await page.getByTestId('refine-edge-feather').fill('0');
  await page.getByTestId('refine-edge-brush').click();
  await page.getByTestId('refine-edge-brush-size').fill('16');
  const top = await at(page, 30, 45), bottom = await at(page, 30, 65);
  await page.mouse.move(top.x, top.y);
  await page.mouse.down();
  await page.mouse.move(bottom.x, bottom.y, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId('refine-edge-status')).toHaveCount(0);
  await page.getByTestId('refine-edge-ok').click();
  await expect(panel).toHaveCount(0);
  const brushed = await selectionMask(page);
  expect(brushed.slice(52 * 120 + 24, 52 * 120 + 37).some((v) => v > 0 && v < 255)).toBe(true);
  expect(brushed[85 * 120 + 30]).toBe(255);
  expect(brushed[85 * 120 + 29]).toBe(0);
  await page.getByTestId('compositor-editor').press(`${mod}+z`);
  expect(await selectionMask(page)).toEqual(before);

  // Cancel leaves the selection and history as they were.
  await page.getByTestId('menu-Select').click();
  await page.getByRole('menuitem', { name: 'Refine Edge…' }).click();
  await expect(panel).toBeVisible();
  await page.getByTestId('refine-edge-feather').fill('20');
  await page.getByTestId('refine-edge-cancel').click();
  await expect(panel).toHaveCount(0);
  expect(await selectionMask(page)).toEqual(before);
  expect(await page.evaluate(() => (window as any).__editorForTests.session.history.undoName)).toBe('Rectangular Marquee');
});

test('Refine Edge outputs to a layer mask and to a new layer with a mask', async ({ page }) => {
  await openScene(page, solidPng(120, 120, [40, 160, 90, 255]), 120, 120);
  await selectRectangle(page, 20, 20, 70, 100);
  await page.getByTestId('refine-edge').click();
  await expect(page.getByTestId('refine-edge-ok')).toBeEnabled();
  await page.getByTestId('refine-edge-output').selectOption('layerMask');
  await page.getByTestId('refine-edge-ok').click();
  await expect(page.getByTestId('refine-edge-panel')).toHaveCount(0);
  const layer = (await manifest(page)).layers[1];
  expect(layer.mask).toBeTruthy();
  expect(layer.mask.enabled).toBe(true);
  const mask = await page.evaluate(() => {
    const session = (window as any).__editorForTests.session, m = session.activeLayer.mask.raster;
    const pixels = m.toPixels();
    return { width: m.width, inside: pixels[60 * m.width + 45], outside: pixels[60 * m.width + 100] };
  });
  expect(mask.width).toBe(120);
  expect(mask.inside).toBe(255);
  expect(mask.outside).toBe(0);
  expect(await page.evaluate(() => (window as any).__editorForTests.session.history.undoName)).toBe('Refine Layer Mask');

  await page.getByTestId('refine-edge').click();
  await expect(page.getByTestId('refine-edge-ok')).toBeEnabled();
  await page.getByTestId('refine-edge-decontaminate').check();
  await expect(page.getByTestId('refine-edge-output')).toHaveValue('newLayerWithMask');
  await page.getByTestId('refine-edge-ok').click();
  await expect.poll(async () => (await manifest(page)).layers.length).toBe(3);
  expect((await manifest(page)).layers[2].mask).toBeTruthy();
  await page.getByTestId('compositor-editor').press(`${mod}+z`);
  await expect.poll(async () => (await manifest(page)).layers.length).toBe(2);
});

test('Quick Mask: Q shows the selection as a red tint, the Brush edits it, Q returns a selection', async ({ page }) => {
  await openScene(page, solidPng(120, 120, [230, 230, 230, 255]), 120, 120);
  await selectRectangle(page, 10, 10, 110, 110);
  await page.getByTestId('compositor-editor').press('q');
  await page.getByTestId('menu-Select').click();
  await expect(page.getByRole('menuitem', { name: 'Edit in Quick Mask Mode' })).toContainText('✓');
  await page.keyboard.press('Escape');
  await page.getByTestId('tool-brush').click();
  await expect(page.getByTestId('quick-mask-exit')).toBeVisible();
  // Default black paints mask (unselects) with the Brush.
  const a = await at(page, 30, 60), b = await at(page, 90, 60);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 10 });
  await page.mouse.up();
  await page.getByTestId('compositor-editor').press('q');
  await expect(page.getByTestId('quick-mask-exit')).toHaveCount(0);
  const mask = await selectionMask(page);
  expect(mask[60 * 120 + 60]).toBe(0);
  expect(mask[20 * 120 + 60]).toBe(255);
  expect(mask[5 * 120 + 5]).toBe(0);
  expect(await page.evaluate(() => (window as any).__editorForTests.session.history.undoName)).toBe('Quick Mask');
  // The layer pixels were not painted.
  const pixel = await page.evaluate(() => Array.from((window as any).__editorForTests.session.activeLayer.raster.readRegion(60, 60, 1, 1)));
  expect(pixel).toEqual([230, 230, 230, 255]);
  await page.getByTestId('compositor-editor').press(`${mod}+z`);
  expect((await selectionMask(page))[60 * 120 + 60]).toBe(255);
});

test('Select › Color Range selects the sampled colour patch', async ({ page }) => {
  const size = 120, data = new Uint8Array(size * size * 4);
  const patch = (x: number, y: number) => x >= 20 && x < 60 && y >= 30 && y < 90;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) data.set(patch(x + 0.5, y + 0.5) ? [210, 40, 50, 255] : [40, 90, 200, 255], (y * size + x) * 4);
  await openScene(page, Buffer.from(encodePng(data, size, size, 4)), size, size);
  await page.getByTestId('menu-Select').click();
  await page.getByRole('menuitem', { name: 'Color Range…' }).click();
  const panel = page.getByTestId('color-range-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('color-range-ok')).toBeDisabled();
  const p = await at(page, 40, 60);
  await page.mouse.click(p.x, p.y);
  await expect(page.getByTestId('color-range-samples').locator('span')).toHaveCount(1);
  await expect(page.getByTestId('color-range-ok')).toBeEnabled();
  await page.getByTestId('color-range-ok').click();
  await expect(panel).toHaveCount(0);
  const mask = await selectionMask(page);
  expect(iou(mask, size, size, patch)).toBeGreaterThanOrEqual(0.98);
  expect(await page.evaluate(() => (window as any).__editorForTests.session.history.undoName)).toBe('Color Range');

  // A preset needs no sample: Highlights on this image selects nothing bright enough, Shadows neither the patch.
  await page.getByTestId('menu-Select').click();
  await page.getByRole('menuitem', { name: 'Color Range…' }).click();
  await page.getByTestId('color-range-preset').selectOption('skinTones');
  await expect(page.getByTestId('color-range-ok')).toBeEnabled();
  await page.getByTestId('color-range-cancel').click();
  await expect(panel).toHaveCount(0);
});

test('German labels of the Object Selection tool, Refine Edge and Color Range', async ({ page }) => {
  await openScene(page, solidPng(80, 80, [120, 120, 120, 255]), 80, 80, 'de');
  await page.getByTestId('compositor-editor').press('Shift+W');
  await expect(page.getByTestId('tool-objectSelect')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('tool-objectSelect')).toHaveAttribute('aria-label', 'Objektauswahlwerkzeug (Umschalt-W)');
  await expect(page.getByText('Objektauswahlwerkzeug', { exact: true })).toBeVisible();
  await expect(page.getByTestId('enable-object-selection')).toHaveText('Modell herunterladen (20 MB)');
  await expect(page.getByRole('radio', { name: 'Rechteck' })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Lasso' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Motiv auswählen' })).toBeVisible();

  await page.getByTestId('compositor-editor').press(`${mod}+a`);
  await page.getByTestId('menu-Auswahl').click();
  for (const name of ['Farbbereich …', 'Motiv', 'Im Maskierungsmodus bearbeiten']) await expect(page.getByRole('menuitem', { name, exact: true })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Kante verfeinern …' }).click();
  const panel = page.getByTestId('refine-edge-panel');
  await expect(panel.getByRole('heading', { name: 'Kante verfeinern' })).toBeVisible();
  for (const text of ['Ansicht', 'Kantenerkennung', 'Smartradius', 'Radius', 'Globale Verbesserungen', 'Abrunden', 'Weiche Kante', 'Kontrast',
    'Kante verschieben', 'Ausgabeeinstellungen', 'Farben dekontaminieren', 'Ausgabe an', 'Kante-verbessern-Pinsel']) {
    await expect(panel.getByText(text, { exact: true }).first()).toBeVisible();
  }
  await expect(panel.getByTestId('refine-edge-view').locator('option')).toHaveText(['Überlagerung', 'Auf Schwarz', 'Auf Weiß', 'Schwarzweiß', 'Auf Ebenen']);
  await expect(panel.getByTestId('refine-edge-output').locator('option')).toHaveText(['Auswahl', 'Ebenenmaske', 'Neue Ebene', 'Neue Ebene mit Ebenenmaske']);
  await panel.getByTestId('refine-edge-decontaminate').check();
  await expect(panel.getByText('Stärke', { exact: true })).toBeVisible();
  await page.getByTestId('refine-edge-cancel').click();

  await page.getByTestId('menu-Auswahl').click();
  await page.getByRole('menuitem', { name: 'Farbbereich …' }).click();
  const range = page.getByTestId('color-range-panel');
  await expect(range.getByRole('heading', { name: 'Farbbereich' })).toBeVisible();
  for (const text of ['Toleranz', 'Lokalisierte Farbgruppen', 'Umkehren', 'Vorschau']) await expect(range.getByText(text, { exact: true })).toBeVisible();
  await expect(range.getByTestId('color-range-preset').locator('option')).toHaveText(['Aufgenommene Farben', 'Hauttöne', 'Mitteltöne', 'Lichter', 'Tiefen']);
  await page.getByTestId('color-range-cancel').click();

  await page.getByTestId('tool-brush').click();
  await page.getByTestId('compositor-editor').press('q');
  await expect(page.getByTestId('quick-mask-exit')).toHaveText('Maskierungsmodus beenden (Q)');
});
