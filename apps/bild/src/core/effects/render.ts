import type { BlendMode, EffectFill, EffectGradient, LayerEffect, RGB } from '../model';
import { Raster } from '../raster';

export const DEFAULT_GLOBAL_LIGHT_ANGLE = 120;

export interface EffectPass {
  readonly placement: 'behind' | 'above';
  readonly raster: Raster;
  /** Location of pass pixel (0,0) in the source raster's pixel grid. */
  readonly sourceX: number;
  readonly sourceY: number;
  readonly blendMode: BlendMode;
  readonly opacity: number;
  /** Overlays are interior content and therefore follow Fill Opacity. */
  readonly scalesWithFillOpacity: boolean;
}

export interface RenderEffectOptions {
  readonly globalLightAngle?: number;
}

function clamp01(value: number): number { return Math.min(1, Math.max(0, value)); }
function finite(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) ? fallback : value;
}
function channel(value: number): number { return Math.round(clamp01(value) * 255); }

function solidFill(effect: Extract<LayerEffect, { kind: 'stroke' }>): EffectFill {
  return effect.fill ?? { kind: 'color', color: effect.color ?? { red: 0, green: 0, blue: 0 } };
}

function putPixel(output: Uint8Array, index: number, fill: EffectFill | RGB, alpha: number,
  x: number, y: number, sourceWidth: number, sourceHeight: number): void {
  let color: RGB, opacity = 1;
  if ('red' in fill) color = fill;
  else if (fill.kind === 'color') color = fill.color;
  else ({ color, opacity } = gradientColor(fill.gradient, fill.angle, fill.scale, x, y, sourceWidth, sourceHeight));
  output[index] = channel(color.red);
  output[index + 1] = channel(color.green);
  output[index + 2] = channel(color.blue);
  output[index + 3] = Math.round(clamp01(alpha * opacity) * 255);
}

function gradientColor(gradient: EffectGradient, angle: number, scale: number, x: number, y: number,
  width: number, height: number): { color: RGB; opacity: number } {
  const radians = finite(angle, 90) * Math.PI / 180;
  const dx = Math.cos(radians), dy = -Math.sin(radians);
  const span = Math.max(1e-6, (Math.abs(dx) * Math.max(0, width - 1) + Math.abs(dy) * Math.max(0, height - 1))
    * Math.max(0.01, finite(scale, 100) / 100));
  let t = 0.5 + ((x - (width - 1) / 2) * dx + (y - (height - 1) / 2) * dy) / span;
  if (gradient.reverse) t = 1 - t;
  t = clamp01(t);
  const stops = gradient.stops.length ? [...gradient.stops].sort((a, b) => a.offset - b.offset) : [
    { offset: 0, color: { red: 0, green: 0, blue: 0 }, opacity: 1 },
    { offset: 1, color: { red: 1, green: 1, blue: 1 }, opacity: 1 },
  ];
  let left = stops[0]!, right = stops[stops.length - 1]!;
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i]!.offset) { left = stops[i - 1]!; right = stops[i]!; break; }
  }
  const amount = right.offset === left.offset ? 0 : clamp01((t - left.offset) / (right.offset - left.offset));
  return { color: {
    red: left.color.red + (right.color.red - left.color.red) * amount,
    green: left.color.green + (right.color.green - left.color.green) * amount,
    blue: left.color.blue + (right.color.blue - left.color.blue) * amount,
  }, opacity: left.opacity + (right.opacity - left.opacity) * amount };
}

/** Exact squared Euclidean distance transform (Felzenszwalb/Huttenlocher), in linear time. */
function distanceTransform(solid: Uint8Array, width: number, height: number, distanceToSolid: boolean): Float32Array {
  const count = width * height, infinity = 1e20;
  let targets = 0;
  for (let i = 0; i < count; i++) if ((solid[i] !== 0) === distanceToSolid) targets++;
  if (!targets) { const absent = new Float32Array(count); absent.fill(Infinity); return absent; }
  const first = new Float32Array(count), result = new Float32Array(count);
  const max = Math.max(width, height), f = new Float64Array(max), d = new Float64Array(max);
  const v = new Int32Array(max), z = new Float64Array(max + 1);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) f[y] = (!!solid[y * width + x] === distanceToSolid) ? 0 : infinity;
    edt1d(f, d, height, v, z);
    for (let y = 0; y < height; y++) first[y * width + x] = d[y]!;
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) f[x] = first[y * width + x]!;
    edt1d(f, d, width, v, z);
    for (let x = 0; x < width; x++) result[y * width + x] = Math.sqrt(d[x]!);
  }
  return result;
}

