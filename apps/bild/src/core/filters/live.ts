import { carryMask, applyFilter } from './apply';
import { defaultFilterSettings, type FilterKind } from './settings';
import type { EditorSession } from '../session';
import { withLayerRaster, type Layer, type LiveFilter } from '../document';
import type { Raster } from '../raster';

export type LiveFilterKind = LiveFilter['kind'];

export function defaultLiveFilter(kind: LiveFilterKind): LiveFilter {
  switch (kind) {
    case 'gaussianBlur': return { kind, schemaVersion: 1, enabled: true, radius: 1 };
    case 'motionBlur': return { kind, schemaVersion: 1, enabled: true, angle: 0, distance: 10 };
    case 'noise': return { kind, schemaVersion: 1, enabled: true, amount: 10, gaussian: false, monochromatic: false };
    case 'lensCorrection': return { kind, schemaVersion: 1, enabled: true, distortion: 0 };
    case 'unsharpMask': return { kind, schemaVersion: 1, enabled: true, amount: 100, radius: 1, threshold: 0 };
    case 'smartSharpen': return { kind, schemaVersion: 1, enabled: true, amount: 100, radius: 1, threshold: 0, reduceNoise: 10 };
    case 'highPass': return { kind, schemaVersion: 1, enabled: true, radius: 10 };
    case 'denoise': return { kind, schemaVersion: 1, enabled: true, luminance: 25, colour: 25 };
  }
}

function filterSettings(filter: LiveFilter): { kind: FilterKind; settings: ReturnType<typeof defaultFilterSettings> } {
  const base = defaultFilterSettings();
  switch (filter.kind) {
    case 'gaussianBlur': return { kind: 'Gaussian Blur', settings: { ...base, radius: filter.radius } };
    case 'motionBlur': return { kind: 'Motion Blur', settings: { ...base, angle: filter.angle, distance: filter.distance } };
    case 'noise': return { kind: 'Add Noise', settings: { ...base, amount: filter.amount,
      gaussian: filter.gaussian, monochromatic: filter.monochromatic } };
    case 'lensCorrection': return { kind: 'Lens Correction', settings: { ...base, distortion: filter.distortion } };
    case 'unsharpMask': return { kind: 'Unsharp Mask', settings: { ...base, amount: filter.amount,
      radius: filter.radius, threshold: filter.threshold } };
    case 'smartSharpen': return { kind: 'Smart Sharpen', settings: { ...base, amount: filter.amount,
      radius: filter.radius, threshold: filter.threshold, reduceNoise: filter.reduceNoise } };
    case 'highPass': return { kind: 'High Pass', settings: { ...base, radius: filter.radius } };
    case 'denoise': return { kind: 'Denoise', settings: { ...base, luminance: filter.luminance, colour: filter.colour } };
  }
}

export function applyLiveFilter(raster: Raster, filter: LiveFilter): Raster {
  if (!filter.enabled) return raster;
  const converted = filterSettings(filter);
  return applyFilter(converted.kind, raster, {
    origin: { x: 0, y: 0 }, size: { width: raster.width, height: raster.height }, rotation: 0,
    flipX: false, flipY: false, sampling: 'High quality',
  }, converted.settings, { expand: false, seed: 0x6d2b79f5 }).raster;
}

const cache = new WeakMap<Raster, WeakMap<object, Raster>>();
/** Cached, ordered live stack. Immutable filter arrays are the cache key. */
export function applyLiveFilters(raster: Raster, filters: readonly LiveFilter[]): Raster {
  if (!filters.some((filter) => filter.enabled)) return raster;
  let byStack = cache.get(raster); if (!byStack) { byStack = new WeakMap(); cache.set(raster, byStack); }
  const key = filters as object, known = byStack.get(key); if (known) return known;
  let result = raster;
  for (const filter of filters) result = applyLiveFilter(result, filter);
  byStack.set(key, result); return result;
}

