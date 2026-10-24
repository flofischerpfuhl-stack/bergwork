/**
 * Colour-model conversions for the Colour panel, the colour picker and swatch files (PRODUCT-PLAN 6.1/6.4, A3).
 *
 * The document working space is sRGB and colours are stored as RGB floats 0…1 (A3). Everything else here is a view
 * of that value:
 * - HSB is exact (a reparametrisation of sRGB).
 * - Lab is CIE L*a*b* relative to D50, like Photoshop and the ICC PCS: sRGB (D65) → linear → XYZ with the
 *   Bradford-adapted D50 matrix → Lab. Exact up to floating point; out-of-gamut Lab values are clipped to sRGB.
 * - CMYK is the naive, uncalibrated subtractive model (K = 1 − max(R, G, B)). It is the same model as the app's
 *   generic CMYK profile for untagged CMYK images (lcms_create_cmyk_profile) and is labelled as such in the UI; no
 *   press profile is involved.
 */

import type { RGB } from '../model/types';

export interface HSB { readonly hue: number; readonly saturation: number; readonly brightness: number }
export interface Lab { readonly l: number; readonly a: number; readonly b: number }
export interface CMYK { readonly c: number; readonly m: number; readonly y: number; readonly k: number }

const clamp01 = (value: number) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);

export function clampRgb(color: RGB): RGB {
  return { red: clamp01(color.red), green: clamp01(color.green), blue: clamp01(color.blue) };
}

// MARK: HSB

export function rgbToHsb(color: RGB): HSB {
  const max = Math.max(color.red, color.green, color.blue), min = Math.min(color.red, color.green, color.blue), d = max - min;
  let hue = 0;
  if (d > 0) {
    if (max === color.red) hue = ((color.green - color.blue) / d) % 6;
    else if (max === color.green) hue = (color.blue - color.red) / d + 2;
    else hue = (color.red - color.green) / d + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  return { hue, saturation: max > 0 ? d / max : 0, brightness: max };
}

export function hsbToRgb(value: HSB): RGB {
  const hue = ((value.hue % 360) + 360) % 360;
  const c = value.brightness * value.saturation, x = c * (1 - Math.abs(((hue / 60) % 2) - 1)), m = value.brightness - c;
  const [r, g, b] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  return clampRgb({ red: r + m, green: g + m, blue: b + m });
}

/** RGB → HSB that keeps the previous hue for grays and hue/saturation for black, so sliders do not jump. */
export function hsbKeepingHue(color: RGB, previous: HSB): HSB {
  const next = rgbToHsb(color);
  if (next.brightness === 0) return { hue: previous.hue, saturation: previous.saturation, brightness: 0 };
  if (next.saturation === 0) return { ...next, hue: previous.hue };
  return next;
}

// MARK: Lab (D50)

const D50 = { x: 0.96422, y: 1, z: 0.82521 };
const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const fromLinear = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
const EPSILON = 216 / 24389, KAPPA = 24389 / 27;

export function rgbToLab(color: RGB): Lab {
  const r = toLinear(clamp01(color.red)), g = toLinear(clamp01(color.green)), b = toLinear(clamp01(color.blue));
  const x = (0.4360747 * r + 0.3850649 * g + 0.1430804 * b) / D50.x;
  const y = (0.2225045 * r + 0.7168786 * g + 0.0606169 * b) / D50.y;
  const z = (0.0139322 * r + 0.0971045 * g + 0.7141733 * b) / D50.z;
  const f = (t: number) => (t > EPSILON ? Math.cbrt(t) : (KAPPA * t + 16) / 116);
  const fx = f(x), fy = f(y), fz = f(z);
  return { l: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

export function labToRgb(lab: Lab): RGB {
  const fy = (lab.l + 16) / 116, fx = fy + lab.a / 500, fz = fy - lab.b / 200;
  const inverse = (t: number) => (t ** 3 > EPSILON ? t ** 3 : (116 * t - 16) / KAPPA);
  const x = inverse(fx) * D50.x, y = (lab.l > KAPPA * EPSILON ? fy ** 3 : lab.l / KAPPA) * D50.y, z = inverse(fz) * D50.z;
  const r = 3.1338561 * x - 1.6168667 * y - 0.4906146 * z;
  const g = -0.9787684 * x + 1.9161415 * y + 0.033454 * z;
  const b = 0.0719453 * x - 0.2289914 * y + 1.4052427 * z;
  return clampRgb({ red: fromLinear(clamp01(r)), green: fromLinear(clamp01(g)), blue: fromLinear(clamp01(b)) });
}

// MARK: CMYK (naive, uncalibrated)

export function rgbToCmykNaive(color: RGB): CMYK {
  const r = clamp01(color.red), g = clamp01(color.green), b = clamp01(color.blue);
  const k = 1 - Math.max(r, g, b);
  if (k >= 1) return { c: 0, m: 0, y: 0, k: 1 };
  return { c: (1 - r - k) / (1 - k), m: (1 - g - k) / (1 - k), y: (1 - b - k) / (1 - k), k };
}

export function cmykToRgbNaive(value: CMYK): RGB {
  const k = clamp01(value.k);
  return { red: (1 - clamp01(value.c)) * (1 - k), green: (1 - clamp01(value.m)) * (1 - k), blue: (1 - clamp01(value.y)) * (1 - k) };
}

// MARK: Hex and 8-bit keys

export function rgbToHex(color: RGB): string {
  return [color.red, color.green, color.blue].map((v) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** 3- or 6-digit hex, with or without #; also `rgb(r, g, b)` as the EyeDropper API may report. */
export function parseColorText(text: string): RGB | null {
  const trimmed = text.trim();
  const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*[\d.]+)?\s*\)$/i.exec(trimmed);
  if (rgb) {
    const [r, g, b] = [rgb[1], rgb[2], rgb[3]].map(Number) as [number, number, number];
    return r <= 255 && g <= 255 && b <= 255 ? { red: r / 255, green: g / 255, blue: b / 255 } : null;
  }
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(trimmed);
  if (!m) return null;
  const digits = m[1]!.length === 3 ? m[1]!.split('').map((d) => d + d).join('') : m[1]!;
  return { red: parseInt(digits.slice(0, 2), 16) / 255, green: parseInt(digits.slice(2, 4), 16) / 255, blue: parseInt(digits.slice(4, 6), 16) / 255 };
}

/** Colours equal at 8 bits per channel (what the user can tell apart in the UI). */
export function sameColor8(a: RGB, b: RGB): boolean { return rgbToHex(a) === rgbToHex(b); }

export function rgbFrom8(r: number, g: number, b: number): RGB { return { red: r / 255, green: g / 255, blue: b / 255 }; }
