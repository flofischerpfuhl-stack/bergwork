/**
 * The creative filters Compositor added after v1.0.4: Vignette, Bloom / Glow, Tonal Contrast, Progressive Blur and
 * RGB Split. Vignette and Tonal Contrast port `Rendering/AdjustPixels.c` (`adjust_colored_vignette`,
 * `adjust_tonal_contrast`) and RGB Split ports the `disperse` kernel of `Rendering/MetalDispersion.swift`, all from the
 * MIT-licensed Compositor. Its Core Image steps (CIBloom, CIMaskedVariableBlur) are rebuilt from the layer Gaussian.
 * Everything works on colour normalised to the raster's maximum, so RGBA16 layers stay 16-bit.
 */
import { Raster } from '../raster';
import { makePixelArray, type PixelArray } from '../pixel/format';
import type { RGB } from '../adjustments';
import { blurPlanes } from './blur';

/** The layer's own pixels inside a raster that may have been padded to give a filter room to spread. */
export interface FilterFrame { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
const wholeRaster = (raster: Raster): FilterFrame => ({ x: 0, y: 0, width: raster.width, height: raster.height });

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);
const rec709 = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const smooth = (t: number): number => t * t * (3 - 2 * t);
const smoothstep = (low: number, high: number, value: number): number => smooth(clamp01((value - low) / (high - low)));

function requireRgba(raster: Raster, name: string): void {
  if (raster.channels !== 4) throw new RangeError(`${name} requires an RGBA raster`);
}
function rasterFrom(source: Raster, data: PixelArray): Raster {
  return Raster.fromPixels(source.width, source.height, 4, data, { format: source.format });
}
/** One premultiplied channel (0…1) of interleaved native pixels. */
function premultipliedPlane(data: PixelArray, maximum: number, channel: number, count: number): Float32Array {
  const plane = new Float32Array(count), square = maximum * maximum;
  for (let i = 0, p = 0; i < count; i++, p += 4) plane[i] = channel === 3 ? data[p + 3]! / maximum : data[p + channel]! * data[p + 3]! / square;
  return plane;
}
/** Straight native pixels from premultiplied channels (`alpha` already clamped to 0…1). */
function writeStraight(out: PixelArray, maximum: number, channel: number, plane: Float32Array, alpha: Float32Array): void {
  for (let i = 0, p = channel; i < alpha.length; i++, p += 4) {
    const a = alpha[i]!;
    out[p] = a > 0 ? Math.round(clamp01(plane[i]! / a) * maximum) : 0;
  }
}

// MARK: Vignette

export interface VignetteOptions {
  readonly color: RGB; readonly amount: number; readonly midpoint: number;
  readonly roundness: number; readonly feather: number; readonly highlights: number;
}

/** `vignette_mask_at`: 0 in the frame's middle, 1 past its edges; Roundness 100 is the fitted ellipse, −100 a rectangle. */
export function vignetteMask(px: number, py: number, width: number, height: number,
  midpoint: number, roundness: number, feather: number): number {
  const nx = px / width * 2 - 1, ny = py / height * 2 - 1;
  const square = Math.max(Math.abs(nx), Math.abs(ny)), circle = Math.hypot(nx, ny) / Math.SQRT2;
  const distance = circle + (square - circle) * (1 - roundness / 100) * 0.5;
  const start = midpoint / 100 * 0.85, soft = Math.max(0.05, feather / 100);
  return smooth(clamp01((distance - start) / soft));
}

/**
 * Recolours pixels toward `color` near the frame's edges, easing off bright ones by `highlights`. A wholly transparent
 * raster (an empty layer, Compositor 1.2.6) is painted instead, so the vignette can sit on a layer of its own.
 */
