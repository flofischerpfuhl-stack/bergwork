interface EmscriptenKernelsModule {
  HEAPU8: Uint8Array;
  _malloc(size: number): number;
  _free(pointer: number): void;
  _adjust_gradient_map(rgba: number, width: number, height: number, stride: number, table: number): void;
  _adjust_grain(rgba: number, width: number, height: number, stride: number, amount: number, size: number,
    roughness: number, seed: number, originX: number, originY: number, unitsPerPixel: number): void;
  _rgba_clamp_premultiplied(rgba: number, count: number): void;
  _brush_alpha_bounds(bytes: number, width: number, height: number, stride: number, bounds: number): void;
  _layer_extract_alpha(rgba: number, rgbaStride: number, gray: number, grayStride: number,
    width: number, height: number): void;
  _layer_unpremultiply_opaque(rgba: number, stride: number, width: number, height: number): void;
  _layer_restore_alpha(rgba: number, stride: number, alpha: number, alphaStride: number,
    width: number, height: number): void;
  _content_fill(rgba: number, stride: number, mask: number, maskStride: number, width: number, height: number): number;
  _heal_coverage_bounds(gray: number, width: number, height: number, stride: number, bounds: number): void;
  _spot_heal(rgba: number, coverage: number, width: number, height: number, stride: number,
    opacity: number, mode: number, seed: number): number;
  _lens_distort(source: number, destination: number, width: number, height: number, stride: number, k: number): void;
  _levels_apply(pixels: number, count: number, tables: number): void;
  _levels_histogram(pixels: number, coverage: number, count: number, bins: number): void;
  _noise_add(rgba: number, width: number, height: number, stride: number, amount: number,
    gaussian: number, monochromatic: number, seed: number): void;
  _wand_mask(rgba: number, width: number, height: number, stride: number, seedX: number, seedY: number,
    radius: number, tolerance: number, contiguous: number, mask: number): number;
  _wand_trace(mask: number, width: number, height: number, points: number, pointCount: number,
    loops: number, loopCount: number): number;
}

interface EmscriptenKernelsOptions {
  locateFile(path: string): string;
  wasmBinary?: Uint8Array;
}

export default function createKernelsModule(options: EmscriptenKernelsOptions): Promise<EmscriptenKernelsModule>;
