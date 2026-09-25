/**
 * Small, dependency-free DNG 1.x reader for the interoperable baseline: strips/tiles containing
 * uncompressed or JPEG-lossless integer samples, CFA Bayer mosaics and LinearRaw RGB. DNG is an
 * open TIFF-based format, so this path is also available in the browser build.
 */

export type RawWhiteBalance = 'as-shot' | 'auto' | 'custom';
export interface RawDecodeOptions {
  readonly exposure?: number;
  readonly whiteBalance?: RawWhiteBalance;
  readonly temperature?: number;
  readonly tint?: number;
  readonly highlightRecovery?: boolean;
}
export interface DecodedRaw {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint16Array;
}

export class DngError extends Error {
  constructor(readonly code: 'invalid' | 'unsupported' | 'dimensions', message: string) {
    super(message); this.name = 'DngError';
  }
}

const TYPE_BYTES: Readonly<Record<number, number>> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };
const TAG = {
  width: 256, height: 257, bits: 258, compression: 259, photometric: 262, stripOffsets: 273,
  samples: 277, rowsPerStrip: 278, stripCounts: 279, planar: 284, subIfds: 330,
  tileWidth: 322, tileHeight: 323, tileOffsets: 324, tileCounts: 325,
  cfaDimensions: 33421, cfaPattern: 33422, dngVersion: 50706, black: 50714, white: 50717,
  colorMatrix: 50721, asShotNeutral: 50728, orientation: 274,
} as const;

interface Entry { readonly type: number; readonly count: number; readonly valueOffset: number; readonly inlineAt: number }
interface Ifd { readonly entries: Map<number, Entry>; readonly offset: number }

class Tiff {
  readonly view: DataView;
  readonly little: boolean;
  readonly firstIfd: number;
  constructor(readonly bytes: Uint8Array) {
    if (bytes.length < 8) throw new DngError('invalid', 'The DNG header is truncated.');
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const order = String.fromCharCode(bytes[0]!, bytes[1]!);
    if (order !== 'II' && order !== 'MM') throw new DngError('invalid', 'The DNG byte order is invalid.');
    this.little = order === 'II';
    if (this.u16(2) !== 42) throw new DngError('invalid', 'BigTIFF DNG files are not supported.');
    this.firstIfd = this.u32(4);
  }
  check(at: number, length: number): void {
    if (!Number.isSafeInteger(at) || !Number.isSafeInteger(length) || at < 0 || length < 0 || at + length > this.bytes.length) {
      throw new DngError('invalid', 'A DNG table points outside the file.');
    }
  }
  u16(at: number): number { this.check(at, 2); return this.view.getUint16(at, this.little); }
  i16(at: number): number { this.check(at, 2); return this.view.getInt16(at, this.little); }
  u32(at: number): number { this.check(at, 4); return this.view.getUint32(at, this.little); }
  i32(at: number): number { this.check(at, 4); return this.view.getInt32(at, this.little); }
  ifd(offset: number): Ifd {
    this.check(offset, 2); const count = this.u16(offset);
    this.check(offset + 2, count * 12 + 4);
    const entries = new Map<number, Entry>();
    for (let index = 0; index < count; index++) {
      const at = offset + 2 + index * 12, tag = this.u16(at), type = this.u16(at + 2), n = this.u32(at + 4);
      const unit = TYPE_BYTES[type];
      if (!unit || n > 0x1fff_ffff) continue;
      const size = unit * n, valueOffset = size <= 4 ? at + 8 : this.u32(at + 8);
      this.check(valueOffset, size);
      entries.set(tag, { type, count: n, valueOffset, inlineAt: at + 8 });
    }
    return { entries, offset };
  }
  numbers(ifd: Ifd, tag: number): number[] {
    const entry = ifd.entries.get(tag); if (!entry) return [];
    const result: number[] = [];
    const unit = TYPE_BYTES[entry.type]!;
    for (let i = 0; i < entry.count; i++) {
      const at = entry.valueOffset + i * unit;
      switch (entry.type) {
        case 1: case 7: result.push(this.bytes[at]!); break;
        case 3: result.push(this.u16(at)); break;
        case 4: case 13: result.push(this.u32(at)); break;
        case 5: { const d = this.u32(at + 4); result.push(d ? this.u32(at) / d : 0); break; }
        case 6: result.push(this.view.getInt8(at)); break;
        case 8: result.push(this.i16(at)); break;
        case 9: result.push(this.i32(at)); break;
        case 10: { const d = this.i32(at + 4); result.push(d ? this.i32(at) / d : 0); break; }
        case 11: result.push(this.view.getFloat32(at, this.little)); break;
        case 12: result.push(this.view.getFloat64(at, this.little)); break;
      }
    }
    return result;
  }
  number(ifd: Ifd, tag: number, fallback = 0): number { return this.numbers(ifd, tag)[0] ?? fallback; }
}

