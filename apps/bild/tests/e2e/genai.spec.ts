import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { encodePng } from '../../src/io/png';
import { lanczosRgba } from '../../src/core/genai/resample';
import { GENAI_MODELS } from '../../src/core/genai/models';
import { exportedPixels, importThroughMenu, manifest, mountForTest } from './helpers';

test.use({ viewport: { width: 1440, height: 900 } });
const MODEL_DIR = process.env.FERNWORK_GENAI_MODEL_DIR ?? '/tmp/fernwork-genai-models';
const hasMigan = existsSync(`${MODEL_DIR}/migan_pipeline_v2.onnx`);
const hasX2 = existsSync(`${MODEL_DIR}/RealESRGAN_x2plus.onnx`);
const hasX4 = existsSync(`${MODEL_DIR}/RealESRGAN_x4plus.onnx`);

function scene(): Buffer {
  const width = 96, height = 80, data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const object = x >= 42 && x < 54 && y >= 34 && y < 46;
    data.set(object ? [230, 25, 20, 255] : [25 + x % 9, 80 + y % 7, 175 + (x + y) % 11, 255], (y * width + x) * 4);
  }
  return Buffer.from(encodePng(data, width, height, 4));
}

async function selectObject(page: import('@playwright/test').Page): Promise<void> {
  await selectRect(page, 41, 33, 55, 47);
}

async function selectRect(page: import('@playwright/test').Page, x0: number, y0: number, x1: number, y1: number): Promise<void> {
  await page.getByTestId('tool-marquee').click();
  const points = await page.evaluate(([x0, y0, x1, y1]) => {
    const session = (window as any).__editorForTests.session;
    return [{ x: x0, y: y0 }, { x: x1, y: y1 }].map((point) => session.viewport.viewPoint(point, session.document));
  }, [x0, y0, x1, y1]);
  const box = (await page.getByTestId('editor-canvas').boundingBox())!;
  await page.mouse.move(box.x + points[0]!.x, box.y + points[0]!.y); await page.mouse.down();
  await page.mouse.move(box.x + points[1]!.x, box.y + points[1]!.y, { steps: 4 }); await page.mouse.up();
}

test('Pro Remove uses the existing fallback without a request, creates a new layer, and downloads AI only after the click', async ({ page }) => {
  const external: string[] = [];
  let release!: () => void;
  page.on('request', (request) => { if (request.url().startsWith('https://huggingface.co/')) external.push(request.url()); });
  await page.route('https://huggingface.co/**', async (route) => { await new Promise<void>((resolve) => { release = resolve; }); await route.abort().catch(() => {}); });
  await mountForTest(page, { profile: 'pro' });
  await page.getByTestId('widthInput').fill('96'); await page.getByTestId('heightInput').fill('80'); await page.getByTestId('createCanvas').click();
  await importThroughMenu(page, [{ name: 'generated.png', mimeType: 'image/png', buffer: scene() }]);
  await selectObject(page);
  await page.getByTestId('compositor-editor').press('Shift+Backspace');
  await expect(page.getByTestId('remove-panel')).toBeVisible();
  await expect(page.getByTestId('remove-apply')).toBeEnabled({ timeout: 30_000 });
  expect(external).toEqual([]);
  const before = await manifest(page);
  await page.getByTestId('remove-apply').click();
  await expect(page.getByTestId('remove-panel')).toHaveCount(0);
  const after = await manifest(page);
  expect(after.layers).toHaveLength(before.layers.length + 1);
  expect(after.layers.at(-1).name).toBe('Removed');
  const pixels = await exportedPixels(page), center = (40 * pixels.width + 48) * 4;
  expect(pixels.data[center]).toBeLessThan(100);
  expect(pixels.data[center + 2]).toBeGreaterThan(100);

  await page.getByTestId('compositor-editor').press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await selectObject(page);
  await page.getByTestId('compositor-editor').press('Shift+Backspace');
  await page.getByTestId('download-remove-model').click();
  await expect.poll(() => external.length).toBe(1);
  await expect(page.getByTestId('remove-model-progress')).toBeVisible();
  await page.getByTestId('remove-model-progress').getByRole('button', { name: 'Cancel' }).click();
  release();
});

