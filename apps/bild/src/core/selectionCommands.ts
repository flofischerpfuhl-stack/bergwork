/** Selection commands and selection-clipped pixel edits (Selection.swift / SelectionEdits.swift). */

import {
  effectiveVisibleIds, layerPixelHeight, layerPixelWidth, maskTransform, MAX_PIXELS, MAX_SIDE, newLayer, withLayerRaster,
  type CanvasDocument, type Layer,
} from './document';
import {
  apply, boundingBox, integralRect, invert, pixelToDocument, rectIntersection, rectUnion, roundHalfAway, transformsEqual,
  type Affine, type LayerTransform, type Point, type Rect,
} from './geometry';
import { uuid } from './ids';
import { Raster, TILE, alphaBounds, cropRaster } from './raster';
import { makePixelArray, type PixelArray } from './pixel/format';
import type { EditorSession, TransformEdit } from './session';
import { selectionIsEmpty, type DocumentSelection, type SelectionMode } from './selection';
import {
  combineSelection, contractSelection as contractCoverage, coverageSelection, emptySelection, expandSelection as expandCoverage,
  inverseSelection as inverseCoverage, moveSelection, selectAll as allCoverage, selectionBounds, selectionContains,
} from './selectionOps';

export type FillSource = 'foreground' | 'background';

export function canEditSelection(session: EditorSession): boolean { return session.canEditLayers && session.document !== null; }
export function canModifySelection(session: EditorSession): boolean {
  return canEditSelection(session) && !!session.selection && !selectionIsEmpty(session.selection);
}

export function setSelection(session: EditorSession, value: DocumentSelection | null, name: string): boolean {
  if (!canEditSelection(session) || session.selection === value || !session.document) return false;
  session.edit(name, () => session.replaceDocument({ ...session.document!, selection: value }));
  return true;
}

/** Common entry point for lasso, marquee, traced masks, and future Magic Wand masks. */
export function applySelection(session: EditorSession, shape: DocumentSelection, mode: SelectionMode, name: string): boolean {
  const document = session.document;
  if (!document || !canEditSelection(session)) return false;
  const result = combineSelection(document.selection, shape, mode, document);
  return result === document.selection ? false : setSelection(session, result, name);
}

export function selectAll(session: EditorSession): boolean {
  return session.document ? setSelection(session, allCoverage(session.document), 'Select All') : false;
}
export function deselect(session: EditorSession): boolean {
  return session.selection !== null ? setSelection(session, null, 'Deselect') : false;
}
export function invertSelection(session: EditorSession): boolean {
  const document = session.document, selection = session.selection;
  return document && selection ? setSelection(session, inverseCoverage(selection, document), 'Inverse') : false;
}
export function expandSelection(session: EditorSession, amount: number): boolean {
  const document = session.document, selection = session.selection;
  if (!document || !selection || !canModifySelection(session) || amount < 1 || amount > 500 || !Number.isInteger(amount)) return false;
  return setSelection(session, expandCoverage(selection, amount, document), 'Expand Selection');
}
export function contractSelection(session: EditorSession, amount: number): boolean {
  const document = session.document, selection = session.selection;
  if (!document || !selection || !canModifySelection(session) || amount < 1 || amount > 500 || !Number.isInteger(amount)) return false;
  return setSelection(session, contractCoverage(selection, amount, document), 'Contract Selection');
}

const movingSelections = new WeakMap<EditorSession, DocumentSelection>();

export function canMoveSelection(session: EditorSession, point: Point): boolean {
  return !!session.selection && !selectionIsEmpty(session.selection) && canEditSelection(session)
    && selectionContains(session.selection, point);
}
export function beginSelectionMove(session: EditorSession): boolean {
  const selection = session.selection;
  if (movingSelections.has(session) || !selection || selectionIsEmpty(selection) || !canEditSelection(session)) return false;
  session.beginEdit('Move Selection'); movingSelections.set(session, selection); return true;
}
export function previewSelectionMove(session: EditorSession, dx: number, dy: number): boolean {
  const origin = movingSelections.get(session), document = session.document;
  if (!origin || !document) return false;
  session.replaceDocument({ ...document, selection: moveSelection(origin, dx, dy) }); session.notify('document'); return true;
}
export function endSelectionMove(session: EditorSession): boolean {
  if (!movingSelections.delete(session)) return false;
  session.endEdit(); return true;
}
export function nudgeSelection(session: EditorSession, dx: number, dy: number): boolean {
  if (!beginSelectionMove(session)) return false;
  previewSelectionMove(session, dx, dy); endSelectionMove(session); return true;
}

/** `ignoringLocks`: true for menu commands, which stay enabled on a locked layer and refuse with the lock notice when run. */
export function canEditPixels(session: EditorSession, ignoringLocks = false): boolean {
  const document = session.document, layer = session.activeLayer;
  if (!document || !layer || !session.canEditLayers || session.selectedLayerIds.size !== 1) return false;
  if (!effectiveVisibleIds(document.layers).has(layer.id)) return false;
  if (!ignoringLocks && session.editBlocker(layer.id, 'pixels')) return false;
  return session.isMaskSelected ? !!layer.mask?.enabled : layer.kind !== 'group';
}

export function canInvertPixels(session: EditorSession, ignoringLocks = false): boolean {
  const document = session.document, layer = session.activeLayer;
  if (!document || !layer || session.isProjectBusy || session.isImporting || session.renamingLayerId !== null
    || session.selectedLayerIds.size !== 1 || !effectiveVisibleIds(document.layers).has(layer.id)
    || session.selection && selectionIsEmpty(session.selection)) return false;
  if (!ignoringLocks && session.editBlocker(layer.id, 'pixels')) return false;
  return session.isMaskSelected ? !!layer.mask?.enabled : layer.kind !== 'group' && !!layer.raster;
}

/** A pixel command run on a pixel-locked active layer: shows the lock notice and reports the refusal. */
export function refusePixelCommand(session: EditorSession): boolean {
  const id = session.activeLayerId;
  return !!id && session.refuseLayerEdit(id, 'pixels');
}

