/**
 * Codable adjustment records. Ported from Document/LayerAdjustment.swift,
 * ImageAdjustments.swift, Levels.swift, Curves.swift and HueSaturation.swift.
 */

import type { AdjustmentKind, LayerAdjustment } from './document';

export interface RGB { readonly red: number; readonly green: number; readonly blue: number }
export type LevelsChannel = 'RGB' | 'Red' | 'Green' | 'Blue';
export type ColorRange = 'Master' | 'Reds' | 'Yellows' | 'Greens' | 'Cyans' | 'Blues' | 'Magentas';

export interface RangeAdjustment { readonly hue: number; readonly saturation: number; readonly lightness: number }
export interface HueBand {
  readonly falloffStart: number; readonly rangeStart: number; readonly rangeEnd: number; readonly falloffEnd: number;
}
export interface HueSaturationSettings {
  readonly range: ColorRange;
  readonly colorize: boolean;
  readonly invertRange: boolean;
  readonly adjustments: Partial<Record<ColorRange, RangeAdjustment>>;
  readonly bands: Partial<Record<ColorRange, HueBand>>;
}
export interface LevelRange {
  readonly black: number; readonly gamma: number; readonly white: number;
  readonly outputBlack: number; readonly outputWhite: number;
}
export interface LevelsSettings { readonly channel: LevelsChannel; readonly ranges: readonly LevelRange[] }
export interface CurvePoint { readonly x: number; readonly y: number }
export interface CurvesSettings { readonly channel: LevelsChannel; readonly channels: readonly (readonly CurvePoint[])[] }
export interface ExposureSettings { readonly exposure: number; readonly offset: number; readonly gamma: number }
export interface GradientMapSettings { readonly shadows: RGB; readonly highlights: RGB; readonly reversed: boolean }
export interface GrainSettings { readonly amount: number; readonly size: number; readonly roughness: number; readonly seed: number }

/** Fully resolved in-memory view of the optional Codable fields in `LayerAdjustment`. */
export interface ResolvedAdjustment {
  readonly kind: AdjustmentKind;
  readonly hue: number; readonly saturation: number; readonly lightness: number; readonly colorize: boolean;
  readonly hsvSettings: HueSaturationSettings;
  readonly levels: LevelsSettings;
  readonly curves: CurvesSettings;
  readonly exposureSettings: ExposureSettings;
  readonly gradientMapSettings: GradientMapSettings;
  readonly grainSettings: GrainSettings;
}

export const COLOR_RANGES: readonly ColorRange[] = ['Master', 'Reds', 'Yellows', 'Greens', 'Cyans', 'Blues', 'Magentas'];
export const LEVELS_CHANNELS: readonly LevelsChannel[] = ['RGB', 'Red', 'Green', 'Blue'];

export const DEFAULT_BANDS: Readonly<Record<ColorRange, HueBand>> = {
  Master: { falloffStart: 0, rangeStart: 0, rangeEnd: 360, falloffEnd: 360 },
  Reds: { falloffStart: 315, rangeStart: 345, rangeEnd: 15, falloffEnd: 45 },
  Yellows: { falloffStart: 15, rangeStart: 45, rangeEnd: 75, falloffEnd: 105 },
  Greens: { falloffStart: 75, rangeStart: 105, rangeEnd: 135, falloffEnd: 165 },
  Cyans: { falloffStart: 135, rangeStart: 165, rangeEnd: 195, falloffEnd: 225 },
  Blues: { falloffStart: 195, rangeStart: 225, rangeEnd: 255, falloffEnd: 285 },
  Magentas: { falloffStart: 255, rangeStart: 285, rangeEnd: 315, falloffEnd: 345 },
};

export function defaultRangeAdjustment(): RangeAdjustment { return { hue: 0, saturation: 0, lightness: 0 }; }
export function defaultHueSaturation(hue = 0, saturation = 0, lightness = 0, colorize = false,
  range: ColorRange = 'Master'): HueSaturationSettings {
  return { range, colorize, invertRange: false,
    adjustments: { [range]: { hue, saturation, lightness } }, bands: { ...DEFAULT_BANDS } };
}
export const COLORIZE_START: HueSaturationSettings = defaultHueSaturation(0, 25, 0, true);
export function defaultLevelRange(): LevelRange {
  return { black: 0, gamma: 1, white: 255, outputBlack: 0, outputWhite: 255 };
}
export function defaultLevels(): LevelsSettings {
  return { channel: 'RGB', ranges: Array.from({ length: 4 }, defaultLevelRange) };
}
export function defaultCurves(): CurvesSettings {
  return { channel: 'RGB', channels: Array.from({ length: 4 }, () => [{ x: 0, y: 0 }, { x: 255, y: 255 }]) };
}
export function defaultExposure(): ExposureSettings { return { exposure: 0, offset: 0, gamma: 1 }; }
export function defaultGradientMap(shadows: RGB = { red: 0, green: 0, blue: 0 },
  highlights: RGB = { red: 1, green: 1, blue: 1 }): GradientMapSettings {
  return { shadows: { ...shadows }, highlights: { ...highlights }, reversed: false };
}
export function defaultGrain(seed = 0): GrainSettings { return { amount: 25, size: 1.5, roughness: 50, seed: seed >>> 0 }; }

