/**
 * LiveMaskBaker (LiveLayerMask.swift): a layer's own pixels, at its own pixel grid, with only its
 * live (clipping) coverage baked into alpha. Its raster mask, opacity and blend mode stay as layer
 * properties. Rendered by the GPU compositor with the target's grid as the view.
 */

import type { CanvasDocument } from '../core/document';
import { pixelToDocument, makeTransform } from '../core/geometry';
import { Raster } from '../core/raster';
import type { GpuCompositor } from '../render/gpuCompositor';

export function bakeLiveMaskGpu(gpu: GpuCompositor, document: CanvasDocument, targetId: string): Raster | null {
  const target = document.layers.find((l) => l.id === targetId);
  if (!target?.raster || !target.maskSourceId) return null;
  const { width, height } = target.raster;
  // Sources supply coverage whatever their visibility; hide everything else, draw the target plainly.
  const chain = new Set<string>();
  let source: string | null = target.maskSourceId;
  const byId = new Map(document.layers.map((l) => [l.id, l]));
  while (source && !chain.has(source) && chain.size < 256) { chain.add(source); source = byId.get(source)?.maskSourceId ?? null; }
  const layers = document.layers
    .filter((l) => chain.has(l.id) || l.id === targetId)
    .map((l) => (l.id === targetId
      ? { ...l, parentId: null, visible: true, opacity: 1, blendMode: 'normal' as const, mask: null }
      : { ...l, parentId: null, visible: false }));
  const view = pixelToDocument(target.transform, width, height);
  const scale = Math.max(1e-6, Math.min(target.transform.size.width / width, target.transform.size.height / height));
  const pixels = gpu.readView({ ...document, layers, selection: null }, width, height, view, 1 / scale);
  return Raster.fromPixels(width, height, 4, pixels);
}

export { makeTransform };
