import type { Layer } from '../core/document';
import { VectorRasterCache } from '../core/vector/render';
import { DEFAULT_HOOKS, type CompositeHooks } from './gpuCompositor';

export { VectorRasterCache };

/** Hooks shared by the software and WebGL compositors after the lazy CanvasKit cache is prepared. */
export function vectorCompositeHooks(cache: VectorRasterCache, base: CompositeHooks = DEFAULT_HOOKS): CompositeHooks {
  return {
    ...base,
    raster: (layer: Layer) => layer.kind === 'vector' ? cache.raster(layer) : base.raster(layer),
    // Preserve transient session transforms supplied by the caller; vector rasters use the same layer-space contract.
    transform: (layer: Layer) => base.transform(layer),
    maskRaster: (layer: Layer) => layer.vectorMask?.enabled ? cache.maskRaster(layer) : base.maskRaster(layer),
    maskPlacement: (layer: Layer) => layer.vectorMask?.enabled ? cache.maskPlacement(layer) : base.maskPlacement(layer),
  };
}
