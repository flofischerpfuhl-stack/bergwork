import {
  initializeCanvas, readPsd, type BlendMode as AgBlendMode, type Layer as AgLayer,
  type BezierPath, type Color as AgColor, type LayerTextData, type PixelData, type Psd, type UnitsValue, type VectorContent,
} from 'ag-psd';
import {
  type BlendMode, type CanvasDocument, type ColorLabel, type FillParameters, type Layer, type LayerLocks,
  type VectorMask, type VectorPath, type VectorStyle,
  DEFAULT_TEXT_STYLE, defaultTextParagraphStyle, MAX_LAYERS, MAX_PIXELS, MAX_SIDE, newLayer,
} from '../../core/document';
import { makeTransform, samePlacement, type LayerTransform } from '../../core/geometry';
import { Raster } from '../../core/raster';

export type PsdUnsupportedImpact = 'not-rendered' | 'approximated' | 'editability-only';

export interface PsdUnsupportedFeature {
  readonly code: string;
  readonly message: string;
  readonly impact: PsdUnsupportedImpact;
  readonly layerPath?: string;
}

export interface PsdSourceInfo {
  readonly width: number;
  readonly height: number;
  readonly bitsPerChannel: number;
  readonly colorMode: number;
  readonly isPsb: boolean;
}

export interface PsdReadResult {
  readonly document: CanvasDocument;
  /** Photoshop's saved composite image, used as the fidelity oracle. */
  readonly oracle: Raster | null;
  readonly unsupported: readonly PsdUnsupportedFeature[];
  readonly parserWarnings: readonly string[];
  readonly source: PsdSourceInfo;
}

export const PSD_BLEND_MODES: readonly AgBlendMode[] = [
  'normal', 'dissolve', 'darken', 'multiply', 'color burn', 'linear burn', 'darker color',
  'lighten', 'screen', 'color dodge', 'linear dodge', 'lighter color', 'overlay', 'soft light',
  'hard light', 'vivid light', 'linear light', 'pin light', 'hard mix', 'difference', 'exclusion',
  'subtract', 'divide', 'hue', 'saturation', 'color', 'luminosity',
];

const BLEND_MODES = new Map<AgBlendMode, BlendMode>([
  ['normal', 'normal'], ['dissolve', 'dissolve'],
  ['darken', 'darken'], ['multiply', 'multiply'], ['color burn', 'colorBurn'],
  ['linear burn', 'linearBurn'], ['darker color', 'darkerColor'],
  ['lighten', 'lighten'], ['screen', 'screen'], ['color dodge', 'colorDodge'],
  ['linear dodge', 'linearDodge'], ['lighter color', 'lighterColor'],
  ['overlay', 'overlay'], ['soft light', 'softLight'], ['hard light', 'hardLight'],
  ['vivid light', 'vividLight'], ['linear light', 'linearLight'], ['pin light', 'pinLight'],
  ['hard mix', 'hardMix'], ['difference', 'difference'], ['exclusion', 'exclusion'],
  ['subtract', 'subtract'], ['divide', 'divide'],
  ['hue', 'hue'], ['saturation', 'saturation'], ['color', 'color'], ['luminosity', 'luminosity'],
]);

export const SUPPORTED_PSD_BLEND_MODES: ReadonlySet<AgBlendMode> = new Set(BLEND_MODES.keys());

let canvasShimReady = false;

/** ag-psd needs only ImageData allocation in canvas-free mode; no DOM or native canvas is used. */
function ensureCanvasFreeImageData(): void {
  if (canvasShimReady) return;
  initializeCanvas(
    () => { throw new Error('Canvas output is disabled for PSD import'); },
    (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4), colorSpace: 'srgb' }) as ImageData,
  );
  canvasShimReady = true;
}

function byte(value: number, scale: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.min(1, Math.max(0, value / scale)) * 255);
}

