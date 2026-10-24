import { newLayer, uniqueName, type LayerMask } from '../document';
import { uuid } from '../ids';
import { Raster } from '../raster';
import { setSelection } from '../selectionCommands';
import type { EditorSession } from '../session';
import type { RefineEdgeResult } from './engine';

export type RefineEdgeOutput = 'selection' | 'layerMask' | 'newLayerWithMask' | 'newLayer';

/** Commits one Refine Edge result to any product-plan output destination as one undo step. */
export function applyRefineEdgeResult(session: EditorSession, result: RefineEdgeResult, output: RefineEdgeOutput): boolean {
  const document = session.document, source = session.activeLayer;
  if (!document || !source || !session.canEditLayers) return false;
  if (output === 'selection') {
    if (result.width !== document.width || result.height !== document.height) return false;
    return setSelection(session, { mask: Raster.fromPixels(result.width, result.height, 1, result.mask), x: 0, y: 0, antialiased: true }, 'Refine Edge');
  }
  const raster = source.raster;
  if (!raster || raster.channels !== 4 || result.width !== raster.width || result.height !== raster.height) return false;
  const mask: LayerMask = { raster: Raster.fromPixels(result.width, result.height, 1, result.mask), enabled: true, linked: true, placement: null };
  if (output === 'layerMask') {
    session.edit('Refine Layer Mask', () => {
      session.replaceDocument({ ...session.document!, layers: session.document!.layers.map((layer) => layer.id === source.id ? { ...layer, mask } : layer) });
      session.isMaskSelected = true;
    });
    return true;
  }
  const pixels = result.decontaminatedRgba;
  const newRaster = output === 'newLayer' ? applyAlpha(pixels ?? raster.toPixels(), result.mask, raster.width, raster.height)
    : pixels ? Raster.fromPixels(raster.width, raster.height, 4, pixels) : raster;
  const layer = newLayer({ id: uuid(), name: uniqueName(document.layers, `${source.name} Refined`), raster: newRaster,
    transform: source.transform, parentId: source.parentId, mask: output === 'newLayerWithMask' ? mask : null });
  session.edit(output === 'newLayer' ? 'New Layer from Refine Edge' : 'New Layer with Refined Mask', () => {
    const layers = session.document!.layers.slice(), index = layers.findIndex((item) => item.id === source.id);
    layers.splice(index + 1, 0, layer); session.replaceDocument({ ...session.document!, layers }); session.setActiveLayer(layer.id);
    session.isMaskSelected = output === 'newLayerWithMask';
  });
  return true;
}

function applyAlpha(rgba: Uint8Array, mask: Uint8Array, width: number, height: number): Raster {
  const output = rgba.slice();
  for (let i = 0; i < mask.length; i++) output[i * 4 + 3] = Math.round(output[i * 4 + 3]! * mask[i]! / 255);
  return Raster.fromPixels(width, height, 4, output);
}
