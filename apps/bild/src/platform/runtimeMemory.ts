export interface RuntimeMemoryBudgets {
  readonly tileBudgetBytes: number;
  readonly gpuTextureBudgetBytes: number;
  readonly gpuTextureChunkSize: number;
}

export const WEBKITGTK_TILE_BUDGET = 512 * 1024 * 1024;
export const WEBKITGTK_GPU_TEXTURE_BUDGET = 512 * 1024 * 1024;
export const WEBKITGTK_GPU_TEXTURE_CHUNK_SIZE = 1024;

/**
 * WebKitGTK 2.52 keeps large JSC ArrayBuffer allocations much longer than Chromium. Keep the
 * Linux desktop host's explicit caches below that collector's process-pressure threshold; other
 * Tauri engines retain the normal Pro defaults.
 */
export function webKitGtkMemoryBudgets(userAgent: string): RuntimeMemoryBudgets | null {
  const webKit = /AppleWebKit\//.test(userAgent);
  const chromium = /(?:Chrome|Chromium|Edg)\//.test(userAgent);
  return /Linux/.test(userAgent) && webKit && !chromium
    ? { tileBudgetBytes: WEBKITGTK_TILE_BUDGET, gpuTextureBudgetBytes: WEBKITGTK_GPU_TEXTURE_BUDGET,
      gpuTextureChunkSize: WEBKITGTK_GPU_TEXTURE_CHUNK_SIZE }
    : null;
}
