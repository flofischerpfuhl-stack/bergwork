import { describe, expect, it } from 'vitest';
import { makeTransform } from '../../src/core/geometry';
import { colourRangeMask } from '../../src/core/refine/colourRange';
import { documentMaskToLayer, stampDab, stampSegment } from '../../src/app/objsel/overlay';

describe('Object selection UI helpers', () => {
  it('resamples a document mask onto an offset layer grid', () => {
    const mask = new Uint8Array(8 * 8);
    for (let y = 2; y < 6; y++) for (let x = 2; x < 6; x++) mask[y * 8 + x] = 255;
    // A 4×4 layer placed at (2, 2) covers exactly the selected square.
    const layer = documentMaskToLayer(mask, 8, 8, makeTransform({ x: 2, y: 2 }, { width: 4, height: 4 }), 4, 4);
    expect(Array.from(layer)).toEqual(new Array(16).fill(255));
    const shifted = documentMaskToLayer(mask, 8, 8, makeTransform({ x: 5, y: 2 }, { width: 4, height: 4 }), 4, 4);
    expect(Array.from(shifted.slice(0, 4))).toEqual([255, 0, 0, 0]);
  });

  it('stamps round dabs that never build up past the stroke opacity', () => {
    const coverage = new Uint8Array(20 * 20);
    const rect = stampDab(coverage, 20, 20, { x: 10, y: 10 }, 8, 1, 0.5);
    expect(rect).toEqual({ x: 6, y: 6, width: 8, height: 8 });
    expect(coverage[10 * 20 + 10]).toBe(128);
    stampSegment(coverage, 20, 20, { x: 10, y: 10 }, { x: 11, y: 10 }, 8, 1, 0.5);
    expect(Math.max(...coverage)).toBe(128);
    expect(coverage[0]).toBe(0);
  });

  it('Color Range presets pick highlights and shadows by luminance', () => {
    const rgba = new Uint8Array([250, 250, 250, 255, 128, 128, 128, 255, 8, 8, 8, 255]);
    const highlights = colourRangeMask(rgba, 3, 1, { preset: 'highlights', samples: [], fuzziness: 40, localized: false });
    const shadows = colourRangeMask(rgba, 3, 1, { preset: 'shadows', samples: [], fuzziness: 40, localized: false });
    expect(Array.from(highlights)).toEqual([255, 0, 0]);
    expect(Array.from(shadows)).toEqual([0, 0, 255]);
  });
});
