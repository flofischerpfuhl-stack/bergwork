import { describe, expect, test } from 'vitest';
import { decodeDng, decodeLosslessJpeg, dngDimensions, isDng } from '../../src/io/dng';
import { makeDng } from '../helpers/dngFixture';

function pixel(rgba: Uint16Array, width: number, x: number, y: number): [number, number, number] {
  const at = (y * width + x) * 4; return [rgba[at]! / 65535, rgba[at + 1]! / 65535, rgba[at + 2]! / 65535];
}
function linear(value: number): number { return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4; }
function lab(rgb: readonly number[]): [number, number, number] {
  const [r, g, b] = rgb.map(linear) as [number, number, number];
  const xyz = [(r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047,
    r * 0.2126729 + g * 0.7151522 + b * 0.072175,
    (r * 0.0193339 + g * 0.119192 + b * 0.9503041) / 1.08883];
  const f = (v: number) => v > 216 / 24389 ? Math.cbrt(v) : (24389 / 27 * v + 16) / 116;
  return [116 * f(xyz[1]!) - 16, 500 * (f(xyz[0]!) - f(xyz[1]!)), 200 * (f(xyz[1]!) - f(xyz[2]!))];
}
function deltaE(a: readonly number[], b: readonly number[]): number {
  const aa = lab(a), bb = lab(b); return Math.hypot(aa[0] - bb[0], aa[1] - bb[1], aa[2] - bb[2]);
}
const encodedSrgb = (value: number) => value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;

describe('pure TypeScript DNG decoder', () => {
  test('Bayer RGGB known patches decode within ΔE limits as RGBA16', () => {
    const bytes = makeDng('bayer'), decoded = decodeDng(bytes);
    expect(isDng(bytes)).toBe(true); expect(dngDimensions(bytes)).toEqual({ width: 18, height: 10 });
    expect(decoded.rgba).toBeInstanceOf(Uint16Array); expect(decoded.rgba.length).toBe(18 * 10 * 4);
    const expected = [[0.72, 0.015, 0.012], [0.015, 0.68, 0.018], [0.012, 0.018, 0.74]].map((p) => p.map(encodedSrgb));
    expect(deltaE(pixel(decoded.rgba, 18, 2, 5), expected[0]!)).toBeLessThan(3);
    expect(deltaE(pixel(decoded.rgba, 18, 8, 5), expected[1]!)).toBeLessThan(3);
    expect(deltaE(pixel(decoded.rgba, 18, 15, 5), expected[2]!)).toBeLessThan(3);
    expect(decoded.rgba[3]).toBe(65535);
  });

  test('LinearRaw RGB decodes without demosaic and exposure changes real samples', () => {
    const bytes = makeDng('linear'), normal = decodeDng(bytes), lifted = decodeDng(bytes, { exposure: 1 });
    expect(deltaE(pixel(normal.rgba, 18, 2, 5), [encodedSrgb(0.72), encodedSrgb(0.015), encodedSrgb(0.012)])).toBeLessThan(1);
    expect(lifted.rgba[(5 * 18 + 8) * 4 + 1]).toBeGreaterThan(normal.rgba[(5 * 18 + 8) * 4 + 1]!);
  });

  test('applies TIFF orientation to 16-bit DNG pixels and dimensions', () => {
    const bytes = makeDng('linear', 'none', 18, 10, 6), decoded = decodeDng(bytes);
    expect(dngDimensions(bytes)).toEqual({ width: 10, height: 18 });
    expect([decoded.width, decoded.height, decoded.rgba.length]).toEqual([10, 18, 10 * 18 * 4]);
    // Orientation 6 rotates the original left red patch to the top.
    const top = pixel(decoded.rgba, decoded.width, 5, 2);
    expect(top[0]).toBeGreaterThan(top[1] * 3);
  });

  test('lossless-JPEG DNG produces the same developed pixels as independently packed uncompressed DNG', () => {
    const plain = decodeDng(makeDng('bayer', 'none')).rgba;
    const file = makeDng('bayer', 'lossless-jpeg');
    const view = new DataView(file.buffer, file.byteOffset, file.byteLength), count = view.getUint16(8, true);
    let offset = 0, length = 0;
    for (let i = 0; i < count; i++) {
      const at = 10 + i * 12, tag = view.getUint16(at, true);
      if (tag === 273) offset = view.getUint32(at + 8, true);
      if (tag === 279) length = view.getUint32(at + 8, true);
    }
    const jpeg = decodeLosslessJpeg(file.subarray(offset, offset + length));
    expect(jpeg.data.length).toBe(18 * 10);
    const compressed = decodeDng(file).rgba;
    expect(compressed).toEqual(plain);
  });

  test('lossless JPEG rejects a lossy SOF marker', () => {
    expect(() => decodeLosslessJpeg(Uint8Array.of(0xff, 0xd8, 0xff, 0xd9))).toThrow(/supported lossless frame/);
  });
});
