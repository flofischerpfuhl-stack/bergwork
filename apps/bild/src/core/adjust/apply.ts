/** CPU adjustment-layer applier. The input/output is straight sRGB float RGBA. */
import type { DocumentResource, LayerAdjustment } from '../document';
import { resolveAdjustment, type ExposureSettings, type GrainSettings, type GradientMapSettings, type HueSaturationSettings } from '../adjustments';
import { basicColor } from './basic';
import { colourLuminance, colourPanelColor } from './colour';
import { lookupCube, parseCubeLut, type CubeLut } from './cube';
import { adjustHueColor, hueResponse } from './hue';
import { curvesTables, levelsTables } from './levels';
import { linearToSrgb, srgbToLinear } from '../pixel/color';

export type AdjustmentApplier = (adjustment: LayerAdjustment, rgba: Float32Array,
  width: number, height: number, originX: number, originY: number, resources?: readonly DocumentResource[]) => Float32Array;

function clamp01(value: number): number { return Math.min(1, Math.max(0, value)); }
function tableLookup(table: Float32Array, channel: number, value: number): number {
  const x = clamp01(value) * 255, lo = Math.floor(x), hi = Math.min(255, lo + 1), t = x - lo, offset = channel * 256;
  return table[offset + lo]! + (table[offset + hi]! - table[offset + lo]!) * t;
}
export function exposureValue(value: number, settings: ExposureSettings): number {
  const linear = Math.max(0, srgbToLinear(clamp01(value)) * 2 ** settings.exposure + settings.offset) ** (1 / settings.gamma);
  return clamp01(linearToSrgb(linear));
}
function exposureTables(settings: ExposureSettings): Float32Array {
  const table = new Float32Array(768);
  for (let c = 0; c < 3; c++) for (let i = 0; i < 256; i++) table[c * 256 + i] = exposureValue(i / 255, settings);
  return table;
}

export function gradientMapColor(r: number, g: number, b: number, settings: GradientMapSettings): [number, number, number] {
  const dark = settings.reversed ? settings.highlights : settings.shadows;
  const light = settings.reversed ? settings.shadows : settings.highlights;
  const level = clamp01(0.2126 * r + 0.7152 * g + 0.0722 * b);
  return [dark.red + (light.red - dark.red) * level, dark.green + (light.green - dark.green) * level,
    dark.blue + (light.blue - dark.blue) * level];
}

function mix32(value: number): number {
  let x = value >>> 0; x ^= x >>> 16; x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15; x = Math.imul(x, 0x846ca68b) >>> 0; x ^= x >>> 16; return x >>> 0;
}
function lattice(x: number, y: number, seed: number): number {
  const h = mix32((Math.imul(x | 0, 0x9e3779b1) ^ mix32((Math.imul(y | 0, 0x85ebca77) ^ seed) >>> 0)) >>> 0);
  return (h & 0xffff) / 65535 + (h >>> 16) / 65535 - 1;
}
export function grainDelta(r: number, g: number, b: number, x: number, y: number, settings: GrainSettings): number {
  if (!(settings.amount > 0)) return 0;
  const size = settings.size > 0 ? settings.size : 1, cellX = Math.floor(x / size), cellY = Math.floor(y / size);
  let tx = x / size - cellX, ty = y / size - cellY;
  tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty);
  const n00 = lattice(cellX, cellY, settings.seed), n10 = lattice(cellX + 1, cellY, settings.seed);
  const n01 = lattice(cellX, cellY + 1, settings.seed), n11 = lattice(cellX + 1, cellY + 1, settings.seed);
  const smooth = ((n00 + (n10 - n00) * tx) + ((n01 + (n11 - n01) * tx) - (n00 + (n10 - n00) * tx)) * ty) * 1.6;
  const fine = lattice(Math.floor(x), Math.floor(y), mix32((settings.seed ^ 0xa511e9b3) >>> 0));
  const rough = clamp01(settings.roughness / 100), noise = smooth + (fine - smooth) * rough;
  const level = clamp01(0.2126 * r + 0.7152 * g + 0.0722 * b);
  return noise * Math.min(1, settings.amount / 100) * 0.35 * (0.4 + 2.4 * level * (1 - level));
}

