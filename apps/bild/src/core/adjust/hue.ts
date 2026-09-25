/** Hue/Saturation math from Document/HueSaturation.swift. */
import {
  COLOR_RANGES, DEFAULT_BANDS, defaultRangeAdjustment,
  type ColorRange, type HueBand, type HueSaturationSettings, type RangeAdjustment,
} from '../adjustments';

export function forwardHue(from: number, to: number): number {
  const delta = (to - from) % 360;
  return delta < 0 ? delta + 360 : delta;
}

export function hueBandWeight(band: HueBand, hue: number): number {
  const span = forwardHue(band.falloffStart, band.falloffEnd);
  if (span <= 0) return 1;
  const position = forwardHue(band.falloffStart, hue);
  if (position > span) return 0;
  const rampIn = forwardHue(band.falloffStart, band.rangeStart);
  const plateauEnd = forwardHue(band.falloffStart, band.rangeEnd);
  if (position < rampIn) return rampIn > 0 ? position / rampIn : 1;
  if (position <= plateauEnd) return 1;
  const rampOut = span - plateauEnd;
  return rampOut > 0 ? (span - position) / rampOut : 1;
}

function wrapHue(value: number): number { const r = value % 360; return r < 0 ? r + 360 : r; }

export function centerHueBand(band: HueBand, hue: number): HueBand {
  const core = forwardHue(band.rangeStart, band.rangeEnd);
  const leading = forwardHue(band.falloffStart, band.rangeStart);
  const trailing = forwardHue(band.rangeEnd, band.falloffEnd);
  const start = wrapHue(hue - core / 2);
  return { falloffStart: wrapHue(start - leading), rangeStart: start,
    rangeEnd: wrapHue(start + core), falloffEnd: wrapHue(start + core + trailing) };
}

function normalizeBand(value: HueBand): HueBand {
  const result = { falloffStart: wrapHue(value.falloffStart), rangeStart: wrapHue(value.rangeStart),
    rangeEnd: wrapHue(value.rangeEnd), falloffEnd: wrapHue(value.falloffEnd) };
  return forwardHue(result.falloffStart, result.falloffEnd) > 350
    ? { ...result, falloffEnd: wrapHue(result.falloffStart + 350) } : result;
}

export function includeHue(band: HueBand, hue: number): HueBand {
  if (hueBandWeight(band, hue) >= 1) return band;
  const shoulderIn = forwardHue(band.falloffStart, band.rangeStart);
  const shoulderOut = forwardHue(band.rangeEnd, band.falloffEnd);
  return forwardHue(hue, band.rangeStart) <= forwardHue(band.rangeEnd, hue)
    ? normalizeBand({ ...band, rangeStart: hue, falloffStart: hue - shoulderIn })
    : normalizeBand({ ...band, rangeEnd: hue, falloffEnd: hue + shoulderOut });
}

export function excludeHue(band: HueBand, hue: number): HueBand {
  if (hueBandWeight(band, hue) <= 0) return band;
  const shoulderIn = forwardHue(band.falloffStart, band.rangeStart);
  const shoulderOut = forwardHue(band.rangeEnd, band.falloffEnd);
  return forwardHue(band.falloffStart, hue) <= forwardHue(hue, band.falloffEnd)
    ? normalizeBand({ ...band, falloffStart: hue + 1, rangeStart: hue + 1 + shoulderIn })
    : normalizeBand({ ...band, falloffEnd: hue - 1, rangeEnd: hue - 1 - shoulderOut });
}

export function setHueBandHandle(band: HueBand, index: number, degrees: number): HueBand {
  const key = (['falloffStart', 'rangeStart', 'rangeEnd', 'falloffEnd'] as const)[Math.min(3, Math.max(0, index))]!;
  const updated = { ...band, [key]: wrapHue(degrees) };
  const span = forwardHue(updated.falloffStart, updated.falloffEnd);
  const toStart = forwardHue(updated.falloffStart, updated.rangeStart);
  const toEnd = forwardHue(updated.falloffStart, updated.rangeEnd);
  return span > 1 && span <= 350 && toStart <= toEnd && toEnd <= span ? updated : band;
}

