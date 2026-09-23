import { describe, expect, it } from 'vitest';
import { applyAdjustment } from '../../src/core/adjust/apply';
import {
  beginAdjustmentLayerEdit, finishAdjustmentLayerEdit, updateAdjustmentLayerEdit,
} from '../../src/core/adjust/editing';
import { adjustRaster } from '../../src/core/adjust/raster';
import { histogramDisplayScale, levelValue } from '../../src/core/adjust/levels';
import {
  defaultAdjustment, defaultHueSaturation, defaultLevels, isValidAdjustment, resolveAdjustment,
  type HueSaturationSettings,
} from '../../src/core/adjustments';
import { flattenDocument } from '../../src/core/composite';
import type { AdjustmentKind, LayerAdjustment } from '../../src/core/document';
import { makeTransform } from '../../src/core/geometry';
import { Raster } from '../../src/core/raster';
import { applySelection } from '../../src/core/selectionCommands';
import { rectangleSelection } from '../../src/core/selectionOps';
import { EditorSession } from '../../src/core/session';

function pixels(values: readonly number[]): Float32Array {
  return Float32Array.from(values, (value) => value / 255);
}

function bytes(values: Float32Array): number[] {
  return Array.from(values, (value) => Math.round(value * 255));
}

function solid(width: number, height: number, rgba: readonly [number, number, number, number]): Raster {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(rgba, i * 4);
  return Raster.fromPixels(width, height, 4, data);
}

function render(session: EditorSession): Raster {
  return flattenDocument(session.document!, { adjust: applyAdjustment });
}

describe('upstream ImageAdjustmentTests', () => {
  it('settingsSaveAndOlderAdjustmentsStillOpen', () => {
    const levels = defaultAdjustment('Levels', { red: 0, green: 0, blue: 0 }, { red: 1, green: 1, blue: 1 });
    const json = JSON.stringify(levels);
    expect(json).not.toContain('exposureSettings');
    expect(json).not.toContain('gradientMapSettings');
    expect(json).not.toContain('grainSettings');
    expect(JSON.parse(json)).toEqual(levels);
    const grain: LayerAdjustment = { ...defaultAdjustment('Grain', { red: 0, green: 0, blue: 0 }, { red: 1, green: 1, blue: 1 }),
      grainSettings: { amount: 40, size: 3, roughness: 10, seed: 9 } };
    expect(isValidAdjustment(JSON.parse(JSON.stringify(grain)) as LayerAdjustment)).toBe(true);
    expect(isValidAdjustment({ kind: 'Exposure', exposureSettings: { exposure: 0, offset: 0, gamma: 0 } })).toBe(false);
  });

  it('newAdjustmentLayersStartFromThePaletteRenderAndEditInThePanel (engine state)', () => {
    const session = new EditorSession(); session.createDocument(20, 20);
    session.insertRaster(solid(20, 20, [128, 128, 128, 255]), 'Gray');
    session.setPaletteColor({ red: 1, green: 0, blue: 0 }, false);
    session.setPaletteColor({ red: 0, green: 0, blue: 1 }, true);
    session.addAdjustment('Gradient Map');
    const id = session.activeLayerId!, adjustment = session.activeLayer!.adjustment!;
    expect(adjustment).toMatchObject({ kind: 'Gradient Map', gradientMapSettings: {
      shadows: { red: 1, green: 0, blue: 0 }, highlights: { red: 0, green: 0, blue: 1 },
    } });
    expect(session.adjustmentEditingId).toBe(id);
    const rendered = render(session);
    const middle = rendered.pixel(10, 10);
    expect(middle[0]).toBeGreaterThan(100); expect(middle[2]).toBeGreaterThan(100); expect(middle[1]).toBeLessThan(20);
    session.adjustmentEditingId = null;
    session.addAdjustment('Grain'); const first = resolveAdjustment(session.activeLayer!.adjustment!).grainSettings.seed;
    session.adjustmentEditingId = null;
    session.addAdjustment('Grain'); const second = resolveAdjustment(session.activeLayer!.adjustment!).grainSettings.seed;
    expect(second).not.toBe(first);
  });
});

