/**
 * Documents across worker boundaries. Rasters travel as plain tile arrays (structured clone);
 * coming back, any raster whose id and tiles are unchanged is replaced by the original instance so
 * history sharing and GPU texture caches keep working.
 */

import type { CanvasDocument, Layer } from './document';
import { Raster, type Channels, type EncodedSource } from './raster';
import type { PixelArray, RasterFormat } from './pixel/format';

export interface RasterTransfer {
  id: string;
  width: number;
  height: number;
  channels: Channels;
  format: RasterFormat;
  tiles: (PixelArray | null)[];
  source: EncodedSource | null;
}
type LayerTransferFor<L extends Layer> = L extends Layer ? Omit<L, 'raster' | 'mask'> & {
  mask: (Omit<NonNullable<Layer['mask']>, 'raster'> & { raster: RasterTransfer }) | null;
} & (L extends { readonly raster: Raster | null } ? { raster: RasterTransfer | null } : { raster?: never }) : never;
export type LayerTransfer = LayerTransferFor<Layer>;
export type DocumentTransfer = Omit<CanvasDocument, 'layers' | 'selection'> & {
  layers: LayerTransfer[];
  selection: (Omit<NonNullable<CanvasDocument['selection']>, 'mask'> & { mask: RasterTransfer }) | null;
};

export function rasterToTransfer(raster: Raster): RasterTransfer {
  return { id: raster.id, width: raster.width, height: raster.height, channels: raster.channels,
    format: raster.format, tiles: raster.tiles.slice(), source: raster.source };
}

export function rasterFromTransfer(value: RasterTransfer, known?: ReadonlyMap<string, Raster>): Raster {
  const original = known?.get(value.id);
  // Rasters are immutable: the same id always means the same pixels.
  if (original && original.width === value.width && original.height === value.height
    && original.channels === value.channels && original.format === value.format) return original;
  return new Raster(value.width, value.height, value.channels, value.tiles,
    { id: value.id, source: value.source, format: value.format });
}

export function documentToTransfer(document: CanvasDocument): DocumentTransfer {
  return {
    ...document,
    layers: document.layers.map(layerToTransfer),
    selection: document.selection ? { ...document.selection, mask: rasterToTransfer(document.selection.mask) } : null,
  };
}

function layerToTransfer(layer: Layer): LayerTransfer {
  const mask = layer.mask ? { ...layer.mask, raster: rasterToTransfer(layer.mask.raster) } : null;
  switch (layer.kind) {
    case 'pixel': return { ...layer, raster: layer.raster ? rasterToTransfer(layer.raster) : null, mask };
    case 'vector': return { ...layer, raster: layer.raster ? rasterToTransfer(layer.raster) : null, mask };
    case 'text': return { ...layer, raster: layer.raster ? rasterToTransfer(layer.raster) : null, mask };
    case 'embedded': return { ...layer, raster: layer.raster ? rasterToTransfer(layer.raster) : null, mask };
    case 'group': return { ...layer, mask };
    case 'adjustment': return { ...layer, mask };
    case 'fill': return { ...layer, mask };
  }
}

export function documentFromTransfer(value: DocumentTransfer, original?: CanvasDocument | null): CanvasDocument {
  const known = new Map<string, Raster>();
  for (const layer of original?.layers ?? []) {
    if (layer.raster) known.set(layer.raster.id, layer.raster);
    if (layer.mask) known.set(layer.mask.raster.id, layer.mask.raster);
  }
  if (original?.selection) known.set(original.selection.mask.id, original.selection.mask);
  // Rasters shared by several layers stay shared.
  const rebuilt = new Map<string, Raster>();
  const raster = (transfer: RasterTransfer): Raster => {
    const existing = rebuilt.get(transfer.id);
    if (existing) return existing;
    const result = rasterFromTransfer(transfer, known);
    rebuilt.set(transfer.id, result);
    return result;
  };
  return {
    ...value,
    layers: value.layers.map((layer) => layerFromTransfer(layer, raster)),
    selection: value.selection ? { ...value.selection, mask: raster(value.selection.mask) } : null,
  };
}

export function layerFromTransfer(value: LayerTransfer, raster: (value: RasterTransfer) => Raster = rasterFromTransfer): Layer {
  const mask = value.mask ? { ...value.mask, raster: raster(value.mask.raster) } : null;
  switch (value.kind) {
    case 'pixel': return { ...value, raster: value.raster ? raster(value.raster) : null, mask };
    case 'vector': return { ...value, raster: value.raster ? raster(value.raster) : null, mask };
    case 'text': return { ...value, raster: value.raster ? raster(value.raster) : null, mask };
    case 'embedded': return { ...value, raster: value.raster ? raster(value.raster) : null, mask };
    case 'group': return { ...value, mask };
    case 'adjustment': return { ...value, mask };
    case 'fill': return { ...value, mask };
  }
}
