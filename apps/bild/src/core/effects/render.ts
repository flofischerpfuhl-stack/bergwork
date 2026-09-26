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
  /** Photoshop's fixed kind stack, from drop shadow (bottom) to bevel/emboss (top). */
  readonly stackOrder: number;
}

export interface RenderEffectOptions {
  readonly globalLightAngle?: number;
  /** Cache pixels per document pixel; keeps effect padding aligned with sharp mip levels. */
  readonly rasterScale?: number;
}

/** @deprecated PSD import now creates live LayerEffect records; retained as a delegating compatibility API. */
export interface PsdInnerEffect {
  readonly kind: 'innerShadow' | 'innerGlow'; readonly opacity: number; readonly blendMode: BlendMode;
  readonly color: RGB; readonly size: number; readonly choke: number; readonly angle: number;
  readonly distance: number; readonly useGlobalLight: boolean; readonly source: 'edge' | 'center';
}

function clamp01(value: number): number { return Math.min(1, Math.max(0, value)); }
function finite(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) ? fallback : value;
}
function channel(value: number): number { return Math.round(clamp01(value) * 255); }

function solidFill(effect: Extract<LayerEffect, { kind: 'stroke' }>): EffectFill {
  return effect.fill ?? { kind: 'color', color: effect.color ?? { red: 0, green: 0, blue: 0 } };
}

interface PsdStrokePattern { readonly data: Uint8Array; readonly width: number; readonly height: number;
  readonly x: number; readonly y: number; readonly linked: boolean }

function effectContour(effect: LayerEffect, value: number): number {
  const points = effect.psdContour;
  if (!points?.length) return clamp01(value);
  const input = clamp01(value) * 255;
  let left = points[0]!, right = points[points.length - 1]!;
  for (let index = 1; index < points.length; index++) if (input <= points[index]!.x) {
    left = points[index - 1]!; right = points[index]!; break;
  }
  const amount = right.x === left.x ? 0 : clamp01((input - left.x) / (right.x - left.x));
  return clamp01((left.y + (right.y - left.y) * amount) / 255);
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

function boxBlur(values: Float32Array, width: number, height: number, radius: number): Float32Array {
  if (radius <= 0) return values;
  const horizontal = new Float32Array(values.length), output = new Float32Array(values.length);
  for (let y = 0; y < height; y++) {
    let sum = 0;
    for (let x = -radius; x <= radius; x++) sum += values[y * width + Math.min(width - 1, Math.max(0, x))]!;
    for (let x = 0; x < width; x++) {
      horizontal[y * width + x] = sum / (radius * 2 + 1);
      sum += values[y * width + Math.min(width - 1, x + radius + 1)]!
        - values[y * width + Math.max(0, x - radius)]!;
    }
  }
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let y = -radius; y <= radius; y++) sum += horizontal[Math.min(height - 1, Math.max(0, y)) * width + x]!;
    for (let y = 0; y < height; y++) {
      output[y * width + x] = sum / (radius * 2 + 1);
      sum += horizontal[Math.min(height - 1, y + radius + 1) * width + x]!
        - horizontal[Math.max(0, y - radius) * width + x]!;
    }
  }
  return output;
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
  blendMode: BlendMode, opacity: number, scalesWithFillOpacity: boolean, stackOrder: number): EffectPass {
  return { placement, raster: Raster.fromPixels(width, height, 4, rgba), sourceX: -margin, sourceY: -margin,
    blendMode, opacity: clamp01(opacity), scalesWithFillOpacity, stackOrder };
}