function ifds(tiff: Tiff): Ifd[] {
  const result: Ifd[] = [], pending = [tiff.firstIfd], seen = new Set<number>();
  while (pending.length && result.length < 64) {
    const offset = pending.shift()!; if (!offset || seen.has(offset)) continue; seen.add(offset);
    const value = tiff.ifd(offset); result.push(value);
    pending.push(...tiff.numbers(value, TAG.subIfds));
    const nextAt = offset + 2 + tiff.u16(offset) * 12;
    const next = tiff.u32(nextAt); if (next) pending.push(next);
  }
  return result;
}

function rawIfd(tiff: Tiff): { raw: Ifd; root: Ifd } {
  const all = ifds(tiff), root = all[0];
  if (!root || !all.some((value) => tiff.numbers(value, TAG.dngVersion).length)) throw new DngError('invalid', 'This TIFF is not a DNG file.');
  const candidates = all.filter((value) => [32803, 34892].includes(tiff.number(value, TAG.photometric)));
  const raw = candidates.sort((a, b) => tiff.number(b, TAG.width) * tiff.number(b, TAG.height)
    - tiff.number(a, TAG.width) * tiff.number(a, TAG.height))[0];
  if (!raw) throw new DngError('unsupported', 'The DNG has no supported CFA or LinearRaw image.');
  return { raw, root };
}

export function isDng(bytes: Uint8Array): boolean {
  try { rawIfd(new Tiff(bytes)); return true; } catch { return false; }
}

