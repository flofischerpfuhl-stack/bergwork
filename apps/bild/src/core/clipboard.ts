/** In-memory pixel clipboard; platform PNG integration is deliberately callback-based. */

import { maskTransform, type CanvasDocument, type Layer } from './document';
import { apply, invert, pixelToDocument, rectIntersection, type LayerTransform, type Rect } from './geometry';
import { Raster } from './raster';
import type { EditorSession } from './session';
import { selectionIsEmpty } from './selection';
import { selectionBounds } from './selectionOps';
import { canEditPixels, clearSelectedPixels, selectionSampleAt } from './selectionCommands';

export interface PixelClipboardEntry { readonly raster: Raster; readonly origin: { readonly x: number; readonly y: number } }

export interface ClipboardHooks {
  /** The platform adapter may encode and publish PNG data; core never assumes a DOM Clipboard API. */
  readonly toPngBlobData?: (raster: Raster) => void | Promise<void>;
  /** Optional platform decoder for Paste; returned pixels are centred like an external image upstream. */
  readonly readExternalRaster?: () => Raster | null | Promise<Raster | null>;
}

export class InMemoryPixelClipboard {
  private value: PixelClipboardEntry | null = null;
  get entry(): PixelClipboardEntry | null { return this.value; }
  store(entry: PixelClipboardEntry): void { this.value = entry; }
  clear(): void { this.value = null; }
}

export const pixelClipboard = new InMemoryPixelClipboard();

export function selectionCopyRegion(document: CanvasDocument): Rect | null {
  const canvas = { x: 0, y: 0, width: document.width, height: document.height };
  if (!document.selection) return canvas;
  const bounds = selectionBounds(document.selection);
  return bounds ? rectIntersection(bounds, canvas) : null;
}

function sampleNearest(raster: Raster, transform: LayerTransform, x: number, y: number): number[] {
  const source = apply(invert(pixelToDocument(transform, raster.width, raster.height)), { x, y });
  return raster.pixel(Math.floor(source.x), Math.floor(source.y));
}

/** SelectionClipboard.swift `renderSelectedPixels`, in document placement with soft selection alpha. */
export function renderSelectedPixels(document: CanvasDocument, layer: Layer, mask = false): PixelClipboardEntry | null {
  const selection = document.selection;
  if (selection && selectionIsEmpty(selection)) return null;
  const region = selectionCopyRegion(document); if (!region) return null;
  const width = region.width, height = region.height, out = new Uint8Array(width * height * 4);
  const raster = mask ? layer.mask?.raster ?? null : layer.raster;
  if (!raster) return null;
  const transform = mask ? maskTransform(layer) : layer.transform;
  for (let py = 0; py < height; py++) for (let px = 0; px < width; px++) {
    const docX = region.x + px + 0.5, docY = region.y + py + 0.5;
    const coverage = selectionSampleAt(selection, docX, docY) / 255;
    if (coverage === 0) continue;
    const source = sampleNearest(raster, transform, docX, docY), offset = (py * width + px) * 4;
    if (mask) {
      const gray = source[0] ?? 0; out[offset] = gray; out[offset + 1] = gray; out[offset + 2] = gray;
      out[offset + 3] = Math.round(255 * coverage);
    } else {
      const alpha = (source[3] ?? 0) * coverage;
      out[offset] = source[0] ?? 0; out[offset + 1] = source[1] ?? 0; out[offset + 2] = source[2] ?? 0;
      out[offset + 3] = Math.round(alpha);
      if (out[offset + 3] === 0) { out[offset] = 0; out[offset + 1] = 0; out[offset + 2] = 0; }
    }
  }
  return { raster: Raster.fromPixels(width, height, 4, out), origin: { x: region.x, y: region.y } };
}

export function canCopyPixels(session: EditorSession): boolean {
  const layer = session.activeLayer;
  if (!session.document || !layer || !session.canEditLayers || session.selection && selectionIsEmpty(session.selection)) return false;
  return session.isMaskSelected ? !!layer.mask : !layer.isGroup && !!layer.raster;
}