const EFFECT_STACK: Readonly<Record<LayerEffect['kind'], number>> = { dropShadow: 0, outerGlow: 1, colorOverlay: 2,
  gradientOverlay: 3, patternOverlay: 4, satin: 5, innerGlow: 6, innerShadow: 7, stroke: 8, bevelEmboss: 9 };

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
    else if (effect.kind === 'bevelEmboss' && effect.style !== 'innerBevel') {
      margin = Math.max(margin, Math.ceil(effect.size + effect.soften) + 2);
    }
  }
  if (enabled.some((effect) => effect.kind === 'stroke' && effect.position !== 'outside')) margin = Math.max(margin, 1);
  if (enabled.some((effect) => effect.kind === 'innerShadow' || effect.kind === 'innerGlow'
    || effect.kind === 'bevelEmboss' || effect.kind === 'satin')) margin = Math.max(margin, 1);
  const alignment = Math.max(1, Math.round(finite(options.rasterScale, 1)));
  margin = Math.ceil(margin / alignment) * alignment;
  const outWidth = width + margin * 2, outHeight = height + margin * 2;
  const source = expandedAlpha(alpha, width, height, margin);
  const solid = new Uint8Array(source.length);
  for (let i = 0; i < source.length; i++) solid[i] = source[i]! > 0 ? 1 : 0;
  let toSolid: Float32Array | null = null;
  const solidDistances = () => toSolid ??= distanceTransform(solid, outWidth, outHeight, true);
  let toOutside: Float32Array | null = null;
  const outsideDistances = () => toOutside ??= distanceTransform(solid, outWidth, outHeight, false);
  let signed: Float32Array | null = null;
  const bevelReach = enabled.reduce((reach, effect) => effect.kind === 'bevelEmboss'
    ? Math.max(reach, effect.size + effect.soften + 1) : reach, 1);
  const signedDistances = () => signed ??= signedDistance(source, outWidth, outHeight, bevelReach);
  const behind: EffectPass[] = [], above: EffectPass[] = [];

  for (const effect of enabled) {
    const stackOrder = EFFECT_STACK[effect.kind];
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
        coverage = effectContour(effect, coverage);
        if (effect.knockout ?? true) coverage *= 1 - source[y * outWidth + x]! / 255;
        putPixel(rgba, (y * outWidth + x) * 4, effect.color, coverage, x - margin, y - margin, width, height);
      }
      behind.push(pass(rgba, outWidth, outHeight, margin, 'behind', effect.blendMode ?? 'multiply', effect.opacity, false, stackOrder));
    } else if (effect.kind === 'outerGlow') {
      const size = Math.max(0, effect.size), spread = Math.max(0, Math.min(size, size * effect.spread / 100));
      const distances = solidDistances(), softness = Math.max(1e-6, size - spread);
      for (let i = 0; i < source.length; i++) {
        if (solid[i]) continue;
        const coverage = effectContour(effect,
          size <= 0 ? 0 : distances[i]! <= spread ? 1 : clamp01(1 - (distances[i]! - spread) / softness));
        putPixel(rgba, i * 4, effect.color, coverage, i % outWidth - margin,
          Math.floor(i / outWidth) - margin, width, height);
      }
      behind.push(pass(rgba, outWidth, outHeight, margin, 'behind', effect.blendMode, effect.opacity, false, stackOrder));
    } else if (effect.kind === 'innerShadow' || effect.kind === 'innerGlow') {
      const distances = outsideDistances(), size = Math.max(0, effect.size);
      const choke = Math.max(0, Math.min(size, size * effect.choke / 100));
      const softness = Math.max(1e-6, size - choke);
      const angle = effect.kind === 'innerShadow'
        ? (effect.useGlobalLight ? finite(options.globalLightAngle, DEFAULT_GLOBAL_LIGHT_ANGLE) : effect.angle) * Math.PI / 180 : 0;
      const dx = effect.kind === 'innerShadow' ? -Math.cos(angle) * effect.distance : 0;
      const dy = effect.kind === 'innerShadow' ? Math.sin(angle) * effect.distance : 0;
      for (let y = 0; y < outHeight; y++) for (let x = 0; x < outWidth; x++) {
        const index = y * outWidth + x, shape = source[index]! / 255;
        if (shape <= 0) continue;
        const distance = sampleDistance(distances, outWidth, outHeight, x - dx, y - dy);
        let coverage: number;
        if (effect.kind === 'innerGlow' && effect.source === 'center') {
          coverage = size <= 0 ? 0 : distance <= choke ? 0 : clamp01((distance - choke) / softness);
        } else coverage = size <= 0 ? 0 : distance <= choke ? 1 : clamp01(1 - (distance - choke) / softness);
        coverage = effectContour(effect, coverage);
        putPixel(rgba, index * 4, effect.color, coverage * shape, x - margin, y - margin, width, height);
      }
      above.push(pass(rgba, outWidth, outHeight, margin, 'above', effect.blendMode, effect.opacity, false, stackOrder));
    } else if (effect.kind === 'bevelEmboss') {
      const distances = signedDistances(), highlight = new Uint8Array(rgba.length), shadow = new Uint8Array(rgba.length);
      const size = Math.max(0.5, effect.size + effect.soften), radians =
        (effect.useGlobalLight ? finite(options.globalLightAngle, DEFAULT_GLOBAL_LIGHT_ANGLE) : effect.angle) * Math.PI / 180;
      const normals = effect.technique === 'smooth'
        ? boxBlur(distances, outWidth, outHeight, Math.min(16, Math.max(1, Math.round(size / 8)))) : distances;
      const lx = Math.cos(radians), ly = -Math.sin(radians), altitude = effect.altitude * Math.PI / 180;
      const lightScale = Math.cos(altitude), depth = effect.depth / 100;
      for (let y = 0; y < outHeight; y++) for (let x = 0; x < outWidth; x++) {
        const index = y * outWidth + x, distance = distances[index]!;
        const inner = distance <= 0 && distance >= -size, outer = distance >= 0 && distance <= size;
        const included = effect.style === 'innerBevel' ? inner : effect.style === 'outerBevel' ? outer : inner || outer;
        if (!included) continue;
        let profile = clamp01(1 - Math.abs(distance) / size);
        if (effect.technique === 'chiselHard') profile = profile > 0 ? 1 : 0;
        else if (effect.technique === 'chiselSoft') profile *= profile;
        const left = normals[y * outWidth + Math.max(0, x - 1)]!;
        const right = normals[y * outWidth + Math.min(outWidth - 1, x + 1)]!;
        const top = normals[Math.max(0, y - 1) * outWidth + x]!;
        const bottom = normals[Math.min(outHeight - 1, y + 1) * outWidth + x]!;
        const gx = right - left, gy = bottom - top, length = Math.max(1e-6, Math.hypot(gx, gy));
        let lighting = (gx / length * lx + gy / length * ly) * lightScale;
        if (effect.style === 'pillowEmboss' && outer) lighting = -lighting;
        if (effect.direction === 'down') lighting = -lighting;
        const amount = clamp01(effectContour(effect, Math.abs(lighting)) * profile * depth)
          * (source[index]! / 255 || (outer ? 1 : 0));
        if (lighting >= 0) putPixel(highlight, index * 4, effect.highlightColor, amount, x - margin, y - margin, width, height);
        else putPixel(shadow, index * 4, effect.shadowColor, amount, x - margin, y - margin, width, height);
      }
      above.push(pass(highlight, outWidth, outHeight, margin, 'above', effect.highlightMode, effect.highlightOpacity, false, stackOrder));
      above.push(pass(shadow, outWidth, outHeight, margin, 'above', effect.shadowMode, effect.shadowOpacity, false, stackOrder));
    } else if (effect.kind === 'satin') {
      const distances = outsideDistances(), radians = effect.angle * Math.PI / 180;
      const dx = Math.cos(radians) * effect.distance, dy = -Math.sin(radians) * effect.distance;
      const falloff = (distance: number) => effect.size <= 0 ? 0 : clamp01(1 - distance / effect.size);
      for (let y = 0; y < outHeight; y++) for (let x = 0; x < outWidth; x++) {
        const index = y * outWidth + x, shape = source[index]! / 255;
        if (!shape) continue;
        let coverage = Math.abs(falloff(sampleDistance(distances, outWidth, outHeight, x - dx, y - dy))
          - falloff(sampleDistance(distances, outWidth, outHeight, x + dx, y + dy)));
        if (effect.invert) coverage = 1 - coverage;
        coverage = effectContour(effect, coverage);
        putPixel(rgba, index * 4, effect.color, coverage * shape, x - margin, y - margin, width, height);
      }
      above.push(pass(rgba, outWidth, outHeight, margin, 'above', effect.blendMode, effect.opacity, false, stackOrder));
    } else if (effect.kind === 'stroke') {
      const radius = Math.max(0, effect.width), fill = solidFill(effect);
      const pattern = (effect as typeof effect & { readonly psdPattern?: PsdStrokePattern }).psdPattern;
      const low = effect.position === 'inside' ? -radius : effect.position === 'center' ? -radius / 2 : 0;
      const high = effect.position === 'inside' ? 0 : effect.position === 'center' ? radius / 2 : radius;
      const distances = radius > 0 ? signedDistance(source, outWidth, outHeight, Math.max(Math.abs(low), Math.abs(high)) + 1)
        : null;
      for (let i = 0; i < source.length; i++) {
        const coverage = distances ? distanceBand(distances[i]!, low, high) : 0;
        if (pattern && pattern.width > 0 && pattern.height > 0) {
          const localX = i % outWidth - margin, localY = Math.floor(i / outWidth) - margin;
          const px = ((Math.floor(localX) - pattern.x) % pattern.width + pattern.width) % pattern.width;
          const py = ((Math.floor(localY) - pattern.y) % pattern.height + pattern.height) % pattern.height;
          const sourceAt = (py * pattern.width + px) * 4, target = i * 4;
          rgba[target] = pattern.data[sourceAt]!; rgba[target + 1] = pattern.data[sourceAt + 1]!;
          rgba[target + 2] = pattern.data[sourceAt + 2]!;
          rgba[target + 3] = Math.round(clamp01(coverage) * pattern.data[sourceAt + 3]!);
        } else putPixel(rgba, i * 4, fill, coverage, i % outWidth - margin,
          Math.floor(i / outWidth) - margin, width, height);
      }
      above.push(pass(rgba, outWidth, outHeight, margin, 'above', effect.blendMode ?? 'normal', effect.opacity ?? 1, false, stackOrder));
    } else if (effect.kind === 'colorOverlay' || effect.kind === 'gradientOverlay') {
      const fill: EffectFill = effect.kind === 'colorOverlay' ? { kind: 'color', color: effect.color }
        : { kind: 'gradient', gradient: effect.gradient, angle: effect.angle, scale: effect.scale };
      for (let y = 0; y < outHeight; y++) for (let x = 0; x < outWidth; x++) {
        const coverage = source[y * outWidth + x]! / 255;
        putPixel(rgba, (y * outWidth + x) * 4, fill, coverage, x - margin, y - margin, width, height);
      }
      above.push(pass(rgba, outWidth, outHeight, margin, 'above', effect.blendMode ?? 'normal', effect.opacity, true, stackOrder));
    }
  }
  return [...behind.sort((a, b) => a.stackOrder - b.stackOrder), ...above.sort((a, b) => a.stackOrder - b.stackOrder)];
}

/** @deprecated Delegates old callers to the live effect renderer. */
export function renderPsdInnerEffectPasses(alpha: Uint8Array, width: number, height: number,
  effects: readonly PsdInnerEffect[], options: RenderEffectOptions = {}): readonly EffectPass[] {
  return renderEffectPasses(alpha, width, height, effects.map((effect) => effect.kind === 'innerShadow'
    ? { kind: 'innerShadow', schemaVersion: 1, enabled: true, opacity: effect.opacity, blendMode: effect.blendMode,
      color: effect.color, size: effect.size, choke: effect.choke, angle: effect.angle, distance: effect.distance,
      useGlobalLight: effect.useGlobalLight, contour: 'linear' }
    : { kind: 'innerGlow', schemaVersion: 1, enabled: true, opacity: effect.opacity, blendMode: effect.blendMode,
      color: effect.color, size: effect.size, choke: effect.choke, source: effect.source, contour: 'linear' }), options);
}
