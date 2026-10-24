import { carryMask, applyFilter } from './apply';
import { defaultFilterSettings, type FilterKind } from './settings';
import type { EditorSession } from '../session';
import { withLayerRaster, type Layer, type LayerMask, type LiveFilter } from '../document';
import type { Raster } from '../raster';
import { Raster as RasterValue } from '../raster';
import { compositePremultiplied } from '../blend';
import { makePixelArray } from '../pixel/format';
import { apply, pixelToDocument, type LayerTransform } from '../geometry';
import { mapPlacement, maskBackground, preparePlacement, prepareSampler, sampleMask } from '../resample';

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
    case 'denoise': return { kind, schemaVersion: 1, enabled: true, luminance: 25, colour: 25, detail: 50 };
    case 'vignette': {
      const d = defaultFilterSettings();
      return { kind, schemaVersion: 1, enabled: true, color: d.vignetteColor, amount: d.vignetteAmount, midpoint: d.vignetteMidpoint,
        roundness: d.vignetteRoundness, feather: d.vignetteFeather, highlights: d.vignetteHighlights };
    }
    case 'bloom': return { kind, schemaVersion: 1, enabled: true, threshold: 50, radius: 24, amount: 40 };
    case 'tonalContrast': return { kind, schemaVersion: 1, enabled: true, radius: 16, amount: 50, shadows: 40, midtones: 60, highlights: 30 };
    case 'progressiveBlur': return { kind, schemaVersion: 1, enabled: true, angle: -90, start: 35, end: 100, radius: 20 };
    case 'rgbSplit': return { kind, schemaVersion: 1, enabled: true, distance: 10, blur: 0, angle: 0, radial: false };
  }
}

/** The destructive filter and settings a live filter runs as (also used to bake it). */
export function liveFilterSettings(filter: LiveFilter): { kind: FilterKind; settings: ReturnType<typeof defaultFilterSettings> } {
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
    case 'denoise': return { kind: 'Denoise', settings: { ...base, luminance: filter.luminance,
      colour: filter.colour, detail: filter.detail ?? 50 } };
    case 'vignette': return { kind: 'Vignette', settings: { ...base, vignetteColor: filter.color, vignetteAmount: filter.amount,
      vignetteMidpoint: filter.midpoint, vignetteRoundness: filter.roundness, vignetteFeather: filter.feather,
      vignetteHighlights: filter.highlights } };
    case 'bloom': return { kind: 'Bloom / Glow', settings: { ...base, bloomThreshold: filter.threshold,
      bloomRadius: filter.radius, bloomAmount: filter.amount } };
    case 'tonalContrast': return { kind: 'Tonal Contrast', settings: { ...base, tonalRadius: filter.radius, tonalAmount: filter.amount,
      tonalShadows: filter.shadows, tonalMidtones: filter.midtones, tonalHighlights: filter.highlights } };
    case 'progressiveBlur': return { kind: 'Progressive Blur', settings: { ...base, progressiveAngle: filter.angle,
      progressiveStart: filter.start, progressiveEnd: filter.end, progressiveRadius: filter.radius } };
    case 'rgbSplit': return { kind: 'RGB Split', settings: { ...base, rgbSplitDistance: filter.distance, rgbSplitBlur: filter.blur,
      rgbSplitAngle: filter.angle, rgbSplitRadial: filter.radial } };
  }
}

export function applyLiveFilter(raster: Raster, filter: LiveFilter): Raster {
  if (!filter.enabled) return raster;
  const converted = liveFilterSettings(filter);
  const filtered = applyFilter(converted.kind, raster, {
    origin: { x: 0, y: 0 }, size: { width: raster.width, height: raster.height }, rotation: 0,
    flipX: false, flipY: false, sampling: 'High quality',
  }, converted.settings, { expand: false, seed: 0x6d2b79f5 }).raster;
  const opacity = Math.min(1, Math.max(0, filter.opacity ?? 1)), mode = filter.blendMode ?? 'normal';
  if (opacity >= 1 && mode === 'normal') return filtered;
  const original = raster.toPixelsNative(), changed = filtered.toPixelsNative(), maximum = raster.maximum;
  const output = makePixelArray(raster.format, original.length), pixel = new Float32Array(4), scratch = new Float64Array(6);
  for (let offset = 0; offset < original.length; offset += 4) {
    const ba = original[offset + 3]! / maximum, sa = changed[offset + 3]! / maximum;
    pixel[0] = original[offset]! / maximum * ba; pixel[1] = original[offset + 1]! / maximum * ba;
    pixel[2] = original[offset + 2]! / maximum * ba; pixel[3] = ba;
    compositePremultiplied(pixel, 0, changed[offset]! / maximum * sa * opacity,
      changed[offset + 1]! / maximum * sa * opacity, changed[offset + 2]! / maximum * sa * opacity,
      sa * opacity, mode, false, scratch);
    const alpha = pixel[3]!;
    output[offset + 3] = Math.round(Math.min(1, Math.max(0, alpha)) * maximum);
    for (let channel = 0; channel < 3; channel++) output[offset + channel] = Math.round(
      Math.min(1, Math.max(0, alpha > 0 ? pixel[channel]! / alpha : 0)) * maximum);
  }
  return RasterValue.fromPixels(raster.width, raster.height, 4, output, { format: raster.format });
}

