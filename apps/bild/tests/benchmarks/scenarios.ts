import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import { writePsdUint8Array, type Psd } from 'ag-psd';
import { unzipSync } from 'fflate';
import { decodePng, encodePng } from '../../src/io/png';
import {
  PLAN,
  applyGaussianBlur,
  clearFlatBackground,
  clickView,
  decodeImage,
  dragView,
  exportAs,
  fileNamed,
  menuPath,
  openLayerStyle,
  type Pixels,
  renderedRegion,
  styleField,
  viewPoint,
  createCanvas,
  dragInDocument,
  exportedPixels,
  importFile,
  importPng,
  manifest,
  missing,
  mountForTest,
  patternedPng,
  rgbaAt,
  solidPng,
} from './benchmark-helpers';

const task = (number: number): string => `${PLAN}, task ${number}`;
const productCutout = () => patternedPng(100, 100, (x, y) =>
  x >= 30 && x < 70 && y >= 20 && y < 80 ? [220, 55, 35, 255] : [245, 245, 245, 255]);

async function cutOutFlatProduct(page: Page, name = 'product.png'): Promise<void> {
  await createCanvas(page);
  await importPng(page, name, productCutout());
  await clearFlatBackground(page);
  const pixels = await exportedPixels(page);
  expect(rgbaAt(pixels, 5, 5)[3]).toBe(0);
  expect(rgbaAt(pixels, 50, 50)).toEqual([220, 55, 35, 255]);
}

export async function benchmark01(page: Page): Promise<void> {
  test.setTimeout(300_000);
  await cutOutFlatProduct(page);
  // Phase 2: an editable drop shadow through Layer › Layer Style (light from 120°: the shadow falls right and down).
  await page.getByTestId('compositor-editor').press(`${mod}+d`);
  await openLayerStyle(page, 'Drop Shadow…');
  await styleField(page, 'style-distance', '8');
  await styleField(page, 'style-size', '3');
  await page.getByTestId('style-ok').click();
  await expect(page.getByTestId('layer-style-dialog')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__editorForTests.session.document.layers.find((l: any) => l.name === 'product').effects
    .map((e: any) => [e.kind, e.enabled, e.distance]))).toEqual([['dropShadow', true, 8]]);
  const shadowed = await exportedPixels(page);
  expect(rgbaAt(shadowed, 50, 50)).toEqual([220, 55, 35, 255]);
  expect(rgbaAt(shadowed, 72, 84)[3]).toBeGreaterThan(60);
  expect(rgbaAt(shadowed, 72, 84)[0]).toBeLessThan(80);
  expect(rgbaAt(shadowed, 25, 15)[3]).toBe(0);

  // Three social formats as artboards from the presets: the first holds the layout, the others are duplicates resized
  // through the preset list (Photoshop: resizing an artboard keeps its content in place).
  await page.getByTestId('tool-artboard').click();
  await page.getByTestId('artboard-preset').selectOption('instagram-post');
  await renameSelectedArtboard(page, 'Post');
  await duplicateArtboardFromPanel(page, 'Post');
  await page.getByTestId('artboard-preset').selectOption('instagram-story');
  await renameSelectedArtboard(page, 'Story');
  await duplicateArtboardFromPanel(page, 'Post');
  await page.getByTestId('artboard-preset').selectOption('facebook-cover');
  await renameSelectedArtboard(page, 'Cover');
  const boards = await artboardRects(page);
  expect(boards.map((b) => [b.name, b.width, b.height])).toEqual([['Post', 1080, 1080], ['Story', 1080, 1920], ['Cover', 851, 315]]);

  // File › Export As…: the artboards are the default targets; one PNG each, saved as one ZIP.
  const files = await exportAs(page, async () => {
    await expect(page.getByTestId('export-target-artboard')).toHaveCount(3);
    await expect(page.getByTestId('export-file')).toHaveText([/^Post\.png/, /^Story\.png/, /^Cover\.png/]);
  });
  expect(files.map((f) => f.name).sort()).toEqual(['Cover.png', 'Post.png', 'Story.png']);
  for (const board of boards) {
    const pixels = await decodeImage(page, fileNamed(files, `${board.name}.png`));
    expect([pixels.width, pixels.height]).toEqual([board.width, board.height]);
    // Product, its shadow and the artboard's white background, at the same place on every format.
    expect(rgbaAt(pixels, 50, 50)).toEqual([220, 55, 35, 255]);
    const shadow = rgbaAt(pixels, 72, 84);
    expect(shadow[3]).toBe(255);
    expect(shadow[0]).toBeLessThan(200);
    expect(rgbaAt(pixels, 25, 15)).toEqual([255, 255, 255, 255]);
    expect(rgbaAt(pixels, board.width - 5, board.height - 5)).toEqual([255, 255, 255, 255]);
  }
}

export async function benchmark02(page: Page): Promise<void> {
  test.setTimeout(300_000);
  await createCanvas(page, 160, 90);
  await importPng(page, 'color-field.png', solidPng(160, 90, [25, 45, 90, 255]));
  await importPng(page, 'campaign-photo.png', solidPng(60, 60, [230, 145, 45, 255]));
  const state = await manifest(page);
  expect(state.layers.map((layer) => layer.name)).toEqual(['Layer 1', 'color-field', 'campaign-photo']);
  const field = [25, 45, 90, 255], photo = [230, 145, 45, 255], green = [16, 192, 64, 255];

  // Phase 2: the headline as a real text layer (Type tool, 24 pt, click to place, type, Escape commits).
  await chooseTextTool(page);
  await page.getByTestId('font-size').fill('24');
  await page.getByTestId('font-size').press('Enter');
  await clickView(page, 8, 30);
  await page.keyboard.type('SALE');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('text-commit')).toHaveCount(0);
  const headline = await page.evaluate(() => (window as any).__editorForTests.session.document.layers
    .filter((l: any) => l.kind === 'text').map((l: any) => ({ text: l.text, size: l.runs[0].style.fontSize })));
  expect(headline).toEqual([{ text: 'SALE', size: 24 }]);
  expect(inkCount(await renderedRegion(page, 8, 8, 40, 26), field)).toBeGreaterThan(60);

  // The logo as SVG through File › Place Embedded…, moved to the corner with the Move tool's X/Y fields.
  const chooser = page.waitForEvent('filechooser');
  await menuPath(page, 'File', 'Place Embedded…');
  await (await chooser).setFiles({ name: 'logo.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><circle cx="10" cy="10" r="9" fill="#10c040"/></svg>') });
  await expect.poll(async () => (await manifest(page)).layers.at(-1)?.name).toBe('logo.svg');
  expect(await page.evaluate(() => (window as any).__editorForTests.session.activeLayer.content.mediaType)).toBe('svg');
  await page.getByTestId('tool-move').click();
  await moveActiveLayerTo(page, 132, 62);
  expect(rgbaAt(await renderedRegion(page, 142, 72, 1, 1), 0, 0)).toEqual(green);

  // Four artboards: one drawn around the layout with the Artboard tool, three duplicates with their content.
  await page.getByTestId('tool-artboard').click();
  await dragView(page, [0, 0], [160, 90]);
  expect((await artboardRects(page)).map((b) => [b.x, b.y, b.width, b.height])).toEqual([[0, 0, 160, 90]]);
  const first = (await artboardRects(page))[0]!.name;
  for (let i = 0; i < 3; i++) await duplicateArtboardFromPanel(page, first);
  const boards = await artboardRects(page);
  expect(boards).toHaveLength(4);

  // Export As WebP, then PNG: four files each, every one with the whole key visual.
  for (const format of ['webp', 'png'] as const) {
    const files = await exportAs(page, async () => {
      await page.getByTestId(`export-format-${format}`).click();
      await expect(page.getByTestId('export-file')).toHaveCount(4);
    });
    expect(files.map((f) => f.name).sort()).toEqual(boards.map((b) => `${b.name}.${format}`).sort());
    const tolerance = format === 'png' ? 0 : 12;
    for (const board of boards) {
      const pixels = await decodeImage(page, fileNamed(files, `${board.name}.${format}`));
      expect([pixels.width, pixels.height]).toEqual([160, 90]);
      for (const [x, y, expected] of [[95, 60, photo], [150, 5, field], [142, 72, green]] as const) {
        rgbaAt(pixels, x, y).forEach((value, c) => expect(Math.abs(value - expected[c]!), `${board.name}.${format} (${x}, ${y})`).toBeLessThanOrEqual(tolerance));
      }
      expect(inkCount(pixels, field, 8, 8, 40, 26)).toBeGreaterThan(60);
    }
  }
}