test('Image Upscale exposes 2×/4× and strength, with no model request before Download and Upscale', async ({ page }) => {
  const external: string[] = [];
  let release!: () => void;
  page.on('request', (request) => { if (request.url().startsWith('https://huggingface.co/')) external.push(request.url()); });
  await page.route('https://huggingface.co/**', async (route) => { await new Promise<void>((resolve) => { release = resolve; }); await route.abort().catch(() => {}); });
  await mountForTest(page, { profile: 'pro' });
  await page.getByTestId('widthInput').fill('96'); await page.getByTestId('heightInput').fill('80'); await page.getByTestId('createCanvas').click();
  await importThroughMenu(page, [{ name: 'generated.png', mimeType: 'image/png', buffer: scene() }]);
  await page.getByTestId('menu-Image').click();
  await page.getByRole('menuitem', { name: 'Upscale…' }).click();
  await expect(page.getByTestId('upscale-panel')).toBeVisible();
  await expect(page.getByRole('radio', { name: '2×' })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('radio', { name: '4×' }).click();
  await expect(page.getByTestId('upscale-strength')).toHaveValue('75');
  expect(external).toEqual([]);
  await expect(page.getByTestId('upscale-run')).toBeEnabled();
  await page.getByTestId('upscale-run').click();
  await expect.poll(() => external.length).toBe(1);
  await expect(page.getByTestId('upscale-model-progress')).toBeVisible();
  await page.getByTestId('upscale-model-progress').getByRole('button', { name: 'Cancel' }).click();
  release();
});

test('optional local MI-GAN fixture removes the generated object through ONNX Runtime', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Model inference is covered in Chromium; command/download policy runs cross-browser.');
  test.skip(!hasMigan, `MI-GAN is not available in ${MODEL_DIR}`);
  const model = readFileSync(`${MODEL_DIR}/migan_pipeline_v2.onnx`);
  await page.route('https://huggingface.co/**', (route) => route.fulfill({ status: 200, body: model,
    headers: { 'content-type': 'application/octet-stream', 'content-length': String(model.length), 'access-control-allow-origin': '*' } }));
  const width = 512, height = 512, generated = removalScene(width, height);
  await mountForTest(page, { profile: 'pro' });
  // Model-dependent tests seed the same verified cache from a local fixture. Product code still performs a cache-only
  // lookup; the command-policy tests above prove that the real remote path begins only at the button click.
  await page.evaluate(async ({ url, id, sha256 }) => {
    const response = await fetch(url), cache = await caches.open('fernwork-models-v1');
    await cache.put(`https://fernwork-model-cache.invalid/${encodeURIComponent(id)}/${sha256}`, response);
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    await (await load('/src/app/genaiFeature.tsx')).checkCachedGenAiModel((window as any).__editorForTests, id);
  }, GENAI_MODELS['migan-512']);
  await page.getByTestId('widthInput').fill(String(width)); await page.getByTestId('heightInput').fill(String(height)); await page.getByTestId('createCanvas').click();
  await importThroughMenu(page, [{ name: 'generated-512.png', mimeType: 'image/png', buffer: Buffer.from(encodePng(generated, width, height, 4)) }]);
  await selectRect(page, 228, 234, 284, 278);
  await page.getByTestId('compositor-editor').press('Shift+Backspace');
  await expect(page.getByTestId('remove-apply')).toBeEnabled({ timeout: 80_000 });
  const timing = await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const module = await load('/src/app/genaiFeature.tsx');
    return module.genAiTiming((window as any).__editorForTests.session).remove;
  });
  await page.getByTestId('remove-apply').click();
  const output = await exportedPixels(page);
  let error = 0, count = 0;
  for (let y = 238; y < 274; y++) for (let x = 232; x < 280; x++) {
    const at = (y * width + x) * 4;
    const target = [35 + x % 11, 90 + y % 7, 160 + (x + y) % 13];
    for (let c = 0; c < 3; c++) { error += Math.abs(output.data[at + c]! - target[c]!); count++; }
  }
  const meanAbsoluteError = error / count;
  expect(meanAbsoluteError).toBeLessThan(70);
  expect((await manifest(page)).layers.at(-1).name).toBe('Removed');
  console.log(`MI-GAN 512 TILE ${JSON.stringify({ ...timing, meanAbsoluteError })}`);
});

