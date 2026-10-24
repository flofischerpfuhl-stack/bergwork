import { describe, expect, it } from 'vitest';
import {
  WEBKITGTK_GPU_TEXTURE_BUDGET, WEBKITGTK_GPU_TEXTURE_CHUNK_SIZE, WEBKITGTK_TILE_BUDGET, webKitGtkMemoryBudgets,
} from '../../src/platform/runtimeMemory';

describe('desktop runtime memory budgets', () => {
  it('caps Linux WebKitGTK tile and texture residency', () => {
    expect(webKitGtkMemoryBudgets('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15'))
      .toEqual({ tileBudgetBytes: WEBKITGTK_TILE_BUDGET, gpuTextureBudgetBytes: WEBKITGTK_GPU_TEXTURE_BUDGET,
        gpuTextureChunkSize: WEBKITGTK_GPU_TEXTURE_CHUNK_SIZE });
  });

  it('keeps Chromium and non-Linux WebKit on their existing host defaults', () => {
    expect(webKitGtkMemoryBudgets('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36')).toBeNull();
    expect(webKitGtkMemoryBudgets('Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15')).toBeNull();
  });
});