export async function benchmark03(page: Page): Promise<void> {
  test.setTimeout(300_000);
  await cutOutFlatProduct(page, 'person.png');
  await page.getByTestId('compositor-editor').press(`${mod}+d`);
  const red = [220, 55, 35, 255];

  // Phase 2: a background gradient on the bottom layer (Gradient tool, foreground blue to transparent, top to bottom).
  await page.getByTestId('layer-row').filter({ hasText: 'Layer 1' }).click();
  await setForegroundHex(page, '2050C0');
  await page.getByTestId('tool-gradient').click();
  await dragView(page, [50, 0], [50, 100]);
  await page.getByTestId('compositor-editor').press('Enter');
  let pixels = await exportedPixels(page);
  expect(rgbaAt(pixels, 5, 2)[3]).toBeGreaterThan(230);
  expect(rgbaAt(pixels, 5, 2)[2]).toBeGreaterThan(170);
  expect(rgbaAt(pixels, 5, 97)[3]).toBeLessThan(40);
  expect(rgbaAt(pixels, 50, 50)).toEqual(red);
  const beforeEffects = pixels;

  // Stroke and outer glow on the extracted person through the Layer Style dialog.
  await page.getByTestId('layer-row').filter({ hasText: 'person' }).click();
  await openLayerStyle(page, 'Stroke…');
  await styleField(page, 'style-width', '3');
  await page.getByTestId('style-enable-outerGlow').check();
  await page.getByTestId('style-effect-outerGlow').click();
  await expect(page.getByTestId('style-body')).toHaveAttribute('data-kind', 'outerGlow');
  await styleField(page, 'style-opacity', '100');
  await styleField(page, 'style-size', '8');
  await page.getByTestId('style-ok').click();
  await expect(page.getByTestId('layer-style-dialog')).toHaveCount(0);
  expect((await layerEffects(page, 'person')).sort()).toEqual(['outerGlow', 'stroke']);
  pixels = await exportedPixels(page);
  expect(rgbaAt(pixels, 50, 50)).toEqual(red);
  // Black stroke just outside the left edge (x = 30); the glow brightens the gradient further out.
  expect(rgbaAt(pixels, 28, 50).slice(0, 3).every((v) => v < 30)).toBe(true);
  expect(rgbaAt(pixels, 28, 50)[3]).toBe(255);
  const glow = rgbaAt(pixels, 24, 30), plain = rgbaAt(beforeEffects, 24, 30);
  expect(glow[0]! + glow[1]!).toBeGreaterThan(plain[0]! + plain[1]! + 60);
  // Far from the person the gradient is unchanged (within 2 levels: adding a style re-rounds semi-transparent pixels).
  rgbaAt(pixels, 5, 50).forEach((value, c) => expect(Math.abs(value - rgbaAt(beforeEffects, 5, 50)[c]!)).toBeLessThanOrEqual(2));

  // Big bold text in magenta with its own black stroke.
  await setForegroundHex(page, 'FF00FF');
  await chooseTextTool(page);
  await page.getByTestId('font-style').selectOption('700|normal');
  await page.getByTestId('font-size').fill('24');
  await page.getByTestId('font-size').press('Enter');
  await clickView(page, 4, 97);
  await page.keyboard.type('WOW');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('text-commit')).toHaveCount(0);
  await page.getByTestId('tool-move').click();
  const textFill = await exportedPixels(page);
  await openLayerStyle(page, 'Stroke…');
  await styleField(page, 'style-width', '2');
  await page.getByTestId('style-ok').click();
  expect(await layerEffects(page, 'WOW')).toEqual(['stroke']);
  const stroked = await exportedPixels(page);
  const count = (pixels: Pixels, match: (rgba: number[]) => boolean) => {
    let n = 0;
    for (let y = 78; y < 100; y++) for (let x = 0; x < 70; x++) if (match(rgbaAt(pixels, x, y))) n++;
    return n;
  };
  const magenta = ([r, g, b, a]: number[]) => r! > 230 && g! < 40 && b! > 230 && a === 255;
  const black = ([r, g, b, a]: number[]) => r! < 40 && g! < 40 && b! < 40 && a === 255;
  expect(count(textFill, magenta)).toBeGreaterThan(40);
  expect(count(stroked, magenta)).toBeGreaterThan(40);
  // A 2 px outside stroke around bold 24 pt glyphs covers well over 100 pixels. (Product bug: on text layers the stroke
  // width is applied in the 4× oversampled text raster, so it comes out ~0.5 px wide and grey — see artifacts/benchmarks.md.)
  expect(count(stroked, black) - count(textFill, black), 'new solid black pixels from a 2 px stroke around the text').toBeGreaterThan(100);

  // The thumbnail as JPEG through Export As.
  const [jpeg] = await exportAs(page, async () => { await page.getByTestId('export-format-jpeg').click(); });
  expect(jpeg!.name).toMatch(/\.jpg$/);
  const decoded = await decodeImage(page, jpeg!);
  expect([decoded.width, decoded.height]).toEqual([100, 100]);
  rgbaAt(decoded, 50, 50).slice(0, 3).forEach((value, c) => expect(Math.abs(value - red[c]!)).toBeLessThanOrEqual(12));
}

/** File › Open Project… with a PSD made in Node (ag-psd writer, no product code). */
async function openPsd(page: Page, name: string, bytes: Uint8Array): Promise<void> {
  await mountForTest(page);
  await page.getByTestId('menu-File').click();
  await expect(page.getByRole('menuitem', { name: 'Open Project…' })).toBeEnabled();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: 'Open Project…' }).click();
  await (await chooser).setFiles({ name, mimeType: 'image/vnd.adobe.photoshop', buffer: Buffer.from(bytes) });
  await expect.poll(() => page.evaluate(() => (window as any).__editorForTests.session.projectName), { timeout: 60_000 })
    .toBe(name.replace(/\.psd$/, ''));
}

const mockupBackground = [200, 200, 205, 255] as const, mockupScreen = [30, 60, 200, 255] as const;
/** A 120 × 90 device mockup: a grey background and a Smart Object "Screen" placed in perspective. */
function mockupPsd(): Uint8Array {
  const width = 120, height = 90;
  const background = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) background.set(mockupBackground, i * 4);
  const screenPng = Buffer.from(encodePng(Uint8Array.from(Array.from({ length: 64 * 48 }, () => [...mockupScreen]).flat()), 64, 48, 4));
  const preview = new Uint8ClampedArray(60 * 50 * 4);
  for (let i = 0; i < 60 * 50; i++) preview.set(mockupScreen, i * 4);
  const composite = background.slice();
  for (let y = 20; y < 70; y++) for (let x = 30; x < 90; x++) composite.set(mockupScreen, (y * width + x) * 4);
  const id = '20953ddb-9391-11ec-b4f1-c15674f50bc4';
  const psd: Psd = {
    width, height, imageData: { width, height, data: composite },
    children: [
      { name: 'Background', left: 0, top: 0, right: width, bottom: height, imageData: { width, height, data: background } },
      { name: 'Screen', left: 30, top: 20, right: 90, bottom: 70, imageData: { width: 60, height: 50, data: preview },
        placedLayer: { id, placed: 'b1e2d3c4-0000-11ec-0000-000000000001', type: 'raster', width: 64, height: 48,
          // A slight perspective: the right edge is shorter than the left one.
          transform: [30, 20, 90, 24, 90, 66, 30, 70] } },
    ],
    linkedFiles: [{ id, name: 'screen.png', data: new Uint8Array(screenPng) }],
  };
  return writePsdUint8Array(psd, { generateThumbnail: false });
}

export async function benchmark04(page: Page): Promise<void> {
  test.setTimeout(180_000);
  // Phase 2: PSD read (A7) through File › Open Project…; the Smart Object arrives as an embedded layer.
  await openPsd(page, 'mockup.psd', mockupPsd());
  const layers = await page.evaluate(() => (window as any).__editorForTests.session.document.layers
    .map((l: any) => ({ name: l.name, kind: l.kind, source: l.content?.sourceName ?? null, warp: !!l.warp })));
  expect(layers).toEqual([{ name: 'Background', kind: 'pixel', source: null, warp: false },
    { name: 'Screen', kind: 'embedded', source: 'screen.png', warp: true }]);
  let pixels = await exportedPixels(page);
  expect([pixels.width, pixels.height]).toEqual([120, 90]);
  expect(rgbaAt(pixels, 60, 45)).toEqual([...mockupScreen]);
  expect(rgbaAt(pixels, 10, 45)).toEqual([...mockupBackground]);
  const before = await page.evaluate(() => {
    const layer = (window as any).__editorForTests.session.document.layers.find((l: any) => l.name === 'Screen');
    return { transform: layer.transform, warp: layer.warp };
  });

  // Layer › Replace Contents… with the client's artwork: same placement and perspective, new pixels.
  await page.getByTestId('layer-row').filter({ hasText: 'Screen' }).click();
  const artwork = patternedPng(64, 48, (x) => x < 32 ? [240, 150, 30, 255] : [250, 230, 60, 255]);
  const chooser = page.waitForEvent('filechooser');
  await menuPath(page, 'Layer', 'Replace Contents…');
  await (await chooser).setFiles({ name: 'client-artwork.png', mimeType: 'image/png', buffer: artwork });
  await expect.poll(() => page.evaluate(() => (window as any).__editorForTests.session.activeLayer.content.sourceName)).toBe('client-artwork.png');
  expect(await page.evaluate(() => {
    const layer = (window as any).__editorForTests.session.activeLayer;
    return { transform: layer.transform, warp: layer.warp };
  })).toEqual(before);

  // Export As PNG: the artwork sits in the screen, left half orange, right half yellow; the background is untouched.
  const [png] = await exportAs(page);
  pixels = await decodeImage(page, png!);
  expect([pixels.width, pixels.height]).toEqual([120, 90]);
  expect(rgbaAt(pixels, 45, 45)).toEqual([240, 150, 30, 255]);
  expect(rgbaAt(pixels, 75, 45)).toEqual([250, 230, 60, 255]);
  expect(rgbaAt(pixels, 10, 45)).toEqual([...mockupBackground]);
  // The perspective of the placement (corners 30,20 · 90,24 · 90,66 · 30,70): the right edge is shorter, so near it the
  // screen starts lower and ends higher. (Product bug: the imported warp quad is stored but never rendered; the layer is
  // drawn as a rotated rectangle around the corners' centre — see artifacts/benchmarks.md.)
  expect(rgbaAt(pixels, 32, 22)).toEqual([240, 150, 30, 255]);
  expect(rgbaAt(pixels, 32, 67)).toEqual([240, 150, 30, 255]);
  expect(rgbaAt(pixels, 88, 22), 'above the perspective top edge at x = 88').toEqual([...mockupBackground]);
  expect(rgbaAt(pixels, 88, 67), 'below the perspective bottom edge at x = 88').toEqual([...mockupBackground]);
}

