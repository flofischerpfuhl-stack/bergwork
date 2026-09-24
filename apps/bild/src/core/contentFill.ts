/** Content-Aware Fill edit state machine. Ported from ContentFill.swift and Filters.swift. */

import { effectiveVisibleIds, type Layer, type LayerMask } from './document';
import { apply, integralRect, invert, pixelToDocument, rectIntersection, type LayerTransform, type Rect } from './geometry';
import { Raster, TILE } from './raster';
import { selectionIsEmpty, type DocumentSelection } from './selection';
import { selectionBounds } from './selectionOps';
import { selectionSampleAt } from './selectionCommands';
import type { EditorSession } from './session';
import { KernelCancelledError, KernelClient, type KernelJob } from '../workers/kernelClient';

export type ContentFillPhase = 'preparing' | 'ready' | 'applying' | 'error' | 'cancelled' | 'applied';

/** Observable-by-session-notification state for a non-UI panel or command surface. */
export interface ContentFillState {
  readonly layerId: string;
  readonly originalRaster: Raster;
  readonly originalTransform: LayerTransform;
  readonly grownRaster: Raster;
  readonly grownTransform: LayerTransform;
  readonly selection: DocumentSelection;
  phase: ContentFillPhase;
  previewRaster: Raster | null;
  previewTransform: LayerTransform;
  error: string | null;
}

interface InternalState extends ContentFillState {
  readonly documentId: string;
  readonly coverage: Uint8Array;
  readonly sourceRect: Rect;
  readonly kernels: KernelClient;
  generation: number;
  job: KernelJob<Uint8Array> | null;
  pending: Promise<Raster | null> | null;
}

export interface ContentFillOptions { readonly kernels?: KernelClient }

export interface RetouchCommand {
  enabled(): boolean;
  run(): void;
}

export type RetouchCommands = Record<'contentAwareFill', RetouchCommand>;

const states = new WeakMap<EditorSession, InternalState>();
const clients = new WeakMap<EditorSession, KernelClient>();

function clientFor(session: EditorSession): KernelClient {
  let client = clients.get(session);
  if (!client) { client = new KernelClient(); clients.set(session, client); }
  return client;
}

export function contentFillState(session: EditorSession): ContentFillState | null { return states.get(session) ?? null; }

export function canContentAwareFill(session: EditorSession): boolean {
  const layer = session.activeLayer, selection = session.selection;
  return !states.has(session) && session.canEditLayers && session.selectedLayerIds.size === 1 && !session.isMaskSelected
    && !!layer && layer.kind !== 'group' && !layer.adjustment && !layer.locked && !!layer.raster && layer.raster.channels === 4
    && effectiveVisibleIds(session.document!.layers).has(layer.id) && !!selection && !selectionIsEmpty(selection);
}

/** Starts the automatic filter and schedules its full-size preview, as FilterEdit does upstream. */
export function beginContentAwareFill(session: EditorSession, options: ContentFillOptions = {}): ContentFillState | null {
  if (!canContentAwareFill(session)) return null;
  const document = session.document!, layer = session.activeLayer!, selection = document.selection!;
  try {
    const grown = growToSelection(layer, selection, document.width, document.height);
    const coverage = selectionMask(selection, grown.transform, grown.raster.width, grown.raster.height);
    const state: InternalState = {
      layerId: layer.id,
      originalRaster: layer.raster!,
      originalTransform: layer.transform,
      grownRaster: grown.raster,
      grownTransform: grown.transform,
      selection,
      phase: 'preparing',
      previewRaster: null,
      previewTransform: grown.transform,
      error: null,
      documentId: document.id,
      coverage,
      sourceRect: grown.sourceRect,
      kernels: options.kernels ?? clientFor(session),
      generation: 0,
      job: null,
      pending: null,
    };
    states.set(session, state);
    // Reuse the session's existing editing lock so layer/history commands cannot race this edit.
    session.adjustmentEditingId = layer.id;
    session.notify('ui');
    void previewContentAwareFill(session);
    return state;
  } catch (error) {
    session.errorMessage = error instanceof Error ? error.message : String(error); session.notify('ui'); return null;
  }
}

