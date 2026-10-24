import { expect, test, type Page } from '@playwright/test';
import { encodePng } from '../../src/io/png';
import { exportedPixels, importThroughMenu, manifest, mountForTest } from './helpers';

test.use({ viewport: { width: 1440, height: 900 } });

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const SIZE = 64;

/** A textured, colourful photo stand-in: a gradient with a bright disc, bars and a hard edge. */
function photo(): Buffer {
  const data = new Uint8Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const disc = Math.hypot(x - 40, y - 24) < 7, bar = x % 12 < 4;
    data.set(disc ? [255, 250, 235, 255] : [bar ? 40 : 90 + x * 2, 60 + y * 2, bar ? 150 : 110, 255], (y * SIZE + x) * 4);
  }
  return Buffer.from(encodePng(data, SIZE, SIZE, 4));
}

async function canvasWithPhoto(page: Page): Promise<void> {
  await mountForTest(page);
  await page.getByTestId('widthInput').fill(String(SIZE));
  await page.getByTestId('heightInput').fill(String(SIZE));
  await page.getByTestId('createCanvas').click();
  await importThroughMenu(page, [{ name: 'photo.png', mimeType: 'image/png', buffer: photo() }]);
  await expect.poll(async () => (await manifest(page)).layers.length).toBe(2);
}

async function openFilter(page: Page, label: string): Promise<void> {
  await page.getByTestId('menu-Filter').click();
  await page.getByRole('menuitem', { name: label, exact: true }).click();
  await expect(page.getByTestId('adjustment-panel')).toBeVisible();
}

/** Whether the open destructive filter's worker preview has replaced the layer's displayed pixels with different ones. */
const previewDiffers = (page: Page) => page.evaluate(() => {
  const session = (window as any).__editorForTests.session, layer = session.activeLayer;
  const preview = session.rasterOverrides.get(layer.id);
  if (!preview) return false;
  const a = preview.toPixels(), b = layer.raster.toPixels();
  return a.length !== b.length || a.some((value: number, index: number) => value !== b[index]);
});
/** The photo layer's live filter stack, as stored in the document. */
const layerFilters = (page: Page) => page.evaluate(() => (window as any).__editorForTests.session.document.layers[1].filters as any[]);
const undoCount = (page: Page) => page.evaluate(() => (window as any).__editorForTests.session.history.undoCount as number);
const same = (a: number[], b: number[]) => a.length === b.length && a.every((value, index) => value === b[index]);

const FILTERS: readonly { label: string; field: string; value: string }[] = [
  { label: 'Vignette…', field: 'vignetteAmount', value: '90' },
  { label: 'Bloom / Glow…', field: 'bloomThreshold', value: '20' },
  { label: 'Tonal Contrast…', field: 'tonalAmount', value: '100' },
  { label: 'Progressive Blur…', field: 'progressiveRadius', value: '8' },
  { label: 'RGB Split…', field: 'rgbSplitDistance', value: '6' },
];

test('each creative filter previews in its panel and applies inside a selection as one undo step', async ({ page }) => {
  test.setTimeout(180_000);
  await canvasWithPhoto(page);
  const editor = page.getByTestId('compositor-editor');
  const original = (await exportedPixels(page)).data;
  await editor.press(`${mod}+a`);
  await expect.poll(() => page.evaluate(() => !!(window as any).__editorForTests.session.selection)).toBe(true);
  for (const filter of FILTERS) {
    await openFilter(page, filter.label);
    // A selection keeps the filter destructive (no smart filter), previewed by the pixel worker.
    await expect(page.getByTestId('adjustment-panel')).not.toContainText('Smart Filter');
    await page.getByTestId(filter.field).fill(filter.value);
    await page.getByTestId(filter.field).press('Enter');
    await expect.poll(() => previewDiffers(page), { message: `${filter.label} preview`, timeout: 30_000 }).toBe(true);
    const before = await undoCount(page);
    await page.getByTestId('adjustment-ok').click();
    await expect(page.getByTestId('adjustment-panel')).toHaveCount(0, { timeout: 30_000 });
    expect(await undoCount(page), filter.label).toBe(before + 1);
    expect(same((await exportedPixels(page)).data, original), `${filter.label} changed the pixels`).toBe(false);
    expect(await layerFilters(page)).toEqual([]);
    await editor.press(`${mod}+z`);
    await expect.poll(async () => same((await exportedPixels(page)).data, original), { message: `${filter.label} undo` }).toBe(true);
  }
});

