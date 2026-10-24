import { Raster } from '../raster';
import type { DocumentSelection } from '../selection';
import { setSelection } from '../selectionCommands';
import type { EditorSession } from '../session';

export interface QuickMaskColour { readonly red: number; readonly green: number; readonly blue: number; readonly opacity: number }
export const DEFAULT_QUICK_MASK_COLOUR: QuickMaskColour = { red: 255, green: 0, blue: 0, opacity: 0.5 };

/** RGBA overlay: unselected pixels receive the Quick Mask colour, selected pixels stay clear. */
export function quickMaskOverlay(selection: DocumentSelection | null, width: number, height: number,
  colour: QuickMaskColour = DEFAULT_QUICK_MASK_COLOUR): Uint8Array {
  const result = new Uint8Array(width * height * 4), opacity = Math.round(Math.max(0, Math.min(1, colour.opacity)) * 255);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const selected = selectionByte(selection, x, y), p = (y * width + x) * 4;
    result[p] = colour.red; result[p + 1] = colour.green; result[p + 2] = colour.blue;
    result[p + 3] = Math.round(opacity * (255 - selected) / 255);
  }
  return result;
}

export function selectionMaskOnCanvas(selection: DocumentSelection | null, width: number, height: number): Uint8Array {
  const result = new Uint8Array(width * height);
  if (!selection) { result.fill(255); return result; }
  const pixels = selection.mask.toPixels();
  for (let y = 0; y < selection.mask.height; y++) {
    const targetY = y + selection.y; if (targetY < 0 || targetY >= height) continue;
    const from = Math.max(0, -selection.x), to = Math.min(selection.mask.width, width - selection.x);
    if (to > from) result.set(pixels.subarray(y * selection.mask.width + from, y * selection.mask.width + to),
      targetY * width + selection.x + from);
  }
  return result;
}

/** Quick Mask grayscale uses Photoshop convention: black masked, white selected. */
export function selectionFromQuickMask(mask: Uint8Array, width: number, height: number): DocumentSelection {
  if (mask.length !== width * height) throw new RangeError('Quick Mask buffer size mismatch');
  return { mask: Raster.fromPixels(width, height, 1, mask), x: 0, y: 0, antialiased: true };
}

export function commitQuickMask(session: EditorSession, mask: Uint8Array): boolean {
  const document = session.document;
  return document ? setSelection(session, selectionFromQuickMask(mask, document.width, document.height), 'Quick Mask') : false;
}

function selectionByte(selection: DocumentSelection | null, x: number, y: number): number {
  if (!selection) return 255;
  const px = x - selection.x, py = y - selection.y;
  if (px < 0 || py < 0 || px >= selection.mask.width || py >= selection.mask.height) return 0;
  const col = Math.floor(px / 256), row = Math.floor(py / 256), tile = selection.mask.tiles[row * selection.mask.cols + col];
  return tile?.[(py - row * 256) * selection.mask.tileWidth(col) + px - col * 256] ?? 0;
}
