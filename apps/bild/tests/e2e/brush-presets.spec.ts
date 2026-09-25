import { expect, test, type Page } from '@playwright/test';
import { exportedPixels, mountForTest } from './helpers';
import { abrV12, abrV6, ringTipData } from '../unit/abrFixtures';

test.use({ viewport: { width: 1440, height: 900 } });

async function newCanvas(page: Page, width: number, height: number) {
  await page.getByTestId('widthInput').fill(String(width));
  await page.getByTestId('heightInput').fill(String(height));
  await page.getByTestId('createCanvas').click();
  await page.getByTestId('tool-brush').click();
}

async function canvasMapper(page: Page, width: number, height: number) {
  const pane = (await page.getByTestId('canvas-pane').boundingBox())!;
  const zoom = parseFloat((await page.getByTestId('zoomStatus').textContent())!) / 100 / (await page.evaluate(() => devicePixelRatio));
  const origin = { x: pane.x + pane.width / 2 - width / 2 * zoom, y: pane.y + pane.height / 2 - height / 2 * zoom };
  return (x: number, y: number) => ({ x: origin.x + x * zoom, y: origin.y + y * zoom });
}

/** Waits for the worker commit, then reads the exported composite. */
async function pixelsAfterStroke(page: Page) {
  await page.evaluate(async () => {
    const load = (path: string): Promise<typeof import('../../src/core/brush/index.ts')> => import(/* @vite-ignore */ path);
    const brush = await load('/src/core/brush/index.ts');
    await brush.waitForBrushStroke((window as any).__editorForTests.session);
  });
  const pixels = await exportedPixels(page);
  return { ...pixels, alpha: (x: number, y: number) => pixels.data[(y * pixels.width + x) * 4 + 3]! };
}

async function stroke(page: Page, at: (x: number, y: number) => { x: number; y: number }, from: [number, number], to: [number, number]) {
  let p = at(...from);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    p = at(from[0] + (to[0] - from[0]) * i / 12, from[1] + (to[1] - from[1]) * i / 12);
    await page.mouse.move(p.x, p.y, { steps: 2 });
  }
  await page.mouse.up();
}

