import { expect, test, type Page } from '@playwright/test';
import { decodePng } from '../../src/io/png';
import { importThroughMenu, manifest, mountForTest } from './helpers';
import { rampPng } from './qa-helpers';

/**
 * QA 16-bit workflow as a user does it: import a dark 16-bit (or 8-bit) PNG ramp through File › Import, stretch it
 * with strong Levels (⌘L, input white 64, gamma 0.6) or a Curves adjustment layer, export PNG, and look for banding.
 * Then save/reopen the project and check the layer is still 16 bit.
 */
test.use({ viewport: { width: 1440, height: 900 } });
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const W = 2048, H = 8;

async function exportRow(page: Page): Promise<number[]> {
  const b64 = await page.evaluate(async () => {
    const blob: Blob = await (window as any).__handle.exportImage({ format: 'png' });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  });
  const png = decodePng(new Uint8Array(Buffer.from(b64, 'base64'))) as any;
  const data: Uint8Array = png.pixels ?? png.data;
  const channels = data.length / (png.width * png.height);
  return Array.from({ length: png.width }, (_, x) => data[(4 * png.width + x) * channels]!);
}

const bandingOf = (row: number[]) => {
  let maxStep = 0;
  for (let x = 1; x < row.length; x++) maxStep = Math.max(maxStep, Math.abs(row[x]! - row[x - 1]!));
  return { distinct: new Set(row).size, maxStep, last: row.at(-1)! };
};

async function openRamp(page: Page, bits: 8 | 16, W = 2048, H = 8): Promise<void> {
  await mountForTest(page);
  await page.getByTestId('widthInput').fill(String(W));
  await page.getByTestId('heightInput').fill(String(H));
  await page.getByTestId('createCanvas').click();
  await importThroughMenu(page, [{ name: `ramp${bits}.png`, mimeType: 'image/png', buffer: rampPng(bits, W, H) }]);
  await expect.poll(async () => (await manifest(page)).layers.length).toBe(2);
}

const topRasterFormat = (page: Page) => page.evaluate(() => (window as any).__editorForTests.session.document.layers.at(-1)?.raster?.format ?? null);

async function strongLevels(page: Page): Promise<void> {
  await page.getByTestId('compositor-editor').press(`${mod}+l`);
  const panel = page.getByTestId('adjustment-panel');
  await expect(panel).toBeVisible();
  await page.getByTestId('levelsInputwhite').fill('64');
  await page.getByTestId('levelsInputwhite').press('Enter');
  await page.getByTestId('levelsGamma').fill('0.6');
  await page.getByTestId('levelsGamma').press('Enter');
  await page.getByTestId('adjustment-ok').click();
  await expect(panel).toHaveCount(0);
}

test('QA bug: strong Levels (⌘L) on a 16-bit ramp bands exactly like the 8-bit ramp', async ({ page, browser }) => {
  // The 8-bit reference runs in its own context: reloading this page would bring up the recovery prompt.
  const other = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: { width: 1440, height: 900 } });
  const eightPage = await other.newPage();
  await openRamp(eightPage, 8);
  await strongLevels(eightPage);
  const eight = bandingOf(await exportRow(eightPage));
  await other.close();
  await openRamp(page, 16);
  expect(await topRasterFormat(page)).toBe('rgba16');
  await strongLevels(page);
  const sixteen = bandingOf(await exportRow(page));
  console.log(`QA levels: 8-bit ${JSON.stringify(eight)}, 16-bit ${JSON.stringify(sixteen)}`);
  expect(eight.last).toBeGreaterThan(250);
  expect(sixteen.last).toBeGreaterThan(250);
  expect(eight.distinct).toBeLessThan(80);
  expect(sixteen.distinct).toBeGreaterThan(230);
  expect(sixteen.maxStep).toBeLessThanOrEqual(2);
});

test('QA 16-bit: a Curves adjustment layer over the 16-bit ramp exports without banding', async ({ page }) => {
  await openRamp(page, 16);
  // A steep curve (0,0) → (64,255): what a user drags in the Curves panel, set through the session like the panel does.
  await page.getByTestId('menu-Layer').click();
  await page.getByRole('menuitem', { name: 'New Adjustment Layer' }).hover();
  await page.getByRole('menuitem', { name: 'Curves…' }).click();
  await expect(page.getByTestId('adjustment-panel')).toBeVisible();
  await page.getByTestId('adjustment-ok').click();
  await page.evaluate(() => {
    const s = (window as any).__editorForTests.session;
    const layer = s.document.layers.at(-1);
    const points = [{ x: 0, y: 0 }, { x: 64, y: 255 }, { x: 255, y: 255 }], id = [{ x: 0, y: 0 }, { x: 255, y: 255 }];
    s.updateAdjustment(layer.id, { ...layer.adjustment, parameters: { ...layer.adjustment.parameters, channel: 'RGB', channels: [points, id, id, id] } });
  });
  const result = bandingOf(await exportRow(page));
  console.log(`QA curves layer 16-bit: ${JSON.stringify(result)}`);
  expect(result.last).toBeGreaterThan(250);
  expect(result.distinct).toBeGreaterThan(230);
  expect(result.maxStep).toBeLessThanOrEqual(2);
});

