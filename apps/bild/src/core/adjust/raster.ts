/** Destructive pixel adjustments and alpha/selection-weighted histograms. */
import type { LayerAdjustment } from '../document';
import { apply, pixelToDocument, type LayerTransform } from '../geometry';
import { Raster } from '../raster';
import type { DocumentSelection } from '../selection';
import { applyAdjustment } from './apply';

function coverageAt(selection: DocumentSelection | null, x: number, y: number): number {
  if (!selection) return 1;
  return (selection.mask.pixel(Math.floor(x) - selection.x, Math.floor(y) - selection.y)[0] ?? 0) / 255;
}

export function rasterToFloat(raster: Raster): Float32Array {
  if (raster.channels !== 4) throw new RangeError('RGBA raster required');
  const bytes = raster.toPixels(), out = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[i]! / 255;
  return out;
}
export function floatToRaster(width: number, height: number, rgba: Float32Array): Raster {
  const bytes = new Uint8Array(rgba.length);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.round(Math.min(1, Math.max(0, rgba[i]!)) * 255);
  return Raster.fromPixels(width, height, 4, bytes);
}

/** PixelAdjust.blend, with the selection mapped through the layer transform. */
export function adjustRaster(raster: Raster, transform: LayerTransform, adjustment: LayerAdjustment,
  selection: DocumentSelection | null = null): Raster {
  const original = rasterToFloat(raster), mapping = pixelToDocument(transform, raster.width, raster.height);
  const origin = apply(mapping, { x: 0, y: 0 });
  const adjusted = applyAdjustment(adjustment, original, raster.width, raster.height, origin.x, origin.y);
  if (selection) for (let y = 0; y < raster.height; y++) for (let x = 0; x < raster.width; x++) {
    const point = apply(mapping, { x: x + 0.5, y: y + 0.5 });
    const c = coverageAt(selection, point.x, point.y);
    const i = (y * raster.width + x) * 4;
    for (let k = 0; k < 4; k++) adjusted[i + k] = original[i + k]! + (adjusted[i + k]! - original[i + k]!) * c;
  }
  return floatToRaster(raster.width, raster.height, adjusted);
}

export function invertRaster(raster: Raster, transform: LayerTransform, selection: DocumentSelection | null = null): Raster {
  const source = raster.toPixels(), out = source.slice(), mapping = pixelToDocument(transform, raster.width, raster.height);
  for (let y = 0; y < raster.height; y++) for (let x = 0; x < raster.width; x++) {
    const point = apply(mapping, { x: x + 0.5, y: y + 0.5 }), c = coverageAt(selection, point.x, point.y);
    const i = (y * raster.width + x) * raster.channels;
    if (raster.channels === 1) out[i] = Math.round(source[i]! + ((255 - source[i]!) - source[i]!) * c);
    else for (let k = 0; k < 3; k++) out[i + k] = Math.round(source[i + k]! + ((255 - source[i + k]!) - source[i + k]!) * c);
  }
  return Raster.fromPixels(raster.width, raster.height, raster.channels, out);
}

/** Four 256-bin arrays: RGB mean, red, green, blue (`levels_histogram`). */
export function levelsHistogram(raster: Raster, transform: LayerTransform,
  selection: DocumentSelection | null = null): Float64Array[] {
  if (raster.channels !== 4) throw new RangeError('RGBA raster required');
  const pixels = raster.toPixels(), bins = Array.from({ length: 4 }, () => new Float64Array(256));
  const mapping = pixelToDocument(transform, raster.width, raster.height);
  for (let y = 0; y < raster.height; y++) for (let x = 0; x < raster.width; x++) {
    const i = (y * raster.width + x) * 4, alpha = pixels[i + 3]!;
    if (!alpha) continue;
    const point = apply(mapping, { x: x + 0.5, y: y + 0.5 });
    const weight = alpha / 255 * coverageAt(selection, point.x, point.y);
    if (!(weight > 0)) continue;
    for (let c = 0; c < 3; c++) { const value = pixels[i + c]!, channel = bins[c + 1]!, rgb = bins[0]!;
      channel[value] = channel[value]! + weight; rgb[value] = rgb[value]! + weight / 3; }
  }
  return bins;
}
