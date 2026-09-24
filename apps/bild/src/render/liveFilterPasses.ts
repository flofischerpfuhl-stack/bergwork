import { applyLiveFilters } from '../core/filters/live';
import type { CompositeHooks } from './hooks';

/** CPU-backed cached live-filter source pass shared by both compositors and destructive Apply. */
export function liveFilterHooks(hooks: CompositeHooks): CompositeHooks {
  return { ...hooks, raster: (layer) => {
    const raster = hooks.raster(layer);
    return raster && layer.filters.length ? applyLiveFilters(raster, layer.filters) : raster;
  } };
}
