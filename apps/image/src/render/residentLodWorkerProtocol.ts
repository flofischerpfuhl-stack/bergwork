import type { Channels } from '../core/raster';
import type { PixelArray, RasterFormat } from '../core/pixel/format';
import type { RasterTransfer } from '../core/transfer';

export type ResidentLodWorkerRequest =
  | { readonly type: 'init'; readonly width: number; readonly height: number; readonly channels: Channels; readonly format: RasterFormat;
      readonly tileCount: number }
  | { readonly type: 'tile'; readonly indices: readonly number[]; readonly data: PixelArray }
  | { readonly type: 'finish' };

export type ResidentLodWorkerResponse =
  | { readonly ok: true; readonly raster: RasterTransfer; readonly workerMs: number }
  | { readonly ok: false; readonly error: string };