test('German preset picker: pick a preset, paint its angled tip, step presets with , and . and open Brush Settings', async ({ page }) => {
  await mountForTest(page, { locale: 'de' });
  await newCanvas(page, 200, 200);
  const at = await canvasMapper(page, 200, 200);
  const button = page.getByTestId('brush-preset-button');
  await expect(button).toHaveAttribute('aria-label', 'Pinselvorgaben');
  await button.click();
  const picker = page.getByTestId('brush-presets');
  await expect(picker.getByText('Pinselvorgaben', { exact: true })).toBeVisible();
  await expect(picker.getByRole('radio', { name: 'Bibliothek' })).toBeVisible();
  await expect(picker.getByRole('radio', { name: 'Dokument' })).toBeVisible();
  await expect(picker.getByTestId('brush-presets-search')).toHaveAttribute('placeholder', 'Pinsel suchen');
  // The default brush is the Hard Round preset; the textured defaults are there with German names.
  await expect(picker.locator('[data-testid=brush-preset][aria-selected=true]')).toHaveAttribute('data-name', 'Hard Round');
  for (const name of ['Hart rund', 'Weich rund', 'Kreide', 'Spritzer', 'Gras', 'Kalligrafie']) await expect(picker.getByRole('option', { name, exact: true })).toBeVisible();
  await expect(picker.getByRole('button', { name: 'Neue Pinselvorgabe' })).toBeVisible();
  await expect(picker.getByRole('button', { name: 'Pinsel importieren …' })).toBeVisible();
  // Stroke previews are drawn by the engine.
  await expect(picker.locator('[data-testid=brush-preset-stroke][data-ready=true]').first()).toBeVisible();

  await picker.getByTestId('brush-presets-search').fill('kalli');
  await expect(picker.getByTestId('brush-preset')).toHaveCount(1);
  await picker.getByRole('option', { name: 'Kalligrafie' }).click();
  await expect(picker.getByRole('option', { name: 'Kalligrafie' })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
  await expect(button).toContainText('28');

  // One click: a 28 px tip at 45° with 20 % roundness paints along the down-right diagonal only.
  const p = at(100, 100);
  await page.mouse.click(p.x, p.y);
  const pixels = await pixelsAfterStroke(page);
  expect(pixels.alpha(100, 100)).toBe(255);
  expect(pixels.alpha(105, 105)).toBe(255);
  expect(pixels.alpha(95, 95)).toBe(255);
  expect(pixels.alpha(105, 95)).toBe(0);
  expect(pixels.alpha(95, 105)).toBe(0);
  expect(pixels.alpha(100, 110)).toBe(0);

  // Photoshop keys: . next preset, , previous; ] grows the brush.
  const editor = page.getByTestId('compositor-editor');
  await editor.press('Period');
  await expect(button).toContainText('40');
  await editor.press('Comma');
  await expect(button).toContainText('28');
  await editor.press('BracketRight');
  await expect(button).toContainText('34');

  // Brush Settings (F5 or the context-bar button) with Photoshop's German terms.
  await page.getByTestId('brush-settings-button').click();
  const panel = page.getByTestId('brush-settings');
  await expect(panel.getByRole('heading', { name: 'Pinseleinstellungen' })).toBeVisible();
  for (const text of ['Pinselspitze', 'Form-Eigenschaften', 'Übertragung', 'Fluss', 'Malabstand', 'Größen-Jitter', 'Winkel', 'Rundheit']) {
    await expect(panel.getByText(text, { exact: true }).first()).toBeVisible();
  }
  await expect(panel.getByText('Streuung', { exact: true }).first()).toBeVisible();
  await expect(panel.getByTestId('brush-angle')).toHaveValue('45');
  await expect(panel.getByTestId('brush-roundness')).toHaveValue('20');
  await expect(panel.locator('[data-testid=brush-settings-preview][data-ready=true]')).toBeVisible();
  await editor.press('F5');
  await expect(panel).toHaveCount(0);
});

test('spacing and scatter from Brush Settings are visible in the painted pixels', async ({ page }) => {
  await mountForTest(page);
  await newCanvas(page, 320, 160);
  const at = await canvasMapper(page, 320, 160);
  await page.getByTestId('brush-settings-button').click();
  const panel = page.getByTestId('brush-settings');
  await panel.getByTestId('brush-size').fill('10');
  await panel.getByTestId('brush-spacing-enabled').check();
  await panel.getByTestId('brush-spacing').fill('300');
  await expect(page.getByTestId('brush-preset-button')).toContainText('10');

  await stroke(page, at, [20, 40], [290, 40]);
  let pixels = await pixelsAfterStroke(page);
  // Dabs every 30 px: painted runs separated by transparent gaps along the path.
  const row = Array.from({ length: 320 }, (_, x) => pixels.alpha(x, 40) > 128);
  const runs: number[] = [];
  for (let x = 1; x < 320; x++) if (row[x] && !row[x - 1]) runs.push(x);
  expect(runs.length).toBeGreaterThanOrEqual(8);
  const gaps = runs.slice(1).map((x, i) => x - runs[i]!);
  for (const gap of gaps) expect(Math.abs(gap - 30)).toBeLessThanOrEqual(2);
  expect(pixels.alpha(35, 40)).toBe(0);
  for (let x = 0; x < 320; x++) { expect(pixels.alpha(x, 52)).toBe(0); expect(pixels.alpha(x, 28)).toBe(0); }

  // Scatter 400 % at 50 % spacing: dabs leave the path by up to 40 px.
  await panel.getByTestId('brush-spacing').fill('50');
  await panel.getByTestId('brush-scatter').fill('400');
  await stroke(page, at, [20, 110], [290, 110]);
  pixels = await pixelsAfterStroke(page);
  let farAway = 0;
  for (let y = 60; y < 160; y++) for (let x = 0; x < 320; x++) if (Math.abs(y - 110) > 8 && pixels.alpha(x, y) > 0) farAway++;
  expect(farAway).toBeGreaterThan(200);
  // The first, unscattered stroke is unchanged.
  for (let x = 0; x < 320; x++) expect(pixels.alpha(x, 28)).toBe(0);
});

test('import a generated .abr, paint with its sampled tip, keep it after a reload, copy it into the document', async ({ page }) => {
  await mountForTest(page);
  await newCanvas(page, 200, 200);
  let at = await canvasMapper(page, 200, 200);
  const file = abrV6(2, [{ uuid: '$e2e-ring-0000-0000-0000-000000000000', width: 64, height: 64, data: ringTipData(64), rle: true }],
    [{ name: 'Test Ring', uuid: '$e2e-ring-0000-0000-0000-000000000000', diameter: 60, spacing: 25 }]);
  await page.getByTestId('brush-preset-button').click();
  const picker = page.getByTestId('brush-presets');
  const chooser = page.waitForEvent('filechooser');
  await picker.getByTestId('brush-presets-import-button').click();
  await (await chooser).setFiles({ name: 'rings.abr', mimeType: 'application/octet-stream', buffer: Buffer.from(file) });
  await expect(picker.getByTestId('brush-presets-message')).toHaveText('Imported 1 brushes.');
  const tile = picker.getByRole('option', { name: 'Test Ring' });
  await expect(tile).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape');

  // One click: the ring tip leaves its centre empty and paints a ring of radius ~15–28 px.
  const p = at(100, 100);
  await page.mouse.click(p.x, p.y);
  let pixels = await pixelsAfterStroke(page);
  expect(pixels.alpha(100, 100)).toBe(0);
  expect(pixels.alpha(122, 100)).toBe(255);
  expect(pixels.alpha(100, 78)).toBe(255);
  expect(pixels.alpha(100, 132)).toBe(0);

  // A second, v2 file with two brushes; an unreadable 32-bit sample is reported.
  const second = abrV12(2, [
    { name: 'Dots', sampled: { width: 8, height: 8, data: new Uint8Array(64).fill(255), spacing: 50 } },
    { name: 'Deep', sampled: { width: 2, height: 2, data: new Uint8Array(4), spacing: 50, depth: 32 } },
    { computed: { spacing: 25, diameter: 12, roundness: 50, angle: 30, hardness: 100 } },
  ]);
  await page.getByTestId('brush-preset-button').click();
  const next = page.waitForEvent('filechooser');
  await picker.getByTestId('brush-presets-import-button').click();
  await (await next).setFiles({ name: 'more.abr', mimeType: 'application/octet-stream', buffer: Buffer.from(second) });
  await expect(picker.getByTestId('brush-presets-message')).toHaveText('Imported 2 brushes. 1 brushes could not be read.');
  await expect(picker.getByRole('option', { name: 'more 2' })).toBeVisible();

  // Not a brush file.
  const bad = page.waitForEvent('filechooser');
  await picker.getByTestId('brush-presets-import-button').click();
  await (await bad).setFiles({ name: 'bad.abr', mimeType: 'application/octet-stream', buffer: Buffer.from([0, 9, 0, 0, 1, 2]) });
  await expect(picker.getByTestId('brush-presets-message')).toHaveText('This file is not a usable .abr brush file.');

  // Copy the ring into the document (one undo step), then undo removes it again.
  await tile.click({ button: 'right' });
  await page.getByTestId('brush-preset-copy').click();
  await picker.getByTestId('brush-presets-scope-document').click();
  await expect(picker.getByRole('option', { name: 'Test Ring' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__editorForTests.session.document.resources.filter((r: { role: string }) => r.role === 'brushes').length)).toBe(1);
  await page.keyboard.press('Escape');
  await page.getByTestId('compositor-editor').press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await page.getByTestId('brush-preset-button').click();
  await expect(picker.getByTestId('brush-preset')).toHaveCount(0);
  await picker.getByTestId('brush-presets-scope-library').click();

  // The library (with the sampled tip pixels) survives a reload (the autosaved project is not what this checks).
  await mountForTest(page);
  const discard = page.getByRole('button', { name: 'Discard' });
  await discard.waitFor({ timeout: 5000 }).then(() => discard.click(), () => undefined);
  await newCanvas(page, 200, 200);
  at = await canvasMapper(page, 200, 200);
  await page.getByTestId('brush-preset-button').click();
  await picker.getByRole('option', { name: 'Test Ring' }).click();
  await page.keyboard.press('Escape');
  const q = at(100, 100);
  await page.mouse.click(q.x, q.y);
  pixels = await pixelsAfterStroke(page);
  expect(pixels.alpha(100, 100)).toBe(0);
  expect(pixels.alpha(122, 100)).toBe(255);
});
