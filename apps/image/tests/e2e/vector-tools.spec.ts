import { expect, test, type Page } from '@playwright/test';
import { exportedPixels, importThroughMenu, mountForTest, solidPng } from './helpers';

/**
 * Vector tools end to end (PRODUCT-PLAN A5, 6.2, 6.6, M12): the Shape tool's five primitives, live style and parameter
 * edits as single undo steps, the Pen with corner and smooth points, Direct Selection, Combine Shapes, vector masks,
 * selection from a path, arrowheads and the German labels.
 */

test.use({ viewport: { width: 1440, height: 900 } });
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

async function newCanvas(page: Page, width = 300, height = 300): Promise<void> {
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

async function drag(page: Page, from: [number, number], to: [number, number], steps = 6): Promise<void> {
  const a = await at(page, ...from), b = await at(page, ...to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps });
  await page.mouse.up();
}

async function click(page: Page, x: number, y: number): Promise<void> {
  const point = await at(page, x, y);
  await page.mouse.click(point.x, point.y);
}

interface VectorInfo {
  id: string; name: string; kind: string; shape: any; style: any; closed: boolean[]; points: any[][]; transform: any; vectorMask: any;
}
async function layers(page: Page): Promise<VectorInfo[]> {
  return page.evaluate(() => (window as any).__editorForTests.session.document.layers.map((layer: any) => ({
    id: layer.id, name: layer.name, kind: layer.kind, shape: layer.sourceShape ?? null, style: layer.style ?? null,
    closed: (layer.paths ?? []).map((path: any) => path.closed), points: (layer.paths ?? []).map((path: any) => path.points),
    transform: layer.transform, vectorMask: layer.vectorMask,
  })));
}

/** Waits until every vector layer is drawn by the engine. */
async function rendered(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => {
    const session = (window as any).__editorForTests.session;
    return session.document.layers.every((layer: any) => layer.kind !== 'vector' || !!session.displayedRaster(layer));
  }), { timeout: 90_000 }).toBe(true);
}

/** Composited RGBA of one document pixel, as the canvas and exports draw it. */
async function pixel(page: Page, x: number, y: number): Promise<number[]> {
  await rendered(page);
  return page.evaluate(({ x, y }) => {
    const controller = (window as any).__editorForTests;
    return Array.from(controller.canvas.readRegion(controller.session.document, x, y, 1, 1) as Uint8Array);
  }, { x, y });
}

async function undoCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as any).__editorForTests.session.history.undoCount);
}

/** Drags a scrubby label in the context bar by `dx` points. */
async function scrub(page: Page, label: string, dx: number): Promise<void> {
  const target = page.getByTestId('context-bar').getByText(label, { exact: true });
  const box = (await target.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 5; i++) await page.mouse.move(box.x + box.width / 2 + dx * i / 5, box.y + box.height / 2);
  await page.mouse.up();
}

/** A menu item by its label (submenu items carry a trailing ›). */
function item(page: Page, label: string) {
  const escaped = label.replace(/[.*+?^$()|[\]\\]/g, (c) => `\\${c}`);
  return page.getByRole('menuitem', { name: new RegExp(`^${escaped}( ›)?$`) });
}

async function menu(page: Page, title: string, ...items: string[]): Promise<void> {
  await page.getByTestId(`menu-${title}`).click();
  for (const [index, label] of items.entries()) {
    const entry = item(page, label);
    if (index < items.length - 1) await entry.hover(); else await entry.click();
  }
}

