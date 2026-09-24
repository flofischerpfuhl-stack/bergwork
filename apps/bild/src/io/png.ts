import { unzlibSync, zlibSync } from 'fflate';
import type { Chromaticities, IccColorModel } from '../wasm/lcms';

const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const DEFAULT_LIMITS: PngLimits = { maxSide: 30_000, maxPixels: 100_000_000 };

export class PngError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'PngError';
    this.code = code;
  }
}

export interface PngResult {
  width: number;
  height: number;
  channels: 1 | 4;
  data: Uint8Array;
  colorType: number;
  bitDepth: number;
  hasAlpha: boolean;
  interlaced: boolean;
  dpi: { x: number; y: number } | null;
  colorInfo: { srgb: boolean; iccp: boolean; gama: number | null; chrm: boolean };
}

interface Header {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
}

interface ParsedPng {
  header: Header;
  idat: Uint8Array[];
  palette: Uint8Array | null;
  transparency: Uint8Array | null;
  dpi: { x: number; y: number } | null;
  colorInfo: PngResult['colorInfo'];
  iccProfile: Uint8Array | null;
  chromaticities: Chromaticities | null;
}

export interface PngColorSamples {
  width: number;
  height: number;
  model: Extract<IccColorModel, 'gray' | 'rgb'>;
  bits: 8 | 16;
  colors: Uint8Array | Uint16Array;
  alpha: Uint8Array | Uint16Array | null;
  iccProfile: Uint8Array | null;
  gamma: number | null;
  chromaticities: Chromaticities | null;
  srgb: boolean;
  dpi: { x: number; y: number } | null;
  colorInfo: PngResult['colorInfo'];
}

export interface PngNativeRgba {
  width: number;
  height: number;
  data: Uint8Array | Uint16Array;
  bitDepth: 8 | 16;
  dpi: { x: number; y: number } | null;
  colorInfo: PngResult['colorInfo'];
}

export interface PngEncodeOptions {
  dpi?: number;
  level?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  /** Emits PNG16 and requires a Uint16Array. Defaults to the legacy PNG8 path. */
  bitDepth?: 8 | 16;
  /** The editor profile owns the limit; direct codec callers retain Lite defaults. */
  limits?: PngLimits;
}

export interface PngLimits { readonly maxSide: number; readonly maxPixels: number }

/**
 * Lossless PNG decoder used instead of canvas/ImageBitmap, which may premultiply
 * semi-transparent pixels. Mask PNGs stay scalar, matching LayerMask.isValid
 * (Compositor/Document/LayerMask.swift).
 */
export function decodePng(bytes: Uint8Array, limits: PngLimits = DEFAULT_LIMITS): PngResult {
  const parsed = parsePng(bytes, true, limits);
  const h = parsed.header;
  const samples = samplesPerPixel(h.colorType);
  const expected = inflatedSize(h.width, h.height, h.bitDepth, samples, h.interlace);
  const compressed = concat(parsed.idat);
  let inflated: Uint8Array;
  try {
    inflated = unzlibSync(compressed);
  } catch (cause) {
    throw new PngError('inflate', `Invalid PNG zlib stream: ${errorMessage(cause)}`);
  }
  if (inflated.length !== expected) {
    throw new PngError('data', `PNG image data has length ${inflated.length}, expected ${expected}`);
  }

  const grayOnly = h.colorType === 0 && parsed.transparency === null;
  const channels: 1 | 4 = grayOnly ? 1 : 4;
  const data = new Uint8Array(h.width * h.height * channels);
  if (h.interlace === 0) {
    decodePass(inflated, 0, h.width, h.height, 0, 0, 1, 1, parsed, data, channels);
  } else {
    let offset = 0;
    for (let pass = 0; pass < 7; pass++) {
      const x0 = ADAM7_X[pass]!, y0 = ADAM7_Y[pass]!;
      const dx = ADAM7_DX[pass]!, dy = ADAM7_DY[pass]!;
      const width = passSize(h.width, x0, dx), height = passSize(h.height, y0, dy);
      if (width === 0 || height === 0) continue;
      offset = decodePass(inflated, offset, width, height, x0, y0, dx, dy, parsed, data, channels);
    }
    if (offset !== inflated.length) throw new PngError('data', 'Unexpected trailing interlaced image data');
  }

  return {
    width: h.width,
    height: h.height,
    channels,
    data,
    colorType: h.colorType,
    bitDepth: h.bitDepth,
    hasAlpha: h.colorType === 4 || h.colorType === 6 || parsed.transparency !== null,
    interlaced: h.interlace === 1,
    dpi: parsed.dpi,
    colorInfo: parsed.colorInfo,
  };
}

