import { describe, expect, it } from 'vitest';
import { applyProofLut, buildCmykLut, bundledCmykProfile, rgbToCmykPixels } from '../../src/core/color/cmyk';
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

describe('Phase 3 CMYK proof and export', () => {
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

  it('writes four-component CMYK JPEG with embedded ICC and decodes its pixels', async () => {
    const profile = await bundledCmykProfile('fogra39-approx');
    const samples = new Uint8Array(16 * 8 * 4);
    for (let pixel = 0; pixel < samples.length / 4; pixel++) {
      samples[pixel * 4] = 30; samples[pixel * 4 + 1] = 120; samples[pixel * 4 + 2] = 200; samples[pixel * 4 + 3] = 20;
    }
    const jpeg = jpegWithMetadata(encodeCmykJpeg(samples, 16, 8, 0.92), { icc: profile.icc, exif: null });
    expect(readJpegIccProfile(jpeg)).toEqual(profile.icc);
    const decoded = await decodeJpegSamples(jpeg);
    expect(decoded.model).toBe('cmyk');
    const average = [0, 0, 0, 0];
    for (let at = 0; at < decoded.data.length; at += 4) for (let channel = 0; channel < 4; channel++) average[channel]! += decoded.data[at + channel]!;
    for (let channel = 0; channel < 4; channel++) expect(Math.abs(average[channel]! / 128 - samples[channel]!)).toBeLessThanOrEqual(8);
  });
});
