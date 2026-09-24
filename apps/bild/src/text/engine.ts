import CanvasKitInit, {
  type CanvasKit, type Color, type EmbindObject, type MallocObj, type Paint, type Paragraph, type Path,
  type Shader, type Surface, type TextStyle as CanvasTextStyle, type TypefaceFontProvider,
} from 'canvaskit-wasm';
import canvasKitWasmUrl from 'canvaskit-wasm/bin/canvaskit.wasm?url';
import { Raster, TILE } from '../core/raster';
import type {
  FillPaint, FontRegistration, LoadTextEngineOptions, ParagraphBlock, ParagraphLayout, ParagraphRequest, ParagraphSpan, PathOperation,
  PathRasterRequest, RasterizedOutput, RegisteredFont, RgbaColor, StrokePaint, TextAlignment, TextDirection,
  TextEngine, TextEngineMemory, TextRect,
} from './types';

interface CanvasKitHeap extends CanvasKit { readonly HEAPU8?: Uint8Array }

interface LaidOutParagraph {
  readonly paragraph: Paragraph;
  readonly from: number;
  readonly to: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
}

class CanvasKitParagraphLayout implements ParagraphLayout {
  readonly width: number;
  readonly height: number;
  readonly longestLine: number;
  readonly lineCount: number;
  readonly alphabeticBaseline: number;
  readonly exceededMaxLines: boolean;
  readonly unresolvedCodepoints: readonly number[];
  private disposed = false;

  constructor(readonly owner: CanvasKitTextEngine, readonly request: ParagraphRequest,
    readonly paragraphs: readonly LaidOutParagraph[], width: number, height: number) {
    this.width = width;
    this.height = height;
    this.longestLine = paragraphs.reduce((maximum, value) => Math.max(maximum, value.x + value.paragraph.getLongestLine()), 0);
    this.lineCount = paragraphs.reduce((total, value) => total + value.paragraph.getNumberOfLines(), 0);
    this.alphabeticBaseline = (paragraphs[0]?.y ?? 0) + (paragraphs[0]?.paragraph.getAlphabeticBaseline() ?? 0);
    this.exceededMaxLines = paragraphs.some((value) => value.paragraph.didExceedMaxLines());
    this.unresolvedCodepoints = [...new Set(paragraphs.flatMap((value) => value.paragraph.unresolvedCodepoints()))];
  }

  assertUsable(owner: CanvasKitTextEngine): void {
    if (this.disposed) throw new Error('Paragraph layout has been disposed');
    if (owner !== this.owner) throw new Error('Paragraph layout belongs to a different text engine');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const value of this.paragraphs) value.paragraph.delete();
  }

  caretIndexAt(x: number, y: number): number {
    this.assertUsable(this.owner);
    if (!this.paragraphs.length) return 0;
    let selected = this.paragraphs[0]!;
    for (const paragraph of this.paragraphs) {
      selected = paragraph;
      if (y < paragraph.y + paragraph.paragraph.getHeight()) break;
    }
    const position = selected.paragraph.getGlyphPositionAtCoordinate(x - selected.x, y - selected.y).pos;
    return Math.max(selected.from, Math.min(selected.to, selected.from + position));
  }

  selectionRects(from: number, to: number): readonly TextRect[] {
    this.assertUsable(this.owner);
    if (from < 0 || to < from || to > this.request.text.length) throw new RangeError('Invalid text selection range');
    const result: TextRect[] = [];
    for (const value of this.paragraphs) {
      const start = Math.max(from, value.from), end = Math.min(to, value.to);
      if (end <= start) continue;
      const rects = value.paragraph.getRectsForRange(start - value.from, end - value.from,
        this.owner.kit.RectHeightStyle.Tight, this.owner.kit.RectWidthStyle.Tight);
      for (const entry of rects) result.push({ x: value.x + entry.rect[0]!, y: value.y + entry.rect[1]!,
        width: entry.rect[2]! - entry.rect[0]!, height: entry.rect[3]! - entry.rect[1]! });
    }
    return result;
  }

  caretRect(index: number): TextRect {
    this.assertUsable(this.owner);
    if (!Number.isInteger(index) || index < 0 || index > this.request.text.length) throw new RangeError('Invalid caret index');
    const value = this.paragraphs.find((paragraph) => paragraph.from <= index && index <= paragraph.to)
      ?? this.paragraphs.at(-1);
    if (!value) return { x: 0, y: 0, width: 1, height: Math.max(1, this.request.fontSize) };
    const local = Math.max(0, Math.min(value.to - value.from, index - value.from));
    const info = value.paragraph.getGlyphInfoAt(Math.min(local, Math.max(0, value.to - value.from - 1)));
    if (info) {
      const bounds = info.graphemeLayoutBounds;
      const atEnd = local >= info.graphemeClusterTextRange.end;
      return { x: value.x + bounds[atEnd ? 2 : 0]!, y: value.y + bounds[1]!, width: 1,
        height: Math.max(1, bounds[3]! - bounds[1]!) };
    }
    const line = value.paragraph.getLineMetrics().at(-1);
    return line ? { x: value.x + line.left + line.width, y: value.y + line.baseline - line.ascent,
      width: 1, height: Math.max(1, line.ascent + line.descent) }
      : { x: value.x, y: value.y, width: 1, height: Math.max(1, this.request.fontSize) };
  }
}

function positiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be a positive finite number`);
}

function color(kit: CanvasKit, value: RgbaColor): Color {
  const alpha = value.alpha ?? 1;
  if (![value.red, value.green, value.blue, alpha].every(Number.isFinite) || alpha < 0 || alpha > 1) {
    throw new RangeError('Invalid RGBA color');
  }
  return kit.Color(value.red, value.green, value.blue, alpha);
}

function textAlign(kit: CanvasKit, value: TextAlignment | undefined) {
  switch (value ?? 'left') {
    case 'left': return kit.TextAlign.Left;
    case 'right': return kit.TextAlign.Right;
    case 'center': return kit.TextAlign.Center;
    case 'justify': return kit.TextAlign.Justify;
  }
}

function textDirection(kit: CanvasKit, value: TextDirection | undefined) {
  return value === 'rtl' ? kit.TextDirection.RTL : kit.TextDirection.LTR;
}

function fontWeight(kit: CanvasKit, weight: number | undefined) {
  const value = weight ?? 400;
  if (value < 150) return kit.FontWeight.Thin;
  if (value < 250) return kit.FontWeight.ExtraLight;
  if (value < 350) return kit.FontWeight.Light;
  if (value < 450) return kit.FontWeight.Normal;
  if (value < 550) return kit.FontWeight.Medium;
  if (value < 650) return kit.FontWeight.SemiBold;
  if (value < 750) return kit.FontWeight.Bold;
  if (value < 850) return kit.FontWeight.ExtraBold;
  return kit.FontWeight.Black;
}

function spanStyle(kit: CanvasKit, request: ParagraphRequest, span?: ParagraphSpan): CanvasTextStyle {
  const style = span ?? request;
  const slant = 'fontStyle' in style && style.fontStyle === 'italic' ? kit.FontSlant.Italic
    : 'fontStyle' in style && style.fontStyle === 'oblique' ? kit.FontSlant.Oblique : kit.FontSlant.Upright;
  return {
    color: color(kit, style.color ?? request.color ?? { red: 0, green: 0, blue: 0 }),
    fontFamilies: [...style.fontFamilies], fontSize: style.fontSize,
    fontStyle: { weight: fontWeight(kit, 'fontWeight' in style ? style.fontWeight : undefined), slant },
    letterSpacing: style.letterSpacing ?? request.letterSpacing,
    wordSpacing: request.wordSpacing, heightMultiplier: style.heightMultiplier ?? request.heightMultiplier,
    fontFeatures: (style.fontFeatures ?? request.fontFeatures)?.map((feature) => ({ ...feature })),
    fontVariations: (style.fontVariations ?? request.fontVariations)?.map((variation) => ({ ...variation })),
  };
}

function paragraphBlocks(request: ParagraphRequest): ParagraphBlock[] {
  if (request.paragraphs?.length) return request.paragraphs.map((value) => ({ ...value }));
  return [{ from: 0, to: request.text.length, alignment: request.alignment, direction: request.direction }];
}

function pathOperation(kit: CanvasKit, value: PathOperation) {
  switch (value) {
    case 'union': return kit.PathOp.Union;
    case 'difference': return kit.PathOp.Difference;
    case 'intersect': return kit.PathOp.Intersect;
    case 'xor': return kit.PathOp.XOR;
    case 'reverseDifference': return kit.PathOp.ReverseDifference;
  }
}

function deleteAll(values: readonly (EmbindObject<string> | null)[]): void {
  for (let i = values.length - 1; i >= 0; i--) values[i]?.delete();
}

export class CanvasKitTextEngine implements TextEngine {
  private readonly provider: TypefaceFontProvider;
  private readonly registered = new Map<string, RegisteredFont>();
  private paragraphSurface: {
    readonly width: number;
    readonly height: number;
    readonly surface: Surface;
    readonly pixels: MallocObj;
  } | null = null;
  private disposed = false;

  constructor(readonly kit: CanvasKit) {
    this.provider = kit.TypefaceFontProvider.Make();
  }

  get fonts(): readonly RegisteredFont[] { return [...this.registered.values()]; }

  registerFont(registration: FontRegistration): RegisteredFont {
    this.assertUsable();
    if (!registration.id || !registration.family) throw new Error('Font id and family are required');
    if (this.registered.has(registration.id)) throw new Error(`Font id is already registered: ${registration.id}`);
    const bytes = registration.bytes instanceof Uint8Array
      ? registration.bytes
      : new Uint8Array(registration.bytes);
    if (bytes.byteLength === 0) throw new Error('Font data is empty');
    this.provider.registerFont(bytes, registration.family);
    const record: RegisteredFont = {
      id: registration.id,
      family: registration.family,
      byteLength: bytes.byteLength,
      source: registration.source ?? null,
    };
    this.registered.set(record.id, record);
    return record;
  }

  layoutParagraph(request: ParagraphRequest): ParagraphLayout {
    this.assertUsable();
    positiveFinite(request.width, 'Paragraph width');
    positiveFinite(request.fontSize, 'Font size');
    if (request.fontFamilies.length === 0) throw new Error('At least one font family is required');
    if (!request.spans && !request.paragraphs && !request.pointText) {
      const style = new this.kit.ParagraphStyle({
        textAlign: textAlign(this.kit, request.alignment), textDirection: textDirection(this.kit, request.direction),
        maxLines: request.maxLines, textStyle: {
          color: color(this.kit, request.color ?? { red: 0, green: 0, blue: 0 }),
          fontFamilies: [...request.fontFamilies], fontSize: request.fontSize,
          letterSpacing: request.letterSpacing, wordSpacing: request.wordSpacing,
          heightMultiplier: request.heightMultiplier,
          fontFeatures: request.fontFeatures?.map((feature) => ({ ...feature })),
          fontVariations: request.fontVariations?.map((variation) => ({ ...variation })),
        },
      });
      const builder = this.kit.ParagraphBuilder.MakeFromFontProvider(style, this.provider);
      try {
        builder.addText(request.text);
        const paragraph = builder.build();
        paragraph.layout(request.width);
        return new CanvasKitParagraphLayout(this, request,
          [{ paragraph, from: 0, to: request.text.length, x: 0, y: 0, width: request.width }],
          request.width, Math.max(1, paragraph.getHeight()));
      } finally { builder.delete(); }
    }
    const laidOut: LaidOutParagraph[] = [];
    let y = 0, actualWidth = request.pointText ? 1 : request.width;
    try {
      for (const block of paragraphBlocks(request)) {
        if (!Number.isInteger(block.from) || !Number.isInteger(block.to) || block.from < 0 || block.to < block.from
          || block.to > request.text.length) throw new RangeError('Invalid paragraph range');
        const startIndent = block.startIndent ?? 0, endIndent = block.endIndent ?? 0;
        const availableWidth = Math.max(1, request.width - startIndent - endIndent);
        const paragraphStyle = new this.kit.ParagraphStyle({
          textAlign: textAlign(this.kit, block.alignment ?? request.alignment),
          textDirection: textDirection(this.kit, block.direction ?? request.direction),
          maxLines: request.maxLines, textStyle: spanStyle(this.kit, request),
        });
        const builder = this.kit.ParagraphBuilder.MakeFromFontProvider(paragraphStyle, this.provider);
        try {
          const firstLineIndent = Math.max(0, block.firstLineIndent ?? 0);
          if (firstLineIndent) builder.addPlaceholder(firstLineIndent, request.fontSize);
          const contentTo = block.to > block.from && request.text.charCodeAt(block.to - 1) === 10 ? block.to - 1 : block.to;
          const boundaries = new Set<number>([block.from, contentTo]);
          for (const span of request.spans ?? []) {
            if (span.to > block.from && span.from < contentTo) {
              boundaries.add(Math.max(block.from, span.from)); boundaries.add(Math.min(contentTo, span.to));
            }
          }
          const sorted = [...boundaries].sort((a, b) => a - b);
          for (let index = 0; index + 1 < sorted.length; index++) {
            const from = sorted[index]!, to = sorted[index + 1]!;
            if (to <= from) continue;
            const span = [...request.spans ?? []].reverse().find((value) => value.from <= from && value.to >= to);
            builder.pushStyle(new this.kit.TextStyle(spanStyle(this.kit, request, span)));
            builder.addText(request.text.slice(from, to));
            builder.pop();
          }
          if (contentTo === block.from) builder.addText('');
          const paragraph = builder.build();
          paragraph.layout(availableWidth);
          y += Math.max(0, block.spaceBefore ?? 0);
          laidOut.push({ paragraph, from: block.from, to: block.to, x: startIndent, y, width: availableWidth });
          actualWidth = Math.max(actualWidth, startIndent + paragraph.getLongestLine());
          y += paragraph.getHeight() + Math.max(0, block.spaceAfter ?? 0);
        } finally {
          builder.delete();
        }
      }
      return new CanvasKitParagraphLayout(this, request, laidOut, actualWidth, Math.max(1, y));
    } catch (error) {
      for (const value of laidOut) value.paragraph.delete();
      throw error;
    }
  }

  rasterizeParagraph(layout: ParagraphLayout, padding = 0): RasterizedOutput {
    this.assertUsable();
    if (!(layout instanceof CanvasKitParagraphLayout)) throw new Error('Unsupported paragraph layout implementation');
    layout.assertUsable(this);
    if (!Number.isFinite(padding) || padding < 0) throw new RangeError('Padding must be a non-negative finite number');
    const width = Math.max(1, Math.ceil(layout.width + padding * 2));
    const height = Math.max(1, Math.ceil(layout.height + padding * 2));
    const scratch = this.reusableParagraphSurface(width, height);
    const canvas = scratch.surface.getCanvas();
    canvas.clear(this.kit.TRANSPARENT);
    for (const value of layout.paragraphs) canvas.drawParagraph(value.paragraph, padding + value.x, padding + value.y);
    return { raster: this.readSurface(scratch.surface, width, height, scratch.pixels), origin: { x: padding, y: padding } };
  }

  combinePaths(firstSvg: string, secondSvg: string, operation: PathOperation): string {
    this.assertUsable();
    const first = this.parsePath(firstSvg);
    const second = this.parsePath(secondSvg);
    let combined: Path | null = null;
    try {
      combined = this.kit.Path.MakeFromOp(first, second, pathOperation(this.kit, operation));
      if (!combined) throw new Error(`CanvasKit PathOps ${operation} failed`);
      return combined.toSVGString();
    } finally {
      deleteAll([combined, second, first]);
    }
  }

  rasterizePath(request: PathRasterRequest): RasterizedOutput {
    this.assertUsable();
    positiveFinite(request.width, 'Path raster width');
    positiveFinite(request.height, 'Path raster height');
    const width = Math.ceil(request.width), height = Math.ceil(request.height);
    const surface = this.makeSurface(width, height);
    const path = this.parsePath(request.svgPath);
    try {
      const canvas = surface.getCanvas();
      canvas.clear(color(this.kit, request.background ?? { red: 0, green: 0, blue: 0, alpha: 0 }));
      if (request.fill) this.drawFill(canvas, path, request.fill);
      if (request.stroke) this.drawStroke(canvas, path, request.stroke);
      return { raster: this.readSurface(surface, width, height), origin: { x: 0, y: 0 } };
    } finally {
      deleteAll([path, surface]);
    }
  }

  memoryUsage(): TextEngineMemory {
    this.assertUsable();
    const heap = (this.kit as CanvasKitHeap).HEAPU8;
    let registeredFontBytes = 0;
    for (const font of this.registered.values()) registeredFontBytes += font.byteLength;
    return {
      wasmHeapBytes: heap?.buffer.byteLength ?? 0,
      registeredFontBytes,
      registeredFontCount: this.registered.size,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.paragraphSurface) {
      this.paragraphSurface.surface.delete();
      this.kit.Free(this.paragraphSurface.pixels);
    }
    this.paragraphSurface = null;
    this.provider.delete();
    this.registered.clear();
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('Text engine has been disposed');
  }

  private parsePath(svg: string): Path {
    const path = this.kit.Path.MakeFromSVGString(svg);
    if (!path) throw new Error('Invalid SVG path data');
    return path;
  }

  private makeSurface(width: number, height: number): Surface {
    // A software raster surface is deliberate: A5 requires host-identical output, never WebGL output.
    const surface = this.kit.MakeSurface(width, height);
    if (!surface) throw new Error(`CanvasKit could not allocate a ${width}×${height} CPU surface`);
    return surface;
  }

  private reusableParagraphSurface(width: number, height: number): NonNullable<CanvasKitTextEngine['paragraphSurface']> {
    if (this.paragraphSurface?.width === width && this.paragraphSurface.height === height) {
      return this.paragraphSurface;
    }
    if (this.paragraphSurface) {
      this.paragraphSurface.surface.delete();
      this.kit.Free(this.paragraphSurface.pixels);
    }
    const surface = this.makeSurface(width, height);
    const pixels = this.kit.Malloc(Uint8Array, width * height * 4);
    this.paragraphSurface = { width, height, surface, pixels };
    return this.paragraphSurface;
  }

  private readSurface(surface: Surface, width: number, height: number, destination?: MallocObj): Raster {
    // MakeSurface creates an immediate CPU raster surface; readPixels observes completed draws
    // without the GPU-only flush step.
    const pixels = surface.getCanvas().readPixels(0, 0, {
      width, height,
      colorType: this.kit.ColorType.RGBA_8888,
      alphaType: this.kit.AlphaType.Unpremul,
      colorSpace: this.kit.ColorSpace.SRGB,
    }, destination, destination ? width * 4 : undefined);
    if (!(pixels instanceof Uint8Array)) throw new Error('CanvasKit CPU readback failed');
    const cols = Math.ceil(width / TILE), rows = Math.ceil(height / TILE);
    const tiles = new Array<Uint8Array>(cols * rows);
    for (let row = 0; row < rows; row++) {
      const tileHeight = Math.min(TILE, height - row * TILE);
      for (let col = 0; col < cols; col++) {
        const tileWidth = Math.min(TILE, width - col * TILE);
        const tile = new Uint8Array(tileWidth * tileHeight * 4);
        for (let y = 0; y < tileHeight; y++) {
          const source = ((row * TILE + y) * width + col * TILE) * 4;
          tile.set(pixels.subarray(source, source + tileWidth * 4), y * tileWidth * 4);
        }
        tiles[row * cols + col] = tile;
      }
    }
    return new Raster(width, height, 4, tiles);
  }

  private drawFill(canvas: ReturnType<Surface['getCanvas']>, path: Path, fill: FillPaint): void {
    const paint = new this.kit.Paint();
    let shader: Shader | null = null;
    try {
      paint.setAntiAlias(true);
      paint.setStyle(this.kit.PaintStyle.Fill);
      if (fill.kind === 'solid') {
        paint.setColor(color(this.kit, fill.color));
      } else {
        if (fill.colors.length < 2) throw new Error('A linear gradient needs at least two colors');
        if (fill.positions && fill.positions.length !== fill.colors.length) {
          throw new Error('Gradient positions must match the color count');
        }
        shader = this.kit.Shader.MakeLinearGradient(
          [...fill.start], [...fill.end], fill.colors.map((entry) => color(this.kit, entry)),
          fill.positions ? [...fill.positions] : null, this.kit.TileMode.Clamp,
        );
        paint.setShader(shader);
      }
      canvas.drawPath(path, paint);
    } finally {
      deleteAll([shader, paint]);
    }
  }

  private drawStroke(canvas: ReturnType<Surface['getCanvas']>, path: Path, stroke: StrokePaint): void {
    positiveFinite(stroke.width, 'Stroke width');
    const paint = new this.kit.Paint();
    let effect: ReturnType<CanvasKit['PathEffect']['MakeDash']> | null = null;
    try {
      paint.setAntiAlias(true);
      paint.setStyle(this.kit.PaintStyle.Stroke);
      paint.setColor(color(this.kit, stroke.color));
      paint.setStrokeWidth(stroke.width);
      paint.setStrokeJoin(stroke.join === 'round' ? this.kit.StrokeJoin.Round
        : stroke.join === 'bevel' ? this.kit.StrokeJoin.Bevel : this.kit.StrokeJoin.Miter);
      paint.setStrokeCap(stroke.cap === 'round' ? this.kit.StrokeCap.Round
        : stroke.cap === 'square' ? this.kit.StrokeCap.Square : this.kit.StrokeCap.Butt);
      if (stroke.dash) {
        if (stroke.dash.length < 2 || stroke.dash.length % 2 !== 0 || stroke.dash.some((value) => !(value > 0))) {
          throw new Error('Dash intervals must be a positive, even-length list');
        }
        effect = this.kit.PathEffect.MakeDash([...stroke.dash], stroke.dashPhase ?? 0);
        paint.setPathEffect(effect);
      }
      canvas.drawPath(path, paint);
    } finally {
      deleteAll([effect, paint]);
    }
  }
}

export async function createCanvasKitTextEngine(options: LoadTextEngineOptions = {}): Promise<TextEngine> {
  // Root-relative Vite asset URLs are invalid against a blob: worker URL. Resolving against this
  // module keeps the exact same emitted WASM usable on the main thread and in module workers.
  const emittedWasmUrl = new URL(canvasKitWasmUrl, import.meta.url).href;
  const kit = await CanvasKitInit({ locateFile: () => options.wasmUrl ?? emittedWasmUrl });
  if (!kit.ParagraphBuilder || !kit.PathOp || !kit.MakeSurface) {
    throw new Error('This CanvasKit build lacks Paragraph, PathOps, or CPU surface support');
  }
  return new CanvasKitTextEngine(kit);
}