/** ag-psd preserves 16-bit integers and 32-bit floats; the editor model is RGBA8. */
export function pixelDataToRgba8(image: PixelData): Uint8Array {
  if (image.data.length !== image.width * image.height * 4) throw new RangeError('PSD pixel buffer size mismatch');
  const output = new Uint8Array(image.data.length);
  if (image.data instanceof Uint8Array || image.data instanceof Uint8ClampedArray) {
    output.set(image.data);
  } else if (image.data instanceof Uint16Array) {
    for (let index = 0; index < output.length; index++) output[index] = byte(image.data[index]!, 65_535);
  } else {
    for (let index = 0; index < output.length; index++) output[index] = byte(image.data[index]!, 1);
  }
  return output;
}

function transform(left: number, top: number, width: number, height: number): LayerTransform {
  return makeTransform({ x: left, y: top }, { width: Math.max(1, width), height: Math.max(1, height) }, { sampling: 'Nearest' });
}

function pathName(parent: string, layer: AgLayer, index: number): string {
  const name = layer.name?.trim() || `Layer ${index + 1}`;
  return parent ? `${parent}/${name}` : name;
}

interface ImportState {
  nextId: number;
  readonly documentWidth: number;
  readonly documentHeight: number;
  readonly resolution: number;
  readonly unsupported: PsdUnsupportedFeature[];
}

function issue(state: ImportState, code: string, message: string, impact: PsdUnsupportedImpact, layerPath?: string): void {
  state.unsupported.push({ code, message, impact, ...(layerPath ? { layerPath } : {}) });
}

function maskFor(source: AgLayer, layerTransform: LayerTransform, state: ImportState,
  layerPath: string): Layer['mask'] {
  const mask = source.mask;
  if (!mask) return null;
  if (!mask.imageData) {
    const cached = mask.fromVectorData && source.imageData;
    issue(state, 'mask-pixels', cached
      ? 'Vector-derived mask uses the layer pixel cache and is not editable.'
      : 'Layer mask has no decodable pixel channel.', cached ? 'editability-only' : 'not-rendered', layerPath);
    return null;
  }
  const rgba = pixelDataToRgba8(mask.imageData);
  const pixels = new Uint8Array(mask.imageData.width * mask.imageData.height);
  const density = mask.userMaskDensity ?? 1;
  for (let pixel = 0; pixel < pixels.length; pixel++) {
    const coverage = rgba[pixel * 4]!;
    pixels[pixel] = Math.round(255 - (255 - coverage) * density);
  }
  if (density !== 1) issue(state, 'mask-density', 'Mask density was baked into its raster.', 'approximated', layerPath);
  if ((mask.userMaskFeather ?? 0) > 0 || (mask.vectorMaskFeather ?? 0) > 0) {
    issue(state, 'mask-feather', 'Mask feather is not rendered.', 'not-rendered', layerPath);
  }
  const relative = mask.positionRelativeToLayer === true;
  const left = (mask.left ?? 0) + (relative ? layerTransform.origin.x : 0);
  const top = (mask.top ?? 0) + (relative ? layerTransform.origin.y : 0);
  const placement = transform(left, top, mask.imageData.width, mask.imageData.height);
  const raster = Raster.fromPixels(mask.imageData.width, mask.imageData.height, 1, pixels);
  const defaultColor = mask.defaultColor ?? 0;
  let edgeTotal = 0, edgeCount = 0;
  for (let y = 0; y < raster.height; y++) for (let x = 0; x < raster.width; x++) {
    if (y === 0 || y === raster.height - 1 || x === 0 || x === raster.width - 1) {
      edgeTotal += pixels[y * raster.width + x]!; edgeCount++;
    }
  }
  const inferredDefault = edgeTotal * 2 >= edgeCount * 255 ? 255 : 0;
  if (inferredDefault !== defaultColor && !samePlacement(placement, layerTransform)) {
    issue(state, 'mask-default', `PSD outside-mask value ${defaultColor} differs from the editor's edge inference.`,
      'approximated', layerPath);
  }
  return { raster, enabled: mask.disabled !== true, placement: samePlacement(placement, layerTransform) ? null : placement,
    linked: relative };
}

