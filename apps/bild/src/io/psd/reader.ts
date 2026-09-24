import {
  initializeCanvas, readPsd, type BlendMode as AgBlendMode, type Layer as AgLayer,
  type BezierPath, type Color as AgColor, type EffectSolidGradient, type LayerEffectsInfo, type LayerTextData, type LinkedFile, type PixelData, type Psd,
  type UnitsValue, type VectorContent,
} from 'ag-psd';
import {
  type BlendMode, type CanvasDocument, type ColorLabel, type FillParameters, type Layer, type LayerAdjustment, type LayerEffect,
  type LayerLocks, type VectorMask, type VectorPath, type VectorStyle,
  DEFAULT_TEXT_STYLE, defaultTextParagraphStyle, MAX_LAYERS, MAX_PIXELS, MAX_SIDE, newLayer,
} from '../../core/document';
import { makeTransform, samePlacement, type LayerTransform } from '../../core/geometry';
import { Raster } from '../../core/raster';
import {
  defaultChannelMixer, defaultColour, defaultCurves, defaultHueSaturation, defaultLevels,
  type RGB,
} from '../../core/adjustments';
import { parseCubeLut } from '../../core/adjust/cube';
import { readRawPsdComposite } from './composite';
import { decodePsdLayerChannels } from './layerChannels';
import type { LittleCms } from '../../wasm/lcms';
import { sha256Hex } from '../sha256';
import { decodePngNativeRGBA } from '../png';

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

function rasterFromPixelData(image: PixelData): Raster {
  if (image.data instanceof Uint16Array) {
    return Raster.fromPixels(image.width, image.height, 4, image.data, { format: 'rgba16' });
  }
  return Raster.fromPixels(image.width, image.height, 4, pixelDataToRgba8(image));
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
  readonly resources: NonNullable<CanvasDocument['resources']>[number][];
  readonly linkedFiles: ReadonlyMap<string, LinkedFile>;
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
  // ag-psd normalizes descriptor locations to 0...1 in parseGradient().
  return { stops: value.colorStops.map((stop) => ({ offset: Math.min(1, Math.max(0, stop.location)),
    color: rgb(stop.color), opacity: opacityAt(stop.location) })) };
}