function rasterByte(raster: Raster, x: number, y: number, channel = 0): number {
  if (x < 0 || y < 0 || x >= raster.width || y >= raster.height) return 0;
  const col = Math.floor(x / TILE), row = Math.floor(y / TILE), tile = raster.tiles[row * raster.cols + col];
  if (!tile) return 0;
  return tile[((y - row * TILE) * raster.tileWidth(col) + x - col * TILE) * raster.channels + channel]!;
}

function sampleMask(selection: DocumentSelection | null, x: number, y: number): number {
  if (!selection) return 255;
  if (!selection.antialiased) return rasterByte(selection.mask, Math.floor(x - selection.x), Math.floor(y - selection.y));
  const u = x - selection.x - 0.5, v = y - selection.y - 0.5;
  const x0 = Math.floor(u), y0 = Math.floor(v), fx = u - x0, fy = v - y0;
  const a = rasterByte(selection.mask, x0, y0), b = rasterByte(selection.mask, x0 + 1, y0);
  const c = rasterByte(selection.mask, x0, y0 + 1), d = rasterByte(selection.mask, x0 + 1, y0 + 1);
  return Math.round((a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy);
}

function editRaster(raster: Raster, transform: LayerTransform, selection: DocumentSelection | null,
  operation: 'fill' | 'clear' | 'invert', color: readonly number[] = []): Raster {
  if (selection && selectionIsEmpty(selection)) return raster;
  const tiles = raster.tiles.slice();
  const map = pixelToDocument(transform, raster.width, raster.height), ch = raster.channels;
  const maximum = raster.maximum, colorScale = maximum / 255;
  let changed = false;
  for (let row = 0; row < raster.rows; row++) for (let col = 0; col < raster.cols; col++) {
    const tw = raster.tileWidth(col), th = raster.tileHeight(row), old = raster.tiles[row * raster.cols + col];
    let tile: PixelArray | null = null;
    for (let py = 0; py < th; py++) for (let px = 0; px < tw; px++) {
      const gx = col * TILE + px, gy = row * TILE + py;
      const p = apply(map, { x: gx + 0.5, y: gy + 0.5 });
      const coverage = sampleMask(selection, p.x, p.y);
      if (coverage === 0) continue;
      if (!tile) tile = old ? old.slice() : makePixelArray(raster.format, tw * th * ch);
      const offset = (py * tw + px) * ch, f = coverage / 255;
      if (ch === 1) {
        const before = tile[offset]!;
        const target = operation === 'invert' ? maximum - before : (color[0] ?? 0) * colorScale;
        tile[offset] = Math.round(before + (target - before) * f);
      } else if (operation === 'clear') {
        const oldA = tile[offset + 3]!;
        const nextA = Math.round(oldA * (1 - f));
        if (nextA === 0) { tile[offset] = 0; tile[offset + 1] = 0; tile[offset + 2] = 0; }
        tile[offset + 3] = nextA;
      } else if (operation === 'invert') {
        for (let c = 0; c < 3; c++) {
          const before = tile[offset + c]!; tile[offset + c] = Math.round(before + (maximum - before * 2) * f);
        }
      } else {
        const oldA = tile[offset + 3]! / maximum, outA = f + oldA * (1 - f);
        for (let c = 0; c < 3; c++) {
          const paint = (color[c] ?? 0) * colorScale;
          tile[offset + c] = outA === 0 ? 0 : Math.round((paint * f + tile[offset + c]! * oldA * (1 - f)) / outA);
        }
        tile[offset + 3] = Math.round(outA * maximum);
      }
    }
    if (tile) { tiles[row * raster.cols + col] = tile.some((v) => v !== 0) ? tile : null; changed = true; }
  }
  return changed ? new Raster(raster.width, raster.height, raster.channels, tiles, { format: raster.format }) : raster;
}

function targetRaster(session: EditorSession): { layer: Layer; raster: Raster; transform: LayerTransform; mask: boolean } | null {
  const layer = session.activeLayer;
  if (!layer) return null;
  if (!session.isMaskSelected) {
    const width = layer.raster?.width ?? layerPixelWidth(layer), height = layer.raster?.height ?? layerPixelHeight(layer);
    return { layer, raster: layer.raster ?? Raster.blank(width, height, 4), transform: layer.transform, mask: false };
  }
  if (!layer.mask) return null;
  let raster = layer.mask.raster;
  if (session.selection && raster.width === 1 && raster.height === 1) {
    const width = layer.raster?.width ?? layerPixelWidth(layer), height = layer.raster?.height ?? layerPixelHeight(layer);
    const value = raster.pixel(0, 0)[0]!; const data = new Uint8Array(width * height); data.fill(value);
    raster = Raster.fromPixels(width, height, 1, data);
  }
  return { layer, raster, transform: maskTransform(layer), mask: true };
}

function installEdit(session: EditorSession, target: NonNullable<ReturnType<typeof targetRaster>>, raster: Raster, name: string): boolean {
  if (raster === target.raster) return false;
  if (target.mask) session.replaceMaskPixels(target.layer.id, raster, name);
  else session.replaceLayerPixels(target.layer.id, raster, name);
  return true;
}

export function fillSelection(session: EditorSession, source: FillSource): boolean {
  if (!canEditPixels(session)) return false;
  const target = targetRaster(session); if (!target) return false;
  const palette = source === 'background' ? session.backgroundColor : session.foregroundColor;
  const color = target.mask
    ? [Math.round(palette.red * 255)]
    : [Math.round(palette.red * 255), Math.round(palette.green * 255), Math.round(palette.blue * 255), 255];
  return installEdit(session, target, editRaster(target.raster, target.transform, session.selection, 'fill', color), target.mask ? 'Fill Mask' : 'Fill');
}

export function clearSelectedPixels(session: EditorSession): boolean {
  if (!session.selection || !canEditPixels(session)) return false;
  if (session.isMaskSelected) return fillSelection(session, 'background');
  const target = targetRaster(session); if (!target || !target.layer.raster) return false;
  return installEdit(session, target, editRaster(target.raster, target.transform, session.selection, 'clear'), 'Clear');
}

export function deleteKeyPressed(session: EditorSession): boolean {
  if (session.selection) return clearSelectedPixels(session);
  if (session.isMaskSelected && session.activeLayer?.mask && session.selectedLayerIds.size <= 1) { session.deleteLayerMask(); return true; }
  const count = session.document?.layers.length ?? 0; session.deleteSelectedLayers();
  return (session.document?.layers.length ?? 0) !== count;
}

export function invertPixels(session: EditorSession): boolean {
  if (!canInvertPixels(session)) return false;
  session.commitTransform();
  if (!canInvertPixels(session)) return false;
  const target = targetRaster(session); if (!target) return false;
  return installEdit(session, target, editRaster(target.raster, target.transform, session.selection, 'invert'), target.mask ? 'Invert Mask' : 'Invert');
}

/** LayerMask.swift `addMask`: base colour with the selected area painted the opposite. */
export function addMaskFromSelection(session: EditorSession, revealing = true): boolean {
  const selection = session.selection, layer = session.activeLayer;
  if (!selection) { const before = layer?.mask; session.addLayerMask(revealing); return before !== session.activeLayer?.mask; }
  if (!layer || layer.mask || !session.canEditMask) return false;
  const width = layer.raster?.width ?? layerPixelWidth(layer), height = layer.raster?.height ?? layerPixelHeight(layer);
  const base = revealing ? 255 : 0, opposite = 255 - base;
  const data = new Uint8Array(width * height); data.fill(base);
  const map = pixelToDocument(layer.transform, width, height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = apply(map, { x: x + 0.5, y: y + 0.5 }), f = sampleMask(selection, p.x, p.y) / 255;
    data[y * width + x] = Math.round(base + (opposite - base) * f);
  }
  session.setMaskFromRaster(Raster.fromPixels(width, height, 1, data), 'Add Mask from Selection', true);
  return true;
}

function tracedSelection(raster: Raster, transform: LayerTransform, canvas: CanvasDocument, dark: boolean,
  antialiased: boolean): DocumentSelection | null {
  const box = boundingBox(transform), x = Math.max(0, Math.floor(box.x)), y = Math.max(0, Math.floor(box.y));
  const right = Math.min(canvas.width, Math.ceil(box.x + box.width)), bottom = Math.min(canvas.height, Math.ceil(box.y + box.height));
  if (right <= x || bottom <= y) return null;
  const width = right - x, height = bottom - y, out = new Uint8Array(width * height);
  const toPixels = invert(pixelToDocument(transform, raster.width, raster.height));
  const samples = antialiased ? 4 : 1, total = samples * samples;
  let any = false;
  for (let py = 0; py < height; py++) for (let px = 0; px < width; px++) {
    let count = 0;
    for (let sy = 0; sy < samples; sy++) for (let sx = 0; sx < samples; sx++) {
      const source = apply(toPixels, { x: x + px + (sx + 0.5) / samples, y: y + py + (sy + 0.5) / samples });
      const ix = Math.floor(source.x), iy = Math.floor(source.y);
      if (ix < 0 || iy < 0 || ix >= raster.width || iy >= raster.height) continue;
      const value = rasterByte(raster, ix, iy, raster.channels === 4 ? 3 : 0);
      if (dark ? value < 128 : value >= 128) count++;
    }
    const value = Math.round(count * 255 / total); out[py * width + px] = value; if (value) any = true;
  }
  return any ? coverageSelection(Raster.fromPixels(width, height, 1, out), x, y, canvas, antialiased) : null;
}

export function loadLayerSelection(session: EditorSession, layerId: string, mode: SelectionMode = 'New', antialiased = true): boolean {
  const document = session.document, layer = session.layer(layerId);
  if (!document || !layer?.raster || !canEditSelection(session)) return false;
  const traced = tracedSelection(layer.raster, layer.transform, document, false, antialiased);
  return traced ? applySelection(session, traced, mode, 'Load Layer Selection') : false;
}

export function loadMaskSelection(session: EditorSession, layerId: string, mode: SelectionMode = 'New', antialiased = true): boolean {
  const document = session.document, layer = session.layer(layerId);
  if (!document || !layer?.mask || !canEditSelection(session)) return false;
  const traced = tracedSelection(layer.mask.raster, maskTransform(layer), document, true, antialiased);
  return traced ? applySelection(session, traced, mode, 'Load Mask Selection') : false;
}

// Re-exported for clipboard/floating code without exposing its implementation as public API.
export const selectionSampleAt = sampleMask;

/** Displayed selection while a floating transform is active. */
export function transformedSelection(selection: DocumentSelection, from: LayerTransform, to: LayerTransform,
  pixelWidth: number, pixelHeight: number, _canvas: CanvasDocument): DocumentSelection {
  const sourceToDoc = pixelToDocument(from, pixelWidth, pixelHeight);
  const docToSource = invert(pixelToDocument(to, pixelWidth, pixelHeight));
  const points = [
    apply(pixelToDocument(to, pixelWidth, pixelHeight), { x: 0, y: 0 }),
    apply(pixelToDocument(to, pixelWidth, pixelHeight), { x: pixelWidth, y: 0 }),
    apply(pixelToDocument(to, pixelWidth, pixelHeight), { x: pixelWidth, y: pixelHeight }),
    apply(pixelToDocument(to, pixelWidth, pixelHeight), { x: 0, y: pixelHeight }),
  ];
  const minX = Math.floor(Math.min(...points.map((p) => p.x))), minY = Math.floor(Math.min(...points.map((p) => p.y)));
  const maxX = Math.ceil(Math.max(...points.map((p) => p.x))), maxY = Math.ceil(Math.max(...points.map((p) => p.y)));
  if (maxX <= minX || maxY <= minY) return emptySelection(selection.antialiased);
  const out = new Uint8Array((maxX - minX) * (maxY - minY));
  for (let y = minY; y < maxY; y++) for (let x = minX; x < maxX; x++) {
    const sourcePixel = apply(docToSource, { x: x + 0.5, y: y + 0.5 });
    const oldDoc = apply(sourceToDoc, sourcePixel);
    out[(y - minY) * (maxX - minX) + x - minX] = sampleMask(selection, oldDoc.x, oldDoc.y);
  }
  return { mask: Raster.fromPixels(maxX - minX, maxY - minY, 1, out), x: minX, y: minY, antialiased: selection.antialiased };
}

function inverseQuad(points: readonly Point[], point: Point): Point | null {
  const p00 = points[0]!, p10 = points[1]!, p11 = points[2]!, p01 = points[3]!;
  let u = 0.5, v = 0.5;
  for (let i = 0; i < 8; i++) {
    const ax = p10.x - p00.x, ay = p10.y - p00.y, bx = p01.x - p00.x, by = p01.y - p00.y;
    const cx = p00.x - p10.x - p01.x + p11.x, cy = p00.y - p10.y - p01.y + p11.y;
    const fx = p00.x + ax * u + bx * v + cx * u * v - point.x;
    const fy = p00.y + ay * u + by * v + cy * u * v - point.y;
    const j00 = ax + cx * v, j01 = bx + cx * u, j10 = ay + cy * v, j11 = by + cy * u;
    const determinant = j00 * j11 - j01 * j10;
    if (Math.abs(determinant) < 1e-10) return null;
    u -= (fx * j11 - fy * j01) / determinant;
    v -= (fy * j00 - fx * j10) / determinant;
  }
  return u >= -1e-6 && v >= -1e-6 && u <= 1.000001 && v <= 1.000001 ? { x: u, y: v } : null;
}

function distortedSelection(selection: DocumentSelection, from: LayerTransform, corners: readonly Point[],
  pixelWidth: number, pixelHeight: number): DocumentSelection {
  const minX = Math.floor(Math.min(...corners.map((p) => p.x))), minY = Math.floor(Math.min(...corners.map((p) => p.y)));
  const maxX = Math.ceil(Math.max(...corners.map((p) => p.x))), maxY = Math.ceil(Math.max(...corners.map((p) => p.y)));
  if (maxX <= minX || maxY <= minY) return emptySelection(selection.antialiased);
  const sourceToDocument = pixelToDocument(from, pixelWidth, pixelHeight), out = new Uint8Array((maxX - minX) * (maxY - minY));
  for (let y = minY; y < maxY; y++) for (let x = minX; x < maxX; x++) {
    const unit = inverseQuad(corners, { x: x + 0.5, y: y + 0.5 });
    if (!unit) continue;
    const oldDoc = apply(sourceToDocument, { x: unit.x * pixelWidth, y: unit.y * pixelHeight });
    out[(y - minY) * (maxX - minX) + x - minX] = sampleMask(selection, oldDoc.x, oldDoc.y);
  }
  return { mask: Raster.fromPixels(maxX - minX, maxY - minY, 1, out), x: minX, y: minY, antialiased: selection.antialiased };
}

export type FloatingEdit = TransformEdit;

export function canTransformSelection(session: EditorSession): boolean {
  return session.transformEdit === null && canEditPixels(session) && !session.isMaskSelected && !!session.selection
    && !selectionIsEmpty(session.selection) && !!session.activeLayer?.raster;
}

function liftFloatingSelection(document: CanvasDocument, layer: Layer): { raster: Raster; origin: Point } | null {
  const selection = document.selection, source = layer.raster;
  if (!selection || !source) return null;
  const bounds = selectionBounds(selection);
  if (!bounds) return null;
  const x = Math.max(0, bounds.x), y = Math.max(0, bounds.y);
  const right = Math.min(document.width, bounds.x + bounds.width), bottom = Math.min(document.height, bounds.y + bounds.height);
  if (right <= x || bottom <= y) return null;
  const width = right - x, height = bottom - y, out = makePixelArray(source.format, width * height * 4);
  const toPixels = invert(pixelToDocument(layer.transform, source.width, source.height));
  let any = false;
  for (let py = 0; py < height; py++) for (let px = 0; px < width; px++) {
    const docX = x + px + 0.5, docY = y + py + 0.5, coverage = sampleMask(selection, docX, docY);
    if (!coverage) continue;
    const point = apply(toPixels, { x: docX, y: docY });
    const sx = Math.floor(point.x), sy = Math.floor(point.y), offset = (py * width + px) * 4;
    const alpha = Math.round(rasterByte(source, sx, sy, 3) * coverage / 255);
    out[offset] = rasterByte(source, sx, sy); out[offset + 1] = rasterByte(source, sx, sy, 1);
    out[offset + 2] = rasterByte(source, sx, sy, 2); out[offset + 3] = alpha;
    if (alpha) any = true;
  }
  return any ? { raster: Raster.fromPixels(width, height, 4, out, { format: source.format }), origin: { x, y } } : null;
}

function clearLayerSelection(layer: Layer, selection: DocumentSelection): Layer {
  if (!layer.raster) return layer;
  return { ...layer, raster: editRaster(layer.raster, layer.transform, selection, 'clear') };
}

function sameTransform(a: LayerTransform, b: LayerTransform): boolean {
  return a.origin.x === b.origin.x && a.origin.y === b.origin.y && a.size.width === b.size.width && a.size.height === b.size.height
    && a.rotation === b.rotation && a.flipX === b.flipX && a.flipY === b.flipY && a.sampling === b.sampling;
}

function sourceOver(destination: PixelArray, offset: number, red: number, green: number, blue: number,
  alpha: number, maximum: number): void {
  const sa = alpha / maximum;
  if (sa === 0) return;
  const da = destination[offset + 3]! / maximum, outA = sa + da * (1 - sa);
  destination[offset] = Math.round((red * sa + destination[offset]! * da * (1 - sa)) / outA);
  destination[offset + 1] = Math.round((green * sa + destination[offset + 1]! * da * (1 - sa)) / outA);
  destination[offset + 2] = Math.round((blue * sa + destination[offset + 2]! * da * (1 - sa)) / outA);
  destination[offset + 3] = Math.round(outA * maximum);
}

/** FloatingSelection.swift `FloatingMerge.merge`, nearest sampled in the CPU port. */
function mergeFloating(source: Layer, floating: Layer, edit: TransformEdit): { layer: Layer; selection: DocumentSelection } | null {
  const sourceRaster = source.raster, pixels = floating.raster, info = edit.floating;
  if (!sourceRaster || !pixels || !info || !info.before.selection) return null;
  const document = info.before, originalSelection = info.before.selection;
  const sourceToDocument = pixelToDocument(source.transform, sourceRaster.width, sourceRaster.height);
  const documentToSource = invert(sourceToDocument);
  const floatingToDocument = pixelToDocument(edit.draft, pixels.width, pixels.height);
  const placedCorners = edit.corners ?? [
    apply(floatingToDocument, { x: 0, y: 0 }), apply(floatingToDocument, { x: pixels.width, y: 0 }),
    apply(floatingToDocument, { x: pixels.width, y: pixels.height }), apply(floatingToDocument, { x: 0, y: pixels.height }),
  ];
  const floatingCorners = placedCorners.map((p) => apply(documentToSource, p));
  const minX = Math.floor(Math.min(0, ...floatingCorners.map((p) => p.x))), minY = Math.floor(Math.min(0, ...floatingCorners.map((p) => p.y)));
  const maxX = Math.ceil(Math.max(sourceRaster.width, ...floatingCorners.map((p) => p.x)));
  const maxY = Math.ceil(Math.max(sourceRaster.height, ...floatingCorners.map((p) => p.y)));
  const width = maxX - minX, height = maxY - minY;
  if (width < 1 || height < 1 || width > 30_000 || height > 30_000 || width * height > 100_000_000) return null;
  const out = makePixelArray(sourceRaster.format, width * height * 4);
  const old = sourceRaster.toPixelsNative();
  for (let y = 0; y < sourceRaster.height; y++) {
    const src = y * sourceRaster.width * 4, dst = ((y - minY) * width - minX) * 4;
    out.set(old.subarray(src, src + sourceRaster.width * 4), dst);
  }
  const documentToFloating = invert(floatingToDocument);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const doc = apply(sourceToDocument, { x: x + minX + 0.5, y: y + minY + 0.5 });
    const unit = edit.corners ? inverseQuad(edit.corners, doc) : null;
    if (edit.corners && !unit) continue;
    const fp = unit ? { x: unit.x * pixels.width, y: unit.y * pixels.height } : apply(documentToFloating, doc);
    const sx = Math.floor(fp.x), sy = Math.floor(fp.y);
    if (sx < 0 || sy < 0 || sx >= pixels.width || sy >= pixels.height) continue;
    sourceOver(out, (y * width + x) * 4, rasterByte(pixels, sx, sy), rasterByte(pixels, sx, sy, 1),
      rasterByte(pixels, sx, sy, 2), rasterByte(pixels, sx, sy, 3), sourceRaster.maximum);
  }
  const oldCenter = apply(sourceToDocument, { x: (minX + maxX) / 2, y: (minY + maxY) / 2 });
  const size = { width: width * source.transform.size.width / sourceRaster.width,
    height: height * source.transform.size.height / sourceRaster.height };
  const transform = { ...source.transform, size, origin: { x: oldCenter.x - size.width / 2, y: oldCenter.y - size.height / 2 } };
  let mask = source.mask;
  if (mask && !mask.placement && (width !== sourceRaster.width || height !== sourceRaster.height)) {
    const current = mask.raster.width === 1 && mask.raster.height === 1
      ? new Uint8Array(sourceRaster.width * sourceRaster.height).fill(mask.raster.pixel(0, 0)[0]!) : mask.raster.toPixels();
    const grown = new Uint8Array(width * height); grown.fill(255);
    for (let y = 0; y < sourceRaster.height; y++) grown.set(current.subarray(y * sourceRaster.width, (y + 1) * sourceRaster.width),
      (y - minY) * width - minX);
    mask = { ...mask, raster: Raster.fromPixels(width, height, 1, grown) };
  }
  const moved = edit.corners
    ? distortedSelection(originalSelection, info.original, edit.corners, info.pixelSize.width, info.pixelSize.height)
    : transformedSelection(originalSelection, info.original, edit.draft, info.pixelSize.width, info.pixelSize.height, document);
  return { layer: { ...source, raster: Raster.fromPixels(width, height, 4, out, { format: sourceRaster.format }), transform, mask }, selection: moved };
}

