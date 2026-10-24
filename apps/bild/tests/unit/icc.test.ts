import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodeImageFile } from '../../src/io/imageImport';
import { readJpegIccProfile } from '../../src/io/jpegMeta';
import { decodeTiff } from '../../src/io/tiff';
import { loadLittleCms, type Chromaticities } from '../../src/wasm/lcms';

const P3: Chromaticities = {
  white: [0.3127, 0.329], red: [0.68, 0.32], green: [0.265, 0.69], blue: [0.15, 0.06],
};
const ADOBE_RGB: Chromaticities = {
  white: [0.3127, 0.329], red: [0.64, 0.33], green: [0.21, 0.71], blue: [0.15, 0.06],
};

describe('ICC import conversion (ImageImportTests.orientationAndColorConversion)', () => {
  it('converts a real Display P3 iCCP PNG before 16-bit quantization', async () => {
    const lcms = await loadLittleCms();
    const profile = lcms.createRgbProfile(P3, 2.4, 'srgb');
    const source = new Uint16Array([50000, 17000, 42000, 10000, 58000, 9000]);
    const alpha = new Uint16Array([32768, 65535]);
    const fixture = makePng(2, 1, 16, 6, interleave(source, alpha), [iccChunk(profile)]);
    const expected = lcms.transform(profile, source, 'rgb', 16, alpha);
    const actual = (await decodeImageFile(fixture, 2)).toPixels();
    expectCloseBytes(actual, expected);
    expect(actual).not.toEqual(quantizedRgba(source, alpha));
  });

  it('synthesizes cHRM+gAMA and grayscale-gamma profiles', async () => {
    const lcms = await loadLittleCms();
    const rgb = new Uint16Array([50000, 17000, 42000]);
    const gamma = 45_455;
    const p3Fixture = makePng(1, 1, 16, 2, rgb, [chrmChunk(P3), chunk('gAMA', u32(gamma))]);
    const p3Profile = lcms.createRgbProfile(P3, 100_000 / gamma);
    expectCloseBytes((await decodeImageFile(p3Fixture, 1)).toPixels(),
      lcms.transform(p3Profile, rgb, 'rgb', 16));

    const grayProfile = lcms.createGrayProfile([0.3127, 0.329], 1.8);
    const gray = new Uint16Array([8192, 40000, 62000]);
    const grayFixture = makePng(3, 1, 16, 0, gray, [iccChunk(grayProfile)]);
    expectCloseBytes((await decodeImageFile(grayFixture, 3)).toPixels(),
      lcms.transform(grayProfile, gray, 'gray', 16));
  });

  it('converts an Adobe RGB TIFF with the embedded tag 34675 profile', async () => {
    const lcms = await loadLittleCms();
    const profile = lcms.createRgbProfile(ADOBE_RGB, 2.19921875);
    const source = new Uint16Array([50000, 9000, 30000, 12000, 53000, 44000]);
    const fixture = makeTiff(2, 1, 3, 2, 16, source, profile);
    const expected = lcms.transform(profile, source, 'rgb', 16);
    const decoded = await decodeTiff(fixture);
    expect(decoded.hasIcc).toBe(true);
    expectCloseBytes(decoded.data, expected);
  });

  it('uses the embedded CMYK TIFF profile instead of the naive channel formula', async () => {
    const lcms = await loadLittleCms();
    const profile = lcms.createCmykProfile();
    const source = new Uint8Array([180, 20, 90, 40, 0, 170, 220, 80]);
    const expected = lcms.transform(profile, source, 'cmyk', 8);
    const decoded = await decodeTiff(makeTiff(2, 1, 4, 5, 8, source, profile));
    expectCloseBytes(decoded.data, expected);
    const naive = new Uint8Array([Math.round(255 * (1 - 180 / 255) * (1 - 40 / 255)),
      Math.round(255 * (1 - 20 / 255) * (1 - 40 / 255)), Math.round(255 * (1 - 90 / 255) * (1 - 40 / 255)), 255]);
    expect(decoded.data.subarray(0, 4)).not.toEqual(naive);
  });

  it('reassembles a multi-segment JPEG APP2 profile in sequence order', async () => {
    const lcms = await loadLittleCms();
    const profile = lcms.createRgbProfile(ADOBE_RGB, 2.19921875);
    const middle = Math.floor(profile.length / 2);
    const jpeg = makeJpeg([
      jpegIccSegment(profile.subarray(middle), 2, 2),
      jpegIccSegment(profile.subarray(0, middle), 1, 2),
    ]);
    const extracted = readJpegIccProfile(jpeg);
    expect(extracted).toEqual(profile);
    const sample = new Uint8Array([200, 80, 30]);
    expectCloseBytes(lcms.transform(extracted!, sample, 'rgb', 8), lcms.transform(profile, sample, 'rgb', 8));
  });

  it('leaves an sRGB-tagged PNG unchanged', async () => {
    const source = new Uint8Array([2, 19, 233, 7, 240, 91, 128, 255]);
    const fixture = makePng(2, 1, 8, 6, source, [chunk('sRGB', new Uint8Array([0]))]);
    expect((await decodeImageFile(fixture, 2)).toPixels()).toEqual(source);
  });
});

