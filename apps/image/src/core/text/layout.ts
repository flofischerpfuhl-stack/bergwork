import type { GlyphDraw, ParagraphBlock, ParagraphLayout, ParagraphSpan, RgbaColor, TextEngine } from '../../text';
import { Raster } from '../raster';
import { apply, invert, pixelToDocument, type Affine, type LayerTransform, type Point, type Rect, type Size } from '../geometry';
import type { CanvasDocument, TextLayer, TextOnPath, TextParagraph, TextRun, TextWarp } from '../document';
import type { MissingFont, TextFontRegistry } from './fonts';
import { PathMeasure, PathTextMapping, pathTextOptions, validTextOnPath, type Matrix, type PathTextLine } from './pathText';
import { invertWarp, isIdentityWarp, validTextWarp, warpedBounds, warpFunction } from './warp';

function pointsToPixels(points: number, resolution: number, scale: number): number {
  return points * resolution / 72 * scale;
}

function direction(paragraph: TextParagraph, text: string): 'ltr' | 'rtl' {
  if (paragraph.style.direction !== 'auto') return paragraph.style.direction;
  // Unicode bidi layout itself remains HarfBuzz/SkParagraph's responsibility. This only selects
  // the paragraph base direction when the model requests auto direction: the first strong (letter)
  // character decides (UAX #9 P2/P3), so a Latin paragraph ending in Arabic stays left-to-right.
  const first = /\p{L}/u.exec(text.slice(paragraph.from, paragraph.to))?.[0] ?? '';
  return /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]/u.test(first) ? 'rtl' : 'ltr';
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

/** Layout pixels ↔ raster pixels of text on a path or warped text; flat text needs none (they coincide). */
interface LayoutMapping {
  toRaster(point: Point): Point;
  toLayout(point: Point): Point;
  /** Layout pixels per piece when a rectangle is bent along the text (selection, caret). */
  readonly slice: number;
}

/**
 * Where a text layer's pixels sit for a frame placement. The frame is the unwarped text box (point/area text) or the
 * path's box (text on a path); the raster may reach past it (warp, glyphs beside the path) by `offset`, in frame pixels.
 * The frame's scale relative to `frameSize` scales the raster's placement too (a transform being dragged).
 */
export function textPlacement(frame: LayerTransform, frameSize: Size, offset: Point, size: Size): LayerTransform {
  const sx = frame.size.width / Math.max(1e-9, frameSize.width), sy = frame.size.height / Math.max(1e-9, frameSize.height);
  if (offset.x === 0 && offset.y === 0 && size.width === frameSize.width && size.height === frameSize.height) return frame;
  const width = size.width * sx, height = size.height * sy;
  const centre = apply(pixelToDocument(frame, frame.size.width, frame.size.height),
    { x: offset.x * sx + width / 2, y: offset.y * sy + height / 2 });
  return { ...frame, origin: { x: centre.x - width / 2, y: centre.y - height / 2 }, size: { width, height } };
}