describe('upstream AdjustmentLayerTests', () => {
  it('clippedCurveChangesOnlyItsBaseAndCopyMergedMatchesExport', () => {
    const session = new EditorSession(); session.createDocument(2, 2);
    session.insertRaster(solid(2, 2, [0, 0, 255, 255]), 'Blue');
    const green = Raster.fromPixels(2, 2, 4, Uint8Array.from([
      0, 255, 0, 255, 0, 255, 0, 0, 0, 255, 0, 128, 0, 255, 0, 0,
    ]));
    session.insertRaster(green, 'Green');
    session.addAdjustment('Curves'); const adjustment = session.activeLayerId!; session.adjustmentEditingId = null;
    const value = defaultAdjustment('Curves', session.foregroundColor, session.backgroundColor);
    const curves = resolveAdjustment(value).curves, channels = curves.channels.map((channel) => channel.slice());
    channels[0] = [{ x: 0, y: 255 }, { x: 255, y: 0 }];
    session.updateAdjustment(adjustment, { ...value, curves: { ...curves, channels } });
    session.toggleClippingMask(adjustment);
    const clipped = render(session);
    expect(clipped.pixel(0, 0)).toEqual([255, 0, 255, 255]);
    expect(clipped.pixel(1, 0)).toEqual([0, 0, 255, 255]);
    session.toggleClippingMask(adjustment);
    expect(render(session).pixel(1, 0)).toEqual([255, 255, 0, 255]);
  });

  it('hueOpacityAndMaskPreserveOriginalPixels', () => {
    const session = new EditorSession(); session.createDocument(2, 2);
    const original = solid(2, 2, [255, 0, 0, 255]);
    session.insertRaster(original, 'Red'); session.addAdjustment('Hue/Saturation');
    const id = session.activeLayerId!; session.adjustmentEditingId = null;
    session.updateAdjustment(id, { kind: 'Hue/Saturation', hue: 120, saturation: 0, lightness: 0, colorize: false });
    expect(render(session).pixel(0, 0)).toEqual([0, 255, 0, 255]);
    session.setLayerOpacity(0);
    expect(render(session).pixel(0, 0)).toEqual([255, 0, 0, 255]);
    session.setLayerOpacity(1); session.addLayerMask(false);
    expect(render(session).pixel(0, 0)).toEqual([255, 0, 0, 255]);
    expect(session.document!.layers[0]!.raster).toBe(original);
  });

  it('adjustmentPersistsDuplicatesAndUndoRestoresSettings', () => {
    const session = new EditorSession(); session.createDocument(2, 2); session.insertRaster(solid(2, 2, [255, 255, 255, 255]), 'White');
    session.addAdjustment('Curves'); session.adjustmentEditingId = null;
    const id = session.activeLayerId!, original = session.activeLayer!.adjustment!;
    const resolved = resolveAdjustment(original), channels = resolved.curves.channels.map((channel) => channel.slice());
    channels[0] = [{ x: 0, y: 0 }, { x: 128, y: 190 }, { x: 255, y: 255 }];
    const changed = { ...original, curves: { ...resolved.curves, channels } };
    session.beginEdit('Edit Curves'); session.updateAdjustment(id, changed); session.endEdit();
    session.undo(); expect(session.activeLayer!.adjustment).toEqual(original);
    session.redo(); expect(session.activeLayer!.adjustment).toEqual(changed);
    session.duplicateActiveLayer();
    expect(session.activeLayer!.adjustment).toEqual(changed);
  });

  it('adjustmentBlendAndSoftMaskPreserveCoverage', () => {
    const session = new EditorSession(); session.createDocument(2, 2);
    const alpha = Raster.fromPixels(2, 2, 4, Uint8Array.from([
      255, 0, 0, 255, 255, 0, 0, 128, 255, 0, 0, 32, 0, 0, 0, 0,
    ]));
    session.insertRaster(alpha, 'Red'); session.addAdjustment('Hue/Saturation');
    const id = session.activeLayerId!; session.adjustmentEditingId = null;
    session.updateAdjustment(id, { kind: 'Hue/Saturation', hue: 120, saturation: 0, lightness: 0, colorize: false });
    session.setLayerBlendMode('multiply');
    expect(render(session).toPixels()).toEqual(Uint8Array.from([
      0, 0, 0, 255, 0, 0, 0, 128, 0, 0, 0, 32, 0, 0, 0, 0,
    ]));
    session.setLayerBlendMode('normal');
    session.replaceDocument({ ...session.document!, layers: session.document!.layers.map((layer) => layer.id === id ? {
      ...layer, mask: { raster: Raster.fromPixels(1, 1, 1, [128]), enabled: true, linked: true, placement: null },
    } : layer) });
    const out = render(session).toPixels();
    expect([out[3], out[7], out[11], out[15]]).toEqual([255, 128, 32, 0]);
    expect(out[0]).toBeCloseTo(127, 0); expect(out[1]).toBeCloseTo(128, 0);
  });

  it.each(['Hue/Saturation', 'Levels', 'Curves', 'Exposure', 'Gradient Map', 'Grain'] as const)(
    'sharedEditorsKeepPixelsDynamicAndSupportCancel: %s', (kind: AdjustmentKind) => {
      const session = new EditorSession(); session.createDocument(2, 2); session.insertRaster(solid(2, 2, [255, 255, 255, 255]), 'White');
      session.addAdjustment(kind); const id = session.activeLayerId!, created = session.activeLayer!.adjustment!;
      session.adjustmentEditingId = null;
      const state = beginAdjustmentLayerEdit(session, id)!;
      const changed = kind === 'Exposure' ? { ...created, exposureSettings: { exposure: 1, offset: 0, gamma: 1 } }
        : { ...created, hue: 30 };
      expect(updateAdjustmentLayerEdit(session, changed)).toBe(true);
      expect(session.layer(id)!.adjustment).toEqual(changed);
      expect(finishAdjustmentLayerEdit(session, false)).toBe(true);
      expect(session.layer(id)!.adjustment).toEqual(created);
      expect(state.original).toBe(created);
    },
  );

  it('legacyHSVStillDecodesAndRenders', () => {
    const legacy: LayerAdjustment = { kind: 'Hue/Saturation', hue: 120, saturation: 0, lightness: 0, colorize: false };
    const decoded = JSON.parse(JSON.stringify(legacy)) as LayerAdjustment;
    expect(decoded.hsvSettings).toBeUndefined();
    expect(resolveAdjustment(decoded).hsvSettings.adjustments.Master!.hue).toBe(120);
    expect(bytes(applyAdjustment(decoded, pixels([255, 0, 0, 255]), 1, 1, 0, 0))).toEqual([0, 255, 0, 255]);
  });
});

