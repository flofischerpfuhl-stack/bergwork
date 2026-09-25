import { expect, test } from '@playwright/test';

/** Phase 3 print path: actual 45.97 MP conversion and LZW TIFF encode in Chromium. */
test('46 MP exact CMYK export does not regress the previous LUT conversion', async ({ page }) => {
  test.setTimeout(600_000);
  await page.goto('/?harness=cmyk-performance');
  const result = await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const [{ bundledCmykProfile, buildCmykLut, rgbToCmykPixels, rgbToCmykPixelsExact }, { encodeTiff }] = await Promise.all([
      load('/src/core/color/cmyk.ts'), load('/src/io/tiffEncode.ts'),
    ]);
    const width = 8256, height = 5568, count = width * height;
    const pixels = (): Uint8Array => {
      const data = new Uint8Array(count * 4);
      for (let pixel = 0, at = 0; pixel < count; pixel++, at += 4) {
        data[at] = pixel & 255; data[at + 1] = (pixel >>> 7) & 255;
        data[at + 2] = (pixel >>> 15) & 255; data[at + 3] = 255;
      }
      return data;
    };
    const profile = await bundledCmykProfile('fogra39-approx');
    const lut = await buildCmykLut(profile, { intent: 'relative-colorimetric', blackPointCompensation: true,
      simulatePaperWhite: false });

    const legacyInput = pixels(), legacyStart = performance.now();
    const legacyOutput = rgbToCmykPixels(legacyInput, lut);
    const legacyConversionMs = performance.now() - legacyStart;
    const legacyProbe = legacyOutput[0]! + legacyOutput[legacyOutput.length - 1]!;

    const exactOutput = pixels(), exactStart = performance.now();
    await rgbToCmykPixelsExact(exactOutput, profile, 'relative-colorimetric', true);
    const exactConversionMs = performance.now() - exactStart;
    const encodeStart = performance.now();
    const tiff = encodeTiff(exactOutput, width, height, { alpha: false, colorModel: 'cmyk', compression: 'lzw',
      iccProfile: profile.icc });
    const encodeMs = performance.now() - encodeStart;
    return { width, height, pixels: count, legacyConversionMs, exactConversionMs, encodeMs,
      exactExportMs: exactConversionMs + encodeMs, projectedLegacyExportMs: legacyConversionMs + encodeMs,
      bytes: tiff.length, probes: [legacyProbe, tiff[0], tiff[1]] };
  });
  console.info('46 MP CMYK export (ms):', JSON.stringify(result));
  expect(result.pixels).toBe(45_969_408);
  expect(result.probes.slice(1)).toEqual([0x49, 0x49]);
  expect(result.bytes).toBeGreaterThan(1_000_000);
  expect(result.exactConversionMs).toBeLessThanOrEqual(result.legacyConversionMs * 1.2);
  expect(result.exactExportMs).toBeLessThanOrEqual(result.projectedLegacyExportMs * 1.2);
});