function bbox(points: readonly Point[]): Rect {
  const xs = points.map((value) => value.x), ys = points.map((value) => value.y);
  const left = Math.min(...xs), top = Math.min(...ys);
  return { x: left, y: top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
}

export class TextLayerLayout {
  constructor(readonly layerId: string, readonly raster: Raster, readonly transform: TextLayer['transform'],
    readonly missingFonts: readonly MissingFont[], private readonly layout: ParagraphLayout,
    /** The unwarped text box, or the path's frame, in document pixels. */
    readonly frameSize: Size = transform.size,
    /** The raster's top-left inside the frame, document pixels. */
    readonly rasterOffset: Point = { x: 0, y: 0 },
    /** The raster's size in document pixels. */
    readonly rasterSize: Size = transform.size,
    private readonly mapping: LayoutMapping | null = null,
    /** Text on a path keeps its frame (the path's box) whatever its text; point text grows with it. */
    readonly onPath = false) {}

  private rasterToDocument(): Affine { return pixelToDocument(this.transform, this.raster.width, this.raster.height); }

  /** Layout pixels → raster pixels. */
  toRaster(point: Point): Point { return this.mapping ? this.mapping.toRaster(point) : point; }
  /** Raster pixels → layout pixels. */
  toLayout(point: Point): Point { return this.mapping ? this.mapping.toLayout(point) : point; }
  layoutIndexAt(point: Point): number { return this.layout.caretIndexAt(point.x, point.y); }
  layoutCaretRect(index: number): Rect { return this.layout.caretRect(index); }
  layoutSelectionRects(from: number, to: number): readonly Rect[] { return this.layout.selectionRects(from, to); }
  get layoutHeight(): number { return this.layout.height; }

  /** A layout rectangle on the raster: its corners, or a strip of pieces following bent or warped text. */
  polygon(rect: Rect): Point[] {
    const { x, y, width, height } = rect;
    if (!this.mapping) return [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }];
    const across = Math.max(1, Math.min(96, Math.ceil(width / this.mapping.slice)));
    const down = Math.max(1, Math.min(24, Math.ceil(height / this.mapping.slice)));
    const result: Point[] = [];
    for (let i = 0; i <= across; i++) result.push(this.toRaster({ x: x + width * i / across, y }));
    for (let j = 1; j <= down; j++) result.push(this.toRaster({ x: x + width, y: y + height * j / down }));
    for (let i = across - 1; i >= 0; i--) result.push(this.toRaster({ x: x + width * i / across, y: y + height }));
    for (let j = down - 1; j >= 1; j--) result.push(this.toRaster({ x, y: y + height * j / down }));
    return result;
  }

  caretPosition(point: Point): number {
    return this.layoutIndexAt(this.toLayout(apply(invert(this.rasterToDocument()), point)));
  }

  selectionRectangles(from: number, to: number): readonly Rect[] {
    const map = this.rasterToDocument();
    return this.layout.selectionRects(from, to).map((rect) => bbox(this.polygon(rect).map((point) => apply(map, point))));
  }

  caretRectangle(index: number): Rect {
    const map = this.rasterToDocument();
    return bbox(this.polygon(this.layout.caretRect(index)).map((point) => apply(map, point)));
  }

  /** The caret as a document-space segment from its top to its bottom (tilted on paths and warps). */
  caretSegment(index: number): [Point, Point] {
    const map = this.rasterToDocument(), caret = this.layout.caretRect(index);
    return [apply(map, this.toRaster({ x: caret.x, y: caret.y })), apply(map, this.toRaster({ x: caret.x, y: caret.y + caret.height }))];
  }

  dispose(): void { this.layout.dispose(); }
}

/** Layouts from the editable model every time target scale changes; cached pixels are never scaled as text. */
function colorAt(layer: TextLayer, index: number): RgbaColor {
  const run = layer.runs.find((value) => value.from <= index && index < value.to) ?? layer.runs.at(-1);
  const color = run?.style.color ?? { red: 0, green: 0, blue: 0, alpha: 1 };
  return { red: color.red * 255, green: color.green * 255, blue: color.blue * 255, alpha: color.alpha ?? 1 };
}

const sameColor = (a: RgbaColor, b: RgbaColor) => a.red === b.red && a.green === b.green && a.blue === b.blue && a.alpha === b.alpha;
const translated = (m: Matrix, dx: number, dy: number): Matrix => [m[0], m[1], m[2], m[3], m[4] + dx, m[5] + dy];
const applyMatrix = (m: Matrix, x: number, y: number): Point => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });
/** Largest raster side for bent or warped text. */
const MAX_SIDE = 16_384;

interface Extent { left: number; top: number; right: number; bottom: number }
function rasterBox(extent: Extent): { origin: Point; width: number; height: number } {
  if (!Number.isFinite(extent.left)) return { origin: { x: 0, y: 0 }, width: 1, height: 1 };
  const origin = { x: Math.floor(extent.left) - 2, y: Math.floor(extent.top) - 2 };
  return { origin, width: Math.max(1, Math.min(MAX_SIDE, Math.ceil(extent.right) + 2 - origin.x)),
    height: Math.max(1, Math.min(MAX_SIDE, Math.ceil(extent.bottom) + 2 - origin.y)) };
}

