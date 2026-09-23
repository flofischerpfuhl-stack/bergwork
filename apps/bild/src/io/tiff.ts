import { inflateSync, unzlibSync } from 'fflate';

const MAX_SIDE = 30_000;
const MAX_PIXELS = 100_000_000;
const MAX_IFD_ENTRIES = 4096;
const MAX_SAMPLES = 8;
const MAX_SEGMENTS = 1_000_000;

export type TiffErrorCode = 'signature' | 'truncated' | 'format' | 'unsupported' | 'dimensions' | 'data';

export class TiffError extends Error {
  readonly code: TiffErrorCode;

  constructor(code: TiffErrorCode, message: string) {
    super(message);
    this.name = 'TiffError';
    this.code = code;
  }
}

export interface TiffDpi { x: number; y: number }

export interface TiffResult {
  width: number;
  height: number;
  data: Uint8Array;
  dpi: TiffDpi | null;
  hasIcc: boolean;
}

export interface TiffProbe {
  width: number;
  height: number;
  dpi: TiffDpi | null;
  hasIcc: boolean;
}

interface Entry { type: number; count: number; value: number; inline: number }

interface Parsed {
  bytes: Uint8Array;
  view: DataView;
  little: boolean;
  entries: Map<number, Entry>;
  sourceWidth: number;
  sourceHeight: number;
  width: number;
  height: number;
  orientation: number;
  dpi: TiffDpi | null;
  hasIcc: boolean;
}

interface DecodeLayout {
  bits: number;
  samples: number;
  photometric: number;
  compression: number;
  planar: number;
  predictor: number;
  alphaSample: number;
  associatedAlpha: boolean;
  colorSamples: number;
  palette: number[] | null;
}

interface SegmentGeometry {
  offset: number;
  count: number;
  x: number;
  y: number;
  storedWidth: number;
  storedHeight: number;
  copyWidth: number;
  copyHeight: number;
  plane: number;
}

/**
 * Reads first-IFD dimensions and metadata without touching compressed pixels. This mirrors
 * ImageImporter.decode's pre-decode size gate (Compositor/IO/ImageImporter.swift).
 */
export function tiffDimensions(bytes: Uint8Array): TiffProbe {
  const parsed = parse(bytes);
  return { width: parsed.width, height: parsed.height, dpi: parsed.dpi, hasIcc: parsed.hasIcc };
}

/** Decodes the first TIFF IFD to straight-alpha sRGB-ish RGBA8. ICC profiles are reported, not applied. */
export async function decodeTiff(bytes: Uint8Array): Promise<TiffResult> {
  const parsed = parse(bytes);
  const layout = readLayout(parsed);
  if (layout.compression === 7) return decodeJpegTiff(parsed, layout);

  const output = new Uint8Array(parsed.width * parsed.height * 4);
  for (let i = 3; i < output.length; i += 4) output[i] = 255;
  const segments = readSegments(parsed, layout);
  for (const segment of segments) decodeSegment(parsed, layout, segment, output);
  if (layout.planar === 2) finishPlanar(layout, output);
  return { width: parsed.width, height: parsed.height, data: output, dpi: parsed.dpi, hasIcc: parsed.hasIcc };
}

