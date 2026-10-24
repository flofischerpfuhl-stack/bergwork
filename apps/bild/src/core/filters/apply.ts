/** Pixel filters from Document/Filters.swift and Rendering/NoisePixels.c/LensPixels.c. */
import type { LayerAdjustment } from '../document';
import { apply, invert, pixelToDocument, type LayerTransform } from '../geometry';
import { alphaBounds, cropRaster, Raster } from '../raster';
import { makePixelArray } from '../pixel/format';
import type { DocumentSelection } from '../selection';
import { adjustRaster } from '../adjust/raster';
import { blurMargin, normalizeFilterSettings, type FilterKind, type FilterSettings } from './settings';
import { gaussianBlur, motionBlur } from './blur';
import { denoise, highPass, smartSharpen, unsharpMask } from './sharpen';
import { bloom, progressiveBlur, rgbSplit, tonalContrast, vignette, type FilterFrame } from './creative';

export { gaussianBlur, motionBlur } from './blur';

export interface FilterResult { readonly raster: Raster; readonly transform: LayerTransform }
export interface FilterOptions { readonly selection?: DocumentSelection | null; readonly seed?: number; readonly expand?: boolean }

/** Carries an unplaced mask from an old layer grid onto a grown/trimmed filter grid. */
export function carryMask(mask: Raster, from: LayerTransform, to: LayerTransform, width: number, height: number): Raster {
  if (mask.channels !== 1 || (mask.width === 1 && mask.height === 1)) return mask;
  const oldMap = invert(pixelToDocument(from, mask.width, mask.height)), newMap = pixelToDocument(to, width, height);
  let edgeTotal = 0, edgeCount = 0;
  for (let x = 0; x < mask.width; x++) { edgeTotal += mask.pixel(x, 0)[0]!; edgeCount++; if (mask.height > 1) { edgeTotal += mask.pixel(x, mask.height - 1)[0]!; edgeCount++; } }
  for (let y = 1; y < mask.height - 1; y++) { edgeTotal += mask.pixel(0, y)[0]!; edgeCount++; if (mask.width > 1) { edgeTotal += mask.pixel(mask.width - 1, y)[0]!; edgeCount++; } }
  const background = edgeTotal * 2 >= edgeCount * 255 ? 255 : 0, pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const documentPoint = apply(newMap, { x: x + 0.5, y: y + 0.5 }), old = apply(oldMap, documentPoint);
    if (old.x < 0 || old.y < 0 || old.x >= mask.width || old.y >= mask.height) pixels[y * width + x] = background;
    else pixels[y * width + x] = mask.pixel(Math.floor(old.x), Math.floor(old.y))[0]!;
  }
  return Raster.fromPixels(width, height, 1, pixels);
}

function expanded(raster: Raster, transform: LayerTransform, margin: number): FilterResult {
  const m = Math.max(0, Math.ceil(margin)); if (m <= 0) return { raster, transform };
  const width = raster.width + m * 2, height = raster.height + m * 2;
  if (width > 30_000 || height > 30_000 || width * height > 100_000_000) throw new RangeError('Filtered layer is too large');
  const pixels = makePixelArray(raster.format, width * height * 4), source = raster.toPixelsNative();
  for (let y = 0; y < raster.height; y++) pixels.set(source.subarray(y * raster.width * 4, (y + 1) * raster.width * 4), ((y + m) * width + m) * 4);
  const map = pixelToDocument(transform, raster.width, raster.height), middle = apply(map, { x: raster.width / 2, y: raster.height / 2 });
  const size = { width: width * transform.size.width / raster.width, height: height * transform.size.height / raster.height };
  return { raster: Raster.fromPixels(width, height, 4, pixels, { format: raster.format }),
    transform: { ...transform, size, origin: { x: middle.x - size.width / 2, y: middle.y - size.height / 2 } } };
}