describe('upstream HueSaturationTests and LevelsTests', () => {
  it('defaultsAreAnExactNoOp', () => {
    const source = Raster.fromPixels(4, 1, 4, Uint8Array.from([
      255, 0, 0, 255, 128, 128, 128, 255, 0, 0, 255, 128, 0, 0, 0, 0,
    ]));
    const adjusted = adjustRaster(source, makeTransform({ x: 0, y: 0 }, { width: 4, height: 1 }),
      { kind: 'Hue/Saturation', hsvSettings: defaultHueSaturation() });
    expect(adjusted.toPixels()).toEqual(source.toPixels());
  });

  it('colorizeGivesEverythingOneHueAndKeepsAlpha', () => {
    const settings = defaultHueSaturation(210, 80, 0, true);
    const result = bytes(applyAdjustment({ kind: 'Hue/Saturation', hsvSettings: settings },
      pixels([255, 0, 0, 255, 128, 128, 128, 128]), 2, 1, 0, 0));
    expect(result[2]).toBeGreaterThan(result[0]!); expect(result[2]).toBeGreaterThan(result[1]!);
    expect(result[6]).toBeGreaterThan(result[4]!); expect(result[7]).toBe(128);
  });

  it('adjustmentStaysInsideTheSelectionAndIsOneUndoStep (pixel engine)', () => {
    const session = new EditorSession(); session.createDocument(4, 1);
    session.insertRaster(solid(4, 1, [255, 0, 0, 255]), 'Red');
    applySelection(session, rectangleSelection({ x: 0, y: 0, width: 2, height: 1 }, session.document!), 'New', 'Select');
    const before = session.activeLayer!.raster!, count = session.history.undoCount;
    const result = adjustRaster(before, session.activeLayer!.transform,
      { kind: 'Hue/Saturation', hsvSettings: defaultHueSaturation(120) }, session.selection);
    session.replaceLayerPixels(session.activeLayerId!, result, 'Hue/Saturation');
    expect(session.activeLayer!.raster!.pixel(0, 0)).toEqual([0, 255, 0, 255]);
    expect(session.activeLayer!.raster!.pixel(3, 0)).toEqual([255, 0, 0, 255]);
    expect(session.history.undoCount).toBe(count + 1);
    session.undo(); expect(session.activeLayer!.raster).toBe(before);
  });

  it('colorRangesAdjustIndependently and rangesLeaveOtherHuesAloneAndInvertFlipsTheBand', () => {
    let settings = defaultHueSaturation(60, 0, 0, false, 'Reds');
    settings = { ...settings, adjustments: { ...settings.adjustments, Blues: { hue: 0, saturation: -100, lightness: 0 } } };
    let result = bytes(applyAdjustment({ kind: 'Hue/Saturation', hsvSettings: settings }, pixels([255, 0, 0, 255, 0, 0, 255, 255]), 2, 1, 0, 0));
    expect(result.slice(0, 4)).toEqual([255, 255, 0, 255]);
    expect(result[4]).toBe(result[5]); expect(result[5]).toBe(result[6]);
    settings = defaultHueSaturation(0, 0, -100, false, 'Reds');
    result = bytes(applyAdjustment({ kind: 'Hue/Saturation', hsvSettings: settings }, pixels([255, 0, 0, 255, 0, 0, 255, 255]), 2, 1, 0, 0));
    expect(result.slice(0, 4)).toEqual([0, 0, 0, 255]); expect(result.slice(4)).toEqual([0, 0, 255, 255]);
    const inverted: HueSaturationSettings = { ...settings, invertRange: true };
    result = bytes(applyAdjustment({ kind: 'Hue/Saturation', hsvSettings: inverted }, pixels([255, 0, 0, 255, 0, 0, 255, 255]), 2, 1, 0, 0));
    expect(result.slice(0, 4)).toEqual([255, 0, 0, 255]); expect(result.slice(4)).toEqual([0, 0, 0, 255]);
  });

  it('identityAndChannelSelectionAreExactNoOps', () => {
    const settings = { ...defaultLevels(), channel: 'Blue' as const };
    const source = pixels([0, 0, 0, 255, 64, 32, 0, 128, 0, 0, 0, 0]);
    expect(bytes(applyAdjustment({ kind: 'Levels', levels: settings }, source, 3, 1, 0, 0))).toEqual(bytes(source));
  });

  it('channelsCoexistAndUseDocumentedOrder', () => {
    const base = defaultLevels(), ranges = base.ranges.slice();
    ranges[1] = { black: 0, gamma: 2, white: 255, outputBlack: 0, outputWhite: 255 };
    ranges[0] = { black: 40, gamma: 1, white: 210, outputBlack: 0, outputWhite: 255 };
    const settings = { ...base, ranges };
    const result = bytes(applyAdjustment({ kind: 'Levels', levels: settings }, pixels([64, 64, 64, 255]), 1, 1, 0, 0));
    const expectedRed = Math.round(levelValue(64 / 255, settings, 'Red') * 255);
    expect(result[0]).toBe(expectedRed); expect(result[0]).toBeGreaterThan(result[1]!); expect(result[1]).toBe(result[2]);
  });

  it('histogramDisplayKeepsDistributionVisibleBesideClippingSpikes', () => {
    const bins = new Array<number>(256).fill(100); bins[255] = 100_000;
    expect(histogramDisplayScale(bins)).toBe(400);
    bins[0] = 200_000; expect(histogramDisplayScale(bins)).toBe(400);
    bins[128] = 500_000; expect(histogramDisplayScale(bins)).toBe(400);
    expect(bins[128]).toBe(500_000);
    expect(histogramDisplayScale(new Array<number>(256).fill(100))).toBe(100);
  });
});