/** Text on a path: every glyph cluster keeps its shaped advance and turns with the path's tangent (pathText.ts). */
function pathTextLayout(engine: TextEngine, layout: ParagraphLayout, layer: TextLayer, settings: TextOnPath, document: CanvasDocument,
  scale: number, fontPixels: number, missing: readonly MissingFont[]): TextLayerLayout {
  const lines = layout.shapedLines();
  const alignmentAt = (index: number) => (layer.paragraphs.find((value) => value.from <= index && index < value.to)
    ?? layer.paragraphs.at(-1))?.style.alignment ?? 'left';
  const pathLines: PathTextLine[] = lines.map((line) => {
    let left = Infinity, right = -Infinity;
    for (const run of line.runs) {
      const count = run.glyphs.length;
      left = Math.min(left, run.positions[0]!, run.positions[2 * count]!);
      right = Math.max(right, run.positions[0]!, run.positions[2 * count]!);
    }
    return { top: line.top, bottom: line.bottom, baseline: line.baseline, left: Number.isFinite(left) ? left : 0,
      right: Number.isFinite(right) ? right : 0, alignment: alignmentAt(line.from) };
  });
  if (!pathLines.length) pathLines.push({ top: 0, bottom: layout.height, baseline: layout.alphabeticBaseline, left: 0, right: 0, alignment: alignmentAt(0) });
  const measure = new PathMeasure(settings.path, scale);
  const lift = pointsToPixels(settings.baselineOffset, document.resolution, scale);
  const mapping = new PathTextMapping(measure, pathTextOptions(settings, lift), pathLines);
  const pieces: Omit<GlyphDraw, 'matrix'>[] = [], matrices: Matrix[] = [];
  const extent: Extent = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
  const include = (point: Point) => {
    extent.left = Math.min(extent.left, point.x); extent.right = Math.max(extent.right, point.x);
    extent.top = Math.min(extent.top, point.y); extent.bottom = Math.max(extent.bottom, point.y);
  };
  lines.forEach((line, lineIndex) => line.runs.forEach((run, runIndex) => {
    const count = run.glyphs.length;
    for (let i = 0; i < count;) {
      let j = i + 1;
      while (j < count && run.offsets[j] === run.offsets[i]) j++;
      const x0 = run.positions[2 * i]!, x1 = run.positions[2 * j]!;
      if (mapping.fits(x0, x1, lineIndex)) {
        const matrix = mapping.clusterMatrix((x0 + x1) / 2, lineIndex);
        pieces.push({ line: lineIndex, run: runIndex, from: i, to: j, color: colorAt(layer, run.offsets[i]!) });
        matrices.push(matrix);
        for (let k = i; k < j; k++) {
          const gx = run.positions[2 * k]!, gy = run.positions[2 * k + 1]!;
          const l = run.bounds[4 * k]!, t = run.bounds[4 * k + 1]!, r = run.bounds[4 * k + 2]!, b = run.bounds[4 * k + 3]!;
          if (!(r > l) || !(b > t)) continue;
          for (const [x, y] of [[l, t], [r, t], [r, b], [l, b]] as const) include(applyMatrix(matrix, gx + x, gy + y));
        }
      }
      i = j;
    }
  }));
  if (!Number.isFinite(extent.left)) {
    const start = mapping.map({ x: 0, y: pathLines[0]!.baseline });
    include(start); include({ x: start.x + 1, y: start.y + 1 });
  }
  const box = rasterBox(extent);
  const draws = pieces.map((piece, index) => ({ ...piece, matrix: translated(matrices[index]!, -box.origin.x, -box.origin.y) }));
  const rendered = engine.rasterizeGlyphs(layout, { width: box.width, height: box.height, draws });
  const frameSize = layer.transform.size;
  const offset = { x: box.origin.x / scale, y: box.origin.y / scale }, size = { width: box.width / scale, height: box.height / scale };
  return new TextLayerLayout(layer.id, rendered.raster, textPlacement(layer.transform, frameSize, offset, size), missing, layout,
    frameSize, offset, size, {
      toRaster: (point) => { const q = mapping.map(point); return { x: q.x - box.origin.x, y: q.y - box.origin.y }; },
      toLayout: (point) => mapping.inverse({ x: point.x + box.origin.x, y: point.y + box.origin.y }),
      slice: Math.max(2, fontPixels / 6),
    }, true);
}

/**
 * Warped text: the shaped glyphs are drawn through a fine piecewise-affine mesh of the warp, each triangle from the
 * glyph outlines under its own affine map and clipped to its triangle, so the result is rendered at the target
 * resolution rather than resampled from a flat raster.
 */
