import { apply, boundingBox, invert, pixelToDocument, type Point } from '../geometry';
import { Raster } from '../raster';
import type { DocumentSelection, SelectionMode } from '../selection';
import { applySelection } from '../selectionCommands';
import type { EditorSession } from '../session';
import type { ObjectPrompt, ObjectSelectResult, ObjectSelectStage } from './types';

export interface ObjectSelectionInference {
  select(cacheKey: string, rgba: Uint8Array, width: number, height: number, prompts: readonly ObjectPrompt[],
    modelUrls: { readonly encoder: string; readonly decoder: string },
    progress?: (stage: ObjectSelectStage, value: number) => void, signal?: AbortSignal): Promise<ObjectSelectResult>;
}

export interface SelectObjectOptions {
  readonly mode?: SelectionMode;
  readonly modelUrls: { readonly encoder: string; readonly decoder: string };
  readonly inference: ObjectSelectionInference;
  readonly progress?: (stage: ObjectSelectStage, value: number) => void;
  readonly signal?: AbortSignal;
}

/** Converts document-space prompts to the active layer and installs the returned mask as one undo step. */
export async function selectObject(session: EditorSession, prompts: readonly ObjectPrompt[],
  options: SelectObjectOptions): Promise<ObjectSelectResult | null> {
  const document = session.document, layer = session.activeLayer, raster = layer?.raster;
  if (!document || !layer || !raster || raster.channels !== 4 || !session.canEditLayers) return null;
  const placement = session.displayedTransform(layer), toPixels = invert(pixelToDocument(placement, raster.width, raster.height));
  const local = prompts.map((prompt): ObjectPrompt => {
    if (prompt.kind === 'point') { const p = apply(toPixels, prompt); return { ...prompt, x: p.x, y: p.y }; }
    const a = apply(toPixels, { x: prompt.x0, y: prompt.y0 }), b = apply(toPixels, { x: prompt.x1, y: prompt.y1 });
    return { kind: 'box', x0: a.x, y0: a.y, x1: b.x, y1: b.y };
  });
  const result = await options.inference.select(`${layer.id}:${raster.serial}`, raster.toPixels(), raster.width, raster.height,
    local, options.modelUrls, options.progress, options.signal);
  if (session.layer(layer.id)?.raster !== raster) return null;
  const shape = layerMaskSelection(result.mask, result.width, result.height, placement, document.width, document.height);
  applySelection(session, shape, options.mode ?? 'New', 'Object Selection');
  return result;
}

/** Reuses subject-removal inference by turning its full-size layer mask into a selection. */
export function selectSubjectMask(session: EditorSession, mask: Uint8Array, width: number, height: number,
  mode: SelectionMode = 'New'): boolean {
  const document = session.document, layer = session.activeLayer;
  if (!document || !layer || !layer.raster || layer.raster.width !== width || layer.raster.height !== height) return false;
  return applySelection(session, layerMaskSelection(mask, width, height, session.displayedTransform(layer),
    document.width, document.height), mode, 'Select Subject');
}

export function layerMaskSelection(mask: Uint8Array, width: number, height: number,
  transform: ReturnType<EditorSession['displayedTransform']>, documentWidth: number, documentHeight: number): DocumentSelection {
  if (mask.length !== width * height) throw new RangeError('Mask buffer size mismatch');
  const map = pixelToDocument(transform, width, height), box = boundingBox(transform);
  const left = Math.max(0, Math.floor(box.x)), top = Math.max(0, Math.floor(box.y));
  const right = Math.min(documentWidth, Math.ceil(box.x + box.width)), bottom = Math.min(documentHeight, Math.ceil(box.y + box.height));
  const outWidth = Math.max(1, right - left), outHeight = Math.max(1, bottom - top), output = new Uint8Array(outWidth * outHeight);
  const inverse = invert(map);
  for (let y = 0; y < outHeight; y++) for (let x = 0; x < outWidth; x++) {
    const p = apply(inverse, { x: left + x + 0.5, y: top + y + 0.5 });
    output[y * outWidth + x] = bilinear(mask, width, height, p.x - 0.5, p.y - 0.5);
  }
  return { mask: Raster.fromPixels(outWidth, outHeight, 1, output), x: left, y: top, antialiased: true };
}

function bilinear(mask: Uint8Array, width: number, height: number, x: number, y: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const at = (px: number, py: number): number => px < 0 || py < 0 || px >= width || py >= height ? 0 : mask[py * width + px]!;
  return Math.round(at(x0, y0) * (1 - fx) * (1 - fy) + at(x0 + 1, y0) * fx * (1 - fy)
    + at(x0, y0 + 1) * (1 - fx) * fy + at(x0 + 1, y0 + 1) * fx * fy);
}
