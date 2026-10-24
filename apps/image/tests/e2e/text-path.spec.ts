import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { mountForTest } from './helpers';

/**
 * Text on a path and Warp Text end to end (PRODUCT-PLAN 6.6, Phase 3): the Type tool's path cursor and click on a
 * shape or pen path, glyphs along a circle and an S-curve (checked in composited pixels), editing text on its path,
 * start/end/flip settings, the fifteen warp styles, undo, the German labels, and host-identical rasters.
 */

test.use({ viewport: { width: 1440, height: 900 } });
test.beforeEach(async ({ page }) => { await page.addInitScript(() => performance.setResourceTimingBufferSize(100_000)); });

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
/** Optional screenshot folder for the review (TEXTPATH_SHOTS=/path). */
const SHOTS = process.env.TEXTPATH_SHOTS ?? '';

async function newCanvas(page: Page, width = 800, height = 500): Promise<void> {
  await page.getByTestId('widthInput').fill(String(width));
  await page.getByTestId('heightInput').fill(String(height));
  await page.getByTestId('createCanvas').click();
  await expect(page.getByTestId('layer-row')).toHaveCount(1);
}

async function at(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  return page.evaluate(({ x, y }) => {
    const controller = (window as any).__editorForTests;
    const session = controller.session;
    const view = session.viewport.viewPoint({ x, y }, session.document);
    const rect = controller.canvasView.element.getBoundingClientRect();
    return { x: rect.left + view.x, y: rect.top + view.y };
  }, { x, y });
}
async function click(page: Page, x: number, y: number): Promise<void> {
  const point = await at(page, x, y);
  await page.mouse.click(point.x, point.y);
}
async function drag(page: Page, from: [number, number], to: [number, number], steps = 8): Promise<void> {
  const a = await at(page, ...from), b = await at(page, ...to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps });
  await page.mouse.up();
}
async function hoverCursor(page: Page, x: number, y: number): Promise<string> {
  const point = await at(page, x, y);
  await page.mouse.move(point.x - 3, point.y - 3);
  await page.mouse.move(point.x, point.y);
  return page.evaluate(() => (window as any).__editorForTests.canvasView.element.style.cursor as string);
}

async function chooseTextTool(page: Page): Promise<void> {
  await page.getByTestId('tool-text').click();
  await expect(page.locator('[data-testid="text-bar"][data-engine="ready"]')).toBeVisible({ timeout: 90_000 });
}

/** A path-only shape: no fill, a thin grey stroke (the tool's settings for the next shape). */
async function pathOnlyShapes(page: Page): Promise<void> {
  await page.getByTestId('vector-fill').click();
  await page.getByTestId('vector-fill-none').click();
  await page.getByTestId('vector-fill').click();
  await page.getByTestId('vector-stroke').click();
  await page.getByTestId('vector-stroke-solid').click();
  await page.getByTestId('vector-stroke').click();
}

async function drawCircle(page: Page): Promise<void> {
  await page.getByTestId('compositor-editor').press('u');
  await page.getByTestId('vector-kind-Ellipse').click();
  await pathOnlyShapes(page);
  await drag(page, [250, 100], [550, 400]);
  await expect.poll(() => page.evaluate(() => (window as any).__editorForTests.session.document.layers.some((layer: any) => layer.kind === 'vector')))
    .toBe(true);
}

interface TextInfo { id: string; text: string; name: string; textPath: any; textWarp: any; transform: any }
async function texts(page: Page): Promise<TextInfo[]> {
  return page.evaluate(() => (window as any).__editorForTests.session.document.layers.filter((layer: any) => layer.kind === 'text')
    .map((layer: any) => ({ id: layer.id, text: layer.text, name: layer.name, textPath: layer.textPath ?? null, textWarp: layer.textWarp ?? null,
      transform: layer.transform })));
}

