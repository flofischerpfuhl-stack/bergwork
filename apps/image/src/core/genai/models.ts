import type { ModelHost, ResolvedModel } from '../../platform/hosts/types';

export type GenAiModelId = 'migan-512' | 'realesrgan-x2plus' | 'realesrgan-x4plus';

export interface GenAiModelSpec {
  readonly id: GenAiModelId;
  readonly byteLength: number;
  readonly sha256: string;
  readonly url: string;
  readonly license: 'MIT' | 'BSD-3-Clause';
  readonly scale: 1 | 2 | 4;
}

const MIGAN_REVISION = '406830d0fa60666da0071c342ad2fbc8f30c5c64';
const ESRGAN_REVISION = '766bac4b35aaeefe85a065ece8ee2f827b1314d8';

/**
 * Immutable optional artifacts. MI-GAN publishes a separate MIT weight license; the Real-ESRGAN files are mechanical
 * ONNX exports of the upstream BSD-3-Clause checkpoints. Provenance and training-data notes are in artifacts/genai.md.
 */
export const GENAI_MODELS: Readonly<Record<GenAiModelId, GenAiModelSpec>> = {
  'migan-512': {
    id: 'migan-512', byteLength: 28_079_181,
    sha256: '6f1f3530a1a2324b19752018ce756088b07973cda8d7d890034ace5c8a48c40b',
    url: `https://huggingface.co/andraniksargsyan/migan/resolve/${MIGAN_REVISION}/migan_pipeline_v2.onnx`,
    license: 'MIT', scale: 1,
  },
  'realesrgan-x2plus': {
    id: 'realesrgan-x2plus', byteLength: 67_156_218,
    sha256: '35d016524a6eb7e9a99f192cfa81b6cf1f80fdf8f1b51605d77f0763f5ccba7f',
    url: `https://huggingface.co/fernandotonon/QtMeshEditor-realesrgan-onnx/resolve/${ESRGAN_REVISION}/RealESRGAN_x2plus.onnx`,
    license: 'BSD-3-Clause', scale: 2,
  },
  'realesrgan-x4plus': {
    id: 'realesrgan-x4plus', byteLength: 67_132_609,
    sha256: 'c999e5e3365a23cda6d627c407005076c160f420d6b122a0ef7c9d4210aee96a',
    url: `https://huggingface.co/fernandotonon/QtMeshEditor-realesrgan-onnx/resolve/${ESRGAN_REVISION}/RealESRGAN_x4plus.onnx`,
    license: 'BSD-3-Clause', scale: 4,
  },
};

/** Cache-only lookup. Omitting the URL and setting userInitiated=false makes a network request impossible by contract. */
export function cachedGenAiModel(host: ModelHost, id: GenAiModelId): Promise<ResolvedModel | null> {
  const spec = GENAI_MODELS[id];
  return host.resolveModel({ id: spec.id, sha256: spec.sha256, userInitiated: false });
}

/** The sole remote-resolution entry point; call directly from the Download button. */
export async function downloadGenAiModel(host: ModelHost, id: GenAiModelId,
  progress?: (loaded: number, total: number | null) => void, signal?: AbortSignal): Promise<ResolvedModel> {
  const spec = GENAI_MODELS[id];
  const value = await host.resolveModel({ id: spec.id, sha256: spec.sha256, url: spec.url, userInitiated: true }, progress, signal);
  if (!value) throw new Error('The model is not cached and this host did not allow downloading it.');
  return value;
}
