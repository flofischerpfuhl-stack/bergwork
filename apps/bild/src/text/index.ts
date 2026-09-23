export type {
  FillPaint, FontFeature, FontRegistration, FontVariation, LinearGradientPaint, LoadTextEngineOptions,
  ParagraphLayout, ParagraphMetrics, ParagraphRequest, PathOperation, PathRasterRequest, RasterizedOutput,
  RegisteredFont, RgbaColor, SolidPaint, StrokePaint, TextAlignment, TextDirection, TextEngine, TextEngineMemory,
} from './types';

import type { LoadTextEngineOptions, TextEngine } from './types';

/**
 * The only eager entry point. CanvasKit and its WASM remain in a separate Vite chunk until this
 * function is called for a text/vector document or tool (PRODUCT-PLAN A5).
 */
export async function loadTextEngine(options: LoadTextEngineOptions = {}): Promise<TextEngine> {
  const { createCanvasKitTextEngine } = await import('./engine');
  return createCanvasKitTextEngine(options);
}