export function vignette(raster: Raster, options: VignetteOptions, frame: FilterFrame = wholeRaster(raster)): Raster {
  requireRgba(raster, 'Vignette');
  const strength = clamp01(options.amount / 100);
  if (strength <= 0 || frame.width <= 0 || frame.height <= 0) return raster;
  const data = raster.toPixelsNative(), maximum = raster.maximum, width = raster.width, height = raster.height;
  let fillsClear = true;
  for (let p = 3; p < data.length; p += 4) if (data[p]) { fillsClear = false; break; }
  const red = clamp01(options.color.red), green = clamp01(options.color.green), blue = clamp01(options.color.blue);
  const protect = options.highlights / 100;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = (y * width + x) * 4, stored = data[p + 3]!;
    if (!stored && !fillsClear) continue;
    const mask = vignetteMask(x + 0.5 - frame.x, y + 0.5 - frame.y, frame.width, frame.height,
      options.midpoint, options.roundness, options.feather);
    if (mask <= 0) continue;
    const alpha = stored / maximum;
    let r = 0, g = 0, b = 0, bright = 0;
    if (stored) {
      r = data[p]! / maximum; g = data[p + 1]! / maximum; b = data[p + 2]! / maximum;
      bright = clamp01((rec709(r, g, b) - 0.45) / 0.55);
    }
    const effect = strength * mask * (1 - protect * bright);
    if (!fillsClear) {
      // Only the pixels that are there change colour; their coverage stays as it was.
      data[p] = Math.round(clamp01(r + (red - r) * effect) * maximum);
      data[p + 1] = Math.round(clamp01(g + (green - g) * effect) * maximum);
      data[p + 2] = Math.round(clamp01(b + (blue - b) * effect) * maximum);
      continue;
    }
    // The colour painted over the pixel at `effect`: a clear pixel takes it on.
    const out = alpha + effect * (1 - alpha);
    if (out <= 0) continue;
    data[p] = Math.round(clamp01((red * effect + r * alpha * (1 - effect)) / out) * maximum);
    data[p + 1] = Math.round(clamp01((green * effect + g * alpha * (1 - effect)) / out) * maximum);
    data[p + 2] = Math.round(clamp01((blue * effect + b * alpha * (1 - effect)) / out) * maximum);
    data[p + 3] = Math.round(clamp01(out) * maximum);
  }
  return rasterFrom(raster, data);
}

// MARK: Bloom / Glow

/**
 * Bright-pass, blur and screen: pixels brighter than `threshold` (% luminance, soft knee) are blurred by `radius` and
 * screened back over the layer at `amount` / 50 (Compositor's CIBloom intensity). The glow spreads into transparent
 * room around the layer, so a padded raster gains a halo.
 */
export function bloom(raster: Raster, threshold: number, radius: number, amount: number): Raster {
  requireRgba(raster, 'Bloom / Glow');
  const gain = Math.max(0, amount) / 50;
  if (gain <= 0) return raster;
  const data = raster.toPixelsNative(), maximum = raster.maximum, width = raster.width, height = raster.height;
  const count = width * height, start = clamp01(threshold / 100), span = Math.max(0.05, 1 - start);
  const weight = new Float32Array(count), glowAlpha = new Float32Array(count);
  for (let i = 0, p = 0; i < count; i++, p += 4) {
    const stored = data[p + 3]!;
    if (!stored) continue;
    const lum = rec709(data[p]! / maximum, data[p + 1]! / maximum, data[p + 2]! / maximum);
    weight[i] = smooth(clamp01((lum - start) / span));
    glowAlpha[i] = stored / maximum * weight[i]!;
  }
  blurPlanes(width, height, radius, [glowAlpha]);
  const alpha = new Float32Array(count), out = makePixelArray(raster.format, data.length);
  for (let i = 0, p = 0; i < count; i++, p += 4) {
    const glow = clamp01(glowAlpha[i]! * gain), base = data[p + 3]! / maximum;
    glowAlpha[i] = glow;
    alpha[i] = base + glow - base * glow;
    out[p + 3] = Math.round(clamp01(alpha[i]!) * maximum);
  }
  for (let channel = 0; channel < 3; channel++) {
    const source = premultipliedPlane(data, maximum, channel, count), glow = new Float32Array(count);
    for (let i = 0; i < count; i++) glow[i] = source[i]! * weight[i]!;
    blurPlanes(width, height, radius, [glow]);
    // Screen of premultiplied colours; the glow stays within its own coverage.
    for (let i = 0; i < count; i++) {
      const g = Math.min(glowAlpha[i]!, clamp01(glow[i]! * gain)), s = source[i]!;
      source[i] = s + g - s * g;
    }
    writeStraight(out, maximum, channel, source, alpha);
  }
  return rasterFrom(raster, out);
}