test('optional local Real-ESRGAN fixture produces 2× layer pixels and reports generated-scene PSNR/SSIM vs Lanczos', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'Model inference is covered in Chromium; command/download policy runs cross-browser.');
  test.skip(!hasX2, `Real-ESRGAN x2 is not available in ${MODEL_DIR}`);
  const highWidth = 64, highHeight = 48, high = detailScene(highWidth, highHeight);
  const low = lanczosRgba(high, highWidth, highHeight, highWidth / 2, highHeight / 2);
  const model = readFileSync(`${MODEL_DIR}/RealESRGAN_x2plus.onnx`);
  await page.route('https://huggingface.co/**', (route) => route.fulfill({ status: 200, body: model,
    headers: { 'content-type': 'application/octet-stream', 'content-length': String(model.length) } }));
  await mountForTest(page, { profile: 'pro' });
  await page.getByTestId('widthInput').fill('32'); await page.getByTestId('heightInput').fill('24'); await page.getByTestId('createCanvas').click();
  await importThroughMenu(page, [{ name: 'low.png', mimeType: 'image/png', buffer: Buffer.from(encodePng(low, 32, 24, 4)) }]);
  await page.getByTestId('menu-Image').click(); await page.getByRole('menuitem', { name: 'Upscale…' }).click();
  await expect(page.getByTestId('upscale-run')).toBeEnabled(); await page.getByTestId('upscale-run').click();
  await expect(page.getByTestId('upscale-panel')).toHaveCount(0, { timeout: 80_000 });
  const actual = await page.evaluate(() => {
    const raster = (window as any).__editorForTests.session.activeLayer.raster;
    return { width: raster.width, height: raster.height, pixels: Array.from(raster.toPixels()) as number[] };
  });
  expect([actual.width, actual.height]).toEqual([64, 48]);
  const ai = Uint8Array.from(actual.pixels), baseline = lanczosRgba(low, 32, 24, 64, 48);
  const timing = await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const module = await load('/src/app/genaiFeature.tsx');
    return module.genAiTiming((window as any).__editorForTests.session).upscale;
  });
  const result = { aiPsnr: psnr(ai, high), lanczosPsnr: psnr(baseline, high), aiSsim: ssim(ai, high), lanczosSsim: ssim(baseline, high), timing };
  expect(ai).not.toEqual(baseline);
  expect(result.aiPsnr).toBeGreaterThan(10);
  console.log(`GENAI GENERATED SCENE ${JSON.stringify(result)}`);
  await context.setOffline(true);
  const cachedBytes = await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const { cachedGenAiModel } = await load('/src/core/genai/models.ts');
    return (await cachedGenAiModel((window as any).__editorForTests.capabilities.models, 'realesrgan-x2plus'))?.bytes.byteLength ?? 0;
  });
  expect(cachedBytes).toBe(GENAI_MODELS['realesrgan-x2plus'].byteLength);
});

