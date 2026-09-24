import { describe, expect, it } from 'vitest';
import { defaultAdjustment, defaultLevelRange } from '../../src/core/adjustments';
import { applyAdjustment } from '../../src/core/adjust/apply';
import { compositeRegionFloat } from '../../src/core/composite';
import { newLayer, type CanvasDocument, type LayerAdjustment } from '../../src/core/document';
import { makeTransform } from '../../src/core/geometry';
import { Raster } from '../../src/core/raster';
import { SoftwareCompositor } from '../../src/render/softwareCompositor';

const WIDTH = 4096;

export function bandingDocument(bits: 8 | 16): CanvasDocument {
  const maximum = bits === 16 ? 65535 : 255;
  const pixels = bits === 16 ? new Uint16Array(WIDTH * 4) : new Uint8Array(WIDTH * 4);
  for (let x = 0; x < WIDTH; x++) {
    const value = Math.round(x / (WIDTH - 1) * maximum), offset = x * 4;
    pixels[offset] = value; pixels[offset + 1] = value; pixels[offset + 2] = value; pixels[offset + 3] = maximum;
  }
  const transform = makeTransform({ x: 0, y: 0 }, { width: WIDTH, height: 1 }, { sampling: 'Nearest' });
  const base = newLayer({ id: 'gradient', name: 'gradient', transform,
    raster: Raster.fromPixels(WIDTH, 1, 4, pixels, { format: bits === 16 ? 'rgba16' : 'rgba8' }) });
  const levelsBase = defaultAdjustment('Levels', { red: 0, green: 0, blue: 0 }, { red: 1, green: 1, blue: 1 });
  const levels: LayerAdjustment = { ...levelsBase, levels: { channel: 'RGB', ranges: [
    { ...defaultLevelRange(), black: 24, gamma: 0.58, white: 238 },
    defaultLevelRange(), defaultLevelRange(), defaultLevelRange(),
  ] } };
  const curvesBase = defaultAdjustment('Curves', { red: 0, green: 0, blue: 0 }, { red: 1, green: 1, blue: 1 });
  const points = [{ x: 0, y: 0 }, { x: 48, y: 6 }, { x: 112, y: 44 },
    { x: 176, y: 224 }, { x: 224, y: 250 }, { x: 255, y: 255 }];
  const identity = [{ x: 0, y: 0 }, { x: 255, y: 255 }];
  const curves: LayerAdjustment = { ...curvesBase, curves: { channel: 'RGB', channels: [points, identity, identity, identity] } };
  return { id: `banding-${bits}`, width: WIDTH, height: 1, resolution: 72, selection: null, layers: [base,
    newLayer({ id: 'levels', name: 'levels', transform, adjustment: levels }),
    newLayer({ id: 'curves', name: 'curves', transform, adjustment: curves }),
  ] };
}

export interface BandingMetrics { distinct: number; maxStep: number; zeroSteps: number }

export function bandingMetrics(rgba: ArrayLike<number>): BandingMetrics {
  const levels = new Set<number>();
  let maxStep = 0, zeroSteps = 0, previous = -1;
  for (let x = 0; x < WIDTH; x++) {
    const value = rgba[x * 4]!;
    levels.add(Math.round(value * 65535));
    if (x > 0) {
      const step = Math.abs(value - previous);
      if (step === 0) zeroSteps++;
      if (step > maxStep) maxStep = step;
    }
    previous = value;
  }
  return { distinct: levels.size, maxStep, zeroSteps };
}

describe('A3 float CPU pipeline banding acceptance', () => {
  it('keeps a 16-bit gradient smooth through strong Curves and Levels where RGBA8 bands', async () => {
    const canvas = { width: 0, height: 0, getContext: () => ({}) } as unknown as OffscreenCanvas;
    const software = await SoftwareCompositor.create(canvas);
    software.adjustmentPrograms = applyAdjustment;
    const render = (bits: 8 | 16) => software.readRegionFloat(bandingDocument(bits), 0, 0, WIDTH, 1);
    const eight = bandingMetrics(render(8)), sixteen = bandingMetrics(render(16));
    console.info('CPU banding', { rgba8: eight, rgba16: sixteen });
    expect(eight.distinct).toBeLessThanOrEqual(256);
    expect(eight.zeroSteps).toBeGreaterThan(3000);
    expect(sixteen.distinct).toBeGreaterThan(1500);
    expect(sixteen.zeroSteps).toBeLessThan(eight.zeroSteps / 3);
    expect(sixteen.maxStep).toBeLessThanOrEqual(1 / 255 + 1e-6);
    // The direct CPU reference is the same float pipeline used by the software renderer.
    expect(render(16)).toEqual(compositeRegionFloat(bandingDocument(16),
      { x: 0, y: 0, width: WIDTH, height: 1 }, { adjust: applyAdjustment }).rgba);
  });
});
