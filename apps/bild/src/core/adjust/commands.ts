/** Image/Filter menu command registry. Panels consume the state objects exported by editing modules. */
import { ADJUSTMENT_KINDS } from '../document';
import type { EditorSession } from '../session';
import { invertRaster } from './raster';
import {
  adjustmentLayerEditState, beginAdjustmentLayerEdit, beginHueSaturationEdit, beginLevelsEdit,
  hueSaturationEditState, levelsEditState,
} from './editing';
import { beginFilterEdit, filterEditState, startsOnEmptyLayer } from '../filters/editing';
import type { FilterKind } from '../filters/settings';

export type AdjustmentCommandName = 'levels' | 'curves' | 'hueSaturation' | 'exposure' | 'gradientMap' | 'grain'
  | 'invert' | 'gaussianBlur' | 'motionBlur' | 'noise' | 'lensCorrection' | 'unsharpMask' | 'smartSharpen'
  | 'highPass' | 'denoise' | 'vignette' | 'bloom' | 'tonalContrast' | 'progressiveBlur' | 'rgbSplit'
  | 'editAdjustment' | 'adjustmentLayers';
export interface AdjustmentCommand { enabled(): boolean; run(): void }
export type AdjustmentCommandRegistry = Record<AdjustmentCommandName, AdjustmentCommand>;

/** Pixel locks do not disable these commands: running one on a locked layer refuses with the lock notice (Photoshop). */
function canAdjust(session: EditorSession, kind?: FilterKind): boolean {
  const layer = session.activeLayer;
  return session.canEditLayers && session.selectedLayerIds.size === 1 && (!!layer?.raster || (!!kind && startsOnEmptyLayer(kind, layer)))
    && !layer?.adjustment
    && !session.isMaskSelected
    && !levelsEditState(session) && !hueSaturationEditState(session) && !filterEditState(session);
}
function refused(session: EditorSession): boolean {
  const id = session.activeLayerId;
  return !!id && session.refuseLayerEdit(id, 'pixels');
}
function filter(session: EditorSession, kind: FilterKind): AdjustmentCommand {
  return { enabled: () => canAdjust(session, kind), run: () => { if (!refused(session)) beginFilterEdit(session, kind); } };
}

export function adjustmentCommands(session: EditorSession): AdjustmentCommandRegistry {
  return {
    levels: { enabled: () => canAdjust(session), run: () => { if (!refused(session)) beginLevelsEdit(session); } },
    curves: filter(session, 'Curves'),
    hueSaturation: { enabled: () => canAdjust(session), run: () => { if (!refused(session)) beginHueSaturationEdit(session); } },
    exposure: filter(session, 'Exposure'), gradientMap: filter(session, 'Gradient Map'), grain: filter(session, 'Grain'),
    invert: { enabled: () => {
      const layer = session.activeLayer;
      return session.canEditLayers && session.selectedLayerIds.size === 1 && !!layer
        && (session.isMaskSelected ? !!layer.mask : !!layer.raster && !layer.adjustment);
    }, run: () => {
      const layer = session.activeLayer; if (!layer || refused(session)) return;
      if (session.isMaskSelected && layer.mask) session.replaceMaskPixels(layer.id,
        invertRaster(layer.mask.raster, layer.mask.placement ?? layer.transform, session.selection), 'Invert');
      else if (layer.raster) session.replaceLayerPixels(layer.id, invertRaster(layer.raster, layer.transform, session.selection), 'Invert');
    } },
    gaussianBlur: filter(session, 'Gaussian Blur'), motionBlur: filter(session, 'Motion Blur'),
    noise: filter(session, 'Add Noise'), lensCorrection: filter(session, 'Lens Correction'),
    unsharpMask: filter(session, 'Unsharp Mask'), smartSharpen: filter(session, 'Smart Sharpen'),
    highPass: filter(session, 'High Pass'), denoise: filter(session, 'Denoise'),
    vignette: filter(session, 'Vignette'), bloom: filter(session, 'Bloom / Glow'), tonalContrast: filter(session, 'Tonal Contrast'),
    progressiveBlur: filter(session, 'Progressive Blur'), rgbSplit: filter(session, 'RGB Split'),
    editAdjustment: { enabled: () => !!session.activeLayer?.adjustment
      && !session.editBlocker(session.activeLayer.id, 'appearance') && !adjustmentLayerEditState(session),
      run: () => { beginAdjustmentLayerEdit(session); } },
    // A submenu command has no single kind to run; UI invokes session.addAdjustment(kind).
    adjustmentLayers: { enabled: () => session.canEditLayers && !!session.document
      && session.document.layers.length < 10_000 && ADJUSTMENT_KINDS.length > 0, run: () => {} },
  };
}