/** Optional new fields are deliberately omitted, matching old project JSON exactly. */
export function defaultAdjustment(kind: AdjustmentKind, foreground: RGB, background: RGB): LayerAdjustment {
  const base: Record<string, unknown> = {
    kind, hue: 0, saturation: 0, lightness: 0, colorize: false,
    levels: defaultLevels(), curves: defaultCurves(),
  };
  if (kind === 'Gradient Map') base.gradientMapSettings = defaultGradientMap(foreground, background);
  if (kind === 'Grain') base.grainSettings = defaultGrain(Math.floor(Math.random() * 0x1_0000_0000));
  return base as LayerAdjustment;
}

function record(value: LayerAdjustment): Record<string, unknown> { return value as Record<string, unknown>; }
function setting<T>(r: Record<string, unknown>, key: string, fallback: T): T {
  return r[key] && typeof r[key] === 'object' ? r[key] as T : fallback;
}

export function resolveAdjustment(value: LayerAdjustment): ResolvedAdjustment {
  const r = record(value);
  const hue = typeof r.hue === 'number' ? r.hue : 0;
  const saturation = typeof r.saturation === 'number' ? r.saturation : 0;
  const lightness = typeof r.lightness === 'number' ? r.lightness : 0;
  const colorize = typeof r.colorize === 'boolean' ? r.colorize : false;
  return {
    kind: value.kind, hue, saturation, lightness, colorize,
    hsvSettings: setting(r, 'hsvSettings', defaultHueSaturation(hue, saturation, lightness, colorize)),
    levels: setting(r, 'levels', defaultLevels()), curves: setting(r, 'curves', defaultCurves()),
    exposureSettings: setting(r, 'exposureSettings', defaultExposure()),
    gradientMapSettings: setting(r, 'gradientMapSettings', defaultGradientMap()),
    grainSettings: setting(r, 'grainSettings', defaultGrain()),
  };
}

function finiteRange(n: number, lo: number, hi: number): boolean { return Number.isFinite(n) && n >= lo && n <= hi; }
export function normalizeLevelRange(value: LevelRange): LevelRange {
  const finite = (n: number, fallback: number): number => Number.isFinite(n) ? n : fallback;
  const black = Math.min(254, Math.max(0, finite(value.black, 0)));
  return { black, white: Math.min(255, Math.max(black + 1, finite(value.white, 255))),
    gamma: Math.min(9.99, Math.max(0.1, finite(value.gamma, 1))),
    outputBlack: Math.min(255, Math.max(0, finite(value.outputBlack, 0))),
    outputWhite: Math.min(255, Math.max(0, finite(value.outputWhite, 255))) };
}
export function isValidCurves(value: CurvesSettings): boolean {
  return LEVELS_CHANNELS.includes(value.channel) && value.channels.length === 4 && value.channels.every((points) =>
    points.length >= 2 && points.length <= 32 && points[0]?.x === 0 && points.at(-1)?.x === 255
    && points.every((p) => finiteRange(p.x, 0, 255) && finiteRange(p.y, 0, 255))
    && points.slice(1).every((p, i) => points[i]!.x < p.x));
}

/** `LayerAdjustment.isValid`; malformed imported project values are rejected, not silently clamped. */
export function isValidAdjustment(value: LayerAdjustment): boolean {
  if (!['Hue/Saturation', 'Levels', 'Curves', 'Exposure', 'Gradient Map', 'Grain'].includes(value.kind)) return false;
  const a = resolveAdjustment(value), h = a.hsvSettings;
  const hsv = COLOR_RANGES.includes(h.range) && typeof h.colorize === 'boolean' && typeof h.invertRange === 'boolean'
    && Object.values(h.adjustments).every((x) => !!x && finiteRange(x.hue, -360, 360)
      && finiteRange(x.saturation, -100, 100) && finiteRange(x.lightness, -100, 100))
    && Object.values(h.bands).every((b) => !!b && [b.falloffStart, b.rangeStart, b.rangeEnd, b.falloffEnd].every(Number.isFinite));
  const levels = a.levels.ranges.length === 4 && LEVELS_CHANNELS.includes(a.levels.channel)
    && a.levels.ranges.every((x) => { const n = normalizeLevelRange(x); return x.black === n.black && x.gamma === n.gamma
      && x.white === n.white && x.outputBlack === n.outputBlack && x.outputWhite === n.outputWhite; });
  const e = a.exposureSettings, g = a.gradientMapSettings, grain = a.grainSettings;
  return finiteRange(a.hue, -360, 360) && finiteRange(a.saturation, -100, 100) && finiteRange(a.lightness, -100, 100)
    && hsv && levels && isValidCurves(a.curves)
    && finiteRange(e.exposure, -20, 20) && finiteRange(e.offset, -0.5, 0.5) && finiteRange(e.gamma, 0.01, 9.99)
    && [g.shadows, g.highlights].every((c) => finiteRange(c.red, 0, 1) && finiteRange(c.green, 0, 1) && finiteRange(c.blue, 0, 1))
    && finiteRange(grain.amount, 0, 100) && finiteRange(grain.size, 0.5, 20) && finiteRange(grain.roughness, 0, 100)
    && Number.isInteger(grain.seed) && grain.seed >= 0 && grain.seed <= 0xffff_ffff;
}
