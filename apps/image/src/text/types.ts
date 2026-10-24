import type { Raster } from '../core/raster';

export type TextAlignment = 'left' | 'right' | 'center' | 'justify';
export type TextDirection = 'ltr' | 'rtl';

export interface RgbaColor {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
  readonly alpha?: number;
}

export interface FontFeature {
  readonly name: string;
  readonly value: number;
}

export interface FontVariation {
  readonly axis: string;
  readonly value: number;
}

export interface ParagraphSpan {
  /** UTF-16 offsets, matching JavaScript strings and CanvasKit Paragraph. */
  readonly from: number;
  readonly to: number;
  readonly fontFamilies: readonly string[];
  readonly fontSize: number;
  readonly color?: RgbaColor;
  readonly fontStyle?: 'normal' | 'italic' | 'oblique';
  readonly fontWeight?: number;
  readonly letterSpacing?: number;
  readonly heightMultiplier?: number;
  readonly fontFeatures?: readonly FontFeature[];
  readonly fontVariations?: readonly FontVariation[];
}

export interface ParagraphBlock {
  readonly from: number;
  readonly to: number;
  readonly alignment?: TextAlignment;
  readonly direction?: TextDirection;
  readonly firstLineIndent?: number;
  readonly startIndent?: number;
  readonly endIndent?: number;
  readonly spaceBefore?: number;
  readonly spaceAfter?: number;
}

export interface TextRect { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

export interface FontRegistration {
  readonly id: string;
  readonly family: string;
  readonly bytes: ArrayBuffer | Uint8Array;
  readonly source?: string;
}

export interface RegisteredFont {
  readonly id: string;
  readonly family: string;
  readonly byteLength: number;
  readonly source: string | null;
}

export interface ParagraphRequest {
  readonly text: string;
  readonly width: number;
  readonly fontFamilies: readonly string[];
  readonly fontSize: number;
  readonly color?: RgbaColor;
  readonly alignment?: TextAlignment;
  readonly direction?: TextDirection;
  readonly letterSpacing?: number;
  readonly wordSpacing?: number;
  readonly heightMultiplier?: number;
  readonly maxLines?: number;
  readonly fontFeatures?: readonly FontFeature[];
  readonly fontVariations?: readonly FontVariation[];
  readonly spans?: readonly ParagraphSpan[];
  readonly paragraphs?: readonly ParagraphBlock[];
  /** Point text uses its intrinsic width; area text uses the requested width. */
  readonly pointText?: boolean;
}

export interface ParagraphMetrics {
  readonly width: number;
  readonly height: number;
  readonly longestLine: number;
  readonly lineCount: number;
  readonly alphabeticBaseline: number;
  readonly exceededMaxLines: boolean;
  readonly unresolvedCodepoints: readonly number[];
}

/** One shaped glyph run of a line: glyph ids and positions exactly as SkParagraph placed them (kerning, ligatures). */
export interface ShapedGlyphRun {
  readonly size: number;
  readonly glyphs: Uint16Array;
  /** Layout coordinates, x/y per glyph plus one more pair for the position after the last glyph. */
  readonly positions: Float32Array;
  /** UTF-16 offsets per glyph plus the end offset; glyphs of one cluster share their offset. */
  readonly offsets: Uint32Array;
  /** Ink bounds per glyph relative to its origin: left, top, right, bottom. */
  readonly bounds: Float32Array;
}

export interface ShapedTextLine {
  /** UTF-16 range of the line's text. */
  readonly from: number;
  readonly to: number;
  readonly top: number;
  readonly bottom: number;
  readonly baseline: number;
  readonly runs: readonly ShapedGlyphRun[];
}

/** A layout owns a small CanvasKit paragraph allocation until `dispose()` is called. */
export interface ParagraphLayout extends ParagraphMetrics {
  readonly request: ParagraphRequest;
  caretIndexAt(x: number, y: number): number;
  selectionRects(from: number, to: number): readonly TextRect[];
  caretRect(index: number): TextRect;
  /** Shaped lines in layout coordinates (text on a path and warped text place these glyphs themselves). */
  shapedLines(): readonly ShapedTextLine[];
  dispose(): void;
}

/** Glyphs `from…to` of one shaped run, drawn through an affine placement (text on a path, warp mesh). */
export interface GlyphDraw {
  readonly line: number;
  readonly run: number;
  readonly from: number;
  readonly to: number;
  /** Affine `[a, b, c, d, tx, ty]` from layout coordinates to raster pixels: x' = a·x + c·y + tx, y' = b·x + d·y + ty. */
  readonly matrix: readonly [number, number, number, number, number, number];
  readonly color: RgbaColor;
  /** Optional clip polygon in raster pixels (x, y pairs), applied without antialiasing so adjacent pieces tile exactly. */
  readonly clip?: readonly number[];
}

export interface GlyphRasterRequest {
  readonly width: number;
  readonly height: number;
  readonly draws: readonly GlyphDraw[];
}

export interface RasterizedOutput {
  /** Straight-alpha RGBA8 tiles, directly usable by a future text layer raster. */
  readonly raster: Raster;
  /** Layout origin in the raster, including requested padding. */
  readonly origin: { readonly x: number; readonly y: number };
}

export type PathOperation = 'union' | 'difference' | 'intersect' | 'xor' | 'reverseDifference';

export interface SolidPaint {
  readonly kind: 'solid';
  readonly color: RgbaColor;
}

export interface LinearGradientPaint {
  readonly kind: 'linear-gradient';
  readonly start: readonly [number, number];
  readonly end: readonly [number, number];
  readonly colors: readonly RgbaColor[];
  readonly positions?: readonly number[];
}

export type FillPaint = SolidPaint | LinearGradientPaint;

export interface StrokePaint {
  readonly color: RgbaColor;
  readonly width: number;
  readonly dash?: readonly number[];
  readonly dashPhase?: number;
  readonly join?: 'miter' | 'round' | 'bevel';
  readonly miterLimit?: number;
  readonly cap?: 'butt' | 'round' | 'square';
}

export interface PathRasterRequest {
  readonly width: number;
  readonly height: number;
  readonly svgPath: string;
  readonly fillRule?: 'nonzero' | 'evenodd';
  readonly fill?: FillPaint;
  readonly stroke?: StrokePaint;
  readonly background?: RgbaColor;
}

export interface TextEngineMemory {
  readonly wasmHeapBytes: number;
  readonly registeredFontBytes: number;
  readonly registeredFontCount: number;
}

export interface TextEngine {
  readonly fonts: readonly RegisteredFont[];
  registerFont(registration: FontRegistration): RegisteredFont;
  layoutParagraph(request: ParagraphRequest): ParagraphLayout;
  rasterizeParagraph(layout: ParagraphLayout, padding?: number): RasterizedOutput;
  /** Draws shaped glyphs of `layout` with per-piece placements, from their outlines at the raster's resolution. */
  rasterizeGlyphs(layout: ParagraphLayout, request: GlyphRasterRequest): RasterizedOutput;
  combinePaths(firstSvg: string, secondSvg: string, operation: PathOperation): string;
  rasterizePath(request: PathRasterRequest): RasterizedOutput;
  memoryUsage(): TextEngineMemory;
  dispose(): void;
}

export interface LoadTextEngineOptions {
  /** Overrides the emitted Vite asset URL; useful for Node tests and non-Vite hosts. */
  readonly wasmUrl?: string;
}
