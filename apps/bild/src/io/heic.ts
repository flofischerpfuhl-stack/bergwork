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

/** Recognises HEIC/HEIF major and compatible `ftyp` brands without relying on a filename. */
export function isHeic(bytes: Uint8Array): boolean {
  if (bytes.length < 16 || ascii(bytes, 4) !== 'ftyp') return false;
  const size = u32(bytes, 0);
  if (size < 16 || size > bytes.length) return false;
  for (let at = 8; at + 4 <= size; at += 4) if (HEIF_BRANDS.has(ascii(bytes, at))) return true;
  return false;
}

/** Reads the first spatial-extents property, allowing import limits to run before native decode. */
export function heicDimensions(bytes: Uint8Array): { width: number; height: number } {
  if (!isHeic(bytes)) throw new HeicError('not-heic');
  const dimensions = findIspe(bytes, 0, bytes.length, 0);
  if (!dimensions || dimensions.width < 1 || dimensions.height < 1) throw new HeicError('unreadable');
  return dimensions;
}

/**
 * HEVC patent/licensing constraints rule out bundling libheif/libde265. Use the browser codec
 * when present (notably Safari), and otherwise provide an actionable, stable policy error.
 */
export async function decodeHeic(bytes: Uint8Array): Promise<HeicResult> {
  if (!isHeic(bytes)) throw new HeicError('not-heic');
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') throw new HeicError('unsupported');
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/heic' }), {
      imageOrientation: 'from-image', premultiplyAlpha: 'none', colorSpaceConversion: 'default',
    });
  } catch {
    throw new HeicError('unsupported');
  }
  try {
    if (bitmap.width < 1 || bitmap.height < 1) throw new HeicError('unreadable');
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
    if (!context) throw new HeicError('unsupported');
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height, { colorSpace: 'srgb' }).data;
    return { width: bitmap.width, height: bitmap.height, data: new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength).slice() };
  } finally { bitmap.close(); }
}

function findIspe(bytes: Uint8Array, start: number, end: number, depth: number): { width: number; height: number } | null {
  if (depth > 8) return null;
  let at = start;
  while (at + 8 <= end) {
    const size32 = u32(bytes, at), type = ascii(bytes, at + 4);
    let header = 8, size = size32;
    if (size32 === 1) {
      if (at + 16 > end) throw new HeicError('unreadable');
      const high = u32(bytes, at + 8), low = u32(bytes, at + 12);
      size = high * 0x1_0000_0000 + low; header = 16;
    } else if (size32 === 0) size = end - at;
    if (!Number.isSafeInteger(size) || size < header || size > end - at) throw new HeicError('unreadable');
    if (type === 'ispe') {
      if (size < header + 12) throw new HeicError('unreadable');
      return { width: u32(bytes, at + header + 4), height: u32(bytes, at + header + 8) };
    }
    const containers = type === 'meta' || type === 'iprp' || type === 'ipco' || type === 'moov' || type === 'trak' || type === 'mdia' || type === 'minf' || type === 'stbl';
    if (containers) {
      const fullBox = type === 'meta' ? 4 : 0;
      if (size < header + fullBox) throw new HeicError('unreadable');
      const found = findIspe(bytes, at + header + fullBox, at + size, depth + 1);
      if (found) return found;
    }
    at += size;
  }
  return null;
}

function u32(bytes: Uint8Array, at: number): number {
  return ((bytes[at]! * 0x1000000) + ((bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!)) >>> 0;
}

function ascii(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
}