test('a creative smart filter renders live, is stored on the layer and Last Filter adds it again', async ({ page }) => {
  await canvasWithPhoto(page);
  const editor = page.getByTestId('compositor-editor');
  const original = (await exportedPixels(page)).data;
  // Nothing has been applied yet, so Last Filter is disabled and its shortcut does nothing.
  await page.getByTestId('menu-Filter').click();
  await expect(page.getByTestId('menu-last-filter')).toBeDisabled();
  await page.keyboard.press('Escape');

  await openFilter(page, 'Bloom / Glow…');
  await expect(page.getByTestId('adjustment-panel')).toContainText('Smart Filter');
  await page.getByTestId('bloomThreshold').fill('10');
  await page.getByTestId('bloomThreshold').press('Enter');
  await page.getByTestId('adjustment-ok').click();
  await expect(page.getByTestId('adjustment-panel')).toHaveCount(0);
  const stored = await layerFilters(page);
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({ kind: 'bloom', threshold: 10, enabled: true });
  await expect(page.getByTestId('filter-row')).toHaveCount(1);
  // Not baked: the stored pixels stay, the composite shows the glow.
  const exported = (await exportedPixels(page)).data;
  expect(same(exported, original)).toBe(false);

  // The on-screen GPU compositor has no view program for Bloom; it draws the stack through the CPU fallback.
  const rendered = await page.evaluate(() => {
    const editorForTests = (window as any).__editorForTests, session = editorForTests.session, gpu = editorForTests.canvasView.gpu;
    const document = session.document, layer = document.layers[1];
    const filtered = gpu.readRegion(document, 0, 0, document.width, document.height);
    const plain = gpu.readRegion({ ...document, layers: document.layers.map((item: any) => item.id === layer.id ? { ...item, filters: [] } : item) },
      0, 0, document.width, document.height);
    editorForTests.canvasView.redraw();
    let max = 0;
    for (let i = 0; i < filtered.length; i++) max = Math.max(max, Math.abs(filtered[i] - plain[i]));
    return max;
  });
  expect(rendered).toBeGreaterThan(20);

  // Filter › Last Filter (mod+alt+f) adds the same smart filter again, without a panel, as one undo step.
  await page.getByTestId('menu-Filter').click();
  await expect(page.getByTestId('menu-last-filter')).toBeEnabled();
  await expect(page.getByTestId('menu-last-filter')).toContainText('Last Filter: Bloom / Glow');
  await page.keyboard.press('Escape');
  const before = await undoCount(page);
  await editor.press(`${mod}+Alt+f`);
  await expect.poll(async () => (await layerFilters(page)).length).toBe(2);
  await expect(page.getByTestId('adjustment-panel')).toHaveCount(0);
  expect((await layerFilters(page))[1]).toMatchObject({ kind: 'bloom', threshold: 10 });
  expect(await undoCount(page)).toBe(before + 1);
  await editor.press(`${mod}+z`);
  await expect.poll(async () => (await layerFilters(page)).length).toBe(1);
});

test('Vignette on an empty layer paints the whole canvas on that layer', async ({ page }) => {
  await canvasWithPhoto(page);
  const original = (await exportedPixels(page)).data;
  await page.getByTestId('menu-Layer').click();
  await page.getByTestId('menu-new-layer').click();
  await expect.poll(async () => (await manifest(page)).layers.length).toBe(3);
  await openFilter(page, 'Vignette…');
  await page.getByTestId('vignetteAmount').fill('100');
  await page.getByTestId('vignetteAmount').press('Enter');
  await page.getByTestId('adjustment-ok').click();
  await expect(page.getByTestId('adjustment-panel')).toHaveCount(0, { timeout: 30_000 });
  const layer = await page.evaluate(() => {
    const session = (window as any).__editorForTests.session, raster = session.activeLayer.raster;
    return raster && { width: raster.width, height: raster.height, corner: raster.pixel(0, 0), middle: raster.pixel(32, 32) };
  });
  expect(layer).toMatchObject({ width: SIZE, height: SIZE });
  expect(layer!.corner[3]).toBeGreaterThan(200);
  expect(layer!.middle[3]).toBe(0);
  const pixels = await exportedPixels(page);
  const at = (data: number[], x: number, y: number) => data.slice((y * SIZE + x) * 4, (y * SIZE + x) * 4 + 3);
  expect(at(pixels.data, 1, 1)[1]!).toBeLessThan(at(original, 1, 1)[1]! - 30);
  expect(at(pixels.data, 32, 32)).toEqual(at(original, 32, 32));
});
