import { describe, expect, it } from 'vitest';
import { EDITOR_PROFILES, profileHasFeature } from '../../src/app/profiles';

describe('editor profiles (PRODUCT-PLAN sections 1, 5, 6 and A10)', () => {
  it('keeps Lite at 100 MP and Pro at 300 MP without engine forks', () => {
    expect(EDITOR_PROFILES.lite.documentLimits).toEqual({ maximumPixels: 100_000_000, maximumSide: 30_000 });
    expect(EDITOR_PROFILES.pro.documentLimits).toEqual({ maximumPixels: 300_000_000, maximumSide: 60_000 });
    expect(EDITOR_PROFILES.pro.modules).toEqual(EDITOR_PROFILES.lite.modules);
  });

  it('keeps PLQ background-removal models in Lite and excludes Pro-only features', () => {
    expect(EDITOR_PROFILES.lite.aiModels).toEqual(['fast', 'best']);
    expect(EDITOR_PROFILES.pro.aiModels).toEqual(['fast', 'best']);
    expect(profileHasFeature(EDITOR_PROFILES.lite, 'raw', { codecs: { version: 1 } })).toBe(false);
  });

  it('gates host-dependent Pro features by capability version', () => {
    expect(profileHasFeature(EDITOR_PROFILES.pro, 'raw')).toBe(false);
    expect(profileHasFeature(EDITOR_PROFILES.pro, 'raw', { codecs: { version: 1 } })).toBe(true);
  });
});
