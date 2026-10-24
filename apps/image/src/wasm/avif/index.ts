import createAvifModule from './avif.mjs';

type Module = Awaited<ReturnType<typeof createAvifModule>>;
let singleton: Promise<Module> | undefined;

async function load(): Promise<Module> {
  singleton ??= (async () => {
    const wasmUrl = new URL('./avif.wasm', import.meta.url);
    let wasmBinary: Uint8Array | undefined;
    if (typeof process !== 'undefined' && process.versions?.node) {
      const fs = await import(/* @vite-ignore */ 'node:fs/promises');
      wasmBinary = await fs.readFile(wasmUrl);
    }
    return createAvifModule({ locateFile: () => wasmUrl.href, wasmBinary });
  })();
  return singleton;
}

export interface AvifWasmResult {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
  readonly iccProfile: Uint8Array | null;
  readonly orientation: number;
}

export async function decodeAvifWasm(bytes: Uint8Array): Promise<AvifWasmResult> {
  const module = await load();
  const input = module._malloc(bytes.byteLength);
  if (!input) throw new Error('AVIF decoder ran out of memory.');
  try {
    module.HEAPU8.set(bytes, input);
    if (module._fernwork_avif_decode(input, bytes.byteLength) !== 0) throw new Error('Invalid or damaged AVIF image.');
    const width = module._fernwork_avif_result_width(), height = module._fernwork_avif_result_height();
    const pointer = module._fernwork_avif_result_data(), size = module._fernwork_avif_result_size();
    if (!pointer || width < 1 || height < 1 || size !== width * height * 4) throw new Error('Invalid AVIF decoder output.');
    const iccPointer = module._fernwork_avif_result_icc(), iccSize = module._fernwork_avif_result_icc_size();
    return { width, height, data: module.HEAPU8.slice(pointer, pointer + size),
      iccProfile: iccPointer && iccSize ? module.HEAPU8.slice(iccPointer, iccPointer + iccSize) : null,
      orientation: module._fernwork_avif_result_orientation() };
  } finally {
    module._fernwork_avif_release();
    module._free(input);
  }
}

export async function encodeAvifWasm(rgba: Uint8Array, width: number, height: number,
  quality: number, alphaQuality: number, speed: number, iccProfile: Uint8Array | null = null): Promise<Uint8Array> {
  const module = await load();
  const input = module._malloc(rgba.byteLength);
  if (!input) throw new Error('AVIF encoder ran out of memory.');
  const icc = iccProfile ? module._malloc(iccProfile.byteLength) : 0;
  if (iccProfile && !icc) { module._free(input); throw new Error('AVIF encoder ran out of memory.'); }
  try {
    module.HEAPU8.set(rgba, input);
    if (iccProfile) module.HEAPU8.set(iccProfile, icc);
    const status = module._fernwork_avif_encode(input, width, height, quality, alphaQuality, speed, icc, iccProfile?.byteLength ?? 0);
    if (status !== 0) throw new Error(`AVIF encoding failed (${status}).`);
    const pointer = module._fernwork_avif_result_data(), size = module._fernwork_avif_result_size();
    if (!pointer || !size) throw new Error('AVIF encoder returned no data.');
    return module.HEAPU8.slice(pointer, pointer + size);
  } finally {
    module._fernwork_avif_release();
    if (icc) module._free(icc);
    module._free(input);
  }
}