export function decodePngRGBA(bytes: Uint8Array, limits: PngLimits = DEFAULT_LIMITS): Omit<PngResult, 'channels'> & { channels: 4 } {
  const result = decodePng(bytes, limits);
  if (result.channels === 4) return result as Omit<PngResult, 'channels'> & { channels: 4 };
  const rgba = new Uint8Array(result.width * result.height * 4);
  for (let src = 0, dst = 0; src < result.data.length; src++, dst += 4) {
    const gray = result.data[src]!;
    rgba[dst] = gray;
    rgba[dst + 1] = gray;
    rgba[dst + 2] = gray;
    rgba[dst + 3] = 255;
  }
  return { ...result, channels: 4, data: rgba };
}

export function pngDimensions(bytes: Uint8Array, limits: PngLimits = DEFAULT_LIMITS): { width: number; height: number } {
  checkSignature(bytes);
  if (bytes.length < 33 || readU32(bytes, 8) !== 13 || chunkType(bytes, 12) !== 'IHDR') {
    throw new PngError('header', 'PNG does not begin with a valid IHDR chunk');
  }
  checkChunkCrc(bytes, 12, 13);
  const width = readU32(bytes, 16), height = readU32(bytes, 20);
  validateDimensions(width, height, limits);
  return { width, height };
}

/** Extracts ICC/cHRM/gAMA metadata and unquantized color samples for ImageImporter.swift's sRGB conversion. */
export function decodePngColorSamples(bytes: Uint8Array, limits: PngLimits = DEFAULT_LIMITS): PngColorSamples {
  const parsed = parsePng(bytes, true, limits), h = parsed.header;
  const samples = samplesPerPixel(h.colorType), expected = inflatedSize(h.width, h.height, h.bitDepth, samples, h.interlace);
  let inflated: Uint8Array;
  try { inflated = unzlibSync(concat(parsed.idat)); }
  catch (cause) { throw new PngError('inflate', `Invalid PNG zlib stream: ${errorMessage(cause)}`); }
  if (inflated.length !== expected) throw new PngError('data', `PNG image data has length ${inflated.length}, expected ${expected}`);

  const model = h.colorType === 0 || h.colorType === 4 ? 'gray' : 'rgb';
  const bits: 8 | 16 = h.bitDepth === 16 ? 16 : 8;
  const colorChannels = model === 'gray' ? 1 : 3, count = h.width * h.height;
  const colors = bits === 16 ? new Uint16Array(count * colorChannels) : new Uint8Array(count * colorChannels);
  const hasAlpha = h.colorType === 4 || h.colorType === 6 || parsed.transparency !== null;
  const alpha = hasAlpha ? (bits === 16 ? new Uint16Array(count) : new Uint8Array(count)) : null;
  if (alpha) alpha.fill(bits === 16 ? 65535 : 255);
  if (h.interlace === 0) {
    decodeColorPass(inflated, 0, h.width, h.height, 0, 0, 1, 1, parsed, colors, alpha, model, bits);
  } else {
    let offset = 0;
    for (let pass = 0; pass < 7; pass++) {
      const x0 = ADAM7_X[pass]!, y0 = ADAM7_Y[pass]!, dx = ADAM7_DX[pass]!, dy = ADAM7_DY[pass]!;
      const width = passSize(h.width, x0, dx), height = passSize(h.height, y0, dy);
      if (width && height) offset = decodeColorPass(inflated, offset, width, height, x0, y0, dx, dy,
        parsed, colors, alpha, model, bits);
    }
    if (offset !== inflated.length) throw new PngError('data', 'Unexpected trailing interlaced image data');
  }
  return { width: h.width, height: h.height, model, bits, colors, alpha, iccProfile: parsed.iccProfile,
    gamma: parsed.colorInfo.gama, chromaticities: parsed.chromaticities, srgb: parsed.colorInfo.srgb,
    dpi: parsed.dpi, colorInfo: parsed.colorInfo };
}

