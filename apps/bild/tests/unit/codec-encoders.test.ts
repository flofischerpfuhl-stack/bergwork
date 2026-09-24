import { describe, expect, it } from 'vitest';
import { encodeAvif } from '../../src/io/avif';
import { encodeWebp, WebpError } from '../../src/io/webp';
import { decodeAvifWasm } from '../../src/wasm/avif';
import { decodeWebpWasm } from '../../src/wasm/webp';

function pixels(): Uint8Array {
  const data = new Uint8Array(6 * 4 * 4);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 6; x++) {
    const at = (y * 6 + x) * 4;
    data[at] = x * 40; data[at + 1] = y * 70; data[at + 2] = 255 - x * 30; data[at + 3] = 32 + y * 60;
  }
  return data;
}

describe('lazy WebP/AVIF encoders', () => {
  it('libwebp lossless encode/decode preserves straight RGBA including alpha', async () => {
    const source = pixels(), encoded = await encodeWebp(source, 6, 4, { quality: 1, alphaQuality: 1, lossless: true });
    expect(await decodeWebpWasm(encoded, 6, 4)).toEqual(source);
  });

  it('libavif/libaom encode and dav1d decode preserve dimensions, colour, and alpha', async () => {
    const source = pixels(), encoded = await encodeAvif(source, 6, 4, { quality: 1, alphaQuality: 1, speed: 10 });
    const decoded = await decodeAvifWasm(encoded);
    expect([decoded.width, decoded.height]).toEqual([6, 4]);
    for (const [x, y] of [[0, 0], [5, 0], [0, 3], [5, 3]] as const) {
      const at = (y * 6 + x) * 4;
      expect(decoded.data[at]).toBeCloseTo(source[at]!, -1);
      expect(decoded.data[at + 1]).toBeCloseTo(source[at + 1]!, -1);
      expect(decoded.data[at + 3]).toBeCloseTo(source[at + 3]!, -1);
    }
  }, 30_000);

  it('validates dimensions, pixel buffers, quality, alpha quality, and speed before loading codecs', async () => {
    await expect(encodeWebp(new Uint8Array(3), 1, 1)).rejects.toBeInstanceOf(WebpError);
    await expect(encodeWebp(new Uint8Array(4), 1, 1, { quality: 2 })).rejects.toThrow(/quality/);
    await expect(encodeAvif(new Uint8Array(4), 1, 1, { alphaQuality: -1 })).rejects.toThrow(/alphaQuality/);
    await expect(encodeAvif(new Uint8Array(4), 1, 1, { speed: 11 })).rejects.toThrow(/speed/);
  });
});
