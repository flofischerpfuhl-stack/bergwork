/**
 * Gamma-space blend math used by Rendering/LayerRenderer.swift and Rendering/SeparableBlend.swift.
 * Formula sources:
 * - Adobe PDF Reference 1.7, §7.2.4: Multiply, Screen, Overlay, Darken, Lighten, Color Dodge/Burn,
 *   Soft/Hard Light, Difference, Exclusion, Hue, Saturation, Color and Luminosity.
 *   https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/pdfreference1.7old.pdf
 * - Published Photoshop formula table: Dissolve, Linear Burn/Dodge, Darker/Lighter Color, Vivid/Linear/Pin
 *   Light, Hard Mix, Subtract and Divide.
 *   https://github.com/psd-tools/image-blender/blob/master/wiki/Blend-modes-and-formulas.rest
 * Adobe's descriptions confirm the operand directions for the Photoshop-only modes:
 * https://helpx.adobe.com/photoshop/desktop/repair-retouch/adjust-light-tone/blending-mode-descriptions.html
 */
import type { BlendMode } from './document';
import { linearToSrgb, srgbToLinear } from './pixel/color';

export type RGB = readonly [number, number, number];

export const SPECIAL_FILL_BLEND_MODES: ReadonlySet<BlendMode> = new Set([
  'colorBurn', 'linearBurn', 'colorDodge', 'linearDodge', 'vividLight', 'linearLight', 'hardMix', 'difference',
]);

export function clamp01(value: number): number { return Math.min(1, Math.max(0, value)); }

function lum3(r: number, g: number, b: number): number { return 0.3 * r + 0.59 * g + 0.11 * b; }
function sat3(r: number, g: number, b: number): number { return Math.max(r, g, b) - Math.min(r, g, b); }

function softLight(backdrop: number, source: number): number {
  // Adobe PDF Reference 1.7, 7.2.4, SoftLight and its D(x) helper.
  if (source <= 0.5) return backdrop - (1 - 2 * source) * backdrop * (1 - backdrop);
  const d = backdrop <= 0.25 ? ((16 * backdrop - 12) * backdrop + 4) * backdrop : Math.sqrt(backdrop);
  return backdrop + (2 * source - 1) * (d - backdrop);
}

function dodge(backdrop: number, source: number): number {
  return backdrop === 0 ? 0 : source >= 1 ? 1 : Math.min(1, backdrop / (1 - source));
}

function burn(backdrop: number, source: number): number {
  return backdrop >= 1 ? 1 : source <= 0 ? 0 : 1 - Math.min(1, (1 - backdrop) / source);
}

function vividLight(backdrop: number, source: number): number {
  // Photoshop resolves the 0/0 endpoint to the blend colour for the rescaled Burn/Dodge pair.
  if (source <= 0.5) {
    const scaled = 2 * source;
    return scaled <= 0 ? 0 : backdrop >= 1 ? 1 : 1 - Math.min(1, (1 - backdrop) / scaled);
  }
  const scaled = 2 * source - 1;
  return scaled >= 1 ? 1 : backdrop === 0 ? 0 : Math.min(1, backdrop / (1 - scaled));
}

/** W3C Compositing and Blending Level 1 `ClipColor`. */
function clipColorInto(r: number, g: number, b: number, out: Float64Array, offset = 0): void {
  const l = lum3(r, g, b);
  const n = Math.min(r, g, b);
  const x = Math.max(r, g, b);
  if (n < 0) {
    const d = l - n;
    r = d === 0 ? l : l + (r - l) * l / d;
    g = d === 0 ? l : l + (g - l) * l / d;
    b = d === 0 ? l : l + (b - l) * l / d;
  }
  if (x > 1) {
    const d = x - l;
    r = d === 0 ? l : l + (r - l) * (1 - l) / d;
    g = d === 0 ? l : l + (g - l) * (1 - l) / d;
    b = d === 0 ? l : l + (b - l) * (1 - l) / d;
  }
  out[offset] = clamp01(r); out[offset + 1] = clamp01(g); out[offset + 2] = clamp01(b);
}

function setLumInto(r: number, g: number, b: number, target: number, out: Float64Array, offset = 0): void {
  const d = target - lum3(r, g, b);
  clipColorInto(r + d, g + d, b + d, out, offset);
}

