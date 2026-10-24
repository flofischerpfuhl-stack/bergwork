/**
 * Export metadata writers: EXIF-like creator info, embedded ICC profiles and resolution for the
 * encoded formats (PRODUCT-PLAN 6.1 "Metadaten-Wahl"). Mirrors Photoshop Export As: metadata is
 * either stripped or limited to copyright/contact fields; the colour profile is a separate choice.
 */

import { zlibSync } from 'fflate';

/** Creator fields written as EXIF (JPEG APP1, PNG eXIf, WebP EXIF, TIFF tags). */
export interface ExportInfo {
  readonly copyright?: string;
  readonly artist?: string;
  readonly description?: string;
  /** Defaults to the product name. */
  readonly software?: string;
}

export const EXPORT_SOFTWARE = 'berg:work Image';

const TAG_DESCRIPTION = 270, TAG_SOFTWARE = 305, TAG_ARTIST = 315, TAG_COPYRIGHT = 33432;

/** ASCII (Latin-1 fallback) tag values; EXIF ASCII has no encoding field, so other characters become '?'. */
function asciiBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length + 1);
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    bytes[i] = code >= 0x20 && code < 0x7f ? code : code >= 0xa0 && code <= 0xff ? code : 0x3f;
  }
  return bytes;
}

export function infoTags(info: ExportInfo): [number, string][] {
  const tags: [number, string][] = [];
  if (info.description) tags.push([TAG_DESCRIPTION, info.description]);
  tags.push([TAG_SOFTWARE, info.software ?? EXPORT_SOFTWARE]);
  if (info.artist) tags.push([TAG_ARTIST, info.artist]);
  if (info.copyright) tags.push([TAG_COPYRIGHT, info.copyright]);
  return tags;
}

/** A little-endian TIFF structure with one IFD of ASCII creator tags (the EXIF payload). */
export function exifBlock(info: ExportInfo): Uint8Array {
  const tags = infoTags(info).map(([tag, value]) => [tag, asciiBytes(value)] as const).sort((a, b) => a[0] - b[0]);
  const ifdSize = 2 + tags.length * 12 + 4;
  let dataAt = 8 + ifdSize;
  const size = dataAt + tags.reduce((sum, [, bytes]) => sum + (bytes.length > 4 ? bytes.length + (bytes.length & 1) : 0), 0);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set([0x49, 0x49, 42, 0]);
  view.setUint32(4, 8, true);
  view.setUint16(8, tags.length, true);
  tags.forEach(([tag, bytes], index) => {
    const entry = 10 + index * 12;
    view.setUint16(entry, tag, true);
    view.setUint16(entry + 2, 2, true);
    view.setUint32(entry + 4, bytes.length, true);
    if (bytes.length <= 4) out.set(bytes, entry + 8);
    else { view.setUint32(entry + 8, dataAt, true); out.set(bytes, dataAt); dataAt += bytes.length + (bytes.length & 1); }
  });
  return out;
}

/** Reads the ASCII creator tags back (tests and the file-size preview). */
export function readExifInfo(tiff: Uint8Array): Record<number, string> {
  const little = tiff[0] === 0x49;
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const ifd = view.getUint32(4, little), count = view.getUint16(ifd, little);
  const result: Record<number, string> = {};
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (view.getUint16(entry + 2, little) !== 2) continue;
    const length = view.getUint32(entry + 4, little);
    const at = length <= 4 ? entry + 8 : view.getUint32(entry + 8, little);
    result[view.getUint16(entry, little)] = String.fromCharCode(...tiff.subarray(at, at + length - 1));
  }
  return result;
}

// MARK: PNG

export function pngIccpPayload(profile: Uint8Array, name = 'sRGB'): Uint8Array {
  const compressed = zlibSync(profile, { level: 9 });
  const payload = new Uint8Array(name.length + 2 + compressed.length);
  for (let i = 0; i < name.length; i++) payload[i] = name.charCodeAt(i);
  payload.set(compressed, name.length + 2);
  return payload;
}

// MARK: JPEG

interface JpegMetadata { readonly icc?: Uint8Array | null; readonly exif?: Uint8Array | null }