/** Runs/restarts the worker preview. Only the newest generation may publish an override. */
export function previewContentAwareFill(session: EditorSession): Promise<Raster | null> {
  const state = states.get(session);
  if (!state || state.phase === 'cancelled' || state.phase === 'applied' || state.phase === 'applying') return Promise.resolve(null);
  if (state.job) state.kernels.cancel(state.job.id);
  const generation = ++state.generation;
  state.phase = 'preparing'; state.error = null;
  const width = state.grownRaster.width, height = state.grownRaster.height;
  const source = premultiply(state.grownRaster.toPixels());
  const job = state.kernels.contentFill(source, width * 4, state.coverage, width, width, height);
  state.job = job;
  const pending = job.then((filled) => {
    if (!isCurrent(session, state, generation)) { discardStale(session, state, generation); return null; }
    const blended = blendSelection(source, filled, state.coverage);
    const raster = Raster.fromPixels(width, height, 4, unpremultiply(blended));
    state.previewRaster = raster; state.phase = 'ready'; state.error = null; state.job = null; state.pending = null;
    session.rasterOverrides.set(state.layerId, raster);
    session.notify('document');
    return raster;
  }, (error: unknown) => {
    if (!isCurrent(session, state, generation)) { discardStale(session, state, generation); return null; }
    state.job = null; state.pending = null;
    if (!(error instanceof KernelCancelledError)) {
      state.phase = 'error'; state.error = contentFillError(error); session.rasterOverrides.delete(state.layerId);
      session.notify('document');
    }
    return null;
  });
  state.pending = pending;
  session.notify('ui');
  return pending;
}

/** Commits the prepared preview as one undo step. An errored edit remains open, matching FilterEdit. */
export async function applyContentAwareFill(session: EditorSession): Promise<boolean> {
  const state = states.get(session);
  if (!state || state.phase === 'cancelled' || state.phase === 'applied' || state.phase === 'applying') return false;
  if (state.pending) await state.pending;
  if (states.get(session) !== state || !state.previewRaster || state.phase === 'error') return false;
  const document = session.document, index = document?.layers.findIndex((layer) => layer.id === state.layerId) ?? -1;
  const current = index >= 0 ? document!.layers[index]! : null;
  if (!current || document!.id !== state.documentId || current.raster !== state.originalRaster
    || !sameTransform(current.transform, state.originalTransform)) {
    cancelContentAwareFill(session);
    return false;
  }
  state.phase = 'applying'; session.isProjectBusy = true; session.notify('ui');
  try {
    let mask = current.mask;
    if (mask && !mask.placement && (mask.raster.width > 1 || mask.raster.height > 1)
      && (state.previewRaster.width !== state.originalRaster.width || state.previewRaster.height !== state.originalRaster.height)) {
      mask = carryAttachedMask(mask, state.previewRaster.width, state.previewRaster.height, state.sourceRect,
        state.originalRaster.width, state.originalRaster.height);
    }
    const layers = document!.layers.slice();
    layers[index] = { ...current, raster: state.previewRaster, transform: state.grownTransform, mask };
    session.rasterOverrides.delete(state.layerId);
    session.adjustmentEditingId = null;
    session.beginEdit('Content-Aware Fill'); session.replaceDocument({ ...document!, layers }); session.endEdit();
    state.phase = 'applied'; states.delete(session);
    return true;
  } finally {
    session.isProjectBusy = false;
    if (states.get(session) === state && state.phase === 'applying') state.phase = 'ready';
    session.notify('document');
  }
}

export function cancelContentAwareFill(session: EditorSession): boolean {
  const state = states.get(session);
  if (!state || state.phase === 'applying') return false;
  state.generation++;
  if (state.job) state.kernels.cancel(state.job.id);
  state.job = null; state.pending = null; state.phase = 'cancelled';
  session.rasterOverrides.delete(state.layerId);
  if (session.adjustmentEditingId === state.layerId) session.adjustmentEditingId = null;
  states.delete(session); session.notify('document'); return true;
}

