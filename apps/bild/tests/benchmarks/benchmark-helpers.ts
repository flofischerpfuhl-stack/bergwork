import { expect, type Page } from '@playwright/test';
import type { ProjectManifestV1 } from '../../contracts';
import { encodePng } from '../../src/io/png';
import {
  exportedPixels,
  importThroughMenu,
  manifest as readManifest,
  mountForTest,
  solidPng,
} from '../e2e/helpers';

export { exportedPixels, importThroughMenu, mountForTest, solidPng };

export const PLAN = 'PRODUCT-PLAN.md §7.2';

/** An intentional red benchmark: reaching this line proves all preceding UI steps worked. */
export function missing(capability: string, planRef: string): never {
  throw new Error(`MISSING CAPABILITY: ${capability} (${planRef}). The benchmark reached the first unavailable UI step.`);
}

export async function manifest(page: Page): Promise<ProjectManifestV1> {
  return readManifest(page) as Promise<ProjectManifestV1>;
}

export async function createCanvas(page: Page, width = 100, height = 100): Promise<void> {
  await mountForTest(page);
  await page.getByTestId('widthInput').fill(String(width));
  await page.getByTestId('heightInput').fill(String(height));
  await page.getByTestId('createCanvas').click();
  await expect(page.getByTestId('canvasDimensions')).toContainText(`${width.toLocaleString()} × ${height.toLocaleString()} px`);
}

export function patternedPng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => readonly [number, number, number, number],
): Buffer {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const rgba = pixel(x, y);
      const offset = (y * width + x) * 4;
      data[offset] = rgba[0];
      data[offset + 1] = rgba[1];
      data[offset + 2] = rgba[2];
      data[offset + 3] = rgba[3];
    }
  }
  return Buffer.from(encodePng(data, width, height, 4));
}

export async function importPng(page: Page, name: string, png: Buffer): Promise<void> {
  await importFile(page, name, 'image/png', png);
}

export async function importFile(page: Page, name: string, mimeType: string, buffer: Buffer): Promise<void> {
  await importThroughMenu(page, [{ name, mimeType, buffer }]);
  const layerName = name.replace(/\.[^.]+$/, '');
  await expect.poll(async () => (await manifest(page)).layers.some((layer) => layer.name === layerName)).toBe(true);
}

export async function documentPoint(page: Page, x: number, y: number, width = 100, height = 100): Promise<{ x: number; y: number }> {
  const pane = await page.getByTestId('canvas-pane').boundingBox();
  if (!pane) throw new Error('Canvas pane has no bounding box.');
  const zoomText = await page.getByTestId('zoomStatus').textContent();
  const ratio = await page.evaluate(() => devicePixelRatio);
  const zoom = Number.parseFloat(zoomText ?? '') / 100 / ratio;
  return {
    x: pane.x + pane.width / 2 + (x - width / 2) * zoom,
    y: pane.y + pane.height / 2 + (y - height / 2) * zoom,
  };
}

export async function dragInDocument(
  page: Page,
  from: readonly [number, number],
  to: readonly [number, number],
  width = 100,
  height = 100,
): Promise<void> {
  const a = await documentPoint(page, from[0], from[1], width, height);
  const b = await documentPoint(page, to[0], to[1], width, height);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 5 });
  await page.mouse.up();
}

export async function clearFlatBackground(page: Page): Promise<void> {
  await page.getByTestId('tool-wand').click();
  const background = await documentPoint(page, 5, 5);
  await page.mouse.click(background.x, background.y);
  await expect.poll(() => page.evaluate(() => Boolean((window as unknown as {
    __editorForTests: { session: { selection: unknown } };
  }).__editorForTests.session.selection))).toBe(true);
  await page.getByTestId('compositor-editor').press('Backspace');
}

export function rgbaAt(pixels: { width: number; data: number[] }, x: number, y: number): number[] {
  const offset = (y * pixels.width + x) * 4;
  return pixels.data.slice(offset, offset + 4);
}

export async function applyGaussianBlur(page: Page, radius: string): Promise<void> {
  await page.getByTestId('menu-Filter').click();
  await page.getByRole('menuitem', { name: 'Gaussian Blur…' }).click();
  await page.getByTestId('blurRadius').fill(radius);
  await page.getByTestId('adjustment-ok').click();
  await expect(page.getByTestId('adjustment-panel')).toHaveCount(0, { timeout: 30_000 });
}
