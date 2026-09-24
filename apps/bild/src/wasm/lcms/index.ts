import createLcmsModule from './lcms.mjs';

export type IccColorModel = 'gray' | 'rgb' | 'cmyk';
export interface Chromaticities {
  readonly white: readonly [number, number];
  readonly red: readonly [number, number];
  readonly green: readonly [number, number];
  readonly blue: readonly [number, number];
}

export class IccError extends Error {
  constructor(message: string) { super(message); this.name = 'IccError'; }
}

export interface LittleCms {
  /** Compatibility conversion to straight sRGB RGBA8. */
  transform(profile: Uint8Array, input: Uint8Array | Uint16Array, model: IccColorModel,
    bits: 8 | 16, alpha?: Uint8Array | Uint16Array | null): Uint8Array;
  /** Precision-preserving TYPE_RGBA_16-equivalent conversion to straight sRGB RGBA16. */
  transform16(profile: Uint8Array, input: Uint16Array, model: IccColorModel,
    alpha?: Uint16Array | null): Uint16Array;
  createRgbProfile(chromaticities: Chromaticities, gamma: number, transfer?: 'gamma' | 'srgb'): Uint8Array;
  createGrayProfile(white: readonly [number, number], gamma: number): Uint8Array;
  createCmykProfile(): Uint8Array;
}

type Module = Awaited<ReturnType<typeof createLcmsModule>>;

class Arena {
  private readonly pointers: number[] = [];
  constructor(private readonly module: Module) {}
  allocate(length: number): number {
    const pointer = this.module._malloc(Math.max(1, length));
    if (!pointer) throw new IccError('Little CMS ran out of memory');
    this.pointers.push(pointer);
    return pointer;
  }
  copy(data: Uint8Array | Uint16Array): number {
    const pointer = this.allocate(data.byteLength);
    this.module.HEAPU8.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), pointer);
    return pointer;
  }
  release(): void { for (let i = this.pointers.length - 1; i >= 0; i--) this.module._free(this.pointers[i]!); }
}

const MODEL: Readonly<Record<IccColorModel, number>> = { gray: 1, rgb: 3, cmyk: 4 };
const CHANNELS: Readonly<Record<IccColorModel, number>> = { gray: 1, rgb: 3, cmyk: 4 };

function validCoordinate(value: number): boolean { return Number.isFinite(value) && value > 0 && value <= 1; }
function checkWhite(white: readonly [number, number]): void {
  if (!validCoordinate(white[0]) || !validCoordinate(white[1])) throw new RangeError('Invalid ICC white point');
}

