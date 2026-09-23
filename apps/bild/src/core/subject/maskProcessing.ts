import { refineGuidedMask, resizeLevelsToBytes } from './guidedMatte';

export const SUBJECT_INPUT_SIZE = 320;

export type BackgroundQuality = 'basic' | 'advanced';
export interface BackgroundSettings {
  readonly quality: BackgroundQuality;
  readonly refineEdges: number;
  readonly matteContrast: number;
  readonly shiftEdge: number;
}

export const DEFAULT_BACKGROUND_SETTINGS: BackgroundSettings = {
  quality: 'basic', refineEdges: 12, matteContrast: 25, shiftEdge: 0,
};

export function normalizedBackgroundSettings(settings: Partial<BackgroundSettings> = {}): BackgroundSettings {
  const clamp = (value: number | undefined, low: number, high: number, fallback: number): number =>
    value !== undefined && Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : fallback;
  return {
    quality: settings.quality === 'advanced' ? 'advanced' : 'basic',
    refineEdges: clamp(settings.refineEdges, 0, 40, 12),
    matteContrast: clamp(settings.matteContrast, 0, 100, 25),
    shiftEdge: clamp(settings.shiftEdge, -10, 10, 0),
  };
}

/** U²-Net's official 320px RGB/ImageNet preprocessing (`data_loader.ToTensorLab`, flag 0). */
export function preprocessU2Net(rgba: Uint8Array, width: number, height: number): Float32Array {
  if (rgba.length !== width * height * 4) throw new RangeError('RGBA buffer size mismatch');
  const size = SUBJECT_INPUT_SIZE, plane = size * size;
  const result = new Float32Array(plane * 3);
  let maximum = 0;
  for (let i = 0; i < rgba.length; i += 4) maximum = Math.max(maximum, rgba[i]!, rgba[i + 1]!, rgba[i + 2]!);
  const scale = maximum > 0 ? 1 / maximum : 0;
  const means = [0.485, 0.456, 0.406] as const, deviations = [0.229, 0.224, 0.225] as const;
  const sx = width / size, sy = height / size;
  for (let y = 0; y < size; y++) {
    const py = (y + 0.5) * sy - 0.5, y0 = Math.floor(py), fy = py - y0;
    const ay = Math.min(height - 1, Math.max(0, y0)), by = Math.min(height - 1, Math.max(0, y0 + 1));
    for (let x = 0; x < size; x++) {
      const px = (x + 0.5) * sx - 0.5, x0 = Math.floor(px), fx = px - x0;
      const ax = Math.min(width - 1, Math.max(0, x0)), bx = Math.min(width - 1, Math.max(0, x0 + 1));
      const output = y * size + x;
      for (let channel = 0; channel < 3; channel++) {
        const top = rgba[(ay * width + ax) * 4 + channel]! * (1 - fx) + rgba[(ay * width + bx) * 4 + channel]! * fx;
        const bottom = rgba[(by * width + ax) * 4 + channel]! * (1 - fx) + rgba[(by * width + bx) * 4 + channel]! * fx;
        result[channel * plane + output] = ((top * (1 - fy) + bottom * fy) * scale - means[channel]!) / deviations[channel]!;
      }
    }
  }
  return result;
}

export interface PostprocessedMask { readonly pixels: Uint8Array; readonly dynamicRange: number }

/** U²-Net's `normPRED`, followed by bilinear scaling to the layer's pixel grid. */
export function postprocessU2Net(output: Float32Array, width: number, height: number): PostprocessedMask {
  const size = SUBJECT_INPUT_SIZE;
  if (output.length !== size * size) throw new RangeError(`Expected a ${size}×${size} U²-Net output`);
  let low = Infinity, high = -Infinity;
  for (let i = 0; i < output.length; i++) { low = Math.min(low, output[i]!); high = Math.max(high, output[i]!); }
  const range = high - low;
  const normalized = new Float32Array(output.length);
  if (Number.isFinite(range) && range > 1e-6) for (let i = 0; i < output.length; i++) normalized[i] = (output[i]! - low) / range;
  return { pixels: resizeLevelsToBytes(normalized, size, size, width, height), dynamicRange: range };
}

/** SubjectRemoval.refined: guided filter, Shift Edge, then matte contrast. */
export function refineSubjectMask(raw: Uint8Array, guideRgba: Uint8Array, width: number, height: number,
  settingsValue: Partial<BackgroundSettings>, limit = Number.MAX_VALUE): Uint8Array {
  const settings = normalizedBackgroundSettings(settingsValue);
  if (settings.quality === 'basic') return raw.slice();
  let result = settings.refineEdges > 0
    ? refineGuidedMask(raw, guideRgba, width, height, settings.refineEdges, limit) : raw.slice();
  if (settings.shiftEdge !== 0) result = shiftMaskEdge(result, width, height, settings.shiftEdge);
  if (settings.matteContrast > 0) {
    const strength = settings.matteContrast / 100;
    const slope = 1 / Math.max(0.02, 1 - strength * 0.98);
    for (let i = 0; i < result.length; i++) {
      const value = result[i]! / 255 * slope + (1 - slope) / 2;
      result[i] = Math.min(255, Math.max(0, Math.floor(value * 255 + 0.5)));
    }
  }
  return result;
}

function shiftMaskEdge(source: Uint8Array, width: number, height: number, amount: number): Uint8Array {
  const sigma = Math.abs(amount) / 2;
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float32Array(radius * 2 + 1);
  let total = 0;
  for (let x = -radius; x <= radius; x++) { const value = Math.exp(-(x * x) / (2 * sigma * sigma)); kernel[x + radius] = value; total += value; }
  for (let i = 0; i < kernel.length; i++) kernel[i] = kernel[i]! / total;
  const pass = new Float32Array(source.length), blurred = new Float32Array(source.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += source[y * width + Math.min(width - 1, Math.max(0, x + k))]! * kernel[k + radius]!;
    pass[y * width + x] = sum / 255;
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += pass[Math.min(height - 1, Math.max(0, y + k)) * width + x]! * kernel[k + radius]!;
    blurred[y * width + x] = sum;
  }
  const level = amount < 0 ? 0.75 : 0.25;
  const result = new Uint8Array(source.length);
  for (let i = 0; i < result.length; i++) result[i] = Math.min(255, Math.max(0, Math.floor((blurred[i]! - level) * 1000 * 255 + 0.5)));
  return result;
}

export function multiplyMasks(first: Uint8Array, second: Uint8Array): Uint8Array {
  if (first.length !== second.length) throw new RangeError('Mask sizes do not match');
  const result = new Uint8Array(first.length);
  for (let i = 0; i < result.length; i++) result[i] = Math.round(first[i]! * second[i]! / 255);
  return result;
}
