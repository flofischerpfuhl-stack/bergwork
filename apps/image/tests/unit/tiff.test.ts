import { deflateRawSync, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodeHeic, HeicError, heicDimensions, isHeic } from '../../src/io/heic';
import { decodeImageFile, ImageImportError, sniffImage } from '../../src/io/imageImport';
import { decodeTiff, TiffError, tiffDimensions } from '../../src/io/tiff';

describe('TIFF decoder (ImageImporter.swift)', () => {
  it('ImageImportTests.supportedFormats: decodes little- and big-endian stripped RGB', async () => {
    const samples = [255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 8, 7];
    for (const little of [true, false]) {
      const decoded = await decodeTiff(makeTiff({ width: 2, height: 2, samples: 3, photometric: 2, pixels: samples, little, rowsPerStrip: 100 }));
      expect(decoded.data).toEqual(rgba(samples));
    }
  });

  it('decodes tiled RGB and ignores padded edge pixels', async () => {
    const pixels = Array.from({ length: 3 * 3 * 3 }, (_, i) => (i * 41 + 7) & 255);
    const decoded = await decodeTiff(makeTiff({ width: 3, height: 3, samples: 3, photometric: 2, pixels, tile: [2, 2] }));
    expect(decoded.data).toEqual(rgba(pixels));
  });

  it('decodes LZW with and without horizontal predictor 2', async () => {
    const pixels = Array.from({ length: 263 * 3 * 3 }, (_, i) => (i * 67 + Math.floor(i / 13)) & 255);
    for (const predictor of [1, 2] as const) {
      const decoded = await decodeTiff(makeTiff({
        width: 263, height: 3, samples: 3, photometric: 2, pixels, compression: 5, predictor, rowsPerStrip: 2,
      }));
      expect(decoded.data).toEqual(rgba(pixels));
    }
  });

  it('rejects floating-point predictor 3 cleanly', async () => {
    const fixture = makeTiff({ width: 1, height: 1, samples: 3, photometric: 2, pixels: [1, 2, 3], compression: 5, predictor: 3 });
    await expect(decodeTiff(fixture)).rejects.toThrow(/predictor 3/);
  });

  it('decodes PackBits and both Deflate TIFF compression tags', async () => {
    const pixels = Array.from({ length: 17 * 4 * 3 }, (_, i) => i < 40 ? 44 : (i * 19) & 255);
    for (const compression of [32773, 8, 32946] as const) {
      const decoded = await decodeTiff(makeTiff({ width: 17, height: 4, samples: 3, photometric: 2, pixels, compression }));
      expect(decoded.data).toEqual(rgba(pixels));
    }
  });

  it('decodes 1-bit WhiteIsZero/BlackIsZero and 16-bit RGB', async () => {
    const black = await decodeTiff(makeTiff({ width: 5, height: 1, bits: 1, samples: 1, photometric: 1, pixels: [0, 1, 0, 1, 1] }));
    expect(black.data).toEqual(new Uint8Array([
      0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    ]));
    const white = await decodeTiff(makeTiff({ width: 3, height: 1, bits: 1, samples: 1, photometric: 0, pixels: [0, 1, 0] }));
    expect(white.data).toEqual(new Uint8Array([255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255]));
    const rgb16 = await decodeTiff(makeTiff({
      width: 2, height: 1, bits: 16, samples: 3, photometric: 2, little: false,
      pixels: [0, 32768, 65535, 257, 65534, 32767], compression: 5, predictor: 2,
    }));
    expect(rgb16.data).toEqual(new Uint8Array([0, 128, 255, 255, 1, 255, 127, 255]));
  });

  it('decodes Palette, naive CMYK, and uncompressed YCbCr', async () => {
    const palette = [65535, 0, 0, 65535, 0, 0];
    const indexed = await decodeTiff(makeTiff({ width: 2, height: 1, bits: 1, samples: 1, photometric: 3, pixels: [0, 1], palette }));
    expect(indexed.data).toEqual(new Uint8Array([
      255, 0, 0, 255, 0, 255, 0, 255,
    ]));
    const cmyk = await decodeTiff(makeTiff({ width: 2, height: 1, samples: 4, photometric: 5, pixels: [0, 255, 255, 0, 0, 0, 0, 128] }));
    expect(cmyk.data).toEqual(new Uint8Array([255, 0, 0, 255, 127, 127, 127, 255]));
    const ycbcr = await decodeTiff(makeTiff({
      width: 3, height: 1, samples: 3, photometric: 6, pixels: [10, 128, 128, 100, 128, 128, 240, 128, 128], ycbcr: true,
    }));
    expect(ycbcr.data).toEqual(new Uint8Array([10, 10, 10, 255, 100, 100, 100, 255, 240, 240, 240, 255]));
  });

  it('handles unassociated and associated alpha as straight RGBA8', async () => {
    const straight = await decodeTiff(makeTiff({
      width: 2, height: 1, samples: 4, photometric: 2, extraSamples: [2], pixels: [200, 100, 50, 128, 4, 5, 6, 0],
    }));
    expect(straight.data).toEqual(new Uint8Array([200, 100, 50, 128, 4, 5, 6, 0]));
    const associated = await decodeTiff(makeTiff({
      width: 2, height: 1, samples: 4, photometric: 2, extraSamples: [1], pixels: [100, 50, 25, 128, 9, 8, 7, 0],
    }));
    expect(associated.data).toEqual(new Uint8Array([199, 100, 50, 128, 0, 0, 0, 0]));
  });

  it('decodes PlanarConfiguration 2 with predictor and alpha', async () => {
    const pixels = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160];
    const decoded = await decodeTiff(makeTiff({
      width: 2, height: 2, samples: 4, photometric: 2, planar: 2, extraSamples: [2], pixels, compression: 5, predictor: 2, rowsPerStrip: 1,
    }));
    expect(decoded.data).toEqual(new Uint8Array(pixels));
  });

  it('ImageImportTests.orientationAndColorConversion: applies all TIFF orientations', async () => {
    const source = [255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0, 255, 0, 255, 0, 255, 255];
    const expected = [
      [[0, 1, 2], [3, 4, 5]], [[2, 1, 0], [5, 4, 3]], [[5, 4, 3], [2, 1, 0]], [[3, 4, 5], [0, 1, 2]],
      [[0, 3], [1, 4], [2, 5]], [[3, 0], [4, 1], [5, 2]], [[5, 2], [4, 1], [3, 0]], [[2, 5], [1, 4], [0, 3]],
    ];
    for (let orientation = 1; orientation <= 8; orientation++) {
      const decoded = await decodeTiff(makeTiff({ width: 3, height: 2, samples: 3, photometric: 2, pixels: source, orientation }));
      const ids = expected[orientation - 1]!;
      expect([decoded.width, decoded.height]).toEqual([ids[0]!.length, ids.length]);
      const actual: number[] = [];
      for (let i = 0; i < decoded.data.length; i += 4) actual.push(colorId(decoded.data.subarray(i, i + 3)));
      expect(actual).toEqual(ids.flat());
    }
  });

  it('returns DPI/ICC metadata and decodes only the first IFD', async () => {
    const fixture = makeTiff({
      width: 2, height: 1, samples: 3, photometric: 2, pixels: [1, 2, 3, 4, 5, 6], dpi: [300, 150], resolutionUnit: 2,
      icc: new Uint8Array([1, 2, 3, 4, 5]), secondIfd: true,
    });
    expect(tiffDimensions(fixture)).toEqual({ width: 2, height: 1, dpi: { x: 300, y: 150 }, hasIcc: true });
    const decoded = await decodeTiff(fixture);
    expect(decoded.dpi).toEqual({ x: 300, y: 150 });
    expect(decoded.hasIcc).toBe(true);
    expect(decoded.data).toEqual(new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255]));

    const cm = await decodeTiff(makeTiff({
      width: 1, height: 1, samples: 1, photometric: 1, pixels: [8], dpi: [100, 50], resolutionUnit: 3,
    }));
    expect(cm.dpi).toEqual({ x: 254, y: 127 });
  });

  it('routes TIFF imports through the decoder and enforces budget before pixel decode', async () => {
    const fixture = makeTiff({ width: 2, height: 1, samples: 3, photometric: 2, pixels: [1, 2, 3, 4, 5, 6] });
    expect(sniffImage(fixture)).toBe('image/tiff');
    const raster = await decodeImageFile(fixture, 2);
    expect(raster.toPixels()).toEqual(new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255]));
    await expect(decodeImageFile(fixture, 1)).rejects.toMatchObject({ code: 'too-large' });
  });

  it('rejects JPEG-in-TIFF clearly when no browser decoder is available', async () => {
    const fixture = makeTiff({ width: 1, height: 1, samples: 3, photometric: 2, pixels: [1, 2, 3], compression: 7 });
    await expect(decodeTiff(fixture)).rejects.toMatchObject({ code: 'unsupported' });
    await expect(decodeTiff(fixture)).rejects.toThrow(/JPEG-in-TIFF/);
  });

  it('throws typed errors quickly for truncation, huge dimensions, and bad offsets', async () => {
    const valid = makeTiff({ width: 2, height: 2, samples: 3, photometric: 2, pixels: new Array(12).fill(7) });
    for (let length = 0; length < Math.min(valid.length, 80); length++) {
      expect(() => tiffDimensions(valid.subarray(0, length))).toThrow(TiffError);
    }
    const huge = valid.slice();
    new DataView(huge.buffer).setUint32(findEntryValue(huge, 256), 30_001, true);
    expect(() => tiffDimensions(huge)).toThrow(/30,000/);
    const badOffset = valid.slice();
    new DataView(badOffset.buffer).setUint32(findEntryValue(badOffset, 273), 0xfffffff0, true);
    await expect(decodeTiff(badOffset)).rejects.toBeInstanceOf(TiffError);
    await expect(decodeTiff(valid.subarray(0, valid.length - 1))).rejects.toBeInstanceOf(TiffError);
  });

  it('decodes a 4000x3000 LZW RGB TIFF within a bounded benchmark', { timeout: 30_000 }, async () => {
    const width = 4000, height = 3000;
    const row = new Array<number>(width * 3);
    for (let i = 0; i < row.length; i++) row[i] = (i * 29) & 255;
    const pixels = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y++) pixels.set(row, y * row.length);
    const fixture = makeTiff({ width, height, samples: 3, photometric: 2, pixels, compression: 5, predictor: 2, rowsPerStrip: 64 });
    const started = performance.now();
    const decoded = await decodeTiff(fixture);
    const elapsed = performance.now() - started;
    console.info(`TIFF 4000x3000 LZW RGB decode: ${elapsed.toFixed(1)} ms`);
    expect(decoded.data.length).toBe(width * height * 4);
    expect(decoded.data.subarray(0, 4)).toEqual(new Uint8Array([0, 29, 58, 255]));
    expect(elapsed).toBeLessThan(30_000);
  });
});

