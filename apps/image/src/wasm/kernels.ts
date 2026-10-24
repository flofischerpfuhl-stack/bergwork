import createKernelsModule from './kernels.mjs';

export interface PixelBounds { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number }
export interface WandMaskResult { readonly mask: Uint8Array; readonly count: number }
export interface WandTraceResult { readonly points: Int32Array; readonly loops: Int32Array }
export type SpotHealMode = 0 | 1 | 2;
export type KernelErrorCode = 'memory' | 'no-source' | 'too-detailed';

export class KernelError extends Error {
  readonly code: KernelErrorCode;
  constructor(code: KernelErrorCode, message: string) {
    super(message);
    this.name = 'KernelError';
    this.code = code;
  }
}

/** Synchronous wrappers around the loaded upstream C kernels. Inputs are copied and never detached or mutated. */
export interface Kernels {
  /** AdjustPixels.c: premultiplied RGBA8; table is 256 straight-sRGB RGB triplets. */
  adjustGradientMap(rgba: Uint8Array, width: number, height: number, stride: number, table: Uint8Array): Uint8Array;
  /** AdjustPixels.c: document-positioned film grain on premultiplied RGBA8. */
  adjustGrain(rgba: Uint8Array, width: number, height: number, stride: number, amount: number, size: number,
    roughness: number, seed: number, originX: number, originY: number, unitsPerPixel: number): Uint8Array;
  /** AdjustPixels.c: clamps each premultiplied RGB channel to alpha. */
  clampPremultiplied(rgba: Uint8Array, count: number): Uint8Array;
  /** BrushPixels.c: half-open nonzero-alpha bounds; empty is all zero. */
  brushAlphaBounds(rgba: Uint8Array, width: number, height: number, stride: number): PixelBounds;
  /** BrushPixels.c: extracts alpha from premultiplied RGBA8 into a strided gray buffer. */
  layerExtractAlpha(rgba: Uint8Array, rgbaStride: number, grayStride: number, width: number, height: number): Uint8Array;
  /** BrushPixels.c: unpremultiplies RGB and forces alpha to 255, including transparent pixels. */
  layerUnpremultiplyOpaque(rgba: Uint8Array, stride: number, width: number, height: number): Uint8Array;
  /** BrushPixels.c: premultiplies opaque RGBA by a strided alpha plane and restores alpha. */
  layerRestoreAlpha(rgba: Uint8Array, stride: number, alpha: Uint8Array, alphaStride: number,
    width: number, height: number): Uint8Array;
  /** ContentFill.c: premultiplied RGBA8. Throws `no-source` for C status 0 and `memory` for -1. */
  contentFill(rgba: Uint8Array, stride: number, mask: Uint8Array, maskStride: number,
    width: number, height: number): Uint8Array;
  /** HealPixels.c: half-open nonzero gray bounds; empty is all zero. */
  healCoverageBounds(gray: Uint8Array, width: number, height: number, stride: number): PixelBounds;
  /** HealPixels.c: in-place premultiplied RGBA8 operation. Throws `memory` for C status -1. */
  spotHeal(rgba: Uint8Array, coverage: Uint8Array, width: number, height: number, stride: number,
    opacity: number, mode: SpotHealMode, seed: number): Uint8Array;
  /** LensPixels.c: premultiplied RGBA8 with transparent sampling outside the source. */
  lensDistort(source: Uint8Array, width: number, height: number, stride: number, k: number): Uint8Array;
  /** LevelsPixels.c: contiguous premultiplied RGBA8 and three 256-entry normalized float LUTs. */
  levelsApply(pixels: Uint8Array, count: number, tables: Float32Array): Uint8Array;
  /** LevelsPixels.c: four 256-entry Float64 bins, alpha- and optional coverage-weighted. */
  levelsHistogram(pixels: Uint8Array, coverage: Uint8Array | null, count: number): Float64Array;
  /** NoisePixels.c: deterministic noise on premultiplied RGBA8, preserving alpha. */
  noiseAdd(rgba: Uint8Array, width: number, height: number, stride: number, amount: number,
    gaussian: boolean, monochromatic: boolean, seed: number): Uint8Array;
  /** WandPixels.c: top-down premultiplied RGBA8. Throws `memory` for C return -1. */
  wandMask(rgba: Uint8Array, width: number, height: number, stride: number, seedX: number, seedY: number,
    radius: number, tolerance: number, contiguous: boolean): WandMaskResult;
  /** WandPixels.c: copies and frees both C-owned output arrays; throws for statuses -1/-2. */
  wandTrace(mask: Uint8Array, width: number, height: number): WandTraceResult;
}