export function copySelection(session: EditorSession, clipboard = pixelClipboard, hooks: ClipboardHooks = {}): boolean {
  if (!canCopyPixels(session) || !session.document || !session.activeLayer) return false;
  const copied = renderSelectedPixels(session.document, session.activeLayer, session.isMaskSelected);
  if (!copied) return false;
  clipboard.store(copied); void hooks.toPngBlobData?.(copied.raster); return true;
}

export function canCopyMerged(session: EditorSession): boolean {
  return !!session.document && session.canEditLayers && !(session.selection && selectionIsEmpty(session.selection))
    && session.document.layers.some((layer) => layer.visible && !!layer.raster);
}

export async function copyMergedSelection(session: EditorSession, clipboard = pixelClipboard,
  hooks: ClipboardHooks = {}): Promise<boolean> {
  const document = session.document, flatten = session.services?.flatten;
  if (!document || !flatten || !canCopyMerged(session)) return false;
  const region = selectionCopyRegion(document); if (!region) return false;
  const full = await flatten(document);
  if (full.channels !== 4 || full.width !== document.width || full.height !== document.height) return false;
  const data = full.readRegion(region.x, region.y, region.width, region.height);
  if (document.selection) {
    for (let y = 0; y < region.height; y++) for (let x = 0; x < region.width; x++) {
      const f = selectionSampleAt(document.selection, region.x + x + 0.5, region.y + y + 0.5) / 255;
      const offset = (y * region.width + x) * 4;
      data[offset + 3] = Math.round(data[offset + 3]! * f);
      if (data[offset + 3] === 0) { data[offset] = 0; data[offset + 1] = 0; data[offset + 2] = 0; }
    }
  }
  const copied = { raster: Raster.fromPixels(region.width, region.height, 4, data), origin: { x: region.x, y: region.y } };
  clipboard.store(copied); await hooks.toPngBlobData?.(copied.raster); return true;
}

export function cutSelection(session: EditorSession, clipboard = pixelClipboard, hooks: ClipboardHooks = {}): boolean {
  if (!session.selection || !copySelection(session, clipboard, hooks)) return false;
  return clearSelectedPixels(session);
}

export function canPaste(session: EditorSession, clipboard = pixelClipboard, externalAvailable = false): boolean {
  return !!session.document && session.canEditLayers && (!!clipboard.entry || externalAvailable);
}

/** Internal pixels return to their original position; external pixels are centred. */
export async function paste(session: EditorSession, clipboard = pixelClipboard, hooks: ClipboardHooks = {}): Promise<string | null> {
  const document = session.document;
  if (!document || !session.canEditLayers) return null;
  let entry = clipboard.entry;
  if (!entry && hooks.readExternalRaster) {
    const external = await hooks.readExternalRaster();
    if (external?.channels === 4) entry = { raster: external, origin: {
      x: Math.floor((document.width - external.width) / 2), y: Math.floor((document.height - external.height) / 2),
    } };
  }
  if (!entry) return null;
  return session.addPixelLayer(entry.raster, entry.origin, session.nextLayerName(), 'Paste');
}

/** Cmd-J: selected pixels become a layer in place; no selection duplicates the layer. */
export function layerViaCopy(session: EditorSession): string | null {
  const layer = session.activeLayer;
  if (!session.canEditLayers || !layer || layer.isGroup || session.selection && selectionIsEmpty(session.selection)) return null;
  if (!session.selection) { session.duplicateActiveLayer(); return session.activeLayerId; }
  const copied = renderSelectedPixels(session.document!, layer, session.isMaskSelected);
  return copied ? session.addPixelLayer(copied.raster, copied.origin, session.nextLayerName(), 'Layer via Copy') : null;
}

export function canCutPixels(session: EditorSession): boolean { return !!session.selection && canCopyPixels(session) && canEditPixels(session); }
