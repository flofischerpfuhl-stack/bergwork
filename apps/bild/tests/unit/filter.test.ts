import { describe, expect, it } from 'vitest';
import { Raster } from '../../src/core/raster';
import { makeTransform } from '../../src/core/geometry';
import { addNoise, applyFilter, carryMask, lensCorrection, motionBlur } from '../../src/core/filters/apply';
import { defaultFilterSettings } from '../../src/core/filters/settings';
import { EditorSession } from '../../src/core/session';
import { applyFilterEdit, beginFilterEdit, cancelFilterEdit, documentWithPixelFilterPreview,
  setFilterViewPreviewEnabled, updateFilterEdit } from '../../src/core/filters/editing';

describe('pixel filters', () => {
  it('FilterTests.gaussianBlurSoftensAHardEdgeWithoutFadingTheBorders', () => {
    const pixels = new Uint8Array(40 * 20 * 4);
    for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) pixels.fill(255, (y * 40 + x) * 4, (y * 40 + x + 1) * 4);
    const source = Raster.fromPixels(40, 20, 4, pixels), transform = makeTransform({ x: 0, y: 0 }, { width: 40, height: 20 });
    const settings = { ...defaultFilterSettings(), radius: 3 };
    const made = applyFilter('Gaussian Blur', source, transform, settings);
    const centerY = Math.floor(made.raster.height / 2), alpha = (x: number) => made.raster.pixel(x, centerY)[3]!;
    const row = Array.from({ length: made.raster.width }, (_, x) => alpha(x));
    expect(row.some((a) => a > 20 && a < 235)).toBe(true);
    expect(Math.max(...row)).toBeGreaterThanOrEqual(250); expect(row.at(-1)).toBeLessThan(20);
  });

  it('FilterEdit carries an owned mask onto expanded bounds without stretching it', () => {
    const mask = Raster.fromPixels(2, 1, 1, [255, 0]);
    const from = makeTransform({ x: 0, y: 0 }, { width: 2, height: 1 });
    const to = makeTransform({ x: -1, y: 0 }, { width: 4, height: 1 });
    expect(Array.from(carryMask(mask, from, to, 4, 1).toPixels())).toEqual([255, 255, 0, 255]);
  });

  it('FilterTests.motionBlurStreaksAlongItsAngleCounterclockwiseFromHorizontal', () => {
    const pixels = new Uint8Array(41 * 41 * 4); pixels.fill(255, (20 * 41 + 20) * 4, (20 * 41 + 21) * 4);
    const dot = Raster.fromPixels(41, 41, 4, pixels);
    const horizontal = motionBlur(dot, 16, 0), vertical = motionBlur(dot, 16, 90), diagonal = motionBlur(dot, 16, 45);
    expect(horizontal.pixel(24, 20)[3]).toBeGreaterThan(0); expect(horizontal.pixel(20, 24)[3]).toBe(0);
    expect(vertical.pixel(20, 24)[3]).toBeGreaterThan(0); expect(vertical.pixel(24, 20)[3]).toBe(0);
    expect(diagonal.pixel(23, 17)[3]).toBeGreaterThan(0); expect(diagonal.pixel(17, 17)[3]).toBe(0);
  });

  it('FilterTests.addNoiseChangesColorButNeverAlphaAndMonochromaticKeepsGrays', () => {
    const pixels = new Uint8Array(32 * 8 * 4);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 16; x++) pixels.set([128, 128, 128, 255], (y * 32 + x) * 4);
    const source = Raster.fromPixels(32, 8, 4, pixels), settings = { ...defaultFilterSettings(), amount: 10 };
    const a = addNoise(source, settings, 7), b = addNoise(source, settings, 7); expect(a.toPixels()).toEqual(b.toPixels());
    expect(a.pixel(20, 2)).toEqual([0, 0, 0, 0]);
    const mono = addNoise(source, { ...settings, gaussian: true, monochromatic: true }, 7), p = mono.pixel(5, 2);
    expect(p[0]).toBe(p[1]); expect(p[1]).toBe(p[2]); expect(p[3]).toBe(255);
  });

  it('FilterTests.removeDistortionBendsAboutTheCenterAndOnlyPincushionOpensCorners', () => {
    const source = Raster.fromPixels(40, 30, 4, new Uint8Array(40 * 30 * 4).fill(255));
    const barrel = lensCorrection(source, 100), pincushion = lensCorrection(source, -100);
    expect(barrel.pixel(0, 0)[3]).toBe(255); expect(pincushion.pixel(0, 0)[3]).toBe(0);
    expect(pincushion.pixel(20, 15)[3]).toBe(255);
  });

  it('FilterEdit preview/cancel leaves document untouched; apply records one undo step', async () => {
    const session = new EditorSession(); session.createDocument(8, 8);
    const pixels = new Uint8Array(8 * 8 * 4).fill(255); session.insertRaster(Raster.fromPixels(8, 8, 4, pixels), 'Square');
    const original = session.activeLayer?.raster, count = session.history.undoCount;
    const edit = beginFilterEdit(session, 'Add Noise')!;
    await updateFilterEdit(session, { ...edit.settings, amount: 30 }, true);
    expect(session.activeLayer?.raster).toBe(original); expect(session.rasterOverrides.has(edit.layerId)).toBe(true);
    cancelFilterEdit(session); expect(session.activeLayer?.raster).toBe(original); expect(session.history.undoCount).toBe(count);
    const again = beginFilterEdit(session, 'Lens Correction')!;
    await updateFilterEdit(session, { ...again.settings, distortion: -100 }, false);
    expect(await applyFilterEdit(session)).toBe(true); expect(session.history.undoCount).toBe(count + 1);
  });

  it('FilterEdit publishes GPU-only preview state without replacing the document raster', async () => {
    const session = new EditorSession(); session.createDocument(8, 8);
    const raster = Raster.fromPixels(8, 8, 4, new Uint8Array(8 * 8 * 4).fill(127));
    session.insertRaster(raster, 'Square'); setFilterViewPreviewEnabled(session, true);
    const edit = beginFilterEdit(session, 'Denoise')!;
    await updateFilterEdit(session, { ...edit.settings, luminance: 42, colour: 17 }, true);
    const preview = documentWithPixelFilterPreview(session);
    const previewLayer = preview.layers.at(-1) as typeof preview.layers[number] & {
      gpuFilterPreview?: { kind: string; settings: { luminance: number; colour: number } };
    };
    expect(session.activeLayer?.raster).toBe(raster);
    expect(session.rasterOverrides.has(edit.layerId)).toBe(false);
    expect(previewLayer.gpuFilterPreview).toMatchObject({ kind: 'Denoise',
      settings: { luminance: 42, colour: 17 } });
    cancelFilterEdit(session);
    expect(documentWithPixelFilterPreview(session)).toBe(session.document);
  });
});
