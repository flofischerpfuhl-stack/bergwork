import type { ExifOrientation, HostDecodedImage, ImageDecoderHost } from '../platform/imageDecoder';

const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']);
const UNSUPPORTED_MESSAGE = 'This browser cannot decode HEIC. Convert the image to JPEG or PNG and try again.';

export type HeicErrorCode = 'not-heic' | 'unreadable' | 'unsupported';

export class HeicError extends Error {
  readonly code: HeicErrorCode;

  constructor(code: HeicErrorCode, message = code === 'unsupported' ? UNSUPPORTED_MESSAGE : 'Invalid or damaged HEIC image.') {
    super(message);
    this.name = 'HeicError';
    this.code = code;
  }
}

export interface HeicResult { width: number; height: number; data: Uint8Array }
export type HeicDecoder = (bytes: Uint8Array, mime: string) => Promise<HeicResult | null>;

export interface HeicDecodeOptions {
  readonly host?: ImageDecoderHost;
  /** `null` disables the platform decoder; intended for deterministic tests. */
  readonly browserDecoder?: HeicDecoder | null;
  /** Test/replacement hook. Production lazily imports the separate LGPL module. */
  readonly wasmDecoder?: HeicDecoder;
}

interface Box { readonly type: string; readonly content: number; readonly end: number }
interface Property { readonly type: string; readonly width?: number; readonly height?: number; readonly rotation?: number }

/** Recognises HEIC/HEIF major and compatible `ftyp` brands without relying on a filename. */
export function isHeic(bytes: Uint8Array): boolean {
  if (bytes.length < 16 || ascii(bytes, 4) !== 'ftyp') return false;
  const size = u32(bytes, 0);
  if (size < 16 || size > bytes.length) return false;
  if (HEIF_BRANDS.has(ascii(bytes, 8))) return true;
  for (let at = 16; at + 4 <= size; at += 4) if (HEIF_BRANDS.has(ascii(bytes, at))) return true;
  return false;
}

/**
 * Reads the primary item's `ispe` and swaps it for an odd `irot`, so the upstream
 * ImageImporter.decode size gate runs before a codec allocates the image.
 */
export function heicDimensions(bytes: Uint8Array): { width: number; height: number } {
  if (!isHeic(bytes)) throw new HeicError('not-heic');
  const metadata = primaryProperties(bytes);
  if (metadata) {
    const ispe = metadata.find((property) => property.type === 'ispe');
    if (ispe?.width && ispe.height) {
      const rotated = metadata.some((property) => property.type === 'irot' && (property.rotation! & 1) !== 0);
      return rotated ? { width: ispe.height, height: ispe.width } : { width: ispe.width, height: ispe.height };
    }
  }
  // Some simple HEIF writers omit property associations. Retain the conservative legacy fallback.
  const dimensions = findFirstIspe(bytes, 0, bytes.length, 0);
  if (!dimensions || dimensions.width < 1 || dimensions.height < 1) throw new HeicError('unreadable');
  return dimensions;
}

/** Browser-native → host → explicitly enabled LGPL WASM decoder. */
export async function decodeHeic(bytes: Uint8Array, options: HeicDecodeOptions = {}): Promise<HeicResult> {
  if (!isHeic(bytes)) throw new HeicError('not-heic');
  const browser = options.browserDecoder === undefined ? decodeNative : options.browserDecoder;
  const native = browser ? await attempt(() => browser(bytes, 'image/heic')) : null;
  if (native) return checked(native);

  const host = options.host?.decodeImage
    ? await attempt(() => options.host!.decodeImage!(bytes, 'image/heic'))
    : null;
  if (host) return checkedHost(host);

  if (options.host?.heicDecoder === 'lgpl-wasm') {
    const decoder = options.wasmDecoder ?? await loadWasmDecoder();
    try {
      const decoded = await decoder(bytes, 'image/heic');
      if (decoded) return checked(decoded);
    } catch (error) {
      if (error instanceof HeicError && error.code === 'unreadable') throw error;
    }
  }
  throw new HeicError('unsupported');
}