function cancelFloating(session: EditorSession, edit: TransformEdit): void {
  const floating = edit.floating; if (!floating) return;
  session.replaceDocument(floating.before); session.setActiveLayer(floating.beforeActive); session.endEdit();
}

function commitFloating(session: EditorSession, edit: TransformEdit): void {
  const info = edit.floating;
  if (!info) return;
  if (sameTransform(edit.draft, info.original) && !edit.corners) { cancelFloating(session, edit); return; }
  const document = session.document;
  const floating = document?.layers.find((l) => l.id === edit.layerId), source = document?.layers.find((l) => l.id === info.sourceId);
  const merged = floating && source ? mergeFloating(source, floating, edit) : null;
  if (!document || !floating || !source || !merged) { cancelFloating(session, edit); return; }
  const layers = document.layers.filter((l) => l.id !== floating.id).map((l) => l.id === source.id ? merged.layer : l);
  session.replaceDocument({ ...document, layers, selection: merged.selection }); session.setActiveLayer(source.id); session.endEdit();
}

/** Installs the session hooks and starts the one-step floating selection transform. */
export function beginSelectionTransform(session: EditorSession): boolean {
  if (!canTransformSelection(session) || !session.document || !session.activeLayer || !session.selection) return false;
  const before = session.document, beforeActive = session.activeLayerId, source = session.activeLayer;
  const lifted = liftFloatingSelection(before, source); if (!lifted) return false;
  session.beginEdit('Transform Selection');
  const cleared = before.layers.map((layer) => layer.id === source.id ? clearLayerSelection(layer, before.selection!) : layer);
  const floating = newLayer({ id: uuid(), name: session.label('Floating Selection'), raster: lifted.raster, parentId: source.parentId,
    opacity: source.opacity, blendMode: source.blendMode,
    transform: { ...source.transform, origin: lifted.origin, size: { width: lifted.raster.width, height: lifted.raster.height },
      rotation: 0, flipX: false, flipY: false } });
  const index = before.layers.findIndex((l) => l.id === source.id);
  cleared.splice(index + 1, 0, floating);
  session.replaceDocument({ ...before, layers: cleared }); session.setActiveLayer(floating.id); session.tool = 'move';
  session.floatingCommit = (edit) => commitFloating(session, edit);
  session.floatingCancel = (edit) => cancelFloating(session, edit);
  session.transformEdit = { layerId: floating.id, draft: floating.transform, persistent: true, mask: false,
    floating: { sourceId: source.id, before, beforeActive, original: floating.transform,
      pixelSize: { width: lifted.raster.width, height: lifted.raster.height } } };
  session.notify('document'); return true;
}