/** Decodes color channels without the legacy RGBA8 quantization step. */
export function decodePngNativeRGBA(bytes: Uint8Array, limits: PngLimits = DEFAULT_LIMITS): PngNativeRgba {
  const samples = decodePngColorSamples(bytes, limits), count = samples.width * samples.height;
  const data = samples.bits === 16 ? new Uint16Array(count * 4) : new Uint8Array(count * 4);
  const maximum = samples.bits === 16 ? 65535 : 255;
  for (let pixel = 0; pixel < count; pixel++) {
    const target = pixel * 4;
    if (samples.model === 'gray') {
      const value = samples.colors[pixel]!;
      data[target] = value; data[target + 1] = value; data[target + 2] = value;
    } else {
      const source = pixel * 3;
      data[target] = samples.colors[source]!;
      data[target + 1] = samples.colors[source + 1]!;
      data[target + 2] = samples.colors[source + 2]!;
    }
    data[target + 3] = samples.alpha?.[pixel] ?? maximum;
  }
  return { width: samples.width, height: samples.height, data, bitDepth: samples.bits,
    dpi: samples.dpi, colorInfo: samples.colorInfo };
}

/**
 * Encodes archive/export pixels and writes DPI as PNG pHYs, mirroring
 * ImageExporter.pngData (Compositor/IO/ImageExporter.swift).
 */
export function encodePng(
  data: Uint8Array | Uint16Array,
  width: number,
  height: number,
  channels: 1 | 4,
  options: PngEncodeOptions = {},
): Uint8Array {
  validateDimensions(width, height, options.limits);
  if (channels !== 1 && channels !== 4) throw new PngError('pixels', 'PNG channels must be 1 or 4');
  const bitDepth = options.bitDepth ?? 8;
  const expected = width * height * channels;
  if (data.length !== expected) throw new PngError('pixels', `Pixel buffer has length ${data.length}, expected ${expected}`);
  if ((bitDepth === 16) !== (data instanceof Uint16Array)) {
    throw new PngError('pixels', `PNG${bitDepth} requires a ${bitDepth === 16 ? 'Uint16Array' : 'Uint8Array'}`);
  }
  const level = options.level ?? 6;
  if (!Number.isInteger(level) || level < 0 || level > 9) throw new PngError('option', 'PNG compression level must be 0…9');
  if (options.dpi !== undefined && (!Number.isFinite(options.dpi) || options.dpi <= 0)) {
    throw new PngError('option', 'PNG DPI must be a positive finite number');
  }

  let raw: Uint8Array;
  if (data instanceof Uint16Array) {
    raw = new Uint8Array(data.length * 2);
    for (let i = 0; i < data.length; i++) {
      const value = data[i]!;
      raw[i * 2] = value >>> 8; raw[i * 2 + 1] = value & 255;
    }
  } else raw = data;
  const bytesPerSample = bitDepth / 8;
  const stride = width * channels * bytesPerSample;
  const filtered = new Uint8Array((stride + 1) * height);
  let previous = 0;
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    const target = y * (stride + 1);
    const filter = chooseFilter(raw, row, previous, stride, channels * bytesPerSample, y !== 0);
    filtered[target] = filter;
    writeFiltered(raw, row, previous, stride, channels * bytesPerSample, y !== 0, filter, filtered, target + 1);
    previous = row;
  }

  const ihdr = new Uint8Array(13);
  writeU32(ihdr, 0, width);
  writeU32(ihdr, 4, height);
  ihdr[8] = bitDepth;
  ihdr[9] = channels === 1 ? 0 : 6;
  const chunks = [SIGNATURE, makeChunk('IHDR', ihdr)];
  if (channels === 4) chunks.push(makeChunk('sRGB', new Uint8Array([0])));
  if (options.dpi !== undefined) {
    const ppm = Math.round(options.dpi / 0.0254);
    if (ppm < 1 || ppm > 0xffff_ffff) throw new PngError('option', 'PNG DPI is outside the pHYs range');
    const phys = new Uint8Array(9);
    writeU32(phys, 0, ppm);
    writeU32(phys, 4, ppm);
    phys[8] = 1;
    chunks.push(makeChunk('pHYs', phys));
  }
  chunks.push(makeChunk('IDAT', zlibSync(filtered, { level })), makeChunk('IEND', new Uint8Array(0)));
  return concat(chunks);
}