function parse(bytes: Uint8Array): Parsed {
  if (bytes.length < 8) throw new TiffError('signature', 'TIFF header is truncated');
  const little = bytes[0] === 0x49 && bytes[1] === 0x49;
  const big = bytes[0] === 0x4d && bytes[1] === 0x4d;
  if (!little && !big) throw new TiffError('signature', 'Invalid TIFF byte-order marker');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(2, little) !== 42) throw new TiffError('signature', 'Invalid or unsupported BigTIFF header');
  const ifd = view.getUint32(4, little);
  bounds(bytes, ifd, 2, 'first IFD');
  const count = view.getUint16(ifd, little);
  if (count > MAX_IFD_ENTRIES) throw new TiffError('format', 'TIFF contains too many IFD entries');
  const tableBytes = checkedMultiply(count, 12, 'IFD size');
  bounds(bytes, ifd + 2, tableBytes + 4, 'first IFD');
  const entries = new Map<number, Entry>();
  for (let i = 0; i < count; i++) {
    const at = ifd + 2 + i * 12;
    const tag = view.getUint16(at, little);
    if (entries.has(tag)) throw new TiffError('format', `Duplicate TIFF tag ${tag}`);
    const type = view.getUint16(at + 2, little);
    const valueCount = view.getUint32(at + 4, little);
    const size = typeSize(type);
    if (size === 0) throw new TiffError('format', `Unknown TIFF field type ${type}`);
    const byteLength = checkedMultiply(valueCount, size, `tag ${tag} value size`);
    const value = view.getUint32(at + 8, little);
    if (byteLength > 4) bounds(bytes, value, byteLength, `tag ${tag}`);
    entries.set(tag, { type, count: valueCount, value, inline: at + 8 });
  }
  const sourceWidth = requiredScalar({ bytes, view, little, entries }, 256);
  const sourceHeight = requiredScalar({ bytes, view, little, entries }, 257);
  validateDimensions(sourceWidth, sourceHeight);
  const orientation = scalar({ bytes, view, little, entries }, 274, 1);
  if (!Number.isInteger(orientation) || orientation < 1 || orientation > 8) {
    throw new TiffError('format', `Invalid TIFF orientation ${orientation}`);
  }
  const swapped = orientation >= 5;
  const width = swapped ? sourceHeight : sourceWidth;
  const height = swapped ? sourceWidth : sourceHeight;
  const unit = scalar({ bytes, view, little, entries }, 296, 2);
  const xResolution = rational({ bytes, view, little, entries }, 282);
  const yResolution = rational({ bytes, view, little, entries }, 283);
  let dpi: TiffDpi | null = null;
  if ((unit === 2 || unit === 3) && xResolution !== null && yResolution !== null) {
    const factor = unit === 3 ? 2.54 : 1;
    const x = xResolution * factor, y = yResolution * factor;
    if (Number.isFinite(x) && Number.isFinite(y) && x > 0 && y > 0) dpi = { x, y };
  }
  const icc = entries.get(34675);
  return { bytes, view, little, entries, sourceWidth, sourceHeight, width, height, orientation, dpi, hasIcc: !!icc && icc.count > 0 };
}

function readLayout(parsed: Parsed): DecodeLayout {
  const bitsValues = values(parsed, 258, [1]);
  if (bitsValues.length === 0 || bitsValues.some((value) => value !== bitsValues[0])) {
    throw new TiffError('unsupported', 'TIFF channels with differing bit depths are unsupported');
  }
  const bits = bitsValues[0]!;
  if (bits === 32) throw new TiffError('unsupported', '32-bit floating-point TIFF is unsupported');
  if (bits !== 1 && bits !== 8 && bits !== 16) throw new TiffError('unsupported', `Unsupported TIFF bit depth ${bits}`);
  const sampleFormats = values(parsed, 339, [1]);
  if (sampleFormats.some((value) => value !== 1)) {
    throw new TiffError('unsupported', sampleFormats.includes(3)
      ? '32-bit floating-point TIFF is unsupported' : 'Signed or floating-point TIFF samples are unsupported');
  }
  const photometric = scalar(parsed, 262, -1);
  if (![0, 1, 2, 3, 5, 6].includes(photometric)) {
    throw new TiffError('unsupported', `Unsupported TIFF photometric interpretation ${photometric}`);
  }
  const colorSamples = photometric === 2 || photometric === 6 ? 3 : photometric === 5 ? 4 : 1;
  const samples = scalar(parsed, 277, 1);
  if (!Number.isInteger(samples) || samples < colorSamples || samples > MAX_SAMPLES) {
    throw new TiffError('format', `Invalid TIFF SamplesPerPixel ${samples}`);
  }
  if (bitsValues.length !== 1 && bitsValues.length !== samples) {
    throw new TiffError('format', 'TIFF BitsPerSample count does not match SamplesPerPixel');
  }
  const compression = scalar(parsed, 259, 1);
  if (![1, 5, 7, 8, 32946, 32773].includes(compression)) {
    throw new TiffError('unsupported', `Unsupported TIFF compression ${compression}`);
  }
  const predictor = scalar(parsed, 317, 1);
  if (predictor === 3) throw new TiffError('unsupported', 'TIFF floating-point predictor 3 is unsupported');
  if (predictor !== 1 && predictor !== 2) throw new TiffError('unsupported', `Unsupported TIFF predictor ${predictor}`);
  if (predictor === 2 && bits !== 8 && bits !== 16) {
    throw new TiffError('unsupported', 'TIFF horizontal prediction requires 8- or 16-bit samples');
  }
  const planar = scalar(parsed, 284, 1);
  if (planar !== 1 && planar !== 2) throw new TiffError('unsupported', `Unsupported TIFF planar configuration ${planar}`);
  if (photometric === 6 && ((compression !== 1 && compression !== 7) || planar !== 1 || bits !== 8)) {
    throw new TiffError('unsupported', 'Only uncompressed 8-bit chunky YCbCr TIFF is supported');
  }
  const extra = values(parsed, 338, []);
  let alphaSample = -1, associatedAlpha = false;
  for (let i = 0; i < Math.min(extra.length, samples - colorSamples); i++) {
    if (extra[i] === 1 || extra[i] === 2) {
      alphaSample = colorSamples + i;
      associatedAlpha = extra[i] === 1;
      break;
    }
  }
  if (planar === 2 && photometric === 5 && alphaSample >= 0) {
    throw new TiffError('unsupported', 'Planar CMYK TIFF with alpha is unsupported');
  }
  if (photometric === 3 && associatedAlpha) throw new TiffError('unsupported', 'Palette TIFF with associated alpha is unsupported');
  if (planar === 2 && photometric === 3 && bits === 16) {
    throw new TiffError('unsupported', 'Planar 16-bit palette TIFF is unsupported');
  }
  let palette: number[] | null = null;
  if (photometric === 3) {
    const expected = 3 * (2 ** bits);
    palette = values(parsed, 320, []);
    if (palette.length !== expected) throw new TiffError('format', `TIFF ColorMap must contain ${expected} values`);
  }
  return { bits, samples, photometric, compression, planar, predictor, alphaSample, associatedAlpha, colorSamples, palette };
}

