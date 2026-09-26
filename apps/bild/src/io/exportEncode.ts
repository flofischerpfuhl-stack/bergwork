/**
 * Format encoders behind the export pipeline. Runs in the export worker (and in-thread where workers
 * are unavailable). Input is straight-alpha RGBA8 or RGBA16 that the pipeline has already rendered,
 * backed and matted; this module only serialises pixels and metadata.
 */

import { Deflate, zlibSync } from 'fflate';
import { encodeAvif } from './avif';
import { encodeWebp } from './webp';
import { withJpegDensity } from './jpegMeta';
import { encodeTiff } from './tiffEncode';
import { openDeflateEnd } from './deflateJoin';
import { concat, exifBlock, jpegWithMetadata, pngIccpPayload, webpWithMetadata, type ExportInfo } from './exportMetadata';
import { encodeCmykJpeg } from './jpegCmykEncode';

export type ExportFormat = 'png' | 'jpeg' | 'webp' | 'avif' | 'tiff';

export interface EncodeSpec {
  readonly format: ExportFormat;
  readonly colorModel?: 'rgb' | 'cmyk';
  /** Write an alpha channel. False: the pixels were flattened onto a matte (alpha is 255). */
  readonly alpha: boolean;
  /** 0…1 for JPEG/WebP/AVIF. */
  readonly quality: number;
  readonly lossless: boolean;
  /** AVIF encoder speed 0 (slow, small) … 10 (fast). */
  readonly speed: number;
  /** Deflate level for PNG and TIFF. */
  readonly level: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  readonly tiffCompression: 'lzw' | 'deflate' | 'none';
  readonly dpi: number | null;
  readonly icc: Uint8Array | null;
  readonly info: ExportInfo | null;
}

export async function encodePixels(pixels: Uint8Array | Uint16Array, width: number, height: number, spec: EncodeSpec): Promise<Uint8Array> {
  const deep = pixels instanceof Uint16Array;
  if (deep && spec.format !== 'png' && spec.format !== 'tiff') throw new RangeError(`${spec.format.toUpperCase()} export is 8-bit only.`);
  switch (spec.format) {
    case 'png': {
      if (width * height >= 1_000_000) return encodePngBandsAsync(pixels, width, height, spec, Math.max(64, Math.ceil(2_000_000 / width)));
      const header = pngHeader(width, height, deep ? 16 : 8, spec);
      const filtered = pngFilterRows(pixels, width, 0, height, spec.alpha ? 4 : 3);
      return concat([header, pngChunk('IDAT', zlibSync(filtered, { level: spec.level })), PNG_END]);
    }
    case 'tiff':
      return encodeTiff(pixels, width, height, { alpha: spec.alpha, compression: spec.tiffCompression, level: spec.level,
        colorModel: spec.colorModel, dpi: spec.dpi, iccProfile: spec.icc, info: spec.info });
    case 'jpeg': return encodeJpeg(pixels as Uint8Array, width, height, spec);
    case 'webp': {
      const encoded = await encodeWebp(pixels as Uint8Array, width, height, { quality: spec.quality, lossless: spec.lossless, alphaQuality: 1 });
      return webpWithMetadata(encoded, width, height, spec.alpha && hasTransparency(pixels as Uint8Array),
        { icc: spec.icc, exif: spec.info ? exifBlock(spec.info) : null });
    }
    case 'avif':
      return encodeAvif(pixels as Uint8Array, width, height, { quality: spec.quality, speed: spec.speed, alphaQuality: 1,
        ...(spec.icc ? { iccProfile: spec.icc } : {}) });
  }
}

function hasTransparency(pixels: Uint8Array): boolean {
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i] !== 255) return true;
  return false;
}