function parsePng(bytes: Uint8Array, requireData: boolean, limits: PngLimits): ParsedPng {
  checkSignature(bytes);
  let offset = 8;
  let header: Header | null = null;
  let palette: Uint8Array | null = null;
  let transparency: Uint8Array | null = null;
  let dpi: { x: number; y: number } | null = null;
  const idat: Uint8Array[] = [];
  const colorInfo = { srgb: false, iccp: false, gama: null as number | null, chrm: false };
  let iccProfile: Uint8Array | null = null;
  let chromaticities: Chromaticities | null = null;
  let ended = false;
  let seenIdat = false, idatEnded = false, seenPhys = false;
  while (offset < bytes.length) {
    if (bytes.length - offset < 12) throw new PngError('truncated', 'Truncated PNG chunk header');
    const length = readU32(bytes, offset);
    if (length > 0x7fff_ffff || length + 12 > bytes.length - offset) throw new PngError('truncated', 'Truncated PNG chunk');
    const typeOffset = offset + 4;
    const type = chunkType(bytes, typeOffset);
    validateChunkType(bytes, typeOffset);
    checkChunkCrc(bytes, typeOffset, length);
    const start = offset + 8, end = start + length;
    if (header === null && type !== 'IHDR') throw new PngError('header', 'IHDR must be the first PNG chunk');
    if (seenIdat && type !== 'IDAT') idatEnded = true;
    switch (type) {
      case 'IHDR': {
        if (header !== null || length !== 13) throw new PngError('header', 'Invalid PNG IHDR');
        const width = readU32(bytes, start), height = readU32(bytes, start + 4);
        validateDimensions(width, height, limits);
        const bitDepth = bytes[start + 8]!, colorType = bytes[start + 9]!;
        if (!validDepth(colorType, bitDepth)) throw new PngError('format', `Unsupported PNG color type ${colorType} / depth ${bitDepth}`);
        if (bytes[start + 10] !== 0 || bytes[start + 11] !== 0 || (bytes[start + 12] !== 0 && bytes[start + 12] !== 1)) {
          throw new PngError('format', 'Unsupported PNG compression, filter, or interlace method');
        }
        header = { width, height, bitDepth, colorType, interlace: bytes[start + 12]! };
        break;
      }
      case 'PLTE':
        if (palette || transparency || seenIdat || header!.colorType === 0 || header!.colorType === 4
          || length === 0 || length % 3 !== 0 || length > 768) throw new PngError('palette', 'Invalid PNG palette');
        palette = bytes.slice(start, end);
        break;
      case 'tRNS':
        if (transparency || seenIdat || (header?.colorType === 3 && !palette)) {
          throw new PngError('transparency', 'PNG tRNS is duplicated or out of order');
        }
        transparency = bytes.slice(start, end);
        break;
      case 'IDAT':
        if (idatEnded) throw new PngError('data', 'PNG IDAT chunks must be consecutive');
        seenIdat = true;
        idat.push(bytes.slice(start, end));
        break;
      case 'pHYs':
        if (seenPhys || seenIdat || length !== 9) throw new PngError('metadata', 'Invalid or out-of-order PNG pHYs chunk');
        seenPhys = true;
        if (bytes[start + 8] === 1) dpi = { x: readU32(bytes, start) * 0.0254, y: readU32(bytes, start + 4) * 0.0254 };
        else if (bytes[start + 8] !== 0) throw new PngError('metadata', 'Invalid PNG pHYs unit');
        break;
      case 'sRGB':
        if (colorInfo.srgb || colorInfo.iccp || seenIdat || palette || length !== 1 || bytes[start]! > 3) {
          throw new PngError('metadata', 'Invalid or out-of-order PNG sRGB chunk');
        }
        colorInfo.srgb = true;
        break;
      case 'iCCP':
        if (colorInfo.iccp || colorInfo.srgb || seenIdat || palette || !validIccp(bytes, start, end)) {
          throw new PngError('metadata', 'Invalid or out-of-order PNG iCCP chunk');
        }
        colorInfo.iccp = true;
        iccProfile = inflateIccProfile(bytes, start, end);
        break;
      case 'gAMA':
        if (colorInfo.gama !== null || seenIdat || palette || length !== 4 || readU32(bytes, start) === 0) {
          throw new PngError('metadata', 'Invalid or out-of-order PNG gAMA chunk');
        }
        colorInfo.gama = readU32(bytes, start) / 100_000;
        break;
      case 'cHRM':
        if (colorInfo.chrm || seenIdat || palette || length !== 32) throw new PngError('metadata', 'Invalid or out-of-order PNG cHRM chunk');
        colorInfo.chrm = true;
        chromaticities = {
          white: [readU32(bytes, start) / 100_000, readU32(bytes, start + 4) / 100_000],
          red: [readU32(bytes, start + 8) / 100_000, readU32(bytes, start + 12) / 100_000],
          green: [readU32(bytes, start + 16) / 100_000, readU32(bytes, start + 20) / 100_000],
          blue: [readU32(bytes, start + 24) / 100_000, readU32(bytes, start + 28) / 100_000],
        };
        break;
      case 'IEND':
        if (length !== 0) throw new PngError('data', 'Invalid PNG IEND chunk');
        ended = true;
        offset = end + 4;
        if (offset !== bytes.length) throw new PngError('data', 'Unexpected data after PNG IEND');
        break;
      default:
        if ((bytes[typeOffset]! & 0x20) === 0) throw new PngError('chunk', `Unsupported critical PNG chunk ${type}`);
    }
    if (ended) break;
    offset = end + 4;
  }
  if (!header || !ended) throw new PngError('truncated', 'PNG has no complete IHDR/IEND');
  if (requireData && idat.length === 0) throw new PngError('data', 'PNG has no IDAT data');
  if (header.colorType === 3) {
    if (!palette) throw new PngError('palette', 'Indexed PNG has no palette');
    if (palette.length / 3 > 1 << header.bitDepth) throw new PngError('palette', 'PNG palette is too large for its bit depth');
    if (transparency && transparency.length > palette.length / 3) throw new PngError('transparency', 'PNG palette transparency is too long');
  } else if (header.colorType === 0) {
    if (palette) throw new PngError('palette', 'Grayscale PNG cannot have a palette');
    if (transparency && transparency.length !== 2) throw new PngError('transparency', 'Invalid grayscale PNG transparency');
    if (transparency && readU16(transparency, 0) >= 2 ** header.bitDepth) throw new PngError('transparency', 'Grayscale PNG transparency is out of range');
  } else if (header.colorType === 2) {
    if (transparency && transparency.length !== 6) throw new PngError('transparency', 'Invalid truecolor PNG transparency');
    if (transparency) {
      const maximum = 2 ** header.bitDepth;
      if (readU16(transparency, 0) >= maximum || readU16(transparency, 2) >= maximum || readU16(transparency, 4) >= maximum) {
        throw new PngError('transparency', 'Truecolor PNG transparency is out of range');
      }
    }
  } else if (transparency) {
    throw new PngError('transparency', 'PNG color type cannot have tRNS');
  }
  if ((header.colorType === 0 || header.colorType === 4) && palette) throw new PngError('palette', 'PNG color type cannot have a palette');
  return { header, idat, palette, transparency, dpi, colorInfo, iccProfile, chromaticities };
}