function reportLayerFeatures(source: AgLayer, isGroup: boolean, state: ImportState, layerPath: string): void {
  if (source.adjustment) issue(state, `adjustment:${source.adjustment.type}`,
    `Adjustment layer “${source.adjustment.type}” is preserved only as an empty layer.`, 'not-rendered', layerPath);
  if (source.effects) issue(state, 'layer-effects', 'Layer effects are parsed but not rendered.', 'not-rendered', layerPath);
  if (source.text?.orientation === 'vertical') issue(state, 'vertical-text', 'Vertical PSD text is imported as horizontal text.', 'approximated', layerPath);
  if (source.text?.warp?.style && source.text.warp.style !== 'none') issue(state, 'text-warp', 'Warped PSD text remains editable but its warp is not rendered.', 'not-rendered', layerPath);
  if (source.placedLayer) issue(state, 'smart-object',
    'Smart object uses its saved pixel cache and is not editable.', 'editability-only', layerPath);
  if (source.realMask) issue(state, 'real-mask', 'The real/vector-derived mask channel is not rendered.', 'not-rendered', layerPath);
  if (source.filterEffectsMasks) issue(state, 'smart-filter', 'Smart filters and their masks are not rendered.', 'not-rendered', layerPath);
  if (source.knockout) issue(state, 'knockout', 'Knockout compositing is not rendered.', 'not-rendered', layerPath);
  const ranges = source.blendingRanges;
  const defaultRange = (values: readonly number[]): boolean => values.length === 4
    && values[0] === 0 && values[1] === 0 && values[2] === 255 && values[3] === 255;
  if (ranges && (!defaultRange(ranges.compositeGrayBlendSource)
    || !defaultRange(ranges.compositeGraphBlendDestinationRange)
    || ranges.ranges.some((range) => !defaultRange(range.sourceRange) || !defaultRange(range.destRange)))) {
    issue(state, 'blend-if', 'Non-default blend-if channel ranges are not rendered.', 'not-rendered', layerPath);
  }
  const hasClippedChildren = isGroup && source.children?.some((child) => child.clipping) === true;
  if (source.transparencyShapesLayer === false || (source.effects && source.blendInteriorElements === false)
    || (hasClippedChildren && source.blendClippendElements === false)) {
    issue(state, 'advanced-blending', 'Advanced blending flags are not rendered.', 'not-rendered', layerPath);
  }
  if (source.protected?.artboards) issue(state, 'lock-artboards',
    'The PSD artboard lock has no layer-lock equivalent.', 'editability-only', layerPath);
  if (isGroup && (source.blendMode ?? 'pass through') !== 'pass through') issue(state, 'isolated-group',
    `Group blend mode “${source.blendMode}” is rendered as pass-through.`, 'not-rendered', layerPath);
  if (isGroup && (source.opacity ?? 1) !== 1) issue(state, 'group-opacity',
    'Group opacity is not represented by the current document model.', 'not-rendered', layerPath);
}

function unitPixels(value: UnitsValue | undefined, resolution: number): number {
  if (!value) return 0;
  switch (value.units) {
    case 'Points': return value.value * resolution / 72;
    case 'Picas': return value.value * resolution / 6;
    case 'Inches': return value.value * resolution;
    case 'Centimeters': return value.value * resolution / 2.54;
    case 'Millimeters': return value.value * resolution / 25.4;
    default: return value.value;
  }
}