function readSegments(parsed: Parsed, layout: DecodeLayout): SegmentGeometry[] {
  const tiled = parsed.entries.has(324) || parsed.entries.has(325);
  const offsetTag = tiled ? 324 : 273, countTag = tiled ? 325 : 279;
  const storedWidth = tiled ? scalar(parsed, 322, 0) : parsed.sourceWidth;
  const storedHeight = tiled ? scalar(parsed, 323, 0) : scalar(parsed, 278, parsed.sourceHeight);
  if (!Number.isInteger(storedWidth) || !Number.isInteger(storedHeight) || storedWidth < 1 || storedHeight < 1) {
    throw new TiffError('format', 'Invalid TIFF tile or strip geometry');
  }
  const across = Math.ceil(parsed.sourceWidth / storedWidth), down = Math.ceil(parsed.sourceHeight / storedHeight);
  const perPlane = checkedMultiply(across, down, 'segment count');
  const expected = checkedMultiply(perPlane, layout.planar === 2 ? layout.samples : 1, 'planar segment count');
  if (expected > MAX_SEGMENTS) throw new TiffError('dimensions', 'TIFF contains too many independently encoded segments');
  const offsetEntry = parsed.entries.get(offsetTag), countEntry = parsed.entries.get(countTag);
  if (!offsetEntry || !countEntry || offsetEntry.count !== expected || countEntry.count !== expected) {
    throw new TiffError('format', `TIFF must contain ${expected} matching segment offsets and byte counts`);
  }
  const offsets = values(parsed, offsetTag, []), counts = values(parsed, countTag, []);
  const result: SegmentGeometry[] = [];
  for (let index = 0; index < expected; index++) {
    const local = index % perPlane, plane = layout.planar === 2 ? Math.floor(index / perPlane) : 0;
    const x = (local % across) * storedWidth, y = Math.floor(local / across) * storedHeight;
    const count = counts[index]!, offset = offsets[index]!;
    if (!Number.isInteger(offset) || !Number.isInteger(count) || count < 0) throw new TiffError('format', 'Invalid TIFF segment range');
    bounds(parsed.bytes, offset, count, `segment ${index}`);
    const segmentHeight = tiled ? storedHeight : Math.min(storedHeight, parsed.sourceHeight - y);
    result.push({ offset, count, x, y, storedWidth, storedHeight: segmentHeight,
      copyWidth: Math.min(storedWidth, parsed.sourceWidth - x), copyHeight: Math.min(segmentHeight, parsed.sourceHeight - y), plane });
  }
  return result;
}