describe('HEIC handling policy', () => {
  it('detects compatible brands and probes ispe dimensions', () => {
    const fixture = makeHeic(640, 480, 'mif1', 'heic');
    expect(isHeic(fixture)).toBe(true);
    expect(sniffImage(fixture)).toBe('image/heic');
    expect(heicDimensions(fixture)).toEqual({ width: 640, height: 480 });
  });

  it('returns the exact conversion guidance without a native browser codec', async () => {
    const fixture = makeHeic(1, 1, 'heic');
    await expect(decodeHeic(fixture)).rejects.toEqual(new HeicError('unsupported'));
    await expect(decodeImageFile(fixture, 1)).rejects.toEqual(new ImageImportError(
      'unsupported', 'This browser cannot decode HEIC. Convert the image to JPEG or PNG and try again.',
    ));
  });
});

type Compression = 1 | 5 | 7 | 8 | 32946 | 32773;

interface TiffFixtureOptions {
  width: number;
  height: number;
  samples: number;
  photometric: 0 | 1 | 2 | 3 | 5 | 6;
  pixels: ArrayLike<number>;
  bits?: 1 | 2 | 8 | 16;
  little?: boolean;
  compression?: Compression;
  predictor?: 1 | 2 | 3;
  planar?: 1 | 2;
  rowsPerStrip?: number;
  tile?: [number, number];
  orientation?: number;
  extraSamples?: number[];
  palette?: number[];
  dpi?: [number, number];
  resolutionUnit?: 1 | 2 | 3;
  icc?: Uint8Array;
  ycbcr?: boolean;
  secondIfd?: boolean;
}

