import { describe, expect, it } from 'vitest';
import { decodeImageFile } from '../../src/io/imageImport';
import { decodeJpegSamples } from '../../src/io/jpeg';
import { loadLittleCms } from '../../src/wasm/lcms';

// 8x8 four-quadrant fixtures generated with libjpeg-turbo 3.1.2 at quality 100. The CMYK
// fixtures differ only in sample polarity and APP14 presence; the YCCK fixture uses transform 2.
const ADOBE_CMYK = bytes('/9j/7gAOQWRvYmUAZAAAAAAA/9sAQwABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB/8AAFAgACAAIBEMRAE0RAFkRAEsRAP/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/aAA4EQwBNAFkASwAAPwD9Wv8Ag4F+BP8AwnX/AAyV/wAVT/Zf9l/8L5/5gf27z/t3/CmP+ovZ+V5X2P8A6ab/ADP4NnzfU3gD9oj/AIdPf2t/xR//AAvz/hfn2D/mYP8AhVn/AAif/CrPtv8A1BPiN/bv9u/8LG/6g39mf2N/zEf7R/0HzX/g2g+Df/DTn/Dav/FR/wDCEf8ACEf8M4f8wj/hJf7T/wCEl/4Xz/1FNA+xfYv7A/6e/tP2v/lh5H77+pr9nf4yf8Nvf8Jh/wAU5/wrH/hWP/CP/wDMX/4TT+2/+E0/tv8A6hfhP+zf7N/4RP8A6iH2z+0P+XX7L/pP/9k=');
const PLAIN_CMYK = bytes('/9j/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAAUCAAIAAgEQxEATREAWREASxEA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADgRDAE0AWQBLAAA/APyd/wCDfr47f8IL/wANa/8AFLf2p/an/Chv+Y59h8j7D/wuf/qEXnm+b9s/6Z7PL/j3/L8o+P8A9nf/AIew/wBk/wDFYf8ACg/+FB/b/wDmX/8Ahaf/AAln/C0/sX/Ub+HP9hf2F/wrn/qM/wBp/wBs/wDMO/s7/TvQv+Dl/wCMn/DMf/DFX/FOf8Jv/wAJv/w0f/zF/wDhGv7M/wCEa/4UN/1C9f8Atv23+3/+nT7N9k/5b+f+5/ld/aI+Df8AwxD/AMIf/wAVH/ws7/hZ3/CQf8wj/hC/7E/4Qv8AsT/qKeLP7S/tL/hLP+of9j/s/wD5evtX+jf/2Q==');
const ADOBE_YCCK = bytes('/9j/7gAOQWRvYmUAZAAAAAAC/9sAQwABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB/9sAQwEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB/8AAFAgACAAIBAERAAIRAQMRAQQRAP/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/aAA4EAQACEQMRBAAAPwD438IeHv8Ahqv+0f8ATP8AhA/+ED+yf8u//CUf2r/wlH2n/pv4d+w/Yf8AhHf+nz7T9s/5d/s/7/8Apb9rp4lf8Si/8S+/8Iv/ABEH/iIP/EV/+Zl/qn/ZH+qf/ENf+oDiX6/9f/1l/wCoL6r9S/5ifrP7j8R/ZYeNf/Ern/Edv+MZ/wBef9ef+IYf8zn/AFZ/sv8A1Z/4iH/1KuIPrv13/WD/AKhPq31T/mI+sfuf6mv2d/jJ/wANvf8ACYf8U5/wrH/hWP8Awj//ADF/+E0/tv8A4TT+2/8AqF+E/wCzf7N/4RP/AKiH2z+0P+XX7L/pP//Z');

const QUADRANTS = [
  { at: 0, value: [20, 150, 210, 15] },
  { at: 4, value: [180, 25, 90, 45] },
  { at: 32, value: [5, 80, 230, 110] },
  { at: 36, value: [130, 170, 15, 5] },
] as const;

