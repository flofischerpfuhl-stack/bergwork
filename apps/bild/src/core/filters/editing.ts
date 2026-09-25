/** Framework-free filter preview/apply/cancel state machine with latest-request-wins previews. */
import type { LayerTransform } from '../geometry';
import type { Raster } from '../raster';
import type { EditorSession } from '../session';
import type { CanvasDocument, Layer } from '../document';
import { defaultFilterSettings, normalizeFilterSettings, type FilterKind, type FilterSettings } from './settings';
import { filterPixelJob, type PixelJob } from '../adjust/pixelWorkerClient';
import { carryMask } from './apply';

export interface FilterEditState {
  readonly kind: FilterKind;
  readonly layerId: string;
  readonly originalRaster: Raster;
  readonly originalTransform: LayerTransform;
  settings: FilterSettings;
  /** Stable random pattern for Noise/Grain for the lifetime of this panel. */
  readonly seed: number;
  preview: boolean;
  committing: boolean;
  preparing: boolean;
  previewError: string | null;
  request: number;
}

const edits = new WeakMap<EditorSession, FilterEditState>();
const jobs = new WeakMap<EditorSession, PixelJob>();
const viewPreviewSessions = new WeakSet<EditorSession>();
export function filterEditState(session: EditorSession): FilterEditState | null { return edits.get(session) ?? null; }
export function setFilterViewPreviewEnabled(session: EditorSession, enabled: boolean): void {
  if (enabled) viewPreviewSessions.add(session); else viewPreviewSessions.delete(session);
}

const VIEW_FILTERS: ReadonlySet<FilterKind> = new Set([
  'Gaussian Blur', 'Motion Blur', 'Add Noise', 'Lens Correction', 'Unsharp Mask', 'Smart Sharpen', 'High Pass', 'Denoise',
]);

/** Adds immutable preview metadata consumed only by the view-space GPU compositor. */
export function documentWithPixelFilterPreview(session: EditorSession,
  document: CanvasDocument = session.document!): CanvasDocument {
  const state = edits.get(session);
  if (!state?.preview || !viewPreviewSessions.has(session) || !VIEW_FILTERS.has(state.kind)) return document;
  let changed = false;
  const layers = document.layers.map((layer): typeof layer => {
    if (layer.id !== state.layerId) return layer;
    changed = true;
    return { ...layer, gpuFilterPreview: { kind: state.kind, settings: state.settings,
      seed: state.seed, selection: document.selection } } as unknown as typeof layer;
  });
  return changed ? { ...document, layers } : document;
}

export function beginFilterEdit(session: EditorSession, kind: FilterKind,
  settings: FilterSettings = defaultFilterSettings()): FilterEditState | null {
  const layer = session.activeLayer;
  if (edits.has(session) || !session.canEditLayers || session.selectedLayerIds.size !== 1 || !layer?.raster
    || !!layer.adjustment || session.isMaskSelected || session.editBlocker(layer.id, 'pixels')) return null;
  const state: FilterEditState = { kind, layerId: layer.id, originalRaster: layer.raster, originalTransform: layer.transform,
    settings: normalizeFilterSettings(settings), seed: Math.floor(Math.random() * 0x1_0000_0000), preview: true,
    committing: false, preparing: false, previewError: null, request: 0 };
  edits.set(session, state); void updateFilterEdit(session, state.settings, true); session.notify('ui'); return state;
}

export async function updateFilterEdit(session: EditorSession, settings: FilterSettings, preview = true): Promise<void> {
  const state = edits.get(session); if (!state || state.committing) return;
  state.settings = normalizeFilterSettings(settings); state.preview = preview; state.previewError = null; const request = ++state.request;
  jobs.get(session)?.cancel(); jobs.delete(session);
  if (!preview) { state.preparing = false; session.rasterOverrides.delete(state.layerId); session.notify('document'); return; }
  if (viewPreviewSessions.has(session) && VIEW_FILTERS.has(state.kind)) {
    state.preparing = false;
    session.rasterOverrides.delete(state.layerId);
    session.notify('document'); session.notify('ui'); return;
  }
  state.preparing = true;
  try {
    const job = filterPixelJob(state.kind, state.originalRaster, state.originalTransform, state.settings,
      session.selection, state.seed, false); jobs.set(session, job); const made = await job.promise;
    if (request !== state.request || edits.get(session) !== state) return;
    // Raster overrides use the stored transform, so previews retain the original grid; Apply expands the bounds.
    session.rasterOverrides.set(state.layerId, made.raster); session.notify('document');
  } catch (error) { if (request === state.request) state.previewError = error instanceof Error ? error.message : String(error); }
  finally { if (request === state.request) { state.preparing = false; jobs.delete(session); session.notify('ui'); } }
}

export function cancelFilterEdit(session: EditorSession): void {
  const state = edits.get(session); if (!state || state.committing) return;
  state.request++; jobs.get(session)?.cancel(); jobs.delete(session); session.rasterOverrides.delete(state.layerId); edits.delete(session); session.notify('document');
}

export async function applyFilterEdit(session: EditorSession): Promise<boolean> {
  const state = edits.get(session); if (!state || state.committing) return false;
  state.committing = true; state.request++; jobs.get(session)?.cancel(); jobs.delete(session);
  const current = session.layer(state.layerId);
  if (!current || current.raster !== state.originalRaster || current.transform !== state.originalTransform) {
    session.rasterOverrides.delete(state.layerId); edits.delete(session); session.notify('document'); return false;
  }
  try {
    const job = filterPixelJob(state.kind, state.originalRaster, state.originalTransform, state.settings,
      session.selection, state.seed, true); jobs.set(session, job); const made = await job.promise;
    session.rasterOverrides.delete(state.layerId); edits.delete(session);
    const constrained = session.constrainLayerPixels(state.layerId, made.raster, made.transform);
    if (!constrained) return false;
    const changedGrid = constrained.width !== state.originalRaster.width || constrained.height !== state.originalRaster.height;
    if (changedGrid && current.mask?.placement === null) {
      const mask = { ...current.mask, raster: carryMask(current.mask.raster, current.transform, made.transform, constrained.width, constrained.height) };
      const replacement: Layer = { ...current, raster: constrained, transform: made.transform, mask };
      const document = session.document!;
      session.beginEdit(state.kind);
      session.replaceDocument({ ...document, layers: document.layers.map((layer) => layer.id === state.layerId ? replacement : layer) });
      session.endEdit();
    } else session.replaceLayerPixels(state.layerId, constrained, state.kind, made.transform);
    return true;
  } catch (error) {
    state.committing = false; state.previewError = error instanceof Error ? error.message : String(error); session.notify('ui'); return false;
  }
}
