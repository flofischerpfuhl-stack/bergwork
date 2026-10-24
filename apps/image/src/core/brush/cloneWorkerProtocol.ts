import type { DocumentTransfer, RasterTransfer } from '../transfer';
import type { LayerTransform, Point, Rect, Size } from '../geometry';
import type { BrushSettings } from './settings';

export interface CloneWorkerUpdate {
  readonly points: readonly Point[];
  readonly options?: { readonly pressure?: number | readonly number[]; readonly tilt?: number | readonly number[] };
}

export interface CloneWorkerRequest {
  readonly document: DocumentTransfer;
  readonly activeLayerId: string;
  readonly allLayers: boolean;
  readonly offset: Size;
  readonly canvas: Size;
  readonly settings: BrushSettings;
  readonly target: 'pixels' | 'mask';
  readonly pixelLimit: number;
  readonly updates: readonly CloneWorkerUpdate[];
}

export type CloneWorkerResponse =
  | { readonly ok: true; readonly raster: RasterTransfer; readonly transform?: LayerTransform;
      readonly bounds: Rect; readonly sourceRect: Rect; readonly workerMs: number }
  | { readonly ok: false; readonly error: string };
