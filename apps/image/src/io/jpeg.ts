import createJpegModule from '../wasm/jpeg/jpeg.mjs';
import { readJpegComponentCount, readJpegInfo } from './jpegMeta';

export type JpegColorModel = 'gray' | 'rgb' | 'cmyk';

export interface JpegSamples {
  readonly width: number;
  readonly height: number;
  readonly model: JpegColorModel;
  readonly data: Uint8Array;
}

export class JpegDecodeError extends Error {
  constructor(message = 'Invalid or unsupported JPEG image.') {
    super(message);
    this.name = 'JpegDecodeError';
  }
}

type Module = Awaited<ReturnType<typeof createJpegModule>>;
let singleton: Promise<Module> | undefined;

async function loadDecoder(): Promise<Module> {
  singleton ??= (async () => {
    const wasmUrl = new URL('../wasm/jpeg/jpeg.wasm', import.meta.url);
    let wasmBinary: Uint8Array | undefined;
    if (typeof process !== 'undefined' && process.versions?.node) {
      const fs = await import(/* @vite-ignore */ 'node:fs/promises');
      wasmBinary = await fs.readFile(wasmUrl);
    }
    return createJpegModule({ locateFile: () => wasmUrl.href, wasmBinary });
  })();
  return singleton;
}

/**
 * Decodes JPEG color samples without browser color management. libjpeg-turbo performs JPEG's
 * YCbCr/YCCK transforms; the bridge also normalizes Adobe-inverted CMYK to 0=no ink.
 */
export async function decodeJpegSamples(bytes: Uint8Array): Promise<JpegSamples> {
  const info = readJpegInfo(bytes);
  const components = readJpegComponentCount(bytes);
  const model: JpegColorModel = components === 1 ? 'gray' : components === 3 ? 'rgb'
    : components === 4 ? 'cmyk' : (() => { throw new JpegDecodeError(`Unsupported ${components}-component JPEG`); })();
  const length = info.width * info.height * components;
  if (!Number.isSafeInteger(length) || length < 1 || length > 400_000_000) {
    throw new JpegDecodeError('JPEG dimensions exceed the decoder limit');
  }
  const module = await loadDecoder();
  const input = module._malloc(bytes.byteLength), output = module._malloc(length);
  if (!input || !output) {
    if (input) module._free(input);
    if (output) module._free(output);
    throw new JpegDecodeError('JPEG decoder ran out of memory');
  }
  try {
    module.HEAPU8.set(bytes, input);
    const status = module._compositor_jpeg_decode(input, bytes.byteLength, output, length,
      info.width, info.height, components);
    if (status !== 0) throw new JpegDecodeError(`libjpeg-turbo could not decode the image (stage ${status})`);
    return { width: info.width, height: info.height, model, data: module.HEAPU8.slice(output, output + length) };
  } finally {
    module._free(output);
    module._free(input);
  }
}
