import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { avifDimensions, avifHasIccProfile, decodeManagedAvif, encodeAvif, isAvif } from '../../src/io/avif';
import { gifDimensions, isGif } from '../../src/io/gif';
import { decodeImageFile, ImageImportError, sniffImage } from '../../src/io/imageImport';
import { decodeManagedWebp, encodeWebp, isWebp, webpDimensions, webpIccProfile } from '../../src/io/webp';
import { decodeAvifWasm } from '../../src/wasm/avif';
import { decodeWebpWasm } from '../../src/wasm/webp';
import { loadLittleCms } from '../../src/wasm/lcms';

const GIF = new Uint8Array(Buffer.from(
  'R0lGODlhBAACAPEAAP8AAAD/AP///wAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQAZAAAACH/C0ltYWdlTWFnaWNrDmdhbW1hPTAuNDU0NTQ1ACwAAAAABAACAAACBAQShgUAIfkEAGQAAAAh/wtJbWFnZU1hZ2ljaw5nYW1tYT0wLjQ1NDU0NQAsAAAAAAQAAgCAAAD/////AgOEbwUAOw==',
  'base64',
));
const ANIMATED_WEBP = new Uint8Array(Buffer.from(
  'UklGRooAAABXRUJQVlA4WAoAAAACAAAAAwAAAQAAQU5JTQYAAAAAAP//AABBTk1GLgAAAAAAAAAAAAMAAAEAAOgDAAJWUDhMFgAAAC8DQAAAD7D/8x/zHxUUAgiAgiai//FBTk1GKAAAAAAAAAAAAAMAAAEAAOgDAABWUDhMDwAAAC8DQAAABxDR//4HIqL/AQA=',
  'base64',
));

function quadrants(width = 8, height = 8): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = (y * width + x) * 4;
    pixels[at] = x < width / 2 ? 255 : 0;
    pixels[at + 1] = x < width / 2 ? 0 : 255;
    pixels[at + 2] = 0;
    pixels[at + 3] = y < height / 2 ? 255 : 96;
  }
  return pixels;
}

