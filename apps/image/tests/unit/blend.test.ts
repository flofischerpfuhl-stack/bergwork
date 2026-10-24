import { describe, expect, it } from 'vitest';
import { blendIfFactor, blendIfRangeFactor, blendRgb, blendSeed, compositePremultiplied, dissolveNoise } from '../../src/core/blend';
import { BLEND_MODES, type BlendMode } from '../../src/core/document';

function close(actual: ArrayLike<number>, expected: readonly number[]): void {
  expect(actual).toHaveLength(expected.length);
  for (let index = 0; index < expected.length; index++) {
    expect(actual[index]!, `channel ${index}`).toBeCloseTo(expected[index]!, 6);
  }
}

describe('Photoshop-only blend formulas', () => {
  it('evaluates Blend If hard and split thresholds per source and underlying channel', () => {
    expect(blendIfRangeFactor(99 / 255, { black0: 100, black1: 100, white0: 220, white1: 220 })).toBe(0);
    expect(blendIfRangeFactor(125 / 255, { black0: 100, black1: 150, white0: 200, white1: 250 })).toBeCloseTo(0.5);
    expect(blendIfRangeFactor(225 / 255, { black0: 100, black1: 150, white0: 200, white1: 250 })).toBeCloseTo(0.5);
    const identity = { black0: 0, black1: 0, white0: 255, white1: 255 };
    const settings = { source: { gray: identity, red: identity, green: identity, blue: identity },
      destination: { gray: identity, red: { black0: 100, black1: 200, white0: 255, white1: 255 }, green: identity, blue: identity } };
    expect(blendIfFactor(settings, [1, 0, 0], [50 / 255, 0, 0])).toBe(0);
    expect(blendIfFactor(settings, [1, 0, 0], [150 / 255, 0, 0])).toBeCloseTo(0.5);
    expect(blendIfFactor(settings, [1, 0, 0], [200 / 255, 0, 0])).toBe(1);
  });
  it('lists all modes in Photoshop menu-group order', () => {
    expect(BLEND_MODES.map(({ mode }) => mode)).toEqual([
      'normal', 'dissolve',
      'darken', 'multiply', 'colorBurn', 'linearBurn', 'darkerColor',
      'lighten', 'screen', 'colorDodge', 'linearDodge', 'lighterColor',
      'overlay', 'softLight', 'hardLight', 'vividLight', 'linearLight', 'pinLight', 'hardMix',
      'difference', 'exclusion', 'subtract', 'divide',
      'hue', 'saturation', 'color', 'luminosity',
    ]);
  });

  const backdrop = [0.25, 0.6, 0.9] as const;
  const source = [0.75, 0.2, 0.4] as const;
  const cases: readonly [BlendMode, readonly number[]][] = [
    ['linearBurn', [0, 0, 0.3]],
    ['darkerColor', source],
    ['linearDodge', [1, 0.8, 1]],
    ['lighterColor', backdrop],
    ['softLight', [0.375, 0.456, 0.882]],
    ['hardLight', [0.625, 0.24, 0.72]],
    ['vividLight', [0.5, 0, 0.875]],
    ['linearLight', [0.75, 0, 0.7]],
    ['pinLight', [0.5, 0.4, 0.8]],
    ['hardMix', [0, 0, 1]],
    ['exclusion', [0.625, 0.56, 0.58]],
    ['subtract', [0, 0.4, 0.5]],
    ['divide', [1 / 3, 1, 1]],
  ];

  for (const [mode, expected] of cases) {
    it(`${mode} matches a hand-computed Photoshop formula`, () => {
      close(blendRgb(mode, backdrop, source), expected);
    });
  }

  it('dissolve turns effective alpha into a deterministic binary threshold', () => {
    const keep = new Float32Array([0.1, 0.2, 0.3, 1]);
    compositePremultiplied(keep, 0, 0.4, 0.1, 0.2, 0.5, 'dissolve', false, new Float64Array(6), 0);
    close(keep, [0.8, 0.2, 0.4, 1]);

    const drop = new Float32Array([0.1, 0.2, 0.3, 1]);
    compositePremultiplied(drop, 0, 0.4, 0.1, 0.2, 0.5, 'dissolve', false, new Float64Array(6), 254);
    close(drop, [0.1, 0.2, 0.3, 1]);
  });

  it('dissolve noise is stable and statistically balanced at 128/255 density', () => {
    const seed = blendSeed('layer');
    expect(seed).toBe(128_336_118);
    expect([dissolveNoise(0, 0, seed), dissolveNoise(1, 0, seed),
      dissolveNoise(0, 1, seed), dissolveNoise(-1, 7, seed)]).toEqual([32, 163, 188, 24]);
    let kept = 0;
    for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
      if (dissolveNoise(x, y, seed) < 128) kept++;
    }
    expect(kept).toBe(32_853);
  });

  it('divide preserves black and handles a zero blend channel', () => {
    close(blendRgb('divide', [0, 0.25, 1], [0, 0, 0.5]), [0, 1, 1]);
  });

  it('darker/lighter color compare the complete RGB color, not each channel', () => {
    close(blendRgb('darkerColor', [0.8, 0.1, 0.1], [0.4, 0.4, 0.4]), [0.8, 0.1, 0.1]);
    close(blendRgb('lighterColor', [0.8, 0.1, 0.1], [0.4, 0.4, 0.4]), [0.4, 0.4, 0.4]);
  });
});