export function dngDimensions(bytes: Uint8Array): { width: number; height: number } {
  const tiff = new Tiff(bytes), { raw, root } = rawIfd(tiff);
  const width = tiff.number(raw, TAG.width), height = tiff.number(raw, TAG.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new DngError('invalid', 'The DNG dimensions are invalid.');
  const orientation = tiff.number(raw, TAG.orientation, tiff.number(root, TAG.orientation, 1));
  return orientation >= 5 && orientation <= 8 ? { width: height, height: width } : { width, height };
}

class BitReader {
  private at = 0; private bits = 0; private buffer = 0;
  constructor(private readonly bytes: Uint8Array, private readonly jpeg = false) {}
  read(count: number): number {
    while (this.bits < count) {
      if (this.at >= this.bytes.length) throw new DngError('invalid', 'The compressed DNG image is truncated.');
      let value = this.bytes[this.at++]!;
      if (this.jpeg && value === 0xff) {
        while (this.at < this.bytes.length && this.bytes[this.at] === 0xff) this.at++;
        const marker = this.bytes[this.at++]!;
        if (marker !== 0x00) throw new DngError('unsupported', `Unexpected JPEG marker 0x${marker.toString(16)} in the lossless scan.`);
      }
      this.buffer = this.buffer * 256 + value; this.bits += 8;
    }
    const divisor = 2 ** (this.bits - count), result = Math.floor(this.buffer / divisor) & (2 ** count - 1);
    this.buffer %= divisor; this.bits -= count; return result;
  }
}

interface HuffNode { zero?: HuffNode; one?: HuffNode; value?: number }
function huffman(lengths: Uint8Array, values: Uint8Array): HuffNode {
  const root: HuffNode = {}; let code = 0, valueAt = 0;
  for (let length = 1; length <= 16; length++) {
    const count = lengths[length - 1]!;
    for (let i = 0; i < count; i++) {
      let node = root;
      for (let bit = length - 1; bit >= 0; bit--) {
        const key = ((code >> bit) & 1) ? 'one' : 'zero'; node[key] ??= {}; node = node[key]!;
      }
      node.value = values[valueAt++]!; code++;
    }
    code <<= 1;
  }
  return root;
}
function readHuffman(reader: BitReader, root: HuffNode): number {
  let node = root;
  for (let depth = 0; depth < 16; depth++) {
    node = reader.read(1) ? node.one! : node.zero!;
    if (!node) throw new DngError('invalid', 'The DNG JPEG Huffman code is invalid.');
    if (node.value !== undefined) return node.value;
  }
  throw new DngError('invalid', 'The DNG JPEG Huffman code is too long.');
}
function extend(value: number, bits: number): number { return bits && value < 2 ** (bits - 1) ? value - (2 ** bits - 1) : value; }

/** ISO/IEC 10918-1 SOF3 lossless JPEG, the compression defined by baseline DNG. */
export function decodeLosslessJpeg(bytes: Uint8Array): { width: number; height: number; channels: number; bits: number; data: Uint16Array } {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new DngError('invalid', 'A DNG JPEG strip has no SOI marker.');
  let at = 2, width = 0, height = 0, precision = 0, components: number[] = [], predictor = 1, pointTransform = 0, entropyAt = 0;
  const tables = new Map<number, HuffNode>();
  const read16 = (p: number) => (bytes[p]! << 8) | bytes[p + 1]!;
  while (at + 1 < bytes.length) {
    if (bytes[at++] !== 0xff) continue;
    while (bytes[at] === 0xff) at++;
    const marker = bytes[at++]!;
    if (marker === 0xd9) break;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    const length = read16(at); if (length < 2 || at + length > bytes.length) throw new DngError('invalid', 'A DNG JPEG segment is truncated.');
    const body = at + 2, end = at + length;
    if (marker === 0xc3) {
      precision = bytes[body]!; height = read16(body + 1); width = read16(body + 3);
      const count = bytes[body + 5]!; components = [];
      for (let i = 0; i < count; i++) components.push(bytes[body + 6 + i * 3]!);
    } else if (marker === 0xc4) {
      let p = body;
      while (p < end) {
        const info = bytes[p++]!, lengths = bytes.subarray(p, p + 16); p += 16;
        const count = lengths.reduce((sum, value) => sum + value, 0), values = bytes.subarray(p, p + count); p += count;
        if ((info >> 4) === 0) tables.set(info & 15, huffman(lengths, values));
      }
    } else if (marker === 0xda) {
      const count = bytes[body]!, scan: { id: number; table: number }[] = [];
      for (let i = 0; i < count; i++) scan.push({ id: bytes[body + 1 + i * 2]!, table: bytes[body + 2 + i * 2]! >> 4 });
      predictor = bytes[body + 1 + count * 2]!; pointTransform = bytes[body + 3 + count * 2]! & 15; entropyAt = end;
      components = scan.map((value) => value.id * 16 + value.table); break;
    }
    at = end;
  }
  if (!width || !height || !precision || !components.length || !entropyAt || predictor < 1 || predictor > 7) {
    throw new DngError('unsupported', 'The DNG JPEG is not a supported lossless frame.');
  }
  const channels = components.length, output = new Uint16Array(width * height * channels);
  const reader = new BitReader(bytes.subarray(entropyAt), true), initial = 2 ** (precision - pointTransform - 1);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < channels; c++) {
    const encoded = components[c]!, table = tables.get(encoded & 15);
    if (!table) throw new DngError('invalid', 'The DNG JPEG references a missing Huffman table.');
    let category: number, difference: number;
    try { category = readHuffman(reader, table); difference = extend(category ? reader.read(category) : 0, category); }
    catch (error) { throw new DngError(error instanceof DngError ? error.code : 'invalid',
      `${error instanceof Error ? error.message : String(error)} (sample ${indexFor(x, y, c, width, channels)})`); }
    const index = (y * width + x) * channels + c;
    const left = x ? output[index - channels]! >> pointTransform : initial;
    const above = y ? output[index - width * channels]! >> pointTransform : initial;
    const diagonal = x && y ? output[index - width * channels - channels]! >> pointTransform : above;
    const predicted = x === 0 && y === 0 ? initial : y === 0 ? left : x === 0 ? above : predictor === 1 ? left
      : predictor === 2 ? above : predictor === 3 ? diagonal : predictor === 4 ? left + above - diagonal
        : predictor === 5 ? left + ((above - diagonal) >> 1) : predictor === 6 ? above + ((left - diagonal) >> 1) : (left + above) >> 1;
    output[index] = Math.max(0, Math.min(65535, (predicted + difference) << pointTransform));
  }
  return { width, height, channels, bits: precision, data: output };
}

