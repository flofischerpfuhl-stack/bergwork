import { HeicError, type HeicResult } from '../../io/heic';

interface HeifModule {
  readonly HEAPU8: Uint8Array;
  _malloc(size: number): number;
  _free(pointer: number): void;
  _compositor_heif_decode(pointer: number, size: number): number;
  _compositor_heif_release(): void;
  _compositor_heif_result_data(): number;
  _compositor_heif_result_size(): number;
  _compositor_heif_result_width(): number;
  _compositor_heif_result_height(): number;
}

type HeifFactory = (options: { locateFile(path: string): string }) => Promise<HeifModule>;

let modulePromise: Promise<HeifModule> | null = null;

async function heifModule(): Promise<HeifModule> {
  if (!modulePromise) {
    modulePromise = (async () => {
      const glue = new URL('./libheif.mjs', import.meta.url).href;
      const wasm = new URL('./libheif.wasm', import.meta.url).href;
      const imported = await import(/* @vite-ignore */ glue) as { default: HeifFactory };
      return imported.default({ locateFile: (path) => path.endsWith('.wasm') ? wasm : path });
    })();
  }
  return modulePromise;
}

/** Optional LGPL decoder. The JS glue and WASM remain separate, replaceable build products. */
export async function decodeHeifWasm(bytes: Uint8Array): Promise<HeicResult> {
  const module = await heifModule();
  const input = module._malloc(bytes.byteLength);
  if (!input) throw new HeicError('unreadable');
  try {
    module.HEAPU8.set(bytes, input);
    if (module._compositor_heif_decode(input, bytes.byteLength) !== 0) throw new HeicError('unreadable');
    const width = module._compositor_heif_result_width();
    const height = module._compositor_heif_result_height();
    const pointer = module._compositor_heif_result_data();
    const size = module._compositor_heif_result_size();
    if (width < 1 || height < 1 || size !== width * height * 4 || pointer < 1) throw new HeicError('unreadable');
    return { width, height, data: module.HEAPU8.slice(pointer, pointer + size) };
  } finally {
    module._compositor_heif_release();
    module._free(input);
  }
}