function decodeColorPass(source: Uint8Array, offset: number, width: number, height: number,
  x0: number, y0: number, dx: number, dy: number, png: ParsedPng,
  colors: Uint8Array | Uint16Array, alpha: Uint8Array | Uint16Array | null,
  model: 'gray' | 'rgb', bits: 8 | 16): number {
  const h = png.header, sampleCount = samplesPerPixel(h.colorType);
  const rowBytes = Math.ceil(width * sampleCount * h.bitDepth / 8), bpp = Math.max(1, Math.ceil(sampleCount * h.bitDepth / 8));
  let previous = new Uint8Array(rowBytes), current = new Uint8Array(rowBytes);
  for (let y = 0; y < height; y++) {
    const filter = source[offset++];
    if (filter === undefined || filter > 4 || offset + rowBytes > source.length) throw new PngError('data', 'Truncated or invalid PNG scanline');
    for (let i = 0; i < rowBytes; i++) {
      const raw = source[offset + i]!, left = i >= bpp ? current[i - bpp]! : 0;
      const up = previous[i]!, upperLeft = i >= bpp ? previous[i - bpp]! : 0;
      current[i] = raw + (filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up
        : filter === 3 ? Math.floor((left + up) / 2) : paeth(left, up, upperLeft));
    }
    offset += rowBytes;
    for (let x = 0; x < width; x++) {
      const pixel = (y0 + y * dy) * h.width + x0 + x * dx;
      writeColorPixel(current, x, pixel, png, colors, alpha, bits);
    }
    const swap = previous; previous = current; current = swap;
  }
  return offset;
}