function indexFor(x: number, y: number, channel: number, width: number, channels: number): number {
  return (y * width + x) * channels + channel;
}

function unpack(bytes: Uint8Array, bits: number, little: boolean, count: number): Uint16Array {
  const output = new Uint16Array(count);
  if (bits === 8) { for (let i = 0; i < count; i++) output[i] = bytes[i] ?? 0; return output; }
  if (bits === 16) {
    if (bytes.length < count * 2) throw new DngError('invalid', 'The uncompressed DNG image is truncated.');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < count; i++) output[i] = view.getUint16(i * 2, little); return output;
  }
  if (bits < 1 || bits > 16) throw new DngError('unsupported', `Unsupported DNG sample depth: ${bits}.`);
  const reader = new BitReader(bytes);
  for (let i = 0; i < count; i++) output[i] = reader.read(bits);
  return output;
}

function rawSamples(tiff: Tiff, ifd: Ifd, width: number, height: number, samples: number, bits: number): Uint16Array {
  const compression = tiff.number(ifd, TAG.compression, 1);
  if (![1, 7].includes(compression)) throw new DngError('unsupported', `Unsupported DNG compression: ${compression}.`);
  if (tiff.number(ifd, TAG.planar, 1) !== 1) throw new DngError('unsupported', 'Planar DNG samples are not supported.');
  const tileOffsets = tiff.numbers(ifd, TAG.tileOffsets), tileCounts = tiff.numbers(ifd, TAG.tileCounts);
  const tiled = tileOffsets.length > 0;
  const offsets = tiled ? tileOffsets : tiff.numbers(ifd, TAG.stripOffsets);
  const counts = tiled ? tileCounts : tiff.numbers(ifd, TAG.stripCounts);
  if (!offsets.length || offsets.length !== counts.length) throw new DngError('invalid', 'The DNG image data table is incomplete.');
  const blockWidth = tiled ? tiff.number(ifd, TAG.tileWidth) : width;
  const blockHeight = tiled ? tiff.number(ifd, TAG.tileHeight) : tiff.number(ifd, TAG.rowsPerStrip, height);
  if (!blockWidth || !blockHeight) throw new DngError('invalid', 'The DNG strip/tile size is invalid.');
  const output = new Uint16Array(width * height * samples), across = Math.ceil(width / blockWidth);
  for (let block = 0; block < offsets.length; block++) {
    const offset = offsets[block]!, byteCount = counts[block]!; tiff.check(offset, byteCount);
    const bx = tiled ? (block % across) * blockWidth : 0, by = tiled ? Math.floor(block / across) * blockHeight : block * blockHeight;
    const actualWidth = Math.min(blockWidth, width - bx), actualHeight = Math.min(blockHeight, height - by);
    const encoded = tiff.bytes.subarray(offset, offset + byteCount);
    const decoded = compression === 7 ? decodeLosslessJpeg(encoded) : null;
    const blockSamples = decoded?.data ?? unpack(encoded, bits, tiff.little, blockWidth * actualHeight * samples);
    if (decoded && (decoded.width < actualWidth || decoded.height < actualHeight || decoded.channels !== samples)) {
      throw new DngError('invalid', 'A DNG JPEG block has unexpected dimensions.');
    }
    const sourceWidth = decoded?.width ?? blockWidth;
    for (let y = 0; y < actualHeight; y++) for (let x = 0; x < actualWidth; x++) for (let c = 0; c < samples; c++) {
      output[((by + y) * width + bx + x) * samples + c] = blockSamples[(y * sourceWidth + x) * samples + c]!;
    }
  }
  return output;
}

