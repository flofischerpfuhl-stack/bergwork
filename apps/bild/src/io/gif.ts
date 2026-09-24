import { MAX_SIDE } from '../core/document';

export class GifError extends Error {
  readonly code: 'not-gif' | 'unreadable' | 'dimensions';
  constructor(code: GifError['code'], message = 'Invalid or damaged GIF image.') {
    super(message); this.name = 'GifError'; this.code = code;
  }
}

export function isGif(bytes: Uint8Array): boolean {
  if (bytes.length < 10) return false;
  const signature = String.fromCharCode(...bytes.subarray(0, 6));
  return signature === 'GIF87a' || signature === 'GIF89a';
}

/** GIF logical-screen size, read before native decoding allocates the first frame. */
export function gifDimensions(bytes: Uint8Array): { width: number; height: number } {
  if (!isGif(bytes)) throw new GifError('not-gif');
  const width = u16le(bytes, 6), height = u16le(bytes, 8);
  validateDimensions(width, height);
  if (bytes.length < 13) throw new GifError('unreadable');
  let at = 13;
  if ((bytes[10]! & 0x80) !== 0) at += 3 * (1 << ((bytes[10]! & 7) + 1));
  while (at < bytes.length) {
    const marker = bytes[at++]!;
    if (marker === 0x2c) {
      if (at + 9 > bytes.length) throw new GifError('unreadable');
      const left = u16le(bytes, at), top = u16le(bytes, at + 2);
      const frameWidth = u16le(bytes, at + 4), frameHeight = u16le(bytes, at + 6);
      validateDimensions(frameWidth, frameHeight);
      if (left + frameWidth > width || top + frameHeight > height) throw new GifError('unreadable');
      return { width, height };
    }
    if (marker === 0x3b) throw new GifError('unreadable');
    if (marker !== 0x21 || at >= bytes.length) throw new GifError('unreadable');
    at++; // extension label
    while (true) {
      if (at >= bytes.length) throw new GifError('unreadable');
      const length = bytes[at++]!;
      if (length === 0) break;
      if (length > bytes.length - at) throw new GifError('unreadable');
      at += length;
    }
  }
  throw new GifError('unreadable');
}

function validateDimensions(width: number, height: number): void {
  if (width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE || width * height > 100_000_000) throw new GifError('dimensions');
}
function u16le(bytes: Uint8Array, at: number): number { return bytes[at]! | (bytes[at + 1]! << 8); }