function warpedTextLayout(engine: TextEngine, layout: ParagraphLayout, layer: TextLayer, warp: TextWarp, scale: number,
  missing: readonly MissingFont[]): TextLayerLayout {
  const width = layer.box ? Math.max(1, layer.box.width * scale) : Math.max(1, Math.ceil(layout.width));
  const height = layer.box ? Math.max(1, layer.box.height * scale) : Math.max(1, Math.ceil(layout.height));
  const frame = { x: 0, y: 0, width, height };
  const map = warpFunction(warp, frame);
  const bounds = warpedBounds(map, frame);
  const box = rasterBox({ left: bounds.x, top: bounds.y, right: bounds.x + bounds.width, bottom: bounds.y + bounds.height });
  const CELL = 12;
  const cols = Math.max(1, Math.min(160, Math.ceil(width / CELL))), rows = Math.max(1, Math.min(80, Math.ceil(height / CELL)));
  const cellWidth = width / cols, cellHeight = height / rows;
  const source = (i: number, j: number): Point => ({ x: i * cellWidth, y: j * cellHeight });
  const target: Point[] = [];
  for (let j = 0; j <= rows; j++) for (let i = 0; i <= cols; i++) {
    const q = map(source(i, j));
    target.push({ x: q.x - box.origin.x, y: q.y - box.origin.y });
  }
  const vertex = (i: number, j: number) => target[j * (cols + 1) + i]!;
  // Glyphs per cell, by their ink bounds.
  interface Glyph { readonly line: number; readonly run: number; readonly index: number; readonly color: RgbaColor }
  const cells: Glyph[][] = Array.from({ length: cols * rows }, () => []);
  layout.shapedLines().forEach((line, lineIndex) => line.runs.forEach((run, runIndex) => {
    for (let k = 0; k < run.glyphs.length; k++) {
      const gx = run.positions[2 * k]!, gy = run.positions[2 * k + 1]!;
      const l = gx + run.bounds[4 * k]! - 1, t = gy + run.bounds[4 * k + 1]! - 1, r = gx + run.bounds[4 * k + 2]! + 1, b = gy + run.bounds[4 * k + 3]! + 1;
      if (!(r - l > 2) || !(b - t > 2)) continue;
      const c0 = Math.max(0, Math.floor(l / cellWidth)), c1 = Math.min(cols - 1, Math.floor(r / cellWidth));
      const r0 = Math.max(0, Math.floor(t / cellHeight)), r1 = Math.min(rows - 1, Math.floor(b / cellHeight));
      const glyph = { line: lineIndex, run: runIndex, index: k, color: colorAt(layer, run.offsets[k]!) };
      for (let row = r0; row <= r1; row++) for (let col = c0; col <= c1; col++) cells[row * cols + col]!.push(glyph);
    }
  }));
  const draws: GlyphDraw[] = [];
  const affine = (p: readonly Point[], q: readonly Point[]): Matrix => {
    const s11 = p[1]!.x - p[0]!.x, s21 = p[1]!.y - p[0]!.y, s12 = p[2]!.x - p[0]!.x, s22 = p[2]!.y - p[0]!.y;
    const d11 = q[1]!.x - q[0]!.x, d21 = q[1]!.y - q[0]!.y, d12 = q[2]!.x - q[0]!.x, d22 = q[2]!.y - q[0]!.y;
    const det = s11 * s22 - s12 * s21;
    const i11 = s22 / det, i12 = -s12 / det, i21 = -s21 / det, i22 = s11 / det;
    const a = d11 * i11 + d12 * i21, c = d11 * i12 + d12 * i22, b = d21 * i11 + d22 * i21, d = d21 * i12 + d22 * i22;
    return [a, b, c, d, q[0]!.x - a * p[0]!.x - c * p[0]!.y, q[0]!.y - b * p[0]!.x - d * p[0]!.y];
  };
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
    const glyphs = cells[row * cols + col]!;
    if (!glyphs.length) continue;
    const corners = [[col, row], [col + 1, row], [col + 1, row + 1], [col, row + 1]] as const;
    for (const triangle of [[0, 1, 2], [0, 2, 3]] as const) {
      const p = triangle.map((k) => source(corners[k][0], corners[k][1])), q = triangle.map((k) => vertex(corners[k][0], corners[k][1]));
      const matrix = affine(p, q), clip = q.flatMap((point) => [point.x, point.y]);
      let open: { line: number; run: number; from: number; to: number; color: RgbaColor } | null = null;
      const flush = () => { if (open) draws.push({ ...open, matrix, clip }); open = null; };
      for (const glyph of glyphs) {
        if (open && open.line === glyph.line && open.run === glyph.run && open.to === glyph.index && sameColor(open.color, glyph.color)) open.to++;
        else { flush(); open = { line: glyph.line, run: glyph.run, from: glyph.index, to: glyph.index + 1, color: glyph.color }; }
      }
      flush();
    }
  }
  const rendered = engine.rasterizeGlyphs(layout, { width: box.width, height: box.height, draws });
  const frameSize = { width: width / scale, height: height / scale };
  const offset = { x: box.origin.x / scale, y: box.origin.y / scale }, size = { width: box.width / scale, height: box.height / scale };
  const placement = textPlacement({ ...layer.transform, size: frameSize }, frameSize, offset, size);
  return new TextLayerLayout(layer.id, rendered.raster, placement, missing, layout, frameSize, offset, size, {
    toRaster: (point) => { const q = map(point); return { x: q.x - box.origin.x, y: q.y - box.origin.y }; },
    toLayout: (point) => {
      // Start Newton from the mesh vertex landing nearest to the point.
      let best = 0, distance = Infinity;
      target.forEach((value, index) => { const d = Math.hypot(value.x - point.x, value.y - point.y); if (d < distance) { distance = d; best = index; } });
      const guess = source(best % (cols + 1), Math.floor(best / (cols + 1)));
      return invertWarp(map, { x: point.x + box.origin.x, y: point.y + box.origin.y }, guess);
    },
    slice: CELL,
  });
}