function setSatInto(r: number, g: number, b: number, target: number, out: Float64Array, offset = 0): void {
  const values = out;
  values[offset] = r; values[offset + 1] = g; values[offset + 2] = b;
  let min = 0, mid = 1, max = 2;
  if (values[offset + min]! > values[offset + mid]!) { const swap = min; min = mid; mid = swap; }
  if (values[offset + mid]! > values[offset + max]!) { const swap = mid; mid = max; max = swap; }
  if (values[offset + min]! > values[offset + mid]!) { const swap = min; min = mid; mid = swap; }
  const low = values[offset + min]!, middle = values[offset + mid]!, high = values[offset + max]!;
  values[offset] = 0; values[offset + 1] = 0; values[offset + 2] = 0;
  if (high > low) {
    values[offset + mid] = (middle - low) * target / (high - low);
    values[offset + max] = target;
  }
}

function channel(mode: BlendMode, backdrop: number, source: number): number {
  switch (mode) {
    case 'normal': case 'dissolve': return source;
    case 'multiply': return backdrop * source;
    case 'screen': return backdrop + source - backdrop * source;
    case 'overlay': return backdrop <= 0.5 ? 2 * backdrop * source : 1 - 2 * (1 - backdrop) * (1 - source);
    case 'darken': return Math.min(backdrop, source);
    case 'linearBurn': return Math.max(0, backdrop + source - 1);
    case 'lighten': return Math.max(backdrop, source);
    case 'linearDodge': return Math.min(1, backdrop + source);
    case 'colorDodge': return dodge(backdrop, source);
    case 'colorBurn': return burn(backdrop, source);
    case 'softLight': return softLight(backdrop, source);
    case 'hardLight': return source <= 0.5 ? 2 * backdrop * source : 1 - 2 * (1 - backdrop) * (1 - source);
    case 'vividLight': return vividLight(backdrop, source);
    case 'linearLight': return clamp01(backdrop + 2 * source - 1);
    case 'pinLight': return source <= 0.5 ? Math.min(backdrop, 2 * source) : Math.max(backdrop, 2 * source - 1);
    case 'hardMix': {
      const sum = backdrop + source;
      return sum < 1 ? 0 : sum > 1 ? 1 : source < 0.5 ? 1 : 0;
    }
    case 'difference': return Math.abs(backdrop - source);
    case 'exclusion': return backdrop + source - 2 * backdrop * source;
    // Adobe Photoshop reference says base minus/divided by blend; zero cases match psd-tools/image-blender.
    case 'subtract': return Math.max(0, backdrop - source);
    case 'divide': return backdrop === 0 ? 0 : source === 0 ? 1 : Math.min(1, backdrop / source);
    default: return source;
  }
}

/**
 * Straight-colour blend function B(Cb, Cs) in sRGB. `linearDodgeBurn` exists for experiments only: the
 * upstream test LayerAppearanceTests.blendModesAndOpacityMatchKnownPixels (burn of 0.8 over 0.4 = 0.25)
 * shows Color Dodge/Burn results follow the sRGB formula.
 */
export function blendRgb(mode: BlendMode, backdrop: RGB, source: RGB, linearDodgeBurn = false): RGB {
  const out = new Float64Array(6);
  blendRgbInto(mode, backdrop[0], backdrop[1], backdrop[2], source[0], source[1], source[2], out, linearDodgeBurn);
  return [out[0]!, out[1]!, out[2]!];
}

/** Allocation-free form used by the compositor's pixel loop; `out` needs six elements. */
export function blendRgbInto(mode: BlendMode, br: number, bg: number, bb: number,
  sr: number, sg: number, sb: number, out: Float64Array, linearDodgeBurn = false): void {
  switch (mode) {
    // Photoshop compares the whole colours, rather than choosing channels independently.
    // Adobe Photoshop help describes total channel values; image-blender pins the comparison to PDF Lum().
    case 'darkerColor': {
      const source = lum3(sr, sg, sb) < lum3(br, bg, bb);
      out[0] = source ? sr : br; out[1] = source ? sg : bg; out[2] = source ? sb : bb;
      return;
    }
    case 'lighterColor': {
      const source = lum3(sr, sg, sb) > lum3(br, bg, bb);
      out[0] = source ? sr : br; out[1] = source ? sg : bg; out[2] = source ? sb : bb;
      return;
    }
    case 'hue':
      setSatInto(sr, sg, sb, sat3(br, bg, bb), out, 3);
      setLumInto(out[3]!, out[4]!, out[5]!, lum3(br, bg, bb), out);
      return;
    case 'saturation':
      setSatInto(br, bg, bb, sat3(sr, sg, sb), out, 3);
      setLumInto(out[3]!, out[4]!, out[5]!, lum3(br, bg, bb), out);
      return;
    case 'color': setLumInto(sr, sg, sb, lum3(br, bg, bb), out); return;
    case 'luminosity': setLumInto(br, bg, bb, lum3(sr, sg, sb), out); return;
    default: {
      if (linearDodgeBurn && (mode === 'colorDodge' || mode === 'colorBurn')) {
        out[0] = linearToSrgb(clamp01(channel(mode, srgbToLinear(br), srgbToLinear(sr))));
        out[1] = linearToSrgb(clamp01(channel(mode, srgbToLinear(bg), srgbToLinear(sg))));
        out[2] = linearToSrgb(clamp01(channel(mode, srgbToLinear(bb), srgbToLinear(sb))));
        return;
      }
      out[0] = channel(mode, br, sr); out[1] = channel(mode, bg, sg); out[2] = channel(mode, bb, sb);
    }
  }
}