/** Aliases use the shorter Edit-menu terminology while preserving the explicit public names above. */
export const beginContentFill = beginContentAwareFill;
export const previewContentFill = previewContentAwareFill;
export const applyContentFill = applyContentAwareFill;
export const cancelContentFill = cancelContentAwareFill;

export function retouchCommands(session: EditorSession): RetouchCommands {
  return {
    contentAwareFill: {
      enabled: () => canContentAwareFill(session),
      run: () => { beginContentAwareFill(session); },
    },
  };
}

function isCurrent(session: EditorSession, state: InternalState, generation: number): boolean {
  const document = session.document, layer = session.layer(state.layerId);
  return states.get(session) === state && state.generation === generation && state.phase !== 'cancelled'
    && document?.id === state.documentId && layer?.raster === state.originalRaster
    && sameTransform(layer.transform, state.originalTransform);
}

function discardStale(session: EditorSession, state: InternalState, generation: number): void {
  if (states.get(session) !== state || state.generation !== generation) return;
  state.phase = 'cancelled'; state.job = null; state.pending = null;
  session.rasterOverrides.delete(state.layerId);
  if (session.adjustmentEditingId === state.layerId) session.adjustmentEditingId = null;
  states.delete(session); session.notify('document');
}

/** FilterEdit.grow(to:): union the old pixel grid with the canvas-clipped selection bounds. */
function growToSelection(layer: Layer, selection: DocumentSelection, canvasWidth: number, canvasHeight: number): {
  raster: Raster; transform: LayerTransform; sourceRect: Rect;
} {
  const source = layer.raster!, selected = selectionBounds(selection);
  const clipped = selected && rectIntersection(selected, { x: 0, y: 0, width: canvasWidth, height: canvasHeight });
  if (!clipped) return { raster: source, transform: layer.transform,
    sourceRect: { x: 0, y: 0, width: source.width, height: source.height } };
  const inverse = invert(pixelToDocument(layer.transform, source.width, source.height));
  const points = [
    apply(inverse, { x: clipped.x, y: clipped.y }), apply(inverse, { x: clipped.x + clipped.width, y: clipped.y }),
    apply(inverse, { x: clipped.x, y: clipped.y + clipped.height }),
    apply(inverse, { x: clipped.x + clipped.width, y: clipped.y + clipped.height }),
  ];
  const xs = points.map((point) => point.x), ys = points.map((point) => point.y);
  const extent = integralRect({ x: Math.min(...xs), y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) });
  const x = Math.min(0, extent.x), y = Math.min(0, extent.y);
  const right = Math.max(source.width, extent.x + extent.width), bottom = Math.max(source.height, extent.y + extent.height);
  const width = right - x, height = bottom - y;
  if (width > 30_000 || height > 30_000 || width * height > 100_000_000) throw new RangeError('Content-Aware Fill result is too large');
  if (x === 0 && y === 0 && width === source.width && height === source.height) {
    return { raster: source, transform: layer.transform, sourceRect: { x: 0, y: 0, width, height } };
  }
  const raster = expandedRaster(source, width, height, -x, -y);
  const mapping = pixelToDocument(layer.transform, source.width, source.height);
  const middle = apply(mapping, { x: x + width / 2, y: y + height / 2 });
  const size = { width: width * layer.transform.size.width / source.width,
    height: height * layer.transform.size.height / source.height };
  const transform = { ...layer.transform, size, origin: { x: middle.x - size.width / 2, y: middle.y - size.height / 2 } };
  return { raster, transform, sourceRect: { x: -x, y: -y, width: source.width, height: source.height } };
}

/** ContentFill.run: render the selection into the (possibly grown) layer grid. */
function selectionMask(selection: DocumentSelection, transform: LayerTransform, width: number, height: number): Uint8Array {
  const mapping = pixelToDocument(transform, width, height), mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const point = apply(mapping, { x: x + 0.5, y: y + 0.5 });
    mask[y * width + x] = selectionSampleAt(selection, point.x, point.y);
  }
  return mask;
}