type Module = Awaited<ReturnType<typeof createKernelsModule>>;

class Arena {
  private readonly pointers: number[] = [];
  constructor(private readonly module: Module) {}
  allocate(bytes: number): number {
    const pointer = this.module._malloc(Math.max(1, bytes));
    if (!pointer) throw new KernelError('memory', 'The WebAssembly kernel could not allocate memory');
    this.pointers.push(pointer);
    return pointer;
  }
  copy(data: Uint8Array): number {
    const pointer = this.allocate(data.byteLength);
    this.module.HEAPU8.set(data, pointer);
    return pointer;
  }
  release(): void {
    for (let i = this.pointers.length - 1; i >= 0; i--) this.module._free(this.pointers[i]!);
  }
}

function integer(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0x7fffffff) throw new RangeError(`Invalid ${name}: ${value}`);
  return value;
}

function requiredBytes(width: number, height: number, stride: number, channels: number): number {
  integer(width, 'width'); integer(height, 'height'); integer(stride, 'stride');
  const row = width * channels;
  if (stride < row) throw new RangeError(`Stride ${stride} is smaller than the ${row}-byte pixel row`);
  if (height === 0) return 0;
  const bytes = (height - 1) * stride + row;
  if (!Number.isSafeInteger(bytes) || bytes > 0x7fffffff) throw new RangeError('Pixel buffer is too large for wasm32');
  return bytes;
}

function requireLength(data: ArrayBufferView, bytes: number, name: string): void {
  if (data.byteLength < bytes) throw new RangeError(`${name} has ${data.byteLength} bytes; ${bytes} required`);
}

function output(module: Module, pointer: number, length: number): Uint8Array {
  return module.HEAPU8.slice(pointer, pointer + length);
}

function u32(module: Module, pointer: number): number {
  return new DataView(module.HEAPU8.buffer).getUint32(pointer, true);
}