function decodeSegment(parsed: Parsed, layout: DecodeLayout, segment: SegmentGeometry, output: Uint8Array): void {
  const segmentSamples = layout.planar === 1 ? layout.samples : 1;
  if (layout.photometric === 6) {
    decodeYCbCrSegment(parsed, layout, segment, output);
    return;
  }
  const rowBytes = Math.ceil(segment.storedWidth * segmentSamples * layout.bits / 8);
  const expected = checkedMultiply(rowBytes, segment.storedHeight, 'decoded segment size');
  const compressed = parsed.bytes.subarray(segment.offset, segment.offset + segment.count);
  const raw = decompress(compressed, layout.compression, expected);
  if (layout.predictor === 2) undoHorizontalPredictor(raw, rowBytes, segment.storedWidth, segmentSamples, layout.bits, parsed.little);

  const max = layout.bits === 16 ? 65535 : layout.bits === 8 ? 255 : 1;
  for (let row = 0; row < segment.copyHeight; row++) {
    const rowStart = row * rowBytes;
    for (let col = 0; col < segment.copyWidth; col++) {
      const sourceX = segment.x + col, sourceY = segment.y + row;
      const dst = orientedOffset(parsed, sourceX, sourceY);
      if (layout.planar === 2) {
        const value = sample(raw, rowStart, col, layout.bits, parsed.little);
        writePlanarSample(output, dst, segment.plane, value, max, layout);
      } else {
        writeChunkyPixel(output, dst, raw, rowStart, col, max, layout, parsed.little);
      }
    }
  }
}

function writeChunkyPixel(output: Uint8Array, dst: number, raw: Uint8Array, row: number, x: number,
  max: number, layout: DecodeLayout, little: boolean): void {
  const base = x * layout.samples;
  let r = 0, g = 0, b = 0;
  switch (layout.photometric) {
    case 0:
    case 1: {
      const rawGray = sample(raw, row, base, layout.bits, little);
      const gray = toByte(layout.photometric === 0 ? max - rawGray : rawGray, max);
      r = gray; g = gray; b = gray;
      break;
    }
    case 2:
      r = toByte(sample(raw, row, base, layout.bits, little), max);
      g = toByte(sample(raw, row, base + 1, layout.bits, little), max);
      b = toByte(sample(raw, row, base + 2, layout.bits, little), max);
      break;
    case 3: {
      const index = sample(raw, row, base, layout.bits, little), size = max + 1, palette = layout.palette!;
      if (index >= size) throw new TiffError('data', 'TIFF palette index is out of range');
      r = colorMapByte(palette[index]!); g = colorMapByte(palette[index + size]!); b = colorMapByte(palette[index + size * 2]!);
      break;
    }
    case 5: {
      const c = sample(raw, row, base, layout.bits, little) / max;
      const m = sample(raw, row, base + 1, layout.bits, little) / max;
      const y = sample(raw, row, base + 2, layout.bits, little) / max;
      const k = sample(raw, row, base + 3, layout.bits, little) / max;
      // TIFF 6.0 defines CMYK ink values but no browser-independent ICC transform is available.
      r = Math.round(255 * (1 - c) * (1 - k));
      g = Math.round(255 * (1 - m) * (1 - k));
      b = Math.round(255 * (1 - y) * (1 - k));
      break;
    }
  }
  const alpha = layout.alphaSample >= 0
    ? toByte(sample(raw, row, base + layout.alphaSample, layout.bits, little), max) : 255;
  if (layout.associatedAlpha) {
    if (alpha === 0) r = g = b = 0;
    else { r = unpremultiply(r, alpha); g = unpremultiply(g, alpha); b = unpremultiply(b, alpha); }
  }
  output[dst] = r; output[dst + 1] = g; output[dst + 2] = b; output[dst + 3] = alpha;
}

function writePlanarSample(output: Uint8Array, dst: number, plane: number, value: number, max: number, layout: DecodeLayout): void {
  const byte = toByte(value, max);
  if (plane === layout.alphaSample) { output[dst + 3] = byte; return; }
  if (plane >= layout.colorSamples) return;
  if (layout.photometric === 3) output[dst] = value;
  else if (layout.photometric === 0 || layout.photometric === 1) output[dst] = layout.photometric === 0 ? 255 - byte : byte;
  else output[dst + plane] = byte;
}