function invert3(m: readonly number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = m as [number, number, number, number, number, number, number, number, number];
  const A = e * i - f * h, B = c * h - b * i, C = b * f - c * e;
  const D = f * g - d * i, E = a * i - c * g, F = c * d - a * f;
  const G = d * h - e * g, H = b * g - a * h, I = a * e - b * d;
  const determinant = a * A + b * D + c * G;
  if (Math.abs(determinant) < 1e-12) throw new DngError('invalid', 'The DNG ColorMatrix is singular.');
  return [A, B, C, D, E, F, G, H, I].map((v) => v / determinant);
}
function mul(m: readonly number[], v: readonly number[]): [number, number, number] {
  return [m[0]! * v[0]! + m[1]! * v[1]! + m[2]! * v[2]!, m[3]! * v[0]! + m[4]! * v[1]! + m[5]! * v[2]!,
    m[6]! * v[0]! + m[7]! * v[1]! + m[8]! * v[2]!];
}

function demosaic(mosaic: Uint16Array, width: number, height: number, pattern: readonly number[]): Float64Array {
  const output = new Float64Array(width * height * 3);
  const colorAt = (x: number, y: number) => pattern[(y & 1) * 2 + (x & 1)] ?? ((y & 1) * 2 + (x & 1));
  const sample = (x: number, y: number) => mosaic[Math.max(0, Math.min(height - 1, y)) * width + Math.max(0, Math.min(width - 1, x))]!;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const known = colorAt(x, y), index = (y * width + x) * 3; output[index + known] = sample(x, y);
    for (let channel = 0; channel < 3; channel++) {
      if (channel === known) continue;
      let sum = 0, weight = 0;
      // Bilinear interpolation with a small edge-aware green refinement at red/blue sites.
      if (channel === 1 && known !== 1) {
        const horizontal = Math.abs(sample(x - 1, y) - sample(x + 1, y));
        const vertical = Math.abs(sample(x, y - 1) - sample(x, y + 1));
        if (horizontal < vertical) { sum = sample(x - 1, y) + sample(x + 1, y); weight = 2; }
        else if (vertical < horizontal) { sum = sample(x, y - 1) + sample(x, y + 1); weight = 2; }
      }
      if (!weight) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const sx = Math.max(0, Math.min(width - 1, x + dx)), sy = Math.max(0, Math.min(height - 1, y + dy));
        if (colorAt(sx, sy) === channel) { sum += sample(sx, sy); weight++; }
      }
      output[index + channel] = weight ? sum / weight : sample(x, y);
    }
  }
  return output;
}

function temperatureNeutral(matrix: readonly number[], temperature: number, tint: number): [number, number, number] {
  const t = Math.max(2000, Math.min(12000, temperature));
  const x = t <= 4000 ? -0.2661239e9 / t ** 3 - 0.234358e6 / t ** 2 + 0.8776956e3 / t + 0.179910
    : -3.0258469e9 / t ** 3 + 2.1070379e6 / t ** 2 + 0.2226347e3 / t + 0.240390;
  const y = t <= 2222 ? -1.1063814 * x ** 3 - 1.3481102 * x ** 2 + 2.18555832 * x - 0.20219683
    : t <= 4000 ? -0.9549476 * x ** 3 - 1.37418593 * x ** 2 + 2.09137015 * x - 0.16748867
      : 3.081758 * x ** 3 - 5.8733867 * x ** 2 + 3.75112997 * x - 0.37001483;
  const xyz: [number, number, number] = [x / y, 1, (1 - x - y) / y];
  const camera = mul(matrix, xyz); camera[1] *= 2 ** (-Math.max(-150, Math.min(150, tint)) / 300);
  return camera;
}
function srgb(value: number): number { return value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055; }

function orient16(rgba: Uint16Array, width: number, height: number, orientation: number): DecodedRaw {
  if (orientation === 1 || orientation < 2 || orientation > 8) return { width, height, rgba };
  const swapped = orientation >= 5, outWidth = swapped ? height : width, outHeight = swapped ? width : height;
  const output = new Uint16Array(rgba.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let dx = x, dy = y;
    if (orientation === 2) dx = width - 1 - x;
    else if (orientation === 3) { dx = width - 1 - x; dy = height - 1 - y; }
    else if (orientation === 4) dy = height - 1 - y;
    else if (orientation === 5) { dx = y; dy = x; }
    else if (orientation === 6) { dx = height - 1 - y; dy = x; }
    else if (orientation === 7) { dx = height - 1 - y; dy = width - 1 - x; }
    else if (orientation === 8) { dx = y; dy = width - 1 - x; }
    const source = (y * width + x) * 4, target = (dy * outWidth + dx) * 4;
    output.set(rgba.subarray(source, source + 4), target);
  }
  return { width: outWidth, height: outHeight, rgba: output };
}