/** PDF/W3C source-over blend on premultiplied sRGB values. */
export function compositePremultiplied(backdrop: Float32Array, offset: number,
  sr: number, sg: number, sb: number, sa: number, mode: BlendMode, linearDodgeBurn = false,
  scratch = new Float64Array(6), dissolveNoise = 0): void {
  if (sa <= 0) return;
  if (mode === 'dissolve') {
    // Photoshop/image-blender: keep the source as opaque iff alpha8 >= a random integer in [1,255].
    // The caller supplies deterministic coordinate noise so CPU and GPU renders are stable.
    if (Math.round(clamp01(sa) * 255) <= dissolveNoise) return;
    const inverse = 1 / sa;
    sr *= inverse; sg *= inverse; sb *= inverse; sa = 1; mode = 'normal';
  }
  const ba = backdrop[offset + 3]!;
  const br = backdrop[offset]!, bg = backdrop[offset + 1]!, bb = backdrop[offset + 2]!;
  const cbr = ba > 0 ? br / ba : 0, cbg = ba > 0 ? bg / ba : 0, cbb = ba > 0 ? bb / ba : 0;
  blendRgbInto(mode, cbr, cbg, cbb, sr / sa, sg / sa, sb / sa, scratch, linearDodgeBurn);
  const both = sa * ba;
  backdrop[offset] = sr * (1 - ba) + br * (1 - sa) + both * scratch[0]!;
  backdrop[offset + 1] = sg * (1 - ba) + bg * (1 - sa) + both * scratch[1]!;
  backdrop[offset + 2] = sb * (1 - ba) + bb * (1 - sa) + both * scratch[2]!;
  backdrop[offset + 3] = sa + ba - both;
}

/**
 * Photoshop Fill: ordinary modes compound alpha; its eight special modes fade the blend kernel
 * itself while Fill scales only alpha growth/source-only colour. The integer kernels are calibrated
 * from the psd-tools oracle corpus; layer effects will be composited separately once rendered.
 */
export function compositePremultipliedWithFill(backdrop: Float32Array, offset: number,
  sr: number, sg: number, sb: number, sa: number, coverage: number, opacity: number, fillOpacity: number,
  mode: BlendMode, scratch = new Float64Array(6), noise = 0): void {
  coverage = clamp01(coverage); opacity = clamp01(opacity); fillOpacity = clamp01(fillOpacity);
  if (sa <= 0 || coverage <= 0 || opacity <= 0 || fillOpacity <= 0) return;
  if (!SPECIAL_FILL_BLEND_MODES.has(mode) || fillOpacity >= 1) {
    const factor = coverage * opacity * fillOpacity;
    compositePremultiplied(backdrop, offset, sr * factor, sg * factor, sb * factor, sa * factor,
      mode, false, scratch, noise);
    return;
  }
  const inverseAlpha = 1 / sa;
  compositeSpecialFill(backdrop, offset, sr * inverseAlpha, sg * inverseAlpha, sb * inverseAlpha,
    sa * coverage, opacity, fillOpacity, mode, scratch);
}