export function hueRangeWeight(settings: HueSaturationSettings, range: ColorRange, hue: number): number {
  if (range === 'Master') return 1;
  const weight = hueBandWeight(settings.bands[range] ?? DEFAULT_BANDS[range], hue);
  return settings.invertRange && range === settings.range ? 1 - weight : weight;
}

export interface HueResponse { readonly shift: number; readonly saturation: number; readonly lightness: number }
export function hueResponse(settings: HueSaturationSettings): HueResponse[] {
  const result: HueResponse[] = [];
  for (let degree = 0; degree <= 360; degree++) {
    let shift = 0, saturation = 0, lightness = 0;
    for (const range of COLOR_RANGES) {
      const a = settings.adjustments[range];
      if (!a || (a.hue === 0 && a.saturation === 0 && a.lightness === 0)) continue;
      const weight = hueRangeWeight(settings, range, degree);
      shift += a.hue * weight; saturation += a.saturation * weight; lightness += a.lightness * weight;
    }
    result.push({ shift, saturation, lightness });
  }
  return result;
}

export function toHsl(red: number, green: number, blue: number): [number, number, number] {
  const high = Math.max(red, green, blue), low = Math.min(red, green, blue);
  const lightness = (high + low) / 2, delta = high - low;
  if (delta <= 0) return [0, 0, lightness];
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue = high === red ? (green - blue) / delta : high === green ? (blue - red) / delta + 2 : (red - green) / delta + 4;
  hue *= 60; if (hue < 0) hue += 360;
  return [hue, Math.min(1, saturation), lightness];
}

export function fromHsl(hue: number, saturation: number, lightness: number): [number, number, number] {
  if (saturation <= 0) return [lightness, lightness, lightness];
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const sector = hue / 60, second = chroma * (1 - Math.abs((sector % 2) - 1)), base = lightness - chroma / 2;
  let rgb: [number, number, number];
  switch (Math.trunc(sector)) {
    case 0: rgb = [chroma, second, 0]; break; case 1: rgb = [second, chroma, 0]; break;
    case 2: rgb = [0, chroma, second]; break; case 3: rgb = [0, second, chroma]; break;
    case 4: rgb = [second, 0, chroma]; break; default: rgb = [chroma, 0, second];
  }
  return rgb.map((v) => Math.min(1, Math.max(0, v + base))) as [number, number, number];
}

function hslToHsv(saturation: number, lightness: number): [number, number] {
  const value = lightness + saturation * Math.min(lightness, 1 - lightness);
  return [value > 0 ? 2 * (1 - lightness / value) : 0, value];
}

function hsvToHsl(saturation: number, value: number): [number, number] {
  const lightness = value * (1 - saturation / 2);
  const denominator = Math.min(lightness, 1 - lightness);
  return [denominator > 0 ? (value - lightness) / denominator : 0, lightness];
}

function photoshopSaturation(value: number, amount: number): number {
  const normalized = Math.min(1, Math.max(-1, amount / 100));
  return Math.min(1, Math.max(0, normalized > 0 ? value / (1 - normalized + 0.01) : value * (1 + normalized)));
}

