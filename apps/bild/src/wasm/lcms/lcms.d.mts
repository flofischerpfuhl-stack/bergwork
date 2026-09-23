interface EmscriptenLcmsModule {
  HEAPU8: Uint8Array;
  _malloc(size: number): number;
  _free(pointer: number): void;
  _lcms_create_transform(profile: number, profileSize: number, model: number, bits: number): number;
  _lcms_do_transform(transform: number, input: number, output: number, pixels: number): void;
  _lcms_delete_transform(transform: number): void;
  _lcms_create_rgb_profile(output: number, capacity: number, wx: number, wy: number,
    rx: number, ry: number, gx: number, gy: number, bx: number, by: number,
    gamma: number, srgbCurve: number): number;
  _lcms_create_gray_profile(output: number, capacity: number, wx: number, wy: number,
    gamma: number): number;
  _lcms_create_cmyk_profile(output: number, capacity: number): number;
}

interface EmscriptenLcmsOptions {
  locateFile(path: string): string;
  wasmBinary?: Uint8Array;
}

export default function createLcmsModule(options: EmscriptenLcmsOptions): Promise<EmscriptenLcmsModule>;
