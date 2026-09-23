/** Levels/Curves lookup construction and automatic presets from Levels*.swift and Curves.swift. */
import {
  LEVELS_CHANNELS, defaultLevelRange, defaultLevels, normalizeLevelRange,
  type CurvePoint, type CurvesSettings, type LevelRange, type LevelsChannel, type LevelsSettings,
} from '../adjustments';

export function levelRangeValue(value: number, range: LevelRange): number {
  const s = normalizeLevelRange(range);
  const input = Math.min(1, Math.max(0, (value * 255 - s.black) / (s.white - s.black)));
  return (s.outputBlack + Math.pow(input, 1 / s.gamma) * (s.outputWhite - s.outputBlack)) / 255;
}
export function levelValue(value: number, settings: LevelsSettings, channel: Exclude<LevelsChannel, 'RGB'>): number {
  const index = LEVELS_CHANNELS.indexOf(channel);
  return levelRangeValue(levelRangeValue(value, settings.ranges[index] ?? defaultLevelRange()), settings.ranges[0] ?? defaultLevelRange());
}
export function levelsIdentity(settings: LevelsSettings): boolean {
  const identity = defaultLevelRange();
  return settings.ranges.length === 4 && settings.ranges.every((r) => { const n = normalizeLevelRange(r);
    return n.black === identity.black && n.gamma === identity.gamma && n.white === identity.white
      && n.outputBlack === identity.outputBlack && n.outputWhite === identity.outputWhite; });
}
export function levelsTables(settings: LevelsSettings): Float32Array {
  const tables = new Float32Array(768);
  for (let c = 0; c < 3; c++) for (let i = 0; i < 256; i++) tables[c * 256 + i] = levelValue(i / 255, settings, LEVELS_CHANNELS[c + 1] as Exclude<LevelsChannel, 'RGB'>);
  return tables;
}

function curveSlope(points: readonly CurvePoint[], deltas: readonly number[], index: number): number {
  if (index === 0) return deltas[0]!;
  if (index === points.length - 1) return deltas.at(-1)!;
  if (deltas[index - 1]! * deltas[index]! <= 0) return 0;
  return 2 / (1 / deltas[index - 1]! + 1 / deltas[index]!);
}
export function curveValue(x: number, settings: CurvesSettings, channel: number): number {
  const points = settings.channels[channel]!;
  let index = 0;
  for (let j = points.length - 2; j >= 0; j--) if (points[j]!.x <= x) { index = j; break; }
  index = Math.min(points.length - 2, Math.max(0, index));
  const deltas = new Array<number>(points.length - 1);
  for (let j = 0; j < deltas.length; j++) deltas[j] = (points[j + 1]!.y - points[j]!.y) / (points[j + 1]!.x - points[j]!.x);
  const a = points[index]!, b = points[index + 1]!, h = b.x - a.x, t = Math.min(1, Math.max(0, (x - a.x) / h));
  const y = (2 * t ** 3 - 3 * t ** 2 + 1) * a.y + (t ** 3 - 2 * t ** 2 + t) * h * curveSlope(points, deltas, index)
    + (-2 * t ** 3 + 3 * t ** 2) * b.y + (t ** 3 - t ** 2) * h * curveSlope(points, deltas, index + 1);
  return Math.min(255, Math.max(0, y));
}
export function curvesTables(settings: CurvesSettings): Float32Array {
  const tables = new Float32Array(768);
  for (let c = 1; c <= 3; c++) for (let i = 0; i < 256; i++) tables[(c - 1) * 256 + i] = curveValue(curveValue(i, settings, c), settings, 0) / 255;
  return tables;
}

export type LevelsAuto = 'Contrast' | 'Color' | 'Color + neutral midtones';
function endpoints(bins: ArrayLike<number>): [number, number] | null {
  let total = 0; for (let i = 0; i < 256; i++) total += bins[i] ?? 0;
  if (!(total > 0)) return null;
  let sum = 0, low = 0, high = 255;
  for (let i = 0; i < 256; i++) { sum += bins[i] ?? 0; if (sum > total * 0.001) { low = i; break; } }
  sum = 0; for (let i = 255; i >= 0; i--) { sum += bins[i] ?? 0; if (sum > total * 0.001) { high = i; break; } }
  return low < high ? [low, high] : null;
}
export function autoLevels(mode: LevelsAuto, histogram: readonly ArrayLike<number>[]): LevelsSettings {
  const result = defaultLevels(), ranges = result.ranges.slice();
  if (mode === 'Contrast') {
    const limits = histogram.slice(1).map(endpoints).filter((x): x is [number, number] => x !== null);
    if (limits.length) {
      const low = Math.min(...limits.map((x) => x[0])), high = Math.max(...limits.map((x) => x[1]));
      if (low < high) ranges[0] = { ...defaultLevelRange(), black: low, white: high };
    }
  } else for (let c = 1; c <= 3; c++) {
    const bins = histogram[c]; if (!bins) continue;
    const limits = endpoints(bins); if (!limits) continue;
    let range: LevelRange = { ...defaultLevelRange(), black: limits[0], white: limits[1] };
    if (mode === 'Color + neutral midtones') {
      let total = 0, weighted = 0;
      for (let i = 0; i < 256; i++) { const count = bins[i] ?? 0; total += count; weighted += levelRangeValue(i / 255, range) * count; }
      const mean = weighted / total;
      if (mean > 0 && mean < 1) range = { ...range, gamma: Math.min(9.99, Math.max(0.1, Math.log(mean) / Math.log(0.5))) };
    }
    ranges[c] = range;
  }
  return { ...result, ranges };
}

export type LevelsSample = 'Black' | 'Gray' | 'White';
export function sampleLevels(settings: LevelsSettings, rgb: readonly number[], mode: LevelsSample): LevelsSettings {
  const ranges = settings.ranges.slice(); ranges[0] = defaultLevelRange();
  for (let c = 1; c <= 3; c++) {
    let range = { ...(ranges[c] ?? defaultLevelRange()) }; const value = (rgb[c - 1] ?? 0) * 255;
    if (mode === 'Black') range.black = Math.min(range.white - 1, Math.max(0, value));
    else if (mode === 'White') range.white = Math.max(range.black + 1, Math.min(255, value));
    else { const fraction = (value - range.black) / (range.white - range.black); if (fraction > 0 && fraction < 1) range.gamma = Math.log(fraction) / Math.log(0.5); }
    range.outputBlack = 0; range.outputWhite = 255; ranges[c] = normalizeLevelRange(range);
  }
  return { ...settings, ranges };
}

/** Display-only 95th-percentile cap from `LevelsHistogramDisplay.scale`. */
export function histogramDisplayScale(bins: readonly number[]): number {
  const positive = bins.filter((x) => Number.isFinite(x) && x > 0), peak = positive.length ? Math.max(...positive) : 0;
  if (!(peak > 0)) return 0;
  const interior = bins.slice(1, -1).filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (!interior.length) return peak;
  return Math.min(peak, interior[Math.floor((interior.length - 1) * 0.95)]! * 4);
}
