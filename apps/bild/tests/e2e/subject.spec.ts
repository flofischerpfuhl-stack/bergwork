import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

const flowerPath = '/home/oem/Dokumente/003_Projekte/17_fernwork/research/compositor-port/references/official-site/example2.png';

test('real U²-Netp separates the flower from its background in Chromium', async ({ page }) => {
  test.skip(!existsSync(flowerPath), 'reference photo from the upstream site is not available on this machine');
  test.setTimeout(120_000);
  const encoded = (await readFile(flowerPath)).toString('base64');
  await page.goto('/');
  const result = await page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('2D canvas is unavailable');
    context.drawImage(bitmap, 0, 0);
    const rgba = new Uint8Array(context.getImageData(0, 0, bitmap.width, bitmap.height).data);
    bitmap.close();
    const load = (path: string): Promise<unknown> => import(/* @vite-ignore */ path);
    const module = await load('/src/workers/subjectClient.ts') as typeof import('../../src/workers/subjectClient');
    const client = new module.SubjectInferenceClient();
    const output = await client.infer('e2e-flower', rgba, canvas.width, canvas.height,
      { quality: 'basic', refineEdges: 12, matteContrast: 25, shiftEdge: 0 }, 1400);
    const mask = output.mask, width = canvas.width, height = canvas.height;
    const mean = (left: number, top: number, right: number, bottom: number): number => {
      let sum = 0, count = 0;
      for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) { sum += mask[y * width + x]!; count++; }
      return sum / count;
    };
    const patchWidth = Math.round(width * 0.08), patchHeight = Math.round(height * 0.08);
    const center = mean(Math.round(width * 0.46), Math.round(height * 0.40), Math.round(width * 0.54), Math.round(height * 0.55));
    const corners = [
      mean(0, 0, patchWidth, patchHeight), mean(width - patchWidth, 0, width, patchHeight),
      mean(0, height - patchHeight, patchWidth, height),
      mean(width - patchWidth, height - patchHeight, width, height),
    ];
    const heap = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null;
    client.destroy();
    return { width, height, center, corners, timing: output.timing, heap };
  }, encoded);

  expect(result.center).toBeGreaterThan(210);
  for (const corner of result.corners) expect(corner).toBeLessThan(55);
  expect(result.timing.inferenceMs).toBeGreaterThan(0);
  expect(result.timing.estimatedBytes).toBeGreaterThan(4_574_861);
  console.log('Subject model metrics', result);
});

test('Filter > Remove Background previews a mask and applies it as one undo step', async ({ page }) => {
  test.skip(!existsSync(flowerPath), 'reference photo from the upstream site is not available on this machine');
  test.setTimeout(120_000);
  const { importThroughMenu, manifest, mountForTest } = await import('./helpers');
  await page.setViewportSize({ width: 1440, height: 900 });
  await mountForTest(page);
  await page.getByTestId('createCanvas').click();
  await importThroughMenu(page, [{ name: 'flower.png', mimeType: 'image/png', buffer: await readFile(flowerPath) }]);
  await expect.poll(async () => (await manifest(page)).layers.length).toBe(2);
  await page.getByTestId('menu-Filter').click();
  await page.getByRole('menuitem', { name: 'Remove Background…' }).click();
  const panel = page.getByTestId('remove-background-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('remove-background-ok')).toBeEnabled({ timeout: 90_000 });
  // The preview is a mask override; nothing is committed yet.
  expect((await manifest(page)).layers[1].mask).toBeFalsy();
  await page.getByRole('radio', { name: 'Advanced' }).click();
  await expect(page.getByTestId('remove-background-ok')).toBeEnabled({ timeout: 60_000 });
  await page.getByTestId('remove-background-ok').click();
  await expect(panel).toHaveCount(0);
  const layer = (await manifest(page)).layers[1];
  expect(layer.mask).toBeTruthy();
  expect(layer.mask.enabled).toBe(true);
  await page.getByTestId('compositor-editor').press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await expect.poll(async () => (await manifest(page)).layers[1].mask ?? null).toBeNull();
});
