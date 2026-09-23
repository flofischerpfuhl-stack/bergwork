/**
 * Image import (IO/ImageImporter.swift): JPEG, PNG, HEIC and TIFF; 30,000 px per side and the
 * remaining 100-megapixel budget checked before decoding; EXIF orientation applied; pixels
 * normalised to straight-alpha sRGB RGBA8.
 *
 * PNGs without colour-profile chunks go through the lossless decoder in png.ts (canvas decoding
 * premultiplies and loses precision in semi-transparent pixels). Everything else uses the browser's
 * colour-managed decoder. TIFF uses the dependency-free decoder in tiff.ts; HEIC uses the
 * browser codec where available and otherwise follows the explicit policy in heic.ts.
 */

import { Raster } from '../core/raster';
import { MAX_SIDE } from '../core/document';
import { decodePng, pngDimensions } from './png';
import { orientedSize, readJpegInfo } from './jpegMeta';
import { sha256Hex } from './sha256';
import { decodeTiff, TiffError, tiffDimensions } from './tiff';
import { decodeHeic, HeicError, heicDimensions, isHeic } from './heic';

export class ImageImportError extends Error {
  readonly code: 'unreadable' | 'unsupported' | 'too-large';
  constructor(code: 'unreadable' | 'unsupported' | 'too-large', message?: string) {
    super(message ?? (code === 'unreadable' ? 'The image could not be read. It may be damaged or unavailable.'
      : code === 'unsupported' ? 'Choose a JPEG, PNG, HEIC, or TIFF image.'
        : 'This import exceeds the current 100-megapixel document budget or 30,000-pixel side limit.'));
    this.code = code;
    this.name = 'ImageImportError';
  }
}

export type ImageKind = 'image/png' | 'image/jpeg' | 'image/heic' | 'image/tiff';

export function sniffImage(bytes: Uint8Array): ImageKind | null {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 4 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 0x2a))) return 'image/tiff';
  if (isHeic(b)) return 'image/heic';
  return null;
}

export function fileBaseName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/** Decodes with the browser (colour managed, EXIF orientation applied). */
export async function browserDecode(bytes: Uint8Array, mime: string): Promise<{ width: number; height: number; channels: 4; data: Uint8Array }> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }), { imageOrientation: 'from-image', premultiplyAlpha: 'none', colorSpaceConversion: 'default' });
  } catch {
    throw new ImageImportError(mime === 'image/heic' || mime === 'image/tiff' ? 'unsupported' : 'unreadable');
  }
  try {
    const { width, height } = bitmap;
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height });
    const context = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!context) throw new ImageImportError('unreadable');
    context.drawImage(bitmap, 0, 0);
    const data = context.getImageData(0, 0, width, height, { colorSpace: 'srgb' }).data;
    return { width, height, channels: 4, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
  } finally { bitmap.close(); }
}

/** Decodes an image file into a raster that remembers its original bytes. */
export async function decodeImageFile(bytes: Uint8Array, remainingPixels: number): Promise<Raster> {
  const kind = sniffImage(bytes);
  if (!kind) throw new ImageImportError('unsupported');
  let width = 0, height = 0;
  try {
    if (kind === 'image/png') ({ width, height } = pngDimensions(bytes));
    else if (kind === 'image/jpeg') ({ width, height } = orientedSize(readJpegInfo(bytes)));
    else if (kind === 'image/tiff') ({ width, height } = tiffDimensions(bytes));
    else ({ width, height } = heicDimensions(bytes));
  } catch (error) {
    if (error instanceof TiffError && error.code === 'dimensions') throw new ImageImportError('too-large');
    throw new ImageImportError('unreadable');
  }
  if (width && height && (width > MAX_SIDE || height > MAX_SIDE || width * height > remainingPixels)) throw new ImageImportError('too-large');
  let pixels: { width: number; height: number; data: Uint8Array };
  if (kind === 'image/png') {
    let png: ReturnType<typeof decodePng>;
    try { png = decodePng(bytes); } catch { throw new ImageImportError('unreadable'); }
    const managed = png.colorInfo.iccp || png.colorInfo.chrm || (png.colorInfo.gama !== null && !png.colorInfo.srgb && Math.abs(png.colorInfo.gama - 45455) > 50);
    if (managed) pixels = await browserDecode(bytes, kind);
    else if (png.channels === 4) pixels = png;
    else {
      const rgba = new Uint8Array(png.width * png.height * 4);
      for (let i = 0; i < png.width * png.height; i++) { const v = png.data[i]!; rgba[i * 4] = v; rgba[i * 4 + 1] = v; rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = 255; }
      pixels = { width: png.width, height: png.height, data: rgba };
    }
  } else if (kind === 'image/tiff') {
    try { pixels = await decodeTiff(bytes); }
    catch (error) {
      if (error instanceof TiffError && error.code === 'dimensions') throw new ImageImportError('too-large');
      if (error instanceof TiffError && error.code === 'unsupported') throw new ImageImportError('unsupported', error.message);
      throw new ImageImportError('unreadable');
    }
  } else if (kind === 'image/heic') {
    try { pixels = await decodeHeic(bytes); }
    catch (error) {
      if (error instanceof HeicError && error.code === 'unsupported') throw new ImageImportError('unsupported', error.message);
      throw new ImageImportError('unreadable');
    }
  } else pixels = await browserDecode(bytes, kind);
  if (pixels.width > MAX_SIDE || pixels.height > MAX_SIDE || pixels.width * pixels.height > remainingPixels) throw new ImageImportError('too-large');
  return Raster.fromPixels(pixels.width, pixels.height, 4, pixels.data, { source: { bytes, mime: kind, sha256: sha256Hex(bytes) } });
}
