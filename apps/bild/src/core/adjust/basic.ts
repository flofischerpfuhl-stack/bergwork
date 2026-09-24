import type { BasicSettings } from '../model/types';
import { linearFromSrgb, srgbFromLinear } from './apply';

const clamp = (v: number): number => Math.min(1, Math.max(0, v));
const luminance = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * P5 approximation: exposure/temperature run in linear sRGB; tone sliders are overlapping smooth
 * luminance masks, and clarity/texture/dehaze are bounded S-curves. This follows published
 * Lightroom-style tone-mask formulations; Adobe's proprietary Process Version is not reproducible.
 */
export function basicColor(red: number, green: number, blue: number, s: BasicSettings): [number, number, number] {
  if (s.exposure === 0 && s.contrast === 0 && s.highlights === 0 && s.shadows === 0 && s.whites === 0
    && s.blacks === 0 && s.texture === 0 && s.clarity === 0 && s.dehaze === 0 && s.vibrance === 0
    && s.saturation === 0 && s.temperature === 0 && s.tint === 0) return [red, green, blue];
  let r = linearFromSrgb(clamp(red)) * 2 ** s.exposure;
  let g = linearFromSrgb(clamp(green)) * 2 ** s.exposure;
  let b = linearFromSrgb(clamp(blue)) * 2 ** s.exposure;
  const temperature = s.temperature / 100, tint = s.tint / 100;
  r *= 2 ** (temperature * 0.22 + tint * 0.06);
  g *= 2 ** (-tint * 0.12);
  b *= 2 ** (-temperature * 0.22 + tint * 0.06);
  r = clamp(srgbFromLinear(Math.max(0, r))); g = clamp(srgbFromLinear(Math.max(0, g))); b = clamp(srgbFromLinear(Math.max(0, b)));
  let l = luminance(r, g, b);
  const shadows = (1 - l) * (1 - l), highlights = l * l;
  let delta = s.shadows / 100 * shadows * (0.55 - l) * 0.8
    + s.highlights / 100 * highlights * (0.45 - l) * 0.8;
  delta += s.blacks / 100 * (1 - l) ** 4 * 0.22 + s.whites / 100 * l ** 4 * 0.22;
  const contrast = s.contrast / 100;
  delta += contrast * (l - 0.5) * (1 - 4 * (l - 0.5) ** 2) * 0.75;
  const presence = (s.clarity * 0.006 + s.texture * 0.0025) * (l - 0.5) * (1 - Math.abs(2 * l - 1));
  delta += presence + s.dehaze / 100 * (l - 1) * 0.18;
  const newL = clamp(l + delta), scale = l > 1e-6 ? newL / l : 1;
  r = clamp(r * scale); g = clamp(g * scale); b = clamp(b * scale); l = luminance(r, g, b);
  const maximum = Math.max(r, g, b), minimum = Math.min(r, g, b);
  const chroma = maximum - minimum;
  const vibrance = s.vibrance / 100 * (1 - chroma) * (1 - Math.max(0, r - Math.max(g, b)) * 0.5);
  const sat = Math.max(-1, s.saturation / 100 + vibrance);
  const factor = sat < 0 ? 1 + sat : 1 + sat * (1 - chroma);
  return [clamp(l + (r - l) * factor), clamp(l + (g - l) * factor), clamp(l + (b - l) * factor)];
}