function psdVectorPaths(paths: readonly BezierPath[], origin: { x: number; y: number }): readonly VectorPath[] {
  return paths.filter((path) => path.knots.length > 0).map((path) => ({
    schemaVersion: 1 as const, closed: !path.open, fillRule: path.fillRule === 'even-odd' ? 'evenodd' as const : 'nonzero' as const,
    points: path.knots.map((knot) => ({
      // ag-psd readBezierKnot: preceding control, anchor, leaving control.
      in: { x: knot.points[0]! - origin.x, y: knot.points[1]! - origin.y },
      anchor: { x: knot.points[2]! - origin.x, y: knot.points[3]! - origin.y },
      out: { x: knot.points[4]! - origin.x, y: knot.points[5]! - origin.y },
      kind: knot.linked ? 'smooth' as const : 'corner' as const,
    })),
  }));
}

function psdFill(content: VectorContent | undefined, state: ImportState, layerPath: string): FillParameters | null {
  if (!content) return null;
  if (content.type === 'color') return { kind: 'solid', schemaVersion: 1, color: psdTextColor(content.color) };
  if (content.type === 'solid') {
    const stops = content.colorStops.map((stop) => ({ offset: Math.max(0, Math.min(1, stop.location)),
      color: psdTextColor(stop.color), opacity: 1 }));
    for (const opacity of content.opacityStops) {
      const nearest = stops.reduce((best, value) => Math.abs(value.offset - opacity.location) < Math.abs(best.offset - opacity.location) ? value : best, stops[0]!);
      nearest.opacity = Math.max(0, Math.min(1, opacity.opacity));
    }
    if (stops.length >= 2) return { kind: 'gradient', schemaVersion: 1, angle: content.angle ?? 0, stops };
  }
  issue(state, `vector-fill:${content.type}`, `PSD ${content.type} vector paint uses the saved preview.`, 'approximated', layerPath);
  return null;
}

function psdVectorStyle(source: AgLayer, resolution: number, state: ImportState, layerPath: string): VectorStyle {
  const stroke = source.vectorStroke, strokePaint = psdFill(stroke?.content, state, layerPath);
  const fallback = strokePaint?.kind === 'solid' ? strokePaint.color : { red: 0, green: 0, blue: 0 };
  return { schemaVersion: 1, fill: stroke?.fillEnabled === false ? null : psdFill(source.vectorFill, state, layerPath),
    stroke: stroke?.strokeEnabled === true ? {
      color: fallback, ...(strokePaint ? { paint: strokePaint } : {}), width: Math.max(0.01, unitPixels(stroke.lineWidth, resolution)),
      alignment: stroke.lineAlignment ?? 'center', cap: stroke.lineCapType ?? 'butt', join: stroke.lineJoinType ?? 'miter',
      miterLimit: Math.max(1, stroke.miterLimit ?? 4), dash: stroke.lineDashSet?.map((value) => unitPixels(value, resolution)),
      dashOffset: unitPixels(stroke.lineDashOffset, resolution), startMarker: 'none', endMarker: 'none', markerSize: 3,
    } : null };
}

function psdVectorMask(source: AgLayer, origin: { x: number; y: number }): VectorMask | null {
  const mask = source.vectorMask;
  if (!mask) return null;
  return { schemaVersion: 1, enabled: mask.disable !== true, inverted: mask.invert === true,
    density: source.mask?.vectorMaskDensity ?? 1, feather: source.mask?.vectorMaskFeather ?? 0,
    paths: psdVectorPaths(mask.paths, origin) };
}

const COLOR_LABELS: ReadonlySet<string> = new Set(['none', 'red', 'orange', 'yellow', 'green', 'blue', 'violet', 'gray']);

function importedColorLabel(source: AgLayer, state: ImportState, layerPath: string): ColorLabel {
  const value: unknown = source.layerColor ?? 'none';
  if (typeof value === 'string' && COLOR_LABELS.has(value)) return value as ColorLabel;
  issue(state, `layer-color:${String(value)}`, `Layer colour label “${String(value)}” is unsupported.`,
    'editability-only', layerPath);
  return 'none';
}