function compositeSpecialFill(backdrop: Float32Array, offset: number, sr: number, sg: number, sb: number,
  sourceCoverage: number, opacity: number, fill: number, mode: BlendMode, scratch: Float64Array): void {
  const ba = clamp01(backdrop[offset + 3]!);
  const br = ba > 0 ? clamp01(backdrop[offset]! / ba) : 0;
  const bg = ba > 0 ? clamp01(backdrop[offset + 1]! / ba) : 0;
  const bb = ba > 0 ? clamp01(backdrop[offset + 2]! / ba) : 0;
  const sr8 = byte(sr), sg8 = byte(sg), sb8 = byte(sb);
  const br8 = byte(br), bg8 = byte(bg), bb8 = byte(bb);
  const fillByte = Math.round(fill * 255);
  scratch[0] = specialFillChannel(mode, sr8, br8, fill, fillByte);
  scratch[1] = specialFillChannel(mode, sg8, bg8, fill, fillByte);
  scratch[2] = specialFillChannel(mode, sb8, bb8, fill, fillByte);
  const effective = sourceCoverage * fill * opacity;
  const overlap = sourceCoverage * opacity;
  const alpha = effective + ba * (1 - effective);
  backdrop[offset] = sr * effective * (1 - ba) + scratch[0]! * overlap * ba + br * ba * (1 - overlap);
  backdrop[offset + 1] = sg * effective * (1 - ba) + scratch[1]! * overlap * ba + bg * ba * (1 - overlap);
  backdrop[offset + 2] = sb * effective * (1 - ba) + scratch[2]! * overlap * ba + bb * ba * (1 - overlap);
  backdrop[offset + 3] = alpha;
}

function byte(value: number): number { return Math.round(clamp01(value) * 255); }
function specialFillChannel(mode: BlendMode, source: number, destination: number, fill: number,
  fillByte: number): number {
  if (mode === 'vividLight') return vividFill(source, destination, fillByte) / 255;
  if (mode === 'linearLight') return linearLightFill(source, destination, fillByte) / 255;
  if (mode === 'hardMix') return hardMixFill(source, destination, fillByte) / 255;
  const neutral = mode === 'colorBurn' || mode === 'linearBurn' ? 255 : 0;
  const adjusted = neutral + (source - neutral) * fill;
  if (mode === 'colorBurn') {
    const quotient = adjusted <= 0 ? 256 : Math.floor((255 - destination) * 256 / adjusted);
    return Math.max(0, Math.min(255, 255 - quotient)) / 255;
  }
  if (mode === 'colorDodge') {
    const divisor = 256 - adjusted;
    const value = divisor <= 0 ? 255 : Math.round(destination * 256 / divisor);
    return Math.max(0, Math.min(255, value)) / 255;
  }
  return channel(mode, destination / 255, byte(adjusted / 255) / 255);
}
function nearest(numerator: number, denominator: number): number {
  return Math.floor((2 * numerator + denominator) / (2 * denominator));
}
function linearLightFill(source: number, destination: number, fill: number): number {
  if (fill <= 0) return destination;
  return Math.max(0, Math.min(255, destination + nearest((2 * source - 255) * fill, 255) - 1));
}
function vividFill(source: number, destination: number, fill: number): number {
  if (fill <= 0) return destination;
  if (source >= 128) {
    const doubled = nearest((source - 128) * 255, 127);
    const divisor = 255 - nearest(doubled * fill, 255);
    return divisor <= 0 ? 255 : Math.min(255, nearest(destination * 255, divisor));
  }
  const doubled = 255 - nearest((255 - nearest(source * 255, 128)) * fill, 255);
  const numerator = destination + doubled - 255;
  if (numerator <= 0 || doubled <= 0) return 0;
  return Math.min(255, Math.floor((2 * numerator * 255 + doubled - 1) / (2 * doubled)));
}
function hardMixFill(source: number, destination: number, fill: number): number {
  const faded = fill - (fill >= 128 ? 1 : 0);
  if (faded <= 0) return destination;
  const anchor = nearest((255 - source) * faded, 255);
  return Math.max(0, Math.min(255, nearest((destination - anchor) * 255, 255 - faded)));
}

/** Stable 0...254 dissolve threshold for a document pixel and layer seed; mirrored in shaders.ts. */
export function dissolveNoise(x: number, y: number, seed: number): number {
  let hash = (Math.imul(x | 0, 0x1f123bb5) ^ Math.imul(y | 0, 0x5f356495) ^ seed) | 0;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  hash ^= hash >>> 16;
  return (hash >>> 0) % 255;
}

/** Positive 31-bit FNV-1a seed shared with the GPU uniform. */
export function blendSeed(key: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index++) hash = Math.imul(hash ^ key.charCodeAt(index), 0x01000193);
  return hash & 0x7fffffff;
}
