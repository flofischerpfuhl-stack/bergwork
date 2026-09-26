/**
 * Live ("smart") filter editing for the UI (PRODUCT-PLAN 6.4): the Filter menu adds a filter to the layer's live stack
 * and opens the filter's panel on it; double-clicking a filter row reopens that panel. The panel is the same one the
 * destructive filters use (adjustmentsFeature FilterControls); it only sees FilterSettings and a change callback.
 *
 * One open edit is one undo step: adding + adjusting a new filter is recorded under the filter's name, editing an
 * existing one as "Edit Smart Filter". Cancel restores the stack exactly as it was.
 */

import type { EditorSession } from '../../core/session';
import type { LiveFilter } from '../../core/document';
import { defaultFilterSettings, normalizeFilterSettings, type FilterKind, type FilterSettings } from '../../core/filters/settings';
import { defaultLiveFilter, type LiveFilterKind } from '../../core/filters/live';

/** Filter menu order and the destructive FilterKind each live filter shares its kernel and panel with. */
export const LIVE_FILTER_KINDS: readonly LiveFilterKind[] = ['gaussianBlur', 'motionBlur', 'lensCorrection', 'noise', 'denoise',
  'unsharpMask', 'smartSharpen', 'highPass'];
export const LIVE_FILTER_NAMES: Readonly<Record<LiveFilterKind, FilterKind>> = {
  gaussianBlur: 'Gaussian Blur', motionBlur: 'Motion Blur', noise: 'Add Noise', lensCorrection: 'Lens Correction',
  unsharpMask: 'Unsharp Mask', smartSharpen: 'Smart Sharpen', highPass: 'High Pass', denoise: 'Denoise',
};
/** Menu command keys (menus.ts `feature(...)`), matching the destructive command registry's names. */
export const LIVE_FILTER_COMMANDS: Readonly<Record<LiveFilterKind, string>> = {
  gaussianBlur: 'gaussianBlur', motionBlur: 'motionBlur', noise: 'noise', lensCorrection: 'lensCorrection',
  unsharpMask: 'unsharpMask', smartSharpen: 'smartSharpen', highPass: 'highPass', denoise: 'denoise',
};

export function filterSettingsOf(filter: LiveFilter): FilterSettings {
  const base = defaultFilterSettings();
  switch (filter.kind) {
    case 'gaussianBlur': return { ...base, radius: filter.radius };
    case 'motionBlur': return { ...base, angle: filter.angle, distance: filter.distance };
    case 'noise': return { ...base, amount: filter.amount, gaussian: filter.gaussian, monochromatic: filter.monochromatic };
    case 'lensCorrection': return { ...base, distortion: filter.distortion };
    case 'unsharpMask': return { ...base, amount: filter.amount, radius: filter.radius, threshold: filter.threshold };
    case 'smartSharpen': return { ...base, amount: filter.amount, radius: filter.radius, threshold: filter.threshold, reduceNoise: filter.reduceNoise };
    case 'highPass': return { ...base, radius: filter.radius };
    case 'denoise': return { ...base, luminance: filter.luminance, colour: filter.colour, detail: filter.detail ?? 50 };
  }
}

export function liveFilterFrom(kind: LiveFilterKind, value: FilterSettings, enabled: boolean,
  blending?: Pick<LiveFilter, 'opacity' | 'blendMode'>): LiveFilter {
  const s = normalizeFilterSettings(value);
  const common = { ...(blending?.opacity === undefined ? {} : { opacity: blending.opacity }),
    ...(blending?.blendMode === undefined ? {} : { blendMode: blending.blendMode }) };
  switch (kind) {
    case 'gaussianBlur': return { kind, schemaVersion: 1, enabled, radius: s.radius, ...common };
    case 'motionBlur': return { kind, schemaVersion: 1, enabled, angle: s.angle, distance: s.distance, ...common };
    case 'noise': return { kind, schemaVersion: 1, enabled, amount: s.amount, gaussian: s.gaussian, monochromatic: s.monochromatic, ...common };
    case 'lensCorrection': return { kind, schemaVersion: 1, enabled, distortion: s.distortion, ...common };
    case 'unsharpMask': return { kind, schemaVersion: 1, enabled, amount: s.amount, radius: s.radius, threshold: s.threshold, ...common };
    case 'smartSharpen': return { kind, schemaVersion: 1, enabled, amount: s.amount, radius: s.radius, threshold: s.threshold, reduceNoise: s.reduceNoise, ...common };
    case 'highPass': return { kind, schemaVersion: 1, enabled, radius: s.radius, ...common };
    case 'denoise': return { kind, schemaVersion: 1, enabled, luminance: s.luminance, colour: s.colour, detail: s.detail, ...common };
  }
}

export interface LiveFilterEditState {
  readonly layerId: string;
  readonly index: number;
  readonly kind: LiveFilterKind;
  /** Whether the filter was visible before the panel opened; Preview off hides it only while the panel is open. */
  readonly enabled: boolean;
  readonly isNew: boolean;
  readonly blending?: Pick<LiveFilter, 'opacity' | 'blendMode'>;
  settings: FilterSettings;
  preview: boolean;
}

const edits = new WeakMap<EditorSession, LiveFilterEditState>();
export function liveFilterEditState(session: EditorSession): LiveFilterEditState | null { return edits.get(session) ?? null; }

/** A layer can take a live filter when it is the single selected pixel layer and its appearance is not locked. */
export function canAddLiveFilter(session: EditorSession): boolean {
  const layer = session.activeLayer;
  return session.canEditLayers && session.selectedLayerIds.size === 1 && !!layer?.raster && !layer.adjustment
    && !session.isMaskSelected && !edits.has(session);
}