function importedLocks(source: AgLayer): LayerLocks {
  const transparency = source.transparencyProtected === true || source.protected?.transparency === true;
  const pixels = source.protected?.composite === true;
  const position = source.protected?.position === true;
  // PSD stores Lock All as the three protection bits, so the two UI states are indistinguishable on read.
  const all = transparency && pixels && position;
  return { transparency: all ? false : transparency, pixels: all ? false : pixels,
    position: all ? false : position, all };
}

function psdTextColor(value: AgColor | undefined): { red: number; green: number; blue: number; alpha?: number } {
  if (!value) return DEFAULT_TEXT_STYLE.color;
  if ('r' in value) return { red: value.r / 255, green: value.g / 255, blue: value.b / 255,
    ...('a' in value ? { alpha: value.a / 255 } : {}) };
  if ('fr' in value) return { red: value.fr, green: value.fg, blue: value.fb };
  if ('k' in value && !('c' in value)) return { red: 1 - value.k / 100, green: 1 - value.k / 100, blue: 1 - value.k / 100 };
  return DEFAULT_TEXT_STYLE.color;
}

function psdTextRuns(data: LayerTextData, text: string) {
  const runs = data.styleRuns?.length ? data.styleRuns : [{ length: text.length, style: data.style ?? {} }];
  let from = 0;
  return runs.map((run) => {
    const to = Math.min(text.length, from + run.length), style = run.style;
    const result = { from, to, style: { ...DEFAULT_TEXT_STYLE, fontFamily: style.font?.name ?? DEFAULT_TEXT_STYLE.fontFamily,
      fontStyle: style.fauxItalic ? 'italic' as const : 'normal' as const,
      fontWeight: style.fauxBold ? 700 : 400, fontSize: style.fontSize ?? DEFAULT_TEXT_STYLE.fontSize,
      color: psdTextColor(style.fillColor), tracking: style.tracking ?? 0,
      kerning: style.autoKerning === false ? 'none' as const : 'metric' as const,
      leading: style.autoLeading === false && style.leading ? style.leading : null,
      baselineShift: style.baselineShift ?? 0,
      features: { liga: style.ligatures !== false, dlig: style.dLigatures === true }, axes: {} } };
    from = to;
    return result;
  }).filter((run) => run.to > run.from);
}

function psdAlignment(value: string | undefined): 'left' | 'center' | 'right' | 'justify' {
  if (value === 'right') return 'right';
  if (value === 'center') return 'center';
  if (value?.startsWith('justify')) return 'justify';
  return 'left';
}

function psdParagraphs(data: LayerTextData, text: string) {
  const runs = data.paragraphStyleRuns?.length ? data.paragraphStyleRuns
    : [{ length: text.length, style: data.paragraphStyle ?? {} }];
  let from = 0;
  return runs.map((run) => {
    const to = Math.min(text.length, from + run.length), style = run.style, alignment = psdAlignment(style.justification);
    const result = { from, to, style: { ...defaultTextParagraphStyle(alignment), firstLineIndent: style.firstLineIndent ?? 0,
      startIndent: style.startIndent ?? 0, endIndent: style.endIndent ?? 0, spaceBefore: style.spaceBefore ?? 0,
      spaceAfter: style.spaceAfter ?? 0 } };
    from = to;
    return result;
  });
}

function psdTextBox(data: LayerTextData, width: number, height: number): { width: number; height: number } | null {
  if (data.shapeType !== 'box') return null;
  const bounds = data.boxBounds;
  return bounds && bounds.length >= 4 ? { width: Math.max(1, Math.abs(bounds[2]! - bounds[0]!)),
    height: Math.max(1, Math.abs(bounds[3]! - bounds[1]!)) } : { width: Math.max(1, width), height: Math.max(1, height) };
}

