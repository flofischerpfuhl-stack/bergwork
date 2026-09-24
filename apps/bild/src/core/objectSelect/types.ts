export type ObjectPrompt =
  | { readonly kind: 'point'; readonly x: number; readonly y: number; readonly positive: boolean }
  | { readonly kind: 'box'; readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number };

export interface ObjectSelectTiming {
  readonly encoderMs: number;
  readonly decoderMs: number;
  readonly refinementMs: number;
  readonly backend: 'webgpu' | 'wasm';
  readonly embeddingCacheHit: boolean;
}

export interface ObjectSelectResult {
  readonly mask: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly score: number;
  readonly timing: ObjectSelectTiming;
}

export type ObjectSelectStage = 'loading-model' | 'encoding' | 'decoding' | 'refining';
