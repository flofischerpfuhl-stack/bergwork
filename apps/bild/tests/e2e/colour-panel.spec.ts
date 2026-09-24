import { expect, test, type Page } from '@playwright/test';
import { encodePng } from '../../src/io/png';
import { importThroughMenu, mountForTest } from './helpers';

/*
 * Colour panel, swatches, recent colours and the eyedropper everywhere (PRODUCT-PLAN 6.1, 6.4).
 */

test.use({ viewport: { width: 1440, height: 900 } });

const fgHex = (page: Page) => page.getByTestId('color-panel-fg').getAttribute('data-hex');
const bgHex = (page: Page) => page.getByTestId('color-panel-bg').getAttribute('data-hex');
const historyLength = (page: Page) => page.evaluate(() => (window as any).__editorForTests.session.history.pastNames.length as number);

async function newCanvas(page: Page, width: number, height: number): Promise<void> {
  await page.getByTestId('widthInput').fill(String(width));
  await page.getByTestId('heightInput').fill(String(height));
  await page.getByTestId('createCanvas').click();
}

async function openColorTab(page: Page): Promise<void> {
  await page.getByTestId('tab-color').click();
  await expect(page.getByTestId('color-panel')).toBeVisible();
}

/** Screen position of a document pixel (the canvas is fitted and centred after create/import). */
async function canvasMapper(page: Page, width: number, height: number) {
  const pane = (await page.getByTestId('canvas-pane').boundingBox())!;
  const zoom = parseFloat((await page.getByTestId('zoomStatus').textContent())!) / 100 / (await page.evaluate(() => devicePixelRatio));
  const origin = { x: pane.x + pane.width / 2 - width / 2 * zoom, y: pane.y + pane.height / 2 - height / 2 * zoom };
  return (x: number, y: number) => ({ x: origin.x + x * zoom, y: origin.y + y * zoom });
}

/** Mounts with a host that has a ScreenColorHost and, optionally, no browser EyeDropper API. */
async function mountWithScreenHost(page: Page, options: { hostColor: [number, number, number] | null; hideEyeDropper: boolean }): Promise<void> {
  await page.goto('/?harness=ui');
  await page.evaluate(async ({ hostColor, hideEyeDropper }) => {
    document.body.style.cssText = 'margin:0;width:100vw;height:100vh;overflow:hidden';
    if (hideEyeDropper) delete (window as any).EyeDropper;
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const { mountEditor } = await load('/src/index.ts');
    const { createBrowserHost } = await load('/src/platform/browserHost.ts');
    const { chooseSaveTarget: _c, saveFileTo: _s, ...base } = createBrowserHost();
    const capabilities = { ...(base.capabilities ?? {}) };
    if (hostColor) capabilities.screenColor = { version: 1, async pickScreenColor() { return { red: hostColor[0], green: hostColor[1], blue: hostColor[2] }; } };
    else delete capabilities.screenColor;
    (window as any).__handle = await mountEditor(document.getElementById('root')!, { locale: 'en', theme: 'dark',
      host: { ...base, capabilities, async saveFile() {}, reportError() {} } });
  }, options);
}

/** A PNG made in Node: left half black, right half white. */
function splitPng(width: number, height: number): Buffer {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(x < width / 2 ? [0, 0, 0, 255] : [255, 255, 255, 255], (y * width + x) * 4);
  return Buffer.from(encodePng(data, width, height, 4));
}
function solidPng(width: number, height: number, rgba: [number, number, number, number]): Buffer {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(rgba, i * 4);
  return Buffer.from(encodePng(data, width, height, 4));
}

/** Adobe Swatch Exchange written from the published layout (big-endian, UTF-16 names, float32 values). */
function aseFile(groups: { name: string; entries: { name: string; model: 'RGB ' | 'CMYK' | 'LAB ' | 'Gray'; values: number[] }[] }[]): Buffer {
  const out: number[] = [];
  const u16 = (v: number) => out.push((v >> 8) & 0xff, v & 0xff);
  const u32 = (v: number) => out.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  const name = (s: string) => { const b: number[] = [((s.length + 1) >> 8) & 0xff, (s.length + 1) & 0xff]; for (const c of s) b.push(c.charCodeAt(0) >> 8, c.charCodeAt(0) & 0xff); b.push(0, 0); return b; };
  for (const c of 'ASEF') out.push(c.charCodeAt(0));
  u16(1); u16(0); u32(groups.reduce((n, g) => n + g.entries.length + 2, 0));
  for (const group of groups) {
    const title = name(group.name);
    u16(0xc001); u32(title.length); out.push(...title);
    for (const entry of group.entries) {
      const block = [...name(entry.name), ...[...entry.model].map((c) => c.charCodeAt(0))];
      for (const v of entry.values) { const f = new DataView(new ArrayBuffer(4)); f.setFloat32(0, v); block.push(...new Uint8Array(f.buffer)); }
      block.push(0, 2);
      u16(0x0001); u32(block.length); out.push(...block);
    }
    u16(0xc002); u32(0);
  }
  return Buffer.from(out);
}

