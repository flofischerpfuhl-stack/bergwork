/// <reference lib="webworker" />

import * as ort from 'onnxruntime-web/webgpu';
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm?url';
import ortModuleUrl from 'onnxruntime-web/ort-wasm-simd-threaded.jsep.mjs?url';
import { ortWasmReady } from './ortWasm';
import { accumulateTile, aiTiles, cropFixedTile, extractMask, extractRgba, finishTiles, padFixedTile } from '../core/genai/tiling';
import { blendRgba, lanczosRgba } from '../core/genai/resample';
import type { GenAiStage, GenAiWorkerRequest, GenAiWorkerResponse } from './genAiProtocol';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const cancelled = new Set<number>();
let session: ort.InferenceSession | null = null, modelUrl = '', backend: 'webgpu' | 'wasm' = 'wasm';

ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
ort.env.wasm.wasmPaths = { wasm: ortWasmUrl, mjs: ortModuleUrl };

function post(message: GenAiWorkerResponse, transfers: Transferable[] = []): void { scope.postMessage(message, transfers); }
function progress(id: number, stage: GenAiStage, value: number): void { post({ id, type: 'progress', stage, value, backend }); }

async function load(url: string, id: number, forceWasm = false): Promise<ort.InferenceSession> {
  if (session && modelUrl === url && (!forceWasm || backend === 'wasm')) return session;
  progress(id, 'loading-model', 0);
  await ortWasmReady(ort.env.wasm, ortWasmUrl);
  session?.release(); session = null;
  if (!forceWasm && typeof navigator !== 'undefined' && 'gpu' in navigator) {
    try {
      session = await ort.InferenceSession.create(url, { executionProviders: ['webgpu'], graphOptimizationLevel: 'all' });
      backend = 'webgpu';
    } catch { session?.release(); session = null; }
  }
  if (!session) {
    session = await ort.InferenceSession.create(url, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    backend = 'wasm';
  }
  modelUrl = url; progress(id, 'loading-model', 1); return session;
}

async function runWithFallback(id: number, url: string, feeds: ort.InferenceSession.OnnxValueMapType): Promise<ort.InferenceSession.OnnxValueMapType> {
  const current = await load(url, id);
  try { return await current.run(feeds); }
  catch (error) {
    if (backend !== 'webgpu') throw error;
    return (await load(url, id, true)).run(feeds);
  }
}

async function inpaint(request: Extract<GenAiWorkerRequest, { op: 'inpaint' }>): Promise<void> {
  validate(request.rgba, request.width, request.height);
  if (request.mask.length !== request.width * request.height) throw new RangeError('The remove mask has the wrong size.');
  const tiles = aiTiles(request.width, request.height, request.tileSize ?? 512, 64);
  const sums = new Float32Array(request.rgba.length), weights = new Float32Array(request.width * request.height);
  let inferenceMs = 0;
  for (let index = 0; index < tiles.length; index++) {
    if (cancelled.has(request.id)) return;
    const tile = tiles[index]!, rgba = extractRgba(request.rgba, request.width, tile);
    const coverage = extractMask(request.mask, request.width, tile);
    let result = rgba;
    if (coverage.some((value) => value >= 1)) {
      const fixed = padFixedTile(rgba, coverage, tile.width, tile.height, 512);
      const image = rgbaToNchwRgb(fixed.rgba, 512, 512, false);
      const known = new Uint8Array(fixed.mask.length);
      for (let i = 0; i < known.length; i++) known[i] = fixed.mask[i]! >= 128 ? 0 : 255;
      const started = performance.now();
      const values = await runWithFallback(request.id, request.modelUrl, {
        image: new ort.Tensor('uint8', image as Uint8Array<ArrayBuffer>, [1, 3, 512, 512]),
        mask: new ort.Tensor('uint8', known as Uint8Array<ArrayBuffer>, [1, 1, 512, 512]),
      });
      inferenceMs += performance.now() - started;
      const output = values.result ?? values[(await load(request.modelUrl, request.id)).outputNames[0]!];
      if (!output || !(output.data instanceof Uint8Array)) throw new Error('MI-GAN returned an unexpected tensor.');
      result = cropFixedTile(nchwRgbToRgba(output.data, fixed.rgba, 512, 512), 512, tile.width, tile.height);
    }
    accumulateTile(sums, weights, request.width, result, tile, 1);
    progress(request.id, 'processing', (index + 1) / tiles.length);
  }
  progress(request.id, 'assembling', 0);
  const assembled = finishTiles(sums, weights);
  // Selection coverage is authoritative: untouched pixels remain bit-exact, soft edges blend in straight RGBA.
  for (let i = 0; i < request.mask.length; i++) {
    const amount = request.mask[i]! / 255, inverse = 1 - amount;
    for (let c = 0; c < 4; c++) assembled[i * 4 + c] = Math.round(assembled[i * 4 + c]! * amount + request.rgba[i * 4 + c]! * inverse);
  }
  progress(request.id, 'assembling', 1);
  post({ id: request.id, type: 'result', rgba: assembled, width: request.width, height: request.height, backend, inferenceMs }, [assembled.buffer]);
}

async function upscale(request: Extract<GenAiWorkerRequest, { op: 'upscale' }>): Promise<void> {
  validate(request.rgba, request.width, request.height);
  const scale = request.scale, outputWidth = request.width * scale, outputHeight = request.height * scale;
  const tiles = aiTiles(request.width, request.height, request.tileSize ?? 512, 32);
  const sums = new Float32Array(outputWidth * outputHeight * 4), weights = new Float32Array(outputWidth * outputHeight);
  let inferenceMs = 0;
  for (let index = 0; index < tiles.length; index++) {
    if (cancelled.has(request.id)) return;
    const tile = tiles[index]!, rgba = extractRgba(request.rgba, request.width, tile);
    const input = rgbaToNchwRgb(rgba, tile.width, tile.height, true), loaded = await load(request.modelUrl, request.id);
    const inputName = loaded.inputNames[0]; if (!inputName) throw new Error('Real-ESRGAN has no input tensor.');
    const started = performance.now();
    const values = await runWithFallback(request.id, request.modelUrl, {
      [inputName]: new ort.Tensor('float32', input, [1, 3, tile.height, tile.width]),
    });
    inferenceMs += performance.now() - started;
    const output = values[(await load(request.modelUrl, request.id)).outputNames[0]!];
    if (!output || !(output.data instanceof Float32Array)) throw new Error('Real-ESRGAN returned an unexpected tensor.');
    const outputScale = Math.round(Number(output.dims.at(-1)) / tile.width);
    if (outputScale !== scale) throw new Error(`Real-ESRGAN returned ${outputScale}× pixels for a ${scale}× request.`);
    const alpha = lanczosRgba(rgba, tile.width, tile.height, tile.width * scale, tile.height * scale);
    const result = nchwFloatToRgba(output.data, alpha, tile.width * scale, tile.height * scale);
    accumulateTile(sums, weights, outputWidth, result, tile, scale);
    progress(request.id, 'processing', (index + 1) / tiles.length);
  }
  progress(request.id, 'assembling', 0);
  const ai = finishTiles(sums, weights);
  const baseline = lanczosRgba(request.rgba, request.width, request.height, outputWidth, outputHeight);
  const result = blendRgba(baseline, ai, request.strength);
  progress(request.id, 'assembling', 1);
  post({ id: request.id, type: 'result', rgba: result, width: outputWidth, height: outputHeight, backend, inferenceMs }, [result.buffer]);
}

scope.onmessage = (event: MessageEvent<GenAiWorkerRequest>) => {
  const request = event.data;
  if (request.op === 'cancel') { cancelled.add(request.id); return; }
  cancelled.delete(request.id);
  void (request.op === 'inpaint' ? inpaint(request) : upscale(request)).catch((error: unknown) => {
    if (!cancelled.has(request.id)) post({ id: request.id, type: 'error', error: error instanceof Error ? error.message : String(error) });
  }).finally(() => cancelled.delete(request.id));
};

function validate(rgba: Uint8Array, width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || rgba.length !== width * height * 4) {
    throw new RangeError('Invalid RGBA image.');
  }
}