/** Composited pixels with coverage, as document points (alpha > 24). */
async function inkPoints(page: Page, x: number, y: number, width: number, height: number): Promise<{ x: number; y: number }[]> {
  return page.evaluate(({ x, y, width, height }) => {
    const controller = (window as any).__editorForTests;
    const pixels: Uint8Array = controller.canvas.readRegion(controller.session.document, x, y, width, height);
    const result: { x: number; y: number }[] = [];
    for (let row = 0; row < height; row++) for (let column = 0; column < width; column++) {
      if (pixels[(row * width + column) * 4 + 3]! > 24) result.push({ x: x + column + 0.5, y: y + row + 0.5 });
    }
    return result;
  }, { x, y, width, height });
}
async function regionHash(page: Page, x: number, y: number, width: number, height: number): Promise<string> {
  return page.evaluate(async ({ x, y, width, height }) => {
    const controller = (window as any).__editorForTests;
    const pixels: Uint8Array = controller.canvas.readRegion(controller.session.document, x, y, width, height);
    const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(pixels).buffer as ArrayBuffer);
    return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
  }, { x, y, width, height });
}
async function history(page: Page): Promise<{ count: number; name: string; editing: boolean }> {
  return page.evaluate(() => {
    const session = (window as any).__editorForTests.session;
    return { count: session.history.undoCount, name: session.history.undoName, editing: session.history.isInTransaction };
  });
}
async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, name) });
}

const radius = (p: { x: number; y: number }) => Math.hypot(p.x - 400, p.y - 250);

/** Circle of radius 150 about (400, 250); text on it from its top. */
async function textOnCircle(page: Page, text: string): Promise<void> {
  await drawCircle(page);
  await chooseTextTool(page);
  // Over the circle's outline the Type tool offers type on a path; elsewhere it is the I-beam.
  expect(await hoverCursor(page, 400, 100)).toContain('svg');
  expect(await hoverCursor(page, 400, 250)).toBe('text');
  await click(page, 400, 100);
  await expect(page.getByTestId('text-commit')).toBeVisible();
  await page.keyboard.type(text);
}

for (const locale of ['en', 'de'] as const) {
  test(`text on a circle follows it, edits in place, moves, flips and undoes (${locale})`, async ({ page }) => {
    test.setTimeout(300_000);
    await mountForTest(page, { locale });
    await newCanvas(page);
    await textOnCircle(page, 'Text rund um den Kreis läuft');
    let layers = await texts(page);
    expect(layers).toHaveLength(1);
    expect(layers[0]!.textPath).not.toBeNull();
    expect(layers[0]!.textPath.path.closed).toBe(true);
    expect(layers[0]!.text).toBe('Text rund um den Kreis läuft');
    // Glyphs stand on the outside of the circle, clockwise from the top: at 12, 1:30 and 3 o'clock, none inside.
    await expect.poll(async () => (await inkPoints(page, 380, 60, 120, 45)).length, { timeout: 30_000 }).toBeGreaterThan(150);
    const ink = await inkPoints(page, 200, 50, 400, 400);
    const text = ink.filter((p) => radius(p) > 153);
    expect(text.length).toBeGreaterThan(1500);
    expect(Math.max(...text.map(radius))).toBeLessThan(150 + 40);
    expect(text.filter((p) => p.x > 555 && Math.abs(p.y - 250) < 30).length).toBeGreaterThan(40);
    expect(text.filter((p) => p.x > 480 && p.y < 170 && p.y > 100).length).toBeGreaterThan(40);
    expect(ink.filter((p) => radius(p) < 140).length).toBe(0);
    await shot(page, `circle-editing-${locale}.png`);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('text-commit')).toHaveCount(0);
    expect((await history(page)).name).toBe('Edit Text');

    // Clicking the glyphs edits the text on its path again (no new layer); the caret stands on the path.
    await click(page, 555 + 12, 250);
    await expect(page.getByTestId('text-commit')).toBeVisible();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End');
    await page.keyboard.type('!');
    layers = await texts(page);
    expect(layers).toHaveLength(1);
    expect(layers[0]!.text).toBe('Text rund um den Kreis läuft!');
    await page.keyboard.press('Escape');

    // Start at 25 % (3 o'clock), then flip: the text moves round and inside the circle.
    const before = await regionHash(page, 200, 50, 400, 400);
    const clickedStart = (await texts(page))[0]!.textPath.start as number;
    await page.getByTestId('path-text-toggle').click();
    await expect(page.getByTestId('path-text-panel')).toBeVisible();
    await shot(page, `path-panel-${locale}.png`);
    await page.getByTestId('path-start').fill('25');
    await page.getByTestId('path-start').press('Enter');
    await expect.poll(async () => (await texts(page))[0]!.textPath.start).toBeCloseTo(0.25, 6);
    await expect.poll(() => regionHash(page, 200, 50, 400, 400)).not.toBe(before);
    expect((await history(page)).name).toBe('Change Path Text');
    await expect.poll(async () => (await inkPoints(page, 380, 60, 40, 40)).length).toBe(0);
    await page.getByTestId('path-flip').check();
    await expect.poll(async () => (await texts(page))[0]!.textPath.flipped).toBe(true);
    await expect.poll(async () => (await inkPoints(page, 200, 50, 400, 400)).filter((p) => radius(p) < 147).length).toBeGreaterThan(1000);
    const flipped = await inkPoints(page, 200, 50, 400, 400);
    expect(flipped.filter((p) => radius(p) > 153).length).toBe(0);
    await page.keyboard.press('Escape');

    // Undo: flip, start, the typed "!", then the whole path text.
    const canvas = page.getByTestId('compositor-editor');
    await canvas.press(`${mod}+z`);
    expect((await texts(page))[0]!.textPath.flipped).toBe(false);
    await canvas.press(`${mod}+z`);
    expect((await texts(page))[0]!.textPath.start).toBe(clickedStart);
    await canvas.press(`${mod}+z`);
    expect((await texts(page))[0]!.text).toBe('Text rund um den Kreis läuft');
    await canvas.press(`${mod}+z`);
    expect(await texts(page)).toHaveLength(0);
    await expect.poll(async () => (await inkPoints(page, 200, 50, 400, 400)).filter((p) => radius(p) > 153).length).toBe(0);
  });
}