test('sliders and hex edit the foreground and background live, without undo steps', async ({ page }) => {
  await mountForTest(page);
  await newCanvas(page, 40, 30);
  await openColorTab(page);
  const steps = await historyLength(page);
  expect(await fgHex(page)).toBe('000000');
  // HSB sliders (default model): brightness up gives red, then hue 120° gives green.
  await page.getByTestId('slider-s').fill('100');
  await page.getByTestId('slider-b').fill('100');
  await expect.poll(() => fgHex(page)).toBe('FF0000');
  await page.getByTestId('slider-h').fill('120');
  await expect.poll(() => fgHex(page)).toBe('00FF00');
  // The number field next to a slider edits it too.
  await page.getByTestId('slider-h-value').fill('240');
  await expect.poll(() => fgHex(page)).toBe('0000FF');
  // RGB sliders.
  await page.getByTestId('slider-model-rgb').click();
  await page.getByTestId('slider-r').fill('255');
  await expect.poll(() => fgHex(page)).toBe('FF00FF');
  // Hex field; the tool rail's chip follows.
  const hex = page.getByTestId('color-panel-hex');
  await hex.fill('ff8800');
  await hex.press('Enter');
  await expect.poll(() => fgHex(page)).toBe('FF8800');
  const railFg = page.getByRole('toolbar').getByRole('button', { name: 'Foreground color' });
  await expect.poll(() => railFg.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(255, 136, 0)');
  // Lab (D50) and naive CMYK readouts.
  await expect(page.getByTestId('cmyk-m')).toContainText('47');
  await expect(page.getByTestId('cmyk-y')).toContainText('100');
  await expect(page.getByTestId('lab-l')).toContainText('69');
  // The background chip becomes the target; its colour changes, the foreground stays.
  await page.getByTestId('color-panel-bg').click();
  await expect(page.getByTestId('color-panel-bg')).toHaveAttribute('aria-pressed', 'true');
  await hex.fill('#00f');
  await hex.press('Enter');
  await expect.poll(() => bgHex(page)).toBe('0000FF');
  expect(await fgHex(page)).toBe('FF8800');
  // Colours are app state: no undo steps.
  expect(await historyLength(page)).toBe(steps);
});

test('swatches: click sets the foreground, Alt-click the background; document swatches are undoable', async ({ page }) => {
  await mountForTest(page);
  await newCanvas(page, 40, 30);
  await openColorTab(page);
  // The app-wide library starts with basic colours.
  await page.getByTestId('swatch-scope-library').click();
  const library = page.getByTestId('swatch');
  await expect(library).toHaveCount(12);
  await page.getByTestId('swatches').getByRole('listitem', { name: 'Red', exact: true }).click();
  await expect.poll(() => fgHex(page)).toBe('FF0000');
  await page.getByTestId('swatches').getByRole('listitem', { name: 'Blue', exact: true }).click({ modifiers: ['Alt'] });
  await expect.poll(() => bgHex(page)).toBe('0054A6');
  expect(await fgHex(page)).toBe('FF0000');

  // Document swatches: New Swatch adds the foreground colour as one undo step.
  await page.getByTestId('swatch-scope-document').click();
  await expect(page.getByTestId('swatches-empty')).toBeVisible();
  await page.getByTestId('swatch-add').click();
  const swatch = page.getByTestId('swatches').getByTestId('swatch');
  await expect(swatch).toHaveCount(1);
  await expect(swatch).toHaveAttribute('data-hex', 'FF0000');
  expect(await page.evaluate(() => (window as any).__editorForTests.session.history.pastNames.at(-1))).toBe('New Swatch');
  // Rename by double-click.
  await swatch.dblclick();
  await page.getByTestId('swatch-rename').fill('Brand Red');
  await page.getByTestId('swatch-rename').press('Enter');
  await expect(swatch).toHaveAttribute('aria-label', 'Brand Red');
  const docSwatches = () => page.evaluate(() => (window as any).__editorForTests.session.document.swatches?.[0]?.swatches.map((s: any) => s.name) ?? []);
  expect(await docSwatches()).toEqual(['Brand Red']);
  // Undo restores the old name; redo the new one.
  await page.getByTestId('compositor-editor').focus();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await expect.poll(docSwatches).toEqual(['Swatch 1']);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+Shift+z');
  await expect.poll(docSwatches).toEqual(['Brand Red']);
  // The swatches are saved with the project.
  const saved = await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const { unzipSync } = await load('/node_modules/.vite/deps/fflate.js').catch(() => load('fflate'));
    const blob: Blob = await (window as any).__handle.saveProject();
    return JSON.parse(new TextDecoder().decode(unzipSync(new Uint8Array(await blob.arrayBuffer()))['manifest.json'])).swatches;
  });
  expect(saved[0].swatches[0]).toMatchObject({ name: 'Brand Red', color: { red: 1, green: 0, blue: 0 } });
  // Delete the selected swatch.
  await swatch.click();
  await page.getByTestId('swatch-delete').click();
  await expect(swatch).toHaveCount(0);
});