interface Tag { tag: number; type: number; values: number[] | Uint8Array }

// Independent minimal TIFF writer used only by the tests.
function makeTiff(options: TiffFixtureOptions): Uint8Array {
  const little = options.little ?? true, bits = options.bits ?? 8, compression = options.compression ?? 1;
  const predictor = options.predictor ?? 1, planar = options.planar ?? 1;
  const segments = makeSegments(options, bits, predictor, planar).map((raw) => compress(raw, compression));
  const counts = segments.map((segment) => segment.length);
  const tiled = options.tile !== undefined;
  const tags: Tag[] = [
    { tag: 256, type: 4, values: [options.width] }, { tag: 257, type: 4, values: [options.height] },
    { tag: 258, type: 3, values: new Array(options.samples).fill(bits) }, { tag: 259, type: 3, values: [compression] },
    { tag: 262, type: 3, values: [options.photometric] }, { tag: 277, type: 3, values: [options.samples] },
    { tag: 284, type: 3, values: [planar] }, { tag: 317, type: 3, values: [predictor] },
    { tag: tiled ? 324 : 273, type: 4, values: new Array(segments.length).fill(0) },
    { tag: tiled ? 325 : 279, type: 4, values: counts },
  ];
  if (tiled) tags.push({ tag: 322, type: 4, values: [options.tile![0]] }, { tag: 323, type: 4, values: [options.tile![1]] });
  else tags.push({ tag: 278, type: 4, values: [options.rowsPerStrip ?? options.height] });
  if ((options.orientation ?? 1) !== 1) tags.push({ tag: 274, type: 3, values: [options.orientation!] });
  if (options.extraSamples) tags.push({ tag: 338, type: 3, values: options.extraSamples });
  if (options.palette) tags.push({ tag: 320, type: 3, values: options.palette });
  if (options.ycbcr) tags.push({ tag: 530, type: 3, values: [1, 1] });
  if (options.dpi) {
    tags.push({ tag: 282, type: 5, values: [options.dpi[0], 1] }, { tag: 283, type: 5, values: [options.dpi[1], 1] },
      { tag: 296, type: 3, values: [options.resolutionUnit ?? 2] });
  }
  if (options.icc) tags.push({ tag: 34675, type: 7, values: options.icc });
  tags.sort((a, b) => a.tag - b.tag);

  const ifdEnd = 8 + 2 + tags.length * 12 + 4;
  const externalOffsets = new Map<Tag, number>();
  let cursor = ifdEnd;
  for (const tag of tags) {
    const encoded = encodeValues(tag, little);
    if (encoded.length > 4) { externalOffsets.set(tag, cursor); cursor += encoded.length + (encoded.length & 1); }
  }
  const segmentOffsets: number[] = [];
  for (const segment of segments) { segmentOffsets.push(cursor); cursor += segment.length; }
  const secondOffset = options.secondIfd ? cursor : 0;
  if (options.secondIfd) cursor += 6;
  const output = new Uint8Array(cursor), view = new DataView(output.buffer);
  output[0] = output[1] = little ? 0x49 : 0x4d;
  view.setUint16(2, 42, little); view.setUint32(4, 8, little); view.setUint16(8, tags.length, little);
  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i]!, at = 10 + i * 12;
    if (tag.tag === (tiled ? 324 : 273)) tag.values = segmentOffsets;
    const encoded = encodeValues(tag, little);
    view.setUint16(at, tag.tag, little); view.setUint16(at + 2, tag.type, little);
    view.setUint32(at + 4, valueCount(tag), little);
    if (encoded.length <= 4) output.set(encoded, at + 8);
    else { const external = externalOffsets.get(tag)!; view.setUint32(at + 8, external, little); output.set(encoded, external); }
  }
  view.setUint32(10 + tags.length * 12, secondOffset, little);
  for (let i = 0; i < segments.length; i++) output.set(segments[i]!, segmentOffsets[i]!);
  if (secondOffset) { view.setUint16(secondOffset, 0, little); view.setUint32(secondOffset + 2, 0, little); }
  return output;
}

