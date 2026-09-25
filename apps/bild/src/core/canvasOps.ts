/** Crop, Canvas Size and Image Size operations, without UI or platform graphics APIs. */

import { MAX_LAYERS, MAX_PIXELS, MAX_SIDE, isValidStructure, newLayer, renderLayers,
  type CanvasDocument, type Layer } from './document';
import { boundingBox, concat, corners, dragUpdated, invert, isValidTransform, makeTransform, placing,
  roundHalfAway, scaling, translation, unitToDocument, HANDLES,
  type LayerSampling, type Point, type Rect } from './geometry';
import { uuid } from './ids';
import { Raster, TILE } from './raster';
import { resampleAffine, resampleRaster } from './resampling';

export const PROJECT_TOO_LARGE = 'This project exceeds the supported canvas, layer, file-size, or 100-megapixel image limit.';
export const PROJECT_INVALID = 'This is not a valid Compositor project, or its metadata is damaged.';

export type CanvasOperationErrorCode = 'invalid' | 'tooLarge';

export class CanvasOperationError extends Error {
  constructor(readonly code: CanvasOperationErrorCode) {
    super(code === 'tooLarge' ? PROJECT_TOO_LARGE : PROJECT_INVALID);
    this.name = 'CanvasOperationError';
  }
}

function validSize(width: number, height: number): boolean {
  return Number.isInteger(width) && Number.isInteger(height) && width >= 1 && height >= 1
    && width <= MAX_SIDE && height <= MAX_SIDE;
}

/** A layer moved by (dx, dy), carrying a separately placed mask along. */
export function translated(layer: Layer, dx: number, dy: number): Layer {
  const transform = { ...layer.transform,
    origin: { x: layer.transform.origin.x + dx, y: layer.transform.origin.y + dy } };
  if (!isValidTransform(transform)) throw new CanvasOperationError('tooLarge');
  const placement = layer.mask?.placement;
  const mask = layer.mask && placement ? { ...layer.mask,
    placement: { ...placement, origin: { x: placement.origin.x + dx, y: placement.origin.y + dy } } } : layer.mask;
  const warp = layer.warp ? { ...layer.warp, corners: layer.warp.corners.map((point) =>
    ({ x: point.x + dx, y: point.y + dy })) as [Point, Point, Point, Point] } : null;
  return { ...layer, transform, mask, warp };
}

export interface CanvasExtensionColor { readonly red: number; readonly green: number; readonly blue: number }
export interface CanvasResizeOptions {
  readonly fill?: CanvasExtensionColor | null; readonly contentOffset?: Point;
  /** Name of the filled extension layer, in the UI language. */
  readonly extensionName?: string;
}
export interface CropOptions { readonly fill?: CanvasExtensionColor | null }
export type CanvasAnchor = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export function canvasOffset(width: number, height: number, oldWidth: number, oldHeight: number,
  anchor: number): Point {
  return { x: Math.floor((width - oldWidth) * (anchor % 3) / 2),
    y: Math.floor((height - oldHeight) * Math.floor(anchor / 3) / 2) };
}

function extensionRaster(width: number, height: number, oldWidth: number, oldHeight: number,
  offset: Point, color: CanvasExtensionColor): Raster {
  const rgb = [color.red, color.green, color.blue];
  if (rgb.some((v) => !Number.isFinite(v) || v < 0 || v > 1)) throw new CanvasOperationError('invalid');
  const bytes = rgb.map((v) => Math.round(v * 255));
  const cols = Math.ceil(width / TILE), rows = Math.ceil(height / TILE);
  const tiles: (Uint8Array | null)[] = [];
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
    const tw = Math.min(TILE, width - col * TILE), th = Math.min(TILE, height - row * TILE);
    const tile = new Uint8Array(tw * th * 4);
    let any = false;
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
      const gx = col * TILE + x, gy = row * TILE + y;
      if (gx >= offset.x && gy >= offset.y && gx < offset.x + oldWidth && gy < offset.y + oldHeight) continue;
      const p = (y * tw + x) * 4;
      tile[p] = bytes[0]!; tile[p + 1] = bytes[1]!; tile[p + 2] = bytes[2]!; tile[p + 3] = 255; any = true;
    }
    tiles.push(any ? tile : null);
  }
  return new Raster(width, height, 4, tiles);
}

