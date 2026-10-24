/// <reference lib="webworker" />

import * as ort from 'onnxruntime-web/webgpu';
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm?url';
import ortModuleUrl from 'onnxruntime-web/ort-wasm-simd-threaded.jsep.mjs?url';
import { SUBJECT_MODELS } from '../core/subject/models';
import {
  countMaskComponents, postprocessBiRefNet, postprocessU2Net, preprocessBiRefNet, preprocessU2Net,
  refineSubjectMask,
} from '../core/subject/maskProcessing';
import type { BackgroundSettings } from '../core/subject/maskProcessing';
import type { SubjectTiming, SubjectWorkerRequest, SubjectWorkerResponse } from './subjectProtocol';

interface CacheEntry {
  readonly rgba: Uint8Array;
  readonly raw: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly inferenceMs: number;
  readonly downloadMs: number;
  readonly modelLoadMs: number;
  readonly modelBytes: number;
  readonly modelCacheHit: boolean;
  readonly backend: 'webgpu' | 'wasm';
}

interface LoadedModel {
  readonly session: ort.InferenceSession;
  readonly downloadMs: number;
  readonly modelLoadMs: number;
  readonly cacheHit: boolean;
}

const scope = self as unknown as DedicatedWorkerGlobalScope;
const cancelled = new Set<number>();
const cache = new Map<string, CacheEntry>();
let session: ort.InferenceSession | null = null;
let sessionKey = '';
let backend: 'webgpu' | 'wasm' = 'wasm';

// A single thread is deliberate: this works without SharedArrayBuffer or cross-origin isolation.
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
ort.env.wasm.wasmPaths = { wasm: ortWasmUrl, mjs: ortModuleUrl };

function post(message: SubjectWorkerResponse, transfer: Transferable[] = []): void { scope.postMessage(message, transfer); }
function progress(id: number, stage: 'loading-model' | 'inferring' | 'refining', value: number): void {
  post({ id, type: 'progress', stage, progress: value });
}

async function loadModel(request: Extract<SubjectWorkerRequest, { op: 'infer' }>, forceWasm = false): Promise<LoadedModel> {
  const spec = SUBJECT_MODELS[request.model];
  const key = `${request.model}:${spec.sha256}`;
  if (session && sessionKey === key) return { session, downloadMs: 0, modelLoadMs: 0, cacheHit: true };

  progress(request.id, 'loading-model', 0);
  const started = performance.now();
  session?.release(); session = null;
  if (!forceWasm && typeof navigator !== 'undefined' && 'gpu' in navigator) {
    try {
      session = await ort.InferenceSession.create(request.modelBytes, {
        executionProviders: ['webgpu'], graphOptimizationLevel: 'all',
      });
      backend = 'webgpu';
    } catch { session = null; }
  }
  if (!session) {
    session = await ort.InferenceSession.create(request.modelBytes, {
      executionProviders: ['wasm'], graphOptimizationLevel: 'all',
    });
    backend = 'wasm';
  }
  const modelLoadMs = performance.now() - started;
  sessionKey = key;
  progress(request.id, 'loading-model', 1);
  return { session, downloadMs: request.modelResolveMs, modelLoadMs, cacheHit: request.modelCacheHit };
}

