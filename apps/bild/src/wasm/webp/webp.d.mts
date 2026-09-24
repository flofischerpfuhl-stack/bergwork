export default function createWebpModule(options?: {
  locateFile?: (path: string) => string;
  wasmBinary?: Uint8Array;
}): Promise<{
  HEAPU8: Uint8Array;
  _malloc(size: number): number;
  _free(pointer: number): void;
  _fernwork_webp_decode(input: number, inputSize: number, width: number, height: number): number;
  _fernwork_webp_encode(rgba: number, width: number, height: number, quality: number, lossless: number, alphaQuality: number): number;
  _fernwork_webp_release(): void;
  _fernwork_webp_result_data(): number;
  _fernwork_webp_result_size(): number;
}>;
