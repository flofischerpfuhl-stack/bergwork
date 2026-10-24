import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodePng, decodePngRGBA, encodePng, PngError, pngDimensions } from '../../src/io/png';
import { orientedSize, readJpegInfo, withJpegDensity } from '../../src/io/jpegMeta';
import { sha256Hex } from '../../src/io/sha256';

describe('PNG codec (LayerMask.swift, ImageExporter.swift)', () => {
  it('round-trips exact straight-alpha RGBA pixels at odd widths', () => {
    for (const width of [1, 3, 5, 257]) {
      const data = pixels(width, 3, 4);
      for (let i = 3; i < data.length; i += 4) data[i] = (i * 37) & 255;
      const encoded = encodePng(data, width, 3, 4);
      const decoded = decodePng(encoded);
      expect(decoded.channels).toBe(4);
      expect(decoded.data).toEqual(data);
      expect(decoded.hasAlpha).toBe(true);
      expect(decoded.colorInfo.srgb).toBe(true);
      expect(pngDimensions(encoded)).toEqual({ width, height: 3 });
    }
  });

  it('LayerMaskTests.projectAndPNGPreserveCoverageAndDisabledState: round-trips gray masks without alpha', () => {
    const data = pixels(257, 2, 1);
    const decoded = decodePng(encodePng(data, 257, 2, 1));
    expect(decoded.channels).toBe(1);
    expect(decoded.data).toEqual(data);
    expect(decoded.colorType).toBe(0);
    expect(decoded.hasAlpha).toBe(false);
    expect(decoded.colorInfo.srgb).toBe(false);

    const rgba = decodePngRGBA(encodePng(new Uint8Array([0, 127, 255]), 3, 1, 1));
    expect(rgba.data).toEqual(new Uint8Array([0, 0, 0, 255, 127, 127, 127, 255, 255, 255, 255, 255]));
  });

  it('decodes every PNG filter type', () => {
    const samples = pixels(5, 5, 4);
    const fixture = makePng({ width: 5, height: 5, depth: 8, colorType: 6, samples, filters: [0, 1, 2, 3, 4] });
    expect(decodePng(fixture).data).toEqual(samples);
  });

  it('decodes packed grayscale depths and grayscale transparency', () => {
    for (const depth of [1, 2, 4] as const) {
      const max = (1 << depth) - 1;
      const source = Array.from({ length: 13 }, (_, i) => i % (max + 1));
      const fixture = makePng({ width: 13, height: 1, depth, colorType: 0, samples: source });
      expect(Array.from(decodePng(fixture).data)).toEqual(source.map((v) => Math.floor((v * 255 + Math.floor(max / 2)) / max)));
    }
    const transparent = makePng({
      width: 3, height: 1, depth: 8, colorType: 0, samples: [10, 20, 10], transparency: new Uint8Array([0, 10]),
    });
    expect(decodePng(transparent).data).toEqual(new Uint8Array([
      10, 10, 10, 0, 20, 20, 20, 255, 10, 10, 10, 0,
    ]));
  });

  it('decodes 16-bit channels with nearest-value rounding and gray-alpha', () => {
    const fixture = makePng({
      width: 2, height: 1, depth: 16, colorType: 6,
      samples: [0, 32768, 65535, 1, 65535, 32767, 257, 65534],
    });
    expect(decodePng(fixture).data).toEqual(new Uint8Array([0, 128, 255, 0, 255, 127, 1, 255]));
    const grayAlpha = makePng({ width: 1, height: 1, depth: 16, colorType: 4, samples: [32768, 16448] });
    expect(decodePng(grayAlpha).data).toEqual(new Uint8Array([128, 128, 128, 64]));
  });

  it('decodes packed palettes, palette alpha, and truecolor tRNS', () => {
    const palette = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 8, 7]);
    const indexed = makePng({
      width: 5, height: 1, depth: 2, colorType: 3, samples: [0, 1, 2, 3, 1], palette,
      transparency: new Uint8Array([255, 128, 0]),
    });
    expect(decodePng(indexed).data).toEqual(new Uint8Array([
      255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 9, 8, 7, 255, 0, 255, 0, 128,
    ]));
    const rgb = makePng({
      width: 2, height: 1, depth: 8, colorType: 2, samples: [1, 2, 3, 1, 2, 4],
      transparency: new Uint8Array([0, 1, 0, 2, 0, 3]),
    });
    expect(decodePng(rgb).data).toEqual(new Uint8Array([1, 2, 3, 0, 1, 2, 4, 255]));
  });

  it('decodes Adam7 interlacing and multiple IDAT chunks', () => {
    const samples = pixels(9, 7, 4);
    const fixture = makePng({ width: 9, height: 7, depth: 8, colorType: 6, samples, interlaced: true, splitIdat: true });
    const result = decodePng(fixture);
    expect(result.interlaced).toBe(true);
    expect(result.data).toEqual(samples);
  });

  it('ImageSizeTests.resolutionOnlyRetainsPixelsAndSurvivesSaveAndExport: round-trips pHYs DPI', () => {
    const encoded = encodePng(new Uint8Array([1, 2, 3, 4]), 1, 1, 4, { dpi: 300 });
    const decoded = decodePng(encoded);
    expect(decoded.dpi?.x).toBeCloseTo(300, 2);
    expect(decoded.dpi?.y).toBeCloseTo(300, 2);
    expect(decoded.colorInfo).toEqual({ srgb: true, iccp: false, gama: null, chrm: false });

    const metadata = makePng({
      width: 1, height: 1, depth: 8, colorType: 0, samples: [42],
      beforeIdat: [
        chunk('gAMA', u32(45_455)),
        chunk('cHRM', new Uint8Array(32)),
        chunk('iCCP', join([new Uint8Array([120, 0, 0]), new Uint8Array(deflateSync(new Uint8Array([1])))])),
      ],
    });
    expect(decodePng(metadata).colorInfo).toEqual({ srgb: false, iccp: true, gama: 0.45455, chrm: true });
  });

  it('is deterministic for identical pixels and options', () => {
    const data = pixels(37, 23, 4);
    expect(encodePng(data, 37, 23, 4, { dpi: 144, level: 7 }))
      .toEqual(encodePng(data, 37, 23, 4, { dpi: 144, level: 7 }));
  });

  it('rejects CRC corruption, malformed data, and oversized dimensions with typed errors', () => {
    const encoded = encodePng(new Uint8Array([1, 2, 3, 4]), 1, 1, 4);
    const corrupt = encoded.slice();
    const idat = asciiIndex(corrupt, 'IDAT');
    corrupt[idat + 4] = corrupt[idat + 4]! ^ 1;
    expect(() => decodePng(corrupt)).toThrow(PngError);
    expect(() => decodePng(corrupt)).toThrow(/CRC/);
    expect(() => decodePng(new Uint8Array([1, 2, 3]))).toThrow(PngError);
    expect(() => encodePng(new Uint8Array(4), 30_001, 1, 4)).toThrow(/dimensions/);
  });
});

