/** Magic Wand selection engine. Ported from Document/MagicWand.swift. */

import { apply, invert, pixelToDocument, type Point } from './geometry';
import { Raster, TILE } from './raster';
import type { DocumentSelection, SelectionMode } from './selection';
import { applySelection, deselect } from './selectionCommands';
import { coverageSelection } from './selectionOps';
import type { EditorSession } from './session';
import { KernelClient } from '../workers/kernelClient';

export type WandSampleSize = 'point' | 'threeByThree' | 'fiveByFive';

export interface WandSettings {
  /** Per-premultiplied-channel difference, clamped to 0...255. */
  readonly tolerance: number;
  readonly sampleSize: WandSampleSize;
  readonly contiguous: boolean;
  readonly sampleAllLayers: boolean;
  readonly antialias: boolean;
}

export const DEFAULT_WAND_SETTINGS: WandSettings = {
  tolerance: 32,
  sampleSize: 'point',
  contiguous: true,
  sampleAllLayers: false,
  antialias: true,
};

/** Canvas input should always make a wand selection, even when the click is inside the old one. */
export const WAND_MOVES_EXISTING_SELECTION = false;

const clients = new WeakMap<EditorSession, KernelClient>();

function kernelClient(session: EditorSession): KernelClient {
  let client = clients.get(session);
  if (!client) { client = new KernelClient(); clients.set(session, client); }
  return client;
}

/**
 * Selects pixels similar to `point`, combining them with the document selection as one undo step.
 * The returned value is the installed selection, or null when the operation was rejected/cleared.
 */
export async function magicWand(session: EditorSession, point: Point, mode: SelectionMode,
  settings: WandSettings = DEFAULT_WAND_SETTINGS, kernels = kernelClient(session)): Promise<DocumentSelection | null> {
  const document = session.document;
  if (!document || !session.canEditLayers || session.isProjectBusy || !Number.isFinite(point.x) || !Number.isFinite(point.y)
    || point.x < 0 || point.y < 0 || point.x >= document.width || point.y >= document.height) return null;

  const originalId = document.id;
  session.isProjectBusy = true;
  session.notify('ui');
  try {
    const rgba = await wandSample(session, settings.sampleAllLayers);
    if (!rgba) return null;
    const x = Math.floor(point.x), y = Math.floor(point.y);
    const radius = settings.sampleSize === 'fiveByFive' ? 2 : settings.sampleSize === 'threeByThree' ? 1 : 0;
    const tolerance = Math.min(255, Math.max(0, Math.trunc(settings.tolerance)));
    const result = await kernels.wandMask(rgba, document.width, document.height, document.width * 4,
      x, y, radius, tolerance, settings.contiguous);
    if (session.document?.id !== originalId) return null;
    if (result.count === 0) {
      session.isProjectBusy = false;
      if (mode === 'New') deselect(session);
      return session.selection;
    }
    // MagicWand.outline supplies the selection path and enforces WandPixels.c's edge limit.
    // DocumentSelection stores coverage, so validate the trace but retain its exactly equivalent mask.
    await kernels.wandTrace(result.mask, document.width, document.height);
    if (session.document?.id !== originalId) return null;
    // MagicWand.swift releases the project-busy gate before installing the selection.
    session.isProjectBusy = false;
    const shape = coverageSelection(Raster.fromPixels(document.width, document.height, 1, result.mask),
      0, 0, document, settings.antialias);
    applySelection(session, shape, mode, 'Magic Wand');
    return session.selection;
  } catch (error) {
    session.errorMessage = error instanceof Error ? error.message : String(error);
    session.notify('ui');
    return null;
  } finally {
    session.isProjectBusy = false;
    session.notify('ui');
  }
}

/** MagicWand.wandSample: a document-sized premultiplied RGBA sample. */
async function wandSample(session: EditorSession, allLayers: boolean): Promise<Uint8Array | null> {
  const document = session.document;
  if (!document) return null;
  if (allLayers) {
    const raster = await session.services?.flatten(document);
    if (!raster || raster.channels !== 4 || raster.width !== document.width || raster.height !== document.height) return null;
    return premultiply(raster.toPixels());
  }
  const layer = session.activeLayer;
  if (!layer || layer.kind === 'group' || !layer.raster || layer.raster.channels !== 4) {
    return new Uint8Array(document.width * document.height * 4);
  }
  return drawLayerPremultiplied(layer.raster, session.displayedTransform(layer), document.width, document.height);
}

function drawLayerPremultiplied(source: Raster, transform: ReturnType<EditorSession['displayedTransform']>,
  width: number, height: number): Uint8Array {
  const map = pixelToDocument(transform, source.width, source.height);
  if (map.a === 1 && map.b === 0 && map.c === 0 && map.d === 1 && map.tx === 0 && map.ty === 0
    && source.width === width && source.height === height) return premultiply(source.toPixels());
  const inverse = invert(map), output = new Uint8Array(width * height * 4);
  const smooth = transform.sampling !== 'Nearest';
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = apply(inverse, { x: x + 0.5, y: y + 0.5 });
    const offset = (y * width + x) * 4;
    if (smooth) sampleBilinearPremultiplied(source, p.x - 0.5, p.y - 0.5, output, offset);
    else sampleNearestPremultiplied(source, Math.floor(p.x), Math.floor(p.y), output, offset);
  }
  return output;
}

function sampleNearestPremultiplied(source: Raster, x: number, y: number, out: Uint8Array, offset: number): void {
  if (x < 0 || y < 0 || x >= source.width || y >= source.height) return;
  const col = Math.floor(x / TILE), row = Math.floor(y / TILE), tile = source.tiles[row * source.cols + col];
  if (!tile) return;
  const p = ((y - row * TILE) * source.tileWidth(col) + x - col * TILE) * 4, a = tile[p + 3]!;
  out[offset] = Math.round(tile[p]! * a / 255);
  out[offset + 1] = Math.round(tile[p + 1]! * a / 255);
  out[offset + 2] = Math.round(tile[p + 2]! * a / 255);
  out[offset + 3] = a;
}

function sampleBilinearPremultiplied(source: Raster, x: number, y: number, out: Uint8Array, offset: number): void {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const weights = [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy];
  const xs = [x0, x0 + 1, x0, x0 + 1], ys = [y0, y0, y0 + 1, y0 + 1];
  let r = 0, g = 0, b = 0, a = 0;
  for (let i = 0; i < 4; i++) {
    const px = xs[i]!, py = ys[i]!, weight = weights[i]!;
    if (px < 0 || py < 0 || px >= source.width || py >= source.height) continue;
    const value = source.pixel(px, py), alpha = value[3]!;
    r += value[0]! * alpha / 255 * weight; g += value[1]! * alpha / 255 * weight;
    b += value[2]! * alpha / 255 * weight; a += alpha * weight;
  }
  out[offset] = Math.round(r); out[offset + 1] = Math.round(g); out[offset + 2] = Math.round(b); out[offset + 3] = Math.round(a);
}

function premultiply(pixels: Uint8Array): Uint8Array {
  const output = pixels.slice();
  for (let i = 0; i < output.length; i += 4) {
    const alpha = output[i + 3]!;
    output[i] = Math.round(output[i]! * alpha / 255);
    output[i + 1] = Math.round(output[i + 1]! * alpha / 255);
    output[i + 2] = Math.round(output[i + 2]! * alpha / 255);
  }
  return output;
}
