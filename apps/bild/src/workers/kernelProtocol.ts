import type { Kernels } from '../wasm/kernels.js';

export interface KernelCallMap {
  adjustGradientMap: Call<Kernels['adjustGradientMap']>;
  adjustGrain: Call<Kernels['adjustGrain']>;
  clampPremultiplied: Call<Kernels['clampPremultiplied']>;
  brushAlphaBounds: Call<Kernels['brushAlphaBounds']>;
  layerExtractAlpha: Call<Kernels['layerExtractAlpha']>;
  layerUnpremultiplyOpaque: Call<Kernels['layerUnpremultiplyOpaque']>;
  layerRestoreAlpha: Call<Kernels['layerRestoreAlpha']>;
  contentFill: Call<Kernels['contentFill']>;
  healCoverageBounds: Call<Kernels['healCoverageBounds']>;
  spotHeal: Call<Kernels['spotHeal']>;
  lensDistort: Call<Kernels['lensDistort']>;
  levelsApply: Call<Kernels['levelsApply']>;
  levelsHistogram: Call<Kernels['levelsHistogram']>;
  noiseAdd: Call<Kernels['noiseAdd']>;
  wandMask: Call<Kernels['wandMask']>;
  wandTrace: Call<Kernels['wandTrace']>;
}

type Call<F> = F extends (...args: infer A) => infer R ? { args: A; result: R } : never;
export type KernelMethod = keyof KernelCallMap;
export type KernelRequest = {
  [M in KernelMethod]: { readonly type: 'request'; readonly id: number; readonly method: M; readonly args: KernelCallMap[M]['args'] }
}[KernelMethod];
export interface KernelCancel { readonly type: 'cancel'; readonly id: number }
export type KernelWorkerInput = KernelRequest | KernelCancel;

export type KernelWorkerOutput =
  | { readonly type: 'progress'; readonly id: number; readonly phase: 'start' | 'end' }
  | { readonly type: 'result'; readonly id: number; readonly result: unknown }
  | { readonly type: 'error'; readonly id: number; readonly error: { name: string; message: string; code?: string } };

/** Kept as an exhaustive switch so both the worker and fallback retain the typed public boundary. */
export function invokeKernel(kernels: Kernels, request: KernelRequest): unknown {
  switch (request.method) {
    case 'adjustGradientMap': return kernels.adjustGradientMap(...request.args);
    case 'adjustGrain': return kernels.adjustGrain(...request.args);
    case 'clampPremultiplied': return kernels.clampPremultiplied(...request.args);
    case 'brushAlphaBounds': return kernels.brushAlphaBounds(...request.args);
    case 'layerExtractAlpha': return kernels.layerExtractAlpha(...request.args);
    case 'layerUnpremultiplyOpaque': return kernels.layerUnpremultiplyOpaque(...request.args);
    case 'layerRestoreAlpha': return kernels.layerRestoreAlpha(...request.args);
    case 'contentFill': return kernels.contentFill(...request.args);
    case 'healCoverageBounds': return kernels.healCoverageBounds(...request.args);
    case 'spotHeal': return kernels.spotHeal(...request.args);
    case 'lensDistort': return kernels.lensDistort(...request.args);
    case 'levelsApply': return kernels.levelsApply(...request.args);
    case 'levelsHistogram': return kernels.levelsHistogram(...request.args);
    case 'noiseAdd': return kernels.noiseAdd(...request.args);
    case 'wandMask': return kernels.wandMask(...request.args);
    case 'wandTrace': return kernels.wandTrace(...request.args);
  }
}