describe('SHA-256', () => {
  it('matches node:crypto for boundary and large deterministic inputs', () => {
    for (const size of [0, 1, 55, 56, 63, 64, 65, 1_000_000]) {
      const input = randomBytes(size, 0x12345678 ^ size);
      const expected = createHash('sha256').update(input).digest('hex');
      expect(sha256Hex(input), `size ${size}`).toBe(expected);
    }
  });
});

describe('JPEG metadata (ImageExporter.swift)', () => {
  it('reads SOF size, JFIF inch/cm density, and applies orientation', () => {
    const jpeg = makeJpeg(640, 480, jfif(300, 150, 1));
    const info = readJpegInfo(jpeg);
    expect(info).toEqual({ width: 640, height: 480, orientation: 1, dpi: { x: 300, y: 150 } });
    expect(orientedSize(info)).toEqual({ width: 640, height: 480 });

    const cm = readJpegInfo(makeJpeg(4, 3, jfif(100, 50, 2)));
    expect(cm.dpi?.x).toBeCloseTo(254);
    expect(cm.dpi?.y).toBeCloseTo(127);
  });

  it('reads little- and big-endian EXIF orientation and rational DPI', () => {
    for (const little of [true, false]) {
      const info = readJpegInfo(makeJpeg(40, 30, exif(6, 300, 150, little)));
      expect(info.orientation).toBe(6);
      expect(info.dpi).toEqual({ x: 300, y: 150 });
      expect(orientedSize(info)).toEqual({ width: 30, height: 40 });
    }
  });

  it('updates or inserts a JFIF density without changing image dimensions', () => {
    const existing = makeJpeg(11, 7, jfif(72, 72, 1));
    const updated = withJpegDensity(existing, 300);
    expect(readJpegInfo(updated)).toEqual({ width: 11, height: 7, orientation: 1, dpi: { x: 300, y: 300 } });
    expect(existing).not.toEqual(updated);
    expect(readJpegInfo(existing).dpi).toEqual({ x: 72, y: 72 });

    const bare = makeJpeg(5, 9);
    const inserted = withJpegDensity(bare, 144);
    expect(Array.from(inserted.subarray(2, 6))).toEqual([0xff, 0xe0, 0, 16]);
    expect(readJpegInfo(inserted).dpi).toEqual({ x: 144, y: 144 });
  });

  it('rejects garbage and truncated JPEG/EXIF data without hanging', () => {
    expect(() => readJpegInfo(new Uint8Array([0, 1, 2]))).toThrow(/SOI/);
    expect(() => readJpegInfo(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 30, 1]))).toThrow(/Truncated/);
    const brokenExif = jpegFromSegments([segment(0xe1, new Uint8Array([69, 120, 105, 102, 0, 0, 73]))]);
    expect(() => readJpegInfo(brokenExif)).toThrow(/EXIF/);
    expect(() => withJpegDensity(new Uint8Array([0xff, 0xd8]), 72)).toThrow(/Truncated/);
    const sof = segment(0xc0, new Uint8Array([8, 0, 2, 0, 3, 1, 1, 0x11, 0]));
    const sos = segment(0xda, new Uint8Array([1, 1, 0, 0, 63, 0]));
    const scan = join([new Uint8Array([0xff, 0xd8]), sof, sos, new Uint8Array([7, 0xff, 0, 9, 0xff, 0xd0, 3])]);
    expect(() => readJpegInfo(scan)).toThrow(/Truncated JPEG scan/);
    expect(readJpegInfo(join([scan, new Uint8Array([0xff, 0xd9])])).width).toBe(3);
  });
});

