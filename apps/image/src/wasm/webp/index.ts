import createWebpModule from './webp.mjs';

type Module = Awaited<ReturnType<typeof createWebpModule>>;
let singleton: Promise<Module> | undefined;

async function load(): Promise<Module> {
  singleton ??= (async () => {
    const wasmUrl = new URL('./webp.wasm', import.meta.url);
    let wasmBinary: Uint8Array | undefined;
    if (typeof process !== 'undefined' && process.versions?.node) {
      const fs = await import(/* @vite-ignore */ 'node:fs/promises');
      wasmBinary = await fs.readFile(wasmUrl);
    }
    return createWebpModule({ locateFile: () => wasmUrl.href, wasmBinary });
  })();
  return singleton;
}

export async function decodeWebpWasm(bytes: Uint8Array, width: number, height: number): Promise<Uint8Array> {
  const module = await load();
  const input = module._malloc(bytes.byteLength);
  if (!input) throw new Error('WebP decoder ran out of memory.');
  try {
    module.HEAPU8.set(bytes, input);
    if (module._fernwork_webp_decode(input, bytes.byteLength, width, height) !== 0) throw new Error('Invalid or damaged WebP image.');
    const pointer = module._fernwork_webp_result_data(), size = module._fernwork_webp_result_size();
    if (!pointer || size !== width * height * 4) throw new Error('Invalid WebP decoder output.');
    return module.HEAPU8.slice(pointer, pointer + size);
  } finally {
    module._fernwork_webp_release();
    module._free(input);
  }
}

export async function encodeWebpWasm(rgba: Uint8Array, width: number, height: number,
  quality: number, lossless: boolean, alphaQuality: number): Promise<Uint8Array> {
  const module = await load();
  const input = module._malloc(rgba.byteLength);
  if (!input) throw new Error('WebP encoder ran out of memory.');
  try {
    module.HEAPU8.set(rgba, input);
    const status = module._fernwork_webp_encode(input, width, height, quality, lossless ? 1 : 0, alphaQuality);
    if (status !== 0) throw new Error(`WebP encoding failed (${status}).`);
    const pointer = module._fernwork_webp_result_data(), size = module._fernwork_webp_result_size();
    if (!pointer || !size) throw new Error('WebP encoder returned no data.');
    return module.HEAPU8.slice(pointer, pointer + size);
  } finally {
    module._fernwork_webp_release();
    module._free(input);
  }
}