function makePng(width: number, height: number, depth: 8 | 16, colorType: 0 | 2 | 6,
  samples: Uint8Array | Uint16Array, metadata: Uint8Array[]): Uint8Array {
  const ihdr = new Uint8Array(13);
  ihdr.set(u32(width), 0); ihdr.set(u32(height), 4); ihdr[8] = depth; ihdr[9] = colorType;
  const sampleBytes = depth === 8 ? samples as Uint8Array : uint16be(samples as Uint16Array);
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : 4, stride = width * channels * (depth / 8);
  const scanlines = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) scanlines.set(sampleBytes.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  return join([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), ...metadata,
    chunk('IDAT', new Uint8Array(deflateSync(scanlines))), chunk('IEND', new Uint8Array(0))]);
}

function iccChunk(profile: Uint8Array): Uint8Array {
  return chunk('iCCP', join([new TextEncoder().encode('fixture'), new Uint8Array([0, 0]), new Uint8Array(deflateSync(profile))]));
}

function chrmChunk(chromaticities: Chromaticities): Uint8Array {
  const values = [...chromaticities.white, ...chromaticities.red, ...chromaticities.green, ...chromaticities.blue];
  return chunk('cHRM', join(values.map((value) => u32(Math.round(value * 100_000)))));
}

function makeTiff(width: number, height: number, samples: number, photometric: 1 | 2 | 5,
  bits: 8 | 16, pixels: Uint8Array | Uint16Array, profile: Uint8Array): Uint8Array {
  const tags = ([
    [256, 4, 1, le32(width)], [257, 4, 1, le32(height)],
    [258, 3, samples, shorts(samples, bits)], [259, 3, 1, le16(1)], [262, 3, 1, le16(photometric)],
    [273, 4, 1, new Uint8Array(4)], [277, 3, 1, le16(samples)], [278, 4, 1, le32(height)],
    [279, 4, 1, le32(pixels.byteLength)], [284, 3, 1, le16(1)], [34675, 7, profile.length, profile],
  ] satisfies Array<[number, number, number, Uint8Array]>).sort((a, b) => a[0] - b[0]);
  const ifdEnd = 8 + 2 + tags.length * 12 + 4;
  let cursor = ifdEnd;
  const offsets = new Map<number, number>();
  for (const tag of tags) if (tag[3].length > 4) { offsets.set(tag[0], cursor); cursor += tag[3].length + (tag[3].length & 1); }
  const pixelOffset = cursor, pixelBytes = bits === 8 ? pixels as Uint8Array : uint16le(pixels as Uint16Array);
  cursor += pixelBytes.length;
  const output = new Uint8Array(cursor), view = new DataView(output.buffer);
  output.set([0x49, 0x49, 42, 0], 0); view.setUint32(4, 8, true); view.setUint16(8, tags.length, true);
  for (let index = 0; index < tags.length; index++) {
    const [tag, type, count, original] = tags[index]!, at = 10 + index * 12;
    const data = tag === 273 ? le32(pixelOffset) : original;
    view.setUint16(at, tag, true); view.setUint16(at + 2, type, true); view.setUint32(at + 4, count, true);
    if (data.length <= 4) output.set(data, at + 8);
    else { const offset = offsets.get(tag)!; view.setUint32(at + 8, offset, true); output.set(data, offset); }
  }
  output.set(pixelBytes, pixelOffset);
  return output;
}