export interface PixelMoveState {
  readonly layerId: string;
  readonly duplicate: boolean;
  readonly origin: DocumentSelection;
  readonly originalRaster: Raster;
  readonly originalTransform: LayerTransform;
  readonly lifted: Raster;
  /** Lifted pixels in the original layer's pixel coordinates. */
  readonly liftedRect: Rect;
  /** Rounded document-pixel offset from the drag start. */
  readonly offset: Point;
  readonly preview: Raster | null;
  readonly previewTransform: LayerTransform | null;
  /** Preview extent in the original layer's pixel coordinates. */
  readonly previewBounds: Rect | null;
}

const pixelMoves = new WeakMap<EditorSession, PixelMoveState>();

/** Current Cmd-drag state; the canvas may use `previewTransform` with `session.rasterOverrides`. */
export function pixelMoveState(session: EditorSession): Readonly<PixelMoveState> | null {
  return pixelMoves.get(session) ?? null;
}

function mappedRectBounds(rect: Rect, transform: Affine): Rect {
  const points = [
    apply(transform, { x: rect.x, y: rect.y }), apply(transform, { x: rect.x + rect.width, y: rect.y }),
    apply(transform, { x: rect.x + rect.width, y: rect.y + rect.height }), apply(transform, { x: rect.x, y: rect.y + rect.height }),
  ];
  const x = Math.min(...points.map((p) => p.x)), y = Math.min(...points.map((p) => p.y));
  return { x, y, width: Math.max(...points.map((p) => p.x)) - x, height: Math.max(...points.map((p) => p.y)) - y };
}