test('the Shape tool draws each primitive as an editable vector layer', async ({ page }) => {
  test.setTimeout(180_000);
  await mountForTest(page);
  await newCanvas(page);
  await page.getByTestId('compositor-editor').press('u');
  await expect(page.getByTestId('vector-kind-Rectangle')).toHaveAttribute('aria-checked', 'true');

  // Rectangle, Shift-U cycles to the Ellipse, then the kind buttons choose Polygon, Star and Line.
  await drag(page, [10, 10], [90, 70]);
  await page.getByTestId('compositor-editor').press('Shift+U');
  await expect(page.getByTestId('vector-kind-Ellipse')).toHaveAttribute('aria-checked', 'true');
  await drag(page, [110, 10], [190, 90]);
  await page.getByTestId('vector-kind-Polygon').click();
  await drag(page, [210, 10], [290, 90]);
  await page.getByTestId('vector-kind-Star').click();
  await drag(page, [10, 110], [110, 210]);
  await page.getByTestId('vector-kind-Line').click();
  await drag(page, [150, 150], [290, 150]);

  const all = await layers(page);
  const vectors = all.filter((layer) => layer.kind === 'vector');
  expect(vectors.map((layer) => layer.shape?.kind ?? 'path')).toEqual(['Rectangle', 'Ellipse', 'Polygon', 'Star', 'path']);
  expect(vectors.map((layer) => layer.name)).toEqual(['Rectangle 1', 'Ellipse 1', 'Polygon 1', 'Star 1', 'Line 1']);
  expect(vectors[0]!.transform.origin).toEqual({ x: 10, y: 10 });
  expect(vectors[0]!.transform.size).toEqual({ width: 80, height: 60 });
  expect(vectors[2]!.shape.sides).toBe(6);
  expect(vectors[3]!.shape.sides).toBe(5);
  expect(vectors[3]!.shape.innerRatio).toBe(0.5);
  // The line is an open two-anchor path stroked at the tool's weight.
  expect(vectors[4]!.closed).toEqual([false]);
  expect(vectors[4]!.style.fill).toBeNull();
  expect(vectors[4]!.style.stroke.width).toBe(3);

  // Rendered pixels: filled insides, empty ellipse and star corners, the line's stroke.
  expect(await pixel(page, 50, 40)).toEqual([0, 0, 0, 255]);
  expect(await pixel(page, 150, 50)).toEqual([0, 0, 0, 255]);
  expect((await pixel(page, 112, 12))[3]).toBe(0);
  expect(await pixel(page, 250, 50)).toEqual([0, 0, 0, 255]);
  expect((await pixel(page, 212, 12))[3]).toBe(0);
  expect(await pixel(page, 60, 160)).toEqual([0, 0, 0, 255]);
  expect((await pixel(page, 14, 205))[3]).toBe(0);
  expect((await pixel(page, 220, 150))[3]).toBe(255);
  expect((await pixel(page, 220, 155))[3]).toBe(0);

  // The export composites the same pixels.
  const exported = await exportedPixels(page);
  const at = (x: number, y: number) => exported.data.slice((y * exported.width + x) * 4, (y * exported.width + x) * 4 + 4);
  expect(at(50, 40)).toEqual([0, 0, 0, 255]);
  expect(at(220, 150)[3]).toBe(255);
});