test('imports a generated .ase through the file chooser and exports .ase', async ({ page }) => {
  await mountForTest(page);
  await newCanvas(page, 40, 30);
  await openColorTab(page);
  await page.getByTestId('swatch-scope-library').click();
  const file = aseFile([{ name: 'Brand', entries: [
    { name: 'Signal', model: 'RGB ', values: [1, 0.5, 0] },
    { name: 'Print Cyan', model: 'CMYK', values: [1, 0, 0, 0] },
    { name: 'Lab Gray', model: 'LAB ', values: [0.5, 0, 0] },
    { name: 'Paper', model: 'Gray', values: [1] },
  ] }]);
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('swatch-menu').click();
  await page.getByTestId('swatches-import').click();
  await (await chooser).setFiles({ name: 'brand.ase', mimeType: 'application/octet-stream', buffer: file });
  const group = page.locator('[data-testid=swatch-group][data-name="Brand"]');
  await expect(group.getByTestId('swatch')).toHaveCount(4);
  await expect(page.getByTestId('swatches-message')).toContainText('Imported 4 swatches.');
  await expect(page.getByTestId('swatches-message')).toContainText('CMYK');
  expect(await group.getByTestId('swatch').nth(0).getAttribute('data-hex')).toBe('FF8000');
  expect(await group.getByTestId('swatch').nth(1).getAttribute('data-hex')).toBe('00FFFF');
  // Lab 50/0/0 is a neutral mid gray (D50 → sRGB 119).
  expect(await group.getByTestId('swatch').nth(2).getAttribute('data-hex')).toBe('777777');
  expect(await group.getByTestId('swatch').nth(3).getAttribute('data-hex')).toBe('FFFFFF');
  // The library survives a reload (local storage).
  await mountForTest(page);
  await newCanvas(page, 40, 30);
  await openColorTab(page);
  await expect(page.locator('[data-testid=swatch-group][data-name="Brand"]').getByTestId('swatch')).toHaveCount(4);
  // Export writes .ase through the host.
  await page.getByTestId('swatch-menu').click();
  await page.getByTestId('swatches-export').click();
  await expect.poll(() => page.evaluate(() => (window as any).__saved.map((s: any) => s.name))).toContain('Swatches.ase');
  const header = await page.evaluate(async () => {
    const entry = (window as any).__saved.find((s: any) => s.name === 'Swatches.ase');
    return Array.from(new Uint8Array(await entry.blob.arrayBuffer()).slice(0, 4)).map((b) => String.fromCharCode(b as number)).join('');
  });
  expect(header).toBe('ASEF');
});

