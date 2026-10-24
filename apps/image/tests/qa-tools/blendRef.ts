/**
 * Independent reference for layer blending, written from the specs rather than from src/core/blend.ts:
 * - W3C Compositing and Blending Level 1 (§5.8 separable, §5.9 non-separable, §5.3 general formula);
 * - Photoshop-only modes from Adobe's mode descriptions (linear burn/dodge, vivid/linear/pin light, hard mix,
 *   subtract, divide, darker/lighter colour).
 * Values are straight colour in 0..1.
 */
export type RGB = [number, number, number];

const clamp = (v: number) => Math.min(1, Math.max(0, v));

function sep(mode: string, b: number, s: number): number {
  switch (mode) {
    case 'normal': return s;
    case 'multiply': return b * s;
    case 'screen': return b + s - b * s;
    case 'overlay': return sep('hardLight', s, b);
    case 'darken': return Math.min(b, s);
    case 'lighten': return Math.max(b, s);
    case 'colorDodge': return b === 0 ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s));
    case 'colorBurn': return b >= 1 ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s);
    case 'hardLight': return s <= 0.5 ? b * 2 * s : sep('screen', b, 2 * s - 1);
    case 'softLight': {
      if (s <= 0.5) return b - (1 - 2 * s) * b * (1 - b);
      const d = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b);
      return b + (2 * s - 1) * (d - b);
    }
    case 'difference': return Math.abs(b - s);
    case 'exclusion': return b + s - 2 * b * s;
    case 'linearBurn': return clamp(b + s - 1);
    case 'linearDodge': return clamp(b + s);
    case 'vividLight': return s <= 0.5 ? sep('colorBurn', b, 2 * s) : sep('colorDodge', b, 2 * s - 1);
    case 'linearLight': return clamp(b + 2 * s - 1);
    case 'pinLight': return s <= 0.5 ? Math.min(b, 2 * s) : Math.max(b, 2 * s - 1);
    case 'hardMix': return b + s >= 1 ? 1 : 0;
    case 'subtract': return clamp(b - s);
    case 'divide': return s <= 0 ? (b <= 0 ? 0 : 1) : clamp(b / s);
    default: throw new Error(`not separable: ${mode}`);
  }
}

const lum = ([r, g, b]: RGB) => 0.3 * r + 0.59 * g + 0.11 * b;
function clipColor(c: RGB): RGB {
  const l = lum(c), n = Math.min(...c), x = Math.max(...c);
  let out = c.slice() as RGB;
  if (n < 0) out = out.map((v) => l + ((v - l) * l) / (l - n)) as RGB;
  if (x > 1) out = out.map((v) => l + ((v - l) * (1 - l)) / (x - l)) as RGB;
  return out;
}
const setLum = (c: RGB, l: number): RGB => { const d = l - lum(c); return clipColor([c[0] + d, c[1] + d, c[2] + d]); };
const sat = (c: RGB) => Math.max(...c) - Math.min(...c);
function setSat(c: RGB, s: number): RGB {
  const idx = [0, 1, 2].sort((a, b) => c[a]! - c[b]!);
  const [mn, md, mx] = idx as [number, number, number];
  const out: RGB = [0, 0, 0];
  if (c[mx]! > c[mn]!) { out[md] = ((c[md]! - c[mn]!) * s) / (c[mx]! - c[mn]!); out[mx] = s; }
  return out;
}

export function blend(mode: string, b: RGB, s: RGB): RGB {
  switch (mode) {
    case 'hue': return setLum(setSat(s, sat(b)), lum(b));
    case 'saturation': return setLum(setSat(b, sat(s)), lum(b));
    case 'color': return setLum(s, lum(b));
    case 'luminosity': return setLum(b, lum(s));
    case 'darkerColor': return lum(s) < lum(b) ? s : b;
    case 'lighterColor': return lum(s) > lum(b) ? s : b;
    default: return [sep(mode, b[0], s[0]), sep(mode, b[1], s[1]), sep(mode, b[2], s[2])];
  }
}

/** W3C §5.3 source-over with blending; returns straight RGBA 0..1. `as` already includes layer opacity. */
export function composite(mode: string, b: RGB, ab: number, s: RGB, as: number): [number, number, number, number] {
  const mixed = blend(mode, b, s);
  const cs = [0, 1, 2].map((i) => (1 - ab) * s[i]! + ab * clamp(mixed[i]!));
  const ao = as + ab * (1 - as);
  if (ao <= 0) return [0, 0, 0, 0];
  const co = [0, 1, 2].map((i) => (as * cs[i]! + ab * b[i]! * (1 - as)) / ao);
  return [co[0]!, co[1]!, co[2]!, ao];
}

/** Photoshop Fill for the eight special modes, opaque layer over an opaque backdrop (Adobe behaviour). */
export function specialFill(mode: string, b: number, s: number, f: number): number | null {
  switch (mode) {
    case 'linearDodge': return clamp(b + f * s);
    case 'linearBurn': return clamp(b + f * (s - 1));
    case 'colorDodge': return f * s >= 1 ? (b > 0 ? 1 : 0) : clamp(b / (1 - f * s));
    case 'colorBurn': { const d = 1 - f * (1 - s); return d <= 0 ? (b >= 1 ? 1 : 0) : clamp(1 - (1 - b) / d); }
    case 'difference': return Math.abs(b - f * s);
    case 'linearLight': return clamp(b + f * (2 * s - 1));
    default: return null; // vivid light and hard mix: no closed form published; checked for "differs from opacity" only
  }
}
