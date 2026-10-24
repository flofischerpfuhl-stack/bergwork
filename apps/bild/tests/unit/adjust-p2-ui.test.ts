import { describe, expect, it } from 'vitest';
import { defaultColour } from '../../src/core/adjustments';
import { defaultLiveFilter } from '../../src/core/filters/live';
import { filterSettingsOf, LIVE_FILTER_KINDS, liveFilterFrom } from '../../src/app/adjust/liveFilters';
import { autoBlackAndWhite } from '../../src/app/adjust/auto';

describe('live filter panel settings', () => {
  it('round-trips every live filter through the destructive filter panel settings', () => {
    for (const kind of LIVE_FILTER_KINDS) {
      const filter = defaultLiveFilter(kind);
      expect(liveFilterFrom(kind, filterSettingsOf(filter), filter.enabled)).toEqual(filter);
    }
  });

  it('carries panel changes and clamps them to the engine ranges', () => {
    const settings = { ...filterSettingsOf(defaultLiveFilter('unsharpMask')), amount: 250, radius: 4, threshold: 900 };
    expect(liveFilterFrom('unsharpMask', settings, false)).toEqual({ kind: 'unsharpMask', schemaVersion: 1, enabled: false, amount: 250, radius: 4, threshold: 255 });
  });
});

describe('Black & White Auto', () => {
  const pixels = (colours: [number, number, number][]) => {
    const data = new Uint8Array(colours.length * 4);
    colours.forEach((c, i) => data.set([...c, 255], i * 4));
    return data;
  };

  it('spreads the colours that occur from dark to light in luminance order and enables the conversion', () => {
    const result = autoBlackAndWhite(pixels([[255, 0, 0], [0, 255, 0], [0, 0, 255]]), defaultColour().blackAndWhite);
    expect(result.enabled).toBe(true);
    // Blues (darkest natural gray) → 20, reds → 60, greens (lightest) → 100.
    expect([result.blues, result.reds, result.greens]).toEqual([20, 60, 100]);
  });

  it('leaves gray images at luminance-matching values', () => {
    const result = autoBlackAndWhite(pixels([[128, 128, 128], [30, 30, 30]]), defaultColour().blackAndWhite);
    expect([result.reds, result.yellows, result.greens, result.cyans, result.blues, result.magentas]).toEqual([21, 93, 72, 79, 20, 28]);
  });
});
