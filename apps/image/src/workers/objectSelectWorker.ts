/// <reference lib="webworker" />

import * as ort from 'onnxruntime-web/webgpu';
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import ortModuleUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url';
import { ortWasmReady } from './ortWasm';
import { bestPromptMask, upscaleObjectMask } from '../core/objectSelect/postprocess';
import { encodePrompts, prepareSlimSamImage } from '../core/objectSelect/preprocess';
import type { ObjectSelectTiming } from '../core/objectSelect/types';
import type { ObjectSelectWorkerRequest, ObjectSelectWorkerResponse } from './objectSelectProtocol';
import {
  OBJECT_SELECT_GPU_BUFFER_BYTES, objectSelectWasmThreadCount, supportsObjectSelectWebGpu,
} from './objectSelectRuntime';

interface EmbeddingEntry {
  readonly data: Float32Array;
  readonly dims: readonly number[];
  readonly positionalData: Float32Array;
  readonly positionalDims: readonly number[];
  readonly rgba: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly preparedWidth: number;
  readonly preparedHeight: number;
  readonly scaleX: number;
  readonly scaleY: number;
}

const scope = self as unknown as DedicatedWorkerGlobalScope;
const cancelled = new Set<number>();
const embeddings = new Map<string, EmbeddingEntry>();
let encoder: ort.InferenceSession | null = null, decoder: ort.InferenceSession | null = null;
let modelKey = '', backend: 'webgpu' | 'wasm' = 'wasm';
let fallbackReason: string | undefined;
const wasmThreads = objectSelectWasmThreadCount(globalThis.crossOriginIsolated,
  globalThis.navigator?.hardwareConcurrency ?? 1);

ort.env.wasm.numThreads = wasmThreads;
ort.env.wasm.proxy = false;
ort.env.wasm.wasmPaths = { wasm: ortWasmUrl, mjs: ortModuleUrl };

async function webGpuProvider(): Promise<ort.InferenceSession.WebGpuExecutionProviderOption | null> {
  if (typeof navigator === 'undefined' || !navigator.gpu) return null;
  // SlimSAM's FP16 graph needs shader-f16. On dual-GPU systems the nominally high-performance adapter may
  // lack it, so inspect both preferences and request a device with the feature explicitly enabled.
  const high = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  const compatible = (candidate: GPUAdapter | null): candidate is GPUAdapter => !!candidate
    && supportsObjectSelectWebGpu(candidate.features.has('shader-f16'), candidate.limits.maxBufferSize,
      candidate.limits.maxStorageBufferBindingSize);
  const low = compatible(high) ? null : await navigator.gpu.requestAdapter({ powerPreference: 'low-power' });
  const adapter = compatible(high) ? high : compatible(low) ? low : null;
  if (!adapter) return null;
  const device = await adapter.requestDevice({ requiredFeatures: ['shader-f16'], requiredLimits: {
    maxBufferSize: OBJECT_SELECT_GPU_BUFFER_BYTES, maxStorageBufferBindingSize: OBJECT_SELECT_GPU_BUFFER_BYTES,
  } });
  ort.env.webgpu.adapter = adapter;
  ort.env.webgpu.device = device;
  return { name: 'webgpu', device, storageBufferCacheMode: 'simple' };
}

function post(message: ObjectSelectWorkerResponse, transfer: Transferable[] = []): void { scope.postMessage(message, transfer); }
function progress(id: number, stage: Extract<ObjectSelectWorkerResponse, { type: 'progress' }>['stage'], value: number): void {
  post({ id, type: 'progress', stage, value });
}

