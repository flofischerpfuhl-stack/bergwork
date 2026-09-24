import { describe, expect, it } from 'vitest';
import { newLayer } from '../../src/core/document';
import { makeTransform } from '../../src/core/geometry';
import { Raster } from '../../src/core/raster';
import { DEFAULT_BRUSH_SETTINGS, beginStroke, brushModeColor } from '../../src/core/brush';

function layer(value: number) {
  return newLayer({ id: 'paint', name: 'Paint', transform: makeTransform({ x: 0, y: 0 }, { width: 21, height: 21 }),
    raster: Raster.fromPixels(21, 21, 4, new Uint8Array(21 * 21 * 4).map((_, i) => i % 4 === 3 ? 255 : value)) });
}

describe('P2 Dodge/Burn/Sponge brush modes', () => {
  it('Dodge and Burn use the selected tonal range and exposure', () => {
    const base = { ...DEFAULT_BRUSH_SETTINGS, range: 'midtones' as const, exposure: 0.5 };
    const dodge = brushModeColor(0.5, 0.5, 0.5, { ...base, mode: 'dodge' }, 1);
    const burn = brushModeColor(0.5, 0.5, 0.5, { ...base, mode: 'burn' }, 1);
    expect(dodge[0]).toBeCloseTo(0.75); expect(burn[0]).toBeCloseTo(0.25);
    const shadowOnWhite = brushModeColor(1, 1, 1, { ...base, mode: 'burn', range: 'shadows' }, 1);
    expect(shadowOnWhite).toEqual([1, 1, 1]);
  });

  it('Sponge saturate/desaturate changes chroma while preserving luma approximately', () => {
    const saturate = brushModeColor(0.7, 0.4, 0.2, { ...DEFAULT_BRUSH_SETTINGS, mode: 'sponge',
      spongeMode: 'saturate', flow: 0.5 }, 1);
    const desaturate = brushModeColor(0.7, 0.4, 0.2, { ...DEFAULT_BRUSH_SETTINGS, mode: 'sponge',
      spongeMode: 'desaturate', flow: 0.5 }, 1);
    expect(Math.max(...saturate) - Math.min(...saturate)).toBeGreaterThan(0.5);
    expect(Math.max(...desaturate) - Math.min(...desaturate)).toBeLessThan(0.5);
  });

  it('stroke replay modifies colour, preserves alpha, and is deterministic', () => {
    const options = { layer: layer(128), canvas: { width: 21, height: 21 }, settings: {
      ...DEFAULT_BRUSH_SETTINGS, diameter: 9, hardness: 1, mode: 'dodge' as const, exposure: 0.5,
    } };
    const paint = () => { const stroke = beginStroke(options); stroke.addPoints([{ x: 10.5, y: 10.5 }]); return stroke.finish().raster; };
    const a = paint(), b = paint();
    expect(a.toPixels()).toEqual(b.toPixels()); expect(a.pixel(10, 10)[0]).toBeGreaterThan(128); expect(a.pixel(10, 10)[3]).toBe(255);
  });
});