test('text on an S-curve drawn with the Pen bends with it; each character is shaped once', async ({ page }) => {
  test.setTimeout(300_000);
  await mountForTest(page, { locale: 'en' });
  await newCanvas(page);
  await page.getByTestId('compositor-editor').press('p');
  await pathOnlyShapes(page);
  // Smooth point with its handle up-right at (100, 250), smooth point at (700, 250) whose incoming handle comes from
  // below left (dragging up-right mirrors it): an S.
  await drag(page, [100, 250], [250, 50]);
  await drag(page, [700, 250], [850, 50]);
  await page.getByTestId('compositor-editor').press('Enter');
  const curve = await page.evaluate(() => {
    const layer = (window as any).__editorForTests.session.document.layers.find((value: any) => value.kind === 'vector');
    const o = layer.transform.origin;
    return layer.paths[0].points.map((point: any) => ({ anchor: { x: point.anchor.x + o.x, y: point.anchor.y + o.y },
      in: { x: point.in.x + o.x, y: point.in.y + o.y }, out: { x: point.out.x + o.x, y: point.out.y + o.y } }));
  });
  expect(curve).toHaveLength(2);
  const cubic = (t: number) => {
    const [a, b] = curve as any[], u = 1 - t;
    const c = (p: number, q: number, r: number, s: number) => u * u * u * p + 3 * u * u * t * q + 3 * u * t * t * r + t * t * t * s;
    return { x: c(a.anchor.x, a.out.x, b.in.x, b.anchor.x), y: c(a.anchor.y, a.out.y, b.in.y, b.anchor.y) };
  };
  await chooseTextTool(page);
  const start = cubic(0.02);
  expect(await hoverCursor(page, start.x, start.y)).toContain('svg');
  await click(page, start.x, start.y);
  await page.keyboard.type('Wellen und Kurven folgen dem Pfad bis zum Ende');
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await inkPoints(page, 60, 20, 700, 460)).length, { timeout: 30_000 }).toBeGreaterThan(2500);
  const ink = await inkPoints(page, 60, 20, 700, 460);
  // Every ink pixel lies near the curve (the stroke itself and the glyphs above it).
  const samples = Array.from({ length: 400 }, (_, i) => cubic(i / 399));
  const near = (p: { x: number; y: number }) => Math.min(...samples.map((q) => Math.hypot(q.x - p.x, q.y - p.y)));
  const sample = ink.filter((_, i) => i % 7 === 0);
  expect(sample.every((p) => near(p) < 40)).toBe(true);
  // The glyphs rise with the first bend and fall with the second: text ink above the curve's top and near its bottom.
  const top = samples.reduce((best, p) => (p.y < best.y ? p : best)), bottom = samples.reduce((best, p) => (p.y > best.y ? p : best));
  expect(ink.filter((p) => Math.abs(p.x - top.x) < 25 && p.y < top.y - 4).length).toBeGreaterThan(60);
  expect(ink.filter((p) => Math.abs(p.x - bottom.x) < 25 && p.y < bottom.y - 4 && p.y > bottom.y - 40).length).toBeGreaterThan(60);
  const layer = (await texts(page))[0]!;
  expect(layer.textPath.path.closed).toBe(false);
  expect(layer.textPath.start).toBeLessThan(0.1);
  await shot(page, 's-curve-en.png');
});

