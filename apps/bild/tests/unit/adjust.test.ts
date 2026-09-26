import { describe, expect, it } from 'vitest';
import { Raster } from '../../src/core/raster';
import { makeTransform } from '../../src/core/geometry';
import {
  defaultAdjustment, defaultCurves, defaultHueSaturation, defaultLevels, defaultRangeAdjustment, isValidAdjustment,
  type HueSaturationSettings,
} from '../../src/core/adjustments';
import { applyAdjustment, exposureValue } from '../../src/core/adjust/apply';
import { autoLevels, curveValue, levelValue, sampleLevels } from '../../src/core/adjust/levels';
import { beginHueTarget, dragHueTarget, hueBandWeight, hueResponse, sampleHueRange } from '../../src/core/adjust/hue';
import { adjustRaster, invertRaster, levelsHistogram } from '../../src/core/adjust/raster';
import { rectangleSelection } from '../../src/core/selectionOps';
import { EditorSession } from '../../src/core/session';
import { cpuCompositeRegion } from '../../src/render/cpuRender';
import { beginAdjustmentLayerEdit, beginLevelsEdit, finishAdjustmentLayerEdit, updateAdjustmentLayerEdit,
  updateLevelsEdit, applyLevelsEdit, documentWithPixelAdjustmentPreview } from '../../src/core/adjust/editing';

const pixel = (values: number[]) => new Float32Array(values.map((v) => v / 255));
const bytes = (values: Float32Array) => Array.from(values, (v) => Math.round(v * 255));

describe('adjustment pixel engines', () => {
  it('ImageAdjustmentTests.exposureWorksInLinearLightWithOffsetAndGamma', () => {
    expect(Math.round(exposureValue(128 / 255, { exposure: 1, offset: 0, gamma: 1 }) * 255)).toBeCloseTo(176, 0);
    expect(Math.round(exposureValue(128 / 255, { exposure: 0, offset: 0, gamma: 2 }) * 255)).toBeCloseTo(181, 0);
    expect(Math.round(exposureValue(0, { exposure: 0, offset: 0.1, gamma: 1 }) * 255)).toBeCloseTo(89, 0);
  });

  it('ImageAdjustmentTests.gradientMapColorsByBrightnessAndReverses', () => {
    const adjustment = { kind: 'Gradient Map', schemaVersion: 1, parameters: {
      shadows: { red: 1, green: 0, blue: 0 }, highlights: { red: 0, green: 0, blue: 1 }, reversed: false,
    } } as const;
    expect(bytes(applyAdjustment(adjustment, pixel([0, 0, 0, 255]), 1, 1, 0, 0))).toEqual([255, 0, 0, 255]);
    expect(bytes(applyAdjustment(adjustment, pixel([255, 255, 255, 128]), 1, 1, 0, 0))).toEqual([0, 0, 255, 128]);
    const middle = bytes(applyAdjustment(adjustment, pixel([128, 128, 128, 255]), 1, 1, 0, 0));
    expect(middle[0]).toBeCloseTo(127, 0); expect(middle[2]).toBeCloseTo(128, 0);
  });

  it('ImageAdjustmentTests.grainIsFixedInDocumentSpaceAndLeavesTransparencyAlone', () => {
    const adjustment = { kind: 'Grain', schemaVersion: 1, parameters: { amount: 60, size: 2, roughness: 40, seed: 7 } } as const;
    const whole = applyAdjustment(adjustment, new Float32Array(40 * 40 * 4).map((_, i) => i % 4 === 3 ? 1 : 128 / 255), 40, 40, 0, 0);
    const part = applyAdjustment(adjustment, new Float32Array(20 * 20 * 4).map((_, i) => i % 4 === 3 ? 1 : 128 / 255), 20, 20, 10, 10);
    for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) {
      const a = ((y + 10) * 40 + x + 10) * 4, b = (y * 20 + x) * 4;
      expect(part[b]).toBe(whole[a]);
    }
    expect(new Set(Array.from(whole.filter((_, i) => i % 4 === 0), (v) => Math.round(v * 255))).size).toBeGreaterThan(5);
  });

  it('HueSaturationTests.hueRotatesSaturationAndLightnessFollowPhotoshopRanges', () => {
    const settings = defaultHueSaturation(120);
    const result = bytes(applyAdjustment({ kind: 'Hue/Saturation', schemaVersion: 1,
      parameters: { hue: 120, saturation: 0, lightness: 0, colorize: false, settings } }, pixel([255, 0, 0, 127]), 1, 1, 0, 0));
    expect(result[0]).toBeLessThanOrEqual(2); expect(result[1]).toBeGreaterThanOrEqual(253); expect(result[2]).toBeLessThanOrEqual(2);
    expect(result[3]).toBe(127);
  });

  it('HueSaturationTests.bandWeightsRampThroughFalloffAndWrapAround', () => {
    const band = { falloffStart: 315, rangeStart: 345, rangeEnd: 15, falloffEnd: 45 };
    expect(hueBandWeight(band, 0)).toBe(1); expect(hueBandWeight(band, 330)).toBeCloseTo(0.5);
    expect(hueBandWeight(band, 30)).toBeCloseTo(0.5); expect(hueBandWeight(band, 180)).toBe(0);
  });

  it('uses the strongest overlapping Photoshop colour range instead of summing contradictory edits', () => {
    const settings = defaultHueSaturation();
    const bands = { ...settings.bands,
      Cyans: { falloffStart: 180, rangeStart: 200, rangeEnd: 240, falloffEnd: 260 },
      Blues: { falloffStart: 180, rangeStart: 200, rangeEnd: 240, falloffEnd: 260 } };
    const adjustments = { ...settings.adjustments,
      Cyans: { hue: 0, saturation: 80, lightness: 0 },
      Blues: { hue: 0, saturation: -80, lightness: 0 } };
    const response = hueResponse({ ...settings, bands, adjustments });
    expect(response[220]).toMatchObject({ shift: 0, saturation: 80, lightness: 0 });
    expect(response[180]).toMatchObject({ shift: 0, saturation: 0, lightness: 0 });
  });

  it('HueSaturationTests.eyedroppers and targeted adjustment semantics', () => {
    let settings = defaultHueSaturation(10, 0, 0, false, 'Greens');
    settings = sampleHueRange(settings, 0, 'Sample'); expect(hueBandWeight(settings.bands.Greens!, 0)).toBe(1);
    settings = sampleHueRange(settings, 240, 'Add'); expect(hueBandWeight(settings.bands.Greens!, 240)).toBe(1);
    settings = sampleHueRange(settings, 240, 'Remove'); expect(hueBandWeight(settings.bands.Greens!, 240)).toBe(0);
    const targeted = beginHueTarget(defaultHueSaturation(), 240)!; expect(targeted.drag.range).toBe('Blues');
    expect(dragHueTarget(targeted.settings, targeted.drag, 60, false).adjustments.Blues?.saturation).toBe(30);
  });
});