// MARK: Tonal Contrast

/**
 * Local contrast against a `radius` Gaussian of the luminance, strengthened separately in the shadows, midtones and
 * highlights of that base (`adjust_tonal_contrast`: tanh-limited detail, eased toward black and white).
 */
export function tonalContrast(raster: Raster, radius: number, amount: number,
  shadows: number, midtones: number, highlights: number): Raster {
  requireRgba(raster, 'Tonal Contrast');
  if (amount <= 0 || (shadows === 0 && midtones === 0 && highlights === 0)) return raster;
  const data = raster.toPixelsNative(), maximum = raster.maximum, width = raster.width, height = raster.height;
  const count = width * height, luminance = new Float32Array(count), alpha = new Float32Array(count);
  for (let i = 0, p = 0; i < count; i++, p += 4) {
    const a = data[p + 3]! / maximum;
    if (!a) continue;
    luminance[i] = rec709(data[p]! / maximum, data[p + 1]! / maximum, data[p + 2]! / maximum) * a; alpha[i] = a;
  }
  blurPlanes(width, height, radius, [luminance, alpha]);
  const strength = amount / 50;
  for (let i = 0, p = 0; i < count; i++, p += 4) {
    if (!data[p + 3] || alpha[i]! < 0.5 / 255) continue;
    const r = data[p]! / maximum, g = data[p + 1]! / maximum, b = data[p + 2]! / maximum;
    const lum = rec709(r, g, b), base = clamp01(luminance[i]! / alpha[i]!);
    const shadowWeight = 1 - smoothstep(0.15, 0.5, base), highlightWeight = smoothstep(0.5, 0.85, base);
    const tone = (shadows * shadowWeight + midtones * (1 - shadowWeight - highlightWeight) + highlights * highlightWeight) / 100;
    const delta = 0.18 * Math.tanh((lum - base) * 6) * tone * strength * (4 * lum * (1 - lum));
    data[p] = Math.round(clamp01(r + delta) * maximum);
    data[p + 1] = Math.round(clamp01(g + delta) * maximum);
    data[p + 2] = Math.round(clamp01(b + delta) * maximum);
  }
  return rasterFrom(raster, data);
}

// MARK: Progressive Blur

/** Blur levels the variable blur blends between; σₖ = radius · (k / N)², dense where small radii differ most. */
const PROGRESSIVE_LEVELS = 6;

/** The 0…1 share of the full radius at each pixel: 0 before `start` %, rising linearly to 1 at `end` % along `angle`. */
export function progressiveShare(width: number, height: number, angle: number, start: number, end: number,
  frame: FilterFrame = { x: 0, y: 0, width, height }): Float32Array {
  const radians = angle * Math.PI / 180, dx = Math.cos(radians), dy = -Math.sin(radians);
  const cx = frame.x + frame.width / 2, cy = frame.y + frame.height / 2;
  const half = Math.max(0.5, (Math.abs(dx) * frame.width + Math.abs(dy) * frame.height) / 2);
  const from = clamp01(start / 100), to = clamp01(end / 100), share = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const t = ((x + 0.5 - cx) * dx + (y + 0.5 - cy) * dy + half) / (2 * half);
    share[y * width + x] = to > from ? clamp01((t - from) / (to - from)) : t >= from ? 1 : 0;
  }
  return share;
}

/**
 * Sharp at the start of a line and blurring evenly to `radius` at its end (CIMaskedVariableBlur with a linear-gradient
 * mask). Each pixel blends the two precomputed Gaussian levels around its own radius.
 */
