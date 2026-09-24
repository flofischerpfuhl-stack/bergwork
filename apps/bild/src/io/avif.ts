import { MAX_SIDE } from '../core/document';
import { orientRgba } from './heic';
import { IccError, loadLittleCms } from '../wasm/lcms';

const AVIF_BRANDS = new Set(['avif', 'avis']);

export class AvifError extends Error {
  readonly code: 'not-avif' | 'unreadable' | 'dimensions' | 'option';
  constructor(code: AvifError['code'], message = 'Invalid or damaged AVIF image.') {
    super(message); this.name = 'AvifError'; this.code = code;
  }
}

export interface AvifResult { readonly width: number; readonly height: number; readonly data: Uint8Array }
export interface AvifEncodeOptions {
  readonly quality?: number;
  readonly alphaQuality?: number;
  readonly speed?: number;
  /** Optional RGB input profile retained for a later deterministic import/export colour path. */
  readonly iccProfile?: Uint8Array;
}

export function isAvif(bytes: Uint8Array): boolean {
  if (bytes.length < 16 || ascii(bytes, 4) !== 'ftyp') return false;
  const size = u32(bytes, 0);
  if (size < 16 || size > bytes.length) return false;
  if (AVIF_BRANDS.has(ascii(bytes, 8))) return true;
  for (let at = 16; at + 4 <= size; at += 4) if (AVIF_BRANDS.has(ascii(bytes, at))) return true;
  return false;
}

/** Reads the primary AVIF item's ispe/irot association before loading a decoder. */
export function avifDimensions(bytes: Uint8Array): { width: number; height: number } {
  if (!isAvif(bytes)) throw new AvifError('not-avif');
  const properties = primaryProperties(bytes);
  const size = properties?.find((property) => property.type === 'ispe');
  if (!size?.width || !size.height) throw new AvifError('unreadable');
  const rotated = properties!.some((property) => property.type === 'irot' && (property.value! & 1) !== 0);
  const width = rotated ? size.height : size.width, height = rotated ? size.width : size.height;
  validateDimensions(width, height);
  return { width, height };
}

export function avifHasIccProfile(bytes: Uint8Array): boolean {
  if (!isAvif(bytes)) throw new AvifError('not-avif');
  const meta = boxes(bytes, 0, bytes.length).find((box) => box.type === 'meta');
  if (!meta || meta.content + 4 > meta.end) return false;
  const iprp = boxes(bytes, meta.content + 4, meta.end).find((box) => box.type === 'iprp');
  const ipco = iprp ? boxes(bytes, iprp.content, iprp.end).find((box) => box.type === 'ipco') : undefined;
  if (!ipco) return false;
  return boxes(bytes, ipco.content, ipco.end).some((box) => box.type === 'colr' && box.content + 4 <= box.end
    && (ascii(bytes, box.content) === 'prof' || ascii(bytes, box.content) === 'rICC'));
}

/** Decodes ICC-tagged AVIF through libavif/dav1d, then converts its RGB samples through Little CMS. */
export async function decodeManagedAvif(bytes: Uint8Array): Promise<AvifResult> {
  const { decodeAvifWasm } = await import('../wasm/avif');
  const decoded = await decodeAvifWasm(bytes);
  let data = decoded.data;
  if (decoded.iccProfile) {
    const pixels = decoded.width * decoded.height, colors = new Uint8Array(pixels * 3), alpha = new Uint8Array(pixels);
    for (let source = 0, pixel = 0, target = 0; pixel < pixels; pixel++, source += 4, target += 3) {
      colors[target] = data[source]!; colors[target + 1] = data[source + 1]!; colors[target + 2] = data[source + 2]!;
      alpha[pixel] = data[source + 3]!;
    }
    try { data = (await loadLittleCms()).transform(decoded.iccProfile, colors, 'rgb', 8, alpha); }
    catch (error) {
      // ImageImporter.swift/ImageIO ignores an unusable embedded profile and keeps decoded samples.
      if (!(error instanceof IccError)) throw error;
    }
  }
  const oriented = orientRgba(data, decoded.width, decoded.height,
    (decoded.orientation >= 1 && decoded.orientation <= 8 ? decoded.orientation : 1) as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8);
  return oriented;
}

/** Lazy libavif/libaom encoder. RGBA alpha is retained; quality values use a 0…1 scale. */
export async function encodeAvif(data: Uint8Array, width: number, height: number,
  options: AvifEncodeOptions = {}): Promise<Uint8Array> {
  validateDimensions(width, height);
  if (data.byteLength !== width * height * 4) throw new AvifError('option', 'AVIF pixels must be straight-alpha RGBA8.');
  const quality = fraction(options.quality ?? 0.75, 'quality'), alpha = fraction(options.alphaQuality ?? 1, 'alphaQuality');
  const speed = options.speed ?? 6;
  if (!Number.isInteger(speed) || speed < 0 || speed > 10) throw new AvifError('option', 'AVIF speed must be an integer from 0 to 10.');
  if (options.iccProfile?.byteLength === 0) throw new AvifError('option', 'AVIF ICC profile must not be empty.');
  const { encodeAvifWasm } = await import('../wasm/avif');
  return encodeAvifWasm(data, width, height, Math.round(quality * 100), Math.round(alpha * 100), speed, options.iccProfile ?? null);
}

