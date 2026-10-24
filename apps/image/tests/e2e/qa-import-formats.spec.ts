import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { compareRgba, importAndRead, mountBare, QA_DIR, qaCorpus } from './qa-helpers';

/**
 * QA: import of generated files nobody on the team has seen (tests/qa-tools/make_files.py). Each file is compared with
 * an sRGB reference computed outside the editor: dimensions, orientation (corner markers), colour and alpha.
 */
const corpus = qaCorpus();

for (const item of corpus) {
  test(`QA import ${item.file}: size, orientation, colour and alpha match the reference`, async ({ page }) => {
    await mountBare(page);
    const got = await importAndRead(page, fs.readFileSync(path.join(QA_DIR, item.file)), item.file);
    expect(got.error, `import error for ${item.file}`).toBeUndefined();
    expect([got.width, got.height]).toEqual([item.width, item.height]);
    const ref = new Uint8Array(fs.readFileSync(path.join(QA_DIR, `${item.file}.ref.bin`)));
    // Colour under (nearly) transparent pixels is undefined; associated-alpha rounding needs a little alpha to mean anything.
    const d = compareRgba(got.pixels, ref, item.alpha ? 64 : 255);
    console.log(`QA ${item.file}: format ${got.format}, mean |Δ| rgb ${d.rgb.toFixed(2)} (max ${d.maxRgb}), alpha ${d.alpha.toFixed(2)}`);
    expect(d.rgb).toBeLessThanOrEqual(item.max);
    expect(d.alpha).toBeLessThanOrEqual(item.alpha ? 1 : 0.01);
    if (item.bits === 16) expect(got.format).toBe('rgba16');
  });
}
