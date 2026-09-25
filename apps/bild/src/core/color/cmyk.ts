/**
 * CMYK output profiles and display proofing. The document remains straight-alpha sRGB; this
 * module is only used for exact output transforms and to build an RGB display proof LUT.
 */

import { loadLittleCms } from '../../wasm/lcms';

export type CmykRenderingIntent = 'perceptual' | 'relative-colorimetric';
export type BundledCmykProfileId = 'swop-approx' | 'fogra39-approx';

export interface CmykProfile {
  readonly id: BundledCmykProfileId | 'user';
  readonly name: string;
  readonly icc: Uint8Array;
}

export interface ProofOptions {
  readonly intent: CmykRenderingIntent;
  readonly blackPointCompensation: boolean;
  readonly simulatePaperWhite: boolean;
}

export interface CmykLut {
  readonly size: number;
  /** CMYK8 device value at each RGB node. */
  readonly cmyk: Uint8Array;
  /** Proof RGB in RGB, with alpha used as the gamut-warning strength. */
  readonly proof: Uint8Array;
}

const PROFILE_NAMES: Readonly<Record<BundledCmykProfileId, string>> = {
  'swop-approx': 'Generic SWOP-like (approximation)',
  'fogra39-approx': 'Generic FOGRA39-like (approximation)',
};

const profileCache = new Map<BundledCmykProfileId, Promise<CmykProfile>>();

/** Bundled profiles are compact deterministic output profiles created by Little CMS at runtime. */
export function bundledCmykProfile(id: BundledCmykProfileId): Promise<CmykProfile> {
  let cached = profileCache.get(id);
  if (!cached) {
    cached = loadLittleCms().then((lcms) => ({
      id, name: PROFILE_NAMES[id], icc: lcms.createCmykProfile(),
    }));
    profileCache.set(id, cached);
  }
  return cached;
}

export function userCmykProfile(name: string, icc: Uint8Array): CmykProfile {
  if (icc.byteLength < 128) throw new RangeError('The ICC profile is too small.');
  return { id: 'user', name: name.replace(/\.(icc|icm)$/i, '') || 'Custom CMYK profile', icc: icc.slice() };
}

/**
 * Builds the flattened 3D display LUT and matching RGB→CMYK device nodes. Both arrays come from
 * Little CMS transforms configured with the selected output profile, intent and BPC setting.
 */
export async function buildCmykLut(profile: CmykProfile, options: ProofOptions, size = 17): Promise<CmykLut> {
  if (!Number.isInteger(size) || size < 2 || size > 65) throw new RangeError('CMYK LUT size must be 2…65.');
  const lcms = await loadLittleCms();
  const nodes = size ** 3, cmyk = new Uint8Array(nodes * 4), proof = new Uint8Array(nodes * 4);
  const rgb = new Uint8Array(nodes * 3);
  let node = 0;
  for (let blue = 0; blue < size; blue++) for (let green = 0; green < size; green++) for (let red = 0; red < size; red++, node++) {
    const at = node * 3;
    rgb[at] = Math.round(red * 255 / (size - 1));
    rgb[at + 1] = Math.round(green * 255 / (size - 1));
    rgb[at + 2] = Math.round(blue * 255 / (size - 1));
  }
  for (let i = 0; i < nodes; i++) {
    cmyk[i * 4] = rgb[i * 3]!; cmyk[i * 4 + 1] = rgb[i * 3 + 1]!; cmyk[i * 4 + 2] = rgb[i * 3 + 2]!; cmyk[i * 4 + 3] = 255;
  }
  lcms.transformRgbToCmykInPlace(profile.icc, cmyk, options.intent, options.blackPointCompensation);
  const rendered = lcms.proofRgb(profile.icc, rgb, options.intent, options.blackPointCompensation,
    options.simulatePaperWhite) as Uint8Array;
  const gamut = lcms.proofRgb(profile.icc, rgb, options.intent, options.blackPointCompensation,
    options.simulatePaperWhite, true) as Uint8Array;
  for (let i = 0; i < nodes; i++) {
    const input = i * 3, output = i * 4;
    proof[output] = rendered[input]!; proof[output + 1] = rendered[input + 1]!; proof[output + 2] = rendered[input + 2]!;
    proof[output + 3] = gamut[input] === 255 && gamut[input + 1] === 0 && gamut[input + 2] === 255 ? 255 : 0;
  }
  return { size, cmyk, proof };
}

