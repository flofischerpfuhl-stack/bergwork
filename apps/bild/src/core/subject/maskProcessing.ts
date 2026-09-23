import { refineGuidedMask, resizeLevelsToBytes } from './guidedMatte';

export const SUBJECT_INPUT_SIZE = 320;
export const BIREFNET_INPUT_SIZE = 1024;

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

/** Official BiRefNet ImageNet preprocessing: RGB / 255, then channel normalization at 1024². */
export function preprocessBiRefNet(rgba: Uint8Array, width: number, height: number): Float32Array {
  if (rgba.length !== width * height * 4) throw new RangeError('RGBA buffer size mismatch');
  const size = BIREFNET_INPUT_SIZE, plane = size * size;
  const result = new Float32Array(plane * 3);
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
        result[channel * plane + output] = ((top * (1 - fy) + bottom * fy) / 255 - means[channel]!) / deviations[channel]!;
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

/** BiRefNet emits full-resolution logits; sigmoid produces its soft alpha matte. */
export function postprocessBiRefNet(output: Float32Array, width: number, height: number): PostprocessedMask {
  const size = BIREFNET_INPUT_SIZE;
  if (output.length !== size * size) throw new RangeError(`Expected a ${size}×${size} BiRefNet output`);
  const levels = new Float32Array(output.length);
  let low = Infinity, high = -Infinity;
  for (let i = 0; i < output.length; i++) {
    const logit = output[i]!;
    const value = logit >= 0 ? 1 / (1 + Math.exp(-logit)) : Math.exp(logit) / (1 + Math.exp(logit));
    levels[i] = value; low = Math.min(low, value); high = Math.max(high, value);
  }
  return { pixels: resizeLevelsToBytes(levels, size, size, width, height), dynamicRange: high - low };
}

/**
 * Counts 8-connected foreground instances without removing any. Only two label rows and O(width)
 * union storage are retained, so a 100 Mpx document does not need a second full-size visited map.
 * This approximates Vision's `allInstances` after the combined instance mask is generated.
 */
export function countMaskComponents(mask: Uint8Array, width: number, height: number, threshold = 127): number {
  if (mask.length !== width * height) throw new RangeError('Mask buffer size mismatch');
  let previous = new Uint32Array(width), current = new Uint32Array(width);
  const parent = new Uint32Array(width + 2), remap = new Uint32Array(width + 2);
  let previousCount = 0, completed = 0;

  for (let y = 0; y < height; y++) {
    current.fill(0); remap.fill(0);
    let nextLabel = previousCount;
    for (let i = 1; i <= previousCount; i++) parent[i] = i;
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (mask[row + x]! <= threshold) continue;
      let label = 0;
      const left = x > 0 ? current[x - 1]! : 0;
      const upperLeft = x > 0 ? previous[x - 1]! : 0;
      const upper = previous[x]!;
      const upperRight = x + 1 < width ? previous[x + 1]! : 0;
      if (left) label = rootLabel(parent, left);
      if (upperLeft) label = mergeLabels(label, upperLeft, parent);
      if (upper) label = mergeLabels(label, upper, parent);
      if (upperRight) label = mergeLabels(label, upperRight, parent);
      if (!label) { label = ++nextLabel; parent[label] = label; }
      current[x] = label;
    }

    let currentCount = 0;
    for (let x = 0; x < width; x++) {
      const label = current[x]!;
      if (!label) continue;
      const canonical = rootLabel(parent, label);
      if (!remap[canonical]) remap[canonical] = ++currentCount;
      current[x] = remap[canonical]!;
    }
    for (let label = 1; label <= previousCount; label++) {
      if (rootLabel(parent, label) === label && remap[label] === 0) completed++;
    }
    const swap = previous; previous = current; current = swap;
    previousCount = currentCount;
  }
  return completed + previousCount;
}

function rootLabel(parent: Uint32Array, label: number): number {
  let value = label;
  while (parent[value] !== value) value = parent[value]!;
  while (label !== value) { const next = parent[label]!; parent[label] = value; label = next; }
  return value;
}

function mergeLabels(first: number, second: number, parent: Uint32Array): number {
  const right = rootLabel(parent, second);
  if (!first) return right;
  const left = rootLabel(parent, first);
  if (left === right) return left;
  const keep = Math.min(left, right), merge = Math.max(left, right);
  parent[merge] = keep;
  return keep;
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
