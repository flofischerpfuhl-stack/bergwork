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
export type LayerTransfer = Omit<Layer, 'raster' | 'mask'> & {
  raster: RasterTransfer | null;
  mask: (Omit<NonNullable<Layer['mask']>, 'raster'> & { raster: RasterTransfer }) | null;
};
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
    layers: document.layers.map((layer) => ({
      ...layer,
      raster: layer.raster ? rasterToTransfer(layer.raster) : null,
      mask: layer.mask ? { ...layer.mask, raster: rasterToTransfer(layer.mask.raster) } : null,
    })),
    selection: document.selection ? { ...document.selection, mask: rasterToTransfer(document.selection.mask) } : null,
  };
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
    layers: value.layers.map((layer) => ({
      ...layer,
      raster: layer.raster ? raster(layer.raster) : null,
      mask: layer.mask ? { ...layer.mask, raster: raster(layer.mask.raster) } : null,
    })),
    selection: value.selection ? { ...value.selection, mask: raster(value.selection.mask) } : null,
  };
}