async function encodeJpeg(pixels: Uint8Array, width: number, height: number, spec: EncodeSpec): Promise<Uint8Array> {
  if (spec.colorModel === 'cmyk') {
    let bytes = encodeCmykJpeg(pixels, width, height, spec.quality);
    if (spec.dpi) bytes = withJpegDensity(bytes, spec.dpi);
    return jpegWithMetadata(bytes, { icc: spec.icc, exif: spec.info ? exifBlock(spec.info) : null });
  }
  const image = new ImageData(new Uint8ClampedArray(pixels.buffer as ArrayBuffer, pixels.byteOffset, pixels.byteLength), width, height);
  // The browser's JPEG encoder (libjpeg-turbo in every engine) via OffscreenCanvas, which exists in
  // windows and workers of all supported browsers; there is no DOM canvas fallback in the engine.
  if (typeof OffscreenCanvas === 'undefined') throw new Error('JPEG export needs OffscreenCanvas.');
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d')!.putImageData(image, 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: spec.quality });
  let bytes: Uint8Array = new Uint8Array(await blob.arrayBuffer());
  if (spec.dpi) bytes = withJpegDensity(bytes, spec.dpi);
  return jpegWithMetadata(bytes, { icc: spec.icc, exif: spec.info ? exifBlock(spec.info) : null });
}

