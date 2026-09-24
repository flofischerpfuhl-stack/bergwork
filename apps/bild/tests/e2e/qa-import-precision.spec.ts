import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { compareRgba, importAndRead, mountBare, QA_DIR, qaCorpus } from './qa-helpers';

/**
 * QA: precision of the import paths. A 2048-step 16-bit ramp must keep far more than 256 levels whatever
 * colour tags the file carries (the 16-bit pipeline is pointless if the importer quantises to 8 bit first),
 * and lossless formats must keep colour exactly, also under low alpha.
 */
qaCorpus();

const distinctRed = (pixels16: Uint16Array | null, width: number) => {
  const seen = new Set<number>();
  for (let x = 0; x < width; x++) seen.add(pixels16 ? pixels16[x * 4]! : -1);
  return seen.size;
};

for (const file of ['prec_png16_plain.png', 'prec_tiff16_plain.tif']) {
  test(`QA 16-bit precision: untagged ${file} keeps more than 256 levels`, async ({ page }) => {
    await mountBare(page, { width: 2048, height: 4 });
    const got = await importAndRead(page, fs.readFileSync(path.join(QA_DIR, file)), file);
    expect(got.format).toBe('rgba16');
    const levels = distinctRed(got.pixels16, got.width);
    console.log(`QA ${file}: ${levels} distinct red levels`);
    expect(levels).toBeGreaterThan(1500);
  });
}

// Photoshop writes an sRGB iCCP into 16-bit PNGs, ImageMagick writes cHRM + gAMA, and 16-bit TIFFs usually carry ICC.
for (const file of ['prec_png16_iccp_srgb.png', 'prec_png16_chrm.png', 'prec_tiff16_icc.tif']) {
  test(`QA bug: colour-tagged 16-bit ${file} is quantised to 8 bit on import`, async ({ page }) => {
    test.fail(true, 'Known failure, owner: 16-bit lane (p2-16bit)');
    await mountBare(page, { width: 2048, height: 4 });
    const got = await importAndRead(page, fs.readFileSync(path.join(QA_DIR, file)), file);
    expect(got.error).toBeUndefined();
    expect(got.format).toBe('rgba16');
    const levels = distinctRed(got.pixels16, got.width);
    console.log(`QA ${file}: ${levels} distinct red levels`);
    expect(levels).toBeGreaterThan(1500);
  });
}

for (const file of ['prec_webp_lossless_lowalpha.webp', 'prec_png_lowalpha.png']) {
  test(`QA lossless ${file}: colour of semi-transparent pixels (alpha 1–61) survives import exactly`, async ({ page }) => {
    test.fail(file.endsWith('.webp'), 'Known failure, owner: 16-bit lane (p2-16bit)');
    await mountBare(page, { width: 256, height: 16 });
    const got = await importAndRead(page, fs.readFileSync(path.join(QA_DIR, file)), file);
    expect(got.error).toBeUndefined();
    const ref = new Uint8Array(fs.readFileSync(path.join(QA_DIR, 'prec_webp_lossless_lowalpha.webp.ref.bin')));
    const d = compareRgba(got.pixels, ref, 1);
    console.log(`QA ${file}: mean |Δ| rgb ${d.rgb.toFixed(2)} max ${d.maxRgb}, alpha ${d.alpha.toFixed(2)}`);
    expect(d.alpha).toBe(0);
    expect(d.maxRgb).toBeLessThanOrEqual(1);
  });
}