export function adjustHueColor(red: number, green: number, blue: number, settings: HueSaturationSettings,
  response = hueResponse(settings)): [number, number, number] {
  let [hue, saturation, lightness] = toHsl(red, green, blue);
  if (settings.colorize) {
    const a = settings.adjustments[settings.range] ?? defaultRangeAdjustment();
    hue = wrapHue(a.hue); saturation = Math.min(1, Math.max(0, a.saturation / 100));
    const amount = Math.min(1, Math.max(-1, a.lightness / 100));
    lightness = amount >= 0 ? lightness + (1 - lightness) * amount : lightness * (1 + amount);
    return fromHsl(hue, saturation, Math.min(1, Math.max(0, lightness)));
  }

  const master = settings.adjustments.Master ?? defaultRangeAdjustment();
  const masterLightness = Math.min(1, Math.max(-1, master.lightness / 100));
  if (masterLightness !== 0) {
    const apply = (value: number): number => masterLightness > 0
      ? value * (1 - masterLightness) + masterLightness : value * (1 + masterLightness);
    red = apply(red); green = apply(green); blue = apply(blue);
    [hue, saturation, lightness] = toHsl(red, green, blue);
  }
  const sampled = response[Math.min(response.length - 1, Math.max(0, Math.round(hue)))]!;
  const rangeHue = sampled.shift - master.hue;
  const rangeSaturation = sampled.saturation - master.saturation;
  const rangeLightness = Math.min(1, Math.max(-1, (sampled.lightness - master.lightness) / 100));
  let hsvSaturation: number, value: number;
  [hsvSaturation, value] = hslToHsv(saturation, lightness);
  if (rangeLightness < 0) value *= 1 + rangeLightness * hsvSaturation;
  if (rangeLightness >= 0) hsvSaturation *= 1 - rangeLightness;
  else if (hsvSaturation > 1e-6) {
    const inverse = 1 / (hsvSaturation + 0.001);
    hsvSaturation = 1 + (inverse - 1) / (Math.abs(rangeLightness) - inverse + 0.001);
  }
  [saturation, lightness] = hsvToHsl(Math.min(1, Math.max(0, hsvSaturation)), Math.min(1, Math.max(0, value)));
  hue = wrapHue(hue + master.hue + rangeHue);
  saturation = photoshopSaturation(photoshopSaturation(saturation, master.saturation), rangeSaturation);
  return fromHsl(hue, saturation, Math.min(1, Math.max(0, lightness)));
}

export function hueSettingsIdentity(settings: HueSaturationSettings): boolean {
  return !settings.colorize && Object.values(settings.adjustments).every((a) => !a || (a.hue === 0 && a.saturation === 0 && a.lightness === 0));
}

export type HueSampleMode = 'Sample' | 'Add' | 'Remove';
export function sampleHueRange(settings: HueSaturationSettings, hue: number, mode: HueSampleMode): HueSaturationSettings {
  if (settings.range === 'Master' || settings.colorize) return settings;
  const band = settings.bands[settings.range] ?? DEFAULT_BANDS[settings.range];
  const sampled = mode === 'Sample' ? centerHueBand(band, hue) : mode === 'Add' ? includeHue(band, hue) : excludeHue(band, hue);
  return { ...settings, bands: { ...settings.bands, [settings.range]: sampled } };
}

export interface HueTargetDrag { readonly range: Exclude<ColorRange, 'Master'>; readonly hue: number; readonly saturation: number }
export function beginHueTarget(settings: HueSaturationSettings, sampledHue: number): { settings: HueSaturationSettings; drag: HueTargetDrag } | null {
  if (settings.colorize) return null;
  const ranges = COLOR_RANGES.slice(1) as Exclude<ColorRange, 'Master'>[];
  let range = ranges[0]!;
  for (const candidate of ranges.slice(1)) if (hueRangeWeight(settings, candidate, sampledHue) > hueRangeWeight(settings, range, sampledHue)) range = candidate;
  const a = settings.adjustments[range] ?? defaultRangeAdjustment();
  return { settings: { ...settings, range }, drag: { range, hue: a.hue, saturation: a.saturation } };
}

export function dragHueTarget(settings: HueSaturationSettings, drag: HueTargetDrag, viewDelta: number, adjustsHue: boolean): HueSaturationSettings {
  const previous = settings.adjustments[drag.range] ?? defaultRangeAdjustment();
  const next: RangeAdjustment = adjustsHue
    ? { ...previous, hue: Math.min(180, Math.max(-180, drag.hue + viewDelta / 2)) }
    : { ...previous, saturation: Math.min(100, Math.max(-100, drag.saturation + viewDelta / 2)) };
  return { ...settings, adjustments: { ...settings.adjustments, [drag.range]: next } };
}
