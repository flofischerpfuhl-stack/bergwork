/** FilterKind and FilterSettings from Document/Filters.swift (unsupported automatic cases omitted). */
import {
  defaultCurves, defaultExposure, defaultGradientMap, defaultGrain,
  type CurvesSettings, type ExposureSettings, type GradientMapSettings, type GrainSettings, type RGB,
} from '../adjustments';

export type FilterKind = 'Gaussian Blur' | 'Motion Blur' | 'Add Noise' | 'Lens Correction'
  | 'Curves' | 'Exposure' | 'Gradient Map' | 'Grain' | 'Unsharp Mask' | 'Smart Sharpen' | 'High Pass' | 'Denoise'
  | 'Vignette' | 'Bloom / Glow' | 'Tonal Contrast' | 'Progressive Blur' | 'RGB Split';
export const FILTER_KINDS: readonly FilterKind[] = ['Gaussian Blur', 'Motion Blur', 'Add Noise', 'Lens Correction',
  'Curves', 'Exposure', 'Gradient Map', 'Grain', 'Unsharp Mask', 'Smart Sharpen', 'High Pass', 'Denoise',
  'Vignette', 'Bloom / Glow', 'Tonal Contrast', 'Progressive Blur', 'RGB Split'];
/** The creative filters Compositor added after v1.0.4 (`Document/Filters.swift`, 1.2–1.5). */
export const CREATIVE_FILTER_KINDS: readonly FilterKind[] = ['Vignette', 'Bloom / Glow', 'Tonal Contrast', 'Progressive Blur', 'RGB Split'];
/** Filter menu filters Last Filter can repeat; the colour adjustments sharing FilterKind live in the Image menu. */
export function repeatsAsLastFilter(kind: FilterKind): boolean {
  return kind !== 'Curves' && kind !== 'Exposure' && kind !== 'Gradient Map' && kind !== 'Grain';
}