function transformForPixelBounds(original: LayerTransform, pixelWidth: number, pixelHeight: number, bounds: Rect): LayerTransform {
  const mapping = pixelToDocument(original, pixelWidth, pixelHeight);
  const middle = apply(mapping, { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 });
  const size = { width: bounds.width * original.size.width / pixelWidth, height: bounds.height * original.size.height / pixelHeight };
  return { ...original, size, origin: { x: middle.x - size.width / 2, y: middle.y - size.height / 2 } };
}

/** BrushStroke.liftSelection: selected source pixels in the layer's own grid. */
function liftPixels(document: CanvasDocument, layer: Layer, selection: DocumentSelection): { raster: Raster; rect: Rect } | null {
  const source = layer.raster, selectionRect = selectionBounds(selection);
  const selected = selectionRect && rectIntersection(selectionRect, { x: 0, y: 0, width: document.width, height: document.height });
  if (!source || !selected) return null;
  const toPixels = invert(pixelToDocument(layer.transform, source.width, source.height));
  const mapped = integralRect(mappedRectBounds(selected, toPixels));
  const region = rectIntersection(mapped, { x: 0, y: 0, width: source.width, height: source.height });
  if (!region) return null;
  const out = makePixelArray(source.format, region.width * region.height * 4);
  const toDocument = pixelToDocument(layer.transform, source.width, source.height);
  let any = false;
  for (let y = 0; y < region.height; y++) for (let x = 0; x < region.width; x++) {
    const sx = region.x + x, sy = region.y + y, documentPoint = apply(toDocument, { x: sx + 0.5, y: sy + 0.5 });
    const coverage = selectionSampleAt(selection, documentPoint.x, documentPoint.y), offset = (y * region.width + x) * 4;
    const alpha = Math.round(rasterByte(source, sx, sy, 3) * coverage / 255);
    out[offset] = rasterByte(source, sx, sy); out[offset + 1] = rasterByte(source, sx, sy, 1);
    out[offset + 2] = rasterByte(source, sx, sy, 2); out[offset + 3] = alpha;
    if (alpha) any = true;
  }
  return any ? { raster: Raster.fromPixels(region.width, region.height, 4, out, { format: source.format }), rect: region } : null;
}