export async function benchmark05(page: Page): Promise<void> {
  test.setTimeout(180_000);
  // Phase 2: the client PSD opens with its headline as an editable text layer.
  await openPsd(page, 'client.psd', clientPsd());
  const text = () => page.evaluate(() => (window as any).__editorForTests.session.document.layers
    .filter((l: any) => l.kind === 'text').map((l: any) => ({ name: l.name, text: l.text })));
  expect(await text()).toEqual([{ name: 'Headline', text: 'Summer Sale' }]);
  expect(await page.evaluate(() => (window as any).__editorForTests.session.document.layers.map((l: any) => l.name))).toEqual(['Background', 'Headline']);

  // Change the text: double-click the T thumbnail (all text selected), type the new headline, Escape commits.
  await page.getByTestId('text-thumb').dblclick();
  await expect(page.locator('[data-testid="text-bar"][data-engine="ready"]')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId('text-commit')).toBeVisible();
  await page.keyboard.type('Winter Sale');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('text-commit')).toHaveCount(0);
  expect((await text())[0]!.text).toBe('Winter Sale');
  const field = [240, 240, 235, 255];
  expect(inkCount(await renderedRegion(page, 10, 10, 180, 50), field)).toBeGreaterThan(80);

  // Hand it back as PSD: the one export path offers no PSD format, and Save writes the editor's own .fwimg.
  await page.getByTestId('menu-File').click();
  await page.getByTestId('menu-export').click();
  await expect(page.getByTestId('export-dialog')).toBeVisible();
  await expect(page.getByTestId('export-format-png')).toBeVisible();
  const formats = await page.locator('[data-testid^="export-format-"]').evaluateAll((elements) => elements.map((e) => e.getAttribute('data-testid')));
  expect(formats).not.toContain('export-format-psd');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('export-dialog')).toHaveCount(0);
  // Photoshop stores the PostScript name (here NotoSans-Regular); the bundled Noto Sans Regular is that font, so a client
  // file set in it must not be reported as using a missing font. (Product bug: the name is matched only as a family.)
  await expect(page.getByTestId('missing-fonts'), 'no missing-font notice for the bundled Noto Sans Regular').toHaveCount(0);
  missing('PSD write (save the edited client file back as a layered, editable PSD)', task(5));
}

/** A 200 × 70 client file: a light background and an editable text layer "Summer Sale". */
function clientPsd(): Uint8Array {
  const width = 200, height = 70;
  const background = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) background.set([240, 240, 235, 255], i * 4);
  const psd: Psd = {
    width, height, imageData: { width, height, data: background.slice() },
    children: [
      { name: 'Background', left: 0, top: 0, right: width, bottom: height, imageData: { width, height, data: background } },
      { name: 'Headline', left: 10, top: 10, right: 190, bottom: 60,
        imageData: { width: 180, height: 50, data: new Uint8ClampedArray(180 * 50 * 4) },
        // Point text: Photoshop stores the baseline origin in the transform and the text bounds relative to it.
        text: { text: 'Summer Sale', transform: [1, 0, 0, 1, 12, 48], left: 0, top: -34, right: 176, bottom: 9,
          style: { font: { name: 'NotoSans-Regular' }, fontSize: 32, fillColor: { r: 20, g: 30, b: 120 } } } },
    ],
  };
  return writePsdUint8Array(psd, { generateThumbnail: false, invalidateTextLayers: false });
}

export async function benchmark06(page: Page): Promise<void> {
  test.setTimeout(240_000);
  const skin = [190, 125, 105, 255], iris = [95, 70, 60, 255];
  const eye = (x: number, y: number) => Math.hypot(x - 30, y - 30) < 5 || Math.hypot(x - 70, y - 30) < 5;
  const portrait = patternedPng(100, 100, (x, y) =>
    Math.hypot(x - 60, y - 50) < 3 ? [15, 15, 15, 255] : eye(x, y) ? iris as [number, number, number, number] : skin as [number, number, number, number]);
  await createCanvas(page);
  await importPng(page, 'portrait.png', portrait);
  await page.getByTestId('tool-spotHealing').click();
  await dragInDocument(page, [58, 50], [62, 50]);
  await expect.poll(async () => rgbaAt(await exportedPixels(page), 60, 50)[0], { timeout: 30_000 }).toBeGreaterThan(120);

  // Phase 2: Dodge is a Brush mode; painting across both eyes brightens the iris midtones.
  await page.getByTestId('tool-brush').click();
  await page.getByRole('radio', { name: 'Dodge' }).click();
  await expect(page.getByTestId('brush-range')).toHaveValue('midtones');
  await page.getByTestId('brush-exposure').fill('80');
  await page.getByTestId('brush-exposure').press('Enter');
  await dragInDocument(page, [22, 30], [78, 30]);
  await expect.poll(() => page.evaluate(() => (window as any).__editorForTests.session.history.pastNames.at(-1)), { timeout: 30_000 }).toBe('Dodge');
  let pixels = await exportedPixels(page);
  for (const x of [30, 70]) expect(rgbaAt(pixels, x, 30)[0]).toBeGreaterThan(iris[0]! + 15);
  expect(rgbaAt(pixels, 10, 90)).toEqual(skin);
  const dodged = pixels;

  // Basic correction as a Basic adjustment layer (Layer › New Adjustment Layer › Basic…): exposure +0.5.
  await menuPath(page, 'Layer', 'New Adjustment Layer', 'Basic…');
  await expect(page.getByTestId('adjustment-panel')).toBeVisible();
  await page.getByTestId('basic-exposure').fill('0.5');
  await page.getByTestId('basic-exposure').press('Enter');
  await page.getByTestId('adjustment-ok').click();
  await expect(page.getByTestId('adjustment-panel')).toHaveCount(0);
  pixels = await exportedPixels(page);
  expect(rgbaAt(pixels, 10, 90)[1]).toBeGreaterThan(skin[1]! + 10);
  const corrected = rgbaAt(pixels, 10, 90);
  expect(await layerKinds(page)).toEqual([['pixel', null], ['pixel', null], ['adjustment', 'Basic']]);

  // A colour look from a .cube file (Color Lookup adjustment layer): this LUT swaps red and blue.
  await menuPath(page, 'Layer', 'New Adjustment Layer', 'Color Lookup…');
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('lut-load').click();
  await (await chooser).setFiles([{ name: 'swap.cube', mimeType: 'text/plain', buffer: Buffer.from(swapRedBlueCube()) }]);
  await expect(page.getByTestId('lut-name')).toHaveText('Swap');
  await page.getByTestId('adjustment-ok').click();
  await expect(page.getByTestId('adjustment-panel')).toHaveCount(0);
  pixels = await exportedPixels(page);
  const looked = rgbaAt(pixels, 10, 90);
  expect(Math.abs(looked[0]! - corrected[2]!)).toBeLessThanOrEqual(3);
  expect(Math.abs(looked[2]! - corrected[0]!)).toBeLessThanOrEqual(3);
  expect(Math.abs(looked[1]! - corrected[1]!)).toBeLessThanOrEqual(3);
  expect(await layerKinds(page)).toEqual([['pixel', null], ['pixel', null], ['adjustment', 'Basic'], ['adjustment', 'Colour Lookup']]);
  // The retouch itself stays in the pixels underneath: the healed blemish and the dodged eyes.
  expect(rgbaAt(dodged, 60, 50)[0]).toBeGreaterThan(120);
}

/** A 2-point 3D LUT that swaps the red and blue channels. */
function swapRedBlueCube(): string {
  const rows: string[] = ['TITLE "Swap"', 'LUT_3D_SIZE 2'];
  for (let b = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) rows.push([b, g, r].map((v) => v.toFixed(1)).join(' '));
  return `${rows.join('\n')}\n`;
}

async function layerKinds(page: Page): Promise<[string, string | null][]> {
  return page.evaluate(() => (window as any).__editorForTests.session.document.layers
    .map((l: any) => [l.kind, l.adjustment?.kind ?? null]));
}

const SKY_W = 256, SKY_H = 192;
const horizon = (x: number) => 110 + 14 * Math.sin(x / 23) + 6 * Math.sin(x / 7);
const isSky = (x: number, y: number) => y < horizon(x);

/** A generated landscape (no photo): a blue sky over a textured green hill with an irregular horizon. */
function landscapePng(): Buffer {
  let seed = 11;
  const noise = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed % 17) - 8; };
  return patternedPng(SKY_W, SKY_H, (x, y) => {
    const n = noise();
    if (isSky(x + 0.5, y + 0.5)) {
      const t = y / 120;
      return [Math.round(70 + 60 * t + n / 2), Math.round(140 + 40 * t + n / 2), Math.round(220 + 10 * t + n / 2), 255];
    }
    const grass = 8 * Math.sin(x / 3 + y / 5);
    return [Math.round(45 + n + grass), Math.round(105 + n + grass), Math.round(40 + n), 255];
  });
}