const cache = new WeakMap<Raster, WeakMap<object, Raster>>();
/** Masked stacks keyed by raster, stack and mask; the transform places the mask, so a moved layer recomputes. */
const maskedCache = new WeakMap<Raster, WeakMap<object, WeakMap<LayerMask, { transform: LayerTransform; result: Raster }>>>();
function applyFilterMask(original: Raster, filtered: Raster, mask: LayerMask, transform: LayerTransform): Raster {
  if (!mask.enabled || mask.raster.channels !== 1) return filtered;
  const before = original.toPixelsNative(), after = filtered.toPixelsNative(), maximum = original.maximum;
  const output = makePixelArray(original.format, before.length), sourceToDocument = pixelToDocument(transform, original.width, original.height);
  const placement = mask.placement ?? transform;
  const prepared = preparePlacement({ ...placement, sampling: 'High quality' }, mask.raster.width, mask.raster.height);
  const sampler = prepareSampler(mask.raster, 'High quality', mask.raster.width), location = new Float64Array(3);
  const outside = (mask.defaultColor ?? Math.round(maskBackground(mask.raster) * 255)) / 255;
  for (let y = 0; y < original.height; y++) for (let x = 0; x < original.width; x++) {
    const point = apply(sourceToDocument, { x: x + 0.5, y: y + 0.5 });
    mapPlacement(prepared, point.x, point.y, location);
    const sampled = sampleMask(sampler, location[0]!, location[1]!);
    const coverage = outside + (sampled - outside) * location[2]!, offset = (y * original.width + x) * 4;
    const beforeAlpha = before[offset + 3]! / maximum, afterAlpha = after[offset + 3]! / maximum;
    const alpha = beforeAlpha * (1 - coverage) + afterAlpha * coverage;
    output[offset + 3] = Math.round(alpha * maximum);
    for (let channel = 0; channel < 3; channel++) {
      const straight = before[offset + channel]! / maximum * (1 - coverage)
        + after[offset + channel]! / maximum * coverage;
      output[offset + channel] = Math.round(Math.min(1, Math.max(0, straight)) * maximum);
    }
  }
  return RasterValue.fromPixels(original.width, original.height, 4, output, { format: original.format });
}

/** Cached, ordered live stack. Immutable filter arrays are the cache key. */
export function applyLiveFilters(raster: Raster, filters: readonly LiveFilter[], filterMask?: LayerMask | null,
  transform?: LayerTransform): Raster {
  if (!filters.some((filter) => filter.enabled)) return raster;
  let byStack: WeakMap<object, Raster> | undefined, known: Raster | undefined;
  if (!filterMask) {
    byStack = cache.get(raster); if (!byStack) { byStack = new WeakMap(); cache.set(raster, byStack); }
    known = byStack.get(filters as object); if (known) return known;
  }
  let byMask: WeakMap<LayerMask, { transform: LayerTransform; result: Raster }> | undefined;
  if (filterMask && transform) {
    let stacks = maskedCache.get(raster); if (!stacks) { stacks = new WeakMap(); maskedCache.set(raster, stacks); }
    byMask = stacks.get(filters as object); if (!byMask) { byMask = new WeakMap(); stacks.set(filters as object, byMask); }
    const entry = byMask.get(filterMask); if (entry?.transform === transform) return entry.result;
  }
  let result = raster;
  for (const filter of filters) result = applyLiveFilter(result, filter);
  if (filterMask && transform) {
    result = applyFilterMask(raster, result, filterMask, transform);
    byMask?.set(filterMask, { transform, result });
  } else byStack?.set(filters as object, result);
  return result;
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
  if (layer.filterMask) {
    const raster = applyLiveFilters(layer.raster, layer.filters, layer.filterMask, layer.transform);
    const replacement: Layer = { ...withLayerRaster(layer, raster), filters: [], filterMask: null };
    session.edit('Apply Live Filters', () => session.replaceDocument({ ...document,
      layers: document.layers.map((item) => item.id === layerId ? replacement : item) }));
    return true;
  }
  let raster = layer.raster, transform = layer.transform;
  for (const filter of layer.filters) {
    if (!filter.enabled) continue;
    const converted = liveFilterSettings(filter), made = applyFilter(converted.kind, raster, transform, converted.settings, { seed: 0x6d2b79f5 });
    raster = made.raster; transform = made.transform;
  }
  let mask = layer.mask;
  if (mask && !mask.placement && (raster.width !== layer.raster.width || raster.height !== layer.raster.height)) {
    mask = { ...mask, raster: carryMask(mask.raster, layer.transform, transform, raster.width, raster.height) };
  }
  const replacement: Layer = { ...withLayerRaster(layer, raster, transform, mask), filters: [], filterMask: null };
  session.edit('Apply Live Filters', () => session.replaceDocument({ ...document,
    layers: document.layers.map((item) => item.id === layerId ? replacement : item) }));
  return true;
}
