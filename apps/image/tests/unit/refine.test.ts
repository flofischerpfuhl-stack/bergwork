import { describe, expect, it } from 'vitest';
import { makeTransform } from '../../src/core/geometry';
import { colourRangeMask, selectColourRange } from '../../src/core/refine/colourRange';
import { applyRefineEdgeResult } from '../../src/core/refine/commands';
import { decontaminateColours, refineEdge } from '../../src/core/refine/engine';
import { quickMaskOverlay, selectionFromQuickMask } from '../../src/core/refine/quickMask';
import { Raster } from '../../src/core/raster';
import { EditorSession } from '../../src/core/session';

function syntheticHair(size = 96): { rgba: Uint8Array; truth: Uint8Array; initial: Uint8Array; hair: Uint8Array } {
  const rgba = new Uint8Array(size * size * 4), truth = new Uint8Array(size * size), initial = new Uint8Array(size * size);
  const hair = new Uint8Array(size * size), cx = size / 2, cy = size / 2;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const distance = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
    let alpha = Math.max(0, Math.min(1, 24.5 - distance));
    const strand = x >= 18 && x <= 77 && Math.abs(y - (43 + Math.sin(x * 0.45) * 3)) < 0.75;
    if (strand) alpha = Math.max(alpha, 0.9);
    const index = y * size + x; truth[index] = Math.round(alpha * 255);
    initial[index] = distance < 23 ? 255 : 0;
    hair[index] = distance > 20 && distance < 32 ? 255 : 0;
    const p = index * 4, fg = [235, 190, 75], bg = [25, 55, 125];
    rgba[p] = Math.round(bg[0]! * (1 - alpha) + fg[0]! * alpha);
    rgba[p + 1] = Math.round(bg[1]! * (1 - alpha) + fg[1]! * alpha);
    rgba[p + 2] = Math.round(bg[2]! * (1 - alpha) + fg[2]! * alpha); rgba[p + 3] = 255;
  }
  return { rgba, truth, initial, hair };
}

function mae(a: Uint8Array, b: Uint8Array): number {
  let error = 0; for (let i = 0; i < a.length; i++) error += Math.abs(a[i]! - b[i]!); return error / a.length;
}

describe('Refine Edge engine', () => {
  it('synthetic hair acceptance: guided hair-region matting reduces alpha MAE by at least 30%', () => {
    const fixture = syntheticHair();
    const result = refineEdge(fixture.rgba, 96, 96, fixture.initial, { radius: 9, smartRadius: true, hairRegion: fixture.hair });
    const before = mae(fixture.initial, fixture.truth), after = mae(result.mask, fixture.truth);
    expect(after).toBeLessThanOrEqual(before * 0.7);
  });

  it('feather, contrast and shift edge produce bounded, distinct masks', () => {
    const rgba = new Uint8Array(9 * 4).fill(128); for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
    const mask = Uint8Array.from([0, 0, 0, 255, 255, 255, 0, 0, 0]);
    const result = refineEdge(rgba, 9, 1, mask, { radius: 0, feather: 2, contrast: 40, shiftEdge: -1 });
    expect(result.mask).not.toEqual(mask);
    expect(result.mask.every((value) => value >= 0 && value <= 255)).toBe(true);
  });

  it('decontaminates translucent edge colours toward opaque foreground', () => {
    const rgba = Uint8Array.from([255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255]);
    const result = decontaminateColours(rgba, Uint8Array.from([255, 128, 0]), 3, 1, 1);
    expect(result[4]).toBeGreaterThan(0); expect(result[6]).toBeLessThan(255);
  });

  it('commits selection, layer-mask, new-layer-with-mask and new-layer outputs', () => {
    const session = new EditorSession(); session.createNewProject(2, 1);
    const raster = Raster.fromPixels(2, 1, 4, [100, 120, 140, 255, 20, 30, 40, 255]);
    const id = session.insertRaster(raster, 'source');
    session.document = { ...session.document!, layers: session.document!.layers.map((layer) => layer.id === id
      ? { ...layer, transform: makeTransform({ x: 0, y: 0 }, { width: 2, height: 1 }) } : layer) };
    const result = { mask: Uint8Array.from([255, 0]), width: 2, height: 1, decontaminatedRgba: null };
    expect(applyRefineEdgeResult(session, result, 'selection')).toBe(true);
    expect(session.selection!.mask.toPixels()).toEqual(result.mask);
    expect(applyRefineEdgeResult(session, result, 'layerMask')).toBe(true);
    session.isMaskSelected = false;
    expect(applyRefineEdgeResult(session, result, 'newLayerWithMask')).toBe(true);
    expect(session.activeLayer!.mask?.raster.toPixels()).toEqual(result.mask);
    session.isMaskSelected = false;
    expect(applyRefineEdgeResult(session, result, 'newLayer')).toBe(true);
    expect(session.activeLayer!.raster!.toPixels()[7]).toBe(0);
  });
});

describe('Quick Mask and Colour Range', () => {
  it('Quick Mask overlays unselected pixels and round-trips edited grayscale coverage', () => {
    const selection = selectionFromQuickMask(Uint8Array.from([255, 0]), 2, 1);
    const overlay = quickMaskOverlay(selection, 2, 1);
    expect(Array.from(overlay)).toEqual([255, 0, 0, 0, 255, 0, 0, 128]);
  });

  it('Colour Range selects perceptually close samples, localization, skin tones and midtones', () => {
    const rgba = Uint8Array.from([
      220, 80, 50, 255, 215, 85, 55, 255, 20, 50, 210, 255,
      205, 150, 115, 255, 128, 128, 128, 255, 250, 250, 250, 255,
    ]);
    const sampled = colourRangeMask(rgba, 3, 2, { preset: 'sampled', samples: [{ red: 220, green: 80, blue: 50 }],
      fuzziness: 40, localized: false });
    expect(sampled[0]).toBeGreaterThan(240); expect(sampled[1]).toBeGreaterThan(180); expect(sampled[2]).toBeLessThan(10);
    const skin = colourRangeMask(rgba, 3, 2, { preset: 'skinTones', samples: [], fuzziness: 100, localized: false });
    const middle = colourRangeMask(rgba, 3, 2, { preset: 'midtones', samples: [], fuzziness: 40, localized: false });
    expect(skin[3]).toBeGreaterThan(skin[2]!); expect(middle[4]).toBeGreaterThan(middle[5]!);

    const session = new EditorSession(); session.createNewProject(3, 2);
    expect(selectColourRange(session, rgba, 3, 2, { preset: 'sampled', samples: [{ red: 220, green: 80, blue: 50 }],
      fuzziness: 40, localized: true, samplePoint: { x: 0, y: 0 }, range: 1.5 })).toBe(true);
    expect(session.history.undoName).toBe('Colour Range');
  });
});
