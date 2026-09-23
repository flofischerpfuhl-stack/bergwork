/** PDF/W3C blend math used by Rendering/LayerRenderer.swift and Rendering/SeparableBlend.swift. */
import type { BlendMode } from './document';

export type RGB = readonly [number, number, number];

export function clamp01(value: number): number { return Math.min(1, Math.max(0, value)); }

export function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

export function linearToSrgb(value: number): number {
  const v = clamp01(value);
  return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
}

function lum3(r: number, g: number, b: number): number { return 0.3 * r + 0.59 * g + 0.11 * b; }
function sat3(r: number, g: number, b: number): number { return Math.max(r, g, b) - Math.min(r, g, b); }

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
    case 'normal': return source;
    case 'multiply': return backdrop * source;
    case 'screen': return backdrop + source - backdrop * source;
    case 'overlay': return backdrop <= 0.5 ? 2 * backdrop * source : 1 - 2 * (1 - backdrop) * (1 - source);
    case 'darken': return Math.min(backdrop, source);
    case 'lighten': return Math.max(backdrop, source);
    case 'difference': return Math.abs(backdrop - source);
    case 'colorDodge': return backdrop === 0 ? 0 : source >= 1 ? 1 : Math.min(1, backdrop / (1 - source));
    case 'colorBurn': return backdrop >= 1 ? 1 : source <= 0 ? 0 : 1 - Math.min(1, (1 - backdrop) / source);
    default: return source;
  }
}

/** Straight-colour blend function B(Cb, Cs). SeparableBlend.swift routes dodge/burn through linear Core Image. */
export function blendRgb(mode: BlendMode, backdrop: RGB, source: RGB, linearDodgeBurn = true): RGB {
  const out = new Float64Array(6);
  blendRgbInto(mode, backdrop[0], backdrop[1], backdrop[2], source[0], source[1], source[2], out, linearDodgeBurn);
  return [out[0]!, out[1]!, out[2]!];
}

/** Allocation-free form used by the compositor's pixel loop; `out` needs six elements. */
export function blendRgbInto(mode: BlendMode, br: number, bg: number, bb: number,
  sr: number, sg: number, sb: number, out: Float64Array, linearDodgeBurn = true): void {
  switch (mode) {
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
        out[0] = linearToSrgb(channel(mode, srgbToLinear(br), srgbToLinear(sr)));
        out[1] = linearToSrgb(channel(mode, srgbToLinear(bg), srgbToLinear(sg)));
        out[2] = linearToSrgb(channel(mode, srgbToLinear(bb), srgbToLinear(sb)));
        return;
      }
      out[0] = channel(mode, br, sr); out[1] = channel(mode, bg, sg); out[2] = channel(mode, bb, sb);
    }
  }
}

/** PDF/W3C source-over blend on premultiplied sRGB values. */
export function compositePremultiplied(backdrop: Float32Array, offset: number,
  sr: number, sg: number, sb: number, sa: number, mode: BlendMode, linearDodgeBurn = true,
  scratch = new Float64Array(6)): void {
  if (sa <= 0) return;
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
