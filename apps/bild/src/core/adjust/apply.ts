/** CPU adjustment-layer applier. The input/output is straight sRGB float RGBA. */
import type { DocumentResource, LayerAdjustment } from '../document';
import { resolveAdjustment, type ExposureSettings, type GrainSettings, type GradientMapSettings, type HueSaturationSettings } from '../adjustments';
import { basicColor } from './basic';
import { colourLuminance, colourPanelColor } from './colour';
import { lookupCube, parseCubeLut, type CubeLut } from './cube';
import { adjustHueColor, hueResponse } from './hue';
import { curvesTables, levelsTables } from './levels';

export type AdjustmentApplier = (adjustment: LayerAdjustment, rgba: Float32Array,
  width: number, height: number, originX: number, originY: number, resources?: readonly DocumentResource[]) => Float32Array;

function clamp01(value: number): number { return Math.min(1, Math.max(0, value)); }
function tableLookup(table: Float32Array, channel: number, value: number): number {
  const x = clamp01(value) * 255, lo = Math.floor(x), hi = Math.min(255, lo + 1), t = x - lo, offset = channel * 256;
  return table[offset + lo]! + (table[offset + hi]! - table[offset + lo]!) * t;
}
export function linearFromSrgb(v: number): number { return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }
export function srgbFromLinear(v: number): number { return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055; }
export function exposureValue(value: number, settings: ExposureSettings): number {
  const linear = Math.max(0, linearFromSrgb(clamp01(value)) * 2 ** settings.exposure + settings.offset) ** (1 / settings.gamma);
  return clamp01(srgbFromLinear(linear));
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

function brightnessContrast(value: number, brightness: number, contrast: number, legacy: boolean): number {
  if (legacy) return clamp01((value - 0.5) * (1 + contrast / 100) + 0.5 + brightness / 255);
  const shifted = clamp01(value + brightness / 200);
  const factor = Math.tan((Math.min(100, Math.max(-100, contrast)) + 100) * Math.PI / 400);
  return clamp01((shifted - 0.5) * factor + 0.5);
}

export const applyAdjustment: AdjustmentApplier = (adjustment, rgba, width, height, originX, originY, resources) => {
  if (rgba.length !== width * height * 4) throw new RangeError('Adjustment buffer size mismatch');
  const a = resolveAdjustment(adjustment), out = rgba.slice();
  const table = a.kind === 'Levels' ? levelsTables(a.levels) : a.kind === 'Curves' ? curvesTables(a.curves)
    : a.kind === 'Exposure' ? exposureTables(a.exposureSettings) : null;
  const cube = a.kind === 'Hue/Saturation' ? hueCube(a.hsvSettings) : null;
  const lookup = adjustment.kind === 'Colour Lookup' ? resourceCube(adjustment.parameters.resourceId, resources) : null;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    if (out[i + 3]! <= 0) continue;
    let r = out[i]!, g = out[i + 1]!, b = out[i + 2]!;
    if (adjustment.kind === 'Basic') [r, g, b] = basicColor(r, g, b, adjustment.parameters);
    else if (lookup && adjustment.kind === 'Colour Lookup') [r, g, b] = lookupCube(lookup, r, g, b, adjustment.parameters.interpolation);
    else if (adjustment.kind === 'Colour') [r, g, b] = colourPanelColor(r, g, b, adjustment.parameters);
    else if (adjustment.kind === 'Invert') { r = 1 - r; g = 1 - g; b = 1 - b; }
    else if (adjustment.kind === 'Threshold') {
      const value = colourLuminance(r, g, b) * 255 >= adjustment.parameters.level ? 1 : 0; r = g = b = value;
    } else if (adjustment.kind === 'Posterize') {
      const steps = adjustment.parameters.levels - 1;
      r = Math.round(clamp01(r) * steps) / steps; g = Math.round(clamp01(g) * steps) / steps; b = Math.round(clamp01(b) * steps) / steps;
    } else if (adjustment.kind === 'Brightness/Contrast') {
      const p = adjustment.parameters;
      r = brightnessContrast(r, p.brightness, p.contrast, p.legacy);
      g = brightnessContrast(g, p.brightness, p.contrast, p.legacy);
      b = brightnessContrast(b, p.brightness, p.contrast, p.legacy);
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
    out[i] = r; out[i + 1] = g; out[i + 2] = b;
  }
  return out;
};