async function decodeNative(bytes: Uint8Array): Promise<HeicResult | null> {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') return null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/heic' }), {
      imageOrientation: 'from-image', premultiplyAlpha: 'none', colorSpaceConversion: 'default',
    });
  } catch { return null; }
  try {
    if (bitmap.width < 1 || bitmap.height < 1) return null;
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
    if (!context) return null;
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height, { colorSpace: 'srgb' }).data;
    return { width: bitmap.width, height: bitmap.height, data: new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength).slice() };
  } finally { bitmap.close(); }
}

async function loadWasmDecoder(): Promise<HeicDecoder> {
  try {
    // This is the only production reference to the LGPL adapter. It is never evaluated by the default path.
    const module = await import('../wasm/heif/decoder');
    return (bytes) => module.decodeHeifWasm(bytes);
  } catch { throw new HeicError('unsupported'); }
}

async function attempt<T>(decode: () => Promise<T | null>): Promise<T | null> {
  try { return await decode(); } catch { return null; }
}

function checked(result: HeicResult): HeicResult {
  if (!validDimensions(result.width, result.height) || result.data.byteLength !== result.width * result.height * 4) {
    throw new HeicError('unreadable');
  }
  return result;
}

function checkedHost(result: HostDecodedImage): HeicResult {
  if (!validDimensions(result.width, result.height) || result.rgba.byteLength !== result.width * result.height * 4) {
    throw new HeicError('unreadable');
  }
  return orientRgba(result.rgba, result.width, result.height, result.orientation ?? 1);
}

/** ImageImporter.swift applies kCGImagePropertyOrientation before producing RGBA8. */
export function orientRgba(data: Uint8Array, width: number, height: number, orientation: ExifOrientation): HeicResult {
  if (orientation === 1) return { width, height, data };
  const swapped = orientation >= 5;
  const outWidth = swapped ? height : width;
  const outHeight = swapped ? width : height;
  const out = new Uint8Array(data.byteLength);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let dx: number, dy: number;
      switch (orientation) {
        case 2: dx = width - 1 - x; dy = y; break;
        case 3: dx = width - 1 - x; dy = height - 1 - y; break;
        case 4: dx = x; dy = height - 1 - y; break;
        case 5: dx = y; dy = x; break;
        case 6: dx = height - 1 - y; dy = x; break;
        case 7: dx = height - 1 - y; dy = width - 1 - x; break;
        case 8: dx = y; dy = width - 1 - x; break;
        default: dx = x; dy = y;
      }
      const source = (y * width + x) * 4;
      const target = (dy * outWidth + dx) * 4;
      out[target] = data[source]!;
      out[target + 1] = data[source + 1]!;
      out[target + 2] = data[source + 2]!;
      out[target + 3] = data[source + 3]!;
    }
  }
  return { width: outWidth, height: outHeight, data: out };
}

function primaryProperties(bytes: Uint8Array): Property[] | null {
  const meta = childBoxes(bytes, 0, bytes.length).find((box) => box.type === 'meta');
  if (!meta || meta.content + 4 > meta.end) return null;
  const children = childBoxes(bytes, meta.content + 4, meta.end);
  const pitm = children.find((box) => box.type === 'pitm');
  const iprp = children.find((box) => box.type === 'iprp');
  if (!pitm || !iprp || pitm.content + 6 > pitm.end) return null;
  const version = bytes[pitm.content]!;
  if (version !== 0 && pitm.content + 8 > pitm.end) return null;
  const primaryId = version === 0 ? u16(bytes, pitm.content + 4) : u32(bytes, pitm.content + 4);
  const propertyBoxes: Box[] = [];
  let association: number[] | null = null;
  for (const child of childBoxes(bytes, iprp.content, iprp.end)) {
    if (child.type === 'ipco') propertyBoxes.push(...childBoxes(bytes, child.content, child.end));
    else if (child.type === 'ipma') association = readAssociation(bytes, child, primaryId) ?? association;
  }
  if (!association) return null;
  const result: Property[] = [];
  for (const index of association) {
    const property = propertyBoxes[index - 1];
    if (!property) continue;
    if (property.type === 'ispe' && property.content + 12 <= property.end) {
      result.push({ type: 'ispe', width: u32(bytes, property.content + 4), height: u32(bytes, property.content + 8) });
    } else if (property.type === 'irot' && property.content < property.end) {
      result.push({ type: 'irot', rotation: bytes[property.content]! & 3 });
    } else if (property.type === 'imir') result.push({ type: 'imir' });
  }
  return result;
}