test('optional local Real-ESRGAN x4 fixture produces exact 4× layer dimensions', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Model inference is covered in Chromium; command/download policy runs cross-browser.');
  test.skip(!hasX4, `Real-ESRGAN x4 is not available in ${MODEL_DIR}`);
  const source = detailScene(16, 12), model = readFileSync(`${MODEL_DIR}/RealESRGAN_x4plus.onnx`);
  await page.route('https://huggingface.co/**', (route) => route.fulfill({ status: 200, body: model,
    headers: { 'content-type': 'application/octet-stream', 'content-length': String(model.length) } }));
  await mountForTest(page, { profile: 'pro' });
  await page.getByTestId('widthInput').fill('16'); await page.getByTestId('heightInput').fill('12'); await page.getByTestId('createCanvas').click();
  await importThroughMenu(page, [{ name: 'small.png', mimeType: 'image/png', buffer: Buffer.from(encodePng(source, 16, 12, 4)) }]);
  await page.getByTestId('menu-Image').click(); await page.getByRole('menuitem', { name: 'Upscale…' }).click();
  await page.getByRole('radio', { name: '4×' }).click(); await expect(page.getByTestId('upscale-run')).toBeEnabled();
  await page.getByTestId('upscale-run').click(); await expect(page.getByTestId('upscale-panel')).toHaveCount(0, { timeout: 80_000 });
  const value = await page.evaluate(async () => {
    const raster = (window as any).__editorForTests.session.activeLayer.raster;
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const timing = (await load('/src/app/genaiFeature.tsx')).genAiTiming((window as any).__editorForTests.session).upscale;
    return { width: raster.width, height: raster.height, timing };
  });
  expect([value.width, value.height]).toEqual([64, 48]);
  console.log(`REALESRGAN X4 ${JSON.stringify(value.timing)}`);
});

function detailScene(width: number, height: number): Uint8Array {
  const output = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const edge = x > 7 + Math.sin(y / 4) * 3 && x < 50 && y > 8 && y < 39;
    const checker = ((x >> 2) + (y >> 2)) & 1;
    output.set(edge ? [45 + checker * 150, 160 - checker * 90, 55 + (x * 3) % 80, 255]
      : [28 + (x * 5 + y * 2) % 70, 52 + (y * 7) % 100, 120 + (x + y) % 80, 255], (y * width + x) * 4);
  }
  return output;
}

function removalScene(width: number, height: number): Uint8Array {
  const output = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const object = x >= 232 && x < 280 && y >= 238 && y < 274;
    output.set(object ? [230, 25, 20, 255] : [35 + x % 11, 90 + y % 7, 160 + (x + y) % 13, 255], (y * width + x) * 4);
  }
  return output;
}

function psnr(actual: Uint8Array, expected: Uint8Array): number {
  let squared = 0, count = 0;
  for (let i = 0; i < actual.length; i += 4) for (let c = 0; c < 3; c++) { const d = actual[i + c]! - expected[i + c]!; squared += d * d; count++; }
  return 10 * Math.log10(255 * 255 / (squared / count));
}

function ssim(actual: Uint8Array, expected: Uint8Array): number {
  const a: number[] = [], b: number[] = [];
  for (let i = 0; i < actual.length; i += 4) { a.push(actual[i]! * .2126 + actual[i + 1]! * .7152 + actual[i + 2]! * .0722); b.push(expected[i]! * .2126 + expected[i + 1]! * .7152 + expected[i + 2]! * .0722); }
  const ma = a.reduce((s, v) => s + v, 0) / a.length, mb = b.reduce((s, v) => s + v, 0) / b.length;
  let va = 0, vb = 0, covariance = 0;
  for (let i = 0; i < a.length; i++) { const da = a[i]! - ma, db = b[i]! - mb; va += da * da; vb += db * db; covariance += da * db; }
  va /= a.length - 1; vb /= b.length - 1; covariance /= a.length - 1;
  const c1 = (0.01 * 255) ** 2, c2 = (0.03 * 255) ** 2;
  return (2 * ma * mb + c1) * (2 * covariance + c2) / ((ma * ma + mb * mb + c1) * (va + vb + c2));
}