test('radius, stroke and markers change the selected shape live, one undo step each', async ({ page }) => {
  test.setTimeout(180_000);
  await mountForTest(page);
  await newCanvas(page, 200, 200);
  await page.getByTestId('tool-shape').click();
  await drag(page, [20, 20], [180, 180]);
  expect(await pixel(page, 21, 21)).toEqual([0, 0, 0, 255]);
  const before = await undoCount(page);

  // Scrubbing the Radius label rounds the corners of the selected rectangle: one undo step for the whole drag.
  await scrub(page, 'Radius', 40);
  let [, rect] = await layers(page);
  expect(rect!.shape.cornerRadii[0]).toBeGreaterThan(20);
  expect(new Set(rect!.shape.cornerRadii).size).toBe(1);
  expect((await pixel(page, 21, 21))[3]).toBe(0);
  expect(await undoCount(page)).toBe(before + 1);

  // Unlinked corners: only the top-left radius changes.
  await page.getByTestId('vector-radius-link').click();
  await page.getByTestId('vector-radius-1').fill('0');
  await page.getByTestId('vector-radius-1').press('Enter');
  [, rect] = await layers(page);
  expect(rect!.shape.cornerRadii[1]).toBe(0);
  expect(rect!.shape.cornerRadii[0]).toBeGreaterThan(20);
  expect(await pixel(page, 178, 21)).toEqual([0, 0, 0, 255]);

  // A red solid stroke, then a wider one by typing: each is one undo step.
  await page.getByTestId('vector-stroke').click();
  await page.getByTestId('vector-stroke-solid').click();
  await page.evaluate(() => {
    const session = (window as any).__editorForTests.session;
    session.foregroundColor = { red: 1, green: 0, blue: 0 };
    session.notify('ui');
  });
  await page.getByTestId('vector-stroke-popover').getByRole('button', { name: 'Foreground color' }).click();
  [, rect] = await layers(page);
  expect(rect!.style.stroke.color).toEqual({ red: 1, green: 0, blue: 0 });
  expect(rect!.style.stroke.alignment).toBe('inside');
  await page.keyboard.press('Escape');
  const beforeWidth = await undoCount(page);
  await page.getByTestId('vector-stroke-width').fill('10');
  await page.getByTestId('vector-stroke-width').press('Enter');
  [, rect] = await layers(page);
  expect(rect!.style.stroke.width).toBe(10);
  expect(await undoCount(page)).toBe(beforeWidth + 1);
  // Inside alignment: the stroke is red inside the edge, and nothing is drawn outside the box.
  expect(await pixel(page, 100, 24)).toEqual([255, 0, 0, 255]);
  expect((await pixel(page, 100, 17))[3]).toBe(0);
  // Outside alignment moves it past the edge (the layer's rendered grid grows with it).
  await page.getByTestId('vector-stroke-options').click();
  await page.getByTestId('stroke-align-outside').click();
  expect(await pixel(page, 100, 15)).toEqual([255, 0, 0, 255]);
  expect(await pixel(page, 100, 24)).toEqual([0, 0, 0, 255]);
  // A dashed stroke.
  await page.getByTestId('stroke-dash-dashed').click();
  [, rect] = await layers(page);
  expect(rect!.style.stroke.dash).toEqual([40, 20]);
  await page.keyboard.press('Escape');

  // Scrubbing the stroke width via ↑ keeps one step per press; Undo walks back through the edits.
  await page.getByTestId('compositor-editor').press(`${mod}+z`);
  [, rect] = await layers(page);
  expect(rect!.style.stroke.dash ?? []).toEqual([]);
  await page.getByTestId('compositor-editor').press(`${mod}+z`);
  [, rect] = await layers(page);
  expect(rect!.style.stroke.alignment).toBe('inside');

  // Markers on a line: an arrow at the end, scrubbed larger in one step.
  await page.getByTestId('vector-kind-Line').click();
  await page.getByTestId('vector-operation').selectOption('new');
  await drag(page, [30, 100], [170, 100]);
  await page.getByTestId('vector-endMarker').selectOption('arrow');
  let line = (await layers(page)).at(-1)!;
  expect(line.style.stroke.endMarker).toBe('arrow');
  const beforeSize = await undoCount(page);
  await scrub(page, 'Size', 30);
  line = (await layers(page)).at(-1)!;
  expect(line.style.stroke.markerSize).toBeGreaterThan(3);
  expect(await undoCount(page)).toBe(beforeSize + 1);
});

test('the Pen draws corner and smooth points and closes; Direct Selection moves an anchor', async ({ page }) => {
  test.setTimeout(180_000);
  await mountForTest(page);
  await newCanvas(page, 200, 200);
  await page.getByTestId('compositor-editor').press('p');
  await expect(page.getByTestId('tool-pen')).toHaveAttribute('aria-pressed', 'true');
  await click(page, 20, 20);                       // corner
  await drag(page, [180, 40], [180, 90]);          // smooth point with handles
  await click(page, 40, 170);                      // corner
  await click(page, 20, 20);                       // back on the first point: closes the path
  let shape = (await layers(page)).at(-1)!;
  expect(shape.kind).toBe('vector');
  expect(shape.closed).toEqual([true]);
  expect(shape.points[0]).toHaveLength(3);
  const doc = (p: { x: number; y: number }) => ({ x: p.x + shape.transform.origin.x, y: p.y + shape.transform.origin.y });
  const smooth = shape.points[0]![1];
  expect(smooth.kind).toBe('smooth');
  expect(doc(smooth.out).y).toBeCloseTo(90, 0);
  expect(doc(smooth.in).y).toBeCloseTo(-10, 0);
  expect(shape.points[0]![0].kind).toBe('corner');
  // Filled inside the curved triangle.
  expect(await pixel(page, 80, 60)).toEqual([0, 0, 0, 255]);

  // Direct Selection (A): drag the bottom anchor to the right; one undo step.
  await page.getByTestId('compositor-editor').press('a');
  await expect(page.getByTestId('tool-directSelect')).toHaveAttribute('aria-pressed', 'true');
  const before = await undoCount(page);
  await drag(page, [40, 170], [120, 180]);
  shape = (await layers(page)).at(-1)!;
  const moved = shape.points[0]![2].anchor;
  expect(moved.x + shape.transform.origin.x).toBeCloseTo(120, 0);
  expect(moved.y + shape.transform.origin.y).toBeCloseTo(180, 0);
  expect(await undoCount(page)).toBe(before + 1);
  // Undo puts it back.
  await page.getByTestId('compositor-editor').press(`${mod}+z`);
  shape = (await layers(page)).at(-1)!;
  expect(shape.points[0]![2].anchor.x + shape.transform.origin.x).toBeCloseTo(40, 0);
  // Option-click converts the smooth point into a corner.
  await page.keyboard.down('Alt');
  await click(page, 180, 40);
  await page.keyboard.up('Alt');
  shape = (await layers(page)).at(-1)!;
  expect(shape.points[0]![1].kind).toBe('corner');
  expect(shape.points[0]![1].out).toEqual(shape.points[0]![1].anchor);
  // Marquee-select two anchors and delete them: too few points remain, so the subpath goes.
  await drag(page, [10, 10], [190, 60]);
  await page.getByTestId('compositor-editor').press('Delete');
  shape = (await layers(page)).at(-1)!;
  expect(shape.points).toHaveLength(0);
});

