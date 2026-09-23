import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const fixture = readFileSync(new URL('./heic-quadrants.heic', import.meta.url)).toString('base64');

async function mount(page: Page, enableWasm: boolean): Promise<void> {
  await page.goto('/?harness=heic');
  await page.evaluate(async ({ enableWasm }) => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const { mountEditor } = await load('/src/index.ts');
    const recorded: { code: string; message: string }[] = [];
    const host = {
      ...(enableWasm ? { heicDecoder: 'lgpl-wasm' as const } : {}),
      async chooseImages() { return []; },
      async chooseProject() { return null; },
      async saveFile() {},
      reportError(error: { code: string; message: string }) { recorded.push(error); },
    };
    (window as any).__errors = recorded;
    (window as any).__handle = await mountEditor(document.getElementById('root')!, { host });
  }, { enableWasm });
}

async function importFixture(page: Page): Promise<string | null> {
  return page.evaluate(async (base64) => {
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    try {
      await (window as any).__handle.importImage(new Blob([bytes], { type: 'image/heic' }), 'heic-quadrants.heic');
      return null;
    } catch (error) { return (error as Error).message; }
  }, fixture);
}

// Generated specifically for this repository from a 64×64 red/green PNG with Ubuntu's
// LGPL libheif 1.17.6 + x265 3.5 (`heif-enc --quality 95`), SHA-256
// b496c28c0bb1b99dce93e4c40ac0c5aa506732c9e0c656af8e103b2a91474208.
test('Chromium imports a real HEIC only when the LGPL WASM decoder is enabled', async ({ page }) => {
  await mount(page, true);
  expect(await importFixture(page)).toBeNull();
  const result = await page.evaluate(async () => {
    const handle = (window as any).__handle;
    const manifest = handle.getManifest();
    const blob: Blob = await handle.exportImage({ format: 'png' });
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const at = (x: number, y: number) => Array.from(pixels.slice((y * bitmap.width + x) * 4, (y * bitmap.width + x) * 4 + 4));
    return { width: manifest.width, height: manifest.height, left: at(8, 32), right: at(56, 32) };
  });
  expect(result.width).toBe(64);
  expect(result.height).toBe(64);
  expect(result.left[0]).toBeGreaterThan(220);
  expect(result.left[1]).toBeLessThan(40);
  expect(result.right[0]).toBeLessThan(40);
  expect(result.right[1]).toBeGreaterThan(220);
  expect(await page.evaluate(() => performance.getEntriesByType('resource').some((entry) => entry.name.includes('libheif')))).toBe(true);
});

test('Chromium keeps the readable error and does not load LGPL WASM when disabled', async ({ page }) => {
  await mount(page, false);
  expect(await importFixture(page)).toBe('This browser cannot decode HEIC. Convert the image to JPEG or PNG and try again.');
  expect(await page.evaluate(() => (window as any).__errors)).toEqual([{
    code: 'import-unsupported',
    message: 'This browser cannot decode HEIC. Convert the image to JPEG or PNG and try again.',
  }]);
  expect(await page.evaluate(() => performance.getEntriesByType('resource').some((entry) => entry.name.includes('libheif')))).toBe(false);
});