describe('levels, curves, selection and edit state', () => {
  it('LevelsTests.inputClippingGammaOutputInversionAndAlpha', () => {
    const levels = defaultLevels(), ranges = levels.ranges.slice(); ranges[0] = { black: 64, gamma: 1, white: 128, outputBlack: 0, outputWhite: 255 };
    expect(levelValue(64 / 255, { ...levels, ranges }, 'Red')).toBe(0);
    expect(levelValue(128 / 255, { ...levels, ranges }, 'Red')).toBe(1);
    const gammaRanges = levels.ranges.slice(); gammaRanges[0] = { black: 0, gamma: 2, white: 255, outputBlack: 0, outputWhite: 255 };
    expect(Math.round(levelValue(128 / 255, { ...levels, ranges: gammaRanges }, 'Red') * 255)).toBe(181);
  });

  it('AdjustmentLayerTests.curves use shape-preserving interpolation and channel then RGB', () => {
    const curves = defaultCurves(), channels = curves.channels.map((c) => c.slice());
    channels[1] = [{ x: 0, y: 0 }, { x: 128, y: 192 }, { x: 255, y: 255 }];
    expect(curveValue(128, { ...curves, channels }, 1)).toBe(192);
  });

  it('LevelsTests.histogramExcludesTransparencyAndWeightsSelection', () => {
    const raster = Raster.fromPixels(3, 1, 4, [255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 0, 0]);
    const transform = makeTransform({ x: 0, y: 0 }, { width: 3, height: 1 });
    const bins = levelsHistogram(raster, transform); expect(bins[1]![255]).toBe(1); expect(bins[2]![255]).toBeCloseTo(128 / 255);
    const selection = rectangleSelection({ x: 0, y: 0, width: 1, height: 1 }, { width: 3, height: 1 });
    expect(levelsHistogram(raster, transform, selection)[2]![255]).toBe(0);
  });

  it('LevelsTests.autoAlgorithmsAndEyedropperCalibration', () => {
    const bins = Array.from({ length: 4 }, () => new Float64Array(256));
    for (let c = 1; c <= 3; c++) { bins[c]![20 * c] = 100; bins[c]![200 + c * 10] = 100; }
    expect(autoLevels('Contrast', bins).ranges[0]).toMatchObject({ black: 20, white: 230 });
    const sampled = sampleLevels(defaultLevels(), [0.25, 0.4, 0.6], 'Gray');
    expect(levelValue(0.25, sampled, 'Red')).toBeCloseTo(0.5, 4);
  });

  it('PixelInvert selection changes only covered pixels and keeps alpha', () => {
    const raster = Raster.fromPixels(2, 1, 4, [10, 20, 30, 128, 40, 50, 60, 255]);
    const transform = makeTransform({ x: 0, y: 0 }, { width: 2, height: 1 });
    const selection = rectangleSelection({ x: 0, y: 0, width: 1, height: 1 }, { width: 2, height: 1 });
    expect(Array.from(invertRaster(raster, transform, selection).toPixels())).toEqual([245, 235, 225, 128, 40, 50, 60, 255]);
  });

  it('LevelsTests.preview is composited without copying the raster; commit is one exact undo step', async () => {
    const session = new EditorSession(); session.createDocument(2, 1); session.insertRaster(Raster.fromPixels(2, 1, 4, [64, 64, 64, 255, 128, 128, 128, 255]), 'Ramp');
    const count = session.history.undoCount, edit = beginLevelsEdit(session)!;
    const ranges = edit.settings.ranges.slice(); ranges[0] = { black: 0, gamma: 1, white: 255, outputBlack: 255, outputWhite: 0 };
    await updateLevelsEdit(session, { ...edit.settings, ranges }, true); expect(session.document?.layers[0]?.raster?.pixel(0, 0)[0]).toBe(64);
    expect(session.rasterOverrides.has(edit.layerId)).toBe(false);
    const preview = cpuCompositeRegion(documentWithPixelAdjustmentPreview(session), { x: 0, y: 0, width: 2, height: 1 });
    expect(Array.from(preview)).toEqual([191, 191, 191, 255, 127, 127, 127, 255]);
    expect(await applyLevelsEdit(session)).toBe(true); expect(session.history.undoCount).toBe(count + 1);
    expect(Array.from(session.activeLayer!.raster!.toPixels())).toEqual(Array.from(preview));
  });

  it('LevelsTests.compositor preview and worker commit preserve pixels outside a selection', async () => {
    const session = new EditorSession(); session.createDocument(2, 1);
    session.insertRaster(Raster.fromPixels(2, 1, 4, [64, 64, 64, 255, 128, 128, 128, 255]), 'Ramp');
    session.replaceDocument({ ...session.document!, selection: rectangleSelection({ x: 0, y: 0, width: 1, height: 1 }, session.document!) });
    const edit = beginLevelsEdit(session)!;
    const ranges = edit.settings.ranges.slice(); ranges[0] = { black: 0, gamma: 1, white: 255, outputBlack: 255, outputWhite: 0 };
    await updateLevelsEdit(session, { ...edit.settings, ranges }, true);
    const preview = cpuCompositeRegion(documentWithPixelAdjustmentPreview(session), { x: 0, y: 0, width: 2, height: 1 });
    expect(Array.from(preview)).toEqual([191, 191, 191, 255, 128, 128, 128, 255]);
    expect(await applyLevelsEdit(session)).toBe(true);
    expect(Array.from(session.activeLayer!.raster!.toPixels())).toEqual(Array.from(preview));
  });

  it('new adjustment defaults use palette colors and unique grain seeds', () => {
    const g = defaultAdjustment('Gradient Map', { red: 1, green: 0, blue: 0 }, { red: 0, green: 0, blue: 1 });
    expect(g.kind === 'Gradient Map' ? g.parameters.shadows : null).toEqual({ red: 1, green: 0, blue: 0 });
    expect(defaultRangeAdjustment()).toEqual({ hue: 0, saturation: 0, lightness: 0 });
    expect(isValidAdjustment(g)).toBe(true);
    expect(isValidAdjustment({ kind: 'Exposure', schemaVersion: 1,
      parameters: { exposure: 0, offset: 0, gamma: 0 } })).toBe(false);
  });

  it('AdjustmentEditing cancel restores original and apply is one undo step', () => {
    const session = new EditorSession(); session.createDocument(2, 1); session.addAdjustment('Exposure');
    const id = session.activeLayerId!, original = session.activeLayer!.adjustment!, count = session.history.undoCount;
    beginAdjustmentLayerEdit(session, id);
    if (original.kind !== 'Exposure') throw new Error('Expected exposure adjustment');
    const changed = { ...original, parameters: { exposure: 2, offset: 0, gamma: 1 } };
    expect(updateAdjustmentLayerEdit(session, changed)).toBe(true); expect(session.activeLayer?.adjustment).toEqual(changed);
    finishAdjustmentLayerEdit(session, false); expect(session.activeLayer?.adjustment).toEqual(original); expect(session.history.undoCount).toBe(count);
    beginAdjustmentLayerEdit(session, id); updateAdjustmentLayerEdit(session, changed); finishAdjustmentLayerEdit(session, true);
    expect(session.activeLayer?.adjustment).toEqual(changed); expect(session.history.undoCount).toBe(count + 1);
  });
});
