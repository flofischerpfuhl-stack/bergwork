/**
 * Image import (IO/ImageImporter.swift): JPEG, PNG, HEIC and TIFF; 30,000 px per side and the
 * remaining 100-megapixel budget checked before decoding; EXIF orientation applied; pixels
 * normalised to straight-alpha sRGB RGBA8.
 *
 * PNG, TIFF, and tagged JPEG profiles are converted explicitly through Little CMS so workers and
 * browsers agree, including conversion before 16-bit quantization. Untagged RGB/gray JPEG uses the
 * browser codec; four-component JPEG is decoded through libjpeg-turbo before its CMYK transform.
 * HEIC tries the browser codec, an optional host codec, then the explicitly enabled LGPL module in heic.ts.
 */

import { Raster } from '../core/raster';
import { MAX_SIDE } from '../core/document';
import { decodePng, decodePngColorSamples, pngDimensions } from './png';
import { decodeJpegSamples } from './jpeg';
import { orientedSize, readJpegComponentCount, readJpegIccProfile, readJpegInfo, type JpegInfo } from './jpegMeta';
import { sha256Hex } from './sha256';
import { decodeTiff, TiffError, tiffDimensions } from './tiff';
import { decodeHeic, HeicError, heicDimensions, isHeic, orientRgba, type HeicDecodeOptions } from './heic';
import { IccError, loadLittleCms, type Chromaticities } from '../wasm/lcms';

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

/** Decodes with the browser (colour managed, EXIF orientation applied) into an sRGB canvas. */
export async function browserDecode(bytes: Uint8Array, mime: string): Promise<{ width: number; height: number; channels: 4; data: Uint8Array }> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }), { imageOrientation: 'from-image', premultiplyAlpha: 'none', colorSpaceConversion: 'default' });
  } catch {
    throw new ImageImportError(mime === 'image/heic' || mime === 'image/tiff' ? 'unsupported' : 'unreadable');
  }
  try {
    const { width, height } = bitmap;
    if (typeof OffscreenCanvas === 'undefined') throw new ImageImportError('unsupported', 'This browser cannot read decoded image pixels.');
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
    if (!context) throw new ImageImportError('unreadable');
    context.drawImage(bitmap, 0, 0);
    const data = context.getImageData(0, 0, width, height, { colorSpace: 'srgb' }).data;
    return { width, height, channels: 4, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
  } finally { bitmap.close(); }
}

const SRGB_CHROMATICITIES: Chromaticities = {
  white: [0.3127, 0.3290], red: [0.64, 0.33], green: [0.30, 0.60], blue: [0.15, 0.06],
};

async function decodeManagedPng(bytes: Uint8Array): Promise<{ width: number; height: number; data: Uint8Array }> {
  const png = decodePngColorSamples(bytes), lcms = await loadLittleCms();
  let profile = png.iccProfile;
  if (!profile) {
    const gamma = png.gamma === null ? 2.2 : 1 / png.gamma;
    profile = png.model === 'gray'
      ? lcms.createGrayProfile(png.chromaticities?.white ?? SRGB_CHROMATICITIES.white, gamma)
      : lcms.createRgbProfile(png.chromaticities ?? SRGB_CHROMATICITIES, gamma, png.gamma === null ? 'srgb' : 'gamma');
  }
  return { width: png.width, height: png.height,
    data: lcms.transform(profile, png.colors, png.model, png.bits, png.alpha) };
}

async function decodeJpeg(bytes: Uint8Array, info: JpegInfo): Promise<{ width: number; height: number; data: Uint8Array }> {
  const embedded = readJpegIccProfile(bytes);
  const components = readJpegComponentCount(bytes);
  if (components !== 4 && !embedded) return browserDecode(bytes, 'image/jpeg');
  const samples = await decodeJpegSamples(bytes);
  const lcms = await loadLittleCms();
  let data: Uint8Array;
  try {
    // ImageImporter.swift renders through sRGB. ImageIO supplies a generic CMYK space to untagged
    // files; our deterministic browser equivalent is Little CMS's subtractive-sRGB CMYK profile.
    data = lcms.transform(embedded ?? lcms.createCmykProfile(), samples.data, samples.model, 8);
  } catch (error) {
    if (!(error instanceof IccError)) throw error;
    // ImageIO ignores an unusable embedded profile. Four-component JPEGs still need a CMYK
    // interpretation; tagged RGB/gray can safely fall back to the platform decoder.
    if (components !== 4) return browserDecode(bytes, 'image/jpeg');
    data = lcms.transform(lcms.createCmykProfile(), samples.data, 'cmyk', 8);
  }
  return orientRgba(data, samples.width, samples.height, info.orientation);
}

/** Decodes an image file into a raster that remembers its original bytes. */
export async function decodeImageFile(bytes: Uint8Array, remainingPixels: number, options: HeicDecodeOptions = {}): Promise<Raster> {
  const kind = sniffImage(bytes);
  if (!kind) throw new ImageImportError('unsupported');
  let width = 0, height = 0;
  let jpegInfo: JpegInfo | null = null;
  try {
    if (kind === 'image/png') ({ width, height } = pngDimensions(bytes));
    else if (kind === 'image/jpeg') {
      jpegInfo = readJpegInfo(bytes);
      ({ width, height } = orientedSize(jpegInfo));
    }
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
    const managed = png.colorInfo.iccp || png.colorInfo.chrm
      || (png.colorInfo.gama !== null && !png.colorInfo.srgb && Math.abs(png.colorInfo.gama - 0.45455) > 0.0005);
    // ImageImporter.swift renders into an sRGB CIContext. Do the equivalent explicitly so
    // workers and browsers agree, and so 16-bit sources reach ColorSync/lcms before RGBA8 quantization.
    if (managed) {
      try { pixels = await decodeManagedPng(bytes); }
      catch (error) {
        if (!(error instanceof IccError) && !(error instanceof RangeError)) throw error;
        pixels = png.channels === 4 ? png : grayToRgba(png.data, png.width, png.height);
      }
    }
    else if (png.channels === 4) pixels = png;
    else {
      pixels = grayToRgba(png.data, png.width, png.height);
    }
  } else if (kind === 'image/tiff') {
    try { pixels = await decodeTiff(bytes); }
    catch (error) {
      if (error instanceof TiffError && error.code === 'dimensions') throw new ImageImportError('too-large');
      if (error instanceof TiffError && error.code === 'unsupported') throw new ImageImportError('unsupported', error.message);
      throw new ImageImportError('unreadable');
    }
  } else if (kind === 'image/heic') {
    try { pixels = await decodeHeic(bytes, options); }
    catch (error) {
      if (error instanceof HeicError && error.code === 'unsupported') throw new ImageImportError('unsupported', error.message);
      throw new ImageImportError('unreadable');
    }
  } else {
    try { pixels = await decodeJpeg(bytes, jpegInfo!); }
    catch (error) {
      if (error instanceof ImageImportError) throw error;
      throw new ImageImportError('unreadable');
    }
  }
  if (pixels.width > MAX_SIDE || pixels.height > MAX_SIDE || pixels.width * pixels.height > remainingPixels) throw new ImageImportError('too-large');
  return Raster.fromPixels(pixels.width, pixels.height, 4, pixels.data, { source: { bytes, mime: kind, sha256: sha256Hex(bytes) } });
}

function grayToRgba(gray: Uint8Array, width: number, height: number): { width: number; height: number; data: Uint8Array } {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const value = gray[i]!, target = i * 4;
    rgba[target] = value; rgba[target + 1] = value; rgba[target + 2] = value; rgba[target + 3] = 255;
  }
  return { width, height, data: rgba };
}
