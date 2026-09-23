/** Image/Filter menu command registry. Panels consume the state objects exported by editing modules. */
import { ADJUSTMENT_KINDS } from '../document';
import type { EditorSession } from '../session';
import { invertRaster } from './raster';
import {
  adjustmentLayerEditState, beginAdjustmentLayerEdit, beginHueSaturationEdit, beginLevelsEdit,
  hueSaturationEditState, levelsEditState,
} from './editing';
import { beginFilterEdit, filterEditState } from '../filters/editing';

export type AdjustmentCommandName = 'levels' | 'curves' | 'hueSaturation' | 'exposure' | 'gradientMap' | 'grain'
  | 'invert' | 'gaussianBlur' | 'motionBlur' | 'noise' | 'lensCorrection' | 'editAdjustment' | 'adjustmentLayers';
export interface AdjustmentCommand { enabled(): boolean; run(): void }
export type AdjustmentCommandRegistry = Record<AdjustmentCommandName, AdjustmentCommand>;

function canAdjust(session: EditorSession): boolean {
  const layer = session.activeLayer;
  return session.canEditLayers && session.selectedLayerIds.size === 1 && !!layer?.raster && !layer.isGroup && !layer.adjustment
    && !session.isMaskSelected && !levelsEditState(session) && !hueSaturationEditState(session) && !filterEditState(session);
}
function filter(session: EditorSession, kind: Parameters<typeof beginFilterEdit>[1]): AdjustmentCommand {
  return { enabled: () => canAdjust(session), run: () => { beginFilterEdit(session, kind); } };
}

export function adjustmentCommands(session: EditorSession): AdjustmentCommandRegistry {
  return {
    levels: { enabled: () => canAdjust(session), run: () => { beginLevelsEdit(session); } },
    curves: filter(session, 'Curves'),
    hueSaturation: { enabled: () => canAdjust(session), run: () => { beginHueSaturationEdit(session); } },
    exposure: filter(session, 'Exposure'), gradientMap: filter(session, 'Gradient Map'), grain: filter(session, 'Grain'),
    invert: { enabled: () => {
      const layer = session.activeLayer;
      return session.canEditLayers && session.selectedLayerIds.size === 1 && !!layer
        && (session.isMaskSelected ? !!layer.mask : !!layer.raster && !layer.isGroup && !layer.adjustment);
    }, run: () => {
      const layer = session.activeLayer; if (!layer) return;
      if (session.isMaskSelected && layer.mask) session.replaceMaskPixels(layer.id,
        invertRaster(layer.mask.raster, layer.mask.placement ?? layer.transform, session.selection), 'Invert');
      else if (layer.raster) session.replaceLayerPixels(layer.id, invertRaster(layer.raster, layer.transform, session.selection), 'Invert');
    } },
    gaussianBlur: filter(session, 'Gaussian Blur'), motionBlur: filter(session, 'Motion Blur'),
    noise: filter(session, 'Add Noise'), lensCorrection: filter(session, 'Lens Correction'),
    editAdjustment: { enabled: () => !!session.activeLayer?.adjustment && !adjustmentLayerEditState(session),
      run: () => { beginAdjustmentLayerEdit(session); } },
    // A submenu command has no single kind to run; UI invokes session.addAdjustment(kind).
    adjustmentLayers: { enabled: () => session.canEditLayers && !!session.document
      && session.document.layers.length < 10_000 && ADJUSTMENT_KINDS.length > 0, run: () => {} },
  };
}
