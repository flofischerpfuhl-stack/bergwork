import type { LayerTransform, Point } from '../geometry';
import type { PixelArray, RasterFormat } from '../pixel/format';
import type { RasterTransfer } from '../transfer';
import type { DocumentSelection } from '../selection';
import type { RetouchMode, RetouchSettings } from './index';

export interface RetouchReplayRequest {
  readonly source: RasterTransfer;
  readonly transform: LayerTransform;
  readonly mode: RetouchMode;
  readonly settings: RetouchSettings;
  readonly selection: (Omit<DocumentSelection, 'mask'> & { readonly mask: RasterTransfer }) | null;
  readonly batches: readonly (readonly Point[])[];
}

export interface RetouchTileTransfer { readonly index: number; readonly data: ArrayBuffer | null }

export type RetouchReplayResponse =
  | { readonly type: 'result'; readonly format: RasterFormat; readonly tiles: readonly RetouchTileTransfer[];
      readonly timingMs: number }
  | { readonly type: 'error'; readonly message: string };

export function changedRetouchTiles(original: readonly (PixelArray | null)[], next: readonly (PixelArray | null)[]):
  { tiles: RetouchTileTransfer[]; transfers: Transferable[] } {
  const tiles: RetouchTileTransfer[] = [], transfers: Transferable[] = [];
  for (let index = 0; index < next.length; index++) {
    const tile = next[index] ?? null;
    if (tile === original[index]) continue;
    if (!tile) { tiles.push({ index, data: null }); continue; }
    const data = tile.slice().buffer; tiles.push({ index, data }); transfers.push(data);
  }
  return { tiles, transfers };
}