function sampleLifted(raster: Raster, x: number, y: number, smooth: boolean): [number, number, number, number] {
  if (!smooth) {
    const ix = Math.floor(x), iy = Math.floor(y);
    return [rasterByte(raster, ix, iy), rasterByte(raster, ix, iy, 1), rasterByte(raster, ix, iy, 2), rasterByte(raster, ix, iy, 3)];
  }
  const u = x - 0.5, v = y - 0.5, x0 = Math.floor(u), y0 = Math.floor(v), fx = u - x0, fy = v - y0;
  const weights = [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy];
  const xs = [x0, x0 + 1, x0, x0 + 1], ys = [y0, y0, y0 + 1, y0 + 1];
  let alpha = 0, red = 0, green = 0, blue = 0;
  for (let i = 0; i < 4; i++) {
    const a = rasterByte(raster, xs[i]!, ys[i]!, 3) / raster.maximum, weight = weights[i]!;
    alpha += a * weight; red += rasterByte(raster, xs[i]!, ys[i]!) * a * weight;
    green += rasterByte(raster, xs[i]!, ys[i]!, 1) * a * weight; blue += rasterByte(raster, xs[i]!, ys[i]!, 2) * a * weight;
  }
  return alpha > 0 ? [Math.round(red / alpha), Math.round(green / alpha), Math.round(blue / alpha),
    Math.round(alpha * raster.maximum)] : [0, 0, 0, 0];
}