function importEffects(source: AgLayer, state: ImportState, layerPath: string): readonly LayerEffect[] {
  const info: LayerEffectsInfo | undefined = source.effects;
  if (!info || info.disabled) return [];
  const rendered = (effect: { present?: boolean; enabled?: boolean } | undefined): boolean =>
    !!effect && effect.present !== false && effect.enabled !== false;
  // Effect dimensions are already final pixels. The list-wide Scl metadata is not a render-time
  // multiplier (psd-tools test_second_stroke_traces_the_layer pins 1 px strokes with Scl 208%).
  const result: LayerEffect[] = [];
  for (const shadow of info.dropShadow ?? []) if (shadow.present !== false) result.push({
    kind: 'dropShadow', schemaVersion: 1, enabled: shadow.enabled !== false, opacity: shadow.opacity ?? 1,
    angle: shadow.angle ?? 120, useGlobalLight: shadow.useGlobalLight ?? false, distance: units(shadow.distance),
    blur: units(shadow.size), size: units(shadow.size), spread: units(shadow.choke), color: rgb(shadow.color),
    blendMode: effectBlend(shadow.blendMode, 'multiply'), contour: 'linear', noise: 0, knockout: shadow.layerConceals !== false,
  });
  const glow = info.outerGlow;
  if (glow?.present !== false && glow) result.push({ kind: 'outerGlow', schemaVersion: 1, enabled: glow.enabled !== false,
    opacity: glow.opacity ?? 1, color: rgb(glow.color), blendMode: effectBlend(glow.blendMode, 'screen'),
    spread: units(glow.choke), size: units(glow.size), contour: 'linear', noise: 0 });
  for (const fill of info.solidFill ?? []) if (fill.present !== false) result.push({
    kind: 'colorOverlay', schemaVersion: 1, enabled: fill.enabled !== false, opacity: fill.opacity ?? 1,
    color: rgb(fill.color), blendMode: effectBlend(fill.blendMode, 'normal'),
  });
  for (const overlay of info.gradientOverlay ?? []) if (overlay.present !== false) {
    if (overlay.enabled !== false && (overlay.gradient?.type !== 'solid' || (overlay.type && overlay.type !== 'linear'))) {
      issue(state, 'gradient-overlay', 'A noise or non-linear gradient overlay was approximated as a linear gradient.',
        'approximated', layerPath);
    }
    result.push({ kind: 'gradientOverlay', schemaVersion: 1, enabled: overlay.enabled !== false,
      opacity: overlay.opacity ?? 1, blendMode: effectBlend(overlay.blendMode, 'normal'), angle: overlay.angle ?? 90,
      scale: (overlay.scale ?? 1) * 100, gradient: { ...gradient(overlay.gradient?.type === 'solid' ? overlay.gradient : undefined),
        reverse: overlay.reverse ?? false } });
  }
  for (const stroke of info.stroke ?? []) if (stroke.present !== false) {
    if (stroke.fillType === 'pattern') {
      if (stroke.enabled !== false) issue(state, 'stroke-pattern', 'Pattern stroke is not a live Phase-2 effect.', 'not-rendered', layerPath);
      continue;
    }
    const fill = stroke.fillType === 'gradient'
      ? { kind: 'gradient' as const, gradient: gradient(stroke.gradient?.type === 'solid' ? stroke.gradient : undefined),
        angle: stroke.gradient?.angle ?? 90, scale: (stroke.gradient?.scale ?? 1) * 100 }
      : { kind: 'color' as const, color: rgb(stroke.color) };
    result.push({ kind: 'stroke', schemaVersion: 1, enabled: stroke.enabled !== false, width: units(stroke.size),
      position: stroke.position ?? 'outside', fill, opacity: stroke.opacity ?? 1,
      blendMode: effectBlend(stroke.blendMode, 'normal') });
  }
  if (info.innerShadow?.some(rendered)) issue(state, 'inner-shadow', 'Inner shadow needs a Phase-3 rasterised effect pass.', 'not-rendered', layerPath);
  if (rendered(info.innerGlow)) issue(state, 'inner-glow', 'Inner glow needs a Phase-3 rasterised effect pass.', 'not-rendered', layerPath);
  if (rendered(info.bevel)) issue(state, 'bevel', 'Bevel/emboss needs a rasterised effect pass.', 'not-rendered', layerPath);
  if (rendered(info.satin)) issue(state, 'satin', 'Satin needs a rasterised effect pass.', 'not-rendered', layerPath);
  if (rendered(info.patternOverlay)) issue(state, 'pattern-overlay', 'Pattern overlay needs a rasterised effect pass.', 'not-rendered', layerPath);
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
  if (source.text?.orientation === 'vertical') issue(state, 'vertical-text', 'Vertical PSD text is imported as horizontal text.', 'approximated', layerPath);
  if (source.text?.warp?.style && source.text.warp.style !== 'none') issue(state, 'text-warp', 'Warped PSD text remains editable but its warp is not rendered.', 'not-rendered', layerPath);
  if (source.placedLayer?.filter) issue(state, 'smart-filter',
    'Smart-object filters remain in the PSD preview; their editable parameters are not imported.', 'editability-only', layerPath);
  if (source.realMask) issue(state, 'real-mask', 'The real/vector-derived mask channel is not rendered.', 'not-rendered', layerPath);
  if (source.filterEffectsMasks) issue(state, 'smart-filter', 'Smart filters and their masks are not rendered.', 'not-rendered', layerPath);
  if (source.knockout) issue(state, 'knockout', 'Knockout is rendered from the layer shape; its boundary is inferred from group nesting.',
    'approximated', layerPath);
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
  // Non-pass-through group isolation and group opacity are carried by PSD-specific group metadata below.
}

function placedMedia(file: LinkedFile | undefined): 'image' | 'svg' | 'pdf' | 'project' {
  const name = file?.name ?? file?.linkedFile?.name ?? '';
  if (/\.svg$/i.test(name)) return 'svg';
  if (/\.pdf$/i.test(name)) return 'pdf';
  if (/\.fwimg$/i.test(name)) return 'project';
  return 'image';
}