function makeSegments(options: TiffFixtureOptions, bits: number, predictor: number, planar: number): Uint8Array[] {
  const [storedWidth, storedHeight] = options.tile ?? [options.width, options.rowsPerStrip ?? options.height];
  const across = Math.ceil(options.width / storedWidth), down = Math.ceil(options.height / storedHeight);
  const result: Uint8Array[] = [];
  const planes = planar === 2 ? options.samples : 1;
  for (let plane = 0; plane < planes; plane++) for (let sy = 0; sy < down; sy++) for (let sx = 0; sx < across; sx++) {
    const segmentSamples = planar === 2 ? 1 : options.samples, values: number[] = [];
    const segmentHeight = options.tile ? storedHeight : Math.min(storedHeight, options.height - sy * storedHeight);
    for (let y = 0; y < segmentHeight; y++) for (let x = 0; x < storedWidth; x++) {
      const sourceX = sx * storedWidth + x, sourceY = sy * storedHeight + y;
      for (let channel = 0; channel < segmentSamples; channel++) {
        const sourceChannel = planar === 2 ? plane : channel;
        values.push(sourceX < options.width && sourceY < options.height
          ? options.pixels[(sourceY * options.width + sourceX) * options.samples + sourceChannel]! : 0);
      }
    }
    const packed = packSamples(values, bits, options.little ?? true);
    if (predictor === 2) applyPredictor(packed, storedWidth, segmentHeight, segmentSamples, bits, options.little ?? true);
    result.push(packed);
  }
  return result;
}

