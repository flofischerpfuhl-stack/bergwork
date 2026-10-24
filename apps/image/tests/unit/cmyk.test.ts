import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyProofLut, buildCmykLut, bundledCmykProfile, rgbToCmykPixels, rgbToCmykPixelsExact,
  type CmykProfile, type CmykRenderingIntent } from '../../src/core/color/cmyk';
import { rgbToLab } from '../../src/core/color/convert';
import { encodeTiff } from '../../src/io/tiffEncode';
import { decodeTiff, decodeTiffNative } from '../../src/io/tiff';
import { encodeCmykJpeg } from '../../src/io/jpegCmykEncode';
import { jpegWithMetadata } from '../../src/io/exportMetadata';
import { decodeJpegSamples } from '../../src/io/jpeg';
import { readJpegIccProfile } from '../../src/io/jpegMeta';
import { loadLittleCms } from '../../src/wasm/lcms';

const OPTIONS = { intent: 'relative-colorimetric' as const, blackPointCompensation: true, simulatePaperWhite: false };

function deltaE(a: Uint8Array, b: Uint8Array): number {
  const aa = rgbToLab({ red: a[0]! / 255, green: a[1]! / 255, blue: a[2]! / 255 });
  const bb = rgbToLab({ red: b[0]! / 255, green: b[1]! / 255, blue: b[2]! / 255 });
  return Math.hypot(aa.l - bb.l, aa.a - bb.a, aa.b - bb.b);
}

function deltaE00(a: ReturnType<typeof rgbToLab>, b: ReturnType<typeof rgbToLab>): number {
  const radians = Math.PI / 180, degrees = 180 / Math.PI;
  const c1 = Math.hypot(a.a, a.b), c2 = Math.hypot(b.a, b.b), meanC = (c1 + c2) / 2;
  const g = 0.5 * (1 - Math.sqrt(meanC ** 7 / (meanC ** 7 + 25 ** 7)));
  const ap1 = (1 + g) * a.a, ap2 = (1 + g) * b.a;
  const cp1 = Math.hypot(ap1, a.b), cp2 = Math.hypot(ap2, b.b);
  const hp = (x: number, y: number) => { const value = Math.atan2(y, x) * degrees; return value < 0 ? value + 360 : value; };
  const hp1 = hp(ap1, a.b), hp2 = hp(ap2, b.b);
  const dl = b.l - a.l, dc = cp2 - cp1;
  const dhDegrees = cp1 * cp2 === 0 ? 0 : Math.abs(hp2 - hp1) <= 180 ? hp2 - hp1 : hp2 <= hp1 ? hp2 - hp1 + 360 : hp2 - hp1 - 360;
  const dh = 2 * Math.sqrt(cp1 * cp2) * Math.sin(dhDegrees * radians / 2);
  const meanL = (a.l + b.l) / 2, meanCp = (cp1 + cp2) / 2;
  const meanHp = cp1 * cp2 === 0 ? hp1 + hp2 : Math.abs(hp1 - hp2) <= 180 ? (hp1 + hp2) / 2
    : hp1 + hp2 < 360 ? (hp1 + hp2 + 360) / 2 : (hp1 + hp2 - 360) / 2;
  const t = 1 - 0.17 * Math.cos((meanHp - 30) * radians) + 0.24 * Math.cos(2 * meanHp * radians)
    + 0.32 * Math.cos((3 * meanHp + 6) * radians) - 0.20 * Math.cos((4 * meanHp - 63) * radians);
  const sl = 1 + 0.015 * (meanL - 50) ** 2 / Math.sqrt(20 + (meanL - 50) ** 2);
  const sc = 1 + 0.045 * meanCp, sh = 1 + 0.015 * meanCp * t;
  const rotation = 30 * Math.exp(-1 * ((meanHp - 275) / 25) ** 2);
  const rc = 2 * Math.sqrt(meanCp ** 7 / (meanCp ** 7 + 25 ** 7));
  const rt = -rc * Math.sin(2 * rotation * radians);
  const l = dl / sl, c = dc / sc, h = dh / sh;
  return Math.sqrt(l * l + c * c + h * h + rt * c * h);
}