function hash32(value: number): number { let x = value >>> 0; x ^= x >>> 16; x = Math.imul(x, 0x7feb352d) >>> 0; x ^= x >>> 15; x = Math.imul(x, 0x846ca68b) >>> 0; x ^= x >>> 16; return x >>> 0; }
function unit(key: number): number { return (hash32(key) >>> 8) / 16777216; }
export function addNoise(raster: Raster, settings: FilterSettings, seed: number): Raster {
  const source = raster.toPixelsNative(), out = source.slice(), maximum = raster.maximum, spread = settings.amount / 100 * maximum / 2;
  for (let i = 0; i < raster.width * raster.height; i++) { const p = i * 4, alpha = source[p + 3]!; if (!alpha) continue;
    const base = hash32((seed ^ hash32(i)) >>> 0);
    for (let c = 0; c < 3; c++) { const key = settings.monochromatic ? base : (base + Math.imul(c, 0x9e3779b9)) >>> 0;
      const n = settings.gaussian ? Math.sqrt(-2 * Math.log(1 - unit(key))) * Math.cos(2 * Math.PI * unit((key ^ 0x68e31da4) >>> 0)) * spread * 2 / 3 : (unit(key) * 2 - 1) * spread;
      const straight = source[p + c]! + n; out[p + c] = Math.round(Math.min(maximum, Math.max(0, straight)));
    }
  }
  return Raster.fromPixels(raster.width, raster.height, 4, out, { format: raster.format });
}

export function lensCorrection(raster: Raster, distortion: number): Raster {
  const source = raster.toPixelsNative(), out = makePixelArray(raster.format, source.length), w = raster.width, h = raster.height, cx = w / 2, cy = h / 2;
  const diagonal = cx * cx + cy * cy, k = distortion / 100 * 0.35;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const dx = x + 0.5 - cx, dy = y + 0.5 - cy, scale = 1 - k * (dx * dx + dy * dy) / diagonal;
    const sx = cx + dx * scale - 0.5, sy = cy + dy * scale - 0.5, x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0, dst = (y * w + x) * 4;
    const sums = [0, 0, 0, 0];
    for (let yy = 0; yy < 2; yy++) for (let xx = 0; xx < 2; xx++) { const px = x0 + xx, py = y0 + yy; if (px < 0 || py < 0 || px >= w || py >= h) continue;
      const weight = (xx ? fx : 1 - fx) * (yy ? fy : 1 - fy), src = (py * w + px) * 4;
      for (let c = 0; c < 4; c++) sums[c] = sums[c]! + source[src + c]! * weight;
    }
    for (let c = 0; c < 4; c++) out[dst + c] = Math.round(sums[c]!);
  }
  return Raster.fromPixels(w, h, 4, out, { format: raster.format });
}

function adjustment(kind: FilterKind, settings: FilterSettings, seed: number): LayerAdjustment | null {
  if (kind === 'Curves') return { kind, schemaVersion: 1, parameters: settings.curves };
  if (kind === 'Exposure') return { kind, schemaVersion: 1, parameters: settings.exposure };
  if (kind === 'Gradient Map') return { kind, schemaVersion: 1, parameters: settings.gradientMap };
  if (kind === 'Grain') return { kind, schemaVersion: 1, parameters: { ...settings.grain, seed } };
  return null;
}

function blendSelection(original: Raster, filtered: Raster, transform: LayerTransform, selection: DocumentSelection | null): Raster {
  if (!selection) return filtered;
  const a = original.toPixelsNative(), b = filtered.toPixelsNative(), map = pixelToDocument(transform, original.width, original.height);
  for (let y = 0; y < original.height; y++) for (let x = 0; x < original.width; x++) { const point = apply(map, { x: x + 0.5, y: y + 0.5 });
    const coverage = (selection.mask.pixel(Math.floor(point.x) - selection.x, Math.floor(point.y) - selection.y)[0] ?? 0) / 255, i = (y * original.width + x) * 4;
    for (let c = 0; c < 4; c++) b[i + c] = Math.round(a[i + c]! + (b[i + c]! - a[i + c]!) * coverage);
  }
  return Raster.fromPixels(original.width, original.height, 4, b, { format: original.format });
}

