/** Framework-free Levels, Hue/Saturation, and live adjustment-layer edit state machines. */
import type { LayerAdjustment } from '../document';
import type { EditorSession } from '../session';
import {
  defaultHueSaturation, defaultLevels, isValidAdjustment, resolveAdjustment,
  type HueSaturationSettings, type LevelsSettings,
} from '../adjustments';
import { adjustmentPixelJob, histogramPixelJob, type HistogramJob, type PixelJob } from './pixelWorkerClient';

interface PixelEditBase {
  /** Stable target; apply rejects if its raster or transform changed while the panel was open. */
  readonly layerId: string;
  readonly originalRaster: NonNullable<ReturnType<EditorSession['displayedRaster']>>;
  readonly originalTransform: NonNullable<EditorSession['activeLayer']>['transform'];
  /** Whether the transient raster is visible on canvas. */
  preview: boolean;
  /** True while the final full-size result is being made. */
  committing: boolean;
  /** Monotonic latest-request-wins token. */
  request: number;
}
export interface LevelsEditState extends PixelEditBase {
  settings: LevelsSettings;
  histogram: readonly Float64Array[];
  histogramReady: boolean;
  histogramTask: Promise<void> | null;
}
export interface HueSaturationEditState extends PixelEditBase { settings: HueSaturationSettings }
export interface AdjustmentLayerEditState {
  readonly layerId: string;
  readonly original: LayerAdjustment;
  value: LayerAdjustment;
  preview: boolean;
}

const levelsEdits = new WeakMap<EditorSession, LevelsEditState>();
const hueEdits = new WeakMap<EditorSession, HueSaturationEditState>();
const layerEdits = new WeakMap<EditorSession, AdjustmentLayerEditState>();
const pixelJobs = new WeakMap<EditorSession, PixelJob>();
const histogramJobs = new WeakMap<EditorSession, HistogramJob>();
export function levelsEditState(session: EditorSession): LevelsEditState | null { return levelsEdits.get(session) ?? null; }
export function hueSaturationEditState(session: EditorSession): HueSaturationEditState | null { return hueEdits.get(session) ?? null; }
export function adjustmentLayerEditState(session: EditorSession): AdjustmentLayerEditState | null { return layerEdits.get(session) ?? null; }

function editableRaster(session: EditorSession) {
  const layer = session.activeLayer;
  return session.canEditLayers && session.selectedLayerIds.size === 1 && layer && layer.kind !== 'group' && !layer.adjustment
    && !session.isMaskSelected && layer.raster ? layer : null;
}

export function beginLevelsEdit(session: EditorSession): LevelsEditState | null {
  if (levelsEdits.has(session) || hueEdits.has(session)) return null;
  const layer = editableRaster(session); if (!layer?.raster) return null;
  const state: LevelsEditState = { layerId: layer.id, originalRaster: layer.raster, originalTransform: layer.transform,
    settings: defaultLevels(), histogram: Array.from({ length: 4 }, () => new Float64Array(256)), histogramReady: false,
    histogramTask: null, preview: true, committing: false, request: 0 };
  levelsEdits.set(session, state);
  const job = histogramPixelJob(layer.raster, layer.transform, session.selection); histogramJobs.set(session, job);
  state.histogramTask = job.promise.then((bins) => { if (levelsEdits.get(session) === state) { state.histogram = bins; state.histogramReady = true; session.notify('ui'); } })
    .catch(() => {}).finally(() => { if (histogramJobs.get(session) === job) histogramJobs.delete(session); });
  session.notify('ui'); return state;
}

export async function updateLevelsEdit(session: EditorSession, settings: LevelsSettings, preview = true): Promise<void> {
  const state = levelsEdits.get(session); if (!state || state.committing) return;
  state.settings = settings; state.preview = preview; const request = ++state.request;
  pixelJobs.get(session)?.cancel(); pixelJobs.delete(session);
  if (!preview) { session.rasterOverrides.delete(state.layerId); session.notify('document'); return; }
  const layer = session.layer(state.layerId); if (request !== state.request || !layer || layer.raster !== state.originalRaster) return;
  const value: LayerAdjustment = { kind: 'Levels', schemaVersion: 1, parameters: settings };
  const job = adjustmentPixelJob(state.originalRaster, state.originalTransform, value, session.selection); pixelJobs.set(session, job);
  try { const made = await job.promise;
    if (request === state.request && levelsEdits.get(session) === state) { session.rasterOverrides.set(state.layerId, made.raster); session.notify('document'); }
  } catch { /* superseded jobs are intentionally discarded */ }
  finally { if (pixelJobs.get(session) === job) pixelJobs.delete(session); }
}
export function cancelLevelsEdit(session: EditorSession): void {
  const state = levelsEdits.get(session); if (!state) return; state.request++; pixelJobs.get(session)?.cancel(); pixelJobs.delete(session);
  histogramJobs.get(session)?.cancel(); histogramJobs.delete(session); session.rasterOverrides.delete(state.layerId);
  levelsEdits.delete(session); session.notify('document');
}
export async function applyLevelsEdit(session: EditorSession): Promise<boolean> {
  const state = levelsEdits.get(session); if (!state || state.committing) return false; state.committing = true; state.request++;
  pixelJobs.get(session)?.cancel(); histogramJobs.get(session)?.cancel(); histogramJobs.delete(session); const layer = session.layer(state.layerId);
  if (!layer || layer.raster !== state.originalRaster || layer.transform !== state.originalTransform) { cancelLevelsEdit(session); return false; }
  const job = adjustmentPixelJob(state.originalRaster, state.originalTransform,
    { kind: 'Levels', schemaVersion: 1, parameters: state.settings }, session.selection);
  pixelJobs.set(session, job); let made;
  try { made = (await job.promise).raster; } catch { cancelLevelsEdit(session); return false; }
  session.rasterOverrides.delete(state.layerId); levelsEdits.delete(session); session.replaceLayerPixels(state.layerId, made, 'Levels'); return true;
}