function grid17(): { rgb: Uint8Array; rgba: Uint8Array } {
  const rgb = new Uint8Array(17 ** 3 * 3), rgba = new Uint8Array(17 ** 3 * 4);
  let pixel = 0;
  for (let blue = 0; blue < 17; blue++) for (let green = 0; green < 17; green++) for (let red = 0; red < 17; red++, pixel++) {
    const values = [red, green, blue].map((value) => Math.round(value * 255 / 16));
    rgb.set(values, pixel * 3); rgba.set([...values, 255], pixel * 4);
  }
  return { rgb, rgba };
}

async function legacyInverse(profile: CmykProfile, rgb: Uint8Array): Promise<Uint8Array> {
  const maximumChannel = profile.id === 'swop-approx' ? 218 : 225, inkLimit = profile.id === 'swop-approx' ? 3.0 : 3.3;
  const steps = 7, values = Array.from({ length: steps }, (_, i) => Math.round(i * maximumChannel / (steps - 1)));
  const candidates: number[] = [], maximumInk = inkLimit * 255 + 0.5;
  for (const k of values) for (const y of values) for (const m of values) for (const c of values) {
    if (c + m + y + k <= maximumInk) candidates.push(c, m, y, k);
  }
  const device = Uint8Array.from(candidates), rendered = (await loadLittleCms()).transform(profile.icc, device, 'cmyk', 8);
  const out = new Uint8Array(rgb.length / 3 * 4);
  for (let pixel = 0; pixel < rgb.length / 3; pixel++) {
    const r = rgb[pixel * 3]!, g = rgb[pixel * 3 + 1]!, b = rgb[pixel * 3 + 2]!;
    let best = 0, distance = Number.POSITIVE_INFINITY;
    for (let sample = 0; sample < device.length / 4; sample++) {
      const at = sample * 4, dr = r - rendered[at]!, dg = g - rendered[at + 1]!, db = b - rendered[at + 2]!;
      const value = dr * dr * 0.30 + dg * dg * 0.59 + db * db * 0.11;
      if (value < distance) { distance = value; best = sample; }
    }
    out.set(device.subarray(best * 4, best * 4 + 4), pixel * 4);
  }
  return out;
}

function maximumDeltaE00(a: Uint8Array, b: Uint8Array): number {
  let maximum = 0;
  for (let at = 0; at < a.length; at += 4) maximum = Math.max(maximum, deltaE00(
    rgbToLab({ red: a[at]! / 255, green: a[at + 1]! / 255, blue: a[at + 2]! / 255 }),
    rgbToLab({ red: b[at]! / 255, green: b[at + 1]! / 255, blue: b[at + 2]! / 255 })));
  return maximum;
}