async function loadModels(id: number, urls: { readonly encoder: string; readonly decoder: string }, forceWasm = false): Promise<void> {
  const key = `${urls.encoder}|${urls.decoder}`;
  if (encoder && decoder && modelKey === key && (!forceWasm || backend === 'wasm')) return;
  progress(id, 'loading-model', 0);
  await ortWasmReady(ort.env.wasm, ortWasmUrl);
  encoder?.release(); decoder?.release(); encoder = null; decoder = null; embeddings.clear();
  let webgpu: ort.InferenceSession.WebGpuExecutionProviderOption | null = null;
  if (!forceWasm) {
    fallbackReason = undefined;
    try { webgpu = await webGpuProvider(); }
    catch (error) {
      fallbackReason = error instanceof Error ? error.message : String(error);
      console.warn('SlimSAM WebGPU device creation failed; falling back to threaded WASM.', error);
    }
  }
  if (webgpu) {
    try {
      // ORT's direct WebGPU bridge registers one device while a session is being created; concurrent
      // creation races that registration and rejects the second session.
      encoder = await ort.InferenceSession.create(urls.encoder,
        { executionProviders: [webgpu], graphOptimizationLevel: 'all' });
      decoder = await ort.InferenceSession.create(urls.decoder,
        { executionProviders: [webgpu], graphOptimizationLevel: 'all' });
      backend = 'webgpu';
    } catch (error) {
      fallbackReason = error instanceof Error ? error.message : String(error);
      console.warn('SlimSAM WebGPU session creation failed; falling back to threaded WASM.', error);
      encoder?.release(); decoder?.release(); encoder = null; decoder = null;
    }
  } else if (!forceWasm && typeof navigator !== 'undefined' && navigator.gpu && !fallbackReason) {
    fallbackReason = 'No WebGPU adapter meets SlimSAM\'s shader-f16 and 512 MiB buffer requirements.';
  }
  if (!encoder || !decoder) {
    [encoder, decoder] = await Promise.all([
      ort.InferenceSession.create(urls.encoder, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' }),
      ort.InferenceSession.create(urls.decoder, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' }),
    ]);
    backend = 'wasm';
  }
  modelKey = key; progress(id, 'loading-model', 1);
}

async function select(request: Extract<ObjectSelectWorkerRequest, { op: 'select' }>): Promise<void> {
  await loadModels(request.id, request.modelUrls);
  if (cancelled.has(request.id) || !encoder || !decoder) return;
  let entry = embeddings.get(request.cacheKey), encoderMs = 0, cacheHit = !!entry;
  if (!entry) {
    progress(request.id, 'encoding', 0);
    const prepared = prepareSlimSamImage(request.rgba, request.width, request.height);
    const input = encoder.inputNames[0]; if (!input) throw new Error('SlimSAM encoder has no input.');
    const started = performance.now();
    let values: ort.InferenceSession.OnnxValueMapType;
    try { values = await encoder.run({ [input]: new ort.Tensor('float32', prepared.tensor, [1, 3, 1024, 1024]) }); }
    catch (error) {
      if (backend !== 'webgpu') throw error;
      fallbackReason = error instanceof Error ? error.message : String(error);
      console.warn('SlimSAM WebGPU encoder failed; falling back to threaded WASM.', error);
      await loadModels(request.id, request.modelUrls, true);
      if (!encoder) throw error;
      values = await encoder.run({ [input]: new ort.Tensor('float32', prepared.tensor, [1, 3, 1024, 1024]) });
    }
    encoderMs = performance.now() - started;
    const output = values.image_embeddings, positional = values.image_positional_embeddings;
    if (!output || !(output.data instanceof Float32Array) || !positional || !(positional.data instanceof Float32Array)) {
      throw new Error('SlimSAM encoder returned unexpected tensors.');
    }
    entry = { data: output.data, dims: output.dims.map(Number), positionalData: positional.data,
      positionalDims: positional.dims.map(Number), rgba: request.rgba, width: request.width, height: request.height,
      preparedWidth: prepared.width, preparedHeight: prepared.height, scaleX: prepared.scaleX, scaleY: prepared.scaleY };
    embeddings.set(request.cacheKey, entry);
    while (embeddings.size > 2) embeddings.delete(embeddings.keys().next().value as string);
    progress(request.id, 'encoding', 1);
  }
  if (cancelled.has(request.id)) return;
  progress(request.id, 'decoding', 0);
  const encoded = encodePrompts(request.prompts, entry.scaleX, entry.scaleY), count = encoded.labels.length;
  const feeds: ort.InferenceSession.OnnxValueMapType = {
    image_embeddings: new ort.Tensor('float32', entry.data, entry.dims),
    image_positional_embeddings: new ort.Tensor('float32', entry.positionalData, entry.positionalDims),
    input_points: new ort.Tensor('float32', encoded.coordinates, [1, 1, count, 2]),
    input_labels: new ort.Tensor('int64', BigInt64Array.from(encoded.labels, (value) => BigInt(value)), [1, 1, count]),
  };
  const decodeStarted = performance.now();
  let outputs: ort.InferenceSession.OnnxValueMapType;
  try { outputs = await decoder.run(feeds); }
  catch (error) {
    if (backend !== 'webgpu') throw error;
    fallbackReason = error instanceof Error ? error.message : String(error);
    console.warn('SlimSAM WebGPU decoder failed; falling back to threaded WASM.', error);
    await loadModels(request.id, request.modelUrls, true);
    if (!decoder) throw error;
    outputs = await decoder.run(feeds);
  }
  const decoderMs = performance.now() - decodeStarted;
  const masks = outputs.pred_masks, scores = outputs.iou_scores;
  if (!masks || !(masks.data instanceof Float32Array) || !scores || !(scores.data instanceof Float32Array)) {
    throw new Error('SlimSAM decoder returned unexpected tensors.');
  }
  const maskWidth = Number(masks.dims.at(-1)), maskHeight = Number(masks.dims.at(-2));
  const selected = bestPromptMask(masks.data, scores.data, maskWidth, maskHeight);
  const contentWidth = Math.max(1, Math.round(maskWidth * entry.preparedWidth / 1024));
  const contentHeight = Math.max(1, Math.round(maskHeight * entry.preparedHeight / 1024));
  const cropped = cropTopLeft(selected.mask, maskWidth, contentWidth, contentHeight);
  progress(request.id, 'decoding', 1); progress(request.id, 'refining', 0);
  const refineStarted = performance.now();
  const mask = upscaleObjectMask(cropped, contentWidth, contentHeight, entry.rgba, entry.width, entry.height);
  const refinementMs = performance.now() - refineStarted;
  progress(request.id, 'refining', 1);
  if (cancelled.has(request.id)) return;
  const timing: ObjectSelectTiming = { encoderMs, decoderMs, refinementMs, backend,
    threads: backend === 'wasm' ? wasmThreads : 0, fallbackReason, embeddingCacheHit: cacheHit };
  post({ id: request.id, type: 'result', result: { mask, width: entry.width, height: entry.height,
    score: selected.score, timing } }, [mask.buffer]);
}

scope.onmessage = (event: MessageEvent<ObjectSelectWorkerRequest>) => {
  const request = event.data;
  if (request.op === 'cancel') { cancelled.add(request.id); return; }
  cancelled.delete(request.id);
  void select(request).catch((error: unknown) => {
    if (!cancelled.has(request.id)) post({ id: request.id, type: 'error', error: error instanceof Error ? error.message : String(error) });
  }).finally(() => cancelled.delete(request.id));
};

function cropTopLeft(mask: Uint8Array, sourceWidth: number, width: number, height: number): Uint8Array {
  if (width === sourceWidth && height * width === mask.length) return mask;
  const result = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) result.set(mask.subarray(y * sourceWidth, y * sourceWidth + width), y * width);
  return result;
}
