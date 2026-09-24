/**
 * Codable adjustment records. Ported from Document/LayerAdjustment.swift,
 * ImageAdjustments.swift, Levels.swift, Curves.swift and HueSaturation.swift.
 */

import type { LayerAdjustment, LayerAdjustmentKind } from './document';
import type {
  BasicSettings, BrightnessContrastSettings, ChannelMixerChannel, ChannelMixerSettings, ColourSettings,
  PhotoFilterSettings,
} from './model/types';

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

/** Stable view used by the adjustment kernels and controls. */
export interface ResolvedAdjustment {
  readonly kind: LayerAdjustmentKind;
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
export function defaultBasic(): BasicSettings {
  return { exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
    texture: 0, clarity: 0, dehaze: 0, vibrance: 0, saturation: 0, temperature: 0, tint: 0 };
}
const ZERO_BALANCE = { cyanRed: 0, magentaGreen: 0, yellowBlue: 0 } as const;
export function defaultColour(): ColourSettings {
  return {
    blackAndWhite: { enabled: false, reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80,
      tint: false, tintColor: { red: 0.84, green: 0.75, blue: 0.62 } },
    colourBalance: { enabled: false, shadows: ZERO_BALANCE, midtones: ZERO_BALANCE, highlights: ZERO_BALANCE, preserveLuminosity: true },
    selectiveColour: { mode: 'relative', ranges: {} },
  };
}
export function defaultBrightnessContrast(): BrightnessContrastSettings { return { brightness: 0, contrast: 0, legacy: false }; }
export function defaultPhotoFilter(): PhotoFilterSettings {
  return { color: { red: 1, green: 0.55, blue: 0.16 }, density: 25, preserveLuminosity: true };
}
export function defaultMixerChannel(red: number, green: number, blue: number): ChannelMixerChannel {
  return { red, green, blue, constant: 0 };
}
export function defaultChannelMixer(): ChannelMixerSettings {
  return { monochrome: false, red: defaultMixerChannel(100, 0, 0), green: defaultMixerChannel(0, 100, 0),
    blue: defaultMixerChannel(0, 0, 100), gray: defaultMixerChannel(40, 40, 20) };
}

export function defaultAdjustment<K extends LayerAdjustmentKind>(kind: K, foreground: RGB, background: RGB): Extract<LayerAdjustment, { kind: K }>;
export function defaultAdjustment(kind: LayerAdjustmentKind, foreground: RGB, background: RGB): LayerAdjustment {
  switch (kind) {
    case 'Hue/Saturation': return { kind, schemaVersion: 1,
      parameters: { hue: 0, saturation: 0, lightness: 0, colorize: false, settings: defaultHueSaturation() } };
    case 'Levels': return { kind, schemaVersion: 1, parameters: defaultLevels() };
    case 'Curves': return { kind, schemaVersion: 1, parameters: defaultCurves() };
    case 'Exposure': return { kind, schemaVersion: 1, parameters: defaultExposure() };
    case 'Gradient Map': return { kind, schemaVersion: 1, parameters: defaultGradientMap(foreground, background) };
    case 'Grain': return { kind, schemaVersion: 1,
      parameters: defaultGrain(Math.floor(Math.random() * 0x1_0000_0000)) };
    case 'Basic': return { kind, schemaVersion: 1, parameters: defaultBasic() };
    case 'Colour Lookup': return { kind, schemaVersion: 1, parameters: { resourceId: '', interpolation: 'tetrahedral' } };
    case 'Colour': return { kind, schemaVersion: 1, parameters: defaultColour() };
    case 'Invert': return { kind, schemaVersion: 1, parameters: {} };
    case 'Threshold': return { kind, schemaVersion: 1, parameters: { level: 128 } };
    case 'Posterize': return { kind, schemaVersion: 1, parameters: { levels: 4 } };
    case 'Brightness/Contrast': return { kind, schemaVersion: 1, parameters: defaultBrightnessContrast() };
    case 'Photo Filter': return { kind, schemaVersion: 1, parameters: defaultPhotoFilter() };
    case 'Channel Mixer': return { kind, schemaVersion: 1, parameters: defaultChannelMixer() };
  }
}

export function resolveAdjustment(value: LayerAdjustment): ResolvedAdjustment {
  const hue = value.kind === 'Hue/Saturation' ? value.parameters.hue : 0;
  const saturation = value.kind === 'Hue/Saturation' ? value.parameters.saturation : 0;
  const lightness = value.kind === 'Hue/Saturation' ? value.parameters.lightness : 0;
  const colorize = value.kind === 'Hue/Saturation' ? value.parameters.colorize : false;
  return {
    kind: value.kind, hue, saturation, lightness, colorize,
    hsvSettings: value.kind === 'Hue/Saturation' ? value.parameters.settings : defaultHueSaturation(),
    levels: value.kind === 'Levels' ? value.parameters : defaultLevels(),
    curves: value.kind === 'Curves' ? value.parameters : defaultCurves(),
    exposureSettings: value.kind === 'Exposure' ? value.parameters : defaultExposure(),
    gradientMapSettings: value.kind === 'Gradient Map' ? value.parameters : defaultGradientMap(),
    grainSettings: value.kind === 'Grain' ? value.parameters : defaultGrain(),
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
  if (!value || typeof value !== 'object' || value.schemaVersion !== 1
    || !['Hue/Saturation', 'Levels', 'Curves', 'Exposure', 'Gradient Map', 'Grain', 'Basic', 'Colour Lookup',
      'Colour', 'Invert', 'Threshold', 'Posterize', 'Brightness/Contrast', 'Photo Filter', 'Channel Mixer'].includes(value.kind)
    || !value.parameters || typeof value.parameters !== 'object') return false;
  try {
    if (value.kind === 'Basic') {
      const p = value.parameters;
      return finiteRange(p.exposure, -5, 5) && [p.contrast, p.highlights, p.shadows, p.whites, p.blacks,
        p.texture, p.clarity, p.dehaze, p.vibrance, p.saturation, p.temperature, p.tint].every((n) => finiteRange(n, -100, 100));
    }
    if (value.kind === 'Colour Lookup') return typeof value.parameters.resourceId === 'string'
      && ['trilinear', 'tetrahedral'].includes(value.parameters.interpolation);
    if (value.kind === 'Invert') return Object.keys(value.parameters).length === 0;
    if (value.kind === 'Threshold') return Number.isInteger(value.parameters.level) && finiteRange(value.parameters.level, 0, 255);
    if (value.kind === 'Posterize') return Number.isInteger(value.parameters.levels) && finiteRange(value.parameters.levels, 2, 256);
    if (value.kind === 'Brightness/Contrast') return finiteRange(value.parameters.brightness, -150, 150)
      && finiteRange(value.parameters.contrast, -100, 100) && typeof value.parameters.legacy === 'boolean';
    if (value.kind === 'Photo Filter') return validRgb(value.parameters.color) && finiteRange(value.parameters.density, 0, 100)
      && typeof value.parameters.preserveLuminosity === 'boolean';
    if (value.kind === 'Channel Mixer') {
      const p = value.parameters;
      return typeof p.monochrome === 'boolean' && [p.red, p.green, p.blue, p.gray].every((c) =>
        [c.red, c.green, c.blue, c.constant].every((n) => finiteRange(n, -200, 200)));
    }
    if (value.kind === 'Colour') return validColour(value.parameters);
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
  } catch { return false; }
}

function validRgb(value: RGB): boolean {
  return finiteRange(value.red, 0, 1) && finiteRange(value.green, 0, 1) && finiteRange(value.blue, 0, 1);
}

function validColour(value: ColourSettings): boolean {
  const bw = value.blackAndWhite, balance = value.colourBalance, selective = value.selectiveColour;
  return typeof bw.enabled === 'boolean' && [bw.reds, bw.yellows, bw.greens, bw.cyans, bw.blues, bw.magentas].every((n) => finiteRange(n, -200, 300))
    && typeof bw.tint === 'boolean' && validRgb(bw.tintColor) && typeof balance.enabled === 'boolean'
    && [balance.shadows, balance.midtones, balance.highlights].every((tone) =>
      [tone.cyanRed, tone.magentaGreen, tone.yellowBlue].every((n) => finiteRange(n, -100, 100)))
    && typeof balance.preserveLuminosity === 'boolean' && ['relative', 'absolute'].includes(selective.mode)
    && Object.values(selective.ranges).every((range) => !!range
      && [range.cyan, range.magenta, range.yellow, range.black].every((n) => finiteRange(n, -100, 100)));
}