function placedTransform(source: AgLayer, fallback: LayerTransform): { transform: LayerTransform; warp: import('../../core/model').WarpQuad | null } {
  const values = source.placedLayer?.transform;
  if (!values || values.length < 8 || !values.slice(0, 8).every(Number.isFinite)) return { transform: fallback, warp: null };
  const corners = [0, 1, 2, 3].map((index) => ({ x: values[index * 2]!, y: values[index * 2 + 1]! })) as
    [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }];
  const centre = { x: corners.reduce((sum, value) => sum + value.x, 0) / 4, y: corners.reduce((sum, value) => sum + value.y, 0) / 4 };
  const width = Math.hypot(corners[1].x - corners[0].x, corners[1].y - corners[0].y);
  const height = Math.hypot(corners[3].x - corners[0].x, corners[3].y - corners[0].y);
  if (!(width >= 1 && height >= 1)) return { transform: fallback, warp: null };
  const cross = (corners[1].x - corners[0].x) * (corners[3].y - corners[0].y)
    - (corners[1].y - corners[0].y) * (corners[3].x - corners[0].x);
  const affineX = corners[1].x + corners[3].x - corners[0].x, affineY = corners[1].y + corners[3].y - corners[0].y;
  const nonAffine = Math.hypot(corners[2].x - affineX, corners[2].y - affineY) > 0.01;
  return { transform: makeTransform({ x: centre.x - width / 2, y: centre.y - height / 2 }, { width, height }, {
    rotation: Math.atan2(corners[1].y - corners[0].y, corners[1].x - corners[0].x) * 180 / Math.PI,
    flipY: cross < 0, sampling: 'High quality',
  }), warp: nonAffine ? { kind: 'quad', schemaVersion: 1, corners } : null };
}

function placedContent(source: AgLayer, state: ImportState): import('../../core/model').EmbeddedLayer['content'] | null {
  const placed = source.placedLayer;
  if (!placed) return null;
  const file = state.linkedFiles.get(placed.id) ?? (placed.placed ? state.linkedFiles.get(placed.placed) : undefined);
  const sourceName = file?.name || file?.linkedFile?.name || source.name || 'Placed Content';
  const size = { width: placed.width, height: placed.height };
  if (file?.data?.length) {
    const hash = sha256Hex(file.data), assetId = `embedded-${hash}`;
    if (!state.resources.some((resource) => resource.id === assetId)) state.resources.push({
      id: assetId, role: 'embedded', mime: placedMedia(file) === 'svg' ? 'image/svg+xml'
        : placedMedia(file) === 'pdf' ? 'application/pdf' : 'application/octet-stream', bytes: file.data.slice(),
    });
    return { mode: 'embedded', mediaType: placedMedia(file), assetId, sourceName, sha256: hash,
      ...(size.width ? { width: size.width } : {}), ...(size.height ? { height: size.height } : {}),
      ...(placedMedia(file) === 'pdf' ? { page: Math.max(0, (placed.pageNumber ?? 1) - 1) } : {}) };
  }
  const uri = file?.linkedFile?.fullPath || file?.linkedFile?.originalPath || file?.linkedFile?.relativePath;
  if (!uri) return null;
  return { mode: 'linked', mediaType: placedMedia(file), uri, sourceName,
    ...(size.width ? { width: size.width } : {}), ...(size.height ? { height: size.height } : {}),
    ...(file?.time ? { modifiedAt: Date.parse(file.time) } : {}),
    ...(placedMedia(file) === 'pdf' ? { page: Math.max(0, (placed.pageNumber ?? 1) - 1) } : {}) };
}

function placedRaster(source: AgLayer, state: ImportState): Raster | null {
  const placed = source.placedLayer;
  if (!placed) return null;
  const file = state.linkedFiles.get(placed.id) ?? (placed.placed ? state.linkedFiles.get(placed.placed) : undefined);
  if (!file?.data || file.data.length < 8 || file.data[0] !== 0x89 || file.data[1] !== 0x50) return null;
  try {
    const png = decodePngNativeRGBA(file.data);
    return Raster.fromPixels(png.width, png.height, 4, png.data, { format: png.bitDepth === 16 ? 'rgba16' : 'rgba8',
      source: { bytes: file.data, mime: 'image/png', sha256: sha256Hex(file.data) } });
  } catch { return null; }
}

