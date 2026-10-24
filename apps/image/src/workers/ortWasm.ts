/**
 * ONNX Runtime's WebGPU builds ship ~26 MB WASM binaries, above the web host's 25 MiB per-file limit. The production
 * build stores those gzip-compressed (`.wasm.gz`, see vite.config.ts); this inflates one with DecompressionStream and
 * hands the bytes to ORT, so ORT never fetches the original. Dev servers serve the plain file and ORT loads it itself.
 */
import type { Env } from 'onnxruntime-web/webgpu';

let load: Promise<void> | null = null;

/** Resolves once ORT can create sessions; call it before the first InferenceSession.create. */
export function ortWasmReady(wasm: Env['wasm'], url: string): Promise<void> {
  if (!url.endsWith('.gz')) return Promise.resolve();
  load ??= (async () => {
    const response = await fetch(url);
    if (!response.ok || !response.body) throw new Error(`ONNX Runtime WASM failed to load (${response.status}).`);
    const bytes = await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    wasm.wasmBinary = new Uint8Array(bytes);
  })().catch((error: unknown) => { load = null; throw error; });
  return load;
}