function psdTextTransform(data: LayerTextData, fallback: LayerTransform,
  box: { width: number; height: number } | null): LayerTransform {
  const matrix = data.transform;
  if (!matrix || matrix.length !== 6 || !matrix.every(Number.isFinite)) return fallback;
  const [a, b, c, d, tx, ty] = matrix as [number, number, number, number, number, number];
  const localWidth = box?.width ?? Math.max(1, fallback.size.width);
  const localHeight = box?.height ?? Math.max(1, fallback.size.height);
  const scaleX = Math.hypot(a, b), scaleY = Math.hypot(c, d);
  if (!(scaleX > 0) || !(scaleY > 0)) return fallback;
  return makeTransform({ x: tx + (data.left ?? 0) * a + (data.top ?? 0) * c,
    y: ty + (data.left ?? 0) * b + (data.top ?? 0) * d },
  { width: Math.max(1, localWidth * scaleX), height: Math.max(1, localHeight * scaleY) },
  { rotation: Math.atan2(b, a) * 180 / Math.PI, flipX: a < 0, flipY: d < 0, sampling: 'High quality' });
}

function importSiblings(sources: readonly AgLayer[], parentId: string | null, parentPath: string,
  state: ImportState): Layer[] {
  const result: Layer[] = [];
  let clippingBaseId: string | null = null;
  // ag-psd's parsed children are in PSD compositing order (bottom first), matching CanvasDocument.
  for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
    const source = sources[sourceIndex]!;
    const id = `psd-layer-${state.nextId++}`;
    const layerPath = pathName(parentPath, source, sourceIndex);
    const isGroup = source.children !== undefined;
    const left = source.left ?? 0, top = source.top ?? 0;
    const width = Math.max(0, (source.right ?? left) - left), height = Math.max(0, (source.bottom ?? top) - top);
    const image = source.adjustment ? undefined : source.imageData;
    const layerTransform = image ? transform(left, top, image.width, image.height)
      : transform(isGroup ? 0 : left, isGroup ? 0 : top,
        isGroup ? state.documentWidth : width, isGroup ? state.documentHeight : height);
    const sourceMode = source.blendMode ?? (isGroup ? 'pass through' : 'normal');
    const mappedMode = BLEND_MODES.get(sourceMode) ?? 'normal';
    if (!isGroup && !BLEND_MODES.has(sourceMode)) issue(state, `blend-mode:${sourceMode}`,
      `Blend mode “${sourceMode}” is rendered as normal.`, 'not-rendered', layerPath);
    if (isGroup && source.clipping) issue(state, 'group-clipping',
      'A clipped group cannot be represented by the current live-mask graph.', 'not-rendered', layerPath);
    if (source.clipping && !clippingBaseId) issue(state, 'orphan-clipping',
      'Clipping layer has no visible base in its group.', 'not-rendered', layerPath);
    reportLayerFeatures(source, isGroup, state, layerPath);
    const opacity = Math.min(1, Math.max(0, source.opacity ?? 1));
    const fillOpacity = Math.min(1, Math.max(0, source.fillOpacity ?? 1));
    const textData = !isGroup ? source.text : undefined;
    const editableText = textData?.text.replace(/\r/g, '\n') ?? '';
    const textBox = textData ? psdTextBox(textData, width, height) : null;
    const editableTransform = textData ? psdTextTransform(textData, layerTransform, textBox) : layerTransform;
    const vectorContent = !isGroup && !textData && !!(source.vectorFill || source.vectorStroke) && !!source.vectorMask?.paths.length;
    const vectorPaths = vectorContent ? psdVectorPaths(source.vectorMask!.paths, editableTransform.origin) : [];
    const imported = newLayer({
      id, name: source.name ?? `Layer ${sourceIndex + 1}`, parentId, kind: isGroup ? 'group' : textData ? 'text' : vectorContent ? 'vector' : 'pixel',
      visible: source.hidden !== true, opacity, fillOpacity, blendMode: mappedMode,
      locks: importedLocks(source), colorLabel: importedColorLabel(source, state, layerPath), transform: editableTransform,
      raster: image ? Raster.fromPixels(image.width, image.height, 4, pixelDataToRgba8(image)) : null,
      ...(textData ? { text: editableText, runs: psdTextRuns(textData, editableText),
        paragraphs: psdParagraphs(textData, editableText), box: textBox,
        alignment: psdAlignment(textData.paragraphStyle?.justification), renderedTransform: layerTransform } : {}),
      ...(vectorContent ? { paths: vectorPaths, style: psdVectorStyle(source, state.resolution, state, layerPath), sourceShape: null } : {}),
      mask: maskFor(source, editableTransform, state, layerPath),
      vectorMask: vectorContent ? null : psdVectorMask(source, editableTransform.origin),
      maskSourceId: source.clipping && !isGroup ? clippingBaseId : null,
    });
    result.push(imported);
    if (isGroup) {
      clippingBaseId = null;
      result.push(...importSiblings(source.children ?? [], id, layerPath, state));
    } else if (!source.clipping) {
      clippingBaseId = id;
    }
  }
  return result;
}