function finishPlanar(layout: DecodeLayout, output: Uint8Array): void {
  const paletteSize = 2 ** layout.bits;
  for (let i = 0; i < output.length; i += 4) {
    if (layout.photometric === 0 || layout.photometric === 1) output[i + 1] = output[i + 2] = output[i]!;
    else if (layout.photometric === 3) {
      const index = output[i]!, palette = layout.palette!;
      output[i] = colorMapByte(palette[index]!);
      output[i + 1] = colorMapByte(palette[index + paletteSize]!);
      output[i + 2] = colorMapByte(palette[index + paletteSize * 2]!);
    } else if (layout.photometric === 5) {
      const c = output[i]! / 255, m = output[i + 1]! / 255, y = output[i + 2]! / 255, k = output[i + 3]! / 255;
      output[i] = Math.round(255 * (1 - c) * (1 - k));
      output[i + 1] = Math.round(255 * (1 - m) * (1 - k));
      output[i + 2] = Math.round(255 * (1 - y) * (1 - k));
      output[i + 3] = 255;
    }
    if (layout.associatedAlpha) {
      const alpha = output[i + 3]!;
      if (alpha === 0) output[i] = output[i + 1] = output[i + 2] = 0;
      else {
        output[i] = unpremultiply(output[i]!, alpha);
        output[i + 1] = unpremultiply(output[i + 1]!, alpha);
        output[i + 2] = unpremultiply(output[i + 2]!, alpha);
      }
    }
  }
}

function decodeYCbCrSegment(parsed: Parsed, layout: DecodeLayout, segment: SegmentGeometry, output: Uint8Array): void {
  const subsampling = values(parsed, 530, [2, 2]);
  const horizontal = subsampling[0]!, vertical = subsampling[1]!;
  if (![1, 2, 4].includes(horizontal) || ![1, 2, 4].includes(vertical) || subsampling.length !== 2 || layout.samples !== 3) {
    throw new TiffError('unsupported', 'Unsupported TIFF YCbCr subsampling');
  }
  const blocksAcross = Math.ceil(segment.storedWidth / horizontal), blocksDown = Math.ceil(segment.storedHeight / vertical);
  const blockBytes = horizontal * vertical + 2;
  const expected = checkedMultiply(checkedMultiply(blocksAcross, blocksDown, 'YCbCr blocks'), blockBytes, 'YCbCr segment size');
  const raw = decompress(parsed.bytes.subarray(segment.offset, segment.offset + segment.count), layout.compression, expected);
  let source = 0;
  for (let by = 0; by < blocksDown; by++) {
    for (let bx = 0; bx < blocksAcross; bx++) {
      const cb = raw[source + horizontal * vertical]!, cr = raw[source + horizontal * vertical + 1]!;
      for (let yy = 0; yy < vertical; yy++) for (let xx = 0; xx < horizontal; xx++) {
        const localX = bx * horizontal + xx, localY = by * vertical + yy;
        if (localX < segment.copyWidth && localY < segment.copyHeight) {
          const y = raw[source + yy * horizontal + xx]!;
          const dst = orientedOffset(parsed, segment.x + localX, segment.y + localY);
          const red = y + 1.402 * (cr - 128);
          const green = y - 0.344136 * (cb - 128) - 0.714136 * (cr - 128);
          const blue = y + 1.772 * (cb - 128);
          output[dst] = clampByte(red); output[dst + 1] = clampByte(green); output[dst + 2] = clampByte(blue); output[dst + 3] = 255;
        }
      }
      source += blockBytes;
    }
  }
}

