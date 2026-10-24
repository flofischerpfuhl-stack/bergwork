/** Tight-alpha cropping from Filters.swift (`PixelFilter.trimmed`). */

import { apply, pixelToDocument, type LayerTransform } from './geometry';
import { alphaBounds, cropRaster, type Raster } from './raster';

export interface TrimmedRaster {
  readonly raster: Raster;
  readonly transform: LayerTransform;
}

/**
 * Crops transparent RGBA edges while keeping visible pixels at the same document coordinates.
 * Like upstream, a completely transparent image is kept unchanged rather than becoming zero-sized.
 */
export function trimmed(raster: Raster, placed: LayerTransform): TrimmedRaster | null {
  const crop = alphaBounds(raster);
  if (!crop || (crop.x === 0 && crop.y === 0 && crop.width === raster.width && crop.height === raster.height)) {
    return { raster, transform: placed };
  }
  const size = {
    width: crop.width * placed.size.width / raster.width,
    height: crop.height * placed.size.height / raster.height,
  };
  const middle = apply(pixelToDocument(placed, raster.width, raster.height),
    { x: crop.x + crop.width / 2, y: crop.y + crop.height / 2 });
  return {
    raster: cropRaster(raster, crop.x, crop.y, crop.width, crop.height),
    transform: { ...placed, size, origin: { x: middle.x - size.width / 2, y: middle.y - size.height / 2 } },
  };
}
