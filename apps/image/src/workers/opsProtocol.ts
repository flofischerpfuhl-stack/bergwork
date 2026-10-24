/** Messages of the document-operations worker (Image Size, Canvas Size, Crop, Distort). */

import type { Point, Rect } from '../core/geometry';
import type { LayerTransform } from '../core/geometry';
import type { CanvasResizeOptions, CropOptions, ImageResample } from '../core/canvasOps';
import type { DocumentTransfer, RasterTransfer } from '../core/transfer';

export type OpsRequest =
  | { op: 'imageSize'; document: DocumentTransfer; width: number; height: number; resolution: number; resample: ImageResample }
  | { op: 'canvasSize'; document: DocumentTransfer; width: number; height: number; anchor: number; options: CanvasResizeOptions }
  | { op: 'crop'; document: DocumentTransfer; rect: Rect; options: CropOptions }
  | { op: 'warp'; raster: RasterTransfer; transform: LayerTransform; corners: Point[]; mask: boolean; background: number };

export type OpsResponse =
  | { id: number; ok: true; document?: DocumentTransfer; raster?: RasterTransfer; transform?: LayerTransform }
  | { id: number; ok: false; error: string };
