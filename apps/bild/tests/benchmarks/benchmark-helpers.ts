import { expect, type Locator, type Page } from '@playwright/test';
import { unzipSync } from 'fflate';
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

/** mountForTest, but with the Pro profile (PRODUCT-PLAN §5: 300 MP / 60,000 px documents; the browser build defaults to Lite). */
export async function mountPro(page: Page): Promise<void> {
  await page.goto('/?harness=ui');
  await page.evaluate(async () => {
    document.body.style.cssText = 'margin:0;width:100vw;height:100vh;overflow:hidden';
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const { mountEditor } = await load('/src/index.ts');
    const { createBrowserHost } = await load('/src/platform/browserHost.ts');
    const { chooseSaveTarget: _choose, saveFileTo: _to, ...base } = createBrowserHost();
    const w = window as unknown as Record<string, unknown>;
    w.__saved = [];
    w.__errors = [];
    w.__handle = await mountEditor(document.getElementById('root')!, {
      locale: 'en', theme: 'dark', profile: 'pro',
      host: {
        ...base,
        async saveFile(blob: Blob, name: string) { (w.__saved as unknown[]).push({ name, type: blob.type, size: blob.size, blob }); },
        reportError(error: { code: string; message: string }) { (w.__errors as unknown[]).push(error); },
      },
    });
  });
  await expect(page.locator('[data-editor-profile="pro"]')).toBeVisible();
}

export async function createCanvas(page: Page, width = 100, height = 100, profile: 'lite' | 'pro' = 'lite'): Promise<void> {
  if (profile === 'pro') await mountPro(page); else await mountForTest(page);
  await page.getByTestId('widthInput').fill(String(width));
  await page.getByTestId('heightInput').fill(String(height));
  await page.getByTestId('createCanvas').click();
  // The status bar formats with the browser's locale, not the locale of the Node process running the test.
  const expected = await page.evaluate(([w, h]) => `${w!.toLocaleString()} × ${h!.toLocaleString()} px`, [width, height]);
  await expect(page.getByTestId('canvasDimensions')).toContainText(expected);
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

// MARK: Phase 2 UI helpers

export interface Pixels { width: number; height: number; data: number[] }

/** Page coordinates of a document pixel, for any canvas size, zoom or artboard layout. */
export async function viewPoint(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  return page.evaluate(({ x, y }) => {
    const controller = (window as unknown as { __editorForTests: any }).__editorForTests;
    const session = controller.session;
    const view = session.viewport.viewPoint({ x, y }, session.document);
    const rect = controller.canvasView.element.getBoundingClientRect();
    return { x: rect.left + view.x, y: rect.top + view.y };
  }, { x, y });
}

export async function dragView(page: Page, from: readonly [number, number], to: readonly [number, number], steps = 6): Promise<void> {
  const a = await viewPoint(page, from[0], from[1]), b = await viewPoint(page, to[0], to[1]);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps });
  await page.mouse.up();
}

export async function clickView(page: Page, x: number, y: number): Promise<void> {
  const point = await viewPoint(page, x, y);
  await page.mouse.click(point.x, point.y);
}

/** Opens a menu-bar menu and walks its submenus; the last label is clicked. Submenu items carry a trailing ›, others a shortcut. */
export async function menuPath(page: Page, menu: string, ...items: string[]): Promise<void> {
  await page.getByTestId(`menu-${menu}`).click();
  for (const [index, label] of items.entries()) {
    const escaped = label.replace(/[.*+?^$()|[\]\\]/g, (c) => `\\${c}`);
    const entry = page.getByRole('menuitem', { name: new RegExp(`^${escaped}( ›| [^ ]+)?$`) });
    if (index < items.length - 1) await entry.hover(); else await entry.click();
  }
}

/** Layer › Layer Style › <effect>…: opens the Layer Style dialog on that effect. */
export async function openLayerStyle(page: Page, effect: string): Promise<void> {
  await page.getByTestId('menu-Layer').click();
  await page.getByRole('menuitem', { name: /^Layer Style/ }).click();
  await page.getByRole('menuitem', { name: effect, exact: true }).click();
  await expect(page.getByTestId('layer-style-dialog')).toBeVisible();
}