/** Filters that spread into their padding and are cut back to what they leave covered. */
const TRIMMED: ReadonlySet<FilterKind> = new Set(['Gaussian Blur', 'Motion Blur', 'Progressive Blur', 'Bloom / Glow', 'RGB Split']);

/** Runs one filter, expanding and tightly trimming blur bounds like `FilterEdit`/`PixelFilter.trimmed`. */
export function applyFilter(kind: FilterKind, source: Raster, transform: LayerTransform, input: FilterSettings,
  options: FilterOptions = {}): FilterResult {
  if (source.channels !== 4) throw new RangeError('Filters require an RGBA raster');
  const settings = normalizeFilterSettings(input), seed = options.seed ?? settings.grain.seed;
  const margin = options.expand === false ? 0 : Math.max(0, Math.ceil(blurMargin(kind, settings)));
  const room = margin ? expanded(source, transform, margin) : { raster: source, transform };
  // Vignette, Progressive Blur and RGB Split place themselves on the layer's own pixels, not on the padding.
  const frame: FilterFrame = { x: margin, y: margin, width: source.width, height: source.height };
  let result: Raster; const colorAdjustment = adjustment(kind, settings, seed);
  if (colorAdjustment) result = adjustRaster(room.raster, room.transform, colorAdjustment, options.selection ?? null);
  else if (kind === 'Gaussian Blur') result = gaussianBlur(room.raster, settings.radius);
  else if (kind === 'Motion Blur') result = motionBlur(room.raster, settings.distance, settings.angle);
  else if (kind === 'Add Noise') result = addNoise(room.raster, settings, seed);
  else if (kind === 'Lens Correction') result = lensCorrection(room.raster, settings.distortion);
  else if (kind === 'Unsharp Mask') result = unsharpMask(room.raster, settings.amount, settings.radius, settings.threshold);
  else if (kind === 'Smart Sharpen') result = smartSharpen(room.raster, settings.amount, settings.radius, settings.threshold, settings.reduceNoise);
  else if (kind === 'High Pass') result = highPass(room.raster, settings.radius);
  else if (kind === 'Vignette') result = vignette(room.raster, { color: settings.vignetteColor, amount: settings.vignetteAmount,
    midpoint: settings.vignetteMidpoint, roundness: settings.vignetteRoundness, feather: settings.vignetteFeather,
    highlights: settings.vignetteHighlights }, frame);
  else if (kind === 'Bloom / Glow') result = bloom(room.raster, settings.bloomThreshold, settings.bloomRadius, settings.bloomAmount);
  else if (kind === 'Tonal Contrast') result = tonalContrast(room.raster, settings.tonalRadius, settings.tonalAmount,
    settings.tonalShadows, settings.tonalMidtones, settings.tonalHighlights);
  else if (kind === 'Progressive Blur') result = progressiveBlur(room.raster, settings.progressiveAngle, settings.progressiveStart,
    settings.progressiveEnd, settings.progressiveRadius, frame);
  else if (kind === 'RGB Split') result = rgbSplit(room.raster, settings.rgbSplitDistance, settings.rgbSplitBlur,
    settings.rgbSplitAngle, settings.rgbSplitRadial, frame);
  else result = denoise(room.raster, settings.luminance, settings.colour, settings.detail);
  if (!colorAdjustment) result = blendSelection(room.raster, result, room.transform, options.selection ?? null);
  if (margin > 0 && TRIMMED.has(kind)) {
    const bounds = alphaBounds(result);
    if (bounds && (bounds.x !== 0 || bounds.y !== 0 || bounds.width !== result.width || bounds.height !== result.height)) {
      const map = pixelToDocument(room.transform, result.width, result.height), middle = apply(map, { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 });
      const size = { width: bounds.width * room.transform.size.width / result.width, height: bounds.height * room.transform.size.height / result.height };
      return { raster: cropRaster(result, bounds.x, bounds.y, bounds.width, bounds.height),
        transform: { ...room.transform, size, origin: { x: middle.x - size.width / 2, y: middle.y - size.height / 2 } } };
    }
  }
  return { raster: result, transform: room.transform };
}