async function decodeJpegTiff(parsed: Parsed, layout: DecodeLayout): Promise<TiffResult> {
  if (layout.planar !== 1 || (layout.photometric !== 2 && layout.photometric !== 6) || layout.bits !== 8 || layout.samples < 3) {
    throw new TiffError('unsupported', 'JPEG-in-TIFF is supported only for chunky 8-bit RGB images');
  }
  const segments = readSegments(parsed, layout);
  if (segments.length !== 1 || segments[0]!.copyWidth !== parsed.sourceWidth || segments[0]!.copyHeight !== parsed.sourceHeight) {
    throw new TiffError('unsupported', 'Tiled or multi-strip JPEG-in-TIFF is unsupported');
  }
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') {
    throw new TiffError('unsupported', 'This browser cannot decode JPEG-in-TIFF');
  }
  const segment = segments[0]!;
  let jpeg = parsed.bytes.slice(segment.offset, segment.offset + segment.count);
  const tablesEntry = parsed.entries.get(347);
  if (tablesEntry) {
    const tables = byteValues(parsed, tablesEntry);
    const tableEnd = tables.length >= 2 && tables[tables.length - 2] === 0xff && tables[tables.length - 1] === 0xd9 ? tables.length - 2 : tables.length;
    const scanStart = jpeg.length >= 2 && jpeg[0] === 0xff && jpeg[1] === 0xd8 ? 2 : 0;
    const joined = new Uint8Array(tableEnd + jpeg.length - scanStart);
    joined.set(tables.subarray(0, tableEnd)); joined.set(jpeg.subarray(scanStart), tableEnd); jpeg = joined;
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([jpeg as BlobPart], { type: 'image/jpeg' }), { imageOrientation: 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'default' });
  } catch (cause) {
    throw new TiffError('unsupported', `This browser cannot decode JPEG-in-TIFF: ${message(cause)}`);
  }
  try {
    if (bitmap.width !== parsed.sourceWidth || bitmap.height !== parsed.sourceHeight) throw new TiffError('data', 'JPEG-in-TIFF dimensions do not match the IFD');
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
    if (!context) throw new TiffError('unsupported', 'This browser cannot read JPEG-in-TIFF pixels');
    context.drawImage(bitmap, 0, 0);
    const source = context.getImageData(0, 0, bitmap.width, bitmap.height, { colorSpace: 'srgb' }).data;
    const output = new Uint8Array(parsed.width * parsed.height * 4);
    for (let y = 0; y < parsed.sourceHeight; y++) for (let x = 0; x < parsed.sourceWidth; x++) {
      const src = (y * parsed.sourceWidth + x) * 4, dst = orientedOffset(parsed, x, y);
      output[dst] = source[src]!; output[dst + 1] = source[src + 1]!; output[dst + 2] = source[src + 2]!; output[dst + 3] = source[src + 3]!;
    }
    return { width: parsed.width, height: parsed.height, data: output, dpi: parsed.dpi, hasIcc: parsed.hasIcc };
  } finally { bitmap.close(); }
}

function decompress(input: Uint8Array, compression: number, expected: number): Uint8Array {
  let result: Uint8Array;
  try {
    if (compression === 1) {
      if (input.length < expected) throw new TiffError('truncated', `TIFF segment has ${input.length} bytes, expected ${expected}`);
      result = input.subarray(0, expected);
    } else if (compression === 32773) result = decodePackBits(input, expected);
    else if (compression === 5) result = decodeLzw(input, expected);
    else if (compression === 8 || compression === 32946) {
      const out = new Uint8Array(expected);
      try { result = unzlibSync(input, { out }); }
      catch { result = inflateSync(input, { out }); }
    } else throw new TiffError('unsupported', `Unsupported TIFF compression ${compression}`);
  } catch (cause) {
    if (cause instanceof TiffError) throw cause;
    throw new TiffError('data', `Invalid TIFF compressed segment: ${message(cause)}`);
  }
  if (result.length !== expected) throw new TiffError('data', `TIFF segment expands to ${result.length} bytes, expected ${expected}`);
  return result;
}

function decodePackBits(input: Uint8Array, expected: number): Uint8Array {
  const output = new Uint8Array(expected);
  let source = 0, target = 0;
  while (source < input.length && target < expected) {
    const header = input[source++]!;
    if (header <= 127) {
      const count = header + 1;
      if (source + count > input.length || target + count > expected) throw new TiffError('data', 'Invalid PackBits literal run');
      output.set(input.subarray(source, source + count), target); source += count; target += count;
    } else if (header >= 129) {
      const count = 257 - header;
      if (source >= input.length || target + count > expected) throw new TiffError('data', 'Invalid PackBits repeat run');
      output.fill(input[source++]!, target, target + count); target += count;
    }
  }
  if (target !== expected) throw new TiffError('truncated', 'Truncated PackBits segment');
  return output;
}