/** Layouts from the editable model every time target scale changes; cached pixels are never scaled as text. */
export function layoutTextLayer(engine: TextEngine, fonts: TextFontRegistry, document: CanvasDocument,
  layer: TextLayer, targetPixelsPerDocumentPixel = 1, missingFonts: readonly MissingFont[] = []): TextLayerLayout {
  if (!(targetPixelsPerDocumentPixel > 0) || !Number.isFinite(targetPixelsPerDocumentPixel)) {
    throw new RangeError('Text target scale must be a positive finite number');
  }
  const onPath = layer.textPath && validTextOnPath(layer.textPath) ? layer.textPath : null;
  const warp = !onPath && layer.textWarp && validTextWarp(layer.textWarp) && !isIdentityWarp(layer.textWarp) ? layer.textWarp : null;
  const box = onPath ? null : layer.box;
  const defaultRun = layer.runs[0];
  const defaultStyle = defaultRun?.style;
  const defaultFont = fonts.resolution(defaultStyle?.fontFamily ?? 'Noto Sans');
  const defaultSize = pointsToPixels(defaultStyle?.fontSize ?? 12, document.resolution, targetPixelsPerDocumentPixel);
  const width = box ? Math.max(1, box.width * targetPixelsPerDocumentPixel) : 30_000;
  const blocks = layer.paragraphs.map((paragraph) => block(paragraph, layer.text, document, targetPixelsPerDocumentPixel));
  const layout = engine.layoutParagraph({ text: layer.text, width, pointText: box === null,
    fontFamilies: defaultFont.families, fontSize: defaultSize,
    spans: layer.runs.map((run) => span(run, document, targetPixelsPerDocumentPixel, fonts)),
    // Text on a path is aligned within its path range, not within the line box.
    paragraphs: onPath ? blocks.map((value) => ({ ...value, alignment: 'left' as const })) : blocks });
  const missing = missingFonts.filter((font) => font.layerIds.includes(layer.id));
  try {
    if (onPath) return pathTextLayout(engine, layout, layer, onPath, document, targetPixelsPerDocumentPixel, defaultSize, missing);
    if (warp) return warpedTextLayout(engine, layout, layer, warp, targetPixelsPerDocumentPixel, missing);
    const rendered = engine.rasterizeParagraph(layout);
    const logicalWidth = layer.box?.width ?? rendered.raster.width / targetPixelsPerDocumentPixel;
    const logicalHeight = layer.box?.height ?? rendered.raster.height / targetPixelsPerDocumentPixel;
    const raster = layer.box ? fixedBoxRaster(rendered.raster, Math.max(1, Math.ceil(layer.box.width * targetPixelsPerDocumentPixel)),
      Math.max(1, Math.ceil(layer.box.height * targetPixelsPerDocumentPixel))) : rendered.raster;
    const transform = { ...layer.transform, size: { width: logicalWidth, height: logicalHeight } };
    return new TextLayerLayout(layer.id, raster, transform, missing, layout);
  } catch (error) {
    layout.dispose();
    throw error;
  }
}

