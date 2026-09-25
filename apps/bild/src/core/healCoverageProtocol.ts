import type { LayerTransfer, RasterTransfer } from './transfer';
import type { BrushSettings } from './brush/settings';
import type { LayerTransform, Point, Rect, Size } from './geometry';
import type { DocumentSelection } from './selection';

export interface HealCoverageReplayRequest {
  readonly layer: LayerTransfer;
  readonly canvas: Size;
  readonly settings: BrushSettings;
  readonly selection: (Omit<DocumentSelection, 'mask'> & { readonly mask: RasterTransfer }) | null;
  readonly pixelLimit: number;
  readonly updates: readonly { readonly points: readonly Point[];
    readonly pressure?: number | readonly number[] }[];
}

export type HealCoverageReplayResponse =
  | { readonly type: 'result'; readonly raster: RasterTransfer; readonly transform?: LayerTransform;
      readonly bounds: Rect; readonly sourceRect: Rect }
  | { readonly type: 'error'; readonly message: string };
