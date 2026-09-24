/** FilterKind and FilterSettings from Document/Filters.swift (unsupported automatic cases omitted). */
import {
  defaultCurves, defaultExposure, defaultGradientMap, defaultGrain,
  type CurvesSettings, type ExposureSettings, type GradientMapSettings, type GrainSettings,
} from '../adjustments';

export type FilterKind = 'Gaussian Blur' | 'Motion Blur' | 'Add Noise' | 'Lens Correction'
  | 'Curves' | 'Exposure' | 'Gradient Map' | 'Grain' | 'Unsharp Mask' | 'Smart Sharpen' | 'High Pass' | 'Denoise';
export const FILTER_KINDS: readonly FilterKind[] = ['Gaussian Blur', 'Motion Blur', 'Add Noise', 'Lens Correction',
  'Curves', 'Exposure', 'Gradient Map', 'Grain', 'Unsharp Mask', 'Smart Sharpen', 'High Pass', 'Denoise'];

export interface FilterSettings {
  readonly radius: number; readonly angle: number; readonly distance: number;
  readonly amount: number; readonly gaussian: boolean; readonly monochromatic: boolean;
  readonly distortion: number; readonly curves: CurvesSettings; readonly exposure: ExposureSettings;
  readonly gradientMap: GradientMapSettings; readonly grain: GrainSettings;
  readonly threshold: number; readonly reduceNoise: number; readonly luminance: number; readonly colour: number;
}
export function defaultFilterSettings(): FilterSettings {
  return { radius: 1, angle: 0, distance: 10, amount: 10, gaussian: false, monochromatic: false,
    distortion: 0, curves: defaultCurves(), exposure: defaultExposure(), gradientMap: defaultGradientMap(), grain: defaultGrain(),
    threshold: 0, reduceNoise: 0, luminance: 25, colour: 25 };
}
function clamp(value: number, lo: number, hi: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(hi, Math.max(lo, value)) : fallback;
}
export function normalizeFilterSettings(value: FilterSettings): FilterSettings {
  return { ...value, radius: clamp(value.radius, 0.1, 250, 1), angle: clamp(value.angle, -90, 90, 0),
    distance: clamp(value.distance, 1, 2000, 10), amount: clamp(value.amount, 0.1, 400, 10),
    distortion: clamp(value.distortion, -100, 100, 0),
    threshold: clamp(value.threshold, 0, 255, 0), reduceNoise: clamp(value.reduceNoise, 0, 100, 0),
    luminance: clamp(value.luminance, 0, 100, 25), colour: clamp(value.colour, 0, 100, 25),
    exposure: { exposure: clamp(value.exposure.exposure, -20, 20, 0), offset: clamp(value.exposure.offset, -0.5, 0.5, 0),
      gamma: clamp(value.exposure.gamma, 0.01, 9.99, 1) },
    gradientMap: { ...value.gradientMap,
      shadows: { red: clamp(value.gradientMap.shadows.red, 0, 1, 0), green: clamp(value.gradientMap.shadows.green, 0, 1, 0), blue: clamp(value.gradientMap.shadows.blue, 0, 1, 0) },
      highlights: { red: clamp(value.gradientMap.highlights.red, 0, 1, 0), green: clamp(value.gradientMap.highlights.green, 0, 1, 0), blue: clamp(value.gradientMap.highlights.blue, 0, 1, 0) } },
    grain: { ...value.grain, amount: clamp(value.grain.amount, 0, 100, 25), size: clamp(value.grain.size, 0.5, 20, 1.5),
      roughness: clamp(value.grain.roughness, 0, 100, 50), seed: value.grain.seed >>> 0 } };
}

export function blurMargin(kind: FilterKind, settings: FilterSettings): number {
  if (kind === 'Gaussian Blur') return settings.radius * 3 + 2;
  if (kind === 'Motion Blur') return settings.distance / 2 + 2;
  if (kind === 'Unsharp Mask' || kind === 'Smart Sharpen' || kind === 'High Pass') return settings.radius * 3 + 2;
  return 0;
}
