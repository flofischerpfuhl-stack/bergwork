import type { ImageKind } from '../io/imageImport';
import type { RasterFormat } from '../core/pixel/format';

export interface ImageDecodeWorkerRequest {
  readonly id: number;
  readonly mode: 'asset' | 'tiles';
  readonly bytes: Uint8Array;
  readonly remainingPixels: number;
  readonly maxSide: number;
}

export interface ImageDecodeWorkerTiming {
  readonly decodeMs: number;
  readonly tileMs: number;
  readonly decodedBytes: number;
  readonly tileBytes: number;
}

export type ImageDecodeWorkerResponse =
  | { readonly id: number; readonly ok: true; readonly mode: 'asset'; readonly width: number; readonly height: number;
      readonly bitDepth: 8 | 16; readonly mime: ImageKind;
      readonly data: Uint8Array | Uint16Array; readonly timing: ImageDecodeWorkerTiming }
  | { readonly id: number; readonly ok: true; readonly mode: 'tiles'; readonly width: number; readonly height: number;
      readonly format: RasterFormat; readonly mime: ImageKind; readonly sha256: string;
      readonly tiles: readonly (Uint8Array | Uint16Array | null)[]; readonly timing: ImageDecodeWorkerTiming }
  | { readonly id: number; readonly ok: false; readonly code?: 'unreadable' | 'unsupported' | 'too-large'; readonly error: string };
