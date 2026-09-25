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
  /** Cache pixels per document pixel; keeps effect padding aligned with sharp mip levels. */
  readonly rasterScale?: number;
}

export interface PsdInnerEffect {
  readonly kind: 'innerShadow' | 'innerGlow';
  readonly opacity: number;
  readonly blendMode: BlendMode;
  readonly color: RGB;
  readonly size: number;
  readonly choke: number;
  readonly angle: number;
  readonly distance: number;
  readonly useGlobalLight: boolean;
  readonly source: 'edge' | 'center';
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

/**
 * Photoshop locates a stroke boundary from coverage, not an alpha > 0 silhouette. This follows
 * psd-tools' `_signed_distance`/`_distance_band`: a partial pixel states a boundary 0.5-alpha
 * pixels from its centre, while exact 0/1 steps retain the Euclidean half-pixel boundary.
 */
function signedDistance(alpha: Uint8Array, width: number, height: number, reach: number): Float32Array {
  const count = alpha.length, inside = new Uint8Array(count), partial = new Uint8Array(count);
  let partialCount = 0;
  for (let i = 0; i < count; i++) {
    inside[i] = alpha[i]! >= 128 ? 1 : 0;
    if (alpha[i]! > 0 && alpha[i]! < 255) { partial[i] = 1; partialCount++; }
  }
  const toInside = distanceTransform(inside, width, height, true);
  const toOutside = distanceTransform(inside, width, height, false);
  const base = new Float32Array(count);
  for (let i = 0; i < count; i++) base[i] = inside[i] ? -(toOutside[i]! - 0.5) : toInside[i]! - 0.5;
  if (!partialCount) return base;

  const hard = new Uint8Array(count);
  let hardCount = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x, value = alpha[i]!;
    if (value !== 0 && value !== 255) continue;
    const opposite = value === 0 ? 255 : 0;
    if ((x > 0 && alpha[i - 1] === opposite) || (x + 1 < width && alpha[i + 1] === opposite)
      || (y > 0 && alpha[i - width] === opposite) || (y + 1 < height && alpha[i + width] === opposite)) {
      hard[i] = 1; hardCount++;
    }
  }
  const toPartial = distanceTransform(partial, width, height, true);
  const toHard = hardCount ? distanceTransform(hard, width, height, true) : null;
  const span = Math.ceil(reach), output = base.slice();
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x;
    if (partial[i]) { output[i] = 0.5 - alpha[i]! / 255; continue; }
    if (toPartial[i]! > reach || (toHard && toPartial[i]! > toHard[i]!)) continue;
    let nearest = inside[i] ? -Infinity : Infinity;
    const top = Math.max(0, y - span), bottom = Math.min(height - 1, y + span);
    const left = Math.max(0, x - span), right = Math.min(width - 1, x + span);
    for (let sy = top; sy <= bottom; sy++) for (let sx = left; sx <= right; sx++) {
      const sourceIndex = sy * width + sx;
      if (!partial[sourceIndex]) continue;
      const distance = Math.hypot(sx - x, sy - y);
      if (distance > reach) continue;
      const stated = 0.5 - alpha[sourceIndex]! / 255;
      if (inside[i]) nearest = Math.max(nearest, stated - distance);
      else nearest = Math.min(nearest, stated + distance);
    }
    if (Number.isFinite(nearest)) output[i] = nearest;
  }
  return output;
}

function distanceBand(distance: number, low: number, high: number): number {
  return clamp01(high - distance + 0.5) * clamp01(distance - low + 0.5);
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
  const alignment = Math.max(1, Math.round(finite(options.rasterScale, 1)));
  margin = Math.ceil(margin / alignment) * alignment;
  const outWidth = width + margin * 2, outHeight = height + margin * 2;
  const source = expandedAlpha(alpha, width, height, margin);
  const solid = new Uint8Array(source.length);
  for (let i = 0; i < source.length; i++) solid[i] = source[i]! > 0 ? 1 : 0;
  let toSolid: Float32Array | null = null;
  const solidDistances = () => toSolid ??= distanceTransform(solid, outWidth, outHeight, true);
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
      const radius = Math.max(0, effect.width), fill = solidFill(effect);
      const low = effect.position === 'inside' ? -radius : effect.position === 'center' ? -radius / 2 : 0;
      const high = effect.position === 'inside' ? 0 : effect.position === 'center' ? radius / 2 : radius;
      const distances = radius > 0 ? signedDistance(source, outWidth, outHeight, Math.max(Math.abs(low), Math.abs(high)) + 1)
        : null;
      for (let i = 0; i < source.length; i++) {
        const coverage = distances ? distanceBand(distances[i]!, low, high) : 0;
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

/** Photoshop inner styles are clipped to the source shape and rendered above its fill. */
export function renderPsdInnerEffectPasses(alpha: Uint8Array, width: number, height: number,
  effects: readonly PsdInnerEffect[], options: RenderEffectOptions = {}): readonly EffectPass[] {
  if (!effects.length) return [];
  const solid = Uint8Array.from(alpha, (value) => value > 0 ? 1 : 0);
  const toOutside = distanceTransform(solid, width, height, false), output: EffectPass[] = [];
  for (const effect of effects) {
    const rgba = new Uint8Array(width * height * 4), size = Math.max(0, effect.size);
    const spread = Math.max(0, Math.min(size, size * effect.choke / 100));
    const softness = Math.max(1e-6, size - spread);
    const angle = (effect.useGlobalLight ? finite(options.globalLightAngle, DEFAULT_GLOBAL_LIGHT_ANGLE) : effect.angle) * Math.PI / 180;
    const dx = -Math.cos(angle) * effect.distance, dy = Math.sin(angle) * effect.distance;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const index = y * width + x, shape = alpha[index]! / 255;
      if (shape <= 0) continue;
      let coverage: number;
      if (effect.kind === 'innerGlow' && effect.source === 'center') {
        const maximum = Math.max(1e-6, Math.hypot(width, height) / 2);
        coverage = clamp01(toOutside[index]! / Math.min(maximum, Math.max(1e-6, size)));
      } else {
        const distance = sampleDistance(toOutside, width, height,
          effect.kind === 'innerShadow' ? x - dx : x, effect.kind === 'innerShadow' ? y - dy : y);
        coverage = size <= 0 ? 0 : distance <= spread ? 1 : clamp01(1 - (distance - spread) / softness);
      }
      putPixel(rgba, index * 4, effect.color, coverage * shape, x, y, width, height);
    }
    output.push(pass(rgba, width, height, 0, 'above', effect.blendMode, effect.opacity, false));
  }
  return output;
}