function renderInPlacePixelMove(state: PixelMoveState, target: Rect, placed: Rect, toDocument: Affine): Raster {
  const source = state.originalRaster;
  const tiles = source.tiles, mutable = new Map<number, PixelArray>();
  const outputTiles = tiles.slice();
  const writable = (x: number, y: number): { tile: PixelArray; offset: number } => {
    const col = Math.floor(x / TILE), row = Math.floor(y / TILE), key = row * source.cols + col;
    let tile = mutable.get(key);
    if (!tile) {
      tile = outputTiles[key]?.slice() ?? makePixelArray(source.format, source.tileWidth(col) * source.tileHeight(row) * 4);
      mutable.set(key, tile); outputTiles[key] = tile;
    }
    return { tile, offset: ((y - row * TILE) * source.tileWidth(col) + x - col * TILE) * 4 };
  };
  if (!state.duplicate) {
    for (let y = 0; y < state.liftedRect.height; y++) for (let x = 0; x < state.liftedRect.width; x++) {
      const sx = state.liftedRect.x + x, sy = state.liftedRect.y + y;
      const point = apply(toDocument, { x: sx + 0.5, y: sy + 0.5 });
      const coverage = selectionSampleAt(state.origin, point.x, point.y) / 255;
      if (coverage === 0 || rasterByte(source, sx, sy, 3) === 0) continue;
      const pixel = writable(sx, sy); pixel.tile[pixel.offset + 3] = Math.round(pixel.tile[pixel.offset + 3]! * (1 - coverage));
      if (pixel.tile[pixel.offset + 3] === 0) {
        pixel.tile[pixel.offset] = 0; pixel.tile[pixel.offset + 1] = 0; pixel.tile[pixel.offset + 2] = 0;
      }
    }
  }
  const draw = integralRect(placed), smooth = !Number.isInteger(target.x) || !Number.isInteger(target.y);
  for (let y = draw.y; y < draw.y + draw.height; y++) for (let x = draw.x; x < draw.x + draw.width; x++) {
    const rgba = sampleLifted(state.lifted, x + 0.5 - target.x, y + 0.5 - target.y, smooth);
    if (rgba[3] === 0) continue;
    const pixel = writable(x, y);
    sourceOver(pixel.tile, pixel.offset, rgba[0], rgba[1], rgba[2], rgba[3], source.maximum);
  }
  for (const [key, tile] of mutable) if (!tile.some((value) => value !== 0)) outputTiles[key] = null;
  return new Raster(source.width, source.height, 4, outputTiles, { format: source.format });
}

function renderPixelMove(session: EditorSession, state: PixelMoveState, offset: Point):
  { raster: Raster; transform: LayerTransform; bounds: Rect } | null {
  const document = session.document, source = state.originalRaster;
  if (!document) return null;
  const toDocument = pixelToDocument(state.originalTransform, source.width, source.height), toPixels = invert(toDocument);
  const zero = apply(toPixels, { x: 0, y: 0 }), shifted = apply(toPixels, offset);
  const dx = shifted.x - zero.x, dy = shifted.y - zero.y;
  const target = { x: state.liftedRect.x + dx, y: state.liftedRect.y + dy,
    width: state.liftedRect.width, height: state.liftedRect.height };
  // BrushStroke.makeRasterEdit makes the editable grid cover the canvas, but not space beyond it.
  const canvasPixels = integralRect(mappedRectBounds({ x: 0, y: 0, width: document.width, height: document.height }, toPixels));
  const allowed = rectUnion({ x: 0, y: 0, width: source.width, height: source.height }, canvasPixels);
  const placed = rectIntersection(target, allowed);
  const bounds = integralRect(placed ? rectUnion({ x: 0, y: 0, width: source.width, height: source.height }, placed)
    : { x: 0, y: 0, width: source.width, height: source.height });
  const budget = source.width * source.height + session.remainingPixelBudget();
  if (bounds.width > MAX_SIDE || bounds.height > MAX_SIDE || bounds.width * bounds.height > Math.min(MAX_PIXELS, budget)) return null;
  if (placed && bounds.x === 0 && bounds.y === 0 && bounds.width === source.width && bounds.height === source.height) {
    return { raster: renderInPlacePixelMove(state, target, placed, toDocument), transform: state.originalTransform, bounds };
  }
  const out = source.readRegionNative(bounds.x, bounds.y, bounds.width, bounds.height);
  if (!state.duplicate) {
    for (let y = 0; y < state.liftedRect.height; y++) for (let x = 0; x < state.liftedRect.width; x++) {
      const sx = state.liftedRect.x + x, sy = state.liftedRect.y + y;
      const documentPoint = apply(toDocument, { x: sx + 0.5, y: sy + 0.5 });
      const coverage = selectionSampleAt(state.origin, documentPoint.x, documentPoint.y) / 255;
      if (coverage === 0) continue;
      const ox = sx - bounds.x, oy = sy - bounds.y;
      if (ox < 0 || oy < 0 || ox >= bounds.width || oy >= bounds.height) continue;
      const index = (oy * bounds.width + ox) * 4;
      out[index + 3] = Math.round(out[index + 3]! * (1 - coverage));
      if (out[index + 3] === 0) { out[index] = 0; out[index + 1] = 0; out[index + 2] = 0; }
    }
  }
  if (placed) {
    const draw = integralRect(placed), smooth = !Number.isInteger(target.x) || !Number.isInteger(target.y);
    for (let sy = draw.y; sy < draw.y + draw.height; sy++) for (let sx = draw.x; sx < draw.x + draw.width; sx++) {
      const rgba = sampleLifted(state.lifted, sx + 0.5 - target.x, sy + 0.5 - target.y, smooth);
      const ox = sx - bounds.x, oy = sy - bounds.y;
      sourceOver(out, (oy * bounds.width + ox) * 4, rgba[0], rgba[1], rgba[2], rgba[3], source.maximum);
    }
  }
  return { raster: Raster.fromPixels(bounds.width, bounds.height, 4, out, { format: source.format }),
    transform: transformForPixelBounds(state.originalTransform, source.width, source.height, bounds), bounds };
}

