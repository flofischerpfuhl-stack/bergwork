import type { Channels } from '../core/raster';
import { Raster } from '../core/raster';
import type { RasterFormat } from '../core/pixel/format';
import type { PsdWriteFormat, PsdWriteNotice } from '../io/psd';
import type { PsdColorTransferResult, PsdColorTransferSpec } from '../io/psd/reader';

/** A raster crossing the PSD worker boundary as independently transferable 256 px tiles. */
export interface PsdWireRaster {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly channels: Channels;
  readonly format: RasterFormat;
  readonly tiles: readonly (Uint8Array | Uint16Array | null)[];
}

interface PsdWireRasterRef { readonly __fernworkPsdRaster: number }

export interface PsdWireValue {
  readonly value: unknown;
  readonly rasters: readonly PsdWireRaster[];
}

export interface PsdWorkerTiming {
  readonly operation: 'read' | 'write';
  readonly codecMs: number;
  readonly tileMs: number;
  readonly tileBytes: number;
  readonly tileCount: number;
}

export type PsdWorkerRequest =
  | { readonly id: number; readonly type: 'read'; readonly bytes: Uint8Array }
  | { readonly id: number; readonly type: 'color-transfer'; readonly spec: PsdColorTransferSpec }
  | { readonly id: number; readonly type: 'write'; readonly document: PsdWireValue;
      readonly options: { readonly format?: PsdWriteFormat | 'auto'; readonly bitsPerChannel?: 8 | 16;
        readonly iccProfile?: Uint8Array | null } };

export type PsdWorkerResponse =
  | { readonly id: number; readonly ok: true; readonly type: 'read'; readonly result: PsdWireValue; readonly timing: PsdWorkerTiming }
  | { readonly id: number; readonly ok: true; readonly type: 'color-transfer'; readonly result: PsdColorTransferResult }
  | { readonly id: number; readonly ok: true; readonly type: 'write'; readonly bytes: Uint8Array; readonly format: PsdWriteFormat;
      readonly bitsPerChannel: 8 | 16; readonly notices: readonly PsdWriteNotice[]; readonly timing: PsdWorkerTiming }
  | { readonly id: number; readonly ok: false; readonly error: string };

function isRasterRef(value: unknown): value is PsdWireRasterRef {
  return !!value && typeof value === 'object' && Object.keys(value).length === 1
    && Number.isInteger((value as PsdWireRasterRef).__fernworkPsdRaster);
}

/**
 * Replaces Raster instances with small references. `copyTiles` is true for writer input because the
 * live document must keep its buffers; reader output owns its freshly decoded tiles and transfers them.
 */
export function packPsdValue(value: unknown, copyTiles: boolean): PsdWireValue {
  const rasters: PsdWireRaster[] = [];
  const indices = new WeakMap<Raster, number>();
  const visit = (item: unknown): unknown => {
    if (item instanceof Raster) {
      let index = indices.get(item);
      if (index === undefined) {
        index = rasters.length;
        indices.set(item, index);
        rasters.push({ id: item.id, width: item.width, height: item.height, channels: item.channels, format: item.format,
          tiles: item.tiles.map((tile) => copyTiles && tile ? tile.slice() : tile) });
      }
      return { __fernworkPsdRaster: index } satisfies PsdWireRasterRef;
    }
    if (Array.isArray(item)) return item.map(visit);
    if (!item || typeof item !== 'object' || ArrayBuffer.isView(item) || item instanceof ArrayBuffer) return item;
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(item)) output[key] = visit(child);
    return output;
  };
  return { value: visit(value), rasters };
}

/** Reconstructs Raster prototypes and preserves shared raster identity. */
export function unpackPsdValue<T>(wire: PsdWireValue): T {
  const rasters = wire.rasters.map((raster) => new Raster(raster.width, raster.height, raster.channels, raster.tiles,
    { id: raster.id, format: raster.format }));
  const visit = (item: unknown): unknown => {
    if (isRasterRef(item)) {
      const raster = rasters[item.__fernworkPsdRaster];
      if (!raster) throw new RangeError('PSD worker returned an invalid raster reference.');
      return raster;
    }
    if (Array.isArray(item)) return item.map(visit);
    if (!item || typeof item !== 'object' || ArrayBuffer.isView(item) || item instanceof ArrayBuffer) return item;
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(item)) output[key] = visit(child);
    return output;
  };
  return visit(wire.value) as T;
}

export function psdWireTransfers(wire: PsdWireValue): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  for (const raster of wire.rasters) for (const tile of raster.tiles) {
    if (tile?.buffer instanceof ArrayBuffer) buffers.add(tile.buffer);
  }
  return [...buffers];
}

export function psdWireMetrics(wire: PsdWireValue): { tileBytes: number; tileCount: number } {
  let tileBytes = 0, tileCount = 0;
  for (const raster of wire.rasters) for (const tile of raster.tiles) if (tile) {
    tileBytes += tile.byteLength; tileCount++;
  }
  return { tileBytes, tileCount };
}