function packSamples(values: number[], bits: number, little: boolean): Uint8Array {
  if (bits === 8) return new Uint8Array(values);
  if (bits === 16) {
    const output = new Uint8Array(values.length * 2), view = new DataView(output.buffer);
    for (let i = 0; i < values.length; i++) view.setUint16(i * 2, values[i]!, little);
    return output;
  }
  const output = new Uint8Array(Math.ceil(values.length * bits / 8)), mask = (1 << bits) - 1;
  let bit = 0;
  for (const value of values) for (let shift = bits - 1; shift >= 0; shift--, bit++) {
    const at = bit >>> 3;
    output[at] = output[at]! | (((value & mask) >>> shift & 1) << (7 - (bit & 7)));
  }
  return output;
}

function applyPredictor(data: Uint8Array, width: number, height: number, samples: number, bits: number, little: boolean): void {
  if (bits === 8) {
    const stride = width * samples;
    for (let y = 0; y < height; y++) for (let i = stride - 1; i >= samples; i--) {
      const at = y * stride + i; data[at] = (data[at]! - data[at - samples]!) & 255;
    }
  } else if (bits === 16) {
    const stride = width * samples, view = new DataView(data.buffer);
    for (let y = 0; y < height; y++) for (let i = stride - 1; i >= samples; i--) {
      const at = (y * stride + i) * 2, prior = (y * stride + i - samples) * 2;
      view.setUint16(at, (view.getUint16(at, little) - view.getUint16(prior, little)) & 65535, little);
    }
  }
}

function compress(raw: Uint8Array, compression: Compression): Uint8Array {
  if (compression === 1 || compression === 7) return raw;
  if (compression === 5) return lzwLiteralStream(raw);
  if (compression === 32773) return packBits(raw);
  return new Uint8Array(compression === 8 ? deflateSync(raw) : deflateRawSync(raw));
}