// Fixtures below are generated by an independent minimal PNG writer using node:zlib,
// not encodePng. This covers bit packing, filters, chunks, and Adam7 separately.
interface FixtureOptions {
  width: number;
  height: number;
  depth: 1 | 2 | 4 | 8 | 16;
  colorType: 0 | 2 | 3 | 4 | 6;
  samples: ArrayLike<number>;
  filters?: number[];
  palette?: Uint8Array;
  transparency?: Uint8Array;
  interlaced?: boolean;
  splitIdat?: boolean;
  beforeIdat?: Uint8Array[];
}

function makePng(options: FixtureOptions): Uint8Array {
  const components = options.colorType === 0 || options.colorType === 3 ? 1 : options.colorType === 2 ? 3 : options.colorType === 4 ? 2 : 4;
  const raw: number[] = [];
  if (options.interlaced) {
    const xs = [0, 4, 0, 2, 0, 1, 0], ys = [0, 0, 4, 0, 2, 0, 1];
    const dxs = [8, 8, 4, 4, 2, 2, 1], dys = [8, 8, 8, 4, 4, 2, 2];
    for (let pass = 0; pass < 7; pass++) {
      const rows: Uint8Array[] = [];
      for (let y = ys[pass]!; y < options.height; y += dys[pass]!) {
        const values: number[] = [];
        for (let x = xs[pass]!; x < options.width; x += dxs[pass]!) {
          const source = (y * options.width + x) * components;
          for (let c = 0; c < components; c++) values.push(options.samples[source + c]!);
        }
        rows.push(pack(values, options.depth));
      }
      appendFiltered(raw, rows, components, options.depth, rows.map((_, row) => (pass + row) % 5));
    }
  } else {
    const rows: Uint8Array[] = [];
    for (let y = 0; y < options.height; y++) {
      const start = y * options.width * components;
      rows.push(pack(Array.from(options.samples).slice(start, start + options.width * components), options.depth));
    }
    appendFiltered(raw, rows, components, options.depth, options.filters ?? rows.map(() => 0));
  }
  const ihdr = new Uint8Array(13);
  ihdr.set(u32(options.width), 0); ihdr.set(u32(options.height), 4);
  ihdr[8] = options.depth; ihdr[9] = options.colorType; ihdr[12] = options.interlaced ? 1 : 0;
  const compressed = new Uint8Array(deflateSync(new Uint8Array(raw)));
  const chunks = [chunk('IHDR', ihdr)];
  if (options.palette) chunks.push(chunk('PLTE', options.palette));
  if (options.transparency) chunks.push(chunk('tRNS', options.transparency));
  if (options.beforeIdat) chunks.push(...options.beforeIdat);
  if (options.splitIdat) {
    const middle = Math.floor(compressed.length / 2);
    chunks.push(chunk('IDAT', compressed.subarray(0, middle)), chunk('IDAT', compressed.subarray(middle)));
  } else chunks.push(chunk('IDAT', compressed));
  chunks.push(chunk('IEND', new Uint8Array(0)));
  return join([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), ...chunks]);
}

function appendFiltered(target: number[], rows: Uint8Array[], components: number, depth: number, filters: number[]): void {
  const bpp = Math.max(1, Math.ceil(components * depth / 8));
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y]!, previous = y ? rows[y - 1]! : null, filter = filters[y]!;
    target.push(filter);
    for (let x = 0; x < row.length; x++) {
      const left = x >= bpp ? row[x - bpp]! : 0;
      const up = previous?.[x] ?? 0;
      const upperLeft = x >= bpp ? previous?.[x - bpp] ?? 0 : 0;
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up
        : filter === 3 ? Math.floor((left + up) / 2) : paeth(left, up, upperLeft);
      target.push((row[x]! - predictor) & 255);
    }
  }
}

