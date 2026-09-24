import type { ColourRangeSettings } from '../core/refine/colourRange';
import type { RefineEdgeResult, RefineEdgeSettings } from '../core/refine/engine';

export type RefineWorkerRequest =
  | { readonly op: 'refine'; readonly id: number; readonly rgba: Uint8Array; readonly mask: Uint8Array;
      readonly width: number; readonly height: number; readonly settings: Partial<RefineEdgeSettings> }
  | { readonly op: 'colourRange'; readonly id: number; readonly rgba: Uint8Array; readonly width: number; readonly height: number;
      readonly settings: ColourRangeSettings }
  | { readonly op: 'cancel'; readonly id: number };

export type RefineWorkerResponse =
  | { readonly id: number; readonly type: 'result'; readonly result: RefineEdgeResult }
  | { readonly id: number; readonly type: 'mask'; readonly mask: Uint8Array }
  | { readonly id: number; readonly type: 'error'; readonly error: string };
