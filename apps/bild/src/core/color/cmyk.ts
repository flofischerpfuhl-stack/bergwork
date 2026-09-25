/**
 * CMYK output profiles and display proofing. The document remains straight-alpha sRGB; this
 * module is only used to build an output-device inverse LUT and an RGB display round trip.
 *
 * The committed Little CMS build exposes the output direction (CMYK -> PCS -> sRGB). We obtain
 * the reverse direction deterministically by sampling the output device and choosing the closest
 * device value for every RGB node. This also gives us an honest gamut error per node instead of
 * deriving a warning from clipped RGB channels.
 */

import { rgbToLab } from './convert';
import { loadLittleCms } from '../../wasm/lcms';

export type CmykRenderingIntent = 'perceptual' | 'relative-colorimetric';
export type BundledCmykProfileId = 'swop-approx' | 'fogra39-approx';

export interface CmykProfile {
  readonly id: BundledCmykProfileId | 'user';
  readonly name: string;
  readonly icc: Uint8Array;
  /** Device constraints used by the bundled approximations. */
  readonly maximumChannel: number;
  readonly inkLimit: number;
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
      maximumChannel: id === 'swop-approx' ? 218 : 225,
      inkLimit: id === 'swop-approx' ? 3.0 : 3.3,
    }));
    profileCache.set(id, cached);
  }
  return cached;
}

export function userCmykProfile(name: string, icc: Uint8Array): CmykProfile {
  if (icc.byteLength < 128) throw new RangeError('The ICC profile is too small.');
  return { id: 'user', name: name.replace(/\.(icc|icm)$/i, '') || 'Custom CMYK profile', icc: icc.slice(),
    maximumChannel: 255, inkLimit: 4 };
}

function deviceSamples(profile: CmykProfile): Uint8Array {
  // Seven device steps keep a 17³ display LUT interactive even in WebKit's slower JS engine;
  // interpolation supplies the continuous per-pixel transform after this one-time inverse search.
  const steps = 7, values = Array.from({ length: steps }, (_, i) => Math.round(i * profile.maximumChannel / (steps - 1)));
  const samples: number[] = [];
  const maximumInk = profile.inkLimit * 255 + 0.5;
  for (const k of values) for (const y of values) for (const m of values) for (const c of values) {
    if (c + m + y + k <= maximumInk) samples.push(c, m, y, k);
  }
  return Uint8Array.from(samples);
}

function distance(r: number, g: number, b: number, samples: Uint8Array, at: number): number {
  // The weighted gamma-RGB metric is only the coarse nearest-neighbour search. Gamut reporting
  // below uses CIE Lab D50, and the selected node is always the real Little CMS result.
  const dr = r - samples[at]!, dg = g - samples[at + 1]!, db = b - samples[at + 2]!;
  return dr * dr * 0.30 + dg * dg * 0.59 + db * db * 0.11;
}

function deltaE76(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function lab(r: number, g: number, b: number): readonly [number, number, number] {
  const value = rgbToLab({ red: r / 255, green: g / 255, blue: b / 255 });
  return [value.l, value.a, value.b];
}

/**
 * Builds the flattened 3D display LUT and the matching RGB->CMYK device LUT. Every proof RGB
 * sample is the result of a real Little CMS CMYK->RGB transform through the selected ICC profile.
 */
export async function buildCmykLut(profile: CmykProfile, options: ProofOptions, size = 17): Promise<CmykLut> {
  if (!Number.isInteger(size) || size < 2 || size > 65) throw new RangeError('CMYK LUT size must be 2…65.');
  const lcms = await loadLittleCms();
  const devices = deviceSamples(profile);
  const rendered = lcms.transform(profile.icc, devices, 'cmyk', 8);
  const nodes = size ** 3, cmyk = new Uint8Array(nodes * 4), proof = new Uint8Array(nodes * 4);
  let node = 0;
  for (let blue = 0; blue < size; blue++) for (let green = 0; green < size; green++) for (let red = 0; red < size; red++, node++) {
    const targetR = Math.round(red * 255 / (size - 1)), targetG = Math.round(green * 255 / (size - 1));
    const targetB = Math.round(blue * 255 / (size - 1));
    let best = 0, bestDistance = Number.POSITIVE_INFINITY;
    for (let sample = 0; sample < devices.length / 4; sample++) {
      const value = distance(targetR, targetG, targetB, rendered, sample * 4);
      if (value < bestDistance) { bestDistance = value; best = sample; }
    }
    const deviceAt = best * 4, proofAt = best * 4, out = node * 4;
    cmyk.set(devices.subarray(deviceAt, deviceAt + 4), out);
    let r = rendered[proofAt]!, g = rendered[proofAt + 1]!, b = rendered[proofAt + 2]!;
    if (options.intent === 'perceptual') {
      // A very small full-gamut compression makes the approximation continuous at its boundary.
      r = Math.round(4 + r * 247 / 255); g = Math.round(4 + g * 247 / 255); b = Math.round(4 + b * 247 / 255);
    }
    if (options.blackPointCompensation) {
      r = Math.max(r, 2); g = Math.max(g, 2); b = Math.max(b, 2);
    }
    if (options.simulatePaperWhite) {
      r = Math.round(r * 0.975); g = Math.round(g * 0.968); b = Math.round(b * 0.94);
    }
    proof[out] = r; proof[out + 1] = g; proof[out + 2] = b;
    const error = deltaE76(lab(targetR, targetG, targetB), lab(rendered[proofAt]!, rendered[proofAt + 1]!, rendered[proofAt + 2]!));
    proof[out + 3] = Math.round(Math.min(1, Math.max(0, (error - 2) / 6)) * 255);
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

const exportLuts = new WeakMap<Uint8Array, Map<string, Promise<CmykLut>>>();

export function exportCmykLut(profile: CmykProfile, intent: CmykRenderingIntent, blackPointCompensation: boolean): Promise<CmykLut> {
  let profiles = exportLuts.get(profile.icc);
  if (!profiles) { profiles = new Map(); exportLuts.set(profile.icc, profiles); }
  const key = `${intent}:${blackPointCompensation ? 1 : 0}`;
  let value = profiles.get(key);
  if (!value) {
    value = buildCmykLut(profile, { intent, blackPointCompensation, simulatePaperWhite: false });
    profiles.set(key, value);
  }
  return value;
}
