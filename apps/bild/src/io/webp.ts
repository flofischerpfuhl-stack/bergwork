import { MAX_PIXELS, MAX_SIDE } from '../core/document';
import { IccError, loadLittleCms } from '../wasm/lcms';

export interface WebpLimits { readonly maxSide: number; readonly maxPixels: number }
const DEFAULT_LIMITS: WebpLimits = { maxSide: MAX_SIDE, maxPixels: MAX_PIXELS };

export class WebpError extends Error {
  readonly code: 'not-webp' | 'unreadable' | 'dimensions' | 'option';
  constructor(code: WebpError['code'], message = 'Invalid or damaged WebP image.') {
    super(message); this.name = 'WebpError'; this.code = code;
  }
}

export interface WebpResult { readonly width: number; readonly height: number; readonly data: Uint8Array }
export interface WebpEncodeOptions {
  readonly quality?: number;
  readonly alphaQuality?: number;
  readonly lossless?: boolean;
  /** Optional RGB input profile written as the WebP ICCP chunk. */
  readonly iccProfile?: Uint8Array;
}

export function isWebp(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && ascii(bytes, 0) === 'RIFF' && ascii(bytes, 8) === 'WEBP'
    && u32le(bytes, 4) + 8 <= bytes.length;
}

/** Parses VP8/VP8L/VP8X dimensions so the allocation gate runs before any codec. */
export function webpDimensions(bytes: Uint8Array, limits: WebpLimits = DEFAULT_LIMITS): { width: number; height: number } {
  if (!isWebp(bytes)) throw new WebpError('not-webp');
  let canvas: { width: number; height: number } | null = null, animated = false;
  for (const chunk of chunks(bytes)) {
    let width = 0, height = 0;
    if (chunk.type === 'VP8X') {
      if (chunk.size < 10) throw new WebpError('unreadable');
      width = u24le(bytes, chunk.data + 4) + 1; height = u24le(bytes, chunk.data + 7) + 1;
      validateDimensions(width, height, limits);
      canvas = { width, height }; animated = (bytes[chunk.data]! & 2) !== 0;
      if (!animated) return canvas;
      continue;
    } else if (chunk.type === 'ANMF') {
      if (!canvas || chunk.size < 16) throw new WebpError('unreadable');
      const x = u24le(bytes, chunk.data) * 2, y = u24le(bytes, chunk.data + 3) * 2;
      width = u24le(bytes, chunk.data + 6) + 1; height = u24le(bytes, chunk.data + 9) + 1;
      validateDimensions(width, height, limits);
      if (x + width > canvas.width || y + height > canvas.height) throw new WebpError('unreadable');
      return canvas; // only the first frame is imported
    } else if (chunk.type === 'VP8L') {
      if (chunk.size < 5 || bytes[chunk.data] !== 0x2f) throw new WebpError('unreadable');
      const bits = u32le(bytes, chunk.data + 1);
      width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1;
    } else if (chunk.type === 'VP8 ') {
      if (chunk.size < 10 || bytes[chunk.data + 3] !== 0x9d || bytes[chunk.data + 4] !== 1 || bytes[chunk.data + 5] !== 0x2a) {
        throw new WebpError('unreadable');
      }
      width = u16le(bytes, chunk.data + 6) & 0x3fff; height = u16le(bytes, chunk.data + 8) & 0x3fff;
    } else continue;
    validateDimensions(width, height, limits);
    return { width, height };
  }
  if (animated && canvas) throw new WebpError('unreadable');
  throw new WebpError('unreadable');
}

export function webpIccProfile(bytes: Uint8Array): Uint8Array | null {
  if (!isWebp(bytes)) throw new WebpError('not-webp');
  const chunk = chunks(bytes).find((entry) => entry.type === 'ICCP');
  return chunk ? bytes.slice(chunk.data, chunk.data + chunk.size) : null;
}

/** Embedded WebP profiles take the same deterministic Little CMS path as PNG/JPEG. */
export async function decodeManagedWebp(bytes: Uint8Array, limits: WebpLimits = DEFAULT_LIMITS): Promise<WebpResult> {
  const { width, height } = webpDimensions(bytes, limits), profile = webpIccProfile(bytes);
  const { decodeWebpWasm } = await import('../wasm/webp');
  const rgba = await decodeWebpWasm(bytes, width, height);
  if (!profile) return { width, height, data: rgba };
  const colors = new Uint8Array(width * height * 3), alpha = new Uint8Array(width * height);
  for (let source = 0, pixel = 0, target = 0; pixel < alpha.length; pixel++, source += 4, target += 3) {
    colors[target] = rgba[source]!; colors[target + 1] = rgba[source + 1]!; colors[target + 2] = rgba[source + 2]!;
    alpha[pixel] = rgba[source + 3]!;
  }
  try { return { width, height, data: (await loadLittleCms()).transform(profile, colors, 'rgb', 8, alpha) }; }
  catch (error) {
    // ImageImporter.swift/ImageIO ignores an unusable embedded profile and keeps decoded samples.
    if (error instanceof IccError) return { width, height, data: rgba };
    throw error;
  }
}

