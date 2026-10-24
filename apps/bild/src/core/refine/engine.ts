import { boxMean, refineGuidedMask } from '../subject/guidedMatte';

export interface RefineEdgeSettings {
  readonly radius: number;
  readonly smartRadius: boolean;
  readonly smooth: number;
  readonly feather: number;
  readonly contrast: number;
  readonly shiftEdge: number;
  readonly decontaminate: number;
  /** Optional painted hair/fur region, 255 = recompute alpha there. */
  readonly hairRegion?: Uint8Array | null;
}

export const DEFAULT_REFINE_EDGE_SETTINGS: RefineEdgeSettings = {
  radius: 8, smartRadius: true, smooth: 0, feather: 0, contrast: 0, shiftEdge: 0, decontaminate: 0,
};

export interface RefineEdgeResult {
  readonly mask: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly decontaminatedRgba: Uint8Array | null;
}

export function normalizeRefineEdgeSettings(value: Partial<RefineEdgeSettings> = {}): RefineEdgeSettings {
  const finite = (n: number | undefined, fallback: number, low: number, high: number): number =>
    n === undefined || !Number.isFinite(n) ? fallback : Math.max(low, Math.min(high, n));
  return {
    radius: finite(value.radius, 8, 0, 250), smartRadius: value.smartRadius ?? true,
    smooth: finite(value.smooth, 0, 0, 100), feather: finite(value.feather, 0, 0, 250),
    contrast: finite(value.contrast, 0, 0, 100), shiftEdge: finite(value.shiftEdge, 0, -100, 100),
    decontaminate: finite(value.decontaminate, 0, 0, 100), hairRegion: value.hairRegion ?? null,
  };
}

/**
 * Product-plan Refine Edge pipeline. Guided refinement follows GuidedMatte.refine; shift/contrast
 * follow SubjectRemoval.refined. New controls are deterministic CPU equivalents of the workspace.
 */
export function refineEdge(rgba: Uint8Array, width: number, height: number, inputMask: Uint8Array,
  value: Partial<RefineEdgeSettings> = {}): RefineEdgeResult {
  const count = width * height;
  if (rgba.length !== count * 4 || inputMask.length !== count) throw new RangeError('Refine Edge buffer size mismatch');
  const settings = normalizeRefineEdgeSettings(value);
  if (settings.hairRegion && settings.hairRegion.length !== count) throw new RangeError('Hair-region buffer size mismatch');
  let mask: Uint8Array = inputMask.slice();

  if (settings.radius > 0) {
    const guided = refineGuidedMask(mask, rgba, width, height, settings.radius);
    if (settings.smartRadius || settings.hairRegion) {
      const band = edgeBand(mask, width, height, Math.max(1, Math.ceil(settings.radius)));
      for (let i = 0; i < count; i++) {
        const mix = Math.max(settings.smartRadius ? band[i]! : 0, settings.hairRegion?.[i] ?? 0);
        mask[i] = Math.round((mask[i]! * (255 - mix) + guided[i]! * mix) / 255);
      }
    } else mask = guided;
  }
  if (settings.smooth > 0) mask = smoothMask(mask, width, height, Math.max(1, Math.round(settings.smooth / 8)));
  if (settings.feather > 0) mask = featherMask(mask, width, height, settings.feather);
  if (settings.shiftEdge !== 0) mask = shiftMask(mask, width, height, settings.shiftEdge);
  if (settings.contrast > 0) applyContrast(mask, settings.contrast);
  const decontaminatedRgba = settings.decontaminate > 0
    ? decontaminateColours(rgba, mask, width, height, settings.decontaminate / 100) : null;
  return { mask, width, height, decontaminatedRgba };
}

function toFloat(mask: Uint8Array): Float32Array {
  const result = new Float32Array(mask.length);
  for (let i = 0; i < mask.length; i++) result[i] = mask[i]! / 255;
  return result;
}