function rgbaToNchwRgb(rgba: Uint8Array, width: number, height: number, normalized: false): Uint8Array;
function rgbaToNchwRgb(rgba: Uint8Array, width: number, height: number, normalized: true): Float32Array;
function rgbaToNchwRgb(rgba: Uint8Array, width: number, height: number, normalized: boolean): Uint8Array | Float32Array {
  const length = width * height, output = normalized ? new Float32Array(length * 3) : new Uint8Array(length * 3);
  for (let i = 0; i < length; i++) for (let c = 0; c < 3; c++) output[c * length + i] = normalized ? rgba[i * 4 + c]! / 255 : rgba[i * 4 + c]!;
  return output;
}

function nchwRgbToRgba(rgb: Uint8Array, original: Uint8Array, width: number, height: number): Uint8Array {
  const length = width * height, output = original.slice();
  for (let i = 0; i < length; i++) for (let c = 0; c < 3; c++) output[i * 4 + c] = rgb[c * length + i]!;
  return output;
}

function nchwFloatToRgba(rgb: Float32Array, alpha: Uint8Array, width: number, height: number): Uint8Array {
  const length = width * height, output = new Uint8Array(length * 4);
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < 3; c++) output[i * 4 + c] = Math.max(0, Math.min(255, Math.round(rgb[c * length + i]! * 255)));
    output[i * 4 + 3] = alpha[i * 4 + 3]!;
  }
  return output;
}