interface Box { readonly type: string; readonly content: number; readonly end: number }
interface Property { readonly type: 'ispe' | 'irot'; readonly width?: number; readonly height?: number; readonly value?: number }
function primaryProperties(bytes: Uint8Array): Property[] | null {
  const meta = boxes(bytes, 0, bytes.length).find((box) => box.type === 'meta');
  if (!meta || meta.content + 4 > meta.end) return null;
  const children = boxes(bytes, meta.content + 4, meta.end), pitm = children.find((box) => box.type === 'pitm');
  const iprp = children.find((box) => box.type === 'iprp');
  if (!pitm || !iprp || pitm.content + 6 > pitm.end) return null;
  const version = bytes[pitm.content]!, idBytes = version === 0 ? 2 : 4;
  if (version > 1 || pitm.content + 4 + idBytes > pitm.end) return null;
  const primary = idBytes === 2 ? u16(bytes, pitm.content + 4) : u32(bytes, pitm.content + 4);
  let properties: Box[] = [], association: number[] | null = null;
  for (const child of boxes(bytes, iprp.content, iprp.end)) {
    if (child.type === 'ipco') properties = boxes(bytes, child.content, child.end);
    else if (child.type === 'ipma') association = itemAssociation(bytes, child, primary);
  }
  if (!association) return null;
  const result: Property[] = [];
  for (const index of association) {
    const property = properties[index - 1];
    if (property?.type === 'ispe' && property.content + 12 <= property.end) {
      result.push({ type: 'ispe', width: u32(bytes, property.content + 4), height: u32(bytes, property.content + 8) });
    } else if (property?.type === 'irot' && property.content < property.end) result.push({ type: 'irot', value: bytes[property.content]! & 3 });
  }
  return result;
}
function itemAssociation(bytes: Uint8Array, box: Box, wanted: number): number[] | null {
  if (box.content + 8 > box.end) return null;
  const version = bytes[box.content]!, wide = (u24(bytes, box.content + 1) & 1) !== 0;
  let at = box.content + 4; const count = u32(bytes, at); at += 4;
  for (let entry = 0; entry < count; entry++) {
    const idBytes = version < 1 ? 2 : 4;
    if (at + idBytes + 1 > box.end) throw new AvifError('unreadable');
    const id = idBytes === 2 ? u16(bytes, at) : u32(bytes, at); at += idBytes;
    const length = bytes[at++]!, indices: number[] = [];
    for (let i = 0; i < length; i++) {
      const bytesPer = wide ? 2 : 1;
      if (at + bytesPer > box.end) throw new AvifError('unreadable');
      const value = wide ? u16(bytes, at) : bytes[at]!; at += bytesPer;
      const index = value & (wide ? 0x7fff : 0x7f); if (index) indices.push(index);
    }
    if (id === wanted) return indices;
  }
  return null;
}
function boxes(bytes: Uint8Array, start: number, end: number): Box[] {
  const result: Box[] = [];
  for (let at = start; at + 8 <= end;) {
    const size32 = u32(bytes, at), type = ascii(bytes, at + 4); let header = 8, size = size32;
    if (size32 === 1) { if (at + 16 > end) throw new AvifError('unreadable'); size = u32(bytes, at + 8) * 0x1_0000_0000 + u32(bytes, at + 12); header = 16; }
    else if (size32 === 0) size = end - at;
    if (!Number.isSafeInteger(size) || size < header || size > end - at) throw new AvifError('unreadable');
    result.push({ type, content: at + header, end: at + size }); at += size;
  }
  return result;
}
function validateDimensions(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE
    || width * height > 100_000_000) throw new AvifError('dimensions');
}
function fraction(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new AvifError('option', `AVIF ${name} must be between 0 and 1.`); return value;
}
function ascii(bytes: Uint8Array, at: number): string { return String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!); }
function u16(bytes: Uint8Array, at: number): number { return (bytes[at]! << 8) | bytes[at + 1]!; }
function u24(bytes: Uint8Array, at: number): number { return (bytes[at]! << 16) | (bytes[at + 1]! << 8) | bytes[at + 2]!; }
function u32(bytes: Uint8Array, at: number): number { return ((bytes[at]! * 0x1000000) + (bytes[at + 1]! << 16) + (bytes[at + 2]! << 8) + bytes[at + 3]!) >>> 0; }