/** The pinned SlimSAM files, if they are on this machine (FERNWORK_SLIMSAM_DIR or /tmp/slimsam.*). */
function slimSamDir(): string | null {
  const candidates = [process.env.FERNWORK_SLIMSAM_DIR,
    ...(fs.existsSync('/tmp') ? fs.readdirSync('/tmp').filter((n) => n.startsWith('slimsam.')).map((n) => `/tmp/${n}`) : [])];
  return candidates.find((dir) => !!dir && fs.existsSync(`${dir}/encoder.onnx`) && fs.existsSync(`${dir}/decoder.onnx`)) ?? null;
}

export async function benchmark07(page: Page): Promise<void> {
  test.setTimeout(420_000);
  const modelDir = slimSamDir();
  // The model download goes to huggingface.co; the benchmark serves the pinned local files instead and makes no request.
  if (modelDir) {
    await page.route('https://huggingface.co/**', async (route) => {
      const file = route.request().url().includes('vision_encoder') ? 'encoder.onnx' : 'decoder.onnx';
      const body = fs.readFileSync(`${modelDir}/${file}`);
      await route.fulfill({ status: 200, body, headers: { 'content-type': 'application/octet-stream', 'content-length': String(body.length) } });
    });
  }
  await createCanvas(page, SKY_W, SKY_H);
  await importPng(page, 'landscape.png', landscapePng());
  expect((await manifest(page)).layers.at(-1)?.name).toBe('landscape');

  // Phase 2: Object Selection (Shift-W), model downloaded on the user's click, one click into the sky.
  await page.getByTestId('compositor-editor').press('w');
  await page.getByTestId('compositor-editor').press('Shift+W');
  await expect(page.getByTestId('tool-objectSelect')).toHaveAttribute('aria-pressed', 'true');
  // ENVIRONMENT: without the model files this step cannot run offline; it is reported as skipped, never as passed.
  test.skip(!modelDir, 'ENVIRONMENT-SKIPPED: SlimSAM model files not found (FERNWORK_SLIMSAM_DIR or /tmp/slimsam.*); object selection step not run');
  await page.getByTestId('enable-object-selection').click();
  await expect(page.getByTestId('enable-object-selection')).toHaveCount(0, { timeout: 120_000 });
  await clickView(page, 128, 40);
  await expect(page.getByTestId('object-select-status')).toHaveCount(0, { timeout: 180_000 });
  await expect(page.getByTestId('object-select-error')).toHaveCount(0);
  const sky = await selectionMask(page);
  expect(maskIoU(sky, isSky)).toBeGreaterThanOrEqual(0.9);

  // Refine Edge: a 1.5 px feather softens the horizon; the output stays a selection.
  await page.getByTestId('refine-edge').click();
  await expect(page.getByTestId('refine-edge-ok')).toBeEnabled({ timeout: 60_000 });
  await page.getByTestId('refine-edge-feather').fill('1.5');
  await page.getByTestId('refine-edge-ok').click();
  await expect(page.getByTestId('refine-edge-panel')).toHaveCount(0);
  const refined = await selectionMask(page);
  expect(refined.filter((v) => v > 0 && v < 255).length).toBeGreaterThan(SKY_W);
  expect(maskIoU(refined, isSky)).toBeGreaterThanOrEqual(0.9);
  expect(await page.evaluate(() => (window as any).__editorForTests.session.history.undoName)).toBe('Refine Edge');

  // The new sky goes on top and gets a layer mask from the refined selection.
  const sunset = patternedPng(SKY_W, SKY_H, (_x, y) => [Math.round(250 - y * 0.3), Math.round(150 - y * 0.4), Math.round(90 + y * 0.2), 255]);
  await importPng(page, 'new-sky.png', sunset);
  await expect.poll(() => page.evaluate(() => !!(window as any).__editorForTests.session.selection)).toBe(true);
  await page.getByTestId('addMask').click();
  await expect.poll(() => page.evaluate(() => !!(window as any).__editorForTests.session.activeLayer.mask)).toBe(true);
  let pixels = await exportedPixels(page);
  const newSkyAt = (y: number) => [Math.round(250 - y * 0.3), Math.round(150 - y * 0.4), Math.round(90 + y * 0.2), 255];
  // Photoshop: Add Layer Mask with an active selection reveals the selection. (Product bug: the mask comes out inverted —
  // the new sky is hidden in the sky and shown over the hill; see artifacts/benchmarks.md.)
  expect(rgbaAt(pixels, 128, 30), 'new sky visible where the sky was selected').toEqual(newSkyAt(30));
  const hill = rgbaAt(pixels, 128, 170);
  expect(hill[1]!).toBeGreaterThan(hill[0]! + 30);
  expect(hill[1]!).toBeGreaterThan(hill[2]! + 30);

  // Colour matching with an adjustment layer on the landscape (below the new sky): warm it towards the sunset.
  await page.getByTestId('layer-row').filter({ hasText: 'landscape' }).click();
  await menuPath(page, 'Layer', 'New Adjustment Layer', 'Photo Filter…');
  await page.getByTestId('photo-filter-preset').selectOption('Warming Filter (85)');
  await page.getByTestId('photo-filter-density').fill('60');
  await page.getByTestId('photo-filter-density').press('Enter');
  await page.getByTestId('adjustment-ok').click();
  await expect(page.getByTestId('adjustment-panel')).toHaveCount(0);
  pixels = await exportedPixels(page);
  const warmed = rgbaAt(pixels, 128, 170);
  expect(warmed[0]!).toBeGreaterThan(hill[0]! + 15);
  expect(warmed[2]!).toBeLessThan(hill[2]! + 1);
  expect(rgbaAt(pixels, 128, 30)).toEqual(newSkyAt(30));
  expect(await page.evaluate(() => (window as any).__editorForTests.session.document.layers.map((l: any) => l.name)))
    .toEqual(['Layer 1', 'landscape', 'Photo Filter', 'new-sky']);
}

/** The selection as a document-sized byte mask (0 without a selection). */
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

function maskIoU(mask: number[], truth: (x: number, y: number) => boolean): number {
  let intersection = 0, union = 0;
  for (let y = 0; y < SKY_H; y++) for (let x = 0; x < SKY_W; x++) {
    const a = mask[y * SKY_W + x]! >= 128, b = truth(x + 0.5, y + 0.5);
    if (a && b) intersection++;
    if (a || b) union++;
  }
  return union ? intersection / union : 0;
}

export async function benchmark08(page: Page): Promise<void> {
  const photo = patternedPng(100, 100, (x, y) =>
    Math.hypot(x - 65, y - 50) < 4 ? [0, 0, 0, 255] : [35, 115, 205, 255]);
  await createCanvas(page);
  await importPng(page, 'object-photo.png', photo);
  await page.getByTestId('tool-marquee').click();
  await dragInDocument(page, [59, 44], [72, 57]);
  await page.getByTestId('compositor-editor').press('Shift+Backspace');
  await expect(page.getByTestId('content-fill-apply')).toBeEnabled({ timeout: 30_000 });
  await page.getByTestId('content-fill-apply').click();
  await expect(page.getByTestId('content-fill-panel')).toHaveCount(0);
  const center = rgbaAt(await exportedPixels(page), 65, 50);
  expect(center[2]).toBeGreaterThan(150);
  expect(center[0]).toBeLessThan(90);
  expect((await manifest(page)).layers).toHaveLength(2);
}