function edt1d(f: Float64Array, d: Float64Array, length: number, v: Int32Array, z: Float64Array): void {
  let k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < length; q++) {
    let s = ((f[q]! + q * q) - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    while (s <= z[k]!) {
      k--;
      s = ((f[q]! + q * q) - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    }
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < length; q++) {
    while (z[k + 1]! < q) k++;
    const delta = q - v[k]!;
    d[q] = delta * delta + f[v[k]!]!;
  }
}

function expandedAlpha(alpha: Uint8Array, width: number, height: number, margin: number): Uint8Array {
  const outWidth = width + margin * 2, output = new Uint8Array(outWidth * (height + margin * 2));
  for (let y = 0; y < height; y++) output.set(alpha.subarray(y * width, (y + 1) * width), (y + margin) * outWidth + margin);
  return output;
}

function pass(rgba: Uint8Array, width: number, height: number, margin: number, placement: EffectPass['placement'],
  blendMode: BlendMode, opacity: number, scalesWithFillOpacity: boolean): EffectPass {
  return { placement, raster: Raster.fromPixels(width, height, 4, rgba), sourceX: -margin, sourceY: -margin,
    blendMode, opacity: clamp01(opacity), scalesWithFillOpacity };
}

function sampleNearest(values: Float32Array | Uint8Array, width: number, height: number, x: number, y: number): number {
  const px = Math.round(x), py = Math.round(y);
  return px < 0 || py < 0 || px >= width || py >= height ? 0 : values[py * width + px]!;
}

function sampleDistance(values: Float32Array, width: number, height: number, x: number, y: number): number {
  const px = Math.round(x), py = Math.round(y);
  return px < 0 || py < 0 || px >= width || py >= height ? Infinity : values[py * width + px]!;
}

/**
 * Builds independent Photoshop-style passes from post-mask alpha. Effects are derived before Fill
 * Opacity; only colour/gradient overlays opt into Fill Opacity when the passes are composited.
 */
export function renderEffectPasses(alpha: Uint8Array, width: number, height: number,
  effects: readonly LayerEffect[], options: RenderEffectOptions = {}): readonly EffectPass[] {
  if (alpha.length !== width * height) throw new RangeError('Effect alpha buffer size mismatch');
  const enabled = effects.filter((effect) => effect.enabled);
  if (!enabled.length) return [];
  let margin = 0;
  for (const effect of enabled) {
    if (effect.kind === 'dropShadow') {
      const size = Math.max(0, finite(effect.size, effect.blur));
      margin = Math.max(margin, Math.ceil(size + Math.max(0, effect.distance)) + 2);
    } else if (effect.kind === 'outerGlow') margin = Math.max(margin, Math.ceil(Math.max(0, effect.size)) + 2);
    else if (effect.kind === 'stroke' && effect.position !== 'inside') margin = Math.max(margin, Math.ceil(effect.width) + 1);
  }
  if (enabled.some((effect) => effect.kind === 'stroke' && effect.position !== 'outside')) margin = Math.max(margin, 1);
  const outWidth = width + margin * 2, outHeight = height + margin * 2;
  const source = expandedAlpha(alpha, width, height, margin);
  const solid = new Uint8Array(source.length);
  for (let i = 0; i < source.length; i++) solid[i] = source[i]! > 0 ? 1 : 0;
  let toSolid: Float32Array | null = null, toEmpty: Float32Array | null = null;
  const solidDistances = () => toSolid ??= distanceTransform(solid, outWidth, outHeight, true);
  const emptyDistances = () => toEmpty ??= distanceTransform(solid, outWidth, outHeight, false);
  const behind: EffectPass[] = [], above: EffectPass[] = [];

  for (const effect of enabled) {
    const rgba = new Uint8Array(outWidth * outHeight * 4);
    if (effect.kind === 'dropShadow') {
      const angle = (effect.useGlobalLight ? finite(options.globalLightAngle, DEFAULT_GLOBAL_LIGHT_ANGLE) : effect.angle) * Math.PI / 180;
      // Photoshop's angle denotes the light direction, hence the opposite shadow vector.
      const dx = -Math.cos(angle) * effect.distance, dy = Math.sin(angle) * effect.distance;
      const size = Math.max(0, finite(effect.size, effect.blur)), spread = Math.max(0, Math.min(size, size * finite(effect.spread, 0) / 100));
      const distances = solidDistances(), softness = Math.max(1e-6, size - spread);
      for (let y = 0; y < outHeight; y++) for (let x = 0; x < outWidth; x++) {
        const sx = x - dx, sy = y - dy;
        let coverage: number;
        if (size <= 0) coverage = sampleNearest(source, outWidth, outHeight, sx, sy) / 255;
        else {
          const distance = sampleDistance(distances, outWidth, outHeight, sx, sy);
          coverage = distance <= spread ? 1 : clamp01(1 - (distance - spread) / softness);
        }
        if (effect.knockout ?? true) coverage *= 1 - source[y * outWidth + x]! / 255;
        putPixel(rgba, (y * outWidth + x) * 4, effect.color, coverage, x - margin, y - margin, width, height);
      }
      behind.push(pass(rgba, outWidth, outHeight, margin, 'behind', effect.blendMode ?? 'multiply', effect.opacity, false));
    } else if (effect.kind === 'outerGlow') {
      const size = Math.max(0, effect.size), spread = Math.max(0, Math.min(size, size * effect.spread / 100));
      const distances = solidDistances(), softness = Math.max(1e-6, size - spread);
      for (let i = 0; i < source.length; i++) {
        if (solid[i]) continue;
        const coverage = size <= 0 ? 0 : distances[i]! <= spread ? 1 : clamp01(1 - (distances[i]! - spread) / softness);
        putPixel(rgba, i * 4, effect.color, coverage, i % outWidth - margin,
          Math.floor(i / outWidth) - margin, width, height);
      }
      behind.push(pass(rgba, outWidth, outHeight, margin, 'behind', effect.blendMode, effect.opacity, false));
    } else if (effect.kind === 'stroke') {
      const radius = Math.max(0, effect.width), outside = solidDistances(), inside = emptyDistances(), fill = solidFill(effect);
      for (let i = 0; i < source.length; i++) {
        const isSolid = solid[i] !== 0;
        let coverage = 0;
        if (effect.position === 'outside' && !isSolid) coverage = clamp01(radius + 1 - outside[i]!);
        else if (effect.position === 'inside' && isSolid) coverage = clamp01(radius + 1 - inside[i]!) * source[i]! / 255;
        else if (effect.position === 'center') {
          const half = radius / 2;
          coverage = isSolid ? clamp01(half + 1 - inside[i]!) * source[i]! / 255 : clamp01(half + 1 - outside[i]!);
        }
        putPixel(rgba, i * 4, fill, coverage, i % outWidth - margin, Math.floor(i / outWidth) - margin, width, height);
      }
      above.push(pass(rgba, outWidth, outHeight, margin, 'above', effect.blendMode ?? 'normal', effect.opacity ?? 1, false));
    } else {
      const fill: EffectFill = effect.kind === 'colorOverlay' ? { kind: 'color', color: effect.color }
        : { kind: 'gradient', gradient: effect.gradient, angle: effect.angle, scale: effect.scale };
      for (let y = 0; y < outHeight; y++) for (let x = 0; x < outWidth; x++) {
        const coverage = source[y * outWidth + x]! / 255;
        putPixel(rgba, (y * outWidth + x) * 4, fill, coverage, x - margin, y - margin, width, height);
      }
      above.push(pass(rgba, outWidth, outHeight, margin, 'above', effect.blendMode ?? 'normal', effect.opacity, true));
    }
  }
  return [...behind, ...above];
}