function makeKernels(module: Module): Kernels {
  const mutateRgba = (rgba: Uint8Array, width: number, height: number, stride: number,
    invoke: (pointer: number) => void): Uint8Array => {
    requireLength(rgba, requiredBytes(width, height, stride, 4), 'rgba');
    const arena = new Arena(module);
    try {
      const pointer = arena.copy(rgba);
      invoke(pointer);
      return output(module, pointer, rgba.byteLength);
    } finally { arena.release(); }
  };

  return {
    adjustGradientMap(rgba, width, height, stride, table) {
      if (table.byteLength !== 256 * 3) throw new RangeError('Gradient map table must contain 768 bytes');
      return mutateRgba(rgba, width, height, stride, pointer => {
        const arena = new Arena(module);
        try { module._adjust_gradient_map(pointer, width, height, stride, arena.copy(table)); }
        finally { arena.release(); }
      });
    },
    adjustGrain(rgba, width, height, stride, amount, size, roughness, seed, originX, originY, unitsPerPixel) {
      return mutateRgba(rgba, width, height, stride, pointer =>
        module._adjust_grain(pointer, width, height, stride, amount, size, roughness, seed >>> 0,
          originX, originY, unitsPerPixel));
    },
    clampPremultiplied(rgba, count) {
      integer(count, 'count'); requireLength(rgba, count * 4, 'rgba');
      const arena = new Arena(module);
      try { const p = arena.copy(rgba); module._rgba_clamp_premultiplied(p, count); return output(module, p, rgba.byteLength); }
      finally { arena.release(); }
    },
    brushAlphaBounds(rgba, width, height, stride) {
      requireLength(rgba, requiredBytes(width, height, stride, 4), 'rgba');
      const arena = new Arena(module);
      try {
        const p = arena.copy(rgba), bounds = arena.allocate(16);
        module._brush_alpha_bounds(p, width, height, stride, bounds);
        const view = new Uint32Array(module.HEAPU8.buffer, bounds, 4);
        return { left: view[0]!, top: view[1]!, right: view[2]!, bottom: view[3]! };
      } finally { arena.release(); }
    },
    layerExtractAlpha(rgba, rgbaStride, grayStride, width, height) {
      requireLength(rgba, requiredBytes(width, height, rgbaStride, 4), 'rgba');
      requiredBytes(width, height, grayStride, 1);
      const grayBytes = grayStride * height, arena = new Arena(module);
      if (!Number.isSafeInteger(grayBytes) || grayBytes > 0x7fffffff) throw new RangeError('Gray buffer is too large for wasm32');
      try {
        const source = arena.copy(rgba), gray = arena.allocate(grayBytes);
        module.HEAPU8.fill(0, gray, gray + grayBytes);
        module._layer_extract_alpha(source, rgbaStride, gray, grayStride, width, height);
        return output(module, gray, grayBytes);
      } finally { arena.release(); }
    },
    layerUnpremultiplyOpaque(rgba, stride, width, height) {
      return mutateRgba(rgba, width, height, stride, p => module._layer_unpremultiply_opaque(p, stride, width, height));
    },
    layerRestoreAlpha(rgba, stride, alpha, alphaStride, width, height) {
      requireLength(alpha, requiredBytes(width, height, alphaStride, 1), 'alpha');
      return mutateRgba(rgba, width, height, stride, p => {
        const arena = new Arena(module);
        try { module._layer_restore_alpha(p, stride, arena.copy(alpha), alphaStride, width, height); }
        finally { arena.release(); }
      });
    },
    contentFill(rgba, stride, mask, maskStride, width, height) {
      requireLength(mask, requiredBytes(width, height, maskStride, 1), 'mask');
      requireLength(rgba, requiredBytes(width, height, stride, 4), 'rgba');
      const arena = new Arena(module);
      try {
        const pixels = arena.copy(rgba), maskPointer = arena.copy(mask);
        const status = module._content_fill(pixels, stride, maskPointer, maskStride, width, height);
        if (status === 0) throw new KernelError('no-source', 'Content-aware fill found no opaque source patch');
        if (status !== 1) throw new KernelError('memory', 'Content-aware fill ran out of memory');
        return output(module, pixels, rgba.byteLength);
      } finally { arena.release(); }
    },
    healCoverageBounds(gray, width, height, stride) {
      requireLength(gray, requiredBytes(width, height, stride, 1), 'gray');
      const arena = new Arena(module);
      try {
        const p = arena.copy(gray), bounds = arena.allocate(16);
        module._heal_coverage_bounds(p, width, height, stride, bounds);
        const view = new Int32Array(module.HEAPU8.buffer, bounds, 4);
        return { left: view[0]!, top: view[1]!, right: view[2]!, bottom: view[3]! };
      } finally { arena.release(); }
    },
    spotHeal(rgba, coverage, width, height, stride, opacity, mode, seed) {
      requireLength(coverage, width * height, 'coverage');
      return mutateRgba(rgba, width, height, stride, pixels => {
        const arena = new Arena(module);
        try {
          const status = module._spot_heal(pixels, arena.copy(coverage), width, height, stride,
            opacity, mode, seed >>> 0);
          if (status !== 0) throw new KernelError('memory', 'Spot healing ran out of memory');
        } finally { arena.release(); }
      });
    },
    lensDistort(source, width, height, stride, k) {
      const bytes = requiredBytes(width, height, stride, 4); requireLength(source, bytes, 'source');
      const arena = new Arena(module);
      try {
        const input = arena.copy(source), destination = arena.allocate(source.byteLength);
        module.HEAPU8.fill(0, destination, destination + source.byteLength);
        module._lens_distort(input, destination, width, height, stride, k);
        return output(module, destination, source.byteLength);
      } finally { arena.release(); }
    },
    levelsApply(pixels, count, tables) {
      integer(count, 'count'); requireLength(pixels, count * 4, 'pixels');
      if (tables.length !== 3 * 256) throw new RangeError('Levels tables must contain 768 floats');
      const arena = new Arena(module);
      try {
        const p = arena.copy(pixels), tablePointer = arena.allocate(tables.byteLength);
        new Float32Array(module.HEAPU8.buffer, tablePointer, tables.length).set(tables);
        module._levels_apply(p, count, tablePointer);
        return output(module, p, pixels.byteLength);
      } finally { arena.release(); }
    },
    levelsHistogram(pixels, coverage, count) {
      integer(count, 'count'); requireLength(pixels, count * 4, 'pixels');
      if (coverage) requireLength(coverage, count, 'coverage');
      const arena = new Arena(module);
      try {
        const p = arena.copy(pixels), coveragePointer = coverage ? arena.copy(coverage) : 0;
        const bins = arena.allocate(1024 * Float64Array.BYTES_PER_ELEMENT);
        module.HEAPU8.fill(0, bins, bins + 1024 * Float64Array.BYTES_PER_ELEMENT);
        module._levels_histogram(p, coveragePointer, count, bins);
        return new Float64Array(module.HEAPU8.buffer.slice(bins, bins + 1024 * Float64Array.BYTES_PER_ELEMENT));
      } finally { arena.release(); }
    },
    noiseAdd(rgba, width, height, stride, amount, gaussian, monochromatic, seed) {
      return mutateRgba(rgba, width, height, stride, p =>
        module._noise_add(p, width, height, stride, amount, gaussian ? 1 : 0, monochromatic ? 1 : 0, seed >>> 0));
    },
    wandMask(rgba, width, height, stride, seedX, seedY, radius, tolerance, contiguous) {
      requireLength(rgba, requiredBytes(width, height, stride, 4), 'rgba');
      integer(seedX, 'seedX'); integer(seedY, 'seedY'); integer(radius, 'radius');
      const arena = new Arena(module);
      try {
        const source = arena.copy(rgba), mask = arena.allocate(width * height);
        const count = module._wand_mask(source, width, height, stride, seedX, seedY, radius,
          Math.trunc(tolerance), contiguous ? 1 : 0, mask);
        if (count < 0) throw new KernelError('memory', 'Magic Wand ran out of memory');
        return { mask: output(module, mask, width * height), count };
      } finally { arena.release(); }
    },
    wandTrace(mask, width, height) {
      integer(width, 'width'); integer(height, 'height'); requireLength(mask, width * height, 'mask');
      const arena = new Arena(module);
      let points = 0, loops = 0;
      try {
        const source = arena.copy(mask), pointsSlot = arena.allocate(4), pointCountSlot = arena.allocate(4);
        const loopsSlot = arena.allocate(4), loopCountSlot = arena.allocate(4);
        const status = module._wand_trace(source, width, height, pointsSlot, pointCountSlot, loopsSlot, loopCountSlot);
        points = u32(module, pointsSlot); loops = u32(module, loopsSlot);
        if (status === -2) throw new KernelError('too-detailed', 'Magic Wand outline exceeds the upstream edge limit');
        if (status !== 0) throw new KernelError('memory', 'Magic Wand outline ran out of memory');
        const pointCount = u32(module, pointCountSlot), loopCount = u32(module, loopCountSlot);
        const pointBytes = pointCount * 2 * 4, loopBytes = loopCount * 4;
        const pointCopy = pointBytes ? module.HEAPU8.buffer.slice(points, points + pointBytes) : new ArrayBuffer(0);
        const loopCopy = loopBytes ? module.HEAPU8.buffer.slice(loops, loops + loopBytes) : new ArrayBuffer(0);
        return { points: new Int32Array(pointCopy), loops: new Int32Array(loopCopy) };
      } finally {
        if (points) module._free(points);
        if (loops) module._free(loops);
        arena.release();
      }
    },
  };
}

let singleton: Promise<Kernels> | undefined;

/** Loads the committed wasm artifact once. Node reads it from disk; browsers/workers use Vite's asset URL. */
export function loadKernels(): Promise<Kernels> {
  singleton ??= (async () => {
    const wasmUrl = new URL('./kernels.wasm', import.meta.url);
    let wasmBinary: Uint8Array | undefined;
    if (typeof process !== 'undefined' && process.versions?.node) {
      const fs = await import(/* @vite-ignore */ 'node:fs/promises');
      wasmBinary = await fs.readFile(wasmUrl);
    }
    const module = await createKernelsModule({ locateFile: () => wasmUrl.href, wasmBinary });
    return makeKernels(module);
  })();
  return singleton;
}