/** Starts Cmd-drag (cut) or Option-Cmd-drag (duplicate); the document remains untouched until commit. */
export function beginPixelMove(session: EditorSession, duplicate = false): boolean {
  if (pixelMoves.has(session) || session.isMaskSelected || !canEditPixels(session)) return false;
  const document = session.document, layer = session.activeLayer, selection = session.selection;
  if (!document || !layer?.raster || !selection || selectionIsEmpty(selection)) return false;
  const lifted = liftPixels(document, layer, selection); if (!lifted) return false;
  pixelMoves.set(session, { layerId: layer.id, duplicate, origin: selection, originalRaster: layer.raster,
    originalTransform: layer.transform, lifted: lifted.raster, liftedRect: lifted.rect, offset: { x: 0, y: 0 },
    preview: null, previewTransform: null, previewBounds: null });
  return true;
}

/** Rebuilds the preview from the original pixels, so repeated pointer moves never accumulate. */
export function movePixels(session: EditorSession, dx: number, dy: number): boolean {
  const state = pixelMoves.get(session); if (!state) return false;
  const offset = { x: roundHalfAway(dx), y: roundHalfAway(dy) }, rendered = renderPixelMove(session, state, offset);
  if (!rendered) { cancelPixelMove(session); return false; }
  const next = { ...state, offset, preview: rendered.raster, previewTransform: rendered.transform, previewBounds: rendered.bounds };
  pixelMoves.set(session, next); session.rasterOverrides.set(state.layerId, rendered.raster); session.notify('document'); return true;
}

function expandedMoveMask(layer: Layer, source: Raster, bounds: Rect): Layer['mask'] {
  const mask = layer.mask;
  if (!mask || mask.placement || (bounds.x === 0 && bounds.y === 0 && bounds.width === source.width && bounds.height === source.height)) return mask;
  const out = new Uint8Array(bounds.width * bounds.height);
  const overlap = rectIntersection(bounds, { x: 0, y: 0, width: source.width, height: source.height });
  if (!overlap) return { ...mask, raster: Raster.fromPixels(bounds.width, bounds.height, 1, out) };
  if (mask.raster.width === 1 && mask.raster.height === 1) {
    const value = mask.raster.pixel(0, 0)[0]!;
    for (let y = 0; y < overlap.height; y++) {
      const destination = (overlap.y - bounds.y + y) * bounds.width + overlap.x - bounds.x;
      out.fill(value, destination, destination + overlap.width);
    }
  } else {
    const current = mask.raster.readRegion(overlap.x, overlap.y, overlap.width, overlap.height);
    for (let y = 0; y < overlap.height; y++) out.set(current.subarray(y * overlap.width, (y + 1) * overlap.width),
      (overlap.y - bounds.y + y) * bounds.width + overlap.x - bounds.x);
  }
  return { ...mask, raster: Raster.fromPixels(bounds.width, bounds.height, 1, out) };
}

/** Commits pixels and moved outline together as one upstream-named undo entry. */
export function finishPixelMove(session: EditorSession): boolean {
  const state = pixelMoves.get(session);
  if (!state || session.isProjectBusy) return false;
  if (state.offset.x === 0 && state.offset.y === 0) { cancelPixelMove(session); return false; }
  const current = session.layer(state.layerId);
  if (!current || current.raster !== state.originalRaster || !transformsEqual(current.transform, state.originalTransform)) {
    cancelPixelMove(session); return false;
  }
  const rendered = state.preview && state.previewBounds && state.previewTransform
    ? { raster: state.preview, bounds: state.previewBounds, transform: state.previewTransform }
    : renderPixelMove(session, state, state.offset);
  if (!rendered) { cancelPixelMove(session); return false; }
  const alpha = alphaBounds(rendered.raster);
  const local = alpha ?? { x: 0, y: 0, width: rendered.raster.width, height: rendered.raster.height };
  const bounds = { x: rendered.bounds.x + local.x, y: rendered.bounds.y + local.y, width: local.width, height: local.height };
  const raster = local.x === 0 && local.y === 0 && local.width === rendered.raster.width && local.height === rendered.raster.height
    ? rendered.raster : cropRaster(rendered.raster, local.x, local.y, local.width, local.height);
  const transform = transformForPixelBounds(state.originalTransform, state.originalRaster.width, state.originalRaster.height, bounds);
  const selection = moveSelection(state.origin, state.offset.x, state.offset.y);
  const mask = expandedMoveMask(current, state.originalRaster, bounds);
  pixelMoves.delete(session); session.rasterOverrides.delete(state.layerId);
  session.edit(state.duplicate ? 'Duplicate Pixels' : 'Move Pixels', () => {
    const document = session.document; if (!document) return;
    const layers = document.layers.map((layer) => layer.id === state.layerId ? withLayerRaster(layer, raster, transform, mask) : layer);
    session.replaceDocument({ ...document, layers, selection });
  });
  return true;
}

/** Drops the transient override; because begin/move never mutate the document this restores it exactly. */
export function cancelPixelMove(session: EditorSession): void {
  const state = pixelMoves.get(session); if (!state) return;
  pixelMoves.delete(session); session.rasterOverrides.delete(state.layerId); session.notify('document');
}

/** Cmd-arrow helper: one begin/move/finish cycle and therefore one undo step. */
export function nudgePixels(session: EditorSession, dx: number, dy: number): boolean {
  if (!beginPixelMove(session, false)) return false;
  if (!movePixels(session, dx, dy)) return false;
  return finishPixelMove(session);
}

export function displayedSelection(session: EditorSession): DocumentSelection | null {
  const move = pixelMoves.get(session);
  if (move) return moveSelection(move.origin, move.offset.x, move.offset.y);
  const selection = session.selection, edit = session.transformEdit, document = session.document;
  if (!selection || !edit?.floating || !document) return selection;
  return edit.corners
    ? distortedSelection(selection, edit.floating.original, edit.corners, edit.floating.pixelSize.width, edit.floating.pixelSize.height)
    : transformedSelection(selection, edit.floating.original, edit.draft, edit.floating.pixelSize.width,
      edit.floating.pixelSize.height, document);
}