function makeJpeg(app2: Uint8Array[]): Uint8Array {
  const sof = jpegSegment(0xc0, new Uint8Array([8, 0, 1, 0, 1, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0]));
  return join([new Uint8Array([0xff, 0xd8]), ...app2, sof, new Uint8Array([0xff, 0xd9])]);
}

function jpegIccSegment(payload: Uint8Array, sequence: number, total: number): Uint8Array {
  return jpegSegment(0xe2, join([new TextEncoder().encode('ICC_PROFILE\0'), new Uint8Array([sequence, total]), payload]));
}
function jpegSegment(marker: number, payload: Uint8Array): Uint8Array {
  const result = new Uint8Array(payload.length + 4), length = payload.length + 2;
  result.set([0xff, marker, length >>> 8, length], 0); result.set(payload, 4); return result;
}

function interleave(rgb: Uint16Array, alpha: Uint16Array): Uint16Array {
  const result = new Uint16Array(alpha.length * 4);
  for (let pixel = 0; pixel < alpha.length; pixel++) {
    result.set(rgb.subarray(pixel * 3, pixel * 3 + 3), pixel * 4); result[pixel * 4 + 3] = alpha[pixel]!;
  }
  return result;
}
function quantizedRgba(rgb: Uint16Array, alpha: Uint16Array): Uint8Array {
  const result = new Uint8Array(alpha.length * 4);
  for (let pixel = 0; pixel < alpha.length; pixel++) for (let channel = 0; channel < 4; channel++) {
    const value = channel === 3 ? alpha[pixel]! : rgb[pixel * 3 + channel]!;
    result[pixel * 4 + channel] = Math.floor((value * 255 + 32767) / 65535);
  }
  return result;
}
function expectCloseBytes(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < actual.length; i++) expect(Math.abs(actual[i]! - expected[i]!), `byte ${i}`).toBeLessThanOrEqual(1);
}
function shorts(count: number, value: number): Uint8Array { return join(new Array(count).fill(0).map(() => le16(value))); }
function uint16be(values: Uint16Array): Uint8Array {
  const result = new Uint8Array(values.length * 2), view = new DataView(result.buffer);
  for (let i = 0; i < values.length; i++) view.setUint16(i * 2, values[i]!, false);
  return result;
}
function uint16le(values: Uint16Array): Uint8Array {
  const result = new Uint8Array(values.length * 2), view = new DataView(result.buffer);
  for (let i = 0; i < values.length; i++) view.setUint16(i * 2, values[i]!, true);
  return result;
}
function le16(value: number): Uint8Array { return new Uint8Array([value, value >>> 8]); }
function le32(value: number): Uint8Array { return new Uint8Array([value, value >>> 8, value >>> 16, value >>> 24]); }
function u32(value: number): Uint8Array { return new Uint8Array([value >>> 24, value >>> 16, value >>> 8, value]); }
function chunk(type: string, data: Uint8Array): Uint8Array {
  const result = new Uint8Array(data.length + 12); result.set(u32(data.length), 0);
  result.set(new TextEncoder().encode(type), 4); result.set(data, 8);
  result.set(u32(crc32(result, 4, data.length + 8)), data.length + 8); return result;
}
function crc32(data: Uint8Array, start: number, end: number): number {
  let crc = 0xffff_ffff;
  for (let i = start; i < end; i++) {
    crc ^= data[i]!;
    for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}
function join(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0; for (const part of parts) { output.set(part, offset); offset += part.length; } return output;
}
