export default function createJpegModule(options?: {
  locateFile?: (path: string) => string;
  wasmBinary?: Uint8Array;
}): Promise<{
  HEAPU8: Uint8Array;
  _malloc(size: number): number;
  _free(pointer: number): void;
  _compositor_jpeg_decode(input: number, inputSize: number, output: number, outputSize: number,
    width: number, height: number, components: number): number;
}>;