function resolution(psd: Psd): number {
  const info = psd.imageResources?.resolutionInfo;
  if (!info || !Number.isFinite(info.horizontalResolution) || info.horizontalResolution <= 0) return 72;
  return info.horizontalResolutionUnit === 'PPCM' ? info.horizontalResolution * 2.54 : info.horizontalResolution;
}

/** Parse a PSD/PSB without DOM/canvas and adapt the structures supported by CanvasDocument today. */
export function readPsdDocument(bytes: Uint8Array): PsdReadResult {
  ensureCanvasFreeImageData();
  const parserWarnings: string[] = [];
  const psd = readPsd(bytes, {
    useImageData: true, skipThumbnail: true, skipLinkedFilesData: true, logMissingFeatures: true,
    log: (...values: unknown[]) => parserWarnings.push(values.map(String).join(' ')),
  });
  if (psd.width > MAX_SIDE || psd.height > MAX_SIDE || psd.width * psd.height > MAX_PIXELS) {
    throw new RangeError(`PSD size ${psd.width}×${psd.height} exceeds the document limit`);
  }
  const unsupported: PsdUnsupportedFeature[] = parserWarnings.map((message) => ({
    code: 'ag-psd-parser', message, impact: 'not-rendered',
  }));
  const bitsPerChannel = psd.bitsPerChannel ?? 8, colorMode = psd.colorMode ?? 3;
  if (bitsPerChannel !== 8) unsupported.push({ code: `bit-depth:${bitsPerChannel}`,
    message: `${bitsPerChannel}-bit channels are quantized to RGBA8.`, impact: 'approximated' });
  if (colorMode !== 3) unsupported.push({ code: `color-mode:${colorMode}`,
    message: `PSD color mode ${colorMode} uses ag-psd's conversion to sRGB-like RGBA.`, impact: 'approximated' });
  if (psd.artboards) unsupported.push({ code: 'artboards', message: 'Artboard metadata is not represented.', impact: 'not-rendered' });
  const documentResolution = resolution(psd);
  const state: ImportState = { nextId: 1, documentWidth: psd.width, documentHeight: psd.height, resolution: documentResolution, unsupported };
  const layers = importSiblings(psd.children ?? [], null, '', state);
  if (layers.length > MAX_LAYERS) throw new RangeError(`PSD has ${layers.length} layers; the document limit is ${MAX_LAYERS}`);
  const document: CanvasDocument = {
    id: 'psd-document', width: psd.width, height: psd.height, resolution: documentResolution, layers, selection: null,
  };
  const oracle = psd.imageData
    ? Raster.fromPixels(psd.imageData.width, psd.imageData.height, 4, pixelDataToRgba8(psd.imageData)) : null;
  if (!oracle) unsupported.push({ code: 'composite-image', message: 'PSD has no decodable embedded composite image.',
    impact: 'not-rendered' });
  return { document, oracle, unsupported, parserWarnings,
    source: { width: psd.width, height: psd.height, bitsPerChannel, colorMode, isPsb: bytes[5] === 2 } };
}