async function infer(request: Extract<SubjectWorkerRequest, { op: 'infer' }>): Promise<void> {
  let loaded = await loadModel(request);
  if (cancelled.has(request.id)) return;
  progress(request.id, 'inferring', 0);
  const spec = SUBJECT_MODELS[request.model];
  const tensorData = request.model === 'best'
    ? preprocessBiRefNet(request.rgba, request.width, request.height)
    : preprocessU2Net(request.rgba, request.width, request.height);
  let started = performance.now();
  let outputs: ort.InferenceSession.OnnxValueMapType;
  try {
    outputs = await run(loaded.session, tensorData, spec.inputSize);
  } catch (error) {
    if (backend !== 'webgpu') throw error;
    // Device loss or an unsupported WebGPU kernel can surface only on run. Recreate on the baseline EP.
    const firstLoad = loaded;
    session?.release(); session = null; sessionKey = '';
    const fallback = await loadModel(request, true);
    loaded = { ...fallback, downloadMs: firstLoad.downloadMs + fallback.downloadMs,
      modelLoadMs: firstLoad.modelLoadMs + fallback.modelLoadMs };
    started = performance.now();
    outputs = await run(loaded.session, tensorData, spec.inputSize);
  }
  const outputName = loaded.session.outputNames[0];
  const value = outputName ? outputs[outputName] : undefined;
  if (!value || !(value.data instanceof Float32Array)) {
    throw new Error('The foreground model returned an unexpected tensor type.');
  }
  const inferenceMs = performance.now() - started;
  progress(request.id, 'inferring', 1);
  if (cancelled.has(request.id)) return;
  const made = request.model === 'best'
    ? postprocessBiRefNet(value.data, request.width, request.height)
    : postprocessU2Net(value.data, request.width, request.height);
  if (!Number.isFinite(made.dynamicRange) || made.dynamicRange <= 1e-6) {
    throw new Error('No foreground subject was detected in this layer. Try an image with a more distinct subject.');
  }
  const entry: CacheEntry = {
    rgba: request.rgba, raw: made.pixels, width: request.width, height: request.height,
    inferenceMs, downloadMs: loaded.downloadMs, modelLoadMs: loaded.modelLoadMs,
    modelBytes: spec.byteLength, modelCacheHit: loaded.cacheHit, backend,
  };
  cache.set(request.cacheKey, entry);
  while (cache.size > 2) cache.delete(cache.keys().next().value as string);
  await finish(request.id, entry, request.settings, request.refinementLimit, spec.inputSize);
}

async function run(model: ort.InferenceSession, data: Float32Array, size: number): Promise<ort.InferenceSession.OnnxValueMapType> {
  const inputName = model.inputNames[0];
  if (!inputName || !model.outputNames[0]) throw new Error('The foreground model has no usable input or output tensor.');
  return model.run({ [inputName]: new ort.Tensor('float32', data, [1, 3, size, size]) });
}

async function finish(id: number, entry: CacheEntry, settings: BackgroundSettings, refinementLimit: number,
  inputSize = 1024): Promise<void> {
  progress(id, 'refining', 0);
  const started = performance.now();
  const mask = refineSubjectMask(entry.raw, entry.rgba, entry.width, entry.height, settings, refinementLimit);
  const componentCount = countMaskComponents(mask, entry.width, entry.height);
  const refinementMs = performance.now() - started;
  progress(id, 'refining', 1);
  if (cancelled.has(id)) return;
  const timing: SubjectTiming = {
    downloadMs: entry.downloadMs, modelLoadMs: entry.modelLoadMs, inferenceMs: entry.inferenceMs, refinementMs,
    modelBytes: entry.modelBytes, modelCacheHit: entry.modelCacheHit,
    estimatedBytes: entry.rgba.byteLength + entry.raw.byteLength + mask.byteLength
      + 3 * inputSize * inputSize * 4 + entry.modelBytes,
    backend: entry.backend,
  };
  post({ id, type: 'result', mask, timing, componentCount }, [mask.buffer]);
}

scope.onmessage = (event: MessageEvent<SubjectWorkerRequest>) => {
  const request = event.data;
  if (request.op === 'cancel') {
    cancelled.add(request.id);
    return;
  }
  cancelled.delete(request.id);
  Promise.resolve().then(() => {
    if (request.op === 'infer') return infer(request);
    const entry = cache.get(request.cacheKey);
    if (!entry) throw new Error('The source layer changed; run Remove Background again.');
    const inputSize = entry.modelBytes === SUBJECT_MODELS.best.byteLength
      ? SUBJECT_MODELS.best.inputSize : SUBJECT_MODELS.fast.inputSize;
    return finish(request.id, entry, request.settings, request.refinementLimit, inputSize);
  }).catch((error: unknown) => {
    if (cancelled.has(request.id) || isAbort(error)) return;
    post({ id: request.id, type: 'error', error: error instanceof Error ? error.message : String(error) });
  }).finally(() => { cancelled.delete(request.id); });
};

function abortError(): DOMException { return new DOMException('Background removal was cancelled.', 'AbortError'); }
function isAbort(error: unknown): boolean { return error instanceof DOMException && error.name === 'AbortError'; }