// MARK: PNG (band-parallel)

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
/** IEND has no data: its CRC is the constant AE 42 60 82. */
const PNG_END = new Uint8Array([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
/** zlib header for a 32 KB window at the default compression class. */
export const ZLIB_HEADER = new Uint8Array([0x78, 0x9c]);

/** Signature, IHDR and the ancillary chunks that must precede IDAT. */
export function pngHeader(width: number, height: number, bitDepth: 8 | 16, spec: Pick<EncodeSpec, 'alpha' | 'dpi' | 'icc' | 'info'>): Uint8Array {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width); view.setUint32(4, height);
  ihdr[8] = bitDepth; ihdr[9] = spec.alpha ? 6 : 2;
  const parts = [PNG_SIGNATURE, pngChunk('IHDR', ihdr)];
  if (spec.icc) parts.push(pngChunk('iCCP', pngIccpPayload(spec.icc)));
  if (spec.dpi) {
    const phys = new Uint8Array(9);
    const ppm = Math.round(spec.dpi / 0.0254);
    new DataView(phys.buffer).setUint32(0, ppm); new DataView(phys.buffer).setUint32(4, ppm); phys[8] = 1;
    parts.push(pngChunk('pHYs', phys));
  }
  if (spec.info) parts.push(pngChunk('eXIf', exifBlock(spec.info)));
  return concat(parts);
}

export function pngTrailer(adler: number): Uint8Array {
  const trailer = new Uint8Array(4);
  new DataView(trailer.buffer).setUint32(0, adler);
  return concat([pngChunk('IDAT', trailer), PNG_END]);
}

/**
 * Filtered scanlines for rows [from, to) of RGBA pixels, written as `channels` (3 drops alpha)
 * big-endian samples. Row `from - 1` (when present) is the Up/Paeth reference, so bands filter
 * independently. Filter choice per row: minimum sum of absolute residuals (libpng's heuristic),
 * scored on every 63rd byte (the stride is coprime to RGB/RGBA samples, so all channels are
 * visited; substantially cheaper than scoring every byte, with the same decoded pixels).
 */
export function pngFilterRows(pixels: Uint8Array | Uint16Array, width: number, from: number, to: number, channels: 3 | 4): Uint8Array {
  const deep = pixels instanceof Uint16Array;
  const bpp = channels * (deep ? 2 : 1), stride = width * bpp;
  const out = new Uint8Array((stride + 1) * (to - from));
  // The dominant export path is RGBA8. Its rows already have PNG's byte layout, so filter them
  // directly instead of copying every 46 MP input byte through a temporary scanline first.
  if (!deep && channels === 4) {
    const scores = new Float64Array(5);
    for (let y = from; y < to; y++) {
      const current = pixels.subarray(y * stride, (y + 1) * stride);
      const previous = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : new Uint8Array(stride);
      const target = (y - from) * (stride + 1) + 1, up = y > 0;
      scores.fill(0);
      for (let i = 0; i < stride; i += 63) {
        const value = current[i]!, left = i >= bpp ? current[i - bpp]! : 0;
        const above = up ? previous[i]! : 0, upperLeft = up && i >= bpp ? previous[i - bpp]! : 0;
        scores[0]! += magnitude(value); scores[1]! += magnitude(value - left);
        scores[2]! += magnitude(value - above); scores[3]! += magnitude(value - ((left + above) >> 1));
        scores[4]! += magnitude(value - paeth(left, above, upperLeft));
      }
      let best = 0;
      for (let filter = 1; filter <= 4; filter++) if ((up || filter === 1) && scores[filter]! < scores[best]!) best = filter;
      out[target - 1] = best;
      writeFilter(best, current, previous, stride, bpp, out, target);
    }
    return out;
  }
  let previous = new Uint8Array(stride), current = new Uint8Array(stride);
  const hasPrevious = from > 0;
  if (hasPrevious) scanline(pixels, width, from - 1, channels, deep, previous);
  const scores = new Float64Array(5);
  for (let y = from; y < to; y++) {
    scanline(pixels, width, y, channels, deep, current);
    const target = (y - from) * (stride + 1) + 1;
    const up = y > from || hasPrevious;
    scores.fill(0);
    for (let i = 0; i < stride; i += 7) {
      const value = current[i]!, left = i >= bpp ? current[i - bpp]! : 0;
      const above = up ? previous[i]! : 0, upperLeft = up && i >= bpp ? previous[i - bpp]! : 0;
      scores[0]! += magnitude(value);
      scores[1]! += magnitude(value - left);
      scores[2]! += magnitude(value - above);
      scores[3]! += magnitude(value - ((left + above) >> 1));
      scores[4]! += magnitude(value - paeth(left, above, upperLeft));
    }
    let best = 0;
    for (let filter = 1; filter <= 4; filter++) if ((up || filter === 1) && scores[filter]! < scores[best]!) best = filter;
    out[target - 1] = best;
    writeFilter(best, current, previous, stride, bpp, out, target);
    const swap = previous; previous = current; current = swap;
  }
  return out;
}

function magnitude(residual: number): number { const v = residual & 255; return v < 128 ? v : 256 - v; }

function paeth(left: number, above: number, upperLeft: number): number {
  const p = left + above - upperLeft;
  const pa = p > left ? p - left : left - p, pb = p > above ? p - above : above - p, pc = p > upperLeft ? p - upperLeft : upperLeft - p;
  return pa <= pb && pa <= pc ? left : pb <= pc ? above : upperLeft;
}

function writeFilter(filter: number, current: Uint8Array, previous: Uint8Array, stride: number, bpp: number,
  out: Uint8Array, target: number): void {
  switch (filter) {
    case 0: out.set(current, target); return;
    case 1:
      for (let i = 0; i < bpp; i++) out[target + i] = current[i]!;
      for (let i = bpp; i < stride; i++) out[target + i] = current[i]! - current[i - bpp]!;
      return;
    case 2:
      for (let i = 0; i < stride; i++) out[target + i] = current[i]! - previous[i]!;
      return;
    case 3:
      for (let i = 0; i < bpp; i++) out[target + i] = current[i]! - (previous[i]! >> 1);
      for (let i = bpp; i < stride; i++) out[target + i] = current[i]! - ((current[i - bpp]! + previous[i]!) >> 1);
      return;
    default:
      for (let i = 0; i < bpp; i++) out[target + i] = current[i]! - previous[i]!;
      for (let i = bpp; i < stride; i++) out[target + i] = current[i]! - paeth(current[i - bpp]!, previous[i]!, previous[i - bpp]!);
  }
}

function scanline(pixels: Uint8Array | Uint16Array, width: number, y: number, channels: 3 | 4, deep: boolean, out: Uint8Array): void {
  const base = y * width * 4;
  if (!deep && channels === 4) { out.set((pixels as Uint8Array).subarray(base, base + width * 4)); return; }
  let at = 0;
  for (let x = 0; x < width; x++) {
    for (let c = 0; c < channels; c++) {
      const v = pixels[base + x * 4 + c]!;
      if (deep) { out[at++] = v >>> 8; out[at++] = v & 255; } else out[at++] = v;
    }
  }
}

export interface PngBand {
  /** One IDAT chunk (length, type, data, CRC) holding this band's deflate blocks. */
  readonly chunk: Uint8Array;
  readonly adler: number;
  readonly length: number;
}

/**
 * Filters and deflates one band. Non-final bands end with a sync flush so the next band's
 * independent deflate stream can follow (pigz's approach); the last band sets BFINAL.
 */
export function pngCompressBand(pixels: Uint8Array | Uint16Array, width: number, from: number, to: number, channels: 3 | 4,
  level: EncodeSpec['level'], final: boolean): PngBand {
  const filtered = pngFilterRows(pixels, width, from, to, channels);
  const parts: Uint8Array[] = [];
  const deflate = new Deflate({ level }, (chunk) => { parts.push(chunk); });
  deflate.push(filtered, final);
  if (!final) parts.push(syncFlush(deflate));
  return { chunk: pngChunk('IDAT', concat(parts)), adler: adler32(filtered), length: filtered.length };
}

/**
 * Emits pending data and an empty non-final stored block (00 00 FF FF), byte-aligning the stream.
 * fflate 0.8.3's `flush(true)` writes that block at a wrong bit offset (it passes the packed
 * residue `s.r = bitOffset | partialByte << 3` as a bit position), so the block is written here from
 * the same state after a plain flush. Covered by the band-stitching unit test.
 */
function syncFlush(deflate: Deflate): Uint8Array {
  deflate.flush(false);
  const residue = (deflate as unknown as { s?: { r?: unknown } }).s?.r;
  if (typeof residue !== 'number') throw new Error('Unsupported fflate version for band-parallel PNG.');
  const bits = residue & 7, partial = (residue >> 3) & 255;
  return bits + 3 > 8 ? new Uint8Array([partial, 0, 0, 0, 0xff, 0xff]) : new Uint8Array([partial, 0, 0, 0xff, 0xff]);
}

export function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(data.length + 12);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
  chunk.set(data, 8);
  view.setUint32(data.length + 8, crc32(chunk, 4, data.length + 8));
  return chunk;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array, start: number, end: number): number {
  let crc = 0xffff_ffff;
  for (let i = start; i < end; i++) crc = CRC_TABLE[(crc ^ data[i]!) & 255]! ^ (crc >>> 8);
  return (crc ^ 0xffff_ffff) >>> 0;
}

