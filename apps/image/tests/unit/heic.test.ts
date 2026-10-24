import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeImageFile, ImageImportError } from '../../src/io/imageImport';
import { decodeHeic, heicDimensions, orientRgba, type HeicDecoder } from '../../src/io/heic';
import type { ImageDecoderHost } from '../../src/platform/imageDecoder';

const fixture = new Uint8Array(readFileSync(new URL('../e2e/heic-quadrants.heic', import.meta.url)));
const pixel = (red: number, green: number, blue: number, alpha = 255) => new Uint8Array([red, green, blue, alpha]);

function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const length = 8 + parts.reduce((sum, part) => sum + part.byteLength, 0);
  const result = new Uint8Array(length);
  new DataView(result.buffer).setUint32(0, length);
  result.set(new TextEncoder().encode(type), 4);
  let at = 8;
  for (const part of parts) { result.set(part, at); at += part.byteLength; }
  return result;
}

function u32(value: number): Uint8Array {
  const result = new Uint8Array(4);
  new DataView(result.buffer).setUint32(0, value);
  return result;
}

describe('pluggable HEIC import', () => {
  it('ImageImportTests.supportedFormats: reads the primary ispe before decoding', () => {
    expect(heicDimensions(fixture)).toEqual({ width: 64, height: 64 });
  });

  it('uses the primary item association and irot instead of the first auxiliary ispe', () => {
    const full = new Uint8Array(4);
    const ispe = (width: number, height: number) => box('ispe', full, u32(width), u32(height));
    const pitm = box('pitm', full, new Uint8Array([0, 2]));
    const ipco = box('ipco', ispe(10, 20), ispe(30, 40), box('irot', new Uint8Array([1])));
    const ipma = box('ipma', full, u32(1), new Uint8Array([0, 2, 2, 0x82, 0x83]));
    const meta = box('meta', full, pitm, box('iprp', ipco, ipma));
    const ftyp = box('ftyp', new TextEncoder().encode('heic'), u32(0), new TextEncoder().encode('mif1'));
    const bytes = new Uint8Array(ftyp.byteLength + meta.byteLength);
    bytes.set(ftyp); bytes.set(meta, ftyp.byteLength);
    expect(heicDimensions(bytes)).toEqual({ width: 40, height: 30 });
  });

  it('tries browser native before host and LGPL WASM', async () => {
    const calls: string[] = [];
    const browser: HeicDecoder = async () => { calls.push('browser'); return { width: 1, height: 1, data: pixel(1, 2, 3) }; };
    const host: ImageDecoderHost = {
      heicDecoder: 'lgpl-wasm',
      async decodeImage() { calls.push('host'); return { width: 1, height: 1, rgba: pixel(4, 5, 6) }; },
    };
    const wasm: HeicDecoder = async () => { calls.push('wasm'); return { width: 1, height: 1, data: pixel(7, 8, 9) }; };
    const result = await decodeHeic(fixture, { browserDecoder: browser, host, wasmDecoder: wasm });
    expect(calls).toEqual(['browser']);
    expect(result.data).toEqual(pixel(1, 2, 3));
  });

  it('falls back from browser to host and applies ImageImporter EXIF orientation', async () => {
    const calls: string[] = [];
    const host: ImageDecoderHost = {
      async decodeImage(_bytes, mime) {
        calls.push(`host:${mime}`);
        return { width: 2, height: 1, rgba: new Uint8Array([...pixel(255, 0, 0), ...pixel(0, 255, 0)]), orientation: 6 };
      },
    };
    const result = await decodeHeic(fixture, {
      browserDecoder: async () => { calls.push('browser'); return null; }, host,
    });
    expect(calls).toEqual(['browser', 'host:image/heic']);
    expect({ width: result.width, height: result.height }).toEqual({ width: 1, height: 2 });
    expect(Array.from(result.data)).toEqual([...pixel(255, 0, 0), ...pixel(0, 255, 0)]);
  });

  it('loads LGPL WASM only after opt-in and earlier decoders decline', async () => {
    const calls: string[] = [];
    const host: ImageDecoderHost = {
      heicDecoder: 'lgpl-wasm',
      async decodeImage() { calls.push('host'); return null; },
    };
    const raster = await decodeImageFile(fixture, 5_000, {
      browserDecoder: async () => { calls.push('browser'); return null; },
      host,
      wasmDecoder: async () => { calls.push('wasm'); return { width: 1, height: 1, data: pixel(9, 8, 7) }; },
    });
    expect(calls).toEqual(['browser', 'host', 'wasm']);
    expect(raster.pixel(0, 0)).toEqual([9, 8, 7, 255]);
  });

  it('keeps the readable Chromium error and never touches LGPL WASM when disabled', async () => {
    let wasmCalls = 0;
    await expect(decodeImageFile(fixture, 5_000, {
      browserDecoder: async () => null,
      host: { async decodeImage() { return null; } },
      wasmDecoder: async () => { wasmCalls++; return { width: 1, height: 1, data: pixel(0, 0, 0) }; },
    })).rejects.toEqual(new ImageImportError(
      'unsupported', 'This browser cannot decode HEIC. Convert the image to JPEG or PNG and try again.',
    ));
    expect(wasmCalls).toBe(0);
  });

  it('ImageImportTests.limitsAndInvalidFiles: rejects budget before any decoder', async () => {
    let calls = 0;
    await expect(decodeImageFile(fixture, 4_095, {
      browserDecoder: async () => { calls++; return null; },
      host: { async decodeImage() { calls++; return null; } },
    })).rejects.toMatchObject({ code: 'too-large' });
    expect(calls).toBe(0);
  });

  it('maps all EXIF orientation cases to the oriented RGBA grid', () => {
    const source = new Uint8Array([...pixel(1, 0, 0), ...pixel(2, 0, 0), ...pixel(3, 0, 0), ...pixel(4, 0, 0)]);
    const expected = [[1, 2, 3, 4], [2, 1, 4, 3], [4, 3, 2, 1], [3, 4, 1, 2],
      [1, 3, 2, 4], [3, 1, 4, 2], [4, 2, 3, 1], [2, 4, 1, 3]];
    for (let orientation = 1; orientation <= 8; orientation++) {
      const result = orientRgba(source, 2, 2, orientation as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8);
      expect(Array.from(result.data.filter((_, i) => i % 4 === 0))).toEqual(expected[orientation - 1]);
    }
  });
});