function writeColorPixel(row: Uint8Array, x: number, pixel: number, png: ParsedPng,
  colors: Uint8Array | Uint16Array, alpha: Uint8Array | Uint16Array | null,
  bits: 8 | 16): void {
  const h = png.header, scale = (value: number): number => bits === 16 ? value : toByte(value, h.bitDepth);
  if (h.colorType === 0 || h.colorType === 4) {
    const gray = sample(row, x, 0, h.colorType === 0 ? 1 : 2, h.bitDepth);
    colors[pixel] = scale(gray);
    if (alpha) alpha[pixel] = h.colorType === 4 ? scale(sample(row, x, 1, 2, h.bitDepth))
      : png.transparency && gray === readU16(png.transparency, 0) ? 0 : bits === 16 ? 65535 : 255;
    return;
  }
  const target = pixel * 3;
  if (h.colorType === 3) {
    const index = sample(row, x, 0, 1, h.bitDepth), palette = png.palette!;
    if (index * 3 + 2 >= palette.length) throw new PngError('palette', `PNG palette index ${index} is out of range`);
    colors[target] = palette[index * 3]!; colors[target + 1] = palette[index * 3 + 1]!; colors[target + 2] = palette[index * 3 + 2]!;
    if (alpha) alpha[pixel] = png.transparency?.[index] ?? 255;
    return;
  }
  const components = h.colorType === 2 ? 3 : 4;
  const r = sample(row, x, 0, components, h.bitDepth), g = sample(row, x, 1, components, h.bitDepth);
  const b = sample(row, x, 2, components, h.bitDepth);
  colors[target] = scale(r); colors[target + 1] = scale(g); colors[target + 2] = scale(b);
  if (alpha) alpha[pixel] = h.colorType === 6 ? scale(sample(row, x, 3, 4, h.bitDepth))
    : png.transparency && r === readU16(png.transparency, 0) && g === readU16(png.transparency, 2)
      && b === readU16(png.transparency, 4) ? 0 : bits === 16 ? 65535 : 255;
}