test('the eyedropper samples the composite or the current layer, with 1 px, 3×3 and 5×5 sample sizes', async ({ page }) => {
  await mountForTest(page);
  // 20×20: left half black, right half white; then a 10×20 blue layer, centred over columns 5–14.
  await importThroughMenu(page, [{ name: 'split.png', mimeType: 'image/png', buffer: splitPng(20, 20) }]);
  await expect.poll(() => page.evaluate(() => (window as any).__editorForTests.session.document?.layers.length ?? 0)).toBe(1);
  await importThroughMenu(page, [{ name: 'blue.png', mimeType: 'image/png', buffer: solidPng(10, 20, [0, 0, 255, 255]) }]);
  await expect.poll(() => page.evaluate(() => (window as any).__editorForTests.session.document?.layers.length ?? 0)).toBe(2);
  expect(await page.evaluate(() => (window as any).__editorForTests.session.document.layers[1].transform.origin)).toEqual({ x: 5, y: 0 });
  await openColorTab(page);
  await page.getByTestId('tool-eyedropper').click();
  const at = await canvasMapper(page, 20, 20);
  const click = async (x: number, y: number, alt = false) => {
    const p = at(x, y);
    if (alt) await page.keyboard.down('Alt');
    await page.mouse.click(p.x, p.y);
    if (alt) await page.keyboard.up('Alt');
  };

  // All layers (default), point sample: the blue layer over the black half.
  await click(7.5, 10);
  await expect.poll(() => fgHex(page)).toBe('0000FF');
  await click(2.5, 10);
  await expect.poll(() => fgHex(page)).toBe('000000');
  await click(15.5, 10);
  await expect.poll(() => fgHex(page)).toBe('FFFFFF');
  // 3×3 and 5×5 averages across the blue/white edge (columns 13–15 and 12–16).
  await page.getByTestId('eyedropper-size').selectOption('3');
  await click(14.5, 10);
  await expect.poll(() => fgHex(page)).toBe('5555FF');
  await page.getByTestId('eyedropper-size').selectOption('5');
  await click(14.5, 10);
  await expect.poll(() => fgHex(page)).toBe('6666FF');
  // Alt-click sets the background colour.
  await page.getByTestId('eyedropper-size').selectOption('1');
  await click(2.5, 10, true);
  await expect.poll(() => bgHex(page)).toBe('000000');
  // Current layer: select the bottom (split) layer — under the blue layer it is still black.
  await page.getByTestId('eyedropper-current').click();
  await page.evaluate(() => { const c = (window as any).__editorForTests; c.session.selectLayer(c.session.document.layers[0].id); c.session.notify('ui'); });
  await click(12.5, 10);
  await expect.poll(() => fgHex(page)).toBe('FFFFFF');
  await click(7.5, 10);
  await expect.poll(() => fgHex(page)).toBe('000000');
});

test('recent colours collect the colours used for painting, fills and shapes', async ({ page }) => {
  await mountForTest(page);
  await newCanvas(page, 100, 100);
  await openColorTab(page);
  await expect(page.getByTestId('recent-colors-empty')).toBeVisible();
  const at = await canvasMapper(page, 100, 100);
  const hex = page.getByTestId('color-panel-hex');
  const setFg = async (value: string) => { await hex.fill(value); await hex.press('Enter'); await expect.poll(() => fgHex(page)).toBe(value); };
  // A brush stroke in red.
  await setFg('FF0000');
  await page.getByTestId('tool-brush').click();
  let p = at(10, 50);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  p = at(60, 50);
  await page.mouse.move(p.x, p.y, { steps: 4 });
  await page.mouse.up();
  const recent = () => page.getByTestId('recent-color').evaluateAll((els) => els.map((el) => el.getAttribute('data-hex')));
  await expect.poll(recent).toEqual(['FF0000']);
  // Fill with the foreground colour (green).
  await setFg('00FF00');
  await page.getByTestId('compositor-editor').focus();
  await page.keyboard.press('Alt+Backspace');
  await expect.poll(recent).toEqual(['00FF00', 'FF0000']);
  // A shape in blue.
  await setFg('0000FF');
  await page.getByTestId('tool-shape').click();
  p = at(60, 60);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  p = at(90, 90);
  await page.mouse.move(p.x, p.y, { steps: 4 });
  await page.mouse.up();
  await expect.poll(recent).toEqual(['0000FF', '00FF00', 'FF0000']);
  // Dropping a swatch on the shape fills it (one undo step) and records the colour.
  const dropped = await page.evaluate(({ x, y }) => {
    const target = document.elementFromPoint(x, y)!;
    const transfer = new DataTransfer();
    transfer.setData('application/x-fernwork-color', JSON.stringify({ red: 1, green: 1, blue: 0 }));
    target.dispatchEvent(new DragEvent('dragover', { dataTransfer: transfer, clientX: x, clientY: y, bubbles: true, cancelable: true }));
    target.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, clientX: x, clientY: y, bubbles: true, cancelable: true }));
    const session = (window as any).__editorForTests.session;
    const layer = session.document.layers.at(-1);
    return { kind: layer.kind, fill: layer.style?.fill?.color, step: session.history.pastNames.at(-1) };
  }, at(75, 75));
  expect(dropped).toEqual({ kind: 'vector', fill: { red: 1, green: 1, blue: 0 }, step: 'Set Vector Style' });
  await expect.poll(recent).toEqual(['FFFF00', '0000FF', '00FF00', 'FF0000']);
  // Using red again moves it to the front instead of adding it twice.
  await page.getByTestId('color-panel').getByTestId('recent-color').nth(3).click();
  await expect.poll(() => fgHex(page)).toBe('FF0000');
  await page.evaluate(() => { const c = (window as any).__editorForTests; c.session.selectLayer(c.session.document.layers[0].id); c.session.notify('ui'); });
  await page.getByTestId('compositor-editor').focus();
  await page.keyboard.press('Alt+Backspace');
  await expect.poll(recent).toEqual(['FF0000', 'FFFF00', '0000FF', '00FF00']);
  // The colour picker shows them too.
  await page.getByRole('toolbar').getByRole('button', { name: 'Foreground color' }).click();
  await expect(page.getByTestId('picker-recent-colors').getByTestId('recent-color')).toHaveCount(4);
  await page.getByTestId('picker-recent-colors').getByTestId('recent-color').nth(2).click();
  await page.getByTestId('color-ok').click();
  await expect.poll(() => fgHex(page)).toBe('0000FF');
  // Recent colours persist (app state in local storage; a reload would offer this unsaved document for recovery first).
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('fernwork.recentColors') ?? '[]')
    .map((c: { red: number; green: number; blue: number }) => [c.red, c.green, c.blue].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('').toUpperCase()));
  expect(stored).toEqual(['FF0000', 'FFFF00', '0000FF', '00FF00']);
});

