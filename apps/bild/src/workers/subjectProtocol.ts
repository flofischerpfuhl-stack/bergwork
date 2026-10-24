import type { BackgroundSettings } from '../core/subject/maskProcessing';
import type { SubjectModel } from '../core/subject/models';

export type SubjectStage = 'downloading-model' | 'loading-model' | 'inferring' | 'refining';

export type SubjectWorkerRequest =
  | { readonly op: 'infer'; readonly id: number; readonly cacheKey: string; readonly model: SubjectModel;
      readonly modelBytes: Uint8Array; readonly modelCacheHit: boolean; readonly modelResolveMs: number;
      readonly width: number; readonly height: number; readonly rgba: Uint8Array;
      readonly settings: BackgroundSettings; readonly refinementLimit: number }
  | { readonly op: 'refine'; readonly id: number; readonly cacheKey: string;
      readonly settings: BackgroundSettings; readonly refinementLimit: number }
  | { readonly op: 'cancel'; readonly id: number };

export interface SubjectTiming {
  readonly downloadMs: number;
  readonly modelLoadMs: number;
  readonly inferenceMs: number;
  readonly refinementMs: number;
  readonly modelBytes: number;
  readonly modelCacheHit: boolean;
  /** Buffers directly owned by this job; the runtime may reserve additional backend memory. */
  readonly estimatedBytes: number;
  readonly backend: 'webgpu' | 'wasm';
}

export type SubjectWorkerResponse =
  | { readonly id: number; readonly type: 'progress'; readonly stage: SubjectStage; readonly progress: number;
      readonly downloadedBytes?: number; readonly totalBytes?: number | null }
  | { readonly id: number; readonly type: 'result'; readonly mask: Uint8Array; readonly timing: SubjectTiming;
      readonly componentCount: number }
  | { readonly id: number; readonly type: 'error'; readonly error: string };
