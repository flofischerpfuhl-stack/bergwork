import {
  initializeCanvas, readPsd, type BlendMode as AgBlendMode, type Layer as AgLayer,
  type Color as AgColor, type EffectSolidGradient, type LayerEffectsInfo, type PixelData, type Psd, type UnitsValue,
} from 'ag-psd';
import {
  type BlendMode, type CanvasDocument, type ColorLabel, type Layer, type LayerEffect, type LayerLocks,
  MAX_LAYERS, MAX_PIXELS, MAX_SIDE, newLayer,
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
  readonly unsupported: PsdUnsupportedFeature[];
}

function issue(state: ImportState, code: string, message: string, impact: PsdUnsupportedImpact, layerPath?: string): void {
  state.unsupported.push({ code, message, impact, ...(layerPath ? { layerPath } : {}) });
}

function units(value: UnitsValue | undefined, fallback = 0): number {
  return value && Number.isFinite(value.value) ? value.value : fallback;
}

function rgb(color: AgColor | undefined, fallback = { red: 0, green: 0, blue: 0 }): { red: number; green: number; blue: number } {
  if (!color) return fallback;
  if ('r' in color) return { red: color.r / 255, green: color.g / 255, blue: color.b / 255 };
  if ('fr' in color) return { red: color.fr, green: color.fg, blue: color.fb };
  if ('k' in color && !('c' in color)) return { red: 1 - color.k / 100, green: 1 - color.k / 100, blue: 1 - color.k / 100 };
  if ('c' in color) return { red: (1 - color.c / 100) * (1 - color.k / 100),
    green: (1 - color.m / 100) * (1 - color.k / 100), blue: (1 - color.y / 100) * (1 - color.k / 100) };
  return fallback;
}

function effectBlend(mode: string | undefined, fallback: BlendMode): BlendMode {
  return BLEND_MODES.get(mode as AgBlendMode) ?? fallback;
}

function gradient(value: EffectSolidGradient | undefined): import('../../core/model').EffectGradient {
  if (!value || value.type !== 'solid' || value.colorStops.length < 2) return { stops: [
    { offset: 0, color: { red: 0, green: 0, blue: 0 }, opacity: 1 },
    { offset: 1, color: { red: 1, green: 1, blue: 1 }, opacity: 1 },
  ] };
  const opacityAt = (location: number): number => {
    const stops = value.opacityStops.length ? value.opacityStops : [{ location: 0, opacity: 1, midpoint: 0.5 }];
    let left = stops[0]!, right = stops[stops.length - 1]!;
    for (let i = 1; i < stops.length; i++) if (location <= stops[i]!.location) { left = stops[i - 1]!; right = stops[i]!; break; }
    const amount = right.location === left.location ? 0 : (location - left.location) / (right.location - left.location);
    return left.opacity + (right.opacity - left.opacity) * Math.min(1, Math.max(0, amount));
  };
  return { stops: value.colorStops.map((stop) => ({ offset: Math.min(1, Math.max(0, stop.location / 4096)),
    color: rgb(stop.color), opacity: opacityAt(stop.location) })) };
}

