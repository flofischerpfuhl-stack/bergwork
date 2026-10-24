import type { LayerTransfer, RasterTransfer } from '../transfer';
import type { Channels } from '../raster';
import type { RasterFormat } from '../pixel/format';
import type { LayerTransform, Rect, Size } from '../geometry';
import type { BrushSegment } from './stroke';
import type { BrushSettings } from './settings';

export interface BrushWorkerOptions {
  readonly layer: LayerTransfer;
  readonly canvas: Size;
  readonly settings: BrushSettings;
  readonly target: 'pixels' | 'mask';
  readonly pixelLimit: number;
  readonly patchable: boolean;
  readonly partition: { readonly index: number; readonly count: number };
  readonly selection: { readonly mask: RasterTransfer; readonly x: number; readonly y: number;
    readonly antialiased: boolean } | null;
}

export type BrushWorkerRequest =
  | { readonly type: 'init'; readonly options: BrushWorkerOptions }
  | { readonly type: 'settled'; readonly segments: readonly BrushSegment[]; readonly bases: readonly BrushBaseTile[] }
  | { readonly type: 'finish'; readonly segments: readonly BrushSegment[]; readonly bases: readonly BrushBaseTile[] }
  | { readonly type: 'cancel' };

export interface BrushBaseTile {
  readonly index: number;
  readonly data: ArrayBuffer;
}

export interface BrushTileTransfer {
  readonly index: number;
  readonly data: ArrayBuffer | null;
}

export type BrushWorkerResponse =
  | { readonly type: 'snapshot'; readonly width: number; readonly height: number; readonly channels: Channels; readonly format: RasterFormat;
    readonly reset: boolean; readonly tiles: readonly BrushTileTransfer[] }
  | { readonly type: 'finished'; readonly width: number; readonly height: number; readonly channels: Channels; readonly format: RasterFormat;
    readonly reset: boolean; readonly tiles: readonly BrushTileTransfer[]; readonly transform?: LayerTransform;
    readonly bounds: Rect; readonly sourceRect: Rect; readonly timing: { init: number; settled: number; finish: number } }
  | { readonly type: 'error'; readonly message: string };