test('Subtract Front Shape clears the overlap; Merge Shapes keeps both subpaths', async ({ page }) => {
  test.setTimeout(180_000);
  await mountForTest(page);
  await newCanvas(page, 200, 200);
  await page.getByTestId('tool-shape').click();
  await drag(page, [20, 20], [120, 120]);
  await drag(page, [70, 70], [170, 170]);
  expect(await pixel(page, 95, 95)).toEqual([0, 0, 0, 255]);
  // Select both shape layers (⌘/Ctrl-click the first row) and subtract the front one.
  const rows = page.getByTestId('layer-row');
  await rows.nth(1).click({ modifiers: [mod === 'Meta' ? 'Meta' : 'Control'] });
  await menu(page, 'Layer', 'Combine Shapes', 'Subtract Front Shape');
  await expect.poll(async () => (await layers(page)).length).toBe(2);
  const combined = (await layers(page)).at(-1)!;
  expect(combined.shape).toBeNull();
  expect((await pixel(page, 95, 95))[3]).toBe(0);
  expect((await pixel(page, 150, 150))[3]).toBe(0);
  expect(await pixel(page, 40, 40)).toEqual([0, 0, 0, 255]);
  // Undo restores both layers in one step.
  await page.getByTestId('compositor-editor').press(`${mod}+z`);
  expect((await layers(page)).length).toBe(3);
  expect(await pixel(page, 95, 95)).toEqual([0, 0, 0, 255]);
  // Merge Shapes keeps both outlines as editable subpaths of one layer.
  await page.getByTestId('layer-row').nth(0).click();
  await page.getByTestId('layer-row').nth(1).click({ modifiers: [mod === 'Meta' ? 'Meta' : 'Control'] });
  await menu(page, 'Layer', 'Combine Shapes', 'Merge Shapes');
  await expect.poll(async () => (await layers(page)).length).toBe(2);
  expect((await layers(page)).at(-1)!.closed).toEqual([true, true]);
  expect(await pixel(page, 95, 95)).toEqual([0, 0, 0, 255]);
  expect(await pixel(page, 150, 150)).toEqual([0, 0, 0, 255]);
});