describe('WebP/AVIF/GIF routing', () => {
  it('ImageImportTests.supportedFormats: sniffs real encoded files and reads dimensions before decode', async () => {
    const pixels = quadrants();
    const webp = await encodeWebp(pixels, 8, 8, { lossless: true });
    const avif = await encodeAvif(pixels, 8, 8, { quality: 1, alphaQuality: 1, speed: 10 });
    expect(isWebp(webp)).toBe(true);
    expect(isAvif(avif)).toBe(true);
    expect(isGif(GIF)).toBe(true);
    expect(sniffImage(webp)).toBe('image/webp');
    expect(sniffImage(avif)).toBe('image/avif');
    expect(sniffImage(GIF)).toBe('image/gif');
    expect(webpDimensions(webp)).toEqual({ width: 8, height: 8 });
    expect(avifDimensions(avif)).toEqual({ width: 8, height: 8 });
    expect(gifDimensions(GIF)).toEqual({ width: 4, height: 2 });
  }, 30_000);

  it('ImageImportTests.limitsAndInvalidFiles: rejects all three over budget before native decode', async () => {
    const pixels = quadrants();
    const webp = await encodeWebp(pixels, 8, 8, { lossless: true });
    const avif = await encodeAvif(pixels, 8, 8, { quality: 1, speed: 10 });
    for (const bytes of [webp, avif, GIF]) {
      let calls = 0;
      await expect(decodeImageFile(bytes, 1, { nativeDecoder: async () => { calls++; return null; } }))
        .rejects.toEqual(new ImageImportError('too-large'));
      expect(calls).toBe(0);
    }
  }, 30_000);

  it('rejects oversized animated frame descriptors before invoking a decoder', async () => {
    const webp = ANIMATED_WEBP.slice(), anmf = findAscii(webp, 'ANMF');
    webp.fill(0xff, anmf + 14, anmf + 17); // first-frame width minus one
    const gif = GIF.slice(), image = gif.findIndex((value, index) => index >= 13 && value === 0x2c);
    gif[image + 5] = 0xff; gif[image + 6] = 0xff;
    for (const bytes of [webp, gif]) {
      let calls = 0;
      await expect(decodeImageFile(bytes, 100_000_000, { nativeDecoder: async () => { calls++; return null; } }))
        .rejects.toMatchObject({ code: 'too-large' });
      expect(calls).toBe(0);
    }
  });

  it('routes native first-frame results into straight-alpha document rasters', async () => {
    const expected = quadrants(), webp = await encodeWebp(expected, 8, 8, { lossless: true });
    const avif = await encodeAvif(expected, 8, 8, { quality: 1, alphaQuality: 1, speed: 10 });
    const webpRaster = await decodeImageFile(webp, 1_000, { nativeDecoder: async (bytes) => {
      const size = webpDimensions(bytes); return { ...size, data: await decodeWebpWasm(bytes, size.width, size.height) };
    } });
    const avifRaster = await decodeImageFile(avif, 1_000, { nativeDecoder: async (bytes) => decodeAvifWasm(bytes) });
    expect(webpRaster.pixel(1, 1)).toEqual([255, 0, 0, 255]);
    expect(webpRaster.pixel(6, 6)).toEqual([0, 255, 0, 96]);
    expect(avifRaster.pixel(1, 1)[0]).toBeGreaterThan(230);
    expect(avifRaster.pixel(6, 1)[1]).toBeGreaterThan(230);
    expect(avifRaster.pixel(6, 6)[3]).toBeCloseTo(96, -1);
  }, 30_000);

  it('documents animated WebP first-frame import in the deterministic decoder', async () => {
    expect(webpDimensions(ANIMATED_WEBP)).toEqual({ width: 4, height: 2 });
    const decoded = await decodeWebpWasm(ANIMATED_WEBP, 4, 2);
    expect(Array.from(decoded.subarray(0, 4))).toEqual([255, 0, 0, 255]);
    expect(Array.from(decoded.subarray(12, 16))).toEqual([0, 255, 0, 255]);
  });

  it('converts embedded WebP and AVIF RGB profiles through Little CMS without calling native decoders', async () => {
    const lcms = await loadLittleCms();
    const profile = lcms.createRgbProfile({
      white: [0.3127, 0.329], red: [0.64, 0.33], green: [0.3, 0.6], blue: [0.15, 0.06],
    }, 1);
    const source = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < source.length; i += 4) {
      source[i] = 128; source[i + 1] = 64; source[i + 2] = 32; source[i + 3] = 96;
    }
    const webp = await encodeWebp(source, 4, 4, { lossless: true, iccProfile: profile });
    const avif = await encodeAvif(source, 4, 4, { quality: 1, alphaQuality: 1, speed: 10, iccProfile: profile });
    expect(webpIccProfile(webp)).toEqual(profile);
    expect(avifHasIccProfile(avif)).toBe(true);
    const managedWebp = await decodeManagedWebp(webp), managedAvif = await decodeManagedAvif(avif);
    expect(managedWebp.data[0]).toBeGreaterThan(170);
    expect(managedAvif.data[0]).toBeGreaterThan(170);
    expect(managedWebp.data[3]).toBe(96);
    expect(managedAvif.data[3]).toBeCloseTo(96, -1);
    let nativeCalls = 0;
    const nativeDecoder = async () => { nativeCalls++; return null; };
    expect((await decodeImageFile(webp, 1_000, { nativeDecoder })).pixel(0, 0)[0]).toBeGreaterThan(170);
    expect((await decodeImageFile(avif, 1_000, { nativeDecoder })).pixel(0, 0)[0]).toBeGreaterThan(170);
    expect(nativeCalls).toBe(0);
  }, 30_000);
});

function findAscii(bytes: Uint8Array, text: string): number {
  const encoded = new TextEncoder().encode(text);
  for (let at = 0; at + encoded.length <= bytes.length; at++) {
    let match = true;
    for (let i = 0; i < encoded.length; i++) if (bytes[at + i] !== encoded[i]) { match = false; break; }
    if (match) return at;
  }
  return -1;
}