/** CanvasResizer.resize: source rasters are shared; only transforms and placed masks move. */
export function resizeCanvas(doc: CanvasDocument, width: number, height: number, anchor = 4,
  options: CanvasResizeOptions = {}): CanvasDocument {
  if (!validSize(width, height) || !Number.isInteger(anchor) || anchor < 0 || anchor > 8) {
    throw new CanvasOperationError('tooLarge');
  }
  const offset = options.contentOffset ?? canvasOffset(width, height, doc.width, doc.height, anchor);
  if (![offset.x, offset.y].every(Number.isFinite) || Math.abs(offset.x) > 1_000_000 || Math.abs(offset.y) > 1_000_000) {
    throw new CanvasOperationError('invalid');
  }
  let layers = doc.layers.map((layer) => translated(layer, offset.x, offset.y));
  if (options.fill && (width > doc.width || height > doc.height)) {
    const used = doc.layers.reduce((sum, layer) => sum + (layer.raster ? layer.raster.width * layer.raster.height : 0), 0);
    if (width * height > MAX_PIXELS - used || layers.length >= MAX_LAYERS) throw new CanvasOperationError('tooLarge');
    const raster = extensionRaster(width, height, doc.width, doc.height, offset, options.fill);
    const extension = newLayer({ id: uuid(), name: options.extensionName ?? 'Canvas Extension', raster,
      transform: makeTransform({ x: 0, y: 0 }, { width, height }) });
    layers = [extension, ...layers];
  }
  return { ...doc, width, height, layers, selection: null };
}

/** Crop is Canvas Size with an explicit negative crop-origin offset (Crop.commitCrop). */
export function cropDocument(doc: CanvasDocument, rect: Rect, options: CropOptions = {}): CanvasDocument {
  if (!validCropRect(rect)) throw new CanvasOperationError('tooLarge');
  return resizeCanvas(doc, Math.trunc(rect.width), Math.trunc(rect.height), 4,
    { fill: options.fill, contentOffset: { x: -rect.x, y: -rect.y } });
}

// MARK: Crop geometry (Crop.swift)

export function snapCropRect(rect: Rect): Rect {
  const minX = Math.min(rect.x, rect.x + rect.width), minY = Math.min(rect.y, rect.y + rect.height);
  const maxX = Math.max(rect.x, rect.x + rect.width), maxY = Math.max(rect.y, rect.y + rect.height);
  const x = roundHalfAway(minX), y = roundHalfAway(minY);
  return { x, y, width: Math.max(1, roundHalfAway(maxX) - x), height: Math.max(1, roundHalfAway(maxY) - y) };
}