export function progressiveBlur(raster: Raster, angle: number, start: number, end: number, radius: number,
  frame: FilterFrame = wholeRaster(raster)): Raster {
  requireRgba(raster, 'Progressive Blur');
  if (radius <= 0) return raster;
  const data = raster.toPixelsNative(), maximum = raster.maximum, width = raster.width, height = raster.height;
  const count = width * height, share = progressiveShare(width, height, angle, start, end, frame);
  // Level coordinate: σ = radius · share = radius · (u / N)².
  const level = share;
  for (let i = 0; i < count; i++) level[i] = Math.sqrt(share[i]!) * PROGRESSIVE_LEVELS;
  const used = new Uint8Array(PROGRESSIVE_LEVELS + 1);
  for (let i = 0; i < count; i++) { const u = level[i]!, k = Math.floor(u); used[k] = 1; if (u > k) used[k + 1] = 1; }
  const variable = (source: Float32Array): Float32Array => {
    const out = new Float32Array(count);
    for (let k = 0; k <= PROGRESSIVE_LEVELS; k++) {
      if (!used[k]) continue;
      const sigma = radius * (k / PROGRESSIVE_LEVELS) ** 2, blurred = sigma > 0.05 ? source.slice() : source;
      if (blurred !== source) blurPlanes(width, height, sigma, [blurred]);
      for (let i = 0; i < count; i++) {
        const weight = 1 - Math.abs(level[i]! - k);
        if (weight > 0) out[i] = out[i]! + weight * blurred[i]!;
      }
    }
    return out;
  };
  const alpha = variable(premultipliedPlane(data, maximum, 3, count)), out = makePixelArray(raster.format, data.length);
  for (let i = 0; i < count; i++) { alpha[i] = clamp01(alpha[i]!); out[i * 4 + 3] = Math.round(alpha[i]! * maximum); }
  for (let channel = 0; channel < 3; channel++) writeStraight(out, maximum, channel, variable(premultipliedPlane(data, maximum, channel, count)), alpha);
  return rasterFrom(raster, out);
}

// MARK: RGB Split

function premultipliedInterleaved(data: PixelArray, maximum: number): Float32Array {
  const out = new Float32Array(data.length), square = maximum * maximum;
  for (let p = 0; p < data.length; p += 4) {
    const a = data[p + 3]!;
    out[p] = data[p]! * a / square; out[p + 1] = data[p + 1]! * a / square; out[p + 2] = data[p + 2]! * a / square; out[p + 3] = a / maximum;
  }
  return out;
}

/** Adds the bilinear sample of premultiplied `source` at continuous pixel position (`qx`, `qy`) × `weight`; clear outside. */
function addTap(source: Float32Array, width: number, height: number, qx: number, qy: number, sum: Float64Array): void {
  const fx = qx - 0.5, fy = qy - 0.5, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
  for (let yy = 0; yy < 2; yy++) {
    const py = y0 + yy;
    if (py < 0 || py >= height) continue;
    const wy = yy ? ty : 1 - ty;
    for (let xx = 0; xx < 2; xx++) {
      const px = x0 + xx;
      if (px < 0 || px >= width) continue;
      const w = wy * (xx ? tx : 1 - tx), p = (py * width + px) * 4;
      sum[0] = sum[0]! + source[p]! * w; sum[1] = sum[1]! + source[p + 1]! * w;
      sum[2] = sum[2]! + source[p + 2]! * w; sum[3] = sum[3]! + source[p + 3]! * w;
    }
  }
}

/**
 * Chromatic dispersion (`MetalDispersion.disperse`): each pixel gathers the image along the split, tinted by its place
 * in the spectrum (red ahead, green in the middle, blue behind), so edges fan into a rainbow. `blur` smears both ways
 * along the same line, centred on the pixel (Compositor 1.5.7), so the image does not look shifted. Linear splits
 * along `angle`; radial splits outwards from the frame's centre, reaching `distance` at its corners.
 */