const HUE_CUBE_DIMENSION = 33;
const hueCubeCache = new WeakMap<object, Float32Array>();
/** The 33³ CIColorCube used upstream; alpha is omitted because it is always one. */
export function hueCube(settings: HueSaturationSettings): Float32Array {
  const cached = hueCubeCache.get(settings as object); if (cached) return cached;
  const response = hueResponse(settings), n = HUE_CUBE_DIMENSION, out = new Float32Array(n * n * n * 3);
  let offset = 0;
  for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) {
    const color = adjustHueColor(r / (n - 1), g / (n - 1), b / (n - 1), settings, response);
    out[offset++] = color[0]; out[offset++] = color[1]; out[offset++] = color[2];
  }
  hueCubeCache.set(settings as object, out); return out;
}
function cubeColor(cube: Float32Array, r: number, g: number, b: number): [number, number, number] {
  const n = HUE_CUBE_DIMENSION, x = clamp01(r) * (n - 1), y = clamp01(g) * (n - 1), z = clamp01(b) * (n - 1);
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z), x1 = Math.min(n - 1, x0 + 1), y1 = Math.min(n - 1, y0 + 1), z1 = Math.min(n - 1, z0 + 1);
  const tx = x - x0, ty = y - y0, tz = z - z0, output: [number, number, number] = [0, 0, 0];
  for (let dz = 0; dz < 2; dz++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
    const ix = dx ? x1 : x0, iy = dy ? y1 : y0, iz = dz ? z1 : z0;
    const weight = (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty) * (dz ? tz : 1 - tz), i = ((iz * n + iy) * n + ix) * 3;
    output[0] += cube[i]! * weight; output[1] += cube[i + 1]! * weight; output[2] += cube[i + 2]! * weight;
  }
  return output;
}

const cubeCache = new WeakMap<Uint8Array, CubeLut>();
function resourceCube(id: string, resources: readonly DocumentResource[] | undefined): CubeLut | null {
  const resource = resources?.find((value) => value.id === id && value.role === 'lut');
  if (!resource) return null;
  let lut = cubeCache.get(resource.bytes);
  if (!lut) { lut = parseCubeLut(resource.bytes); cubeCache.set(resource.bytes, lut); }
  return lut;
}

function naturalSpline(points: readonly { readonly x: number; readonly y: number }[], x: number): number {
  if (x <= points[0]!.x) return points[0]!.y;
  if (x >= points.at(-1)!.x) return points.at(-1)!.y;
  const second = new Float64Array(points.length), work = new Float64Array(points.length - 1);
  for (let i = 1; i < points.length - 1; i++) {
    const before = points[i - 1]!, current = points[i]!, after = points[i + 1]!;
    const span = after.x - before.x, sigma = (current.x - before.x) / span;
    const pivot = sigma * second[i - 1]! + 2;
    second[i] = (sigma - 1) / pivot;
    work[i] = (6 * ((after.y - current.y) / (after.x - current.x)
      - (current.y - before.y) / (current.x - before.x)) / span - sigma * work[i - 1]!) / pivot;
  }
  for (let i = points.length - 2; i >= 0; i--) second[i] = second[i]! * second[i + 1]! + work[i]!;
  let index = 0;
  while (index + 2 < points.length && x > points[index + 1]!.x) index++;
  const left = points[index]!, right = points[index + 1]!, width = right.x - left.x;
  const a = (right.x - x) / width, b = (x - left.x) / width;
  return a * left.y + b * right.y + ((a ** 3 - a) * second[index]!
    + (b ** 3 - b) * second[index + 1]!) * width * width / 6;
}

/** Photoshop's modern Brightness/Contrast is a composed spline, not an affine contrast pivot. */
function brightnessContrastTable(brightness: number, contrast: number, legacy: boolean): Float32Array {
  const table = new Float32Array(256);
  if (legacy) {
    for (let i = 0; i < 256; i++) table[i] = clamp01((i / 255 - 0.5) * (1 + contrast / 100) + 0.5 + brightness / 255);
    return table;
  }
  const c = Math.min(100, Math.max(-100, contrast)) / 100;
  const controls = [0, 63 / 255, 191 / 255, 1].map((x, index) => ({ x,
    y: index === 1 ? x - c * 25 / 255 : index === 2 ? x + c * 25 / 255 : x }));
  const b = Math.min(1, Math.max(-1, brightness / 150)), magnitude = Math.abs(b);
  const curve = new Float64Array(256), rotatedX = new Float64Array(256), rotatedY = new Float64Array(256);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    const polynomial = (a: number, power: number): number => a * t ** power;
    const h = 0.5 * (magnitude * (polynomial(1.65, 0.35) + polynomial(-1, 10))
      + (1 - magnitude) * (polynomial(1.96, 0.4) + polynomial(1, 4)) + polynomial(1, 1.25));
    curve[i] = b * t * (1 - t) * h;
    rotatedX[i] = t - curve[i]!;
    rotatedY[i] = naturalSpline(controls, t) + curve[i]!;
  }
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let left = 0;
    while (left < 254 && rotatedX[left + 1]! < t) left++;
    const span = rotatedX[left + 1]! - rotatedX[left]!;
    const amount = span > 1e-12 ? (t - rotatedX[left]!) / span : 0;
    table[i] = clamp01(rotatedY[left]! + (rotatedY[left + 1]! - rotatedY[left]!) * amount);
  }
  return table;
}

function brightnessContrast(value: number, table: Float32Array): number {
  const position = clamp01(value) * 255, low = Math.floor(position), high = Math.min(255, low + 1);
  return table[low]! + (table[high]! - table[low]!) * (position - low);
}