function sample(lut: Uint8Array, size: number, channels: 4, r: number, g: number, b: number, channel: number): number {
  const x = r * (size - 1) / 255, y = g * (size - 1) / 255, z = b * (size - 1) / 255;
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
  const x1 = Math.min(size - 1, x0 + 1), y1 = Math.min(size - 1, y0 + 1), z1 = Math.min(size - 1, z0 + 1);
  const fx = x - x0, fy = y - y0, fz = z - z0;
  const at = (xi: number, yi: number, zi: number) => ((zi * size + yi) * size + xi) * channels + channel;
  const a00 = lut[at(x0, y0, z0)]! * (1 - fx) + lut[at(x1, y0, z0)]! * fx;
  const a10 = lut[at(x0, y1, z0)]! * (1 - fx) + lut[at(x1, y1, z0)]! * fx;
  const a01 = lut[at(x0, y0, z1)]! * (1 - fx) + lut[at(x1, y0, z1)]! * fx;
  const a11 = lut[at(x0, y1, z1)]! * (1 - fx) + lut[at(x1, y1, z1)]! * fx;
  return (a00 * (1 - fy) + a10 * fy) * (1 - fz) + (a01 * (1 - fy) + a11 * fy) * fz;
}

export function applyProofLut(pixels: Uint8Array, lut: CmykLut, gamutWarning = false): Uint8Array {
  const out = pixels.slice();
  for (let at = 0; at < pixels.length; at += 4) {
    const r = pixels[at]!, g = pixels[at + 1]!, b = pixels[at + 2]!;
    const warning = sample(lut.proof, lut.size, 4, r, g, b, 3) / 255;
    if (gamutWarning && warning > 0.15) {
      const stripe = (((at / 4) | 0) & 3) < 2 ? 0.82 : 0.55;
      out[at] = Math.round(255 * stripe); out[at + 1] = 0; out[at + 2] = Math.round(255 * stripe);
    } else {
      out[at] = Math.round(sample(lut.proof, lut.size, 4, r, g, b, 0));
      out[at + 1] = Math.round(sample(lut.proof, lut.size, 4, r, g, b, 1));
      out[at + 2] = Math.round(sample(lut.proof, lut.size, 4, r, g, b, 2));
    }
  }
  return out;
}

/** Converts straight RGB(A) samples into four CMYK device samples using the profiled inverse LUT. */
export function rgbToCmykPixels(pixels: Uint8Array | Uint16Array, lut: CmykLut): Uint8Array | Uint16Array {
  const deep = pixels instanceof Uint16Array;
  const out = deep ? new Uint16Array(pixels.length) : new Uint8Array(pixels.length);
  const maximum = deep ? 65535 : 255;
  for (let at = 0; at < pixels.length; at += 4) {
    const r = pixels[at]! * 255 / maximum, g = pixels[at + 1]! * 255 / maximum, b = pixels[at + 2]! * 255 / maximum;
    for (let channel = 0; channel < 4; channel++) out[at + channel] = Math.round(sample(lut.cmyk, lut.size, 4, r, g, b, channel) * maximum / 255);
  }
  return out;
}

/** Exact, chunked Little CMS export transform. The rendered RGBA storage becomes CMYK in place. */
export async function rgbToCmykPixelsExact(pixels: Uint8Array | Uint16Array, profile: CmykProfile,
  intent: CmykRenderingIntent, blackPointCompensation: boolean, rowWidth?: number): Promise<void> {
  const lcms = await loadLittleCms();
  lcms.transformRgbToCmykInPlace(profile.icc, pixels, intent, blackPointCompensation, rowWidth);
}