/** Lazy libwebp encoder. Quality values use the product-wide 0…1 scale; RGBA alpha is retained. */
export async function encodeWebp(data: Uint8Array, width: number, height: number,
  options: WebpEncodeOptions = {}): Promise<Uint8Array> {
  validatePixels(data, width, height);
  const quality = fraction(options.quality ?? 0.85, 'quality');
  const alphaQuality = fraction(options.alphaQuality ?? 1, 'alphaQuality');
  if (options.iccProfile?.byteLength === 0) throw new WebpError('option', 'WebP ICC profile must not be empty.');
  const { encodeWebpWasm } = await import('../wasm/webp');
  const encoded = await encodeWebpWasm(data, width, height, quality * 100, options.lossless ?? false, Math.round(alphaQuality * 100));
  if (!options.iccProfile) return encoded;
  let hasAlpha = false;
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) { hasAlpha = true; break; }
  return attachIcc(encoded, options.iccProfile, hasAlpha);
}

interface Chunk { readonly type: string; readonly data: number; readonly size: number }
function chunks(bytes: Uint8Array): Chunk[] {
  const result: Chunk[] = [];
  const end = u32le(bytes, 4) + 8;
  for (let at = 12; at + 8 <= end;) {
    const size = u32le(bytes, at + 4), data = at + 8, next = data + size + (size & 1);
    if (size > end - data || next > end) throw new WebpError('unreadable');
    result.push({ type: ascii(bytes, at), data, size }); at = next;
  }
  return result;
}
function attachIcc(encoded: Uint8Array, profile: Uint8Array, hasAlpha: boolean): Uint8Array {
  const dimensions = webpDimensions(encoded), source = chunks(encoded);
  const existing = source.find((chunk) => chunk.type === 'VP8X');
  const vp8x = existing ? encoded.slice(existing.data, existing.data + existing.size) : new Uint8Array(10);
  if (vp8x.length !== 10) throw new WebpError('unreadable');
  vp8x[0] = vp8x[0]! | 0x20 | (hasAlpha ? 0x10 : 0);
  if (!existing) { writeU24le(vp8x, 4, dimensions.width - 1); writeU24le(vp8x, 7, dimensions.height - 1); }
  const parts = [riffChunk('VP8X', vp8x), riffChunk('ICCP', profile)];
  for (const chunk of source) {
    if (chunk.type !== 'VP8X' && chunk.type !== 'ICCP') parts.push(riffChunk(chunk.type, encoded.subarray(chunk.data, chunk.data + chunk.size)));
  }
  let length = 12;
  for (const part of parts) length += part.byteLength;
  const output = new Uint8Array(length);
  writeAscii(output, 0, 'RIFF'); writeU32le(output, 4, length - 8); writeAscii(output, 8, 'WEBP');
  let at = 12; for (const part of parts) { output.set(part, at); at += part.byteLength; }
  return output;
}
function riffChunk(type: string, payload: Uint8Array): Uint8Array {
  const output = new Uint8Array(8 + payload.byteLength + (payload.byteLength & 1));
  writeAscii(output, 0, type); writeU32le(output, 4, payload.byteLength); output.set(payload, 8); return output;
}
function validatePixels(data: Uint8Array, width: number, height: number): void {
  validateDimensions(width, height);
  if (data.byteLength !== width * height * 4) throw new WebpError('option', 'WebP pixels must be straight-alpha RGBA8.');
}
function validateDimensions(width: number, height: number, limits: WebpLimits = DEFAULT_LIMITS): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
    || width > limits.maxSide || height > limits.maxSide || width * height > limits.maxPixels) throw new WebpError('dimensions');
}
function fraction(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new WebpError('option', `WebP ${name} must be between 0 and 1.`);
  return value;
}
function ascii(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
}
function u16le(bytes: Uint8Array, at: number): number { return bytes[at]! | (bytes[at + 1]! << 8); }
function u24le(bytes: Uint8Array, at: number): number { return bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16); }
function u32le(bytes: Uint8Array, at: number): number {
  return (bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! * 0x1000000)) >>> 0;
}
function writeAscii(bytes: Uint8Array, at: number, value: string): void {
  for (let i = 0; i < 4; i++) bytes[at + i] = value.charCodeAt(i);
}
function writeU24le(bytes: Uint8Array, at: number, value: number): void {
  bytes[at] = value; bytes[at + 1] = value >>> 8; bytes[at + 2] = value >>> 16;
}
function writeU32le(bytes: Uint8Array, at: number, value: number): void {
  bytes[at] = value; bytes[at + 1] = value >>> 8; bytes[at + 2] = value >>> 16; bytes[at + 3] = value >>> 24;
}
