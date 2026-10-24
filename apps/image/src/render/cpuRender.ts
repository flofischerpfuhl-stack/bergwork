/**
 * The CPU compositing path shared by the software compositor, the headless export renderer and the PSD fidelity oracle,
 * so that all three draw exactly what the canvas shows: live filters change a layer's content first, layer effects are
 * then computed from the filtered alpha (Photoshop order, same as the GPU compositor).
 */

import { applyAdjustment } from '../core/adjust/apply';
import {
  compositeRegion, compositeRegionFloat, compositeView, compositeViewFloat, type CompositeOptions,
} from '../core/composite';
import type { CanvasDocument } from '../core/document';
import { documentWithLayerEffects } from '../core/effects';
import type { Affine, Rect } from '../core/geometry';
import { DEFAULT_HOOKS, type CompositeHooks } from './hooks';
import { liveFilterHooks } from './liveFilterPasses';

/** Applies live filters to the hooks and expands layer effects into the document. Call once per render. */
export function prepareCpuRender(document: CanvasDocument, hooks: CompositeHooks): { document: CanvasDocument; hooks: CompositeHooks } {
  const filtered = liveFilterHooks(hooks);
  return { document: documentWithLayerEffects(document, filtered), hooks: filtered };
}

function options(hooks: CompositeHooks): CompositeOptions {
  return {
    transform: hooks.transform, maskPlacement: hooks.maskPlacement, blendMode: hooks.blendMode,
    raster: hooks.raster, maskRaster: hooks.maskRaster, adjust: applyAdjustment,
  };
}

/** Straight-alpha RGBA8 of a document region, with effects, live filters and adjustments. */
export function cpuCompositeRegion(document: CanvasDocument, rect: Rect, hooks: CompositeHooks = DEFAULT_HOOKS): Uint8Array {
  const prepared = prepareCpuRender(document, hooks);
  return compositeRegion(prepared.document, rect, options(prepared.hooks)).rgba;
}

export function cpuCompositeRegionFloat(document: CanvasDocument, rect: Rect, hooks: CompositeHooks = DEFAULT_HOOKS): Float32Array {
  const prepared = prepareCpuRender(document, hooks);
  return compositeRegionFloat(prepared.document, rect, options(prepared.hooks)).rgba;
}

export function cpuCompositeView(document: CanvasDocument, width: number, height: number, viewToDoc: Affine,
  hooks: CompositeHooks = DEFAULT_HOOKS): Uint8Array {
  const prepared = prepareCpuRender(document, hooks);
  return compositeView(prepared.document, width, height, viewToDoc, options(prepared.hooks)).rgba;
}

export function cpuCompositeViewFloat(document: CanvasDocument, width: number, height: number, viewToDoc: Affine,
  hooks: CompositeHooks = DEFAULT_HOOKS): Float32Array {
  const prepared = prepareCpuRender(document, hooks);
  return compositeViewFloat(prepared.document, width, height, viewToDoc, options(prepared.hooks)).rgba;
}