export async function benchmark09(page: Page): Promise<void> {
  await createCanvas(page, 160, 90);
  await importPng(page, 'banner-photo.png', solidPng(160, 90, [55, 85, 135, 255]));
  await page.getByTestId('tool-shape').click();
  await dragInDocument(page, [20, 20], [80, 60], 160, 90);
  expect((await manifest(page)).layers.at(-1)?.kind).toBe('shape');
  const placed = await exportedPixels(page);
  const shapeColor = rgbaAt(placed, 30, 40);
  expect(shapeColor).not.toEqual([55, 85, 135, 255]);
  expect(rgbaAt(placed, 100, 40)).toEqual([55, 85, 135, 255]);
  // Phase 1: centre the shape on the layout through Layer › Align (a single layer aligns to the canvas).
  await alignActiveLayer(page, 'Horizontal Centers');
  await alignActiveLayer(page, 'Vertical Centers');
  const centered = (await manifest(page)).layers.at(-1)!;
  expect(centered.kind).toBe('shape');
  const aligned = await exportedPixels(page);
  expect(rgbaAt(aligned, 100, 45)).toEqual(shapeColor);
  expect(rgbaAt(aligned, 30, 45)).toEqual([55, 85, 135, 255]);
  expect(rgbaAt(aligned, 80, 22)).toEqual([55, 85, 135, 255]);

  // Phase 2: five formats as artboards from the presets. The first holds the layout; the others are duplicates resized
  // through the preset list. Each copy is then adapted: the photo fills its artboard, the shape is centred on it.
  test.setTimeout(420_000);
  const formats = [['web-1280', 'Web', 1280, 720], ['instagram-post', 'Post', 1080, 1080], ['instagram-story', 'Story', 1080, 1920],
    ['facebook-cover', 'Cover', 851, 315], ['linkedin-banner', 'LinkedIn', 1584, 396]] as const;
  await page.getByTestId('tool-artboard').click();
  for (const [index, [preset, name]] of formats.entries()) {
    if (index > 0) await duplicateArtboardFromPanel(page, formats[0][1]);
    await page.getByTestId('artboard-preset').selectOption(preset);
    await renameSelectedArtboard(page, name);
  }
  const boards = await artboardRects(page);
  expect(boards.map((b) => [b.name, b.width, b.height])).toEqual(formats.map(([, name, width, height]) => [name, width, height]));
  await page.getByTestId('tool-move').click();
  for (const board of boards) {
    const members = await artboardMembers(page, board.id);
    // The photo: W/H without the aspect lock, X/Y at the artboard's corner, Apply.
    await page.locator(`[data-testid="layer-row"][data-layer-id="${members['banner-photo']}"]`).click();
    if (await page.getByRole('button', { name: 'Lock aspect ratio' }).getAttribute('aria-pressed') === 'true') {
      await page.getByRole('button', { name: 'Lock aspect ratio' }).click();
    }
    for (const [testId, value] of [['transformW', board.width], ['transformH', board.height], ['transformX', board.x], ['transformY', board.y]] as const) {
      await page.getByTestId(testId).fill(String(value));
      await page.getByTestId(testId).press('Enter');
    }
    await page.getByTestId('context-bar').getByRole('button', { name: 'Apply', exact: true }).click();
    await expect.poll(() => page.evaluate((id) => {
      const t = (window as any).__editorForTests.session.document.layers.find((l: any) => l.id === id).transform;
      return [t.origin.x, t.origin.y, t.size.width, t.size.height].map(Math.round);
    }, members['banner-photo'])).toEqual([board.x, board.y, board.width, board.height]);
    // The shape: Layer › Align centres a single layer on its artboard (Photoshop's rule for layers on an artboard).
    await page.locator(`[data-testid="layer-row"][data-layer-id="${members['Rectangle 1']}"]`).click();
    await alignActiveLayer(page, 'Horizontal Centers');
    await alignActiveLayer(page, 'Vertical Centers');
    const centre = await page.evaluate(() => {
      const t = (window as any).__editorForTests.session.activeLayer.transform;
      return { x: t.origin.x + t.size.width / 2, y: t.origin.y + t.size.height / 2 };
    });
    // Product bug: a single layer on an artboard aligns to the whole canvas, not to its artboard (artifacts/benchmarks.md).
    expect(centre, `shape centred on artboard ${board.name}`).toEqual({ x: board.x + board.width / 2, y: board.y + board.height / 2 });
  }

  // Export As: one PNG per artboard at its format's size, photo edge to edge, shape in the middle.
  const files = await exportAs(page, async () => { await expect(page.getByTestId('export-file')).toHaveCount(5); });
  for (const board of boards) {
    const pixels = await decodeImage(page, fileNamed(files, `${board.name}.png`));
    expect([pixels.width, pixels.height]).toEqual([board.width, board.height]);
    expect(rgbaAt(pixels, Math.floor(board.width / 2), Math.floor(board.height / 2))).toEqual(shapeColor);
    for (const [x, y] of [[2, 2], [board.width - 3, board.height - 3]] as const) expect(rgbaAt(pixels, x, y)).toEqual([55, 85, 135, 255]);
  }
}

/** Layer name → id of the layers on one artboard (membership is spatial, as the Layers panel groups them). */
async function artboardMembers(page: Page, artboardId: string): Promise<Record<string, string>> {
  const ids = await page.locator(`[data-testid="artboard-row"][data-artboard-id="${artboardId}"]`).evaluate((row) => {
    const out: string[] = [];
    for (let next = row.nextElementSibling; next && next.getAttribute('data-testid') === 'layer-row'; next = next.nextElementSibling) {
      out.push(next.getAttribute('data-layer-id')!);
    }
    return out;
  });
  return page.evaluate((list) => Object.fromEntries((window as any).__editorForTests.session.document.layers
    .filter((l: any) => list.includes(l.id)).map((l: any) => [l.name, l.id])), ids);
}

export async function benchmark10(page: Page): Promise<void> {
  await createCanvas(page);
  await page.getByTestId('tool-shape').click();
  await dragInDocument(page, [20, 20], [80, 80]);
  const state = await manifest(page);
  expect(state.layers.at(-1)?.kind).toBe('shape');
  expect(rgbaAt(await exportedPixels(page), 50, 50)[3]).toBe(255);

  // Phase 2: an ellipse over the rectangle's lower right, then Layer › Combine Shapes › Subtract Front Shape on both.
  test.setTimeout(240_000);
  await page.getByTestId('vector-kind-Ellipse').click();
  await dragView(page, [50, 50], [90, 90]);
  expect((await manifest(page)).layers).toHaveLength(3);
  await page.getByTestId('layer-row').nth(1).click({ modifiers: [mod] });
  await menuPath(page, 'Layer', 'Combine Shapes', 'Subtract Front Shape');
  await expect.poll(async () => (await manifest(page)).layers.length).toBe(2);
  const icon = await page.evaluate(() => {
    const layer = (window as any).__editorForTests.session.activeLayer;
    return { kind: layer.kind, paths: layer.paths.length, origin: layer.transform.origin, size: layer.transform.size };
  });
  expect(icon.kind).toBe('vector');
  let pixels = await exportedPixels(page);
  expect(rgbaAt(pixels, 30, 30)).toEqual([0, 0, 0, 255]);
  expect(rgbaAt(pixels, 75, 75)[3]).toBe(0);
  expect(rgbaAt(pixels, 78, 25)).toEqual([0, 0, 0, 255]);
  expect(rgbaAt(pixels, 88, 88)[3]).toBe(0);
  // Undo/redo keeps it one editable step.
  await page.getByTestId('compositor-editor').press(`${mod}+z`);
  expect((await manifest(page)).layers).toHaveLength(3);
  await page.getByTestId('compositor-editor').press(`${mod}+Shift+z`);
  expect((await manifest(page)).layers).toHaveLength(2);

  // Export As: only the selected icon layer, at @1x and @2x, as PNG with transparency.
  const files = await exportAs(page, async () => {
    await page.getByTestId('export-target-document').uncheck();
    await page.getByTestId('export-target-layers').check();
    await page.getByTestId('export-add-size').click();
    await expect(page.getByTestId('export-file')).toHaveCount(2);
  });
  expect(files).toHaveLength(2);
  const byScale = files.map((f) => f.name).sort();
  expect(byScale[1]).toMatch(/@2x\.png$/);
  const one = await decodeImage(page, fileNamed(files, byScale[0]!)), two = await decodeImage(page, fileNamed(files, byScale[1]!));
  expect([two.width, two.height]).toEqual([one.width * 2, one.height * 2]);
  expect(one.width).toBeGreaterThanOrEqual(60);
  expect(one.width).toBeLessThanOrEqual(62);
  // In layer coordinates (the rectangle's corner at 0, 0): solid top-left, the subtracted hole at the lower right.
  expect(rgbaAt(one, 10, 10)).toEqual([0, 0, 0, 255]);
  expect(rgbaAt(one, 55, 55)[3]).toBe(0);
  expect(rgbaAt(two, 20, 20)).toEqual([0, 0, 0, 255]);
  expect(rgbaAt(two, 110, 110)[3]).toBe(0);
  expect(rgbaAt(two, 110, 10)).toEqual([0, 0, 0, 255]);
  pixels = await exportedPixels(page);
  expect([pixels.width, pixels.height]).toEqual([100, 100]);
}

export async function benchmark11(page: Page): Promise<void> {
  await createCanvas(page, 80, 60);
  await importFile(page, 'print-photo.tiff', 'image/tiff', await adobeRgbTiff(page, 80, 60));
  expect((await manifest(page)).layers.at(-1)?.name).toBe('print-photo');
  expect((await manifest(page)).assets.at(-1)?.width).toBe(80);
  const converted = rgbaAt(await exportedPixels(page), 40, 30);
  expect(converted[3]).toBe(255);
  expect(converted).not.toEqual([190, 70, 35, 255]);
  missing('CMYK soft-proof controls (before CMYK TIFF export)', task(11));
}

export async function benchmark12(page: Page): Promise<void> {
  await mountForTest(page);
  await page.getByTestId('menu-File').click();
  await expect(page.getByTestId('menu-import')).toBeEnabled();
  missing('RAW/DNG decoding in the Tauri file-import path', task(12));
}

export async function benchmark13(page: Page): Promise<void> {
  test.setTimeout(300_000);
  // A 200 MP poster is a Pro task. Since A4c the browser build's default Lite profile caps documents at 100 MP, so the
  // benchmark mounts the Pro profile (in Phase 0/1 it ran in the then-unlimited default profile).
  await createCanvas(page, 20_000, 10_000, 'pro');
  const state = await manifest(page);
  expect(state.width * state.height).toBe(200_000_000);
  expect(state.layers).toHaveLength(1);
  // Phase 2 (tile swapping): the first full-size layer is filled through Edit › Fill with Foreground Color.
  await menuPath(page, 'Edit', 'Fill with Foreground Color');
  await expect.poll(() => page.evaluate(() => (window as any).__editorForTests.session.history.undoName), { timeout: 120_000 })
    .toMatch(/Fill/);
  for (const [x, y] of [[0, 0], [10_000, 5_000], [19_999, 9_999]] as const) {
    expect(rgbaAt(await renderedRegion(page, x, y, 1, 1), 0, 0), `filled pixel (${x}, ${y})`).toEqual([0, 0, 0, 255]);
  }
  // Not attempted here: the full run needs ~25 GB of scratch plus archive disk, and its Pro target is the Tauri shell.
  missing('a Pro (Tauri) 200-MP path that holds 30 full-size layers through save and reopen (A4c: the packaged Linux Tauri '
    + 'run is killed by WebKitGTK at 16 GB before saving, artifacts/a4-storage.md)', task(13));
}

