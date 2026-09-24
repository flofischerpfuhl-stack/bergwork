import { expect, test, type Page } from '@playwright/test';
import { exportedPixels, mountForTest } from './helpers';

/** The Type tool end to end (PRODUCT-PLAN A5, 6.6, P11): typing, formatting, undo, re-editing, scripts, fonts, export. */

async function newCanvas(page: Page, width = 800, height = 500): Promise<void> {
  await page.getByTestId('widthInput').fill(String(width));
  await page.getByTestId('heightInput').fill(String(height));
  await page.getByTestId('createCanvas').click();
  await expect(page.getByTestId('layer-row')).toHaveCount(1);
}

/** Page coordinates of a document pixel. */
async function at(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  return page.evaluate(({ x, y }) => {
    const controller = (window as any).__editorForTests;
    const session = controller.session;
    const view = session.viewport.viewPoint({ x, y }, session.document);
    const rect = controller.canvasView.element.getBoundingClientRect();
    return { x: rect.left + view.x, y: rect.top + view.y };
  }, { x, y });
}

async function chooseTextTool(page: Page): Promise<void> {
  await page.getByTestId('tool-text').click();
  await expect(page.locator('[data-testid="text-bar"][data-engine="ready"]')).toBeVisible({ timeout: 90_000 });
}

async function clickAt(page: Page, x: number, y: number): Promise<void> {
  const point = await at(page, x, y);
  await page.mouse.click(point.x, point.y);
}

interface TextLayerInfo {
  id: string; name: string; text: string; box: { width: number; height: number } | null;
  transform: { origin: { x: number; y: number }; size: { width: number; height: number } };
  runs: { from: number; to: number; fontFamily: string; fontSize: number; fontWeight: number }[];
}
async function textLayers(page: Page): Promise<TextLayerInfo[]> {
  return page.evaluate(() => {
    const session = (window as any).__editorForTests.session;
    return session.document.layers.filter((layer: any) => layer.kind === 'text').map((layer: any) => ({
      id: layer.id, name: layer.name, text: layer.text, box: layer.box, transform: layer.transform,
      runs: layer.runs.map((run: any) => ({ from: run.from, to: run.to, fontFamily: run.style.fontFamily, fontSize: run.style.fontSize,
        fontWeight: run.style.fontWeight })),
    }));
  });
}

/** Composited pixels with any coverage in a document rectangle, and their bounding box. */
async function ink(page: Page, x: number, y: number, width: number, height: number): Promise<{ count: number; top: number; bottom: number }> {
  return page.evaluate(({ x, y, width, height }) => {
    const controller = (window as any).__editorForTests;
    const pixels: Uint8Array = controller.canvas.readRegion(controller.session.document, x, y, width, height);
    let count = 0, top = height, bottom = -1;
    for (let row = 0; row < height; row++) {
      for (let column = 0; column < width; column++) {
        if (pixels[(row * width + column) * 4 + 3]! > 24) { count++; top = Math.min(top, row); bottom = Math.max(bottom, row); }
      }
    }
    return { count, top, bottom };
  }, { x, y, width, height });
}

async function history(page: Page): Promise<{ count: number; name: string; editing: boolean }> {
  return page.evaluate(() => {
    const session = (window as any).__editorForTests.session;
    return { count: session.history.undoCount, name: session.history.undoName, editing: session.history.isInTransaction };
  });
}

test.beforeEach(async ({ page }) => {
  test.setTimeout(240_000);
  await mountForTest(page, { locale: 'en' });
  await newCanvas(page);
});

test('click creates point text; typing edits it in place and draws on the canvas', async ({ page }) => {
  expect((await ink(page, 60, 120, 500, 140)).count).toBe(0);
  // A5/A10: CanvasKit is not loaded until the Type tool is chosen (or a document has text).
  expect(await page.evaluate(() => performance.getEntriesByType('resource').some((entry) => /canvaskit/i.test(entry.name)))).toBe(false);
  await chooseTextTool(page);
  expect(await page.evaluate(() => performance.getEntriesByType('resource').some((entry) => /canvaskit/i.test(entry.name)))).toBe(true);
  await clickAt(page, 80, 200);
  await expect(page.getByTestId('text-commit')).toBeVisible();
  await page.keyboard.type('Hallo Welt');
  let layers = await textLayers(page);
  expect(layers).toHaveLength(1);
  expect(layers[0]!.text).toBe('Hallo Welt');
  expect(layers[0]!.box).toBeNull();
  expect(layers[0]!.name).toBe('Hallo Welt');
  // The first baseline sits at the click; the layer grows to the shaped text.
  expect(Math.abs(layers[0]!.transform.origin.x - 80)).toBeLessThan(2);
  expect(layers[0]!.transform.origin.y).toBeLessThan(200);
  expect(layers[0]!.transform.size.width).toBeGreaterThan(100);
  await expect.poll(async () => (await ink(page, 60, 120, 500, 140)).count, { timeout: 30_000 }).toBeGreaterThan(200);
  // Caret movement, deletion and a new paragraph.
  await page.keyboard.press('Backspace');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.type('X');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('zwei');
  layers = await textLayers(page);
  expect(layers[0]!.text).toBe('Hallo WXel\nzwei');
  expect((await history(page)).editing).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('text-commit')).toHaveCount(0);
  const after = await history(page);
  expect(after.editing).toBe(false);
  expect(after.name).toBe('Edit Text');
  await expect(page.getByTestId('text-thumb')).toHaveCount(1);
  await expect(page.getByTestId('layer-row').first()).toContainText('Hallo WXel');
});

