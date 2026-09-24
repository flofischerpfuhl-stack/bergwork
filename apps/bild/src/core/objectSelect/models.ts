import type { ModelHost, ResolvedModel } from '../../platform/hosts/types';

export type ObjectSelectModelPart = 'encoder' | 'decoder';

export interface ObjectSelectModelSpec {
  readonly id: string;
  readonly part: ObjectSelectModelPart;
  readonly byteLength: number;
  readonly sha256: string;
  readonly url: string;
  readonly license: 'Apache-2.0';
}

const REVISION = 'f860d9a77028ebdafb86473e88b9c0eea67cd8fc';
const BASE = `https://huggingface.co/skillsafe-ai/slimsam-77-uniform-fp16/resolve/${REVISION}/onnx`;

/** Pinned Apache-2.0 SlimSAM-77 FP16 artifacts; neither is fetched by importing this module. */
export const OBJECT_SELECT_MODELS: Readonly<Record<ObjectSelectModelPart, ObjectSelectModelSpec>> = {
  encoder: {
    id: 'slimsam-77-fp16-encoder', part: 'encoder', byteLength: 12_170_657,
    sha256: '11aaeb49c75e7b3f4cbf8a32c2c819406520c6b3affb4068ff474b2240c8aa38',
    url: `${BASE}/vision_encoder_fp16.onnx`, license: 'Apache-2.0',
  },
  decoder: {
    id: 'slimsam-77-fp16-decoder', part: 'decoder', byteLength: 8_550_118,
    sha256: 'df24d49a6f1a5dc0dbbecd84ca0fff9f14c76e63b81fd35c2b92c1321b007f71',
    url: `${BASE}/prompt_encoder_mask_decoder_fp16.onnx`, license: 'Apache-2.0',
  },
};

export interface ObjectSelectDownloadProgress {
  readonly part: ObjectSelectModelPart;
  readonly loaded: number;
  readonly total: number | null;
}

export interface ResolvedObjectSelectModels {
  readonly encoder: ResolvedModel;
  readonly decoder: ResolvedModel;
}

/**
 * The only remote-resolution entry point. Callers must invoke it directly from a user action;
 * ModelHost enforces the same rule and owns browser/Tauri persistence (PRODUCT-PLAN E6).
 */
export async function resolveObjectSelectModels(host: ModelHost,
  progress?: (value: ObjectSelectDownloadProgress) => void, signal?: AbortSignal): Promise<ResolvedObjectSelectModels> {
  const resolve = async (part: ObjectSelectModelPart): Promise<ResolvedModel> => {
    const spec = OBJECT_SELECT_MODELS[part];
    const model = await host.resolveModel({ id: spec.id, sha256: spec.sha256, url: spec.url, userInitiated: true },
      (loaded, total) => progress?.({ part, loaded, total }), signal);
    if (!model) throw new Error(`The ${part} model is not cached and this host did not allow downloading it.`);
    return model;
  };
  const encoder = await resolve('encoder');
  const decoder = await resolve('decoder');
  return { encoder, decoder };
}