function readAssociation(bytes: Uint8Array, box: Box, primaryId: number): number[] | null {
  if (box.content + 8 > box.end) return null;
  const version = bytes[box.content]!;
  const flags = u24(bytes, box.content + 1);
  let at = box.content + 4;
  const count = u32(bytes, at); at += 4;
  for (let entry = 0; entry < count; entry++) {
    const idBytes = version < 1 ? 2 : 4;
    if (at + idBytes + 1 > box.end) throw new HeicError('unreadable');
    const id = idBytes === 2 ? u16(bytes, at) : u32(bytes, at); at += idBytes;
    const associations = bytes[at++]!;
    const indices: number[] = [];
    const wide = (flags & 1) !== 0;
    for (let i = 0; i < associations; i++) {
      if (at + (wide ? 2 : 1) > box.end) throw new HeicError('unreadable');
      const value = wide ? u16(bytes, at) : bytes[at]!;
      at += wide ? 2 : 1;
      const index = value & (wide ? 0x7fff : 0x7f);
      if (index) indices.push(index);
    }
    if (id === primaryId) return indices;
  }
  return null;
}

function childBoxes(bytes: Uint8Array, start: number, end: number): Box[] {
  const boxes: Box[] = [];
  let at = start;
  while (at + 8 <= end) {
    const size32 = u32(bytes, at), type = ascii(bytes, at + 4);
    let header = 8, size = size32;
    if (size32 === 1) {
      if (at + 16 > end) throw new HeicError('unreadable');
      size = u32(bytes, at + 8) * 0x1_0000_0000 + u32(bytes, at + 12); header = 16;
    } else if (size32 === 0) size = end - at;
    if (!Number.isSafeInteger(size) || size < header || size > end - at) throw new HeicError('unreadable');
    boxes.push({ type, content: at + header, end: at + size });
    at += size;
  }
  return boxes;
}

function findFirstIspe(bytes: Uint8Array, start: number, end: number, depth: number): { width: number; height: number } | null {
  if (depth > 8) return null;
  for (const box of childBoxes(bytes, start, end)) {
    if (box.type === 'ispe') {
      if (box.content + 12 > box.end) throw new HeicError('unreadable');
      return { width: u32(bytes, box.content + 4), height: u32(bytes, box.content + 8) };
    }
    const container = box.type === 'meta' || box.type === 'iprp' || box.type === 'ipco' || box.type === 'moov'
      || box.type === 'trak' || box.type === 'mdia' || box.type === 'minf' || box.type === 'stbl';
    if (container) {
      const found = findFirstIspe(bytes, box.content + (box.type === 'meta' ? 4 : 0), box.end, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function validDimensions(width: number, height: number): boolean {
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0
    && Number.isSafeInteger(width * height * 4);
}

function u16(bytes: Uint8Array, at: number): number { return (bytes[at]! << 8) | bytes[at + 1]!; }
function u24(bytes: Uint8Array, at: number): number { return (bytes[at]! << 16) | (bytes[at + 1]! << 8) | bytes[at + 2]!; }
function u32(bytes: Uint8Array, at: number): number {
  return ((bytes[at]! * 0x1000000) + ((bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!)) >>> 0;
}
function ascii(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
}
