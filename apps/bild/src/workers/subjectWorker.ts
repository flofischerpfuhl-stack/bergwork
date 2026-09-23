/// <reference lib="webworker" />

import * as ort from 'onnxruntime-web/webgpu';
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm?url';
import ortModuleUrl from 'onnxruntime-web/ort-wasm-simd-threaded.jsep.mjs?url';
import { postprocessU2Net, preprocessU2Net, refineSubjectMask } from '../core/subject/maskProcessing';
import type { BackgroundSettings } from '../core/subject/maskProcessing';
import type { SubjectTiming, SubjectWorkerRequest, SubjectWorkerResponse } from './subjectProtocol';

interface CacheEntry { readonly rgba: Uint8Array; readonly raw: Uint8Array; readonly width: number; readonly height: number;
  readonly inferenceMs: number; readonly modelLoadMs: number; readonly backend: 'webgpu' | 'wasm' }

const scope = self as unknown as DedicatedWorkerGlobalScope;
const cancelled = new Set<number>();
const cache = new Map<string, CacheEntry>();
let session: ort.InferenceSession | null = null;
let sessionUrl = '';
let backend: 'webgpu' | 'wasm' = 'wasm';
let lastLoadMs = 0;

// A single thread is deliberate: this works without SharedArrayBuffer or cross-origin isolation.
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
ort.env.wasm.wasmPaths = { wasm: ortWasmUrl, mjs: ortModuleUrl };

function post(message: SubjectWorkerResponse, transfer: Transferable[] = []): void { scope.postMessage(message, transfer); }
function progress(id: number, stage: 'loading-model' | 'inferring' | 'refining', value: number): void {
  post({ id, type: 'progress', stage, progress: value });
}

async function loadModel(id: number, url: string): Promise<ort.InferenceSession> {
  if (session && sessionUrl === url) { lastLoadMs = 0; return session; }
  progress(id, 'loading-model', 0);
  const started = performance.now();
  try {
    session = await ort.InferenceSession.create(url, { executionProviders: ['webgpu'], graphOptimizationLevel: 'all' });
    backend = 'webgpu';
  } catch {
    session = await ort.InferenceSession.create(url, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    backend = 'wasm';
  }
  sessionUrl = url; lastLoadMs = performance.now() - started;
  progress(id, 'loading-model', 1);
  return session;
}

async function infer(request: Extract<SubjectWorkerRequest, { op: 'infer' }>): Promise<void> {
  const model = await loadModel(request.id, request.modelUrl);
  if (cancelled.has(request.id)) return;
  progress(request.id, 'inferring', 0);
  const tensorData = preprocessU2Net(request.rgba, request.width, request.height);
  const started = performance.now();
  const inputName = model.inputNames[0], outputName = model.outputNames[0];
  if (!inputName || !outputName) throw new Error('The foreground model has no usable input or output tensor.');
  const outputs = await model.run({ [inputName]: new ort.Tensor('float32', tensorData, [1, 3, 320, 320]) });
  const value = outputs[outputName];
  if (!value || !(value.data instanceof Float32Array)) throw new Error('The foreground model returned an unexpected tensor type.');
  const inferenceMs = performance.now() - started;
  progress(request.id, 'inferring', 1);
  if (cancelled.has(request.id)) return;
  const made = postprocessU2Net(value.data, request.width, request.height);
  if (!Number.isFinite(made.dynamicRange) || made.dynamicRange <= 1e-6) {
    throw new Error('No foreground subject was detected in this layer. Try an image with a more distinct subject.');
  }
  const entry: CacheEntry = { rgba: request.rgba, raw: made.pixels, width: request.width, height: request.height,
    inferenceMs, modelLoadMs: lastLoadMs, backend };
  cache.set(request.cacheKey, entry);
  while (cache.size > 2) cache.delete(cache.keys().next().value as string);
  await finish(request.id, entry, request.settings, request.refinementLimit);
}

async function finish(id: number, entry: CacheEntry, settings: BackgroundSettings, refinementLimit: number): Promise<void> {
  progress(id, 'refining', 0);
  const started = performance.now();
  const mask = refineSubjectMask(entry.raw, entry.rgba, entry.width, entry.height, settings, refinementLimit);
  const refinementMs = performance.now() - started;
  progress(id, 'refining', 1);
  if (cancelled.has(id)) return;
  const timing: SubjectTiming = { modelLoadMs: entry.modelLoadMs, inferenceMs: entry.inferenceMs, refinementMs,
    estimatedBytes: entry.rgba.byteLength + entry.raw.byteLength + mask.byteLength + 3 * 320 * 320 * 4 + 4_574_861,
    backend: entry.backend };
  post({ id, type: 'result', mask, timing }, [mask.buffer]);
}

scope.onmessage = (event: MessageEvent<SubjectWorkerRequest>) => {
  const request = event.data;
  if (request.op === 'cancel') { cancelled.add(request.id); return; }
  cancelled.delete(request.id);
  Promise.resolve().then(() => {
    if (request.op === 'infer') return infer(request);
    const entry = cache.get(request.cacheKey);
    if (!entry) throw new Error('The source layer changed; run Remove Background again.');
    return finish(request.id, entry, request.settings, request.refinementLimit);
  }).catch((error: unknown) => {
    if (!cancelled.has(request.id)) post({ id: request.id, type: 'error', error: error instanceof Error ? error.message : String(error) });
  }).finally(() => cancelled.delete(request.id));
};
