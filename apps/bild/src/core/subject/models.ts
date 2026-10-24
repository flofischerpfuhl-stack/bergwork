export type SubjectModel = 'fast' | 'best';

export interface SubjectModelSpec {
  readonly kind: SubjectModel;
  readonly inputSize: number;
  readonly byteLength: number;
  readonly sha256: string;
  readonly defaultUrl: string;
}

/** Immutable model artifacts recorded in MODEL_LICENSES.md. */
export const SUBJECT_MODELS: Readonly<Record<SubjectModel, SubjectModelSpec>> = {
  fast: {
    kind: 'fast', inputSize: 320, byteLength: 4_574_861,
    sha256: '309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8',
    defaultUrl: '/models/u2netp.onnx',
  },
  best: {
    kind: 'best', inputSize: 1024, byteLength: 199_681_624,
    sha256: '50a57872cc739192446da2a934159f957c81af8b5a161dfda8e3daa51660ca67',
    defaultUrl: 'https://huggingface.co/CoderViking/birefnet-lite-onnx/resolve/'
      + 'dc06453148f01ef4131f17e9b791345e32e8ee78/birefnet-lite-1024.onnx?download=true',
  },
};