export async function benchmark14(page: Page): Promise<void> {
  test.setTimeout(300_000);
  await createCanvas(page, 40, 40);
  await importPng(page, 'series-01.png', solidPng(40, 40, [80, 80, 80, 255]));
  await page.getByTestId('compositor-editor').press(process.platform === 'darwin' ? 'Meta+l' : 'Control+l');
  await expect(page.getByTestId('adjustment-panel')).toBeVisible();
  await page.getByTestId('levelsInputwhite').fill('160');
  await page.getByTestId('adjustment-ok').click();
  // Levels now applies asynchronously ("Applying…"); the panel closes when the pixels are committed.
  await expect(page.getByTestId('adjustment-panel')).toHaveCount(0, { timeout: 30_000 });
  expect(rgbaAt(await exportedPixels(page), 20, 20)[0]).toBeGreaterThan(110);

  // Phase 3: the series look as a recipe. A Levels adjustment layer (white point 200) above the photo, saved from it
  // with Layer › Save Recipe… (6.9: recipes hold live steps, not recorded actions).
  await menuPath(page, 'Layer', 'New Adjustment Layer', 'Levels…');
  await expect(page.getByTestId('adjustment-panel')).toBeVisible();
  await page.getByTestId('levelsInputwhite').fill('200');
  await page.getByTestId('levelsInputwhite').press('Enter');
  await page.getByTestId('adjustment-ok').click();
  await expect(page.getByTestId('adjustment-panel')).toHaveCount(0);
  await menuPath(page, 'Layer', 'Save Recipe…');
  await expect(page.getByTestId('recipe-step')).toHaveCount(1);
  await page.getByTestId('recipe-name').fill('Hochzeit');
  await page.getByTestId('recipe-save').click();
  await expect(page.getByTestId('recipe-row').filter({ hasText: 'Hochzeit' })).toBeVisible();

  // File › Batch…: 50 photos of the series (different sizes and tones), the recipe, PNG @1x. This host has no folder
  // picker, so the files arrive as one ZIP (the Firefox/WebKit path); the queue reads them one at a time.
  const series = Array.from({ length: 50 }, (_, i) => ({
    name: `DSC_${String(4001 + i)}.png`, width: 48 + (i % 5) * 8, height: 32 + (i % 3) * 8,
    left: [40 + i * 3, 90, 200 - i * 2] as const, right: [180, 30 + i * 2, 60] as const,
  }));
  await menuPath(page, 'File', 'Batch…');
  await expect(page.getByTestId('batch-dialog')).toBeVisible();
  const files = page.waitForEvent('filechooser');
  await page.getByTestId('batch-add-files').click();
  await (await files).setFiles(series.map((photo) => ({ name: photo.name, mimeType: 'image/png', buffer: patternedPng(photo.width, photo.height,
    (x) => (x < photo.width / 2 ? [...photo.left, 255] : [...photo.right, 255])) })));
  await expect(page.getByTestId('batch-item')).toHaveCount(50);
  await expect(page.getByTestId('batch-recipe').locator('option:checked')).toHaveText('Hochzeit');
  await expect(page.getByTestId('batch-zip-note')).toBeVisible();
  await page.getByTestId('batch-pattern').fill('Hochzeit-{index}');
  await page.getByTestId('batch-run').click();
  await expect(page.getByTestId('batch-summary')).toHaveText('50 exported · 0 failed · 0 waiting', { timeout: 240_000 });
  const zip = await page.evaluate(async () => {
    const saved = (window as unknown as { __saved: { name: string; blob: Blob }[] }).__saved.find((file) => file.name.endsWith('.zip'))!;
    return { name: saved.name, bytes: Array.from(new Uint8Array(await saved.blob.arrayBuffer())) };
  });
  expect(zip.name).toBe('Batch export.zip');
  const entries = unzipSync(Uint8Array.from(zip.bytes));
  expect(Object.keys(entries)).toEqual(series.map((_, i) => `Hochzeit-${String(i + 1).padStart(2, '0')}.png`));
  const levels = (value: number) => Math.min(255, Math.round(value * 255 / 200));
  series.forEach((photo, i) => {
    const png = decodePng(entries[`Hochzeit-${String(i + 1).padStart(2, '0')}.png`]!);
    expect([png.width, png.height], photo.name).toEqual([photo.width, photo.height]);
    const y = Math.floor(photo.height / 2);
    for (const [x, source] of [[4, photo.left], [photo.width - 4, photo.right]] as const) {
      const at = (y * png.width + x) * 4;
      source.forEach((value, channel) => expect(Math.abs(png.data[at + channel]! - levels(value)), `${photo.name} (${x}, ${y}) channel ${channel}`)
        .toBeLessThanOrEqual(1));
    }
  });
}

export async function benchmark15(page: Page): Promise<void> {
  test.setTimeout(240_000);
  await createCanvas(page, 120, 160);
  // Phase 2: the Type tool exists (the Phase 0/1 step asserted its absence). A 90 pt point-text headline “ffi”.
  await chooseTextTool(page);
  await page.getByTestId('font-size').fill('90');
  await page.getByTestId('font-size').press('Enter');
  await clickView(page, 4, 120);
  await page.keyboard.type('ffi');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('text-commit')).toHaveCount(0);
  await expect(page.getByTestId('text-bar')).toHaveAttribute('data-target', 'layer');
  const style = () => page.evaluate(() => {
    const layer = (window as any).__editorForTests.session.document.layers.find((l: any) => l.kind === 'text');
    const run = layer.runs[0].style;
    return { family: run.fontFamily, weight: run.fontWeight, wght: run.axes.wght ?? null, liga: run.features.liga !== false };
  });
  const region = () => renderedRegion(page, 0, 20, 120, 120);
  // Coverage: pixels the text makes more than a quarter opaque on the transparent canvas.
  const ink = async () => (await region()).data.filter((v, i) => i % 4 === 3 && v > 64).length;
  await expect.poll(ink, { timeout: 30_000 }).toBeGreaterThan(300);

  // Variable font: the bundled Noto Sans is variable (wght 100–900); Thin and Black are two instances of one file.
  expect((await style()).family).toBe('Noto Sans');
  await page.getByTestId('font-style').selectOption('100|normal');
  await expect.poll(async () => (await style()).wght).toBe(100);
  await expect.poll(ink, { timeout: 30_000 }).toBeLessThan(2_000);
  const thin = await ink();
  await page.getByTestId('font-style').selectOption('900|normal');
  await expect.poll(async () => (await style()).wght).toBe(900);
  await expect.poll(ink, { timeout: 30_000 }).toBeGreaterThan(thin * 2);
  const ligated = await region();

  // OpenType (Character panel). Ligatures are on by default and can be switched off per run; the switch is stored on
  // the layer. The bundled Noto Sans builds its f_f_i/fi/fl ligatures as composites of the plain glyphs, so with this
  // font the switch cannot change a pixel; that OpenType features reach the shaper is shown with Small Caps instead.
  await page.getByTestId('text-panel-toggle').click();
  await expect(page.getByTestId('text-feature-liga')).toBeChecked();
  expect((await style()).liga).toBe(true);
  await page.getByTestId('text-feature-liga').uncheck();
  await expect.poll(async () => (await style()).liga).toBe(false);
  await page.getByTestId('text-feature-liga').check();
  await expect.poll(async () => (await style()).liga).toBe(true);
  await page.getByTestId('text-feature-smcp').check();
  await expect.poll(async () => {
    const small = await region();
    let changed = 0;
    for (let i = 3; i < small.data.length; i += 4) if (Math.abs(small.data[i]! - ligated.data[i]!) > 64) changed++;
    return changed;
  }, { timeout: 30_000, message: 'Small Caps redraws the lowercase headline' }).toBeGreaterThan(500);
  await page.getByTestId('text-feature-smcp').uncheck();
  await page.keyboard.press('Escape');

  missing('text on a path (type along a curve) for the poster headline', task(15));
}

export async function benchmark16(page: Page): Promise<void> {
  await createCanvas(page);
  await importPng(page, 'package-face.png', solidPng(60, 60, [210, 180, 50, 255]));
  expect((await manifest(page)).layers.at(-1)?.transform).toEqual([1, 0, 0, 1, 20, 20]);
  await page.getByTestId('menu-Edit').click();
  await page.getByRole('menuitem', { name: /^Transform/ }).click();
  await page.getByRole('menuitem', { name: 'Warp', exact: true }).click();
  await page.getByTestId('warp-preset').selectOption('bulge');
  const state = await page.evaluate(() => {
    const layer = (window as any).__editorForTests.session.activeLayer;
    return { kind: layer.warp?.kind, points: layer.warp?.points?.length, undo: (window as any).__editorForTests.session.history.undoName };
  });
  expect(state).toEqual({ kind: 'mesh', points: 16, undo: 'Warp' });
  const pixels = await exportedPixels(page);
  expect(rgbaAt(pixels, 50, 50)).toEqual([210, 180, 50, 255]);
}