function packBits(raw: Uint8Array): Uint8Array {
  const output: number[] = [];
  for (let at = 0; at < raw.length;) {
    let run = 1;
    while (run < 128 && at + run < raw.length && raw[at + run] === raw[at]) run++;
    if (run >= 3) {
      output.push(257 - run, raw[at]!); at += run;
      continue;
    }
    const start = at;
    at += run;
    while (at < raw.length && at - start < 128) {
      run = 1;
      while (run < 3 && at + run < raw.length && raw[at + run] === raw[at]) run++;
      if (run >= 3) break;
      at += run;
    }
    output.push(at - start - 1);
    for (let i = start; i < at; i++) output.push(raw[i]!);
  }
  return new Uint8Array(output);
}

function lzwLiteralStream(raw: Uint8Array): Uint8Array {
  const output: number[] = [];
  let byte = 0, used = 0, codeSize = 9, nextCode = 258, previous = false;
  const write = (code: number): void => {
    for (let shift = codeSize - 1; shift >= 0; shift--) {
      byte = (byte << 1) | ((code >>> shift) & 1); used++;
      if (used === 8) { output.push(byte); byte = 0; used = 0; }
    }
  };
  const clear = (): void => { write(256); codeSize = 9; nextCode = 258; previous = false; };
  clear();
  for (const value of raw) {
    write(value);
    if (previous) {
      nextCode++;
      if (nextCode === (1 << codeSize) - 1 && codeSize < 12) codeSize++;
      if (nextCode === 4096) clear();
    } else previous = true;
  }
  write(257);
  if (used) output.push(byte << (8 - used));
  return new Uint8Array(output);
}

function encodeValues(tag: Tag, little: boolean): Uint8Array {
  if (tag.values instanceof Uint8Array) return tag.values;
  const size = tag.type === 3 ? 2 : tag.type === 4 ? 4 : tag.type === 5 ? 4 : 1;
  const output = new Uint8Array(tag.values.length * size), view = new DataView(output.buffer);
  for (let i = 0; i < tag.values.length; i++) {
    if (tag.type === 3) view.setUint16(i * 2, tag.values[i]!, little);
    else if (tag.type === 4 || tag.type === 5) view.setUint32(i * 4, tag.values[i]!, little);
    else output[i] = tag.values[i]!;
  }
  return output;
}

function valueCount(tag: Tag): number {
  return tag.type === 5 ? tag.values.length / 2 : tag.values.length;
}

function rgba(rgb: ArrayLike<number>): Uint8Array {
  const output = new Uint8Array(rgb.length / 3 * 4);
  for (let source = 0, target = 0; source < rgb.length; source += 3, target += 4) {
    output[target] = rgb[source]!; output[target + 1] = rgb[source + 1]!; output[target + 2] = rgb[source + 2]!; output[target + 3] = 255;
  }
  return output;
}

function colorId(rgb: Uint8Array): number {
  const colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [255, 0, 255], [0, 255, 255]];
  return colors.findIndex((color) => color.every((value, i) => rgb[i] === value));
}

function findEntryValue(bytes: Uint8Array, tag: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), count = view.getUint16(8, true);
  for (let i = 0; i < count; i++) if (view.getUint16(10 + i * 12, true) === tag) return 10 + i * 12 + 8;
  throw new Error(`tag ${tag} missing`);
}

function makeHeic(width: number, height: number, major: string, compatible?: string): Uint8Array {
  const ftypSize = compatible ? 20 : 16;
  const output = new Uint8Array(ftypSize + 28), view = new DataView(output.buffer);
  view.setUint32(0, ftypSize); writeAscii(output, 4, 'ftyp'); writeAscii(output, 8, major); view.setUint32(12, 0);
  if (compatible) writeAscii(output, 16, compatible);
  let at = ftypSize;
  view.setUint32(at, 28); writeAscii(output, at + 4, 'meta'); view.setUint32(at + 8, 0);
  view.setUint32(at + 12, 20); writeAscii(output, at + 16, 'ispe'); view.setUint32(at + 20, 0);
  view.setUint32(at + 24, width);
  const expanded = new Uint8Array(output.length + 4); expanded.set(output);
  new DataView(expanded.buffer).setUint32(at + 28, height);
  new DataView(expanded.buffer).setUint32(at, 32);
  return expanded;
}

function writeAscii(bytes: Uint8Array, at: number, text: string): void {
  for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i);
}