/** Layer Style fields apply while typing (Enter would confirm the whole dialog). */
export async function styleField(page: Page, testId: string, value: string): Promise<void> {
  await page.getByTestId(testId).fill(value);
  await expect(page.getByTestId(testId)).toHaveValue(value);
}

/** Composited document pixels as the canvas draws them (waits until vector/text/embedded layers are rendered). */
export async function renderedRegion(page: Page, x: number, y: number, width: number, height: number): Promise<Pixels> {
  await expect.poll(() => page.evaluate(() => {
    const session = (window as unknown as { __editorForTests: any }).__editorForTests.session;
    return session.document.layers.every((layer: any) => !['vector', 'text', 'embedded'].includes(layer.kind) || !!session.displayedRaster(layer));
  }), { timeout: 90_000 }).toBe(true);
  const data = await page.evaluate(({ x, y, width, height }) => {
    const controller = (window as unknown as { __editorForTests: any }).__editorForTests;
    return Array.from(controller.canvas.readRegion(controller.session.document, x, y, width, height) as Uint8Array);
  }, { x, y, width, height });
  return { width, height, data };
}

export interface ExportedFile { name: string; bytes: Uint8Array }

/**
 * File › Export As…: `configure` sets the dialog up, Export writes through the host (one file, or one ZIP for several).
 * Returns the written files, a ZIP unpacked into its entries.
 */
export async function exportAs(page: Page, configure: (dialog: Locator) => Promise<void> = async () => {}): Promise<ExportedFile[]> {
  const before = await page.evaluate(() => ((window as unknown as { __saved: unknown[] }).__saved).length);
  await page.getByTestId('menu-File').click();
  await page.getByTestId('menu-export').click();
  const dialog = page.getByTestId('export-dialog');
  await expect(dialog).toBeVisible();
  await configure(dialog);
  await page.getByTestId('export-confirm').click();
  await expect.poll(() => page.evaluate(() => ((window as unknown as { __saved: unknown[] }).__saved).length), { timeout: 120_000 }).toBe(before + 1);
  await expect(dialog).toHaveCount(0);
  const saved = await page.evaluate(async (index) => {
    const entry = ((window as unknown as { __saved: { name: string; blob: Blob }[] }).__saved)[index]!;
    return { name: entry.name, bytes: Array.from(new Uint8Array(await entry.blob.arrayBuffer())) };
  }, before);
  const bytes = Uint8Array.from(saved.bytes);
  if (!/\.zip$/i.test(saved.name)) return [{ name: saved.name, bytes }];
  return Object.entries(unzipSync(bytes)).map(([name, data]) => ({ name, bytes: data }));
}

/** Decodes an exported PNG/JPEG/WebP/AVIF with the browser (no colour conversion, straight alpha). */
export async function decodeImage(page: Page, file: ExportedFile): Promise<Pixels> {
  const type = /\.webp$/i.test(file.name) ? 'image/webp' : /\.jpe?g$/i.test(file.name) ? 'image/jpeg' : /\.avif$/i.test(file.name) ? 'image/avif' : 'image/png';
  return page.evaluate(async ({ bytes, type }) => {
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(bytes)], { type }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const canvas = Object.assign(document.createElement('canvas'), { width: bitmap.width, height: bitmap.height });
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    context.drawImage(bitmap, 0, 0);
    return { width: bitmap.width, height: bitmap.height, data: Array.from(context.getImageData(0, 0, bitmap.width, bitmap.height).data) };
  }, { bytes: Array.from(file.bytes), type });
}

export function fileNamed(files: readonly ExportedFile[], name: string): ExportedFile {
  const file = files.find((candidate) => candidate.name === name);
  if (!file) throw new Error(`Export produced ${files.map((f) => f.name).join(', ')}, not ${name}.`);
  return file;
}