function replaceFilters(session: EditorSession, layerId: string, filters: readonly LiveFilter[]): boolean {
  const document = session.document, layer = session.layer(layerId);
  if (!document || !layer || session.editBlocker(layerId, 'appearance')) return false;
  session.replaceDocument({ ...document, layers: document.layers.map((item) => item.id === layerId ? { ...item, filters } : item) });
  return true;
}

export function addLiveFilter(session: EditorSession, layerId: string, filter: LiveFilter): boolean {
  const layer = session.layer(layerId); if (!layer) return false;
  let changed = false; session.edit('Add Live Filter', () => { changed = replaceFilters(session, layerId, [...layer.filters, filter]); }); return changed;
}
export function updateLiveFilter(session: EditorSession, layerId: string, index: number, filter: LiveFilter): boolean {
  const layer = session.layer(layerId); if (!layer || index < 0 || index >= layer.filters.length) return false;
  const filters = layer.filters.slice(); filters[index] = filter;
  let changed = false; session.edit('Edit Live Filter', () => { changed = replaceFilters(session, layerId, filters); }); return changed;
}
export function removeLiveFilter(session: EditorSession, layerId: string, index: number): boolean {
  const layer = session.layer(layerId); if (!layer || index < 0 || index >= layer.filters.length) return false;
  const filters = layer.filters.slice(); filters.splice(index, 1);
  let changed = false; session.edit('Remove Live Filter', () => { changed = replaceFilters(session, layerId, filters); }); return changed;
}
export function moveLiveFilter(session: EditorSession, layerId: string, from: number, to: number): boolean {
  const layer = session.layer(layerId); if (!layer || from < 0 || from >= layer.filters.length || to < 0 || to >= layer.filters.length) return false;
  const filters = layer.filters.slice(), moved = filters.splice(from, 1)[0]!; filters.splice(to, 0, moved);
  let changed = false; session.edit('Reorder Live Filters', () => { changed = replaceFilters(session, layerId, filters); }); return changed;
}

interface DragState { readonly layerId: string; readonly original: readonly LiveFilter[] }
const drags = new WeakMap<EditorSession, DragState>();
export function beginLiveFilterDrag(session: EditorSession, layerId: string): boolean {
  const layer = session.layer(layerId); if (!layer || drags.has(session)) return false;
  session.beginEdit('Edit Live Filter'); drags.set(session, { layerId, original: layer.filters }); return true;
}
export function updateLiveFilterDrag(session: EditorSession, filters: readonly LiveFilter[]): boolean {
  const drag = drags.get(session); return !!drag && replaceFilters(session, drag.layerId, filters);
}
export function endLiveFilterDrag(session: EditorSession, commit = true): boolean {
  const drag = drags.get(session); if (!drag) return false;
  if (!commit) replaceFilters(session, drag.layerId, drag.original);
  drags.delete(session); session.endEdit(); return true;
}

/** Applies the enabled stack in order, expands blur/sharpen bounds, then clears the stack in one undo step. */
export function bakeLiveFilters(session: EditorSession, layerId: string): boolean {
  const document = session.document, layer = session.layer(layerId);
  if (!document || !layer?.raster || !layer.filters.length || session.editBlocker(layerId, 'pixels')) return false;
  let raster = layer.raster, transform = layer.transform;
  for (const filter of layer.filters) {
    if (!filter.enabled) continue;
    const converted = filterSettings(filter), made = applyFilter(converted.kind, raster, transform, converted.settings, { seed: 0x6d2b79f5 });
    raster = made.raster; transform = made.transform;
  }
  let mask = layer.mask;
  if (mask && !mask.placement && (raster.width !== layer.raster.width || raster.height !== layer.raster.height)) {
    mask = { ...mask, raster: carryMask(mask.raster, layer.transform, transform, raster.width, raster.height) };
  }
  const replacement: Layer = { ...withLayerRaster(layer, raster, transform, mask), filters: [] };
  session.edit('Apply Live Filters', () => session.replaceDocument({ ...document,
    layers: document.layers.map((item) => item.id === layerId ? replacement : item) }));
  return true;
}
