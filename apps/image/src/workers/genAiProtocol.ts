export type GenAiStage = 'loading-model' | 'processing' | 'assembling';

export type GenAiWorkerRequest =
  | { readonly op: 'inpaint'; readonly id: number; readonly modelUrl: string; readonly rgba: Uint8Array;
      readonly mask: Uint8Array; readonly width: number; readonly height: number; readonly tileSize?: number }
  | { readonly op: 'upscale'; readonly id: number; readonly modelUrl: string; readonly rgba: Uint8Array;
      readonly width: number; readonly height: number; readonly scale: 2 | 4; readonly strength: number; readonly tileSize?: number }
  | { readonly op: 'cancel'; readonly id: number };

export type GenAiWorkerResponse =
  | { readonly id: number; readonly type: 'progress'; readonly stage: GenAiStage; readonly value: number;
      readonly backend: 'webgpu' | 'wasm' }
  | { readonly id: number; readonly type: 'result'; readonly rgba: Uint8Array; readonly width: number;
      readonly height: number; readonly backend: 'webgpu' | 'wasm'; readonly inferenceMs: number }
  | { readonly id: number; readonly type: 'error'; readonly error: string };