export function beginHueSaturationEdit(session: EditorSession): HueSaturationEditState | null {
  if (hueEdits.has(session) || levelsEdits.has(session)) return null;
  const layer = editableRaster(session); if (!layer?.raster) return null;
  const state: HueSaturationEditState = { layerId: layer.id, originalRaster: layer.raster, originalTransform: layer.transform,
    settings: defaultHueSaturation(), preview: true, committing: false, request: 0 };
  hueEdits.set(session, state); session.notify('ui'); return state;
}
export async function updateHueSaturationEdit(session: EditorSession, settings: HueSaturationSettings, preview = true): Promise<void> {
  const state = hueEdits.get(session); if (!state || state.committing) return;
  state.settings = settings; state.preview = preview; const request = ++state.request;
  pixelJobs.get(session)?.cancel(); pixelJobs.delete(session);
  if (!preview) { session.rasterOverrides.delete(state.layerId); session.notify('document'); return; }
  const layer = session.layer(state.layerId);
  if (request !== state.request || !layer || layer.raster !== state.originalRaster) return;
  const job = adjustmentPixelJob(state.originalRaster, state.originalTransform,
    { kind: 'Hue/Saturation', schemaVersion: 1, parameters: { hue: settings.adjustments.Master?.hue ?? 0,
      saturation: settings.adjustments.Master?.saturation ?? 0, lightness: settings.adjustments.Master?.lightness ?? 0,
      colorize: settings.colorize, settings } }, session.selection); pixelJobs.set(session, job);
  try { const made = await job.promise;
    if (request === state.request && hueEdits.get(session) === state) { session.rasterOverrides.set(state.layerId, made.raster); session.notify('document'); }
  } catch { /* superseded */ } finally { if (pixelJobs.get(session) === job) pixelJobs.delete(session); }
}
export function cancelHueSaturationEdit(session: EditorSession): void {
  const state = hueEdits.get(session); if (!state) return; state.request++; pixelJobs.get(session)?.cancel(); pixelJobs.delete(session); session.rasterOverrides.delete(state.layerId);
  hueEdits.delete(session); session.notify('document');
}
export async function applyHueSaturationEdit(session: EditorSession): Promise<boolean> {
  const state = hueEdits.get(session); if (!state || state.committing) return false; state.committing = true; state.request++;
  pixelJobs.get(session)?.cancel(); const layer = session.layer(state.layerId);
  if (!layer || layer.raster !== state.originalRaster || layer.transform !== state.originalTransform) { cancelHueSaturationEdit(session); return false; }
  const job = adjustmentPixelJob(state.originalRaster, state.originalTransform,
    { kind: 'Hue/Saturation', schemaVersion: 1, parameters: { hue: state.settings.adjustments.Master?.hue ?? 0,
      saturation: state.settings.adjustments.Master?.saturation ?? 0, lightness: state.settings.adjustments.Master?.lightness ?? 0,
      colorize: state.settings.colorize, settings: state.settings } }, session.selection); pixelJobs.set(session, job); let made;
  try { made = (await job.promise).raster; } catch { cancelHueSaturationEdit(session); return false; }
  session.rasterOverrides.delete(state.layerId); hueEdits.delete(session); session.replaceLayerPixels(state.layerId, made, 'Hue/Saturation'); return true;
}

/** Opens the metadata edit as one transaction; previews change only layer settings. */
export function beginAdjustmentLayerEdit(session: EditorSession, id = session.adjustmentEditingId ?? session.activeLayerId): AdjustmentLayerEditState | null {
  if (!id || layerEdits.has(session)) return null;
  const original = session.layer(id)?.adjustment; if (!original) return null;
  const state = { layerId: id, original, value: original, preview: true };
  layerEdits.set(session, state); session.adjustmentEditingId = id; session.beginEdit(`Edit ${original.kind} Adjustment`); session.notify('ui'); return state;
}
export function updateAdjustmentLayerEdit(session: EditorSession, value: LayerAdjustment, preview = true): boolean {
  const state = layerEdits.get(session); if (!state || !isValidAdjustment(value)) return false;
  state.value = value; state.preview = preview; session.updateAdjustment(state.layerId, preview ? value : state.original); return true;
}
export function finishAdjustmentLayerEdit(session: EditorSession, apply: boolean): boolean {
  const state = layerEdits.get(session); if (!state) return false;
  session.updateAdjustment(state.layerId, apply ? state.value : state.original); session.endEdit();
  layerEdits.delete(session); session.adjustmentEditingId = null; session.notify('ui'); return true;
}

/** Settings currently shown by the matching adjustment panel. */
export function resolvedEditedAdjustment(session: EditorSession) { const state = layerEdits.get(session); return state ? resolveAdjustment(state.value) : null; }