function decodePass(
  source: Uint8Array,
  offset: number,
  width: number,
  height: number,
  x0: number,
  y0: number,
  dx: number,
  dy: number,
  png: ParsedPng,
  output: Uint8Array,
  outputChannels: 1 | 4,
): number {
  const h = png.header;
  const sampleCount = samplesPerPixel(h.colorType);
  const rowBytes = Math.ceil(width * sampleCount * h.bitDepth / 8);
  const bpp = Math.max(1, Math.ceil(sampleCount * h.bitDepth / 8));
  let previous = new Uint8Array(rowBytes);
  let current = new Uint8Array(rowBytes);
  for (let y = 0; y < height; y++) {
    const filter = source[offset++];
    if (filter === undefined || filter > 4 || offset + rowBytes > source.length) throw new PngError('data', 'Truncated or invalid PNG scanline');
    for (let i = 0; i < rowBytes; i++) {
      const raw = source[offset + i]!;
      const left = i >= bpp ? current[i - bpp]! : 0;
      const up = previous[i]!;
      const upperLeft = i >= bpp ? previous[i - bpp]! : 0;
      let value: number;
      switch (filter) {
        case 0: value = raw; break;
        case 1: value = raw + left; break;
        case 2: value = raw + up; break;
        case 3: value = raw + Math.floor((left + up) / 2); break;
        case 4: value = raw + paeth(left, up, upperLeft); break;
        default: throw new PngError('filter', `Invalid PNG filter ${filter}`);
      }
      current[i] = value;
    }
    offset += rowBytes;
    for (let x = 0; x < width; x++) {
      writePixel(current, x, png, output, (y0 + y * dy) * h.width + x0 + x * dx, outputChannels);
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return offset;
}

function writePixel(row: Uint8Array, x: number, png: ParsedPng, output: Uint8Array, pixel: number, channels: 1 | 4): void {
  const h = png.header;
  let r: number, g: number, b: number, a = 255;
  switch (h.colorType) {
    case 0: {
      const raw = sample(row, x, 0, 1, h.bitDepth);
      const gray = toByte(raw, h.bitDepth);
      if (channels === 1) { output[pixel] = gray; return; }
      r = gray; g = gray; b = gray;
      if (png.transparency && raw === readU16(png.transparency, 0)) a = 0;
      break;
    }
    case 2: {
      const rawR = sample(row, x, 0, 3, h.bitDepth);
      const rawG = sample(row, x, 1, 3, h.bitDepth);
      const rawB = sample(row, x, 2, 3, h.bitDepth);
      r = toByte(rawR, h.bitDepth); g = toByte(rawG, h.bitDepth); b = toByte(rawB, h.bitDepth);
      if (png.transparency && rawR === readU16(png.transparency, 0)
        && rawG === readU16(png.transparency, 2) && rawB === readU16(png.transparency, 4)) a = 0;
      break;
    }
    case 3: {
      const index = sample(row, x, 0, 1, h.bitDepth);
      const palette = png.palette!;
      if (index * 3 + 2 >= palette.length) throw new PngError('palette', `PNG palette index ${index} is out of range`);
      r = palette[index * 3]!; g = palette[index * 3 + 1]!; b = palette[index * 3 + 2]!;
      a = png.transparency?.[index] ?? 255;
      break;
    }
    case 4: {
      const gray = toByte(sample(row, x, 0, 2, h.bitDepth), h.bitDepth);
      r = gray; g = gray; b = gray;
      a = toByte(sample(row, x, 1, 2, h.bitDepth), h.bitDepth);
      break;
    }
    case 6:
      r = toByte(sample(row, x, 0, 4, h.bitDepth), h.bitDepth);
      g = toByte(sample(row, x, 1, 4, h.bitDepth), h.bitDepth);
      b = toByte(sample(row, x, 2, 4, h.bitDepth), h.bitDepth);
      a = toByte(sample(row, x, 3, 4, h.bitDepth), h.bitDepth);
      break;
    default: throw new PngError('format', 'Unsupported PNG color type');
  }
  const dst = pixel * 4;
  output[dst] = r;
  output[dst + 1] = g;
  output[dst + 2] = b;
  output[dst + 3] = a;
}

function sample(row: Uint8Array, pixel: number, component: number, components: number, depth: number): number {
  const index = pixel * components + component;
  if (depth === 8) return row[index]!;
  if (depth === 16) return (row[index * 2]! << 8) | row[index * 2 + 1]!;
  const bit = index * depth;
  return (row[bit >>> 3]! >>> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
}

function toByte(value: number, depth: number): number {
  if (depth === 8) return value;
  // Round all source depths to the nearest RGBA8 value; for 16-bit this is
  // floor((v * 255 + 32767) / 65535), avoiding the bias of truncating to the high byte.
  const maximum = (2 ** depth) - 1;
  return Math.floor((value * 255 + Math.floor(maximum / 2)) / maximum);
}

function chooseFilter(data: Uint8Array, row: number, previous: number, length: number, bpp: number, hasPrevious: boolean): number {
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0;
  for (let i = 0; i < length; i++) {
    const value = data[row + i]!;
    const left = i >= bpp ? data[row + i - bpp]! : 0;
    const up = hasPrevious ? data[previous + i]! : 0;
    const upperLeft = hasPrevious && i >= bpp ? data[previous + i - bpp]! : 0;
    s0 += signedMagnitude(value);
    s1 += signedMagnitude((value - left) & 255);
    s2 += signedMagnitude((value - up) & 255);
    s3 += signedMagnitude((value - Math.floor((left + up) / 2)) & 255);
    s4 += signedMagnitude((value - paeth(left, up, upperLeft)) & 255);
  }
  let best = 0, score = s0;
  if (s1 < score) { best = 1; score = s1; }
  if (s2 < score) { best = 2; score = s2; }
  if (s3 < score) { best = 3; score = s3; }
  if (s4 < score) best = 4;
  return best;
}

function writeFiltered(
  data: Uint8Array, row: number, previous: number, length: number, bpp: number, hasPrevious: boolean,
  filter: number, target: Uint8Array, targetOffset: number,
): void {
  for (let i = 0; i < length; i++) {
    const value = data[row + i]!;
    const left = i >= bpp ? data[row + i - bpp]! : 0;
    const up = hasPrevious ? data[previous + i]! : 0;
    const upperLeft = hasPrevious && i >= bpp ? data[previous + i - bpp]! : 0;
    let prediction = 0;
    if (filter === 1) prediction = left;
    else if (filter === 2) prediction = up;
    else if (filter === 3) prediction = Math.floor((left + up) / 2);
    else if (filter === 4) prediction = paeth(left, up, upperLeft);
    target[targetOffset + i] = value - prediction;
  }
}

function inflatedSize(width: number, height: number, depth: number, samples: number, interlace: number): number {
  if (interlace === 0) return (Math.ceil(width * depth * samples / 8) + 1) * height;
  let total = 0;
  for (let pass = 0; pass < 7; pass++) {
    const w = passSize(width, ADAM7_X[pass]!, ADAM7_DX[pass]!);
    const h = passSize(height, ADAM7_Y[pass]!, ADAM7_DY[pass]!);
    if (w && h) total += (Math.ceil(w * depth * samples / 8) + 1) * h;
  }
  return total;
}

function samplesPerPixel(colorType: number): number {
  if (colorType === 0 || colorType === 3) return 1;
  if (colorType === 2) return 3;
  if (colorType === 4) return 2;
  if (colorType === 6) return 4;
  throw new PngError('format', `Unsupported PNG color type ${colorType}`);
}

function validDepth(colorType: number, depth: number): boolean {
  return (colorType === 0 && (depth === 1 || depth === 2 || depth === 4 || depth === 8 || depth === 16))
    || (colorType === 2 && (depth === 8 || depth === 16))
    || (colorType === 3 && (depth === 1 || depth === 2 || depth === 4 || depth === 8))
    || ((colorType === 4 || colorType === 6) && (depth === 8 || depth === 16));
}

function validateDimensions(width: number, height: number, limits: PngLimits = DEFAULT_LIMITS): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
    || width > limits.maxSide || height > limits.maxSide || width * height > limits.maxPixels) {
    // Same canvas guard as ImageExporter.render (Compositor/IO/ImageExporter.swift).
    throw new PngError('dimensions', 'PNG dimensions must be 1…30000 per side and at most 100 megapixels');
  }
}

function checkSignature(bytes: Uint8Array): void {
  if (bytes.length < 8) throw new PngError('signature', 'Truncated PNG signature');
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIGNATURE[i]) throw new PngError('signature', 'Invalid PNG signature');
}

