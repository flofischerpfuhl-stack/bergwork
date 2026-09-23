/**
 * Flattened exports (IO/ImageExporter.swift, UI/JPEGExportSheet.swift): PNG with the document's
 * resolution as pHYs; JPEG flattened onto a matte colour (white by default) with the resolution as
 * JFIF density. Export is a derivative and never marks the project saved.
 */

import { encodePng } from './png';
import { withJpegDensity } from './jpegMeta';

export interface JpegOptions { quality: number; red: number; green: number; blue: number }
export const DEFAULT_JPEG: JpegOptions = { quality: 0.85, red: 1, green: 1, blue: 1 };

export function pngBlob(rgba: Uint8Array, width: number, height: number, resolution: number): Blob {
  return new Blob([encodePng(rgba, width, height, 4, { dpi: resolution }) as BlobPart], { type: 'image/png' });
}

/** Composites straight-alpha pixels over the matte, as the JPEG export context does. */
export function flattenOnMatte(rgba: Uint8Array, options: JpegOptions): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(rgba.length);
  const matte = [options.red * 255, options.green * 255, options.blue * 255];
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3]! / 255;
    out[i] = rgba[i]! * a + matte[0]! * (1 - a);
    out[i + 1] = rgba[i + 1]! * a + matte[1]! * (1 - a);
    out[i + 2] = rgba[i + 2]! * a + matte[2]! * (1 - a);
    out[i + 3] = 255;
  }
  return out;
}

export async function jpegBlob(rgba: Uint8Array, width: number, height: number, resolution: number, options: JpegOptions): Promise<Blob> {
  const flat = flattenOnMatte(rgba, options);
  const quality = Math.min(1, Math.max(0, options.quality));
  let blob: Blob;
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d')!.putImageData(new ImageData(flat, width, height), 0, 0);
    blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  } else {
    const canvas = Object.assign(document.createElement('canvas'), { width, height });
    canvas.getContext('2d')!.putImageData(new ImageData(flat, width, height), 0, 0);
    blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The image could not be encoded.'))), 'image/jpeg', quality));
  }
  const bytes = withJpegDensity(new Uint8Array(await blob.arrayBuffer()), resolution);
  return new Blob([bytes as BlobPart], { type: 'image/jpeg' });
}
