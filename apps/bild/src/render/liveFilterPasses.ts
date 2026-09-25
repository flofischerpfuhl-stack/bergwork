import { applyLiveFilters } from '../core/filters/live';
import type { Layer } from '../core/document';
import type { LayerTransform } from '../core/geometry';
import type { Raster } from '../core/raster';
import type { BlendMode } from '../core/model';
import type { GpuBrushPreview } from '../core/brush';
import type { CompositeHooks } from './hooks';

/** Stable adapter for render loops whose source hooks can change between frames. */
export class LiveFilterHookAdapter implements CompositeHooks {
  constructor(protected source: CompositeHooks) {}

  use(source: CompositeHooks): CompositeHooks { this.source = source; return this; }
  readonly transform = (layer: Layer): LayerTransform => this.source.transform(layer);
  readonly maskPlacement = (layer: Layer): LayerTransform | null => this.source.maskPlacement(layer);
  readonly blendMode = (layer: Layer): BlendMode => this.source.blendMode(layer);
  readonly raster = (layer: Layer): Raster | null | undefined => {
    const raster = this.source.raster(layer);
    return raster && layer.filters.length ? applyLiveFilters(raster, layer.filters) : raster;
  };
  readonly maskRaster = (layer: Layer): Raster | null | undefined => this.source.maskRaster(layer);
  get brush(): GpuBrushPreview | null { return this.source.brush ?? null; }
}

/** CPU fallback only for style generation, whose distance fields still consume native-grid alpha. */
export class EffectLiveFilterHookAdapter extends LiveFilterHookAdapter {
  override readonly raster = (layer: Layer): Raster | null | undefined => {
    const raster = this.source.raster(layer);
    return raster && layer.filters.length && layer.effects.some((effect) => effect.enabled)
      ? applyLiveFilters(raster, layer.filters) : raster;
  };
}

const adapters = new WeakMap<CompositeHooks, CompositeHooks>();

/** CPU-backed cached live-filter source pass shared by both compositors and destructive Apply. */
export function liveFilterHooks(hooks: CompositeHooks): CompositeHooks {
  let adapter = adapters.get(hooks);
  if (!adapter) { adapter = new LiveFilterHookAdapter(hooks); adapters.set(hooks, adapter); }
  return adapter;
}