function decodeLzw(input: Uint8Array, expected: number): Uint8Array {
  const output = new Uint8Array(expected), prefix = new Int16Array(4096), suffix = new Uint8Array(4096), stack = new Uint8Array(4097);
  for (let i = 0; i < 256; i++) suffix[i] = i;
  let bit = 0, codeSize = 9, nextCode = 258, previous = -1, target = 0, first = 0;
  const readCode = (): number => {
    if (bit + codeSize > input.length * 8) return -1;
    let code = 0;
    for (let i = 0; i < codeSize; i++, bit++) code = (code << 1) | ((input[bit >>> 3]! >>> (7 - (bit & 7))) & 1);
    return code;
  };
  while (target < expected) {
    const code = readCode();
    if (code < 0) break;
    if (code === 256) { codeSize = 9; nextCode = 258; previous = -1; continue; }
    if (code === 257) break;
    if (code > nextCode || code >= 4096) throw new TiffError('data', 'Invalid TIFF LZW code');
    let current = code, stackSize = 0;
    if (current === nextCode) {
      if (previous < 0) throw new TiffError('data', 'Invalid TIFF LZW KwKwK code');
      stack[stackSize++] = first; current = previous;
    }
    while (current >= 256) {
      if (current >= nextCode || stackSize >= 4096) throw new TiffError('data', 'Cyclic TIFF LZW dictionary');
      stack[stackSize++] = suffix[current]!; current = prefix[current]!;
    }
    first = suffix[current]!; stack[stackSize++] = first;
    if (target + stackSize > expected) throw new TiffError('data', 'TIFF LZW segment expands beyond its expected size');
    while (stackSize > 0) output[target++] = stack[--stackSize]!;
    if (previous >= 0 && nextCode < 4096) {
      prefix[nextCode] = previous; suffix[nextCode] = first; nextCode++;
      // TIFF 6.0 LZW uses the early-change convention.
      if (nextCode === (1 << codeSize) - 1 && codeSize < 12) codeSize++;
    }
    previous = code;
  }
  // A few otherwise valid TIFF writers omit EOI; the exact segment byte count remains authoritative.
  if (target !== expected) throw new TiffError('truncated', 'Truncated TIFF LZW segment');
  return output;
}

function undoHorizontalPredictor(data: Uint8Array, rowBytes: number, width: number, samples: number, bits: number, little: boolean): void {
  if (bits === 8) {
    for (let row = 0; row < data.length; row += rowBytes) for (let i = samples; i < width * samples; i++) {
      const at = row + i; data[at] = (data[at]! + data[at - samples]!) & 255;
    }
  } else {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (let row = 0; row < data.length; row += rowBytes) for (let i = samples; i < width * samples; i++) {
      const at = row + i * 2, prior = row + (i - samples) * 2;
      view.setUint16(at, (view.getUint16(at, little) + view.getUint16(prior, little)) & 65535, little);
    }
  }
}

function sample(data: Uint8Array, row: number, index: number, bits: number, little: boolean): number {
  if (bits === 1) return (data[row + (index >>> 3)]! >>> (7 - (index & 7))) & 1;
  if (bits === 8) return data[row + index]!;
  const at = row + index * 2;
  return little ? data[at]! | (data[at + 1]! << 8) : (data[at]! << 8) | data[at + 1]!;
}

function orientedOffset(parsed: Parsed, x: number, y: number): number {
  const w = parsed.sourceWidth, h = parsed.sourceHeight;
  let ox = x, oy = y;
  switch (parsed.orientation) {
    case 2: ox = w - 1 - x; break;
    case 3: ox = w - 1 - x; oy = h - 1 - y; break;
    case 4: oy = h - 1 - y; break;
    case 5: ox = y; oy = x; break;
    case 6: ox = h - 1 - y; oy = x; break;
    case 7: ox = h - 1 - y; oy = w - 1 - x; break;
    case 8: ox = y; oy = w - 1 - x; break;
  }
  return (oy * parsed.width + ox) * 4;
}

function values(parsed: Pick<Parsed, 'bytes' | 'view' | 'little' | 'entries'>, tag: number, fallback: number[]): number[] {
  const entry = parsed.entries.get(tag);
  if (!entry) return fallback;
  if (entry.count > MAX_PIXELS * MAX_SAMPLES) throw new TiffError('format', `TIFF tag ${tag} has an absurd value count`);
  const size = typeSize(entry.type), start = entry.count * size <= 4 ? entry.inline : entry.value;
  const result = new Array<number>(entry.count);
  for (let i = 0; i < entry.count; i++) result[i] = numericValue(parsed, entry.type, start + i * size);
  return result;
}