function checkChunkCrc(bytes: Uint8Array, typeOffset: number, length: number): void {
  const stored = readU32(bytes, typeOffset + 4 + length);
  const actual = crc32(bytes, typeOffset, typeOffset + 4 + length);
  if (stored !== actual) throw new PngError('crc', `PNG CRC mismatch in ${chunkType(bytes, typeOffset)}`);
}

function makeChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(data.length + 12);
  writeU32(chunk, 0, data.length);
  for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
  chunk.set(data, 8);
  writeU32(chunk, data.length + 8, crc32(chunk, 4, data.length + 8));
  return chunk;
}

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[n] = c >>> 0;
}

function crc32(data: Uint8Array, start: number, end: number): number {
  let crc = 0xffff_ffff;
  for (let i = start; i < end; i++) crc = CRC_TABLE[(crc ^ data[i]!) & 255]! ^ (crc >>> 8);
  return (crc ^ 0xffff_ffff) >>> 0;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function signedMagnitude(byte: number): number { return byte < 128 ? byte : 256 - byte; }
function passSize(size: number, start: number, step: number): number { return size <= start ? 0 : Math.ceil((size - start) / step); }
function readU16(data: Uint8Array, offset: number): number { return (data[offset]! << 8) | data[offset + 1]!; }
function readU32(data: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > data.length) throw new PngError('truncated', 'Truncated PNG integer');
  return ((data[offset]! * 0x1000000) + (data[offset + 1]! << 16) + (data[offset + 2]! << 8) + data[offset + 3]!) >>> 0;
}
function writeU32(data: Uint8Array, offset: number, value: number): void {
  data[offset] = value >>> 24; data[offset + 1] = value >>> 16; data[offset + 2] = value >>> 8; data[offset + 3] = value;
}
function chunkType(data: Uint8Array, offset: number): string {
  return String.fromCharCode(data[offset]!, data[offset + 1]!, data[offset + 2]!, data[offset + 3]!);
}
function validateChunkType(data: Uint8Array, offset: number): void {
  for (let i = 0; i < 4; i++) {
    const value = data[offset + i]!;
    if (!((value >= 65 && value <= 90) || (value >= 97 && value <= 122))) throw new PngError('chunk', 'Invalid PNG chunk type');
  }
  if ((data[offset + 2]! & 0x20) !== 0) throw new PngError('chunk', 'Invalid PNG reserved chunk-type bit');
}
function validIccp(data: Uint8Array, start: number, end: number): boolean {
  let separator = start;
  while (separator < end && separator - start < 80 && data[separator] !== 0) separator++;
  return separator > start && separator - start <= 79 && separator + 2 < end
    && data[separator] === 0 && data[separator + 1] === 0;
}
function inflateIccProfile(data: Uint8Array, start: number, end: number): Uint8Array {
  let separator = start;
  while (separator < end && data[separator] !== 0) separator++;
  try { return unzlibSync(data.subarray(separator + 2, end)); }
  catch (cause) { throw new PngError('metadata', `Invalid PNG iCCP profile: ${errorMessage(cause)}`); }
}
function concat(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

const ADAM7_X = [0, 4, 0, 2, 0, 1, 0] as const;
const ADAM7_Y = [0, 0, 4, 0, 2, 0, 1] as const;
const ADAM7_DX = [8, 8, 4, 4, 2, 2, 1] as const;
const ADAM7_DY = [8, 8, 8, 4, 4, 2, 2] as const;
