import { expect, type Page } from '@playwright/test';
import {
  PLAN,
  applyGaussianBlur,
  clearFlatBackground,
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
  await cutOutFlatProduct(page);
  missing('editable drop-shadow/layer effects before the three social-format exports', task(1));
}

export async function benchmark02(page: Page): Promise<void> {
  await createCanvas(page, 160, 90);
  await importPng(page, 'color-field.png', solidPng(160, 90, [25, 45, 90, 255]));
  await importPng(page, 'campaign-photo.png', solidPng(60, 60, [230, 145, 45, 255]));
  const state = await manifest(page);
  expect(state.layers.map((layer) => layer.name)).toEqual(['Layer 1', 'color-field', 'campaign-photo']);
  missing('text layers for the campaign headline (before SVG placement, artboards, and WebP export)', task(2));
}

export async function benchmark03(page: Page): Promise<void> {
  await cutOutFlatProduct(page, 'person.png');
  missing('editable outline/glow layer effects for the extracted person', task(3));
}

async function assertProjectOpenIsNotPsdOpen(page: Page, number: 4 | 5): Promise<never> {
  await mountForTest(page);
  await page.getByTestId('menu-File').click();
  await expect(page.getByRole('menuitem', { name: 'Open Project…' })).toBeEnabled();
  return missing('PSD/PSB import through the file-open UI', task(number));
}

export async function benchmark04(page: Page): Promise<void> {
  await assertProjectOpenIsNotPsdOpen(page, 4);
}

export async function benchmark05(page: Page): Promise<void> {
  await assertProjectOpenIsNotPsdOpen(page, 5);
}

export async function benchmark06(page: Page): Promise<void> {
  const portrait = patternedPng(100, 100, (x, y) =>
    Math.hypot(x - 60, y - 50) < 3 ? [15, 15, 15, 255] : [190, 125, 105, 255]);
  await createCanvas(page);
  await importPng(page, 'portrait.png', portrait);
  await page.getByTestId('tool-spotHealing').click();
  await dragInDocument(page, [58, 50], [62, 50]);
  await expect.poll(async () => rgbaAt(await exportedPixels(page), 60, 50)[0], { timeout: 30_000 }).toBeGreaterThan(120);
  missing('a dodge/burn tool for the eye treatment', task(6));
}

export async function benchmark07(page: Page): Promise<void> {
  await createCanvas(page, 120, 80);
  await importPng(page, 'landscape.png', patternedPng(120, 80, (_x, y) =>
    y < 40 ? [80, 150, 220, 255] : [45, 100, 40, 255]));
  expect((await manifest(page)).layers.at(-1)?.name).toBe('landscape');
  missing('object-selection UI (before edge refinement and adjustment-layer color matching)', task(7));
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
  expect((await manifest(page)).layers.some((layer) => layer.kind === 'shape')).toBe(true);
  missing('artboards and per-artboard resizing for the five banner formats', task(9));
}

export async function benchmark10(page: Page): Promise<void> {
  await createCanvas(page);
  await page.getByTestId('tool-shape').click();
  await dragInDocument(page, [20, 20], [80, 80]);
  const state = await manifest(page);
  expect(state.layers.at(-1)?.kind).toBe('shape');
  expect(rgbaAt(await exportedPixels(page), 50, 50)[3]).toBe(255);
  missing('boolean operations between vector shape layers', task(10));
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
  await createCanvas(page, 20_000, 10_000);
  const state = await manifest(page);
  expect(state.width * state.height).toBe(200_000_000);
  expect(state.layers).toHaveLength(1);
  missing('the Pro scratch-backed 200 MP stress path needed to populate and edit 30 full-size layers safely', task(13));
}

export async function benchmark14(page: Page): Promise<void> {
  await createCanvas(page, 40, 40);
  await importPng(page, 'series-01.png', solidPng(40, 40, [80, 80, 80, 255]));
  await page.getByTestId('compositor-editor').press(process.platform === 'darwin' ? 'Meta+l' : 'Control+l');
  await expect(page.getByTestId('adjustment-panel')).toBeVisible();
  await page.getByTestId('levelsInputwhite').fill('160');
  await page.getByTestId('adjustment-ok').click();
  expect(rgbaAt(await exportedPixels(page), 20, 20)[0]).toBeGreaterThan(110);
  missing('recordable recipes and applying one recipe to a 50-image queue', task(14));
}

export async function benchmark15(page: Page): Promise<void> {
  await createCanvas(page, 120, 160);
  await expect(page.getByTestId('tool-text')).toHaveCount(0);
  missing('editable text layers, including variable fonts and OpenType ligatures', task(15));
}

export async function benchmark16(page: Page): Promise<void> {
  await createCanvas(page);
  await importPng(page, 'package-face.png', solidPng(60, 60, [210, 180, 50, 255]));
  expect((await manifest(page)).layers.at(-1)?.transform).toEqual([1, 0, 0, 1, 20, 20]);
  missing('mesh-warp editing controls', task(16));
}

export async function benchmark17(page: Page): Promise<void> {
  await createCanvas(page, 40, 40);
  await importPng(page, 'old-photo.png', patternedPng(40, 40, (x, y) => {
    const value = (x + y) % 8 < 4 ? 70 : 170;
    return [value, value, value, 255];
  }));
  await page.getByTestId('menu-Image').click();
  await page.getByRole('menuitem', { name: 'Image Size…' }).click();
  await page.getByTestId('imageSizeWidth').fill('80');
  await page.getByTestId('imageSizeWidth').press('Enter');
  await page.getByTestId('imageSizeOK').click();
  await expect.poll(async () => (await manifest(page)).width, { timeout: 30_000 }).toBe(80);
  expect((await manifest(page)).height).toBe(80);
  missing('a denoise filter after upscaling', task(17));
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
  missing('arrow and outline-only frame annotation primitives', task(18));
}

export async function benchmark19(page: Page): Promise<void> {
  await cutOutFlatProduct(page, 'raster-logo.png');
  missing('an editable contour/stroke around transparent raster artwork', task(19));
}

export async function benchmark20(page: Page): Promise<void> {
  await createCanvas(page, 64, 48);
  await importPng(page, 'recovery-layer.png', solidPng(12, 10, [0, 140, 125, 255]));
  const before = await manifest(page);
  await expect.poll(async () => page.evaluate(async () => {
    const request = indexedDB.open('fernwork-compositor');
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (!database.objectStoreNames.contains('recovery')) { database.close(); return 0; }
    const countRequest = database.transaction('recovery').objectStore('recovery').count();
    const count = await new Promise<number>((resolve, reject) => {
      countRequest.onsuccess = () => resolve(countRequest.result);
      countRequest.onerror = () => reject(countRequest.error);
    });
    database.close();
    return count;
  }), { timeout: 15_000 }).toBe(1);
  await mountForTest(page);
  await expect(page.getByRole('alertdialog')).toContainText('Recover an unsaved project?');
  await page.getByRole('button', { name: 'Recover' }).click();
  await expect(page.getByTestId('layerCount')).toHaveText('2');
  expect((await manifest(page)).layers).toEqual(before.layers);
  await page.getByTestId('menu-Edit').click();
  await expect(page.getByTestId('menu-undo')).toBeDisabled();
  missing('persisted undo history that remains available after crash recovery', task(20));
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
