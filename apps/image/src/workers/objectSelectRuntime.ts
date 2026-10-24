/** Keep CPU inference on physical-core-sized pools; SMT adds contention to the convolution kernels. */
export function objectSelectWasmThreadCount(isolated: boolean, hardwareConcurrency: number): number {
  if (!isolated) return 1;
  return Math.min(4, Math.max(1, Math.ceil((Math.floor(hardwareConcurrency) || 1) / 2)));
}

export const OBJECT_SELECT_GPU_BUFFER_BYTES = 512 * 1024 * 1024;

/** SlimSAM FP16 has a 384 MiB MatMul scratch buffer; leave alignment/headroom in the requested device limit. */
export function supportsObjectSelectWebGpu(hasShaderF16: boolean, maxBufferSize: number,
  maxStorageBufferBindingSize: number): boolean {
  return hasShaderF16 && maxBufferSize >= OBJECT_SELECT_GPU_BUFFER_BYTES
    && maxStorageBufferBindingSize >= OBJECT_SELECT_GPU_BUFFER_BYTES;
}