describe('Phase 3 CMYK proof and export', () => {
  it('matches independent Pillow/lcms on a 17³ grid for both intents with and without BPC', async () => {
    const profile = await bundledCmykProfile('fogra39-approx'), lcms = await loadLittleCms(), grid = grid17();
    const directory = mkdtempSync(join(tmpdir(), 'fernwork-cmyk-reference-'));
    const profilePath = join(directory, 'output.icc'), rgbPath = join(directory, 'grid.rgb');
    writeFileSync(profilePath, profile.icc); writeFileSync(rgbPath, grid.rgb);
    let worst = 0, worst16 = 0;
    try {
      for (const intent of ['perceptual', 'relative-colorimetric'] as const) for (const bpc of [false, true]) {
        const output = join(directory, `${intent}-${bpc ? 'bpc' : 'plain'}.cmyk`);
        execFileSync('python3', ['scripts/cmyk-reference.py', profilePath, rgbPath, output, '--intent', intent, ...(bpc ? ['--bpc'] : [])]);
        const expectedDevice = new Uint8Array(readFileSync(output));
        const actualDevice = grid.rgba.slice();
        lcms.transformRgbToCmykInPlace(profile.icc, actualDevice, intent, bpc);
        const expectedRgb = lcms.transform(profile.icc, expectedDevice, 'cmyk', 8);
        const actualRgb = lcms.transform(profile.icc, actualDevice, 'cmyk', 8);
        const difference = maximumDeltaE00(expectedRgb, actualRgb);
        worst = Math.max(worst, difference);
        expect(difference, `${intent}, BPC=${bpc}`).toBeLessThanOrEqual(0.5);
        const actualDevice16 = Uint16Array.from(grid.rgba, (value) => value * 257);
        lcms.transformRgbToCmykInPlace(profile.icc, actualDevice16, intent, bpc);
        const actual16At8 = Uint8Array.from(actualDevice16, (value) => Math.round(value / 257));
        const difference16 = maximumDeltaE00(expectedRgb, lcms.transform(profile.icc, actual16At8, 'cmyk', 8));
        worst16 = Math.max(worst16, difference16);
        expect(difference16, `16-bit ${intent}, BPC=${bpc}`).toBeLessThanOrEqual(0.5);
      }
      const referencePath = join(directory, 'relative-colorimetric-bpc.cmyk');
      const referenceRgb = lcms.transform(profile.icc, new Uint8Array(readFileSync(referencePath)), 'cmyk', 8);
      const legacyRgb = lcms.transform(profile.icc, await legacyInverse(profile, grid.rgb), 'cmyk', 8);
      const legacyError = maximumDeltaE00(referenceRgb, legacyRgb);
      expect(legacyError).toBeGreaterThan(worst + 0.5);
      console.info(`CMYK 17³ oracle: exact 8-bit max ΔE00=${worst.toFixed(4)}, exact 16-bit max ΔE00=${worst16.toFixed(4)}, `
        + `legacy inverse max ΔE00=${legacyError.toFixed(4)}`);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 30_000);

  it('builds a Little CMS RGB→CMYK→RGB LUT with a real gamut-error channel', async () => {
    const profile = await bundledCmykProfile('fogra39-approx');
    const lut = await buildCmykLut(profile, OPTIONS, 9);
    expect(lut.cmyk).toHaveLength(9 ** 3 * 4);
    expect(lut.proof).toHaveLength(9 ** 3 * 4);
    const source = new Uint8Array([255, 0, 0, 255, 90, 120, 150, 255]);
    const proofed = applyProofLut(source, lut, false), warning = applyProofLut(source, lut, true);
    expect(proofed.subarray(0, 3)).not.toEqual(source.subarray(0, 3));
    expect(warning.subarray(0, 3)).toEqual(new Uint8Array([209, 0, 209]));
  });

  it('round-trips representative RGB colours through CMYK within ΔE76 ≤ 12', async () => {
    const profile = await bundledCmykProfile('fogra39-approx');
    const lut = await buildCmykLut(profile, OPTIONS, 17);
    const source = new Uint8Array([64, 96, 128, 255, 180, 120, 72, 255, 210, 205, 190, 255]);
    const device = rgbToCmykPixels(source, lut) as Uint8Array;
    const decoded = (await loadLittleCms()).transform(profile.icc, device, 'cmyk', 8);
    for (let at = 0; at < source.length; at += 4) {
      expect(deltaE(source.subarray(at, at + 3), decoded.subarray(at, at + 3)), `pixel ${at / 4}`).toBeLessThanOrEqual(12);
    }
  }, 30_000);

  it('writes 8/16-bit LZW CMYK TIFF with ICC and decodes real pixels through our decoder', async () => {
    const profile = await bundledCmykProfile('swop-approx');
    const samples8 = new Uint8Array([12, 130, 220, 5, 190, 20, 70, 30]);
    const tiff8 = encodeTiff(samples8, 2, 1, { alpha: false, colorModel: 'cmyk', compression: 'lzw', iccProfile: profile.icc });
    const decoded8 = await decodeTiff(tiff8);
    expect(decoded8.hasIcc).toBe(true);
    expect(decoded8.data).toEqual((await loadLittleCms()).transform(profile.icc, samples8, 'cmyk', 8));

    const samples16 = Uint16Array.from(samples8, (value) => value * 257);
    const tiff16 = encodeTiff(samples16, 2, 1, { alpha: false, colorModel: 'cmyk', compression: 'lzw', iccProfile: profile.icc });
    const decoded16 = await decodeTiffNative(tiff16);
    expect(decoded16.hasIcc).toBe(true);
    expect(decoded16.bitDepth).toBe(16);
    expect(decoded16.data).toEqual((await loadLittleCms()).transform16(profile.icc, samples16, 'cmyk'));
  });

  it('round-trips exact 8/16-bit RGB export samples through the selected CMYK profile', async () => {
    const profile = await bundledCmykProfile('swop-approx'), lcms = await loadLittleCms();
    const rgba8 = new Uint8Array([32, 80, 144, 255, 210, 180, 120, 255]);
    const rgba16 = Uint16Array.from(rgba8, (value) => value * 257);
    await rgbToCmykPixelsExact(rgba8, profile, 'relative-colorimetric', true);
    await rgbToCmykPixelsExact(rgba16, profile, 'relative-colorimetric', true);
    const decoded8 = lcms.transform(profile.icc, rgba8, 'cmyk', 8);
    const decoded16 = lcms.transform16(profile.icc, rgba16, 'cmyk');
    expect(deltaE(decoded8.subarray(0, 3), new Uint8Array([32, 80, 144]))).toBeLessThanOrEqual(2);
    expect(deltaE(decoded8.subarray(4, 7), new Uint8Array([210, 180, 120]))).toBeLessThanOrEqual(2);
    for (let channel = 0; channel < 3; channel++) {
      expect(Math.abs(decoded16[channel]! / 257 - decoded8[channel]!)).toBeLessThanOrEqual(1);
      expect(Math.abs(decoded16[4 + channel]! / 257 - decoded8[4 + channel]!)).toBeLessThanOrEqual(1);
    }
  });

  it('transforms across the bounded WASM row-chunk boundary in the original pixel buffer', async () => {
    const profile = await bundledCmykProfile('fogra39-approx'), lcms = await loadLittleCms();
    const rowWidth = 1024, pixels = new Uint8Array(rowWidth * 1025 * 4);
    for (let at = 0; at < pixels.length; at += 4) pixels.set([37, 91, 173, 255], at);
    const expected = pixels.slice(0, 4);
    lcms.transformRgbToCmykInPlace(profile.icc, expected, 'relative-colorimetric', true);
    const buffer = pixels.buffer;
    lcms.transformRgbToCmykInPlace(profile.icc, pixels, 'relative-colorimetric', true, rowWidth);
    expect(pixels.buffer).toBe(buffer);
    expect(pixels.slice(0, 4)).toEqual(expected);
    expect(pixels.slice(-4)).toEqual(expected);
  });

  it('writes four-component CMYK JPEG with embedded ICC and decodes its pixels', async () => {
    const profile = await bundledCmykProfile('fogra39-approx'), lcms = await loadLittleCms();
    const samples = new Uint8Array(16 * 8 * 4);
    for (let pixel = 0; pixel < samples.length / 4; pixel++) {
      samples[pixel * 4] = 80; samples[pixel * 4 + 1] = 130; samples[pixel * 4 + 2] = 200; samples[pixel * 4 + 3] = 255;
    }
    lcms.transformRgbToCmykInPlace(profile.icc, samples, 'relative-colorimetric', true, 16);
    const jpeg = jpegWithMetadata(encodeCmykJpeg(samples, 16, 8, 0.92), { icc: profile.icc, exif: null });
    expect(readJpegIccProfile(jpeg)).toEqual(profile.icc);
    const decoded = await decodeJpegSamples(jpeg);
    expect(decoded.model).toBe('cmyk');
    const average = [0, 0, 0, 0];
    for (let at = 0; at < decoded.data.length; at += 4) for (let channel = 0; channel < 4; channel++) average[channel]! += decoded.data[at + channel]!;
    for (let channel = 0; channel < 4; channel++) expect(Math.abs(average[channel]! / 128 - samples[channel]!)).toBeLessThanOrEqual(8);
    const roundTrip = lcms.transform(profile.icc, decoded.data, 'cmyk', 8);
    for (let at = 0; at < roundTrip.length; at += 4) {
      expect(deltaE(roundTrip.subarray(at, at + 3), new Uint8Array([80, 130, 200]))).toBeLessThanOrEqual(4);
    }
  });
});