test('drag creates area text that wraps inside its box', async ({ page }) => {
  await chooseTextTool(page);
  const start = await at(page, 100, 60), end = await at(page, 330, 460);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move((start.x + end.x) / 2, (start.y + end.y) / 2, { steps: 4 });
  await page.mouse.move(end.x, end.y, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.type('Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.');
  const [layer] = await textLayers(page);
  expect(layer!.box!.width).toBeCloseTo(230, -1);
  expect(layer!.box!.height).toBeCloseTo(400, -1);
  const fontSize = layer!.runs[0]!.fontSize;
  // Wrapped: ink spans several lines vertically and never leaves the box horizontally.
  await expect.poll(async () => { const value = await ink(page, 100, 60, 230, 400); return value.bottom - value.top; }, { timeout: 30_000 })
    .toBeGreaterThan(fontSize * 3);
  expect((await ink(page, 332, 60, 200, 400)).count).toBe(0);
  await page.keyboard.press('Control+Enter');
  expect((await history(page)).name).toBe('Edit Text');
});

test('Shift+arrows select a range that becomes bold and larger; one undo step per editing session', async ({ page }) => {
  const initial = (await history(page)).count;
  await chooseTextTool(page);
  await clickAt(page, 60, 200);
  await page.keyboard.type('Hello World');
  await expect.poll(async () => (await ink(page, 40, 100, 700, 160)).count, { timeout: 30_000 }).toBeGreaterThan(100);
  const regular = (await ink(page, 40, 100, 700, 160)).count;
  for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowLeft');
  await page.getByTestId('font-style').selectOption('700|normal');
  const size = page.getByTestId('font-size');
  await size.fill('60');
  await size.press('Enter');
  let [layer] = await textLayers(page);
  expect(layer!.runs.map((run) => [run.from, run.to, run.fontWeight, run.fontSize])).toEqual([
    [0, 6, 400, layer!.runs[0]!.fontSize], [6, 11, 700, 60]]);
  await expect.poll(async () => (await ink(page, 40, 60, 740, 220)).count, { timeout: 30_000 }).toBeGreaterThan(regular * 1.3);
  // Typing continues after the controls and replaces the selection in its style.
  await page.keyboard.type('There');
  [layer] = await textLayers(page);
  expect(layer!.text).toBe('Hello There');
  expect(layer!.runs.at(-1)).toMatchObject({ to: 11, fontWeight: 700, fontSize: 60 });
  // Inside the session ⌘Z/Ctrl+Z steps through the typing.
  await page.keyboard.press('ControlOrMeta+z');
  expect((await textLayers(page))[0]!.text).toBe('Hello Ther');
  await page.keyboard.press('ControlOrMeta+Shift+z');
  expect((await textLayers(page))[0]!.text).toBe('Hello There');
  await page.getByTestId('text-commit').click();
  const first = await history(page);
  expect(first.count).toBe(initial + 1);
  expect(first.name).toBe('Edit Text');

  // Second session: click into the text, type, commit with another tool.
  await clickAt(page, 70, 190);
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('!');
  await page.getByTestId('tool-move').click();
  const second = await history(page);
  expect(second.count).toBe(initial + 2);
  expect((await textLayers(page))[0]!.text).toBe('Hello There!');
  await page.evaluate(() => (window as any).__handle.undo());
  expect((await textLayers(page))[0]!.text).toBe('Hello There');
  await page.evaluate(() => (window as any).__handle.undo());
  expect(await textLayers(page)).toHaveLength(0);
  expect((await history(page)).count).toBe(initial);
});

test('double-clicking text on the canvas or its layer thumbnail edits it again', async ({ page }) => {
  await chooseTextTool(page);
  await clickAt(page, 60, 200);
  await page.keyboard.type('Edit me');
  await page.keyboard.press('Escape');
  await page.keyboard.press('v');
  await expect(page.getByTestId('tool-move')).toHaveAttribute('aria-pressed', 'true');
  const [layer] = await textLayers(page);
  const middle = await at(page, layer!.transform.origin.x + layer!.transform.size.width - 4, layer!.transform.origin.y + layer!.transform.size.height / 2);
  await page.mouse.dblclick(middle.x, middle.y);
  await expect(page.getByTestId('tool-text')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('text-commit')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('!');
  await page.keyboard.press('Escape');
  expect((await textLayers(page))[0]!.text).toBe('Edit me!');
  // The T thumbnail: everything selected, so typing replaces it.
  await page.getByTestId('text-thumb').dblclick();
  await expect(page.getByTestId('text-commit')).toBeVisible();
  await page.keyboard.type('Neu');
  await page.keyboard.press('Escape');
  const [edited] = await textLayers(page);
  expect(edited!.text).toBe('Neu');
  expect(edited!.name).toBe('Neu');
});

test('German umlauts, Arabic, IME composition and pasted text render', async ({ page }) => {
  await chooseTextTool(page);
  await clickAt(page, 40, 120);
  await page.keyboard.type('Grüße aus Köln: ÄÖÜ ß');
  await page.keyboard.press('Escape');
  await clickAt(page, 40, 300);
  await page.keyboard.insertText('مرحبا بالعالم');
  // IME: composition updates show inline, the final text replaces them.
  await page.evaluate(() => {
    const input = document.querySelector('[data-testid="text-input"]')!;
    input.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    input.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'に' }));
    input.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'にほ' }));
    input.dispatchEvent(new CompositionEvent('compositionend', { data: '日本' }));
  });
  // Plain-text paste arrives as an input event of the hidden field.
  await page.evaluate(() => {
    const input = document.querySelector('[data-testid="text-input"]') as HTMLTextAreaElement;
    input.value = ' 1\r\n2';
    input.dispatchEvent(new InputEvent('input', { inputType: 'insertFromPaste', bubbles: true }));
  });
  await page.keyboard.press('Escape');
  const layers = await textLayers(page);
  expect(layers.map((layer) => layer.text)).toEqual(['Grüße aus Köln: ÄÖÜ ß', 'مرحبا بالعالم日本 1\n2']);
  await expect.poll(async () => (await ink(page, 30, 60, 700, 90)).count, { timeout: 30_000 }).toBeGreaterThan(300);
  await expect.poll(async () => (await ink(page, 30, 240, 700, 150)).count, { timeout: 30_000 }).toBeGreaterThan(300);
});