export const applyAdjustment: AdjustmentApplier = (adjustment, rgba, width, height, originX, originY, resources) => {
  if (rgba.length !== width * height * 4) throw new RangeError('Adjustment buffer size mismatch');
  const a = resolveAdjustment(adjustment), out = rgba.slice();
  const table = a.kind === 'Levels' ? levelsTables(a.levels) : a.kind === 'Curves' ? curvesTables(a.curves)
    : a.kind === 'Exposure' ? exposureTables(a.exposureSettings) : null;
  const cube = a.kind === 'Hue/Saturation' ? hueCube(a.hsvSettings) : null;
  const brightnessTable = adjustment.kind === 'Brightness/Contrast'
    ? brightnessContrastTable(adjustment.parameters.brightness, adjustment.parameters.contrast, adjustment.parameters.legacy) : null;
  const lookup = adjustment.kind === 'Colour Lookup' ? resourceCube(adjustment.parameters.resourceId, resources) : null;
  const psd = adjustment as LayerAdjustment & { readonly psdColorMode?: number; readonly psdBitsPerChannel?: number };
  const nativeGray = psd.psdColorMode === 1 && (adjustment.kind === 'Levels' || adjustment.kind === 'Curves');
  const decodeGray = (value: number): number => Math.max(0, srgbToLinear(clamp01(value))) ** (1 / 2.2);
  const encodeGray = (value: number): number => clamp01(linearToSrgb(clamp01(value) ** 2.2));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    if (out[i + 3]! <= 0) continue;
    let r = out[i]!, g = out[i + 1]!, b = out[i + 2]!;
    if (nativeGray) r = g = b = decodeGray((r + g + b) / 3);
    if (adjustment.kind === 'Basic') [r, g, b] = basicColor(r, g, b, adjustment.parameters);
    else if (lookup && adjustment.kind === 'Colour Lookup') [r, g, b] = lookupCube(lookup, r, g, b, adjustment.parameters.interpolation);
    else if (adjustment.kind === 'Colour') [r, g, b] = colourPanelColor(r, g, b, adjustment.parameters);
    else if (adjustment.kind === 'Invert') { r = 1 - r; g = 1 - g; b = 1 - b; }
    else if (adjustment.kind === 'Threshold') {
      // Photoshop's PSD threshold oracle uses the legacy Rec. 601 luma coefficients.
      const value = (0.299 * r + 0.587 * g + 0.114 * b) * 255 >= adjustment.parameters.level ? 1 : 0;
      r = g = b = value;
    } else if (adjustment.kind === 'Posterize') {
      const levels = Math.max(2, adjustment.parameters.levels), steps = levels - 1;
      // Photoshop partitions the input into `levels` equal bins, then maps those bins onto
      // the inclusive 0…1 output range (PSD posterize adjustment oracle).
      r = Math.min(steps, Math.floor(clamp01(r) * levels)) / steps;
      g = Math.min(steps, Math.floor(clamp01(g) * levels)) / steps;
      b = Math.min(steps, Math.floor(clamp01(b) * levels)) / steps;
    } else if (brightnessTable) {
      r = brightnessContrast(r, brightnessTable);
      g = brightnessContrast(g, brightnessTable);
      b = brightnessContrast(b, brightnessTable);
    } else if (adjustment.kind === 'Photo Filter') {
      const p = adjustment.parameters, oldLuma = colourLuminance(r, g, b), amount = p.density / 100;
      r = clamp01(r * (1 - amount) + p.color.red * amount); g = clamp01(g * (1 - amount) + p.color.green * amount);
      b = clamp01(b * (1 - amount) + p.color.blue * amount);
      if (p.preserveLuminosity) { const next = colourLuminance(r, g, b), scale = next > 1e-6 ? oldLuma / next : 1;
        r = clamp01(r * scale); g = clamp01(g * scale); b = clamp01(b * scale); }
    } else if (adjustment.kind === 'Channel Mixer') {
      const p = adjustment.parameters, mix = (c: typeof p.red): number => clamp01((r * c.red + g * c.green + b * c.blue + c.constant) / 100);
      if (p.monochrome) { const gray = mix(p.gray); r = g = b = gray; }
      else { const nr = mix(p.red), ng = mix(p.green), nb = mix(p.blue); r = nr; g = ng; b = nb; }
    }
    else if (table) { r = tableLookup(table, 0, r); g = tableLookup(table, 1, g); b = tableLookup(table, 2, b); }
    else if (cube) [r, g, b] = cubeColor(cube, r, g, b);
    else if (a.kind === 'Gradient Map') [r, g, b] = gradientMapColor(r, g, b, a.gradientMapSettings);
    else if (a.kind === 'Grain') {
      const delta = grainDelta(r, g, b, originX + x + 0.5, originY + y + 0.5, a.grainSettings);
      r = clamp01(r + delta); g = clamp01(g + delta); b = clamp01(b + delta);
    }
    if (nativeGray) r = g = b = encodeGray(r);
    out[i] = r; out[i + 1] = g; out[i + 2] = b;
  }
  return out;
};
