/** Shared source-local coverage for the editable per-layer crop parameter. */
import { clamp01 } from './blend';
import type { CropParameters } from './model';

export function layerCropCoverage(crop: CropParameters | null, x: number, y: number): number {
  if (!crop) return 1;
  const { rect } = crop, right = rect.x + rect.width, bottom = rect.y + rect.height;
  if (x < rect.x || y < rect.y || x >= right || y >= bottom) return 0;
  if (!(crop.feather > 0)) return 1;
  return clamp01(Math.min(x - rect.x, right - x, y - rect.y, bottom - y) / crop.feather);
}
