import type { ObjectPrompt, ObjectSelectResult, ObjectSelectStage } from '../core/objectSelect/types';

export type ObjectSelectWorkerRequest =
  | { readonly op: 'select'; readonly id: number; readonly cacheKey: string; readonly rgba: Uint8Array;
      readonly width: number; readonly height: number; readonly prompts: readonly ObjectPrompt[];
      readonly modelUrls: { readonly encoder: string; readonly decoder: string } }
  | { readonly op: 'cancel'; readonly id: number };

export type ObjectSelectWorkerResponse =
  | { readonly id: number; readonly type: 'progress'; readonly stage: ObjectSelectStage; readonly value: number }
  | { readonly id: number; readonly type: 'result'; readonly result: ObjectSelectResult }
  | { readonly id: number; readonly type: 'error'; readonly error: string };