test('a document with an unknown font says so once and can replace it', async ({ page }) => {
  await page.evaluate(() => {
    const session = (window as any).__editorForTests.session;
    session.createPointText({ x: 60, y: 80 }, 'Imaginary', {
      schemaVersion: 1, fontFamily: 'Imaginary Sans', fontStyle: 'normal', fontWeight: 400, fontSize: 40,
      color: { red: 0, green: 0, blue: 0, alpha: 1 }, tracking: 0, kerning: 'metric', leading: null, baselineShift: 0, features: {}, axes: {},
    });
  });
  const notice = page.getByTestId('missing-fonts');
  await expect(notice).toBeVisible({ timeout: 90_000 });
  await expect(notice.getByTestId('missing-font')).toHaveAttribute('data-family', 'Imaginary Sans');
  // Drawn with the substitute meanwhile, never silently rewritten.
  await expect.poll(async () => (await ink(page, 50, 60, 400, 80)).count, { timeout: 30_000 }).toBeGreaterThan(100);
  expect((await textLayers(page))[0]!.runs[0]!.fontFamily).toBe('Imaginary Sans');
  await notice.getByTestId('replacement-font').selectOption('Noto Sans');
  await notice.getByTestId('replace-font').click();
  await expect(notice).toHaveCount(0);
  expect((await textLayers(page))[0]!.runs[0]!.fontFamily).toBe('Noto Sans');
  expect((await history(page)).name).toBe('Replace Font');
  // Undo brings the missing font back, but the notice was already shown for this document.
  await page.evaluate(() => (window as any).__handle.undo());
  await expect.poll(async () => (await textLayers(page))[0]!.runs[0]!.fontFamily).toBe('Imaginary Sans');
  await page.waitForTimeout(500);
  await expect(notice).toHaveCount(0);
});

test('exports include the text', async ({ page }) => {
  await chooseTextTool(page);
  await page.getByTestId('font-size').fill('72');
  await page.getByTestId('font-size').press('Enter');
  await clickAt(page, 100, 250);
  await page.keyboard.type('Export');
  await page.keyboard.press('Escape');
  const image = await exportedPixels(page);
  expect([image.width, image.height]).toEqual([800, 500]);
  let covered = 0;
  for (let y = 150; y < 280; y++) for (let x = 90; x < 500; x++) if (image.data[(y * image.width + x) * 4 + 3]! > 128) covered++;
  expect(covered).toBeGreaterThan(1000);
  let outside = 0;
  for (let y = 300; y < 500; y++) for (let x = 0; x < 800; x++) if (image.data[(y * image.width + x) * 4 + 3]! > 0) outside++;
  expect(outside).toBe(0);
});