/** Replaces APP1 Exif / APP2 ICC_PROFILE after the JFIF header with the given payloads. */
export function jpegWithMetadata(bytes: Uint8Array, metadata: JpegMetadata): Uint8Array {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('Invalid JPEG SOI marker');
  const kept: Uint8Array[] = [];
  let offset = 2, app0: Uint8Array | null = null;
  while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
    const marker = bytes[offset + 1]!;
    if (marker < 0xe0 || marker > 0xef) break;
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    const segment = bytes.subarray(offset, offset + 2 + length);
    const exif = marker === 0xe1 && startsWith(bytes, offset + 4, 'Exif\0\0');
    const icc = marker === 0xe2 && startsWith(bytes, offset + 4, 'ICC_PROFILE\0');
    if (marker === 0xe0 && !app0) app0 = segment;
    else if (!exif && !icc) kept.push(segment);
    offset += 2 + length;
  }
  const inserted: Uint8Array[] = [];
  if (metadata.exif) inserted.push(segment(0xe1, concat([latin('Exif\0\0'), metadata.exif])));
  if (metadata.icc) {
    const chunk = 65_519, total = Math.ceil(metadata.icc.length / chunk);
    if (total > 255) throw new Error('The ICC profile is too large for JPEG.');
    for (let index = 0; index < total; index++) {
      const part = metadata.icc.subarray(index * chunk, (index + 1) * chunk);
      inserted.push(segment(0xe2, concat([latin('ICC_PROFILE\0'), new Uint8Array([index + 1, total]), part])));
    }
  }
  return concat([bytes.subarray(0, 2), ...(app0 ? [app0] : []), ...inserted, ...kept, bytes.subarray(offset)]);
}

function segment(marker: number, payload: Uint8Array): Uint8Array {
  if (payload.length + 2 > 0xffff) throw new Error('JPEG metadata segment is too large.');
  const out = new Uint8Array(payload.length + 4);
  out[0] = 0xff; out[1] = marker; out[2] = (payload.length + 2) >> 8; out[3] = (payload.length + 2) & 255;
  out.set(payload, 4);
  return out;
}

/** Reads the EXIF TIFF payload from a JPEG (tests). */
export function jpegExif(bytes: Uint8Array): Uint8Array | null {
  let offset = 2;
  while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
    const marker = bytes[offset + 1]!, length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    if (marker === 0xda) break;
    if (marker === 0xe1 && startsWith(bytes, offset + 4, 'Exif\0\0')) return bytes.slice(offset + 10, offset + 2 + length);
    offset += 2 + length;
  }
  return null;
}

// MARK: WebP

interface RiffChunk { readonly type: string; readonly data: Uint8Array }

function riffChunks(bytes: Uint8Array): RiffChunk[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = Math.min(bytes.length, view.getUint32(4, true) + 8);
  const result: RiffChunk[] = [];
  for (let at = 12; at + 8 <= end;) {
    const size = view.getUint32(at + 4, true);
    if (at + 8 + size > end) throw new Error('Invalid WebP chunk');
    result.push({ type: String.fromCharCode(...bytes.subarray(at, at + 4)), data: bytes.subarray(at + 8, at + 8 + size) });
    at += 8 + size + (size & 1);
  }
  return result;
}

/** Rebuilds a WebP as VP8X with optional ICCP and EXIF chunks (WebP container spec order). */
export function webpWithMetadata(encoded: Uint8Array, width: number, height: number, hasAlpha: boolean,
  metadata: { readonly icc?: Uint8Array | null; readonly exif?: Uint8Array | null }): Uint8Array {
  if (!metadata.icc && !metadata.exif) return encoded;
  const chunks = riffChunks(encoded);
  const existing = chunks.find((chunk) => chunk.type === 'VP8X');
  const vp8x = existing ? existing.data.slice() : new Uint8Array(10);
  if (!existing) {
    writeU24(vp8x, 4, width - 1); writeU24(vp8x, 7, height - 1);
    if (hasAlpha) vp8x[0] = vp8x[0]! | 0x10;
  }
  if (metadata.icc) vp8x[0] = vp8x[0]! | 0x20;
  if (metadata.exif) vp8x[0] = vp8x[0]! | 0x08;
  const parts = [riff('VP8X', vp8x)];
  if (metadata.icc) parts.push(riff('ICCP', metadata.icc));
  for (const chunk of chunks) if (!['VP8X', 'ICCP', 'EXIF'].includes(chunk.type)) parts.push(riff(chunk.type, chunk.data));
  if (metadata.exif) parts.push(riff('EXIF', metadata.exif));
  const body = concat(parts);
  const out = new Uint8Array(12 + body.length);
  out.set(latin('RIFF'), 0); new DataView(out.buffer).setUint32(4, body.length + 4, true); out.set(latin('WEBP'), 8);
  out.set(body, 12);
  return out;
}

export function webpChunk(bytes: Uint8Array, type: string): Uint8Array | null {
  return riffChunks(bytes).find((chunk) => chunk.type === type)?.data.slice() ?? null;
}

function riff(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length + (payload.length & 1));
  out.set(latin(type), 0); new DataView(out.buffer).setUint32(4, payload.length, true); out.set(payload, 8);
  return out;
}

// MARK: Bytes

function writeU24(bytes: Uint8Array, at: number, value: number): void {
  bytes[at] = value & 255; bytes[at + 1] = (value >>> 8) & 255; bytes[at + 2] = (value >>> 16) & 255;
}
function latin(value: string): Uint8Array { return Uint8Array.from(value, (c) => c.charCodeAt(0)); }
function startsWith(bytes: Uint8Array, at: number, value: string): boolean {
  for (let i = 0; i < value.length; i++) if (bytes[at + i] !== value.charCodeAt(i)) return false;
  return true;
}
export function concat(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}