function expandedRaster(source: Raster, width: number, height: number, offsetX: number, offsetY: number): Raster {
  if (source.width === width && source.height === height && offsetX === 0 && offsetY === 0) return source;
  let result = Raster.blank(width, height, 4);
  for (let row = 0; row < source.rows; row++) for (let col = 0; col < source.cols; col++) {
    const tile = source.tiles[row * source.cols + col];
    if (!tile) continue;
    const tw = source.tileWidth(col), th = source.tileHeight(row);
    result = result.withRegion(offsetX + col * TILE, offsetY + row * TILE, tw, th, tile);
  }
  return result;
}

/** PixelFilter.run's final selection blend, performed in premultiplied space. */
function blendSelection(original: Uint8Array, filled: Uint8Array, coverage: Uint8Array): Uint8Array {
  const output = filled.slice();
  for (let i = 0; i < coverage.length; i++) {
    const amount = coverage[i]! / 255, inverse = 1 - amount, p = i * 4;
    for (let c = 0; c < 4; c++) output[p + c] = Math.round(filled[p + c]! * amount + original[p + c]! * inverse);
  }
  return output;
}

function premultiply(pixels: Uint8Array): Uint8Array {
  for (let i = 0; i < pixels.length; i += 4) {
    const a = pixels[i + 3]!;
    pixels[i] = Math.round(pixels[i]! * a / 255); pixels[i + 1] = Math.round(pixels[i + 1]! * a / 255);
    pixels[i + 2] = Math.round(pixels[i + 2]! * a / 255);
  }
  return pixels;
}

function unpremultiply(pixels: Uint8Array): Uint8Array {
  for (let i = 0; i < pixels.length; i += 4) {
    const a = pixels[i + 3]!;
    if (!a) { pixels[i] = pixels[i + 1] = pixels[i + 2] = 0; continue; }
    pixels[i] = Math.min(255, Math.round(pixels[i]! * 255 / a));
    pixels[i + 1] = Math.min(255, Math.round(pixels[i + 1]! * 255 / a));
    pixels[i + 2] = Math.min(255, Math.round(pixels[i + 2]! * 255 / a));
  }
  return pixels;
}

/** Filters.commitFilter: carry an attached mask and use its majority edge tone beyond the old grid. */
function carryAttachedMask(mask: LayerMask, width: number, height: number, sourceRect: Rect,
  sourceWidth: number, sourceHeight: number): LayerMask {
  const background = maskBackground(mask.raster), pixels = new Uint8Array(width * height).fill(background);
  for (let y = 0; y < sourceHeight; y++) for (let x = 0; x < sourceWidth; x++) {
    const sx = Math.floor(x * mask.raster.width / sourceWidth), sy = Math.floor(y * mask.raster.height / sourceHeight);
    const dx = sourceRect.x + x, dy = sourceRect.y + y;
    if (dx >= 0 && dy >= 0 && dx < width && dy < height) pixels[dy * width + dx] = mask.raster.pixel(sx, sy)[0] ?? background;
  }
  return { ...mask, raster: Raster.fromPixels(width, height, 1, pixels) };
}

function maskBackground(mask: Raster): number {
  let total = 0, count = 0;
  for (let y = 0; y < mask.height; y++) for (let x = 0; x < mask.width; x++) {
    if (x !== 0 && y !== 0 && x !== mask.width - 1 && y !== mask.height - 1) continue;
    total += mask.pixel(x, y)[0] ?? 0; count++;
  }
  return total * 2 >= count * 255 ? 255 : 0;
}

function contentFillError(error: unknown): string {
  if (error instanceof Error && 'code' in error && error.code === 'no-source') {
    return 'Not enough unselected, opaque image pixels to synthesize a fill. Use a smaller selection with some surrounding image.';
  }
  return error instanceof Error ? error.message : String(error);
}

function sameTransform(a: LayerTransform, b: LayerTransform): boolean {
  return a.origin.x === b.origin.x && a.origin.y === b.origin.y && a.size.width === b.size.width
    && a.size.height === b.size.height && a.rotation === b.rotation && a.flipX === b.flipX && a.flipY === b.flipY;
}