test('each warp style changes the text; OK is one undo step and Cancel restores it (German labels)', async ({ page }) => {
  test.setTimeout(300_000);
  await mountForTest(page, { locale: 'de' });
  await newCanvas(page);
  await chooseTextTool(page);
  await click(page, 120, 280);
  await page.keyboard.type('Verkrümmt');
  await page.keyboard.press('Escape');
  const region = [80, 120, 520, 300] as const;
  await expect.poll(async () => (await inkPoints(page, ...region)).length, { timeout: 30_000 }).toBeGreaterThan(300);
  const flat = await regionHash(page, ...region);
  await expect(page.getByTestId('text-warp')).toHaveAttribute('title', 'Text verkrümmen');
  await page.getByTestId('text-warp').click();
  await expect(page.getByTestId('warp-panel')).toBeVisible();
  const panel = page.getByTestId('warp-panel');
  await expect(panel.getByRole('heading', { name: 'Text verkrümmen' })).toBeVisible();
  const styles = ['Bogen', 'Bogen unten', 'Bogen oben', 'Torbogen', 'Wulst', 'Muschel unten', 'Muschel oben', 'Flagge', 'Welle', 'Fisch',
    'Ansteigend', 'Fischauge', 'Aufblasen', 'Stauchen', 'Wirbel'];
  expect(await page.getByTestId('warp-style').locator('option').allTextContents()).toEqual(['Ohne', ...styles]);
  await expect(panel.getByText('Biegung', { exact: true })).toBeVisible();
  await expect(panel.getByText('Horizontale Verzerrung', { exact: true })).toBeVisible();
  await expect(panel.getByText('Vertikale Verzerrung', { exact: true })).toBeVisible();
  await expect(panel.getByText('Stil', { exact: true })).toBeVisible();
  const seen = new Set<string>([flat]);
  for (const label of styles) {
    await page.getByTestId('warp-style').selectOption({ label });
    const previous = seen.size;
    await expect.poll(async () => { seen.add(await regionHash(page, ...region)); return seen.size; }, { message: label }).toBe(previous + 1);
    if (label === 'Bogen') await shot(page, 'warp-arc-de.png');
  }
  expect(seen.size).toBe(16);
  // Distortion and bend change it too; OK records one step.
  await page.getByTestId('warp-style').selectOption({ label: 'Flagge' });
  const flag = await regionHash(page, ...region);
  await page.getByTestId('warp-horizontal').fill('40');
  await page.getByTestId('warp-horizontal').press('Tab');
  await expect.poll(() => regionHash(page, ...region)).not.toBe(flag);
  const count = (await history(page)).count;
  await page.getByTestId('warp-ok').click();
  await expect(page.getByTestId('warp-panel')).toHaveCount(0);
  expect(await history(page)).toMatchObject({ count: count + 1, name: 'Warp Text', editing: false });
  const warp = (await texts(page))[0]!.textWarp;
  expect(warp).toMatchObject({ style: 'flag', bend: 50, horizontalDistortion: 40 });
  // Cancel throws a change away.
  const warped = await regionHash(page, ...region);
  await page.getByTestId('text-warp').click();
  await page.getByTestId('warp-style').selectOption({ label: 'Wirbel' });
  await expect.poll(() => regionHash(page, ...region)).not.toBe(warped);
  await page.getByTestId('warp-cancel').click();
  await expect.poll(() => regionHash(page, ...region)).toBe(warped);
  expect((await history(page)).count).toBe(count + 1);
  // Undo returns to the flat text.
  await page.getByTestId('compositor-editor').press(`${mod}+z`);
  expect((await texts(page))[0]!.textWarp).toBeNull();
  await expect.poll(() => regionHash(page, ...region)).toBe(flat);
});

for (const locale of ['de', 'en'] as const) test(`labels of text on a path (${locale})`, async ({ page }) => {
  test.setTimeout(240_000);
  {
    await mountForTest(page, { locale });
    await newCanvas(page);
    await textOnCircle(page, locale === 'de' ? 'Pfadtext' : 'Path text');
    await page.getByTestId('path-text-toggle').click();
    const panel = page.getByTestId('path-text-panel');
    if (locale === 'de') {
      await expect(page.getByTestId('path-text-toggle')).toHaveText('Pfadtext');
      await expect(panel.getByRole('heading', { name: 'Text auf Pfad' })).toBeVisible();
      for (const label of ['Anfang', 'Ende', 'Grundlinienversatz', 'Umkehren']) await expect(panel.getByText(label, { exact: true })).toBeVisible();
      await expect(page.getByTestId('text-warp')).toHaveAttribute('title', 'Text auf einem Pfad kann nicht verkrümmt werden');
      await expect(page.getByText(/Auf einen Pfad klicken für Pfadtext/)).toBeVisible();
    } else {
      await expect(page.getByTestId('path-text-toggle')).toHaveText('Path Text');
      await expect(panel.getByRole('heading', { name: 'Text on Path' })).toBeVisible();
    }
    await expect(page.getByTestId('text-warp')).toBeDisabled();
  }
});