export function rgbSplit(raster: Raster, distance: number, blur: number, angle: number, radial: boolean,
  frame: FilterFrame = wholeRaster(raster)): Raster {
  requireRgba(raster, 'RGB Split');
  if (distance <= 0 && blur <= 0) return raster;
  const data = raster.toPixelsNative(), maximum = raster.maximum, width = raster.width, height = raster.height;
  const radians = angle * Math.PI / 180, dirX = Math.cos(radians), dirY = -Math.sin(radians);
  const cx = frame.x + frame.width / 2, cy = frame.y + frame.height / 2, reach = Math.max(1, Math.hypot(frame.width, frame.height) / 2);
  const axisX = (x: number) => (radial ? (x - cx) / reach : dirX), axisY = (y: number) => (radial ? (y - cy) / reach : dirY);
  const scale = radial ? 2 : 1, sum = new Float64Array(4);
  let source = premultipliedInterleaved(data, maximum);
  if (blur > 0) {
    // Samples about 1.5 px apart along the longest streak; separable from the spectrum since both run on one line.
    const m = Math.min(64, Math.max(2, Math.ceil(blur * scale / 1.5))), smeared = new Float32Array(source.length);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const px = x + 0.5, py = y + 0.5, sx = axisX(px) * blur, sy = axisY(py) * blur;
      sum.fill(0);
      for (let j = 0; j < m; j++) { const u = (j + 0.5) / m - 0.5; addTap(source, width, height, px - sx * u, py - sy * u, sum); }
      const p = (y * width + x) * 4;
      smeared[p] = sum[0]! / m; smeared[p + 1] = sum[1]! / m; smeared[p + 2] = sum[2]! / m; smeared[p + 3] = sum[3]! / m;
    }
    source = smeared;
  }
  const out = makePixelArray(raster.format, data.length);
  const n = distance > 0 ? Math.min(64, Math.max(3, Math.ceil(2 * distance * scale / 1.5))) : 1;
  const t = new Float64Array(n), wr = new Float64Array(n), wg = new Float64Array(n), wb = new Float64Array(n);
  let totalR = 0, totalG = 0, totalB = 0;
  for (let i = 0; i < n; i++) {
    // −1 is the blue end, 0 green, 1 red.
    const value = n === 1 ? 0 : (i + 0.5) / n * 2 - 1;
    t[i] = value; wr[i] = smoothstep(-0.3, 1, value); wg[i] = 1 - smoothstep(0, 1, Math.abs(value)) + 0.05; wb[i] = smoothstep(-0.3, 1, -value);
    totalR += wr[i]!; totalG += wg[i]!; totalB += wb[i]!;
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const px = x + 0.5, py = y + 0.5, vx = axisX(px) * distance, vy = axisY(py) * distance;
    let r = 0, g = 0, b = 0, ar = 0, ag = 0, ab = 0;
    for (let i = 0; i < n; i++) {
      sum.fill(0);
      addTap(source, width, height, px - vx * t[i]!, py - vy * t[i]!, sum);
      r += wr[i]! * sum[0]!; ar += wr[i]! * sum[3]!;
      g += wg[i]! * sum[1]!; ag += wg[i]! * sum[3]!;
      b += wb[i]! * sum[2]!; ab += wb[i]! * sum[3]!;
    }
    r /= totalR; g /= totalG; b /= totalB; ar /= totalR; ag /= totalG; ab /= totalB;
    // As opaque as the most opaque channel, so each colour stays within the alpha it is stored multiplied by.
    const a = clamp01(Math.max(ar, ag, ab)), p = (y * width + x) * 4;
    out[p + 3] = Math.round(a * maximum);
    if (a > 0) {
      out[p] = Math.round(clamp01(Math.min(r, a) / a) * maximum);
      out[p + 1] = Math.round(clamp01(Math.min(g, a) / a) * maximum);
      out[p + 2] = Math.round(clamp01(Math.min(b, a) / a) * maximum);
    }
  }
  return rasterFrom(raster, out);
}
