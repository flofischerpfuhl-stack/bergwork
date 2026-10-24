/**
 * Image › Rotate Canvas 90° (Document/CanvasRotation.swift, Compositor 1.4.6) and Image › Trim (Document/ImageTrim.swift,
 * Compositor 1.2.3): whole-document operations that move placements, never resample layer pixels.
 */

import type { CanvasDocument, Layer } from './document';
import { center, type LayerTransform, type Rect } from './geometry';
import { Raster } from './raster';
import type { DocumentSelection } from './selection';

/** A placement turned a quarter turn with the canvas (`width` × `height` before the turn); whole pixels stay whole. */
export function quarterTurned(t: LayerTransform, clockwise: boolean, width: number, height: number): LayerTransform {
  const c = center(t);
  const middle = clockwise ? { x: height - c.y, y: c.x } : { x: c.y, y: width - c.x };
  return { ...t, origin: { x: middle.x - t.size.width / 2, y: middle.y - t.size.height / 2 },
    rotation: (t.rotation + (clockwise ? 90 : -90)) % 360 };
}

function turnedRect(rect: Rect, clockwise: boolean, width: number, height: number): Rect {
  return clockwise ? { x: height - rect.y - rect.height, y: rect.x, width: rect.height, height: rect.width }
    : { x: rect.y, y: width - rect.x - rect.width, width: rect.height, height: rect.width };
}

/** A single-channel coverage raster turned a quarter turn. */
function turnedMask(mask: Raster, clockwise: boolean): Raster {
  const w = mask.width, h = mask.height, source = mask.toPixelsNative(), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const tx = clockwise ? h - 1 - y : y, ty = clockwise ? x : w - 1 - x;
    out[ty * h + tx] = source[y * w + x]!;
  }
  return Raster.fromPixels(h, w, 1, out);
}

function turnedSelection(selection: DocumentSelection, clockwise: boolean, width: number, height: number): DocumentSelection {
  const rect = turnedRect({ x: selection.x, y: selection.y, width: selection.mask.width, height: selection.mask.height }, clockwise, width, height);
  return { ...selection, mask: turnedMask(selection.mask, clockwise), x: rect.x, y: rect.y };
}

/**
 * The whole canvas turned a quarter turn, as Photoshop's Image Rotation does: width and height swap, and every layer,
 * folder, placed mask, artboard, guide and the selection turn with it. Layers are placed, not resampled.
 */
export function rotateCanvasDocument(doc: CanvasDocument, clockwise: boolean): CanvasDocument {
  const { width, height } = doc;
  const turn = (t: LayerTransform) => quarterTurned(t, clockwise, width, height);
  const layers = doc.layers.map((layer): Layer => ({ ...layer, transform: turn(layer.transform),
    mask: layer.mask?.placement ? { ...layer.mask, placement: turn(layer.mask.placement) } : layer.mask }));
  return {
    ...doc, width: height, height: width, layers,
    ...(doc.artboards ? { artboards: doc.artboards.map((artboard) => ({ ...artboard, rect: turnedRect(artboard.rect, clockwise, width, height) })) } : {}),
    // A vertical guide becomes horizontal and the other way round, on the same content.
    ...(doc.guides ? { guides: doc.guides.map((guide) => guide.orientation === 'vertical'
      ? { ...guide, orientation: 'horizontal' as const, position: clockwise ? guide.position : width - guide.position }
      : { ...guide, orientation: 'vertical' as const, position: clockwise ? height - guide.position : guide.position }) } : {}),
    selection: doc.selection ? turnedSelection(doc.selection, clockwise, width, height) : null,
  };
}

export type TrimBasedOn = 'transparent' | 'topLeft' | 'bottomRight';
export interface TrimOptions {
  readonly basedOn: TrimBasedOn;
  readonly top: boolean; readonly bottom: boolean; readonly left: boolean; readonly right: boolean;
}
export const DEFAULT_TRIM: TrimOptions = { basedOn: 'transparent', top: true, bottom: true, left: true, right: true };

/**
 * The rectangle that keeps everything but the trimmed edge rows and columns of a rendered canvas: fully transparent
 * ones, or ones of exactly the top-left / bottom-right pixel's colour. Null when nothing would remain.
 */
export function trimRect(raster: Raster, options: TrimOptions = DEFAULT_TRIM): Rect | null {
  const { width, height } = raster;
  if (!(options.top || options.bottom || options.left || options.right) || !width || !height) return null;
  const pixels = raster.toPixelsNative();
  const reference = options.basedOn === 'topLeft' ? 0 : options.basedOn === 'bottomRight' ? (width * height - 1) * 4 : -1;
  const trimmed = (offset: number) => reference < 0 ? pixels[offset + 3] === 0
    : pixels[offset] === pixels[reference] && pixels[offset + 1] === pixels[reference + 1]
      && pixels[offset + 2] === pixels[reference + 2] && pixels[offset + 3] === pixels[reference + 3];
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (trimmed((y * width + x) * 4)) continue;
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (maxX < 0) return null;
  const left = options.left ? minX : 0, top = options.top ? minY : 0;
  const right = options.right ? maxX + 1 : width, bottom = options.bottom ? maxY + 1 : height;
  return { x: left, y: top, width: right - left, height: bottom - top };
}