/** Filter menu: adds the filter with its defaults and opens its panel; OK keeps it as one undo step named after it. */
export function beginNewLiveFilter(session: EditorSession, kind: LiveFilterKind): LiveFilterEditState | null {
  const layer = session.activeLayer;
  if (!layer || !canAddLiveFilter(session) || session.refuseLayerEdit(layer.id, 'appearance')) return null;
  session.beginEdit(LIVE_FILTER_NAMES[kind]);
  if (!session.beginLayerLiveFilterEdit(layer.id)) { session.endEdit(); return null; }
  const filter = defaultLiveFilter(kind);
  if (!session.addLayerLiveFilter(filter, layer.id)) { session.endLayerLiveFilterEdit(false); session.endEdit(); return null; }
  const index = (session.layer(layer.id)?.filters.length ?? 1) - 1;
  const state: LiveFilterEditState = { layerId: layer.id, index, kind, enabled: true, isNew: true, settings: filterSettingsOf(filter), preview: true };
  edits.set(session, state);
  session.notify('ui');
  return state;
}

/** Double-click on a filter row: edits that filter in place. */
export function beginLiveFilterEdit(session: EditorSession, layerId: string, index: number): LiveFilterEditState | null {
  const filter = session.layer(layerId)?.filters[index];
  if (!filter || edits.has(session) || !session.canEditLayers || session.refuseLayerEdit(layerId, 'appearance')) return null;
  session.beginEdit('Edit Smart Filter');
  if (!session.beginLayerLiveFilterEdit(layerId)) { session.endEdit(); return null; }
  const state: LiveFilterEditState = { layerId, index, kind: filter.kind, enabled: filter.enabled, isNew: false,
    blending: { opacity: filter.opacity, blendMode: filter.blendMode }, settings: filterSettingsOf(filter), preview: true };
  edits.set(session, state);
  // The panel always shows its filter, even one that was hidden in the stack.
  session.updateLayerLiveFilter(index, liveFilterFrom(filter.kind, state.settings, true, state.blending), layerId, true);
  session.notify('ui');
  return state;
}

export function updateLiveFilterEdit(session: EditorSession, settings: FilterSettings, preview?: boolean): void {
  const state = edits.get(session); if (!state) return;
  state.settings = normalizeFilterSettings(settings);
  if (preview !== undefined) state.preview = preview;
  session.updateLayerLiveFilter(state.index, liveFilterFrom(state.kind, state.settings, state.preview, state.blending), state.layerId, true);
  session.notify('ui');
}

export function finishLiveFilterEdit(session: EditorSession, apply: boolean): void {
  const state = edits.get(session); if (!state) return;
  edits.delete(session);
  // OK keeps the filter visible as it was before (a new filter is visible); Preview only affects the open panel.
  if (apply) session.updateLayerLiveFilter(state.index, liveFilterFrom(state.kind, state.settings, state.isNew || state.enabled, state.blending), state.layerId, true);
  session.endLayerLiveFilterEdit(apply);
  session.endEdit();
  session.notify('document');
}

// MARK: Stack commands named for the History panel

function named(session: EditorSession, name: string, body: () => boolean): boolean {
  session.beginEdit(name);
  try { return body(); } finally { session.endEdit(); }
}

export function setLiveFilterEnabled(session: EditorSession, layerId: string, index: number, enabled: boolean): boolean {
  const filter = session.layer(layerId)?.filters[index];
  if (!filter || filter.enabled === enabled || !session.canEditLayers) return false;
  return named(session, enabled ? 'Show Smart Filter' : 'Hide Smart Filter',
    () => session.updateLayerLiveFilter(index, { ...filter, enabled }, layerId));
}

/** The Smart Filters row's eye: hides every filter, or shows them all again when all are hidden. */
export function setAllLiveFiltersEnabled(session: EditorSession, layerId: string, enabled: boolean): boolean {
  const filters = session.layer(layerId)?.filters ?? [];
  if (!filters.length || !session.canEditLayers) return false;
  return named(session, enabled ? 'Show Smart Filters' : 'Hide Smart Filters', () => {
    let changed = false;
    filters.forEach((filter, index) => { if (filter.enabled !== enabled) changed = session.updateLayerLiveFilter(index, { ...filter, enabled }, layerId) || changed; });
    return changed;
  });
}

export function moveLiveFilterTo(session: EditorSession, layerId: string, from: number, to: number): boolean {
  if (from === to || !session.canEditLayers) return false;
  return named(session, 'Reorder Smart Filters', () => session.moveLayerLiveFilter(from, to, layerId));
}

export function deleteLiveFilter(session: EditorSession, layerId: string, index: number): boolean {
  if (!session.canEditLayers) return false;
  return named(session, 'Delete Smart Filter', () => session.removeLayerLiveFilter(index, layerId));
}

export function clearLiveFilters(session: EditorSession, layerId: string): boolean {
  const count = session.layer(layerId)?.filters.length ?? 0;
  if (!count || !session.canEditLayers) return false;
  return named(session, 'Clear Smart Filters', () => {
    let changed = false;
    for (let index = count - 1; index >= 0; index--) changed = session.removeLayerLiveFilter(index, layerId) || changed;
    return changed;
  });
}

/** Bakes the enabled filters into the pixels (Photoshop: Rasterize Smart Object) as one undo step. */
export async function applyLiveFiltersToPixels(session: EditorSession, layerId: string): Promise<boolean> {
  if (!session.canEditLayers || !session.layer(layerId)?.filters.length || session.refuseLayerEdit(layerId, 'pixels')) return false;
  session.beginEdit('Apply Smart Filters');
  try { return await session.applyLayerLiveFilters(layerId); } finally { session.endEdit(); }
}
