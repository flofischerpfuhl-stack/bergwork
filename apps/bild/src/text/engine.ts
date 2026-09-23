import CanvasKitInit, {
  type CanvasKit, type Color, type EmbindObject, type Paint, type Paragraph, type Path,
  type Shader, type Surface, type TypefaceFontProvider,
} from 'canvaskit-wasm';
import canvasKitWasmUrl from 'canvaskit-wasm/bin/canvaskit.wasm?url';
import { Raster } from '../core/raster';
import type {
  FillPaint, FontRegistration, LoadTextEngineOptions, ParagraphLayout, ParagraphRequest, PathOperation,
  PathRasterRequest, RasterizedOutput, RegisteredFont, RgbaColor, StrokePaint, TextAlignment, TextDirection,
  TextEngine, TextEngineMemory,
} from './types';

interface CanvasKitHeap extends CanvasKit { readonly HEAPU8?: Uint8Array }

class CanvasKitParagraphLayout implements ParagraphLayout {
  readonly width: number;
  readonly height: number;
  readonly longestLine: number;
  readonly lineCount: number;
  readonly alphabeticBaseline: number;
  readonly exceededMaxLines: boolean;
  readonly unresolvedCodepoints: readonly number[];
  private disposed = false;

  constructor(readonly owner: CanvasKitTextEngine, readonly request: ParagraphRequest, readonly paragraph: Paragraph) {
    this.width = request.width;
    this.height = paragraph.getHeight();
    this.longestLine = paragraph.getLongestLine();
    this.lineCount = paragraph.getNumberOfLines();
    this.alphabeticBaseline = paragraph.getAlphabeticBaseline();
    this.exceededMaxLines = paragraph.didExceedMaxLines();
    this.unresolvedCodepoints = paragraph.unresolvedCodepoints();
  }

  assertUsable(owner: CanvasKitTextEngine): void {
    if (this.disposed) throw new Error('Paragraph layout has been disposed');
    if (owner !== this.owner) throw new Error('Paragraph layout belongs to a different text engine');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.paragraph.delete();
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
  private disposed = false;

  constructor(private readonly kit: CanvasKit) {
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
    const style = new this.kit.ParagraphStyle({
      textAlign: textAlign(this.kit, request.alignment),
      textDirection: textDirection(this.kit, request.direction),
      maxLines: request.maxLines,
      textStyle: {
        color: color(this.kit, request.color ?? { red: 0, green: 0, blue: 0 }),
        fontFamilies: [...request.fontFamilies],
        fontSize: request.fontSize,
        letterSpacing: request.letterSpacing,
        wordSpacing: request.wordSpacing,
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
      return new CanvasKitParagraphLayout(this, request, paragraph);
    } finally {
      builder.delete();
    }
  }

  rasterizeParagraph(layout: ParagraphLayout, padding = 0): RasterizedOutput {
    this.assertUsable();
    if (!(layout instanceof CanvasKitParagraphLayout)) throw new Error('Unsupported paragraph layout implementation');
    layout.assertUsable(this);
    if (!Number.isFinite(padding) || padding < 0) throw new RangeError('Padding must be a non-negative finite number');
    const width = Math.max(1, Math.ceil(layout.width + padding * 2));
    const height = Math.max(1, Math.ceil(layout.height + padding * 2));
    const surface = this.makeSurface(width, height);
    try {
      const canvas = surface.getCanvas();
      canvas.clear(this.kit.TRANSPARENT);
      canvas.drawParagraph(layout.paragraph, padding, padding);
      return { raster: this.readSurface(surface, width, height), origin: { x: padding, y: padding } };
    } finally {
      surface.delete();
    }
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

  private readSurface(surface: Surface, width: number, height: number): Raster {
    surface.flush();
    const pixels = surface.getCanvas().readPixels(0, 0, {
      width, height,
      colorType: this.kit.ColorType.RGBA_8888,
      alphaType: this.kit.AlphaType.Unpremul,
      colorSpace: this.kit.ColorSpace.SRGB,
    });
    if (!(pixels instanceof Uint8Array)) throw new Error('CanvasKit CPU readback failed');
    return Raster.fromPixels(width, height, 4, pixels);
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