function toBytes(levels: Float32Array): Uint8Array {
  const result = new Uint8Array(levels.length);
  for (let i = 0; i < levels.length; i++) result[i] = Math.round(Math.max(0, Math.min(1, levels[i]!)) * 255);
  return result;
}

function smoothMask(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const mean = boxMean(toFloat(mask), width, height, radius), result = new Uint8Array(mask.length);
  for (let i = 0; i < result.length; i++) {
    const v = mean[i]!;
    result[i] = v <= 0.35 ? 0 : v >= 0.65 ? 255 : Math.round((v - 0.35) / 0.3 * 255);
  }
  return result;
}

function featherMask(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  let levels: Float32Array = toFloat(mask);
  const step = Math.max(1, Math.round(radius * 0.58));
  for (let i = 0; i < 3; i++) levels = boxMean(levels, width, height, step);
  return toBytes(levels);
}

function shiftMask(mask: Uint8Array, width: number, height: number, amount: number): Uint8Array {
  const reach = Math.max(1, Math.ceil(Math.abs(amount))), blurred = featherMask(mask, width, height, reach / 2);
  const level = amount < 0 ? 0.75 : 0.25, result = new Uint8Array(mask.length);
  for (let i = 0; i < result.length; i++) result[i] = Math.round(Math.max(0, Math.min(1, (blurred[i]! / 255 - level) * 1000)) * 255);
  return result;
}

function applyContrast(mask: Uint8Array, amount: number): void {
  const strength = amount / 100, slope = 1 / Math.max(0.02, 1 - strength * 0.98);
  for (let i = 0; i < mask.length; i++) mask[i] = Math.round(Math.max(0, Math.min(1, mask[i]! / 255 * slope + (1 - slope) / 2)) * 255);
}

function edgeBand(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const edge = new Float32Array(mask.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = y * width + x, value = mask[at]!;
    if ((value > 0 && value < 255) || (x > 0 && mask[at - 1] !== value) || (y > 0 && mask[at - width] !== value)) edge[at] = 1;
  }
  let spread: Float32Array = edge;
  for (let i = 0; i < 2; i++) spread = boxMean(spread, width, height, radius);
  const result = new Uint8Array(mask.length);
  for (let i = 0; i < result.length; i++) result[i] = Math.min(255, Math.round(spread[i]! * 255 * 8));
  return result;
}

/** Pulls translucent edge RGB toward nearby opaque foreground to suppress background colour spill. */
export function decontaminateColours(rgba: Uint8Array, mask: Uint8Array, width: number, height: number,
  amount: number): Uint8Array {
  const result = rgba.slice(), strength = Math.max(0, Math.min(1, amount));
  if (strength === 0) return result;
  const radius = 3;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = y * width + x, alpha = mask[index]!;
    if (alpha === 0 || alpha === 255) continue;
    let red = 0, green = 0, blue = 0, weight = 0;
    for (let oy = -radius; oy <= radius; oy++) for (let ox = -radius; ox <= radius; ox++) {
      const px = x + ox, py = y + oy;
      if (px < 0 || py < 0 || px >= width || py >= height) continue;
      const sample = py * width + px, coverage = mask[sample]! / 255;
      if (coverage < 0.9) continue;
      const w = coverage / (1 + ox * ox + oy * oy), p = sample * 4;
      red += rgba[p]! * w; green += rgba[p + 1]! * w; blue += rgba[p + 2]! * w; weight += w;
    }
    if (weight === 0) continue;
    const mix = strength * (1 - alpha / 255), p = index * 4;
    result[p] = Math.round(rgba[p]! * (1 - mix) + red / weight * mix);
    result[p + 1] = Math.round(rgba[p + 1]! * (1 - mix) + green / weight * mix);
    result[p + 2] = Math.round(rgba[p + 2]! * (1 - mix) + blue / weight * mix);
  }
  return result;
}