test('a vector mask from the current path hides pixels; Reveal All and Hide All; selection from a path', async ({ page }) => {
  test.setTimeout(180_000);
  await mountForTest(page);
  await newCanvas(page, 200, 200);
  await importThroughMenu(page, [{ name: 'red.png', mimeType: 'image/png', buffer: solidPng(200, 200, [255, 0, 0, 255]) }]);
  await expect(page.getByTestId('layer-row')).toHaveCount(2);
  // An ellipse on its own layer is the current path.
  await page.getByTestId('tool-shape').click();
  await page.getByTestId('vector-kind-Ellipse').click();
  await drag(page, [50, 50], [150, 150]);
  const ellipse = (await layers(page)).at(-1)!;
  // Select › Load Selection from Path: the ellipse's bounds.
  await menu(page, 'Select', 'Load Selection from Path');
  const selection = await page.evaluate(() => {
    const s = (window as any).__editorForTests.session.document.selection;
    const mask = s.mask.toPixels();
    return { x: s.x, y: s.y, width: s.mask.width, height: s.mask.height, center: mask[50 * s.mask.width + 50], corner: mask[0] };
  });
  expect(selection).toEqual({ x: 50, y: 50, width: 100, height: 100, center: 255, corner: 0 });
  await page.getByTestId('compositor-editor').press(`${mod}+d`);

  // Hide the ellipse, choose the image layer and add the vector mask from the current path.
  await page.locator(`[data-eye="${ellipse.id}"]`).click();
  await page.getByTestId('layer-row').nth(1).click();
  await menu(page, 'Layer', 'Vector Mask', 'Current Path');
  await expect(page.getByTestId('vector-mask-thumb')).toHaveCount(1);
  const image = (await layers(page)).find((layer) => layer.kind === 'pixel' && layer.name !== 'Layer 1')!;
  expect(image.vectorMask.paths).toHaveLength(1);
  expect(await pixel(page, 100, 100)).toEqual([255, 0, 0, 255]);
  expect((await pixel(page, 55, 55))[3]).toBe(0);
  expect((await pixel(page, 5, 100))[3]).toBe(0);
  // Shift-click on the thumbnail disables it: all pixels show again.
  await page.getByTestId('vector-mask-thumb').click({ modifiers: ['Shift'] });
  expect((await pixel(page, 55, 55))[3]).toBe(255);
  await page.getByTestId('vector-mask-thumb').click({ modifiers: ['Shift'] });
  // Hide All then draw into the targeted mask: only the new rectangle shows.
  await menu(page, 'Layer', 'Vector Mask', 'Delete Vector Mask');
  await expect(page.getByTestId('vector-mask-thumb')).toHaveCount(0);
  await menu(page, 'Layer', 'Vector Mask', 'Hide All');
  expect((await pixel(page, 100, 100))[3]).toBe(0);
  await page.getByTestId('vector-kind-Rectangle').click();
  await drag(page, [10, 10], [60, 60]);
  expect(await pixel(page, 30, 30)).toEqual([255, 0, 0, 255]);
  expect((await pixel(page, 100, 100))[3]).toBe(0);
  expect((await layers(page)).filter((layer) => layer.kind === 'vector')).toHaveLength(1);
  // Reveal All shows everything; the export agrees.
  await menu(page, 'Layer', 'Vector Mask', 'Delete Vector Mask');
  await menu(page, 'Layer', 'Vector Mask', 'Reveal All');
  const exported = await exportedPixels(page);
  expect(exported.data.slice((100 * 200 + 100) * 4, (100 * 200 + 100) * 4 + 4)).toEqual([255, 0, 0, 255]);
});

test('a line with an arrowhead ends in a filled triangle', async ({ page }) => {
  test.setTimeout(180_000);
  await mountForTest(page);
  await newCanvas(page, 200, 200);
  await page.getByTestId('tool-shape').click();
  await page.getByTestId('vector-kind-Line').click();
  await page.getByTestId('vector-stroke-width').fill('4');
  await page.getByTestId('vector-stroke-width').press('Enter');
  await page.getByTestId('vector-endMarker').selectOption('arrow');
  await drag(page, [20, 100], [180, 100]);
  const line = (await layers(page)).at(-1)!;
  expect(line.style.stroke).toMatchObject({ width: 4, endMarker: 'arrow', startMarker: 'none', markerSize: 3 });
  // The line sits on whole or half pixels; rows 2.5–4 px off its axis lie outside the 4 px stroke but inside the arrow.
  const start = line.points[0]![0].anchor, finish = line.points[0]![1].anchor;
  const y = finish.y + line.transform.origin.y, tip = finish.x + line.transform.origin.x;
  expect(start.y).toBe(finish.y);
  // Pointer positions snap to half pixels, so the tip lands within half a pixel of the release point.
  expect(Math.abs(tip - 180)).toBeLessThanOrEqual(0.5);
  const above = Math.ceil(y - 4), below = Math.floor(y + 3), axis = Math.floor(y), end = Math.floor(tip);
  // The arrow is 12 px long (3 × the width) and 10.8 px wide at its base: filled well past the stroke near its base.
  expect((await pixel(page, end - 4, axis))[3]).toBe(255);
  expect((await pixel(page, end - 11, above))[3]).toBeGreaterThan(200);
  expect((await pixel(page, end - 11, below))[3]).toBeGreaterThan(200);
  // Along the shaft only the stroke is drawn.
  expect((await pixel(page, 120, axis))[3]).toBe(255);
  expect((await pixel(page, 120, above))[3]).toBe(0);
  expect((await pixel(page, 120, below))[3]).toBe(0);
  // The start has no marker, and nothing lies beyond the tip.
  expect((await pixel(page, 24, above))[3]).toBe(0);
  expect((await pixel(page, end + 4, axis))[3]).toBe(0);
});