export async function benchmark17(page: Page): Promise<void> {
  test.setTimeout(180_000);
  await createCanvas(page, 40, 40);
  // A grainy old photo: a dark and a light half (the structure) under strong deterministic grain.
  let seed = 3;
  const grain = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed % 61) - 30; };
  await importPng(page, 'old-photo.png', patternedPng(40, 40, (x) => {
    const value = Math.max(0, Math.min(255, (x < 20 ? 80 : 170) + grain()));
    return [value, value, value, 255];
  }));
  await page.getByTestId('menu-Image').click();
  await page.getByRole('menuitem', { name: 'Image Size…' }).click();
  await page.getByTestId('imageSizeWidth').fill('80');
  await page.getByTestId('imageSizeWidth').press('Enter');
  await page.getByTestId('imageSizeOK').click();
  await expect.poll(async () => (await manifest(page)).width, { timeout: 30_000 }).toBe(80);
  expect((await manifest(page)).height).toBe(80);

  // Phase 2: Filter › Reduce Noise… (a live smart filter) at full luminance and colour strength.
  const grainy = await exportedPixels(page);
  await page.getByTestId('menu-Filter').click();
  await page.getByRole('menuitem', { name: 'Reduce Noise…', exact: true }).click();
  await expect(page.getByTestId('adjustment-panel')).toContainText('Smart Filter');
  for (const id of ['denoiseLuminance', 'denoiseColour']) {
    await page.getByTestId(id).fill('100');
    await page.getByTestId(id).press('Enter');
  }
  await page.getByTestId('adjustment-ok').click();
  await expect(page.getByTestId('adjustment-panel')).toHaveCount(0, { timeout: 30_000 });
  expect(await page.evaluate(() => (window as any).__editorForTests.session.activeLayer.filters.map((f: any) => f.kind))).toEqual(['denoise']);
  const clean = await exportedPixels(page);
  // Grain: the spread of each flat half, away from the edge and the borders.
  const spread = (pixels: Pixels, x0: number) => {
    const values: number[] = [];
    for (let y = 8; y < 72; y++) for (let x = x0; x < x0 + 24; x++) values.push(rgbaAt(pixels, x, y)[0]!);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    return { mean, deviation: Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length) };
  };
  for (const x0 of [6, 50]) {
    const before = spread(grainy, x0), after = spread(clean, x0);
    expect(after.deviation, `grain in the half at x ${x0}`).toBeLessThan(before.deviation * 0.6);
    expect(Math.abs(after.mean - before.mean)).toBeLessThan(6);
  }
  // The structure stays: the two halves keep their contrast.
  expect(spread(clean, 50).mean - spread(clean, 6).mean).toBeGreaterThan(70);
}

export async function benchmark18(page: Page): Promise<void> {
  const screenshot = patternedPng(100, 100, (x, y) => x < 50 ? [20, 20, 20, 255] : [235, 235, 235, 255]);
  await createCanvas(page);
  await importPng(page, 'screenshot.png', screenshot);
  await applyGaussianBlur(page, '5');
  const pixels = await exportedPixels(page);
  const edge = rgbaAt(pixels, 50, 50)[0]!;
  expect(edge).toBeGreaterThan(35);
  expect(edge).toBeLessThan(220);

  // Phase 2: annotations as vector layers in red. An outline-only frame: a rectangle, then Fill: None and a solid stroke.
  test.setTimeout(240_000);
  const red = [255, 0, 0, 255];
  await setForegroundHex(page, 'FF0000');
  await page.getByTestId('tool-shape').click();
  await page.getByTestId('vector-kind-Rectangle').click();
  await dragView(page, [55, 20], [90, 60]);
  await page.getByTestId('vector-fill').click();
  await page.getByTestId('vector-fill-none').click();
  await page.keyboard.press('Escape');
  await page.getByTestId('vector-stroke').click();
  await page.getByTestId('vector-stroke-solid').click();
  await page.keyboard.press('Escape');
  await page.getByTestId('vector-stroke-width').fill('3');
  await page.getByTestId('vector-stroke-width').press('Enter');
  const frame = await page.evaluate(() => (window as any).__editorForTests.session.activeLayer.style);
  expect({ fill: frame.fill, width: frame.stroke.width, color: frame.stroke.paint?.color ?? frame.stroke.color }).toEqual({ fill: null, width: 3, color: { red: 1, green: 0, blue: 0 } });
  let annotated = await renderedRegion(page, 0, 0, 100, 100);
  // The default Inside stroke lies on x 55–57 and y 20–22. (Product bug: with Fill None an Inside stroke renders
  // nothing; Center and Outside strokes render — see artifacts/benchmarks.md.)
  expect(rgbaAt(annotated, 56, 40), 'frame stroke (Fill None, Inside stroke)').toEqual(red);
  expect(rgbaAt(annotated, 72, 21)).toEqual(red);
  // Inside the frame the blurred screenshot shows through unchanged.
  expect(rgbaAt(annotated, 72, 40)).toEqual(rgbaAt(pixels, 72, 40));

  // An arrow: the Line kind on a new layer with an arrowhead at its end.
  await page.getByTestId('vector-kind-Line').click();
  await page.getByTestId('vector-operation').selectOption('new');
  await dragView(page, [10, 85], [45, 60]);
  await page.getByTestId('vector-endMarker').selectOption('arrow');
  const arrow = await page.evaluate(() => (window as any).__editorForTests.session.activeLayer.style.stroke);
  expect(arrow).toMatchObject({ endMarker: 'arrow', startMarker: 'none' });
  annotated = await renderedRegion(page, 0, 0, 100, 100);
  // The head is wider than the shaft: 8 px back from the tip, 3 px to either side of the line is red; on the shaft it is not.
  const tip = { x: 45, y: 60 }, length = Math.hypot(35, 25), d = { x: 35 / length, y: -25 / length }, n = { x: -d.y, y: d.x };
  const isRed = (x: number, y: number) => { const [r, g] = rgbaAt(annotated, Math.round(x), Math.round(y)); return r! > 150 && g! < 120; };
  const head = { x: tip.x - d.x * 8, y: tip.y - d.y * 8 }, shaft = { x: tip.x - d.x * 25, y: tip.y - d.y * 25 };
  for (const side of [-3, 3]) {
    expect(isRed(head.x + n.x * side, head.y + n.y * side), `arrowhead ${side} px beside the line`).toBe(true);
    expect(isRed(shaft.x + n.x * side, shaft.y + n.y * side), `shaft ${side} px beside the line`).toBe(false);
  }
  expect(isRed(shaft.x, shaft.y)).toBe(true);

  // Export As PNG: blur, frame and arrow in the file.
  const [png] = await exportAs(page);
  const file = await decodeImage(page, png!);
  expect([file.width, file.height]).toEqual([100, 100]);
  for (const [x, y] of [[56, 40], [72, 21], [Math.round(shaft.x), Math.round(shaft.y)]] as const) expect(rgbaAt(file, x, y)[0], `red at (${x}, ${y})`).toBeGreaterThan(200);
  expect(rgbaAt(file, 72, 40)).toEqual(rgbaAt(pixels, 72, 40));
  expect(rgbaAt(file, 50, 50)[0]).toBe(edge);
}

export async function benchmark19(page: Page): Promise<void> {
  test.setTimeout(180_000);
  await cutOutFlatProduct(page, 'raster-logo.png');
  await page.getByTestId('compositor-editor').press(`${mod}+d`);
  // Phase 2: an editable 4 px outside stroke (Layer › Layer Style › Stroke…) in the colour chosen in the dialog's fill.
  await openLayerStyle(page, 'Stroke…');
  await styleField(page, 'style-width', '4');
  await page.getByTestId('style-ok').click();
  await expect(page.getByTestId('layer-style-dialog')).toHaveCount(0);
  expect(await layerEffects(page, 'raster-logo')).toEqual(['stroke']);
  // Exported on transparency as PNG: logo, a 4 px black contour following its edge, transparent beyond.
  const [png] = await exportAs(page);
  expect(png!.name).toMatch(/\.png$/);
  const pixels = await decodeImage(page, png!);
  expect([pixels.width, pixels.height]).toEqual([100, 100]);
  expect(rgbaAt(pixels, 50, 50)).toEqual([220, 55, 35, 255]);
  for (const [x, y] of [[27, 50], [72, 50], [50, 17], [50, 82]] as const) expect(rgbaAt(pixels, x, y), `contour at (${x}, ${y})`).toEqual([0, 0, 0, 255]);
  for (const [x, y] of [[24, 50], [75, 50], [50, 14], [50, 85], [5, 5]] as const) expect(rgbaAt(pixels, x, y)[3], `transparent at (${x}, ${y})`).toBe(0);
  // Still editable: a wider stroke from the fx row re-renders the contour.
  await page.getByTestId('layer-row').filter({ hasText: 'raster-logo' }).getByTestId('fx-badge').click();
  await page.getByTestId('effect-row').first().dblclick();
  await expect(page.getByTestId('style-body')).toHaveAttribute('data-kind', 'stroke');
  await styleField(page, 'style-width', '8');
  await page.getByTestId('style-ok').click();
  expect(rgbaAt(await exportedPixels(page), 24, 50)).toEqual([0, 0, 0, 255]);
}

