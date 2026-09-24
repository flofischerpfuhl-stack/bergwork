import { expect, test, type Page } from '@playwright/test';

const ANIMATED_GIF = 'R0lGODlhBAACAPEAAP8AAAD/AP///wAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQAZAAAACH/C0ltYWdlTWFnaWNrDmdhbW1hPTAuNDU0NTQ1ACwAAAAABAACAAACBAQShgUAIfkEAGQAAAAh/wtJbWFnZU1hZ2ljaw5nYW1tYT0wLjQ1NDU0NQAsAAAAAAQAAgCAAAD/////AgOEbwUAOw==';
const ANIMATED_WEBP = 'UklGRooAAABXRUJQVlA4WAoAAAACAAAAAwAAAQAAQU5JTQYAAAAAAP//AABBTk1GLgAAAAAAAAAAAAMAAAEAAOgDAAJWUDhMFgAAAC8DQAAAD7D/8x/zHxUUAgiAgiai//FBTk1GKAAAAAAAAAAAAAMAAAEAAOgDAABWUDhMDwAAAC8DQAAABxDR//4HIqL/AQA=';

async function mount(page: Page): Promise<void> {
  await page.goto('/?harness=import-formats');
  await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const { mountEditor } = await load('/src/index.ts');
    const errors: { code: string; message: string }[] = [];
    const host = {
      async chooseImages() { return []; }, async chooseProject() { return null; }, async saveFile() {},
      reportError(error: { code: string; message: string }) { errors.push(error); },
    };
    (window as any).__errors = errors;
    (window as any).__handle = await mountEditor(document.getElementById('root')!, { host });
  });
}

async function generatedBytes(page: Page, format: 'webp' | 'avif'): Promise<string> {
  return page.evaluate(async (format) => {
    const pixels = new Uint8Array(8 * 4 * 4);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 8; x++) {
      const at = (y * 8 + x) * 4;
      pixels[at] = x < 4 ? 255 : 0; pixels[at + 1] = x < 4 ? 0 : 255;
      pixels[at + 2] = 0; pixels[at + 3] = y < 2 ? 255 : 96;
    }
    const module = await import(/* @vite-ignore */ `/src/io/${format}.ts`);
    const encoded: Uint8Array = format === 'webp'
      ? await module.encodeWebp(pixels, 8, 4, { lossless: true })
      : await module.encodeAvif(pixels, 8, 4, { quality: 1, alphaQuality: 1, speed: 10 });
    let binary = '';
    for (let i = 0; i < encoded.length; i += 0x8000) binary += String.fromCharCode(...encoded.subarray(i, i + 0x8000));
    return btoa(binary);
  }, format);
}

async function importAndSample(page: Page, bytes: string, format: 'webp' | 'avif' | 'gif') {
  return page.evaluate(async ({ bytes, format }) => {
    const binary = atob(bytes), data = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    await (window as any).__handle.importImage(new Blob([data], { type: `image/${format}` }), `generated.${format}`);
    const manifest = (window as any).__handle.getManifest();
    const blob: Blob = await (window as any).__handle.exportImage({ format: 'png' });
    const bitmap = await createImageBitmap(blob), canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    context.drawImage(bitmap, 0, 0);
    const width = bitmap.width, height = bitmap.height;
    const pixels = context.getImageData(0, 0, width, height).data;
    const at = (x: number, y: number) => Array.from(pixels.slice((y * width + x) * 4, (y * width + x) * 4 + 4));
    bitmap.close();
    return { width: manifest.width, height: manifest.height, left: at(0, 0), right: at(width - 1, 0),
      lower: at(0, height - 1), errors: (window as any).__errors };
  }, { bytes, format });
}

async function nativeSample(page: Page, bytes: string, format: 'webp' | 'avif'): Promise<number[]> {
  return page.evaluate(async ({ bytes, format }) => {
    const binary = atob(bytes), data = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([data], { type: `image/${format}` }), {
      imageOrientation: 'from-image', premultiplyAlpha: 'none', colorSpaceConversion: 'default',
    });
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext('2d', { willReadFrequently: true })!;
    context.drawImage(bitmap, 0, 0);
    const sample = Array.from(context.getImageData(0, bitmap.height - 1, 1, 1).data);
    bitmap.close(); return sample;
  }, { bytes, format });
}

test('imports a real lossless WebP with straight alpha', async ({ page }) => {
  await mount(page);
  expect(await page.evaluate(() => performance.getEntriesByType('resource').some((entry) => entry.name.includes('webp.wasm')))).toBe(false);
  const bytes = await generatedBytes(page, 'webp');
  expect(await nativeSample(page, bytes, 'webp')).toEqual([255, 0, 0, 96]);
  const result = await importAndSample(page, bytes, 'webp');
  expect(result).toMatchObject({ width: 8, height: 4, left: [255, 0, 0, 255], right: [0, 255, 0, 255],
    errors: [] });
});

// Generated from the GIF reference below with libwebp gif2webp 1.3.2.
// SHA-256: 5a5322e02b82c913c598530af81991428e240c02db6c8747e31e10fe61a5d7d9.
test('imports only the first frame of a real animated WebP', async ({ page }) => {
  await mount(page);
  const result = await importAndSample(page, ANIMATED_WEBP, 'webp');
  expect(result).toMatchObject({ width: 4, height: 2, left: [255, 0, 0, 255], right: [0, 255, 0, 255], errors: [] });
});

test('imports a real AVIF with colour and alpha', async ({ page }) => {
  await mount(page);
  expect(await page.evaluate(() => performance.getEntriesByType('resource').some((entry) => entry.name.includes('avif.wasm')))).toBe(false);
  const bytes = await generatedBytes(page, 'avif'), native = await nativeSample(page, bytes, 'avif');
  expect(native[0]).toBeGreaterThan(230); expect(native[3]).toBeCloseTo(96, -1);
  const result = await importAndSample(page, bytes, 'avif');
  expect(result.width).toBe(8); expect(result.height).toBe(4); expect(result.errors).toEqual([]);
  expect(result.left[0]).toBeGreaterThan(230); expect(result.left[1]).toBeLessThan(25);
  expect(result.right[0]).toBeLessThan(25); expect(result.right[1]).toBeGreaterThan(230);
});

// Generated with ImageMagick 6.9.12-98 from a red/green first frame and blue second frame.
// SHA-256: 64e30727edc399777dc17bd6e84e3b73eb1fd490e11104932ab8de8fcbed202b.
test('imports only the first frame of a real animated GIF', async ({ page }) => {
  await mount(page);
  const result = await importAndSample(page, ANIMATED_GIF, 'gif');
  expect(result).toMatchObject({ width: 4, height: 2, left: [255, 0, 0, 255], right: [0, 255, 0, 255], errors: [] });
});