test('German labels for the vector tools', async ({ page }) => {
  test.setTimeout(120_000);
  await mountForTest(page, { locale: 'de' });
  await newCanvas(page, 200, 200);
  await expect(page.getByTestId('tool-pen')).toHaveAttribute('title', 'Zeichenstift-Werkzeug (P)');
  await expect(page.getByTestId('tool-directSelect')).toHaveAttribute('title', 'Direktauswahl-Werkzeug (A) · Umschalt-A wechselt zur Pfadauswahl');
  await page.getByTestId('compositor-editor').press('u');
  const bar = page.getByTestId('context-bar');
  await expect(bar.getByText('Form', { exact: true })).toBeVisible();
  await expect(bar.getByText('Fläche:', { exact: true })).toBeVisible();
  await expect(bar.getByText('Kontur:', { exact: true })).toBeVisible();
  await expect(bar.getByRole('textbox', { name: 'Konturstärke' })).toBeVisible();
  for (const [kind, name] of [['Rectangle', 'Rechteck'], ['Ellipse', 'Ellipse'], ['Polygon', 'Polygon'], ['Star', 'Stern'], ['Line', 'Linie']]) {
    await expect(page.getByTestId(`vector-kind-${kind}`)).toHaveAttribute('aria-label', name!);
  }
  await expect(bar.getByTestId('vector-operation').locator('option')).toHaveText(['Neue Ebene', 'Formen kombinieren', 'Vordere Form subtrahieren',
    'Schnittmenge von Formbereichen', 'Überlappende Formbereiche ausschließen']);
  await expect(bar.getByRole('combobox', { name: 'Pfadvorgänge' })).toBeVisible();
  await page.getByTestId('vector-stroke-options').click();
  const options = page.getByTestId('vector-stroke-popover');
  for (const text of ['Konturoptionen', 'Ausrichtung', 'Innen', 'Mitte', 'Außen', 'Enden', 'Ecken', 'Strichlinie', 'Gehrung', 'Gestrichelt']) {
    await expect(options.getByText(text, { exact: true })).toBeVisible();
  }
  await page.keyboard.press('Escape');
  await page.getByTestId('vector-kind-Polygon').click();
  await expect(bar.getByText('Seiten', { exact: true })).toBeVisible();
  await expect(bar.getByText('Eckenradius', { exact: true })).toBeVisible();
  await page.getByTestId('vector-kind-Star').click();
  await expect(bar.getByText('Zacken', { exact: true })).toBeVisible();
  await expect(bar.getByText('Sternverhältnis', { exact: true })).toBeVisible();
  await page.getByTestId('vector-kind-Line').click();
  await expect(bar.getByText('Pfeilspitzen', { exact: true })).toBeVisible();
  await expect(bar.getByTestId('vector-endMarker').locator('option')).toHaveText(['Ohne', 'Pfeil', 'Offener Pfeil', 'Kreis', 'Quadrat']);
  await page.getByTestId('compositor-editor').press('p');
  await expect(bar.getByText('Zeichenstift', { exact: true })).toBeVisible();
  await page.getByTestId('compositor-editor').press('a');
  await expect(bar.getByText('Direktauswahl', { exact: true })).toBeVisible();
  await page.getByTestId('compositor-editor').press('Shift+A');
  await expect(bar.getByText('Pfadauswahl', { exact: true })).toBeVisible();
  await page.getByTestId('menu-Ebene').click();
  await item(page, 'Vektormaske').hover();
  for (const label of ['Alles einblenden', 'Alles ausblenden', 'Aktueller Pfad', 'Vektormaske löschen']) {
    await expect(item(page, label)).toBeVisible();
  }
  await item(page, 'Formen kombinieren').hover();
  for (const label of ['Formen vereinigen', 'Vordere Form subtrahieren', 'Schnittmenge von Formbereichen', 'Überlappende Formbereiche ausschließen', 'Formen zusammenführen']) {
    await expect(item(page, label)).toBeVisible();
  }
  await page.keyboard.press('Escape');
  await page.getByTestId('menu-Auswahl').click();
  await expect(page.getByRole('menuitem', { name: 'Auswahl aus Pfad laden', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByTestId('menu-Bearbeiten').click();
  await expect(page.getByRole('menuitem', { name: 'Pfadfläche füllen', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Pfadkontur füllen', exact: true })).toBeVisible();
});