function rgbColor(value: unknown, fallback: RGB = { red: 1, green: 1, blue: 1 }): RGB {
  if (!value || typeof value !== 'object') return fallback;
  const v = value as Record<string, number>;
  if ([v.fr, v.fg, v.fb].every(Number.isFinite)) return { red: v.fr!, green: v.fg!, blue: v.fb! };
  if ([v.r, v.g, v.b].every(Number.isFinite)) {
    const scale = Math.max(v.r!, v.g!, v.b!) > 1 ? 255 : 1;
    return { red: v.r! / scale, green: v.g! / scale, blue: v.b! / scale };
  }
  if ([v.c, v.m, v.y, v.k].every(Number.isFinite)) {
    const c = v.c! / 100, m = v.m! / 100, y = v.y! / 100, k = v.k! / 100;
    return { red: (1 - c) * (1 - k), green: (1 - m) * (1 - k), blue: (1 - y) * (1 - k) };
  }
  if (Number.isFinite(v.k)) { const gray = 1 - v.k! / 100; return { red: gray, green: gray, blue: gray }; }
  return fallback;
}

function importedAdjustment(source: AgLayer, state: ImportState, layerPath: string): LayerAdjustment | null {
  const adjustment = source.adjustment;
  if (!adjustment) return null;
  switch (adjustment.type) {
    case 'levels': {
      const channels = [adjustment.rgb, adjustment.red, adjustment.green, adjustment.blue];
      const defaults = defaultLevels();
      return { kind: 'Levels', schemaVersion: 1, parameters: { ...defaults, ranges: channels.map((channel, i) => channel ? {
        black: channel.shadowInput, gamma: channel.midtoneInput, white: channel.highlightInput,
        outputBlack: channel.shadowOutput, outputWhite: channel.highlightOutput,
      } : defaults.ranges[i]!) } };
    }
    case 'curves': {
      const defaults = defaultCurves(), channels = [adjustment.rgb, adjustment.red, adjustment.green, adjustment.blue];
      return { kind: 'Curves', schemaVersion: 1, parameters: { ...defaults, channels: channels.map((channel, i) =>
        channel?.length ? channel.map((point) => ({ x: point.input, y: point.output })) : defaults.channels[i]!) } };
    }
    case 'exposure': return { kind: 'Exposure', schemaVersion: 1,
      parameters: { exposure: adjustment.exposure ?? 0, offset: adjustment.offset ?? 0, gamma: adjustment.gamma ?? 1 } };
    case 'hue/saturation': {
      const sourceRanges = [adjustment.master, adjustment.reds, adjustment.yellows, adjustment.greens,
        adjustment.cyans, adjustment.blues, adjustment.magentas];
      const names = ['Master', 'Reds', 'Yellows', 'Greens', 'Cyans', 'Blues', 'Magentas'] as const;
      const master = adjustment.master, colorize = master?.a === 256;
      const masterHue = colorize ? master?.b ?? 0 : master?.hue ?? 0;
      const masterSaturation = colorize ? master?.c ?? 0 : master?.saturation ?? 0;
      const masterLightness = colorize ? master?.d ?? 0 : master?.lightness ?? 0;
      const settings = defaultHueSaturation(masterHue, masterSaturation, masterLightness, colorize);
      const adjustments = { ...settings.adjustments }, bands = { ...settings.bands };
      sourceRanges.forEach((range, index) => { if (!range) return; const name = names[index]!;
        adjustments[name] = { hue: range.hue, saturation: range.saturation, lightness: range.lightness };
        if (name !== 'Master') bands[name] = { falloffStart: range.a, rangeStart: range.b, rangeEnd: range.c, falloffEnd: range.d }; });
      if (colorize) adjustments.Master = { hue: masterHue, saturation: masterSaturation, lightness: masterLightness };
      return { kind: 'Hue/Saturation', schemaVersion: 1, parameters: { hue: masterHue,
        saturation: masterSaturation, lightness: masterLightness, colorize,
        settings: { ...settings, adjustments, bands } } };
    }
    case 'vibrance': return { kind: 'Basic', schemaVersion: 1, parameters: {
      exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0, texture: 0, clarity: 0, dehaze: 0,
      vibrance: adjustment.vibrance ?? 0, saturation: adjustment.saturation ?? 0, temperature: 0, tint: 0 } };
    case 'black & white': {
      const value = defaultColour();
      return { kind: 'Colour', schemaVersion: 1, parameters: { ...value, blackAndWhite: { ...value.blackAndWhite,
        enabled: true, reds: adjustment.reds ?? 40, yellows: adjustment.yellows ?? 60, greens: adjustment.greens ?? 40,
        cyans: adjustment.cyans ?? 60, blues: adjustment.blues ?? 20, magentas: adjustment.magentas ?? 80,
        tint: adjustment.useTint ?? false, tintColor: rgbColor(adjustment.tintColor, value.blackAndWhite.tintColor) } } };
    }
    case 'color balance': {
      const value = defaultColour(), tone = (input: typeof adjustment.shadows) => ({ cyanRed: input?.cyanRed ?? 0,
        magentaGreen: input?.magentaGreen ?? 0, yellowBlue: input?.yellowBlue ?? 0 });
      return { kind: 'Colour', schemaVersion: 1, parameters: { ...value, colourBalance: { enabled: true,
        shadows: tone(adjustment.shadows), midtones: tone(adjustment.midtones), highlights: tone(adjustment.highlights),
        preserveLuminosity: adjustment.preserveLuminosity ?? true } } };
    }
    case 'selective color': {
      const value = defaultColour(), ranges: Record<string, { cyan: number; magenta: number; yellow: number; black: number }> = {};
      const names = [['Reds', adjustment.reds], ['Yellows', adjustment.yellows], ['Greens', adjustment.greens],
        ['Cyans', adjustment.cyans], ['Blues', adjustment.blues], ['Magentas', adjustment.magentas],
        ['Whites', adjustment.whites], ['Neutrals', adjustment.neutrals], ['Blacks', adjustment.blacks]] as const;
      for (const [name, c] of names) if (c) ranges[name] = { cyan: c.c, magenta: c.m, yellow: c.y, black: c.k };
      return { kind: 'Colour', schemaVersion: 1, parameters: { ...value,
        selectiveColour: { mode: adjustment.mode ?? 'relative', ranges } } };
    }
    case 'invert': return { kind: 'Invert', schemaVersion: 1, parameters: {} };
    case 'threshold': return { kind: 'Threshold', schemaVersion: 1, parameters: { level: adjustment.level ?? 128 } };
    case 'posterize': return { kind: 'Posterize', schemaVersion: 1, parameters: { levels: adjustment.levels ?? 4 } };
    case 'brightness/contrast': return { kind: 'Brightness/Contrast', schemaVersion: 1, parameters: {
      brightness: adjustment.brightness ?? 0, contrast: adjustment.contrast ?? 0, legacy: adjustment.useLegacy ?? false } };
    case 'photo filter': return { kind: 'Photo Filter', schemaVersion: 1, parameters: { color: rgbColor(adjustment.color),
      density: adjustment.density ?? 25, preserveLuminosity: adjustment.preserveLuminosity ?? true } };
    case 'channel mixer': {
      const value = defaultChannelMixer(), channel = (input: typeof adjustment.red, fallback: typeof value.red) => input ? {
        red: input.red, green: input.green, blue: input.blue, constant: input.constant } : fallback;
      return { kind: 'Channel Mixer', schemaVersion: 1, parameters: { monochrome: adjustment.monochrome ?? false,
        red: channel(adjustment.red, value.red), green: channel(adjustment.green, value.green),
        blue: channel(adjustment.blue, value.blue), gray: channel(adjustment.gray, value.gray) } };
    }
    case 'color lookup': {
      const bytes = adjustment.lutFormat === 'cube' ? adjustment.lut3DFileData : undefined;
      if (!bytes) break;
      try { parseCubeLut(bytes); } catch { break; }
      const id = `psd-lut-${state.resources.length + 1}`;
      state.resources.push({ id, role: 'lut', mime: 'application/x-cube', bytes: bytes.slice() });
      return { kind: 'Colour Lookup', schemaVersion: 1, parameters: { resourceId: id, interpolation: 'tetrahedral' } };
    }
    case 'gradient map': {
      const stops = adjustment.colorStops?.slice().sort((a, b) => a.location - b.location);
      return { kind: 'Gradient Map', schemaVersion: 1, parameters: { shadows: rgbColor(stops?.[0]?.color, { red: 0, green: 0, blue: 0 }),
        highlights: rgbColor(stops?.at(-1)?.color), reversed: adjustment.reverse ?? false } };
    }
  }
  issue(state, `adjustment:${adjustment.type}`, `Adjustment layer “${adjustment.type}” could not be mapped losslessly.`, 'not-rendered', layerPath);
  return null;
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
    const adjustment = importedAdjustment(source, state, layerPath);
    const image = source.adjustment ? undefined : source.imageData;
    const adjustmentMask = adjustment && source.mask?.imageData ? source.mask : null;
    const layerTransform = image ? transform(left, top, image.width, image.height)
      : adjustmentMask ? transform(adjustmentMask.left ?? 0, adjustmentMask.top ?? 0,
        adjustmentMask.imageData!.width, adjustmentMask.imageData!.height)
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
    const placed = !isGroup ? placedContent(source, state) : null;
    const placedPixels = placed ? placedRaster(source, state) : null;
    // When ag-psd exposes only Photoshop's already-transformed cache, keep its pixel placement until the source
    // runtime resolves. Decodable embedded PNGs use their true original grid and the PlLd/SoLd transform directly.
    const placement = placed && placedPixels ? placedTransform(source, layerTransform) : { transform: editableTransform, warp: null };
    let imported: Layer = newLayer({
      id, name: source.name ?? `Layer ${sourceIndex + 1}`, parentId, kind: isGroup ? 'group' : placed ? 'embedded' : textData ? 'text' : vectorContent ? 'vector' : adjustment ? 'adjustment' : 'pixel',
      visible: source.hidden !== true, opacity, fillOpacity, blendMode: mappedMode,
      locks: importedLocks(source), colorLabel: importedColorLabel(source, state, layerPath), transform: placement.transform,
      warp: placement.warp,
      raster: placedPixels ?? (image ? rasterFromPixelData(image) : null),
      ...(placed ? { content: placed } : {}),
      ...(textData ? { text: editableText, runs: psdTextRuns(textData, editableText),
        paragraphs: psdParagraphs(textData, editableText), box: textBox,
        alignment: psdAlignment(textData.paragraphStyle?.justification), renderedTransform: layerTransform } : {}),
      ...(vectorContent ? { paths: vectorPaths, style: psdVectorStyle(source, state.resolution, state, layerPath), sourceShape: null } : {}),
      mask: maskFor(source, placement.transform, state, layerPath),
      vectorMask: vectorContent ? null : psdVectorMask(source, editableTransform.origin),
      maskSourceId: source.clipping && !isGroup ? clippingBaseId : null,
      effects: importEffects(source, state, layerPath),
      ...(adjustment ? { adjustment } : {}),
    });
    if (isGroup) imported = { ...imported,
      psdIsolated: sourceMode !== 'pass through', psdKnockout: source.knockout === true } as Layer
        & { readonly psdIsolated: boolean; readonly psdKnockout: boolean };
    if (source.mask) imported = { ...imported, psdMaskDefault: source.mask.defaultColor ?? 0 } as Layer
      & { readonly psdMaskDefault: number };
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

function parserWarningImpact(message: string): PsdUnsupportedImpact {
  // psd-tools writes these generator/content-authentication records on otherwise pixel-identical files.
  // ag-psd also reports descriptor padding as unread bytes; neither participates in compositing.
  if (/^Unhandled additional info: (?:CAI  |GenI)$/.test(message)
    || /^Unread (?:2|4) bytes left for additional info: (?:vstk|PtFl|artb|brst)$/.test(message)) {
    return 'editability-only';
  }
  return 'not-rendered';
}

function rawCompositeFallback(bytes: Uint8Array, parserError: unknown, rasterOverride: Raster | null = null): PsdReadResult {
  const raw = readRawPsdComposite(bytes);
  const raster = rasterOverride ?? Raster.fromPixels(raw.width, raw.height, 4, raw.rgba);
  const message = parserError instanceof Error ? parserError.message : String(parserError);
  const unsupported: PsdUnsupportedFeature[] = [{
    code: 'ag-psd-parser', message, impact: 'editability-only',
  }, {
    code: `color-mode:${raw.colorMode}`,
    message: `PSD color mode ${raw.colorMode} was opened from its saved composite preview; layers are not editable.`,
    impact: 'editability-only',
  }, {
    code: 'flattened-composite',
    message: 'This PSD was opened flattened from its saved composite because its layer data could not be decoded.',
    impact: 'editability-only',
  }];
  if (raw.bitsPerChannel !== 8) unsupported.push({
    code: `bit-depth:${raw.bitsPerChannel}`,
    message: `${raw.bitsPerChannel}-bit composite channels are tone-mapped to RGBA8.`, impact: 'approximated',
  });
  if (raw.iccProfile) unsupported.push({
    code: 'embedded-icc', message: 'An embedded profile was detected, but this synchronous compatibility preview uses its deterministic colour-mode conversion.',
    impact: 'approximated',
  });
  const document: CanvasDocument = {
    id: 'psd-document', width: raw.width, height: raw.height, resolution: 72, selection: null,
    layers: [newLayer({ id: 'psd-layer-1', name: 'Photoshop composite (flattened)', kind: 'pixel',
      transform: transform(0, 0, raw.width, raw.height), raster })], resources: [],
  };
  return { document, oracle: raster, unsupported, parserWarnings: [message],
    source: { width: raw.width, height: raw.height, bitsPerChannel: raw.bitsPerChannel,
      colorMode: raw.colorMode, isPsb: raw.isPsb } };
}

function sourceColorMode(bytes: Uint8Array): number {
  if (bytes.length < 26 || String.fromCharCode(...bytes.subarray(0, 4)) !== '8BPS') throw new Error('Invalid PSD signature');
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(24);
}

function colorManagedComposite(raw: ReturnType<typeof readRawPsdComposite>, lcms: LittleCms | null): Raster {
  if (lcms && raw.managedSamples && (raw.bitsPerChannel === 8 || raw.bitsPerChannel === 16)
    && (raw.colorMode === 1 || raw.colorMode === 4)) {
    const model = raw.colorMode === 4 ? 'cmyk' as const : 'gray' as const;
    const profile = raw.iccProfile ?? (model === 'cmyk' ? lcms.createCmykProfile()
      : lcms.createGrayProfile([0.3127, 0.329], 2.2));
    return Raster.fromPixels(raw.width, raw.height, 4,
      lcms.transform(profile, raw.managedSamples, model, raw.bitsPerChannel, raw.managedAlpha));
  }
  return Raster.fromPixels(raw.width, raw.height, 4, raw.rgba);
}

function readRawLayerPsd(bytes: Uint8Array, raw: ReturnType<typeof readRawPsdComposite>,
  lcms: LittleCms | null, parserWarnings: string[]): Psd {
  // ag-psd rejects CMYK/Lab/duotone/multichannel before reading layer records. RGB here only bypasses that gate;
  // decodePsdLayerChannels interprets every raw layer plane using the untouched original mode below.
  const parseBytes = [4, 7, 8, 9].includes(raw.colorMode) ? bytes.slice() : bytes;
  if (parseBytes !== bytes) { parseBytes[24] = 0; parseBytes[25] = 3; }
  const psd = readPsd(parseBytes, {
    useRawData: true, skipCompositeImageData: true, skipThumbnail: true, skipLinkedFilesData: false,
    logMissingFeatures: true, log: (...values: unknown[]) => parserWarnings.push(values.map(String).join(' ')),
  });
  const context = { colorMode: raw.colorMode, bitsPerChannel: raw.bitsPerChannel, isPsb: raw.isPsb,
    palette: raw.palette, iccProfile: raw.iccProfile, lcms };
  for (const layer of psd.children ?? []) decodePsdLayerChannels(layer, context);
  psd.colorMode = raw.colorMode;
  return psd;
}

function readPsdDocumentInternal(bytes: Uint8Array, lcms: LittleCms | null): PsdReadResult {
  ensureCanvasFreeImageData();
  const parserWarnings: string[] = [];
  let psd: Psd;
  let oracleOverride: Raster | null = null;
  const originalMode = sourceColorMode(bytes);
  try {
    if ([4, 7, 8, 9].includes(originalMode) || (originalMode === 1 && lcms)) {
      const raw = readRawPsdComposite(bytes);
      psd = readRawLayerPsd(bytes, raw, lcms, parserWarnings);
      oracleOverride = colorManagedComposite(raw, lcms);
    } else {
      psd = readPsd(bytes, {
        useImageData: true, skipThumbnail: true, skipLinkedFilesData: false, logMissingFeatures: true,
        log: (...values: unknown[]) => parserWarnings.push(values.map(String).join(' ')),
      });
    }
  } catch (error) {
    return rawCompositeFallback(bytes, error);
  }
  if (oracleOverride && !(psd.children?.length)) {
    return rawCompositeFallback(bytes, new Error('PSD has no decodable layer records'), oracleOverride);
  }
  if (psd.width > MAX_SIDE || psd.height > MAX_SIDE || psd.width * psd.height > MAX_PIXELS) {
    throw new RangeError(`PSD size ${psd.width}×${psd.height} exceeds the document limit`);
  }
  const unsupported: PsdUnsupportedFeature[] = parserWarnings.map((message) => ({
    code: 'ag-psd-parser', message, impact: parserWarningImpact(message),
  }));
  const bitsPerChannel = psd.bitsPerChannel ?? 8, colorMode = psd.colorMode ?? 3;
  if (bitsPerChannel !== 8) unsupported.push({ code: `bit-depth:${bitsPerChannel}`,
    message: bitsPerChannel === 16 ? '16-bit RGB layer channels are retained as RGBA16; colour-managed modes currently have 8-bit CMS output.'
      : '32-bit floating channels use a bounded display conversion.', impact: 'approximated' });
  if (colorMode !== 3) unsupported.push({ code: `color-mode:${colorMode}`,
    message: `PSD color mode ${colorMode} layer channels were converted independently to sRGB.`,
    impact: colorMode === 1 || colorMode === 4 ? 'editability-only' : 'approximated' });
  if (oracleOverride && colorMode === 4 && !lcms) unsupported.push({ code: 'embedded-icc',
    message: 'The synchronous CMYK path uses a deterministic fallback; product open applies Little CMS.', impact: 'approximated' });
  if (psd.artboards) unsupported.push({ code: 'artboards', message: 'Artboard metadata is not represented.', impact: 'not-rendered' });
  const documentResolution = resolution(psd);
  const state: ImportState = { nextId: 1, documentWidth: psd.width, documentHeight: psd.height, resolution: documentResolution,
    unsupported, resources: [], linkedFiles: new Map((psd.linkedFiles ?? []).map((file) => [file.id, file])) };
  const layers = importSiblings(psd.children ?? [], null, '', state);
  if (layers.length > MAX_LAYERS) throw new RangeError(`PSD has ${layers.length} layers; the document limit is ${MAX_LAYERS}`);
  const oracle = oracleOverride ?? (psd.imageData ? rasterFromPixelData(psd.imageData) : null);
  if (!oracle) unsupported.push({ code: 'composite-image', message: 'PSD has no decodable embedded composite image.',
    impact: 'not-rendered' });
  let documentLayers = layers;
  if (oracle && unsupported.some((feature) => feature.impact === 'not-rendered')) {
    // The editable layers stay visible: they are the document. Photoshop's saved composite is added on top as a hidden,
    // locked reference the user can show to compare, never as a cover over layers that would then seem not to react.
    documentLayers = [...layers, newLayer({
      id: `psd-layer-${state.nextId++}`, name: 'Photoshop appearance (reference)', kind: 'pixel', visible: false,
      locks: { transparency: false, pixels: true, position: true, all: true },
      transform: transform(0, 0, psd.width, psd.height), raster: oracle,
    })];
    unsupported.push({
      code: 'compatibility-preview',
      message: 'Some PSD features are not rendered natively; a hidden “Photoshop appearance” reference layer shows the saved result.',
      impact: 'editability-only',
    });
  }
  const document: CanvasDocument = {
    id: 'psd-document', width: psd.width, height: psd.height, resolution: resolution(psd),
    globalLightAngle: psd.imageResources?.globalAngle ?? 120, layers: documentLayers, resources: state.resources, selection: null,
  };
  return { document, oracle, unsupported, parserWarnings,
    source: { width: psd.width, height: psd.height, bitsPerChannel, colorMode, isPsb: bytes[5] === 2 } };
}

/** Parse a PSD/PSB synchronously without DOM/canvas. Product open should prefer readPsdDocumentManaged. */
export function readPsdDocument(bytes: Uint8Array): PsdReadResult {
  return readPsdDocumentInternal(bytes, null);
}

/** Product open path: apply embedded/default gray or CMYK profiles independently to every decoded layer. */
export async function readPsdDocumentManaged(bytes: Uint8Array): Promise<PsdReadResult> {
  const mode = sourceColorMode(bytes);
  if (mode !== 1 && mode !== 4) return readPsdDocumentInternal(bytes, null);
  const { loadLittleCms } = await import('../../wasm/lcms');
  return readPsdDocumentInternal(bytes, await loadLittleCms());
}