const ADLER_BASE = 65521;

export function adler32(data: Uint8Array): number {
  let a = 1, b = 0;
  for (let i = 0; i < data.length;) {
    const end = Math.min(data.length, i + 5552);
    for (; i < end; i++) { a += data[i]!; b += a; }
    a %= ADLER_BASE; b %= ADLER_BASE;
  }
  return ((b << 16) | a) >>> 0;
}

/** zlib's adler32_combine: the checksum of A‖B from those of A and B and B's length. */
export function adler32Combine(first: number, second: number, secondLength: number): number {
  const remainder = secondLength % ADLER_BASE;
  let sum1 = first & 0xffff;
  let sum2 = (remainder * sum1) % ADLER_BASE;
  sum1 += (second & 0xffff) + ADLER_BASE - 1;
  sum2 += ((first >>> 16) & 0xffff) + ((second >>> 16) & 0xffff) + ADLER_BASE - remainder;
  if (sum1 >= ADLER_BASE) sum1 -= ADLER_BASE;
  if (sum1 >= ADLER_BASE) sum1 -= ADLER_BASE;
  if (sum2 >= ADLER_BASE * 2) sum2 -= ADLER_BASE * 2;
  if (sum2 >= ADLER_BASE) sum2 -= ADLER_BASE;
  return ((sum2 << 16) | sum1) >>> 0;
}