export function decodeDng(bytes: Uint8Array, options: RawDecodeOptions = {}): DecodedRaw {
  const tiff = new Tiff(bytes), { raw, root } = rawIfd(tiff);
  const value = (tag: number) => raw.entries.has(tag) ? tiff.numbers(raw, tag) : tiff.numbers(root, tag);
  const width = tiff.number(raw, TAG.width), height = tiff.number(raw, TAG.height);
  if (width * height > 300_000_000 || width > 60_000 || height > 60_000) throw new DngError('dimensions', 'The DNG exceeds the Pro document limits.');
  const bits = value(TAG.bits)[0] ?? 16, samples = tiff.number(raw, TAG.samples, 1), photometric = tiff.number(raw, TAG.photometric);
  const encoded = rawSamples(tiff, raw, width, height, samples, bits);
  const blackValues = value(TAG.black), black = blackValues.length ? blackValues.reduce((a, b) => a + b, 0) / blackValues.length : 0;
  const white = value(TAG.white)[0] ?? (2 ** bits - 1), scale = Math.max(1, white - black);
  let camera: Float64Array;
  if (photometric === 34892) {
    if (samples < 3) throw new DngError('unsupported', 'LinearRaw DNG needs at least three samples per pixel.');
    camera = new Float64Array(width * height * 3);
    for (let p = 0; p < width * height; p++) for (let c = 0; c < 3; c++) camera[p * 3 + c] = encoded[p * samples + c]!;
  } else {
    const dimensions = value(TAG.cfaDimensions), pattern = value(TAG.cfaPattern);
    if (dimensions[0] !== 2 || dimensions[1] !== 2 || pattern.length < 4 || pattern.some((c) => c > 2)) {
      throw new DngError('unsupported', 'Only 2×2 RGB Bayer DNG mosaics are supported.');
    }
    camera = demosaic(encoded, width, height, pattern);
  }
  const matrix = value(TAG.colorMatrix).length >= 9 ? value(TAG.colorMatrix).slice(0, 9) : [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const mode = options.whiteBalance ?? 'as-shot';
  let neutral = value(TAG.asShotNeutral).slice(0, 3);
  if (mode === 'auto') {
    neutral = [0, 0, 0];
    for (let p = 0; p < width * height; p++) for (let c = 0; c < 3; c++) neutral[c] = neutral[c]! + Math.max(0, camera[p * 3 + c]! - black);
  } else if (mode === 'custom') neutral = temperatureNeutral(matrix, options.temperature ?? 6500, options.tint ?? 0);
  if (neutral.length < 3 || neutral.some((v) => !Number.isFinite(v) || v <= 0)) neutral = [1, 1, 1];
  const gains = neutral.map((v) => 1 / v), gainScale = gains[1] || 1; for (let c = 0; c < 3; c++) gains[c] = gains[c]! / gainScale;
  const cameraToXyzD50 = invert3(matrix);
  const d50ToD65 = [0.9555766, -0.0230393, 0.0631636, -0.0282895, 1.0099416, 0.0210077, 0.0122982, -0.020483, 1.3299098];
  const xyzToSrgb = [3.2404542, -1.5371385, -0.4985314, -0.969266, 1.8760108, 0.041556, 0.0556434, -0.2040259, 1.0572252];
  const exposure = 2 ** Math.max(-5, Math.min(5, options.exposure ?? 0)), rgba = new Uint16Array(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    let rgb: [number, number, number] = [0, 1, 2].map((c) => Math.max(0, camera[p * 3 + c]! - black) / scale * gains[c]! * exposure) as [number, number, number];
    rgb = mul(xyzToSrgb, mul(d50ToD65, mul(cameraToXyzD50, rgb)));
    const maximum = Math.max(...rgb);
    if (options.highlightRecovery && maximum > 1) rgb = rgb.map((v) => v / maximum) as [number, number, number];
    for (let c = 0; c < 3; c++) rgba[p * 4 + c] = Math.round(Math.max(0, Math.min(1, srgb(Math.max(0, rgb[c]!)))) * 65535);
    rgba[p * 4 + 3] = 65535;
  }
  return orient16(rgba, width, height, value(TAG.orientation)[0] ?? 1);
}