function makeLcms(module: Module): LittleCms {
  const saveProfile = (required: number, write: (pointer: number, capacity: number) => number): Uint8Array => {
    if (!required) throw new IccError('Little CMS could not create the requested profile');
    const arena = new Arena(module);
    try {
      const pointer = arena.allocate(required);
      const written = write(pointer, required);
      if (written !== required) throw new IccError('Little CMS could not serialize the requested profile');
      return module.HEAPU8.slice(pointer, pointer + written);
    } finally { arena.release(); }
  };
  const transform = (profile: Uint8Array, input: Uint8Array | Uint16Array, model: IccColorModel,
    bits: 8 | 16, outputBits: 8 | 16, alpha: Uint8Array | Uint16Array | null): Uint8Array | Uint16Array => {
      if (profile.byteLength === 0) throw new IccError('The embedded ICC profile is empty');
      const channels = CHANNELS[model], bytes = bits / 8;
      if (input.byteLength % (channels * bytes) !== 0) throw new RangeError('ICC input has an incomplete pixel');
      const pixels = input.byteLength / (channels * bytes);
      if (!Number.isSafeInteger(pixels) || pixels < 1 || pixels > 100_000_000) throw new RangeError('Invalid ICC pixel count');
      if ((bits === 8) !== (input instanceof Uint8Array)) throw new RangeError(`ICC ${bits}-bit input uses the wrong typed array`);
      if (alpha && (alpha.length !== pixels || (bits === 8) !== (alpha instanceof Uint8Array))) {
        throw new RangeError('ICC alpha samples do not match the color samples');
      }
      const arena = new Arena(module);
      let transform = 0;
      try {
        const profilePointer = arena.copy(profile);
        transform = module._lcms_create_transform(profilePointer, profile.byteLength, MODEL[model], bits, outputBits);
        if (!transform) throw new IccError(`The embedded ICC profile is invalid or is not ${model.toUpperCase()}`);
        const chunkPixels = Math.min(pixels, 1_048_576), inputStride = channels * bytes;
        const outputBytes = outputBits / 8, outputStride = 3 * outputBytes;
        const inputPointer = arena.allocate(chunkPixels * inputStride), outputPointer = arena.allocate(chunkPixels * outputStride);
        const rgba = outputBits === 16 ? new Uint16Array(pixels * 4) : new Uint8Array(pixels * 4);
        const alphaMax = bits === 16 ? 65535 : 255, outputMax = outputBits === 16 ? 65535 : 255;
        const inputBytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
        for (let first = 0; first < pixels; first += chunkPixels) {
          const count = Math.min(chunkPixels, pixels - first), byteOffset = first * inputStride;
          module.HEAPU8.set(inputBytes.subarray(byteOffset, byteOffset + count * inputStride), inputPointer);
          module._lcms_do_transform(transform, inputPointer, outputPointer, count);
          const rgb = outputBits === 16
            ? new Uint16Array(module.HEAPU8.buffer, outputPointer, count * 3)
            : module.HEAPU8.subarray(outputPointer, outputPointer + count * 3);
          for (let pixel = 0, source = 0, target = first * 4; pixel < count; pixel++, source += 3, target += 4) {
            rgba[target] = rgb[source]!; rgba[target + 1] = rgb[source + 1]!; rgba[target + 2] = rgb[source + 2]!;
            rgba[target + 3] = alpha
              ? Math.floor((alpha[first + pixel]! * outputMax + Math.floor(alphaMax / 2)) / alphaMax) : outputMax;
          }
        }
        return rgba;
      } finally {
        if (transform) module._lcms_delete_transform(transform);
        arena.release();
      }
    };
  return {
    transform(profile, input, model, bits, alpha = null) {
      return transform(profile, input, model, bits, 8, alpha) as Uint8Array;
    },
    transform16(profile, input, model, alpha = null) {
      return transform(profile, input, model, 16, 16, alpha) as Uint16Array;
    },
    createRgbProfile(chromaticities, gamma, transfer = 'gamma') {
      checkWhite(chromaticities.white);
      for (const primary of [chromaticities.red, chromaticities.green, chromaticities.blue]) {
        if (!validCoordinate(primary[0]) || !validCoordinate(primary[1])) throw new RangeError('Invalid ICC RGB primary');
      }
      if (!Number.isFinite(gamma) || gamma <= 0) throw new RangeError('ICC gamma must be positive');
      const args = [chromaticities.white[0], chromaticities.white[1], chromaticities.red[0], chromaticities.red[1],
        chromaticities.green[0], chromaticities.green[1], chromaticities.blue[0], chromaticities.blue[1], gamma,
        transfer === 'srgb' ? 1 : 0] as const;
      const required = module._lcms_create_rgb_profile(0, 0, ...args);
      return saveProfile(required, (pointer, capacity) => module._lcms_create_rgb_profile(pointer, capacity, ...args));
    },
    createGrayProfile(white, gamma) {
      checkWhite(white);
      if (!Number.isFinite(gamma) || gamma <= 0) throw new RangeError('ICC gamma must be positive');
      const required = module._lcms_create_gray_profile(0, 0, white[0], white[1], gamma);
      return saveProfile(required, (pointer, capacity) => module._lcms_create_gray_profile(pointer, capacity, white[0], white[1], gamma));
    },
    createCmykProfile() {
      const required = module._lcms_create_cmyk_profile(0, 0);
      if (required < 128) throw new IccError(`Little CMS could not create the CMYK profile (stage ${required})`);
      return saveProfile(required, (pointer, capacity) => module._lcms_create_cmyk_profile(pointer, capacity));
    },
  };
}

let singleton: Promise<LittleCms> | undefined;

/** Lazily loads the committed Little CMS WASM in a browser, worker, or Node test process. */
export function loadLittleCms(): Promise<LittleCms> {
  singleton ??= (async () => {
    const wasmUrl = new URL('./lcms.wasm', import.meta.url);
    let wasmBinary: Uint8Array | undefined;
    if (typeof process !== 'undefined' && process.versions?.node) {
      const fs = await import(/* @vite-ignore */ 'node:fs/promises');
      wasmBinary = await fs.readFile(wasmUrl);
    }
    const module = await createLcmsModule({ locateFile: () => wasmUrl.href, wasmBinary });
    return makeLcms(module);
  })();
  return singleton;
}