function importEffects(source: AgLayer, state: ImportState, layerPath: string): readonly LayerEffect[] {
  const info: LayerEffectsInfo | undefined = source.effects;
  if (!info || info.disabled) return [];
  const scale = (info.scale ?? 100) / 100, result: LayerEffect[] = [];
  for (const shadow of info.dropShadow ?? []) if (shadow.present !== false) result.push({
    kind: 'dropShadow', schemaVersion: 1, enabled: shadow.enabled !== false, opacity: shadow.opacity ?? 1,
    angle: shadow.angle ?? 120, useGlobalLight: shadow.useGlobalLight ?? false, distance: units(shadow.distance) * scale,
    blur: units(shadow.size) * scale, size: units(shadow.size) * scale, spread: units(shadow.choke), color: rgb(shadow.color),
    blendMode: effectBlend(shadow.blendMode, 'multiply'), contour: 'linear', noise: 0, knockout: shadow.layerConceals !== false,
  });
  const glow = info.outerGlow;
  if (glow?.present !== false && glow) result.push({ kind: 'outerGlow', schemaVersion: 1, enabled: glow.enabled !== false,
    opacity: glow.opacity ?? 1, color: rgb(glow.color), blendMode: effectBlend(glow.blendMode, 'screen'),
    spread: units(glow.choke), size: units(glow.size) * scale, contour: 'linear', noise: 0 });
  for (const fill of info.solidFill ?? []) if (fill.present !== false) result.push({
    kind: 'colorOverlay', schemaVersion: 1, enabled: fill.enabled !== false, opacity: fill.opacity ?? 1,
    color: rgb(fill.color), blendMode: effectBlend(fill.blendMode, 'normal'),
  });
  for (const overlay of info.gradientOverlay ?? []) if (overlay.present !== false) {
    if (overlay.gradient?.type !== 'solid' || (overlay.type && overlay.type !== 'linear')) {
      issue(state, 'gradient-overlay', 'A noise or non-linear gradient overlay was approximated as a linear gradient.',
        'approximated', layerPath);
    }
    result.push({ kind: 'gradientOverlay', schemaVersion: 1, enabled: overlay.enabled !== false,
      opacity: overlay.opacity ?? 1, blendMode: effectBlend(overlay.blendMode, 'normal'), angle: overlay.angle ?? 90,
      scale: overlay.scale ?? 100, gradient: { ...gradient(overlay.gradient?.type === 'solid' ? overlay.gradient : undefined),
        reverse: overlay.reverse ?? false } });
  }
  for (const stroke of info.stroke ?? []) if (stroke.present !== false) {
    if (stroke.fillType === 'pattern') {
      issue(state, 'stroke-pattern', 'Pattern stroke is not a live Phase-2 effect.', 'not-rendered', layerPath); continue;
    }
    const fill = stroke.fillType === 'gradient'
      ? { kind: 'gradient' as const, gradient: gradient(stroke.gradient?.type === 'solid' ? stroke.gradient : undefined),
        angle: stroke.gradient?.angle ?? 90, scale: stroke.gradient?.scale ?? 100 }
      : { kind: 'color' as const, color: rgb(stroke.color) };
    result.push({ kind: 'stroke', schemaVersion: 1, enabled: stroke.enabled !== false, width: units(stroke.size) * scale,
      position: stroke.position ?? 'outside', fill, opacity: stroke.opacity ?? 1,
      blendMode: effectBlend(stroke.blendMode, 'normal') });
  }
  if (info.innerShadow?.length) issue(state, 'inner-shadow', 'Inner shadow needs a Phase-3 rasterised effect pass.', 'not-rendered', layerPath);
  if (info.innerGlow) issue(state, 'inner-glow', 'Inner glow needs a Phase-3 rasterised effect pass.', 'not-rendered', layerPath);
  if (info.bevel) issue(state, 'bevel', 'Bevel/emboss needs a rasterised effect pass.', 'not-rendered', layerPath);
  if (info.satin) issue(state, 'satin', 'Satin needs a rasterised effect pass.', 'not-rendered', layerPath);
  if (info.patternOverlay) issue(state, 'pattern-overlay', 'Pattern overlay needs a rasterised effect pass.', 'not-rendered', layerPath);
  return result;
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
  if (source.vectorMask) issue(state, 'vector-mask', source.imageData
    ? 'Vector mask uses the layer pixel cache and is not editable.' : 'Vector mask is parsed but not rendered.',
    source.imageData ? 'editability-only' : 'not-rendered', layerPath);
  if (source.text) issue(state, 'text', 'Text uses its saved pixel cache and is not editable.', 'editability-only', layerPath);
  if (source.vectorFill || source.vectorStroke) issue(state, 'vector-content',
    'Vector content uses its saved pixel cache and is not editable.', 'editability-only', layerPath);
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
    const imported = newLayer({
      id, name: source.name ?? `Layer ${sourceIndex + 1}`, parentId, kind: isGroup ? 'group' : 'pixel',
      visible: source.hidden !== true, opacity, fillOpacity, blendMode: mappedMode,
      locks: importedLocks(source), colorLabel: importedColorLabel(source, state, layerPath), transform: layerTransform,
      raster: image ? Raster.fromPixels(image.width, image.height, 4, pixelDataToRgba8(image)) : null,
      mask: maskFor(source, layerTransform, state, layerPath),
      maskSourceId: source.clipping && !isGroup ? clippingBaseId : null,
      effects: importEffects(source, state, layerPath),
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
  const state: ImportState = { nextId: 1, documentWidth: psd.width, documentHeight: psd.height, unsupported };
  const layers = importSiblings(psd.children ?? [], null, '', state);
  if (layers.length > MAX_LAYERS) throw new RangeError(`PSD has ${layers.length} layers; the document limit is ${MAX_LAYERS}`);
  const document: CanvasDocument = {
    id: 'psd-document', width: psd.width, height: psd.height, resolution: resolution(psd),
    globalLightAngle: psd.imageResources?.globalAngle ?? 120, layers, selection: null,
  };
  const oracle = psd.imageData
    ? Raster.fromPixels(psd.imageData.width, psd.imageData.height, 4, pixelDataToRgba8(psd.imageData)) : null;
  if (!oracle) unsupported.push({ code: 'composite-image', message: 'PSD has no decodable embedded composite image.',
    impact: 'not-rendered' });
  return { document, oracle, unsupported, parserWarnings,
    source: { width: psd.width, height: psd.height, bitsPerChannel, colorMode, isPsb: bytes[5] === 2 } };
}