describe('four-component JPEG import (ImageImportTests.orientationAndColorConversion)', () => {
  it('normalizes Adobe-inverted CMYK APP14 transform 0 samples', async () => {
    expect(adobeTransform(ADOBE_CMYK)).toBe(0);
    checkCmyk(await decodeJpegSamples(ADOBE_CMYK), 0);
  });

  it('keeps non-inverted CMYK samples when no Adobe APP14 marker is present', async () => {
    expect(adobeTransform(PLAIN_CMYK)).toBeNull();
    checkCmyk(await decodeJpegSamples(PLAIN_CMYK), 0);
  });

  it('converts Adobe YCCK transform 2 to normalized CMYK samples', async () => {
    expect(adobeTransform(ADOBE_YCCK)).toBe(2);
    checkCmyk(await decodeJpegSamples(ADOBE_YCCK), 2);
  });

  it.each([
    ['Adobe-inverted CMYK', ADOBE_CMYK],
    ['non-inverted CMYK', PLAIN_CMYK],
    ['Adobe YCCK', ADOBE_YCCK],
  ])('converts an embedded CMYK profile for %s', async (_name, jpeg) => {
    const lcms = await loadLittleCms();
    const profile = lcms.createCmykProfile();
    const tagged = withIcc(jpeg, profile);
    const samples = await decodeJpegSamples(tagged);
    const expected = lcms.transform(profile, samples.data, 'cmyk', 8);
    expect((await decodeImageFile(tagged, 64)).toPixels()).toEqual(expected);
  });

  it('uses the documented generic CMYK profile for an untagged JPEG', async () => {
    const lcms = await loadLittleCms();
    const samples = await decodeJpegSamples(PLAIN_CMYK);
    const expected = lcms.transform(lcms.createCmykProfile(), samples.data, 'cmyk', 8);
    const actual = (await decodeImageFile(PLAIN_CMYK, 64)).toPixels();
    expect(actual).toEqual(expected);
    expect(Array.from(actual.subarray(0, 4))).toEqual(Array.from(expected.subarray(0, 4)));
  });
});

function checkCmyk(decoded: Awaited<ReturnType<typeof decodeJpegSamples>>, tolerance: number): void {
  expect([decoded.width, decoded.height, decoded.model]).toEqual([8, 8, 'cmyk']);
  for (const sample of QUADRANTS) {
    const at = sample.at * 4;
    for (let channel = 0; channel < 4; channel++) {
      expect(Math.abs(decoded.data[at + channel]! - sample.value[channel]!), `${sample.at}:${channel}`).toBeLessThanOrEqual(tolerance);
    }
  }
}

function withIcc(jpeg: Uint8Array, profile: Uint8Array): Uint8Array {
  const maximum = 65_519;
  const count = Math.ceil(profile.length / maximum);
  const segments: Uint8Array[] = [];
  for (let sequence = 1; sequence <= count; sequence++) {
    const part = profile.subarray((sequence - 1) * maximum, Math.min(sequence * maximum, profile.length));
    const payload = join([new TextEncoder().encode('ICC_PROFILE\0'), new Uint8Array([sequence, count]), part]);
    const segment = new Uint8Array(payload.length + 4), length = payload.length + 2;
    segment.set([0xff, 0xe2, length >>> 8, length], 0); segment.set(payload, 4); segments.push(segment);
  }
  return join([jpeg.subarray(0, 2), ...segments, jpeg.subarray(2)]);
}

function adobeTransform(jpeg: Uint8Array): number | null {
  for (let at = 2; at + 16 <= jpeg.length;) {
    if (jpeg[at] !== 0xff) return null;
    const marker = jpeg[at + 1]!, length = (jpeg[at + 2]! << 8) | jpeg[at + 3]!;
    if (marker === 0xee && String.fromCharCode(...jpeg.subarray(at + 4, at + 9)) === 'Adobe') return jpeg[at + 15]!;
    if (marker === 0xda || length < 2) return null;
    at += length + 2;
  }
  return null;
}

function bytes(base64: string): Uint8Array { return new Uint8Array(Buffer.from(base64, 'base64')); }
function join(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}