test('the screen eyedropper uses the host capability, else falls back to the canvas', async ({ page }) => {
  await mountWithScreenHost(page, { hostColor: [10, 200, 30], hideEyeDropper: true });
  await newCanvas(page, 20, 20);
  await openColorTab(page);
  await expect(page.getByTestId('color-panel-eyedropper')).toHaveAttribute('data-method', 'host');
  await page.getByTestId('color-panel-eyedropper').click();
  await expect.poll(() => fgHex(page)).toBe('0AC81E');

  // No EyeDropper API and no host capability: the next canvas click samples.
  await mountWithScreenHost(page, { hostColor: null, hideEyeDropper: true });
  await importThroughMenu(page, [{ name: 'orange.png', mimeType: 'image/png', buffer: solidPng(20, 20, [250, 117, 39, 255]) }]);
  await expect.poll(() => page.evaluate(() => (window as any).__editorForTests.session.document?.layers.length ?? 0)).toBe(1);
  await openColorTab(page);
  await expect(page.getByTestId('color-panel-eyedropper')).toHaveAttribute('data-method', 'canvas');
  await page.getByTestId('color-panel-eyedropper').click();
  await expect(page.getByTestId('canvas-pick-armed')).toBeVisible();
  const at = await canvasMapper(page, 20, 20);
  const p = at(10, 10);
  await page.mouse.click(p.x, p.y);
  await expect.poll(() => fgHex(page)).toBe('FA7527');
  await expect(page.getByTestId('canvas-pick-armed')).toHaveCount(0);
  // The tool did not change: the pick was one-shot.
  expect(await page.evaluate(() => (window as any).__editorForTests.session.tool)).not.toBe('eyedropper');
});

test('German labels', async ({ page }) => {
  await mountForTest(page, { locale: 'de' });
  await newCanvas(page, 40, 30);
  await expect(page.getByTestId('tab-color')).toHaveText('Farbe');
  await openColorTab(page);
  const panel = page.getByTestId('color-panel');
  await expect(panel.getByRole('button', { name: 'Vordergrundfarbe' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Hintergrundfarbe' })).toBeVisible();
  await expect(panel.getByText('Zuletzt verwendet', { exact: true })).toBeVisible();
  await expect(panel.getByText('Farbfelder', { exact: true })).toBeVisible();
  await expect(panel.getByText('Hex', { exact: true })).toBeVisible();
  await expect(panel.getByText('naiv, unkalibriert', { exact: false })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Neues Farbfeld' })).toBeVisible();
  await expect(panel.getByRole('radio', { name: 'Dokument' })).toBeVisible();
  await expect(panel.getByRole('radio', { name: 'Bibliothek' })).toBeVisible();
  await expect(panel.getByRole('slider', { name: 'Farbton' })).toBeVisible();
  await page.getByTestId('swatch-menu').click();
  await expect(page.getByRole('menuitem', { name: 'Farbfelder importieren …' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByTestId('tool-eyedropper').click();
  await expect(page.getByLabel('Aufnahmebereich')).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Aktuelle Ebene' })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Alle Ebenen' })).toBeVisible();
  // Library basics are named in German on first run.
  await page.getByTestId('swatch-scope-library').click();
  await expect(page.locator('[data-testid=swatch-group][data-name="Grundfarben"]')).toBeVisible();
  await page.getByTestId('swatch-add').click();
  await expect(page.locator('[data-testid=swatch-group][data-name="Grundfarben"]').getByTestId('swatch')).toHaveCount(13);
});