test('QA 16-bit: save and reopen keeps the 16-bit raster bit-exactly, and undo continues after reopening', async ({ page }) => {
  await openRamp(page, 16);
  await page.getByTestId('addBlankLayer').click();
  const digest = () => page.evaluate(() => {
    const r = (window as any).__editorForTests.session.document.layers.find((l: any) => l.name === 'ramp16').raster;
    const px = r.toPixelsNative() as Uint16Array | Uint8Array;
    let h = 0; for (let i = 0; i < px.length; i++) h = (Math.imul(h, 31) + px[i]!) | 0;
    return { format: r.format, hash: h };
  });
  const before = await digest();
  expect(before.format).toBe('rgba16');
  await page.evaluate(async () => { const h = (window as any).__handle; await h.openProject(await h.saveProject()); });
  expect(await digest()).toEqual(before);
  // Undo continues after reopening (history is saved by default): the blank layer goes away.
  await expect.poll(async () => (await manifest(page)).layers.length).toBe(3);
  expect(await page.evaluate(() => (window as any).__handle.undo())).toBe(true);
  await expect.poll(async () => (await manifest(page)).layers.length).toBe(2);
  expect(await digest()).toEqual(before);
});

/** Operations a user applies to a 16-bit layer; each must keep the layer 16 bit (Photoshop keeps the mode). */
const ops: [string, (page: Page) => Promise<void>][] = [
  ['Image › Levels (⌘L)', strongLevels],
  ['Image › Invert (⌘I)', async (page) => { await page.getByTestId('compositor-editor').press(`${mod}+i`); }],
  ['Image › Hue/Saturation (⌘U)', async (page) => {
    await page.getByTestId('compositor-editor').press(`${mod}+u`);
    await page.getByTestId('hueLightness').fill('20');
    await page.getByTestId('hueLightness').press('Enter');
    await page.getByTestId('adjustment-ok').click();
    await expect(page.getByTestId('adjustment-panel')).toHaveCount(0);
  }],
  ['Filter › Gaussian Blur', async (page) => {
    await page.getByTestId('menu-Filter').click();
    await page.getByRole('menuitem', { name: 'Gaussian Blur…' }).click();
    await expect(page.getByTestId('adjustment-panel')).toBeVisible();
    await page.getByTestId('adjustment-ok').click();
    await expect(page.getByTestId('adjustment-panel')).toHaveCount(0);
  }],
  ['Brush stroke', async (page) => {
    await page.getByTestId('tool-brush').click();
    const pane = (await page.getByTestId('canvas-pane').boundingBox())!;
    await page.mouse.move(pane.x + pane.width / 2 - 30, pane.y + pane.height / 2);
    await page.mouse.down();
    await page.mouse.move(pane.x + pane.width / 2 + 30, pane.y + pane.height / 2, { steps: 5 });
    await page.mouse.up();
  }],
  ['Layer › Flip Layer Horizontal', async (page) => {
    await page.getByTestId('menu-Layer').click();
    await page.getByRole('menuitem', { name: 'Flip Layer Horizontal' }).click();
  }],
];
for (const [name, run] of ops) {
  test(`QA 16-bit: ${name} keeps a 16-bit layer 16 bit`, async ({ page }) => {
    await openRamp(page, 16, 512, 256);
    expect(await topRasterFormat(page)).toBe('rgba16');
    const revision = await page.evaluate(() => (window as any).__editorForTests.session.history.undoCount);
    await run(page);
    // The operation must actually have happened (one more undo step).
    await expect.poll(() => page.evaluate(() => (window as any).__editorForTests.session.history.undoCount)).toBeGreaterThan(revision);
    expect(await topRasterFormat(page)).toBe('rgba16');
  });
}

for (const mode of ['Paint', 'Erase'] as const) {
  test(`QA bug: a brush stroke (${mode}) on an imported 16-bit layer is drawn on screen but silently discarded`, async ({ page }) => {
    await openRamp(page, 16, 512, 256);
    await page.getByTestId('tool-brush').click();
    if (mode === 'Erase') await page.getByTestId('context-bar').getByText('Erase', { exact: true }).click();
    const pane = (await page.getByTestId('canvas-pane').boundingBox())!;
    const cx = pane.x + pane.width / 2, cy = pane.y + pane.height / 2;
    await page.mouse.move(cx - 60, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 60, cy, { steps: 8 });
    await page.mouse.up();
    // Either the stroke is committed as an undo step, or the user is told why not; neither happens today.
    await expect.poll(() => page.evaluate(() => {
      const s = (window as any).__editorForTests.session;
      return s.history.pastNames.includes('Brush Stroke') || (window as any).__errors.length > 0;
    }), { timeout: 10_000 }).toBe(true);
    const centre = await page.evaluate(() => {
      const s = (window as any).__editorForTests.session;
      const r = s.document.layers.at(-1).raster;
      return Array.from(r.readRegionNative(256, 128, 1, 1) as Uint16Array);
    });
    // Paint: black (foreground); Erase: transparent. The ramp there is ~12 % grey, opaque.
    if (mode === 'Paint') expect(centre.slice(0, 3)).toEqual([0, 0, 0]);
    else expect(centre[3]).toBe(0);
  });
}
