export type {
  FillPaint, FontFeature, FontRegistration, FontVariation, GlyphDraw, GlyphRasterRequest, LinearGradientPaint, LoadTextEngineOptions,
  ParagraphBlock, ParagraphLayout, ParagraphMetrics, ParagraphRequest, ParagraphSpan, PathOperation, PathRasterRequest, RasterizedOutput,
  RegisteredFont, RgbaColor, ShapedGlyphRun, ShapedTextLine, SolidPaint, StrokePaint, TextAlignment, TextDirection, TextEngine, TextEngineMemory,
  TextRect,
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
