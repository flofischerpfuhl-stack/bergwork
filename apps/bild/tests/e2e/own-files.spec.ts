import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { decodePng } from '../../src/io/png';

/**
 * Integrator's own check with files no lane has seen (/tmp/owntest, made with ImageMagick and system ICC profiles,
 * plus real camera HEICs from other projects on this machine). Skipped when the files are absent.
 */
const dir = '/tmp/owntest';
const cases = [
  { file: 'adobe.png', ref: 'ref-srgb.png', raw: 'raw-adobe.png', max: 3 },
  { file: 'adobe.jpg', ref: 'ref-srgb.png', raw: 'raw-adobe.png', max: 6 },
  { file: 'eci.tif', ref: 'ref-srgb.png', raw: 'raw-eci.png', max: 3 },
  { file: 'prophoto16.tif', ref: 'ref-srgb.png', raw: 'raw-prophoto16.png', max: 3 },
  { file: 'cmyk.tif', ref: 'ref-srgb.png', raw: 'raw-cmyk.png', max: 12 },
  { file: 'cmyk.jpg', ref: 'ref-srgb.png', raw: 'raw-cmyk.png', max: 14 },
  { file: 'chicken.heic', ref: 'chicken-ref8.png', raw: null, max: 4 },
  { file: 'adobe.webp', ref: 'ref-srgb.png', raw: 'raw-adobe.png', max: 3 },
  { file: 'android.webp', ref: 'android-ref.png', raw: null, max: 2 },
  { file: 'pal.gif', ref: 'pal-ref.png', raw: null, max: 1 },
  { file: 'example.avif', ref: 'avif-ref.png', raw: null, max: 4 },
];

function rgbOf(png: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  const d = decodePng(png) as unknown as { width: number; height: number; pixels?: Uint8Array; data?: Uint8Array; channels?: number };
  const pixels = (d.pixels ?? d.data)!;
  const channels = d.channels ?? pixels.length / (d.width * d.height);
  const rgba = new Uint8Array(d.width * d.height * 4);
  for (let i = 0; i < d.width * d.height; i++) {
    for (let c = 0; c < 3; c++) rgba[i * 4 + c] = pixels[i * channels + (channels >= 3 ? c : 0)]!;
    rgba[i * 4 + 3] = channels === 4 || channels === 2 ? pixels[i * channels + channels - 1]! : 255;
  }
  return { width: d.width, height: d.height, rgba };
}

/** Mean |Δ| over RGB where the reference is opaque (colour under transparency is undefined). */
const meanDiff = (a: Uint8Array, b: Uint8Array) => {
  let sum = 0, n = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (b[i + 3]! < 255) continue;
    for (let c = 0; c < 3; c++) { sum += Math.abs(a[i + c]! - b[i + c]!); n++; }
  }
  return sum / Math.max(1, n);
};

for (const item of cases) {
  test(`own file: ${item.file} imports as sRGB close to the reference`, async ({ page }) => {
    test.skip(!fs.existsSync(`${dir}/${item.file}`), 'own test files not present');
    await page.goto('/?harness=own');
    const bytes = fs.readFileSync(`${dir}/${item.file}`).toString('base64');
    const result = await page.evaluate(async ({ bytes, name }) => {
      const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
      const { mountEditor } = await load('/src/index.ts');
      const host = { heicDecoder: 'lgpl-wasm' as const, async chooseImages() { return []; }, async chooseProject() { return null; },
        async saveFile() {}, reportError() {} };
      const handle = await mountEditor(document.getElementById('root')!, { host });
      await handle.newProject({ name: 'own', width: 64, height: 64 });
      const data = Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0));
      await handle.importImage(new Blob([data]), name);
      const session = (window as any).__editorForTests.session;
      const raster = session.document.layers.at(-1).raster;
      return { width: raster.width, height: raster.height, pixels: Array.from(raster.toPixels() as Uint8Array) };
    }, { bytes, name: item.file });
    const ref = rgbOf(fs.readFileSync(`${dir}/${item.ref}`));
    expect([result.width, result.height]).toEqual([ref.width, ref.height]);
    const got = Uint8Array.from(result.pixels);
    const diff = meanDiff(got, ref.rgba);
    const raw = item.raw ? meanDiff(rgbOf(fs.readFileSync(`${dir}/${item.raw}`)).rgba, ref.rgba) : null;
    console.log(`OWN ${item.file}: mean |Δ| to reference ${diff.toFixed(2)}${raw !== null ? `, without conversion ${raw.toFixed(2)}` : ''}`);
    expect(diff).toBeLessThan(item.max);
  });
}