/** Assembles a PNG from header, band chunks (in order) and the combined Adler-32. */
export function assemblePng(header: Uint8Array, bands: readonly PngBand[]): Uint8Array {
  let adler = 1;
  for (const band of bands) adler = adler32Combine(adler, band.adler, band.length);
  return concat([header, pngChunk('IDAT', ZLIB_HEADER), ...bands.map((band) => band.chunk), pngTrailer(adler)]);
}

/** Band-wise PNG in one thread (same bytes as the parallel path with the same band split). */
export function encodePngBands(pixels: Uint8Array | Uint16Array, width: number, height: number, spec: EncodeSpec, bandRows: number): Uint8Array {
  const channels = spec.alpha ? 4 : 3;
  const bands: PngBand[] = [];
  for (let y = 0; y < height; y += bandRows) {
    const to = Math.min(height, y + bandRows);
    bands.push(pngCompressBand(pixels, width, y, to, channels, spec.level, to === height));
  }
  return assemblePng(pngHeader(width, height, pixels instanceof Uint16Array ? 16 : 8, spec), bands);
}

// MARK: Native deflate (browser zlib through CompressionStream)

let nativeDeflate: boolean | null = null;

/** Whether `CompressionStream('deflate')` exists (Chromium 80+, Firefox 113+, Safari 16.4+, Node 18+). */
export function hasNativeDeflate(): boolean {
  if (nativeDeflate === null) {
    try { new CompressionStream('deflate'); nativeDeflate = true; } catch { nativeDeflate = false; }
  }
  return nativeDeflate;
}

/** Native zlib stream split into the raw deflate data and its Adler-32 trailer (saves a JS checksum pass). */
async function deflateNative(data: Uint8Array): Promise<{ raw: Uint8Array; adler: number }> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('deflate'));
  const zlib = new Uint8Array(await new Response(stream).arrayBuffer());
  const adler = new DataView(zlib.buffer, zlib.byteOffset + zlib.length - 4, 4).getUint32(0);
  return { raw: zlib.subarray(2, zlib.length - 4), adler };
}

/**
 * `pngCompressBand` with the browser's native zlib where available. Native deflate always uses zlib's
 * default level 6, so other levels (and engines without CompressionStream) take the fflate path.
 * Non-final bands are re-opened with `openDeflateEnd` (last block made non-final + sync marker).
 */
export async function pngCompressBandAsync(pixels: Uint8Array | Uint16Array, width: number, from: number, to: number,
  channels: 3 | 4, level: EncodeSpec['level'], final: boolean, native = hasNativeDeflate()): Promise<PngBand> {
  if (!native || level !== 6) return pngCompressBand(pixels, width, from, to, channels, level, final);
  const filtered = pngFilterRows(pixels, width, from, to, channels);
  const { raw, adler } = await deflateNative(filtered);
  return { chunk: pngChunk('IDAT', final ? raw : openDeflateEnd(raw)), adler, length: filtered.length };
}

export async function encodePngBandsAsync(pixels: Uint8Array | Uint16Array, width: number, height: number, spec: EncodeSpec,
  bandRows: number, native = hasNativeDeflate()): Promise<Uint8Array> {
  const channels = spec.alpha ? 4 : 3;
  const bands: PngBand[] = [];
  for (let y = 0; y < height; y += bandRows) {
    const to = Math.min(height, y + bandRows);
    bands.push(await pngCompressBandAsync(pixels, width, y, to, channels, spec.level, to === height, native));
  }
  return assemblePng(pngHeader(width, height, pixels instanceof Uint16Array ? 16 : 8, spec), bands);
}