export function validCropRect(rect: Rect): boolean {
  return [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
    && rect.width >= 1 && rect.width <= MAX_SIDE && rect.height >= 1 && rect.height <= MAX_SIDE
    && Math.abs(rect.x) <= 1_000_000 && Math.abs(rect.y) <= 1_000_000;
}

export function createCropRect(start: Point, end: Point, ratio: number | null, symmetric = false): Rect {
  let dx = end.x - start.x, dy = end.y - start.y;
  if (ratio !== null) {
    if (Math.abs(dx) > Math.abs(dy) * ratio) dy = (dy < 0 ? -1 : 1) * Math.abs(dx) / ratio;
    else dx = (dx < 0 ? -1 : 1) * Math.abs(dy) * ratio;
  }
  return symmetric
    ? snapCropRect({ x: start.x - Math.abs(dx), y: start.y - Math.abs(dy), width: Math.abs(dx) * 2, height: Math.abs(dy) * 2 })
    : snapCropRect({ x: Math.min(start.x, start.x + dx), y: Math.min(start.y, start.y + dy),
      width: Math.abs(dx), height: Math.abs(dy) });
}

export type CropDragMode = { readonly kind: 'create' } | { readonly kind: 'move' }
  | { readonly kind: 'resize'; readonly handle: number };
export interface CropDrag { readonly start: Point; readonly original: Rect; readonly mode: CropDragMode }

export function updateCropDrag(drag: CropDrag, point: Point, ratio: number | null, symmetric = false): Rect {
  if (drag.mode.kind === 'create') return createCropRect(drag.start, point, ratio, symmetric);
  if (drag.mode.kind === 'move') return snapCropRect({ ...drag.original,
    x: drag.original.x + point.x - drag.start.x, y: drag.original.y + point.y - drag.start.y });
  const original = makeTransform(drag.original, { width: drag.original.width, height: drag.original.height });
  const next = dragUpdated({ original, start: drag.start, mode: { kind: 'resize', handle: drag.mode.handle } },
    point, ratio !== null, false, symmetric);
  return snapCropRect({ x: next.origin.x, y: next.origin.y, width: next.size.width, height: next.size.height });
}

export interface CropSnap { readonly xs: readonly number[]; readonly ys: readonly number[]; readonly tolerance: number }

function nearest(value: number, targets: readonly number[], tolerance: number): number | null {
  let best: number | null = null;
  for (const target of targets) {
    if (Math.abs(target - value) > tolerance) continue;
    if (best !== null && Math.abs(best - value) <= Math.abs(target - value)) continue;
    best = target;
  }
  return best;
}

/** CropSnap.apply; fixed-ratio create/resize deliberately does not snap. */
export function applyCropSnap(rect: Rect, drag: CropDrag, point: Point, ratio: number | null,
  snap: CropSnap, symmetric = false): Rect {
  if (!(snap.tolerance > 0)) return rect;
  if (drag.mode.kind === 'move') {
    const shift = (edges: readonly number[], targets: readonly number[]): number => {
      let best = 0, found = false;
      for (const edge of edges) {
        const target = nearest(edge, targets, snap.tolerance);
        if (target === null) continue;
        const delta = target - edge;
        if (!found || Math.abs(delta) < Math.abs(best)) { best = delta; found = true; }
      }
      return best;
    };
    return { ...rect, x: rect.x + shift([rect.x, rect.x + rect.width], snap.xs),
      y: rect.y + shift([rect.y, rect.y + rect.height], snap.ys) };
  }
  if (ratio !== null) return rect;
  const handle = drag.mode.kind === 'resize' ? HANDLES[drag.mode.handle] : null;
  const horizontal = !handle || handle.x !== 0.5, vertical = !handle || handle.y !== 0.5;
  let result = { ...rect };
  if (horizontal) {
    if (Math.abs(point.x - result.x) <= Math.abs(point.x - result.x - result.width)) {
      const x = nearest(result.x, snap.xs, snap.tolerance);
      if (x !== null && x < result.x + result.width) result = { ...result, width: result.x + result.width - x, x };
    } else {
      const x = nearest(result.x + result.width, snap.xs, snap.tolerance);
      if (x !== null && x > result.x) result.width = x - result.x;
    }
  }
  if (vertical) {
    if (Math.abs(point.y - result.y) <= Math.abs(point.y - result.y - result.height)) {
      const y = nearest(result.y, snap.ys, snap.tolerance);
      if (y !== null && y < result.y + result.height) result = { ...result, height: result.y + result.height - y, y };
    } else {
      const y = nearest(result.y + result.height, snap.ys, snap.tolerance);
      if (y !== null && y > result.y) result.height = y - result.y;
    }
  }
  if (symmetric) {
    const center = drag.mode.kind === 'create' ? drag.start
      : { x: drag.original.x + drag.original.width / 2, y: drag.original.y + drag.original.height / 2 };
    if (horizontal) {
      const half = point.x >= center.x ? result.x + result.width - center.x : center.x - result.x;
      if (half >= 0.5) { result.x = center.x - half; result.width = half * 2; }
    }
    if (vertical) {
      const half = point.y >= center.y ? result.y + result.height - center.y : center.y - result.y;
      if (half >= 0.5) { result.y = center.y - half; result.height = half * 2; }
    }
  }
  return result;
}

export type CropRatioChoice = 'Free' | 'Original' | '1:1' | '4:3' | '16:9';
export function cropRatioChoice(choice: CropRatioChoice, document: Pick<CanvasDocument, 'width' | 'height'>): number | null {
  if (choice === 'Original') return document.width / document.height;
  if (choice === '1:1') return 1;
  if (choice === '4:3') return 4 / 3;
  if (choice === '16:9') return 16 / 9;
  return null;
}
export function applyCropRatio(rect: Rect, ratio: number): Rect {
  return snapCropRect({ x: rect.x, y: rect.y + rect.height / 2 - rect.width / ratio / 2,
    width: rect.width, height: rect.width / ratio });
}

export function cropSnapTargets(doc: CanvasDocument): { xs: number[]; ys: number[] } {
  const xs = [0, doc.width], ys = [0, doc.height];
  for (const layer of renderLayers(doc.layers)) {
    if (!layer.raster) continue;
    const box = boundingBox(layer.transform);
    xs.push(roundHalfAway(box.x), roundHalfAway(box.x + box.width));
    ys.push(roundHalfAway(box.y), roundHalfAway(box.y + box.height));
  }
  return { xs, ys };
}

// MARK: Canvas Size draft semantics (CanvasSize.swift)

export type CanvasUnit = 'Pixels' | 'Percent' | 'Inches' | 'Centimeters';
export interface CanvasSizeDraft {
  readonly originalWidth: number; readonly originalHeight: number; readonly resolution: number;
  readonly width: number; readonly height: number; readonly relative: boolean; readonly locked: boolean; readonly unit: CanvasUnit;
}
export function makeCanvasSizeDraft(width: number, height: number, resolution: number): CanvasSizeDraft {
  return { originalWidth: width, originalHeight: height, resolution, width, height, relative: false, locked: false, unit: 'Pixels' };
}
export function canvasSizeDraftValid(draft: CanvasSizeDraft): boolean {
  return Number.isFinite(draft.width) && Number.isFinite(draft.height)
    && roundHalfAway(draft.width) >= 1 && roundHalfAway(draft.width) <= MAX_SIDE
    && roundHalfAway(draft.height) >= 1 && roundHalfAway(draft.height) <= MAX_SIDE;
}
export function displayedCanvasDimension(draft: CanvasSizeDraft, widthAxis: boolean): number {
  const original = widthAxis ? draft.originalWidth : draft.originalHeight;
  const pixels = (widthAxis ? draft.width : draft.height) - (draft.relative ? original : 0);
  if (draft.unit === 'Percent') return pixels / original * 100;
  if (draft.unit === 'Inches') return pixels / draft.resolution;
  if (draft.unit === 'Centimeters') return pixels / draft.resolution * 2.54;
  return pixels;
}
export function setCanvasDimension(draft: CanvasSizeDraft, value: number, widthAxis: boolean): CanvasSizeDraft {
  const original = widthAxis ? draft.originalWidth : draft.originalHeight;
  let pixels = value;
  if (draft.unit === 'Percent') pixels = value / 100 * original;
  else if (draft.unit === 'Inches') pixels = value * draft.resolution;
  else if (draft.unit === 'Centimeters') pixels = value / 2.54 * draft.resolution;
  const final = pixels + (draft.relative ? original : 0);
  if (widthAxis) return { ...draft, width: final,
    height: draft.locked ? final * draft.originalHeight / draft.originalWidth : draft.height };
  return { ...draft, height: final,
    width: draft.locked ? final * draft.originalWidth / draft.originalHeight : draft.width };
}

// MARK: Image Size

export type ImageResample = LayerSampling | false;

function scaledLayer(layer: Layer, sx: number, sy: number, sampling: LayerSampling,
  budgets: { pixels: number; masks: number }): Layer {
  const scaled = corners(layer.transform).map((p) => ({ x: p.x * sx, y: p.y * sy }));
  const left = Math.floor(Math.min(...scaled.map((p) => p.x))), top = Math.floor(Math.min(...scaled.map((p) => p.y)));
  const width = Math.ceil(Math.max(...scaled.map((p) => p.x))) - left;
  const height = Math.ceil(Math.max(...scaled.map((p) => p.y))) - top;
  const transform = makeTransform({ x: left, y: top }, { width, height }, { sampling });
  if (!isValidTransform(transform)) throw new CanvasOperationError('tooLarge');
  let raster = layer.raster;
  if (raster) {
    if (!validSize(width, height) || width * height > MAX_PIXELS - budgets.pixels) throw new CanvasOperationError('tooLarge');
    budgets.pixels += width * height;
    // unitToDocument maps unit coordinates; normalize source pixel edges before applying it.
    const sourcePixelToScaledDocument = concat(scaling(1 / raster.width, 1 / raster.height),
      concat(unitToDocument(layer.transform), scaling(sx, sy)));
    const targetToSource = concat(translation(left, top), invert(sourcePixelToScaledDocument));
    const plain = Math.abs(targetToSource.b) < 1e-10 && Math.abs(targetToSource.c) < 1e-10
      && targetToSource.a > 0 && targetToSource.d > 0 && Math.abs(targetToSource.tx) < 1e-8 && Math.abs(targetToSource.ty) < 1e-8
      && Math.abs(targetToSource.a * width - raster.width) < 1e-7
      && Math.abs(targetToSource.d * height - raster.height) < 1e-7;
    raster = plain ? resampleRaster(raster, width, height, sampling)
      : resampleAffine(raster, width, height, targetToSource, sampling);
  }
  let mask = layer.mask;
  if (mask?.placement) {
    const placement = placing(mask.placement, concat(unitToDocument(mask.placement), scaling(sx, sy)));
    mask = { ...mask, placement };
  } else if (mask && mask.raster.uniformValue() === null) {
    if (!validSize(width, height) || width * height > MAX_PIXELS - budgets.masks) throw new CanvasOperationError('tooLarge');
    budgets.masks += width * height;
    const sourcePixelToScaledDocument = concat(scaling(1 / mask.raster.width, 1 / mask.raster.height),
      concat(unitToDocument(layer.transform), scaling(sx, sy)));
    const targetToSource = concat(translation(left, top), invert(sourcePixelToScaledDocument));
    mask = { ...mask, raster: resampleAffine(mask.raster, width, height, targetToSource, sampling) };
  }
  if (layer.kind === 'pixel' || layer.kind === 'vector' || layer.kind === 'text' || layer.kind === 'embedded') {
    return { ...layer, transform, raster: raster ?? null, mask };
  }
  return { ...layer, transform, mask };
}

/** ImageResizer.resize. `false` models the sheet's “Resample” toggle (resolution only). */
export function resizeImage(doc: CanvasDocument, width: number, height: number, resolution: number,
  resample: ImageResample = 'High quality'): CanvasDocument {
  if (!validSize(width, height) || !Number.isFinite(resolution) || resolution < 1 || resolution > 9600) {
    throw new CanvasOperationError('tooLarge');
  }
  if (resample === false) return { ...doc, resolution, selection: null };
  if (width === doc.width && height === doc.height) return { ...doc, resolution, selection: null };
  if (width * height > MAX_PIXELS) throw new CanvasOperationError('tooLarge');
  const sx = width / doc.width, sy = height / doc.height;
  const budgets = { pixels: 0, masks: 0 };
  const layers = doc.layers.map((layer) => scaledLayer(layer, sx, sy, resample, budgets));
  if (!isValidStructure(layers)) throw new CanvasOperationError('invalid');
  return { ...doc, width, height, resolution, layers, selection: null };
}

export interface ImageSizeDraft {
  readonly width: number; readonly height: number; readonly resolution: number; readonly locked: boolean;
  readonly resample: boolean; readonly unit: CanvasUnit;
}
export function displayedImageDimension(draft: ImageSizeDraft, original: number, widthAxis: boolean): number {
  const pixels = widthAxis ? draft.width : draft.height;
  if (draft.unit === 'Percent') return pixels / original * 100;
  if (draft.unit === 'Inches') return pixels / draft.resolution;
  if (draft.unit === 'Centimeters') return pixels / draft.resolution * 2.54;
  return pixels;
}
export function setImageDimension(draft: ImageSizeDraft, value: number, original: number,
  widthAxis: boolean): ImageSizeDraft {
  if (!Number.isFinite(value) || value <= 0) return draft;
  if (!draft.resample) {
    const dimension = widthAxis ? draft.width : draft.height;
    return { ...draft, resolution: dimension / value * (draft.unit === 'Centimeters' ? 2.54 : 1) };
  }
  let pixels = value;
  if (draft.unit === 'Percent') pixels = value / 100 * original;
  else if (draft.unit === 'Inches') pixels = value * draft.resolution;
  else if (draft.unit === 'Centimeters') pixels = value / 2.54 * draft.resolution;
  if (widthAxis) return { ...draft, width: pixels, height: draft.locked ? pixels * draft.height / draft.width : draft.height };
  return { ...draft, height: pixels, width: draft.locked ? pixels * draft.width / draft.height : draft.width };
}
export function setImageResolution(draft: ImageSizeDraft, resolution: number): ImageSizeDraft {
  if (!Number.isFinite(resolution) || resolution <= 0) return { ...draft, resolution };
  if (draft.resample && (draft.unit === 'Inches' || draft.unit === 'Centimeters') && draft.resolution > 0) {
    const factor = resolution / draft.resolution;
    return { ...draft, resolution, width: draft.width * factor, height: draft.height * factor };
  }
  return { ...draft, resolution };
}
export function setImageResample(draft: ImageSizeDraft, enabled: boolean, originalWidth: number,
  originalHeight: number): ImageSizeDraft {
  if (enabled) return { ...draft, resample: true };
  return { ...draft, resample: false, width: originalWidth, height: originalHeight, locked: true,
    unit: draft.unit === 'Pixels' || draft.unit === 'Percent' ? 'Inches' : draft.unit };
}
export function imageSizeDraftValid(draft: ImageSizeDraft): boolean {
  return Number.isFinite(draft.width) && Number.isFinite(draft.height) && Number.isFinite(draft.resolution)
    && draft.resolution >= 1 && draft.resolution <= 9600
    && roundHalfAway(draft.width) >= 1 && roundHalfAway(draft.width) <= MAX_SIDE
    && roundHalfAway(draft.height) >= 1 && roundHalfAway(draft.height) <= MAX_SIDE
    && (!draft.resample || roundHalfAway(draft.width) * roundHalfAway(draft.height) <= MAX_PIXELS);
}