function pack(values: number[], depth: number): Uint8Array {
  if (depth === 8) return new Uint8Array(values);
  if (depth === 16) {
    const output = new Uint8Array(values.length * 2);
    for (let i = 0; i < values.length; i++) { output[i * 2] = values[i]! >>> 8; output[i * 2 + 1] = values[i]!; }
    return output;
  }
  const output = new Uint8Array(Math.ceil(values.length * depth / 8));
  for (let i = 0; i < values.length; i++) {
    const index = (i * depth) >>> 3;
    output[index] = output[index]! | (values[i]! << (8 - depth - ((i * depth) & 7)));
  }
  return output;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const output = new Uint8Array(data.length + 12);
  output.set(u32(data.length), 0);
  for (let i = 0; i < 4; i++) output[4 + i] = type.charCodeAt(i);
  output.set(data, 8);
  output.set(u32(crc32(output.subarray(4, 8 + data.length))), 8 + data.length);
  return output;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function pixels(width: number, height: number, channels: number): Uint8Array {
  const output = new Uint8Array(width * height * channels);
  for (let i = 0; i < output.length; i++) output[i] = (i * 73 + Math.floor(i / 7) * 19) & 255;
  return output;
}

function randomBytes(length: number, seed: number): Uint8Array {
  const output = new Uint8Array(length);
  let value = seed >>> 0;
  for (let i = 0; i < length; i++) {
    value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
    output[i] = value;
  }
  return output;
}

function u32(value: number): Uint8Array {
  return new Uint8Array([value >>> 24, value >>> 16, value >>> 8, value]);
}

function join(parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}

function asciiIndex(bytes: Uint8Array, text: string): number {
  outer: for (let offset = 0; offset <= bytes.length - text.length; offset++) {
    for (let i = 0; i < text.length; i++) if (bytes[offset + i] !== text.charCodeAt(i)) continue outer;
    return offset;
  }
  throw new Error(`${text} not found`);
}

function makeJpeg(width: number, height: number, ...metadata: Uint8Array[]): Uint8Array {
  const sof = new Uint8Array([8, height >>> 8, height, width >>> 8, width, 1, 1, 0x11, 0]);
  return jpegFromSegments([...metadata, segment(0xc0, sof)]);
}

function jpegFromSegments(parts: Uint8Array[]): Uint8Array {
  return join([new Uint8Array([0xff, 0xd8]), ...parts, new Uint8Array([0xff, 0xd9])]);
}

function segment(marker: number, payload: Uint8Array): Uint8Array {
  const length = payload.length + 2;
  return join([new Uint8Array([0xff, marker, length >>> 8, length]), payload]);
}

function jfif(x: number, y: number, units: number): Uint8Array {
  return segment(0xe0, new Uint8Array([
    0x4a, 0x46, 0x49, 0x46, 0, 1, 2, units, x >>> 8, x, y >>> 8, y, 0, 0,
  ]));
}

function exif(orientation: number, xDpi: number, yDpi: number, little: boolean): Uint8Array {
  const tiff = new Uint8Array(78);
  tiff[0] = little ? 0x49 : 0x4d; tiff[1] = tiff[0];
  put16(tiff, 2, 42, little); put32(tiff, 4, 8, little); put16(tiff, 8, 4, little);
  putEntry(tiff, 10, 0x0112, 3, 1, orientation, little, true);
  putEntry(tiff, 22, 0x011a, 5, 1, 62, little, false);
  putEntry(tiff, 34, 0x011b, 5, 1, 70, little, false);
  putEntry(tiff, 46, 0x0128, 3, 1, 2, little, true);
  put32(tiff, 62, xDpi, little); put32(tiff, 66, 1, little);
  put32(tiff, 70, yDpi, little); put32(tiff, 74, 1, little);
  return segment(0xe1, join([new Uint8Array([69, 120, 105, 102, 0, 0]), tiff]));
}

function putEntry(data: Uint8Array, offset: number, tag: number, type: number, count: number, value: number, little: boolean, inlineShort: boolean): void {
  put16(data, offset, tag, little); put16(data, offset + 2, type, little); put32(data, offset + 4, count, little);
  if (inlineShort) put16(data, offset + 8, value, little); else put32(data, offset + 8, value, little);
}

function put16(data: Uint8Array, offset: number, value: number, little: boolean): void {
  data[offset + (little ? 0 : 1)] = value; data[offset + (little ? 1 : 0)] = value >>> 8;
}

function put32(data: Uint8Array, offset: number, value: number, little: boolean): void {
  for (let i = 0; i < 4; i++) data[offset + (little ? i : 3 - i)] = value >>> (i * 8);
}