export interface FilterSettings {
  readonly radius: number; readonly angle: number; readonly distance: number;
  readonly amount: number; readonly gaussian: boolean; readonly monochromatic: boolean;
  readonly distortion: number; readonly curves: CurvesSettings; readonly exposure: ExposureSettings;
  readonly gradientMap: GradientMapSettings; readonly grain: GrainSettings;
  readonly threshold: number; readonly reduceNoise: number; readonly luminance: number; readonly colour: number;
  readonly detail: number;
  /** Vignette: edge colour (straight 0…1), strength, start of the falloff, ellipse↔rectangle, softness, highlight protection. */
  readonly vignetteColor: RGB; readonly vignetteAmount: number; readonly vignetteMidpoint: number;
  readonly vignetteRoundness: number; readonly vignetteFeather: number; readonly vignetteHighlights: number;
  /** Bloom / Glow: brightness where the glow starts (%), blur radius (px), strength (%; 50 = screened once). */
  readonly bloomThreshold: number; readonly bloomRadius: number; readonly bloomAmount: number;
  /** Tonal Contrast: local-detail radius (px), overall strength and per-tone strengths (−100…100). */
  readonly tonalRadius: number; readonly tonalAmount: number;
  readonly tonalShadows: number; readonly tonalMidtones: number; readonly tonalHighlights: number;
  /** Progressive Blur: ramp direction (°, counterclockwise like Motion Blur), sharp until start %, full radius from end %. */
  readonly progressiveAngle: number; readonly progressiveStart: number; readonly progressiveEnd: number;
  readonly progressiveRadius: number;
  /** RGB Split: spectrum spread and symmetric streak length (px), linear angle (°), or radial from the layer centre. */
  readonly rgbSplitDistance: number; readonly rgbSplitBlur: number; readonly rgbSplitAngle: number;
  readonly rgbSplitRadial: boolean;
}
export function defaultFilterSettings(): FilterSettings {
  return { radius: 1, angle: 0, distance: 10, amount: 10, gaussian: false, monochromatic: false,
    distortion: 0, curves: defaultCurves(), exposure: defaultExposure(), gradientMap: defaultGradientMap(), grain: defaultGrain(),
    threshold: 0, reduceNoise: 0, luminance: 25, colour: 25, detail: 50,
    // Compositor's defaults; Roundness starts at 100 since 1.2.6.
    vignetteColor: { red: 0, green: 0, blue: 0 }, vignetteAmount: 35, vignetteMidpoint: 50, vignetteRoundness: 100,
    vignetteFeather: 60, vignetteHighlights: 25,
    bloomThreshold: 50, bloomRadius: 24, bloomAmount: 40,
    tonalRadius: 16, tonalAmount: 50, tonalShadows: 40, tonalMidtones: 60, tonalHighlights: 30,
    // Sharp over the top third, blurring to the foot (Compositor's initial line).
    progressiveAngle: -90, progressiveStart: 35, progressiveEnd: 100, progressiveRadius: 20,
    rgbSplitDistance: 10, rgbSplitBlur: 0, rgbSplitAngle: 0, rgbSplitRadial: false };
}
function clamp(value: number | undefined, lo: number, hi: number, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.min(hi, Math.max(lo, value)) : fallback;
}
export function normalizeFilterSettings(value: FilterSettings): FilterSettings {
  return { ...value, radius: clamp(value.radius, 0.1, 250, 1), angle: clamp(value.angle, -90, 90, 0),
    distance: clamp(value.distance, 1, 2000, 10), amount: clamp(value.amount, 0.1, 400, 10),
    distortion: clamp(value.distortion, -100, 100, 0),
    threshold: clamp(value.threshold, 0, 255, 0), reduceNoise: clamp(value.reduceNoise, 0, 100, 0),
    luminance: clamp(value.luminance, 0, 100, 25), colour: clamp(value.colour, 0, 100, 25),
    detail: clamp(value.detail, 0, 100, 50),
    vignetteColor: { red: clamp(value.vignetteColor?.red, 0, 1, 0), green: clamp(value.vignetteColor?.green, 0, 1, 0),
      blue: clamp(value.vignetteColor?.blue, 0, 1, 0) },
    vignetteAmount: clamp(value.vignetteAmount, 0, 100, 35), vignetteMidpoint: clamp(value.vignetteMidpoint, 0, 100, 50),
    vignetteRoundness: clamp(value.vignetteRoundness, -100, 100, 100), vignetteFeather: clamp(value.vignetteFeather, 0, 100, 60),
    vignetteHighlights: clamp(value.vignetteHighlights, 0, 100, 25),
    bloomThreshold: clamp(value.bloomThreshold, 0, 100, 50), bloomRadius: clamp(value.bloomRadius, 1, 150, 24),
    bloomAmount: clamp(value.bloomAmount, 0, 100, 40),
    tonalRadius: clamp(value.tonalRadius, 1, 100, 16), tonalAmount: clamp(value.tonalAmount, 0, 100, 50),
    tonalShadows: clamp(value.tonalShadows, -100, 100, 40), tonalMidtones: clamp(value.tonalMidtones, -100, 100, 60),
    tonalHighlights: clamp(value.tonalHighlights, -100, 100, 30),
    progressiveAngle: clamp(value.progressiveAngle, -180, 180, -90), progressiveStart: clamp(value.progressiveStart, 0, 100, 35),
    progressiveEnd: clamp(value.progressiveEnd, 0, 100, 100), progressiveRadius: clamp(value.progressiveRadius, 0, 250, 20),
    rgbSplitDistance: clamp(value.rgbSplitDistance, 0, 200, 10), rgbSplitBlur: clamp(value.rgbSplitBlur, 0, 400, 0),
    rgbSplitAngle: clamp(value.rgbSplitAngle, -180, 180, 0), rgbSplitRadial: value.rgbSplitRadial === true,
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
  if (kind === 'Progressive Blur') return settings.progressiveRadius * 3 + 2;
  if (kind === 'Bloom / Glow') return settings.bloomRadius * 3 + 2;
  // Radial reaches about twice its distance at the far corners (Filters.swift `blurMargin`).
  if (kind === 'RGB Split') return (settings.rgbSplitDistance + settings.rgbSplitBlur) * (settings.rgbSplitRadial ? 2 : 1) + 2;
  return 0;
}