// Host-identical rendering (A5): the same text on a circle, on an S-curve and under three warps, at 1× and 2×, must
// produce the same RGBA bytes in Chromium, Firefox and WebKit.
const EXPECTED_PATH_SHA256 = 'aecee6f4593d336ceb1e2653b0c98cc682ebc1392ee40d4c0c83bc44148219c1';

test('text on a path and warped text rasterize identically in every browser', async ({ page }, info) => {
  test.setTimeout(240_000);
  await page.goto('/?harness=text-engine');
  const hash = await page.evaluate(async () => {
    const load = (url: string): Promise<any> => import(/* @vite-ignore */ url);
    const [{ loadTextEngine }, core, geometry, document] = await Promise.all([load('/src/text/index.ts'), load('/src/core/text/index.ts'),
      load('/src/core/geometry.ts'), load('/src/core/document.ts')]);
    const engine = await loadTextEngine();
    const fonts = new core.TextFontRegistry(engine);
    await fonts.loadBundledFallbacks();
    const k = 0.5522847498 * 150;
    const p = (x: number, y: number, ix: number, iy: number, ox: number, oy: number) => ({ anchor: { x, y }, in: { x: ix, y: iy }, out: { x: ox, y: oy }, kind: 'smooth' });
    const circle = { schemaVersion: 1, closed: true, fillRule: 'nonzero', points: [p(200, 50, 200 - k, 50, 200 + k, 50), p(350, 200, 350, 50 + 150 - k, 350, 200 + k),
      p(200, 350, 200 + k, 350, 200 - k, 350), p(50, 200, 50, 200 + k, 50, 200 - k)] };
    const curve = { schemaVersion: 1, closed: false, fillRule: 'nonzero', points: [
      { anchor: { x: 20, y: 150 }, in: { x: 20, y: 150 }, out: { x: 150, y: -50 }, kind: 'smooth' },
      { anchor: { x: 380, y: 150 }, in: { x: 250, y: 350 }, out: { x: 380, y: 150 }, kind: 'smooth' }] };
    const text = 'Übergröße AVATAR office ﬁne Kreis';
    const style = { ...document.DEFAULT_TEXT_STYLE, fontSize: 26, color: { red: 0.1, green: 0.2, blue: 0.5, alpha: 1 }, tracking: 20 };
    const make = (fields: object) => document.newLayer({ id: 't', name: 'T', kind: 'text', text, transform: geometry.makeTransform({ x: 0, y: 0 }, { width: 400, height: 400 }),
      runs: [{ from: 0, to: text.length, style }], ...fields });
    const onPath = (path: object, patch: object = {}) => ({ schemaVersion: 1, path, start: 0.05, end: (path as any).closed ? 0.05 : 1, flipped: false, baselineOffset: 2, ...patch });
    const warp = (style: string) => ({ schemaVersion: 1, style, orientation: 'horizontal', bend: 45, horizontalDistortion: 10, verticalDistortion: -5 });
    const layers = [make({ textPath: onPath(circle) }), make({ textPath: onPath(circle, { flipped: true }) }), make({ textPath: onPath(curve) }),
      make({ textWarp: warp('arc') }), make({ textWarp: warp('flag') }), make({ textWarp: warp('twist') })];
    const chunks: Uint8Array[] = [];
    for (const scale of [1, 2]) for (const layer of layers) {
      const doc = { id: 'd', width: 400, height: 400, resolution: 72, layers: [layer], selection: null };
      const layout = core.layoutTextLayer(engine, fonts, doc, layer, scale);
      chunks.push(new Uint8Array(new Uint32Array([layout.raster.width, layout.raster.height]).buffer), layout.raster.toPixels());
      layout.dispose();
    }
    engine.dispose();
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0), all = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
    const digest = await crypto.subtle.digest('SHA-256', all.buffer as ArrayBuffer);
    return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
  });
  console.log(`${info.project.name} text-path raster SHA-256 ${hash}`);
  expect(hash).toBe(EXPECTED_PATH_SHA256);
});
