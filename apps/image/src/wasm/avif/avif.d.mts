export default function createAvifModule(options?: {
  locateFile?: (path: string) => string;
  wasmBinary?: Uint8Array;
}): Promise<{
  HEAPU8: Uint8Array;
  _malloc(size: number): number;
  _free(pointer: number): void;
  _fernwork_avif_decode(input: number, inputSize: number): number;
  _fernwork_avif_encode(rgba: number, width: number, height: number, quality: number, alphaQuality: number, speed: number,
    icc: number, iccSize: number): number;
  _fernwork_avif_release(): void;
  _fernwork_avif_result_data(): number;
  _fernwork_avif_result_size(): number;
  _fernwork_avif_result_icc(): number;
  _fernwork_avif_result_icc_size(): number;
  _fernwork_avif_result_width(): number;
  _fernwork_avif_result_height(): number;
  _fernwork_avif_result_orientation(): number;
}>;
