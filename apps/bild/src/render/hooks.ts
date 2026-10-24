/**
 * How a compositor reads each layer (shared by the GPU, software and headless CPU renderers). Kept free of PixiJS so the
 * CPU paths (export fallback, PSD fidelity, Node tests) can use it.
 */

import type { BlendMode, Layer } from '../core/document';
import type { LayerTransform } from '../core/geometry';
import type { Raster } from '../core/raster';
import type { GpuBrushPreview } from '../core/brush';

export interface CompositeHooks {
  transform(layer: Layer): LayerTransform;
  maskPlacement(layer: Layer): LayerTransform | null;
  blendMode(layer: Layer): BlendMode;
  /** Pixels to draw instead of the stored raster (brush stroke in progress, previews). */
  raster(layer: Layer): Raster | null | undefined;
  maskRaster(layer: Layer): Raster | null | undefined;
  /** Geometry-only Brush/Eraser preview; its immutable selection is sampled on the GPU. */
  readonly brush?: GpuBrushPreview | null;
}

export const DEFAULT_HOOKS: CompositeHooks = {
  transform: (l) => l.kind === 'text' ? l.renderedTransform ?? l.transform : l.transform,
  maskPlacement: (l) => l.mask?.placement ?? null,
  blendMode: (l) => l.blendMode,
  raster: (l) => l.raster ?? null,
  maskRaster: (l) => l.mask?.raster ?? null,
};
