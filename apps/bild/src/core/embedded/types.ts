import type { EmbeddedLayer } from '../model';
import type { Raster } from '../raster';

export type EmbeddedMediaType = EmbeddedLayer['content']['mediaType'];
export type EmbeddedMode = EmbeddedLayer['content']['mode'];

/** A decoded source ready to enter the immutable document model. `bytes` always remain the authority. */
export interface PreparedEmbeddedSource {
  readonly bytes: Uint8Array;
  readonly mime: string;
  readonly mediaType: EmbeddedMediaType;
  readonly sourceName: string;
  readonly width: number;
  readonly height: number;
  readonly raster: Raster;
  readonly mode?: EmbeddedMode;
  readonly uri?: string;
  readonly page?: number;
  readonly modifiedAt?: number;
}

export type EmbeddedLinkState = 'current' | 'changed' | 'missing' | 'unavailable';

export interface EmbeddedLinkStatus {
  readonly state: EmbeddedLinkState;
  readonly sha256: string | null;
  readonly checkedAt: number;
  readonly message?: string;
}
