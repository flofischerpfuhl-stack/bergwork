import type { EncodeSpec } from './exportEncode';

/** From this size on, a default PNG export uses fast deflate (level 1): the 46 MP export stays interactive, at ~17 % larger files. */
export const FAST_PNG_PIXELS = 20_000_000;

/** The deflate level for a PNG of this size: an explicit level is honoured; the default is 6, or 1 for very large images. */
export function pngLevel(spec: Pick<EncodeSpec, 'level' | 'fastLargePng'>, width: number, height: number): EncodeSpec['level'] {
  return spec.fastLargePng && width * height >= FAST_PNG_PIXELS ? 1 : spec.level;
}
