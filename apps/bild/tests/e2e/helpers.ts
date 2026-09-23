import type { Page } from '@playwright/test';
import { encodePng } from '../../src/io/png';

/** A solid RGBA PNG made in Node, independent of the browser under test. */
export function solidPng(width: number, height: number, rgba: [number, number, number, number]): Buffer {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(rgba, i * 4);
  return Buffer.from(encodePng(data, width, height, 4));
}

/** Mounts the editor through the public API with a host that records downloads and errors. */
export async function mountForTest(page: Page, options: { locale?: 'de' | 'en' } = {}): Promise<void> {
  await page.goto('/?harness=ui');
  await page.evaluate(async (locale) => {
    document.body.style.cssText = 'margin:0;width:100vw;height:100vh;overflow:hidden';
    const root = document.getElementById('root')!;
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const { mountEditor } = await load('/src/index.ts');
    const { createBrowserHost } = await load('/src/platform/browserHost.ts');
    const base = createBrowserHost();
    const w = window as unknown as Record<string, unknown>;
    w.__saved = [];
    w.__errors = [];
    w.__handle = await mountEditor(root, {
      locale, theme: 'dark',
      host: {
        ...base,
        async saveFile(blob: Blob, name: string) { (w.__saved as unknown[]).push({ name, type: blob.type, size: blob.size, blob }); },
        reportError(error: { code: string; message: string }) { (w.__errors as unknown[]).push(error); },
      },
    });
  }, options.locale ?? 'en');
}

export async function manifest(page: Page): Promise<any> {
  return page.evaluate(() => (window as any).__handle.getManifest());
}

/** Imports files through File > Import Images… and the real file chooser. */
export async function importThroughMenu(page: Page, files: { name: string; mimeType: string; buffer: Buffer }[]): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('menu-File').click();
  await page.getByTestId('menu-import').click();
  await (await chooser).setFiles(files);
}

/** Pixels of the current export, decoded by the browser. */
export async function exportedPixels(page: Page): Promise<{ width: number; height: number; data: number[] }> {
  return page.evaluate(async () => {
    const blob: Blob = await (window as any).__handle.exportImage({ format: 'png' });
    const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const canvas = Object.assign(document.createElement('canvas'), { width: bitmap.width, height: bitmap.height });
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    context.drawImage(bitmap, 0, 0);
    return { width: bitmap.width, height: bitmap.height, data: Array.from(context.getImageData(0, 0, bitmap.width, bitmap.height).data) };
  });
}
