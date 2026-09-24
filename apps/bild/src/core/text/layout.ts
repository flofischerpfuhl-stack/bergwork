import type { ParagraphBlock, ParagraphLayout, ParagraphSpan, TextEngine, TextRect } from '../../text';
import { Raster } from '../raster';
import { apply, invert, unitToDocument, type Point, type Rect } from '../geometry';
import type { CanvasDocument, TextLayer, TextParagraph, TextRun } from '../document';
import type { MissingFont, TextFontRegistry } from './fonts';

function pointsToPixels(points: number, resolution: number, scale: number): number {
  return points * resolution / 72 * scale;
}

function direction(paragraph: TextParagraph, text: string): 'ltr' | 'rtl' {
  if (paragraph.style.direction !== 'auto') return paragraph.style.direction;
  // Unicode bidi layout itself remains HarfBuzz/SkParagraph's responsibility. This only selects
  // the paragraph base direction when the model requests auto direction.
  const value = text.slice(paragraph.from, paragraph.to);
  return /[\u0590-\u08ff]/u.test(value) ? 'rtl' : 'ltr';
}

function span(run: TextRun, document: CanvasDocument, scale: number, fonts: TextFontRegistry): ParagraphSpan {
  const style = run.style, resolution = fonts.resolution(style.fontFamily);
  const fontSize = pointsToPixels(style.fontSize, document.resolution, scale);
  const features = Object.entries(style.features).map(([name, enabled]) => ({ name, value: enabled ? 1 : 0 }));
  features.push({ name: 'kern', value: style.kerning === 'none' ? 0 : 1 });
  return { from: run.from, to: run.to, fontFamilies: resolution.families, fontSize,
    color: { red: style.color.red * 255, green: style.color.green * 255, blue: style.color.blue * 255,
      alpha: style.color.alpha ?? 1 }, fontStyle: style.fontStyle, fontWeight: style.fontWeight,
    letterSpacing: fontSize * style.tracking / 1000,
    ...(style.leading ? { heightMultiplier: style.leading / style.fontSize } : {}),
    fontFeatures: features, fontVariations: Object.entries(style.axes).map(([axis, value]) => ({ axis, value })) };
}

function block(paragraph: TextParagraph, text: string, document: CanvasDocument, scale: number): ParagraphBlock {
  const convert = (value: number) => pointsToPixels(value, document.resolution, scale);
  return { from: paragraph.from, to: paragraph.to, alignment: paragraph.style.alignment,
    direction: direction(paragraph, text),
    firstLineIndent: convert(paragraph.style.firstLineIndent), startIndent: convert(paragraph.style.startIndent),
    endIndent: convert(paragraph.style.endIndent), spaceBefore: convert(paragraph.style.spaceBefore),
    spaceAfter: convert(paragraph.style.spaceAfter) };
}

function fixedBoxRaster(source: Raster, width: number, height: number): Raster {
  if (source.width === width && source.height === height) return source;
  const output = new Uint8Array(width * height * 4), input = source.toPixels();
  const copyWidth = Math.min(width, source.width), rows = Math.min(height, source.height);
  for (let y = 0; y < rows; y++) output.set(input.subarray(y * source.width * 4, y * source.width * 4 + copyWidth * 4), y * width * 4);
  return Raster.fromPixels(width, height, 4, output);
}

function mapRect(rect: TextRect, layoutWidth: number, layoutHeight: number, transform: TextLayer['transform']): Rect {
  const matrix = unitToDocument(transform);
  const x0 = rect.x / layoutWidth, y0 = rect.y / layoutHeight;
  const x1 = (rect.x + rect.width) / layoutWidth, y1 = (rect.y + rect.height) / layoutHeight;
  const points = [apply(matrix, { x: x0, y: y0 }), apply(matrix, { x: x1, y: y0 }),
    apply(matrix, { x: x1, y: y1 }), apply(matrix, { x: x0, y: y1 })];
  const xs = points.map((value) => value.x), ys = points.map((value) => value.y);
  const left = Math.min(...xs), top = Math.min(...ys);
  return { x: left, y: top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
}

export class TextLayerLayout {
  constructor(readonly layerId: string, readonly raster: Raster, readonly transform: TextLayer['transform'],
    readonly missingFonts: readonly MissingFont[], private readonly layout: ParagraphLayout,
    private readonly basisWidth: number, private readonly basisHeight: number) {}

  caretPosition(point: Point): number {
    const unit = apply(invert(unitToDocument(this.transform)), point);
    return this.layout.caretIndexAt(unit.x * this.basisWidth, unit.y * this.basisHeight);
  }

  selectionRectangles(from: number, to: number): readonly Rect[] {
    return this.layout.selectionRects(from, to).map((rect) => mapRect(rect, this.basisWidth, this.basisHeight, this.transform));
  }

  caretRectangle(index: number): Rect {
    return mapRect(this.layout.caretRect(index), this.basisWidth, this.basisHeight, this.transform);
  }

  dispose(): void { this.layout.dispose(); }
}

/** Layouts from the editable model every time target scale changes; cached pixels are never scaled as text. */
export function layoutTextLayer(engine: TextEngine, fonts: TextFontRegistry, document: CanvasDocument,
  layer: TextLayer, targetPixelsPerDocumentPixel = 1, missingFonts: readonly MissingFont[] = []): TextLayerLayout {
  if (!(targetPixelsPerDocumentPixel > 0) || !Number.isFinite(targetPixelsPerDocumentPixel)) {
    throw new RangeError('Text target scale must be a positive finite number');
  }
  const defaultRun = layer.runs[0];
  const defaultStyle = defaultRun?.style;
  const defaultFont = fonts.resolution(defaultStyle?.fontFamily ?? 'Noto Sans');
  const defaultSize = pointsToPixels(defaultStyle?.fontSize ?? 12, document.resolution, targetPixelsPerDocumentPixel);
  const width = layer.box ? Math.max(1, layer.box.width * targetPixelsPerDocumentPixel) : 30_000;
  const layout = engine.layoutParagraph({ text: layer.text, width, pointText: layer.box === null,
    fontFamilies: defaultFont.families, fontSize: defaultSize,
    spans: layer.runs.map((run) => span(run, document, targetPixelsPerDocumentPixel, fonts)),
    paragraphs: layer.paragraphs.map((paragraph) => block(paragraph, layer.text, document, targetPixelsPerDocumentPixel)) });
  try {
    const rendered = engine.rasterizeParagraph(layout);
    const logicalWidth = layer.box?.width ?? rendered.raster.width / targetPixelsPerDocumentPixel;
    const logicalHeight = layer.box?.height ?? rendered.raster.height / targetPixelsPerDocumentPixel;
    const raster = layer.box ? fixedBoxRaster(rendered.raster, Math.max(1, Math.ceil(layer.box.width * targetPixelsPerDocumentPixel)),
      Math.max(1, Math.ceil(layer.box.height * targetPixelsPerDocumentPixel))) : rendered.raster;
    const transform = { ...layer.transform, size: { width: logicalWidth, height: logicalHeight } };
    return new TextLayerLayout(layer.id, raster, transform, missingFonts.filter((font) => font.layerIds.includes(layer.id)),
      layout, raster.width, raster.height);
  } catch (error) {
    layout.dispose();
    throw error;
  }
}