export async function benchmark20(page: Page): Promise<void> {
  const teal = [0, 140, 125, 255], inverted = [255, 115, 130, 255];
  await createCanvas(page, 64, 48);
  const blank = await manifest(page);
  const blankPixel = rgbaAt(await exportedPixels(page), 32, 24);
  expect(blankPixel).not.toEqual(teal);
  await importPng(page, 'recovery-layer.png', solidPng(12, 10, [0, 140, 125, 255]));
  const imported = await manifest(page);
  expect(rgbaAt(await exportedPixels(page), 32, 24)).toEqual(teal);
  // A second, pixel-changing step: undoing it after recovery needs the layer's earlier pixels from the recovered history.
  await page.getByTestId('menu-Image').click();
  await page.getByRole('menuitem', { name: /^Invert(?! Mask)/ }).click();
  await expect.poll(async () => rgbaAt(await exportedPixels(page), 32, 24)).toEqual(inverted);
  const before = await manifest(page);
  const editedAt = await page.evaluate(() => Date.now());
  await expect.poll(() => recoveryCopiesSavedAfter(page, editedAt), { timeout: 15_000 }).toBe(1);

  await mountForTest(page);
  await expect(page.getByRole('alertdialog')).toContainText('Recover an unsaved project?');
  await page.getByRole('button', { name: 'Recover' }).click();
  await expect(page.getByTestId('layerCount')).toHaveText('2');
  expect((await manifest(page)).layers).toEqual(before.layers);
  expect(rgbaAt(await exportedPixels(page), 32, 24)).toEqual(inverted);

  // Phase 1: the history travels with the recovery copy, so undo continues after the crash.
  await page.getByTestId('tab-history').click();
  const steps = page.getByTestId('history-step');
  const stepCount = await steps.count();
  expect(stepCount).toBeGreaterThanOrEqual(3);
  await expect(steps.nth(stepCount - 1)).toHaveAttribute('aria-current', 'step');
  await page.getByTestId('menu-Edit').click();
  await expect(page.getByTestId('menu-undo')).toBeEnabled();
  await page.getByTestId('menu-undo').click();
  await expect.poll(async () => rgbaAt(await exportedPixels(page), 32, 24)).toEqual(teal);
  expect((await manifest(page)).layers).toEqual(imported.layers);
  await expect(steps.nth(stepCount - 2)).toHaveAttribute('aria-current', 'step');
  // Further back through the History panel to the state before the import.
  await steps.nth(stepCount - 3).click();
  await expect.poll(async () => (await manifest(page)).layers).toEqual(blank.layers);
  expect(rgbaAt(await exportedPixels(page), 32, 24)).toEqual(blankPixel);
  await expect(page.getByTestId('layerCount')).toHaveText('1');
  // And forward again: redo restores both recovered steps with their pixels.
  await steps.nth(stepCount - 1).click();
  await expect.poll(async () => rgbaAt(await exportedPixels(page), 32, 24)).toEqual(inverted);
  expect((await manifest(page)).layers).toEqual(before.layers);
}

async function recoveryCopiesSavedAfter(page: Page, timestamp: number): Promise<number> {
  return page.evaluate(async (after) => {
    const request = indexedDB.open('fernwork-compositor');
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (!database.objectStoreNames.contains('recovery')) { database.close(); return 0; }
    const allRequest = database.transaction('recovery').objectStore('recovery').getAll();
    const records = await new Promise<{ savedAt: number }[]>((resolve, reject) => {
      allRequest.onsuccess = () => resolve(allRequest.result as { savedAt: number }[]);
      allRequest.onerror = () => reject(allRequest.error);
    });
    database.close();
    return records.length === 1 && records[0]!.savedAt > after ? 1 : 0;
  }, timestamp);
}

async function alignActiveLayer(page: Page, edge: string): Promise<void> {
  await page.getByTestId('menu-Layer').click();
  await page.getByRole('menuitem', { name: 'Align' }).hover();
  const item = page.getByRole('menuitem', { name: edge, exact: true });
  // Product bug (Phase 2 regression): Align ignores layers without a raster, so a vector shape cannot be aligned.
  await expect(item, `Layer › Align › ${edge} enabled for the selected layer`).toBeEnabled();
  await item.click();
}

async function adobeRgbTiff(page: Page, width: number, height: number): Promise<Buffer> {
  const profile = Uint8Array.from(await page.evaluate(async () => {
    const load = (path: string): Promise<unknown> => import(/* @vite-ignore */ path);
    const module = await load('/src/wasm/lcms/index.ts') as typeof import('../../src/wasm/lcms');
    const lcms = await module.loadLittleCms();
    return Array.from(lcms.createRgbProfile({
      white: [0.3127, 0.329], red: [0.64, 0.33], green: [0.21, 0.71], blue: [0.15, 0.06],
    }, 2.19921875));
  }));
  const pixels = new Uint8Array(width * height * 3);
  for (let offset = 0; offset < pixels.length; offset += 3) pixels.set([190, 70, 35], offset);
  return Buffer.from(rgbTiffWithIcc(width, height, pixels, profile));
}

function rgbTiffWithIcc(width: number, height: number, pixels: Uint8Array, profile: Uint8Array): Uint8Array {
  const le16 = (value: number) => new Uint8Array([value, value >>> 8]);
  const le32 = (value: number) => new Uint8Array([value, value >>> 8, value >>> 16, value >>> 24]);
  const tags = ([
    [256, 4, 1, le32(width)], [257, 4, 1, le32(height)], [258, 3, 3, new Uint8Array([8, 0, 8, 0, 8, 0])],
    [259, 3, 1, le16(1)], [262, 3, 1, le16(2)], [273, 4, 1, new Uint8Array(4)],
    [277, 3, 1, le16(3)], [278, 4, 1, le32(height)], [279, 4, 1, le32(pixels.length)],
    [284, 3, 1, le16(1)], [34675, 7, profile.length, profile],
  ] satisfies Array<[number, number, number, Uint8Array]>).sort((a, b) => a[0] - b[0]);
  const ifdEnd = 8 + 2 + tags.length * 12 + 4;
  let cursor = ifdEnd;
  const offsets = new Map<number, number>();
  for (const tag of tags) {
    if (tag[3].length > 4) {
      offsets.set(tag[0], cursor);
      cursor += tag[3].length + (tag[3].length & 1);
    }
  }
  const pixelOffset = cursor;
  const output = new Uint8Array(pixelOffset + pixels.length);
  const view = new DataView(output.buffer);
  output.set([0x49, 0x49, 42, 0], 0);
  view.setUint32(4, 8, true);
  view.setUint16(8, tags.length, true);
  for (let index = 0; index < tags.length; index++) {
    const [tag, type, count, original] = tags[index]!;
    const data = tag === 273 ? le32(pixelOffset) : original;
    const at = 10 + index * 12;
    view.setUint16(at, tag, true);
    view.setUint16(at + 2, type, true);
    view.setUint32(at + 4, count, true);
    if (data.length <= 4) output.set(data, at + 8);
    else {
      const offset = offsets.get(tag)!;
      view.setUint32(at + 8, offset, true);
      output.set(data, offset);
    }
  }
  output.set(pixels, pixelOffset);
  return output;
}

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

async function renameSelectedArtboard(page: Page, name: string): Promise<void> {
  await page.getByTestId('artboard-name').fill(name);
  await page.getByTestId('artboard-name').press('Enter');
  await expect(page.getByTestId('artboard-name')).toHaveValue(name);
}

/** The Layers panel's artboard row › Duplicate Artboard (the copy, with its layers, is selected). */
async function duplicateArtboardFromPanel(page: Page, name: string): Promise<void> {
  const count = (await artboardRects(page)).length;
  await page.getByTestId('artboard-row').filter({ hasText: name }).first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Duplicate Artboard' }).click();
  await expect.poll(async () => (await artboardRects(page)).length).toBe(count + 1);
}

async function artboardRects(page: Page): Promise<{ id: string; name: string; x: number; y: number; width: number; height: number }[]> {
  return page.evaluate(() => ((window as any).__editorForTests.session.document.artboards ?? [])
    .map((a: any) => ({ id: a.id, name: a.name, ...a.rect })));
}

async function chooseTextTool(page: Page): Promise<void> {
  await page.getByTestId('tool-text').click();
  await expect(page.locator('[data-testid="text-bar"][data-engine="ready"]')).toBeVisible({ timeout: 90_000 });
}

/** Pixels in a region that clearly differ from a background colour (text ink, strokes, glows). */
function inkCount(pixels: { width: number; data: number[] }, background: readonly number[], x = 0, y = 0,
  width = pixels.width, height = pixels.data.length / 4 / pixels.width): number {
  let count = 0;
  for (let row = y; row < y + height; row++) for (let column = x; column < x + width; column++) {
    const [r, g, b] = rgbaAt(pixels, column, row);
    if (Math.abs(r! - background[0]!) + Math.abs(g! - background[1]!) + Math.abs(b! - background[2]!) > 60) count++;
  }
  return count;
}

/** The Move tool's X and Y fields in the context bar (the layer's top-left corner), then Apply. */
async function moveActiveLayerTo(page: Page, x: number, y: number): Promise<void> {
  for (const [testId, value] of [['transformX', x], ['transformY', y]] as const) {
    await page.getByTestId(testId).fill(String(value));
    await page.getByTestId(testId).press('Enter');
  }
  // The fields preview a transform; Apply commits it.
  await page.getByTestId('context-bar').getByRole('button', { name: 'Apply', exact: true }).click();
  await expect.poll(() => page.evaluate(() => {
    const origin = (window as any).__editorForTests.session.activeLayer.transform.origin;
    return [Math.round(origin.x), Math.round(origin.y)];
  })).toEqual([x, y]);
}

/** Colour panel › hex field sets the foreground colour. */
async function setForegroundHex(page: Page, hex: string): Promise<void> {
  await page.getByTestId('tab-color').click();
  await expect(page.getByTestId('color-panel')).toBeVisible();
  await page.getByTestId('color-panel-hex').fill(hex);
  await page.getByTestId('color-panel-hex').press('Enter');
  await expect(page.getByTestId('color-panel-fg')).toHaveAttribute('data-hex', hex);
  await page.getByTestId('tab-layers').click();
}

async function layerEffects(page: Page, name: string): Promise<string[]> {
  return page.evaluate((n) => (window as any).__editorForTests.session.document.layers.find((l: any) => l.name === n)
    .effects.filter((e: any) => e.enabled).map((e: any) => e.kind), name);
}
