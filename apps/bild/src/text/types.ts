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

/** A layout owns a small CanvasKit paragraph allocation until `dispose()` is called. */
export interface ParagraphLayout extends ParagraphMetrics {
  readonly request: ParagraphRequest;
  caretIndexAt(x: number, y: number): number;
  selectionRects(from: number, to: number): readonly TextRect[];
  caretRect(index: number): TextRect;
  dispose(): void;
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
  combinePaths(firstSvg: string, secondSvg: string, operation: PathOperation): string;
  rasterizePath(request: PathRasterRequest): RasterizedOutput;
  memoryUsage(): TextEngineMemory;
  dispose(): void;
}

export interface LoadTextEngineOptions {
  /** Overrides the emitted Vite asset URL; useful for Node tests and non-Vite hosts. */
  readonly wasmUrl?: string;
}
