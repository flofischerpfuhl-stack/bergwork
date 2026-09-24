/**
 * Eyedropper sampling (PRODUCT-PLAN 6.1): the composite (all layers, what the canvas shows) or the current layer,
 * one pixel or the 3×3 / 5×5 average around it (Photoshop's Sample Size).
 */

import type { RGB } from '../model/types';
import type { EditorSession } from '../session';
import { apply, invert, pixelToDocument, type Point } from '../geometry';

export type SampleSize = 1 | 3 | 5;
export interface EyedropperSettings { readonly size: SampleSize; readonly allLayers: boolean }
export const DEFAULT_EYEDROPPER: EyedropperSettings = { size: 1, allLayers: true };

/** The document-pixel square of a sample, clipped to the canvas; null when the point is outside. */
export function sampleRect(point: Point, size: SampleSize, width: number, height: number): { x: number; y: number; width: number; height: number } | null {
  const cx = Math.floor(point.x), cy = Math.floor(point.y);
  if (cx < 0 || cy < 0 || cx >= width || cy >= height) return null;
  const r = (size - 1) / 2;
  const x0 = Math.max(0, cx - r), y0 = Math.max(0, cy - r), x1 = Math.min(width, cx + r + 1), y1 = Math.min(height, cy + r + 1);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Alpha-weighted mean of straight RGBA8 pixels; null when every pixel is transparent. */
export function averageStraightRgba(pixels: ArrayLike<number>): RGB | null {
  let r = 0, g = 0, b = 0, a = 0;
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    const alpha = pixels[i + 3]!;
    r += pixels[i]! * alpha; g += pixels[i + 1]! * alpha; b += pixels[i + 2]! * alpha; a += alpha;
  }
  if (!a) return null;
  // Round to 8-bit steps like a single-pixel sample, so a uniform area samples exactly its colour.
  const channel = (sum: number) => Math.round(sum / a) / 255;
  return { red: channel(r), green: channel(g), blue: channel(b) };
}

/** Straight RGBA8 of the current layer's own pixels over a document rectangle (transparent outside the layer). */
export function currentLayerRegion(session: EditorSession, rect: { x: number; y: number; width: number; height: number }): Uint8Array {
  const out = new Uint8Array(rect.width * rect.height * 4);
  const layer = session.activeLayer;
  const raster = layer && layer.kind !== 'group' ? layer.raster : null;
  if (!layer || !raster || raster.channels !== 4) return out;
  const placement = layer.kind === 'text' && layer.renderedTransform ? layer.renderedTransform : session.displayedTransform(layer);
  const inverse = invert(pixelToDocument(placement, raster.width, raster.height));
  for (let y = 0; y < rect.height; y++) for (let x = 0; x < rect.width; x++) {
    const p = apply(inverse, { x: rect.x + x + 0.5, y: rect.y + y + 0.5 });
    const px = Math.floor(p.x), py = Math.floor(p.y);
    if (px < 0 || py < 0 || px >= raster.width || py >= raster.height) continue;
    out.set(raster.readRegion(px, py, 1, 1), (y * rect.width + x) * 4);
  }
  return out;
}

/**
 * The eyedropper's colour at a document point. `readComposite` reads straight RGBA8 of the visible composite (the
 * canvas host's readRegion); the current-layer mode reads the layer's own pixels.
 */
export function sampleColor(session: EditorSession, point: Point, settings: EyedropperSettings,
  readComposite: ((x: number, y: number, width: number, height: number) => Uint8Array) | null): RGB | null {
  const document = session.document;
  if (!document) return null;
  const rect = sampleRect(point, settings.size, document.width, document.height);
  if (!rect) return null;
  if (settings.allLayers) return readComposite ? averageStraightRgba(readComposite(rect.x, rect.y, rect.width, rect.height)) : null;
  return averageStraightRgba(currentLayerRegion(session, rect));
}
