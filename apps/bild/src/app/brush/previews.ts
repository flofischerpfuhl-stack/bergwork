/**
 * Tip thumbnails and stroke previews for the preset picker and the Brush Settings panel, drawn by the real engine
 * (tip.ts coverage, stroke.ts/dabs.ts rasterizers), so a preview shows what the brush paints. Work is queued and
 * done one item per task, so a library of large imported tips never blocks input.
 */

import { newLayer } from '../../core/document';
import { makeTransform } from '../../core/geometry';
import { DEFAULT_BRUSH_SETTINGS, type BrushSettings } from '../../core/brush/settings';
import { beginStroke } from '../../core/brush/stroke';
import { dabCoverage, prepareDab, type BrushTip } from '../../core/brush/tip';
import type { BrushPreset } from '../../core/brush/presets';

export interface PreviewImage { readonly width: number; readonly height: number; readonly data: Uint8ClampedArray }

type Look = Pick<BrushSettings, 'diameter' | 'hardness' | 'opacity' | 'tip' | 'dynamics'>;

const cache = new WeakMap<object, Map<string, PreviewImage>>();
const queue: (() => void)[] = [];
let scheduled = false;

function pump(): void {
  scheduled = false;
  const job = queue.shift();
  job?.();
  if (queue.length && !scheduled) { scheduled = true; setTimeout(pump, 0); }
}

/** Returns a cached image now, or null and calls `ready` once it is drawn. */
export function requestPreview(owner: object, key: string, draw: () => PreviewImage, ready: (image: PreviewImage) => void): PreviewImage | null {
  let images = cache.get(owner);
  if (!images) { images = new Map(); cache.set(owner, images); }
  const existing = images.get(key);
  if (existing) return existing;
  queue.push(() => {
    const again = images.get(key);
    if (again) { ready(again); return; }
    let image: PreviewImage;
    try { image = draw(); } catch { image = { width: 1, height: 1, data: new Uint8ClampedArray(4) }; }
    images.set(key, image);
    ready(image);
  });
  if (!scheduled) { scheduled = true; setTimeout(pump, 0); }
  return null;
}

/** The tip's shape at its angle and roundness, fitted into a square (not the brush size). */
export function drawTipThumbnail(tip: BrushTip | undefined, hardness: number, size: number, rgb: readonly [number, number, number]): PreviewImage {
  const data = new Uint8ClampedArray(size * size * 4);
  const dab = prepareDab({ x: size / 2, y: size / 2, size: size - 4, angle: (tip?.angle ?? 0) * Math.PI / 180, alpha: 1 }, tip, 1);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const coverage = dabCoverage(dab, x + 0.5, y + 0.5, hardness, 1);
    const offset = (y * size + x) * 4;
    data[offset] = rgb[0]; data[offset + 1] = rgb[1]; data[offset + 2] = rgb[2]; data[offset + 3] = Math.round(coverage * 255);
  }
  return { width: size, height: size, data };
}

/** An S-shaped stroke with a pressure taper, painted by the engine at a size that fits the preview. */
export function drawStrokePreview(look: Look, width: number, height: number, rgb: readonly [number, number, number]): PreviewImage {
  const diameter = Math.max(2, Math.min(look.diameter, height * 0.55));
  const settings: BrushSettings = { ...DEFAULT_BRUSH_SETTINGS, ...look, diameter, mode: 'paint',
    red: rgb[0] / 255, green: rgb[1] / 255, blue: rgb[2] / 255 };
  const layer = newLayer({ id: 'preview', name: 'Preview', raster: null, transform: makeTransform({ x: 0, y: 0 }, { width, height }) });
  const stroke = beginStroke({ layer, canvas: { width, height }, settings });
  const margin = diameter / 2 + 2, count = 24;
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    const point = { x: margin + (width - margin * 2) * t, y: height / 2 - Math.sin(t * Math.PI * 2) * (height / 2 - margin) * 0.6 };
    stroke.addPoints([point], { pressure: Math.max(0.15, Math.sin(t * Math.PI)), tilt: 1 - t * 0.7 });
  }
  const result = stroke.finish();
  const data = new Uint8ClampedArray(width * height * 4);
  const bounds = result.bounds;
  const pixels = result.raster.readRegion(0, 0, result.raster.width, result.raster.height);
  for (let y = 0; y < result.raster.height; y++) {
    const ty = y + bounds.y;
    if (ty < 0 || ty >= height) continue;
    for (let x = 0; x < result.raster.width; x++) {
      const tx = x + bounds.x;
      if (tx < 0 || tx >= width) continue;
      const from = (y * result.raster.width + x) * 4, to = (ty * width + tx) * 4;
      data[to] = pixels[from]!; data[to + 1] = pixels[from + 1]!; data[to + 2] = pixels[from + 2]!; data[to + 3] = pixels[from + 3]!;
    }
  }
  return { width, height, data };
}

export function presetLook(preset: BrushPreset): Look {
  return { diameter: preset.diameter, hardness: preset.hardness, opacity: preset.opacity, tip: preset.tip, dynamics: preset.dynamics };
}