function scalar(parsed: Pick<Parsed, 'bytes' | 'view' | 'little' | 'entries'>, tag: number, fallback: number): number {
  const entry = parsed.entries.get(tag);
  if (!entry) return fallback;
  if (entry.count !== 1) throw new TiffError('format', `TIFF tag ${tag} must be scalar`);
  const size = typeSize(entry.type), start = size <= 4 ? entry.inline : entry.value;
  return numericValue(parsed, entry.type, start);
}

function requiredScalar(parsed: Pick<Parsed, 'bytes' | 'view' | 'little' | 'entries'>, tag: number): number {
  if (!parsed.entries.has(tag)) throw new TiffError('format', `Required TIFF tag ${tag} is missing`);
  return scalar(parsed, tag, 0);
}

function rational(parsed: Pick<Parsed, 'bytes' | 'view' | 'little' | 'entries'>, tag: number): number | null {
  const entry = parsed.entries.get(tag);
  if (!entry || entry.count !== 1 || (entry.type !== 5 && entry.type !== 10)) return null;
  const signed = entry.type === 10, numerator = signed ? parsed.view.getInt32(entry.value, parsed.little) : parsed.view.getUint32(entry.value, parsed.little);
  const denominator = signed ? parsed.view.getInt32(entry.value + 4, parsed.little) : parsed.view.getUint32(entry.value + 4, parsed.little);
  return denominator === 0 ? null : numerator / denominator;
}

function numericValue(parsed: Pick<Parsed, 'view' | 'little'>, type: number, at: number): number {
  switch (type) {
    case 1: case 2: case 6: case 7: return parsed.view.getUint8(at);
    case 3: return parsed.view.getUint16(at, parsed.little);
    case 4: case 13: return parsed.view.getUint32(at, parsed.little);
    case 8: return parsed.view.getInt16(at, parsed.little);
    case 9: return parsed.view.getInt32(at, parsed.little);
    case 11: return parsed.view.getFloat32(at, parsed.little);
    case 12: return parsed.view.getFloat64(at, parsed.little);
    default: throw new TiffError('format', `TIFF field type ${type} is not numeric`);
  }
}

function byteValues(parsed: Parsed, entry: Entry): Uint8Array {
  const size = typeSize(entry.type), length = checkedMultiply(entry.count, size, 'tag byte size');
  const start = length <= 4 ? entry.inline : entry.value;
  bounds(parsed.bytes, start, length, 'tag bytes');
  return parsed.bytes.slice(start, start + length);
}

function typeSize(type: number): number {
  if (type === 1 || type === 2 || type === 6 || type === 7) return 1;
  if (type === 3 || type === 8) return 2;
  if (type === 4 || type === 9 || type === 11 || type === 13) return 4;
  if (type === 5 || type === 10 || type === 12) return 8;
  return 0;
}

function bounds(bytes: Uint8Array, offset: number, length: number, label: string): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset > bytes.length || length > bytes.length - offset) {
    throw new TiffError('truncated', `Invalid or truncated TIFF ${label}`);
  }
}

function checkedMultiply(a: number, b: number, label: string): number {
  const value = a * b;
  if (!Number.isSafeInteger(value) || value < 0 || value > 0x7fff_ffff) throw new TiffError('dimensions', `TIFF ${label} is too large`);
  return value;
}

function validateDimensions(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new TiffError('dimensions', 'Invalid TIFF dimensions');
  if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) throw new TiffError('dimensions', 'TIFF dimensions exceed the 30,000-pixel side or 100-megapixel limit');
}

function toByte(value: number, max: number): number { return Math.floor((value * 255 + Math.floor(max / 2)) / max); }
function colorMapByte(value: number): number { return Math.floor((value + 128) / 257); }
function unpremultiply(value: number, alpha: number): number { return Math.min(255, Math.floor((value * 255 + Math.floor(alpha / 2)) / alpha)); }
function clampByte(value: number): number { return value <= 0 ? 0 : value >= 255 ? 255 : Math.round(value); }
function message(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause); }
