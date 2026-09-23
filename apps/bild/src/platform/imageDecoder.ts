/** Optional capabilities carried by a HostAdapter without changing the shared contracts.ts boundary. */
export type ExifOrientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface HostDecodedImage {
  readonly width: number;
  readonly height: number;
  /** Straight-alpha RGBA8 in sRGB, in un-oriented source order. */
  readonly rgba: Uint8Array;
  readonly orientation?: ExifOrientation;
}

export interface ImageDecoderHost {
  decodeImage?(bytes: Uint8Array, mime: string): Promise<HostDecodedImage | null>;
  /** Explicit opt-in. The default/absent value never loads LGPL code. */
  readonly heicDecoder?: 'lgpl-wasm';
}
