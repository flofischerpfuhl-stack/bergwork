import {
  initializeCanvas, readPsd, type BlendMode as AgBlendMode, type Layer as AgLayer,
  type BezierPath, type Color as AgColor, type EffectSolidGradient, type LayerEffectsInfo, type LayerTextData, type LinkedFile, type PixelData, type Psd,
  type LayerMaskData, type PatternInfo, type UnitsValue, type VectorContent,
} from 'ag-psd';
import {
  type BlendMode, type CanvasDocument, type ColorLabel, type FillParameters, type Layer, type LayerAdjustment, type LayerEffect,
  type LayerLocks, type VectorMask, type VectorPath, type VectorStyle,
  DEFAULT_TEXT_STYLE, defaultTextParagraphStyle, MAX_LAYERS, MAX_PIXELS, MAX_SIDE, newLayer,
} from '../../core/document';
import { apply, makeTransform, samePlacement, unitToDocument, type LayerTransform } from '../../core/geometry';
import { MAX_MESH_SPLITS, meshPreset } from '../../core/meshWarp';
import { Raster } from '../../core/raster';
import {
  defaultChannelMixer, defaultColour, defaultCurves, defaultHueSaturation, defaultLevels,
  type RGB,
} from '../../core/adjustments';
import { parseCubeLut } from '../../core/adjust/cube';
import { psdHasMergedTransparency, readRawPsdComposite } from './composite';
import { decodePsdLayerChannels } from './layerChannels';
import { readPsdCmykAdjustmentChannels, readPsdLayerKnockouts,
  type PsdCmykAdjustmentChannels, type PsdKnockoutMode } from './layerInfo';
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
  readonly bitsPerChannel: number;
  readonly colorMode: number;
  readonly artboards: boolean;
  readonly resolution: number;
  readonly unsupported: PsdUnsupportedFeature[];
  readonly resources: NonNullable<CanvasDocument['resources']>[number][];
  readonly linkedFiles: ReadonlyMap<string, LinkedFile>;
  readonly patterns: ReadonlyMap<string, PatternInfo>;
  readonly grayTransfer: Float32Array | null;
  readonly cmykTransfer: { readonly inverseSize: number; readonly inverse: Uint8Array;
    readonly forwardSize: number; readonly forward: Uint8Array } | null;
  readonly knockoutModes: ReadonlyMap<number, PsdKnockoutMode>;
  readonly cmykAdjustmentChannels: ReadonlyMap<number, PsdCmykAdjustmentChannels>;
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
  // Effect dimensions are already final pixels. The list-wide Scl metadata is not a render-time
  // multiplier (psd-tools test_second_stroke_traces_the_layer pins 1 px strokes with Scl 208%).
  const result: LayerEffect[] = [];
  for (const shadow of info.dropShadow ?? []) if (shadow.present !== false) result.push({
    kind: 'dropShadow', schemaVersion: 1, enabled: shadow.enabled !== false, opacity: shadow.opacity ?? 1,
    angle: shadow.angle ?? 120, useGlobalLight: shadow.useGlobalLight ?? false, distance: units(shadow.distance),
    blur: units(shadow.size), size: units(shadow.size), spread: units(shadow.choke), color: rgb(shadow.color),
    blendMode: effectBlend(shadow.blendMode, 'multiply'), contour: 'linear', noise: 0, knockout: shadow.layerConceals !== false,
  });
  for (const shadow of info.innerShadow ?? []) if (shadow.present !== false) result.push({
    kind: 'innerShadow', schemaVersion: 1, enabled: shadow.enabled !== false, opacity: shadow.opacity ?? 1,
    blendMode: effectBlend(shadow.blendMode, 'multiply'), color: rgb(shadow.color), angle: shadow.angle ?? 120,
    useGlobalLight: shadow.useGlobalLight ?? false, distance: units(shadow.distance), choke: units(shadow.choke),
    size: units(shadow.size), contour: 'linear',
  });
  const glow = info.outerGlow;
  if (glow?.present !== false && glow) result.push({ kind: 'outerGlow', schemaVersion: 1, enabled: glow.enabled !== false,
    opacity: glow.opacity ?? 1, color: rgb(glow.color), blendMode: effectBlend(glow.blendMode, 'screen'),
    spread: units(glow.choke), size: units(glow.size), contour: 'linear', noise: 0 });
  const innerGlow = info.innerGlow;
  if (innerGlow?.present !== false && innerGlow) result.push({ kind: 'innerGlow', schemaVersion: 1,
    enabled: innerGlow.enabled !== false, opacity: innerGlow.opacity ?? 1, color: rgb(innerGlow.color),
    blendMode: effectBlend(innerGlow.blendMode, 'screen'), source: innerGlow.source ?? 'edge',
    choke: units(innerGlow.choke), size: units(innerGlow.size), contour: 'linear' });
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
      const pattern = stroke.pattern?.id ? state.patterns.get(stroke.pattern.id) : undefined;
      if (!pattern || pattern.data.length !== pattern.bounds.w * pattern.bounds.h * 4) {
        if (stroke.enabled !== false) issue(state, 'stroke-pattern', 'Pattern stroke pixels are absent from the PSD pattern table.', 'not-rendered', layerPath);
      } else result.push({ kind: 'stroke', schemaVersion: 1, enabled: stroke.enabled !== false,
        width: units(stroke.size), position: stroke.position ?? 'outside',
        fill: { kind: 'color', color: { red: 0, green: 0, blue: 0 } }, opacity: stroke.opacity ?? 1,
        blendMode: effectBlend(stroke.blendMode, 'normal'), psdPattern: { data: pattern.data.slice(),
          width: pattern.bounds.w, height: pattern.bounds.h, x: pattern.bounds.x, y: pattern.bounds.y,
          id: pattern.id, name: pattern.name,
          linked: (stroke.pattern as typeof stroke.pattern & { readonly linked?: boolean } | undefined)?.linked !== false } } as LayerEffect & { readonly psdPattern: {
            readonly data: Uint8Array; readonly width: number; readonly height: number;
            readonly x: number; readonly y: number; readonly id: string; readonly name: string; readonly linked: boolean } });
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
  const bevel = info.bevel;
  if (bevel?.present !== false && bevel) {
    const style = bevel.style === 'outer bevel' ? 'outerBevel' : bevel.style === 'emboss' ? 'emboss'
      : bevel.style === 'pillow emboss' ? 'pillowEmboss' : 'innerBevel';
    const technique = bevel.technique === 'chisel hard' ? 'chiselHard'
      : bevel.technique === 'chisel soft' ? 'chiselSoft' : 'smooth';
    const strength = bevel.strength ?? 1;
    result.push({ kind: 'bevelEmboss', schemaVersion: 1, enabled: bevel.enabled !== false, style, technique,
      depth: Math.max(1, strength <= 10 ? strength * 100 : strength), direction: bevel.direction ?? 'up',
      size: units(bevel.size), soften: units(bevel.soften), angle: bevel.angle ?? 120, altitude: bevel.altitude ?? 30,
      useGlobalLight: bevel.useGlobalLight ?? false, highlightMode: effectBlend(bevel.highlightBlendMode, 'screen'),
      highlightColor: rgb(bevel.highlightColor, { red: 1, green: 1, blue: 1 }), highlightOpacity: bevel.highlightOpacity ?? 0.75,
      shadowMode: effectBlend(bevel.shadowBlendMode, 'multiply'), shadowColor: rgb(bevel.shadowColor),
      shadowOpacity: bevel.shadowOpacity ?? 0.75, glossContour: 'linear' });
  }
  const satin = info.satin;
  if (satin?.present !== false && satin) result.push({ kind: 'satin', schemaVersion: 1, enabled: satin.enabled !== false,
    opacity: satin.opacity ?? 0.5, blendMode: effectBlend(satin.blendMode, 'multiply'), color: rgb(satin.color),
    angle: satin.angle ?? 19, distance: units(satin.distance), size: units(satin.size), invert: satin.invert ?? true,
    contour: 'linear' });
  const overlay = info.patternOverlay;
  if (overlay && overlay.present !== false) {
  const pattern = overlay.pattern?.id ? state.patterns.get(overlay.pattern.id) : undefined;
  if (!pattern || pattern.data.length !== pattern.bounds.w * pattern.bounds.h * 4) {
      if (overlay.enabled !== false) issue(state, 'pattern-overlay', 'Pattern overlay pixels are absent from the PSD pattern table.', 'not-rendered', layerPath);
    } else {
      const resourceId = `psd-pattern-${sha256Hex(pattern.data)}`;
      if (!state.resources.some((resource) => resource.id === resourceId)) state.resources.push({
        id: resourceId, role: 'pattern', mime: 'application/x-fernwork-rgba8', bytes: pattern.data.slice(),
      });
      result.push({ kind: 'patternOverlay', schemaVersion: 1, enabled: overlay.enabled !== false,
        opacity: overlay.opacity ?? 1, blendMode: effectBlend(overlay.blendMode, 'normal'), resourceId,
        patternWidth: pattern.bounds.w, patternHeight: pattern.bounds.h, scale: Math.max(1, (overlay.scale ?? 1) * 100),
        angle: (overlay as typeof overlay & { angle?: number }).angle ?? 0,
        linkWithLayer: overlay.align !== false, phase: overlay.phase ?? { x: 0, y: 0 } });
    }
  }
  const rank: Record<LayerEffect['kind'], number> = { dropShadow: 0, outerGlow: 1, colorOverlay: 2,
    gradientOverlay: 3, patternOverlay: 4, satin: 5, innerGlow: 6, innerShadow: 7, stroke: 8, bevelEmboss: 9 };
  return result.sort((a, b) => rank[a.kind] - rank[b.kind]);
}

function featherMask(source: Uint8Array, width: number, height: number, sigma: number,
  outside: number): Uint8Array {
  if (!(sigma > 0)) return source;
  const radius = Math.ceil(sigma * 3);
  const kernel = new Float64Array(radius * 2 + 1);
  let kernelTotal = 0;
  for (let offset = -radius; offset <= radius; offset++) {
    const weight = Math.exp(-(offset * offset) / (2 * sigma * sigma));
    kernel[offset + radius] = weight;
    kernelTotal += weight;
  }
  for (let index = 0; index < kernel.length; index++) kernel[index] = kernel[index]! / kernelTotal;
  const horizontal = new Float64Array(source.length);
  const output = new Uint8Array(source.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let total = 0;
    for (let offset = -radius; offset <= radius; offset++) {
      const sampleX = x + offset;
      total += (sampleX < 0 || sampleX >= width ? outside : source[y * width + sampleX]!)
        * kernel[offset + radius]!;
    }
    horizontal[y * width + x] = total;
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let total = 0;
    for (let offset = -radius; offset <= radius; offset++) {
      const sampleY = y + offset;
      total += (sampleY < 0 || sampleY >= height ? outside : horizontal[sampleY * width + x]!)
        * kernel[offset + radius]!;
    }
    output[y * width + x] = Math.round(total);
  }
  return output;
}

interface ImportedPsdMask {
  readonly raster: Raster;
  readonly enabled: boolean;
  readonly placement: LayerTransform | null;
  readonly linked: boolean;
  readonly defaultColor: number;
}

function decodedMask(mask: LayerMaskData | undefined, parameters: LayerMaskData | undefined,
  layerTransform: LayerTransform, state: ImportState, layerPath: string): ImportedPsdMask | null {
  if (!mask) return null;
  const vectorParameters = mask.fromVectorData === true;
  const density = (vectorParameters ? parameters?.vectorMaskDensity : parameters?.userMaskDensity) ?? 1;
  const rawDefaultColor = mask.defaultColor ?? 0;
  // Mask density weakens the whole mask, including the value beyond its stored rectangle.
  // Applying it only to channel pixels leaves positioned masks fully hiding outside their cache.
  const defaultColor = Math.round(255 - (255 - rawDefaultColor) * density);
  if (!mask.imageData) {
    const width = Math.max(0, (mask.right ?? 0) - (mask.left ?? 0));
    const height = Math.max(0, (mask.bottom ?? 0) - (mask.top ?? 0));
    if (!width || !height) {
      if (mask.disabled === true || defaultColor === 255) return null;
      return { raster: Raster.fromPixels(1, 1, 1, new Uint8Array([defaultColor])), enabled: true,
        placement: transform(0, 0, state.documentWidth, state.documentHeight), linked: false, defaultColor };
    }
    issue(state, 'mask-pixels', 'Layer mask has no decodable pixel channel.', 'not-rendered', layerPath);
    return null;
  }
  const rgba = pixelDataToRgba8(mask.imageData);
  let pixels: Uint8Array<ArrayBufferLike> = new Uint8Array(mask.imageData.width * mask.imageData.height);
  for (let pixel = 0; pixel < pixels.length; pixel++) {
    const coverage = rgba[pixel * 4]!;
    pixels[pixel] = Math.round(255 - (255 - coverage) * density);
  }
  if (density !== 1) issue(state, 'mask-density', 'Mask density was baked into its raster and outside value.', 'editability-only', layerPath);
  const feather = (vectorParameters ? parameters?.vectorMaskFeather : parameters?.userMaskFeather) ?? 0;
  if (feather > 0) {
    pixels = featherMask(pixels, mask.imageData.width, mask.imageData.height, feather, defaultColor);
    issue(state, 'mask-feather', 'Mask feather was baked into its raster.', 'editability-only', layerPath);
  }
  const relative = mask.positionRelativeToLayer === true;
  const left = (mask.left ?? 0) + (relative ? layerTransform.origin.x : 0);
  const top = (mask.top ?? 0) + (relative ? layerTransform.origin.y : 0);
  const placement = transform(left, top, mask.imageData.width, mask.imageData.height);
  const raster = Raster.fromPixels(mask.imageData.width, mask.imageData.height, 1, pixels);
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
    linked: relative, defaultColor };
}

function maskFor(source: AgLayer, layerTransform: LayerTransform, state: ImportState,
  layerPath: string): { readonly mask: Layer['mask']; readonly defaultColor?: number } {
  const primary = decodedMask(source.mask, source.mask, layerTransform, state, layerPath);
  const real = decodedMask(source.realMask, source.mask, layerTransform, state, layerPath);
  if (!primary && !real) {
    const cached = source.mask?.fromVectorData && source.imageData;
    if (cached) issue(state, 'mask-pixels',
      'Vector-derived mask uses the layer pixel cache and is not editable.', 'editability-only', layerPath);
    return { mask: null };
  }
  // When both records exist, channel -2 is Photoshop's rendered mask cache (already composing
  // vector and real/user mask data); -3 is the editable user-mask source. Rendering both would
  // square its coverage. Fall back to -3 only for files that omit the composed cache.
  const value = primary ?? real!;
  return { mask: value, defaultColor: value.defaultColor };
}

function reportLayerFeatures(source: AgLayer, isGroup: boolean, state: ImportState, layerPath: string): void {
  if (source.text?.orientation === 'vertical') issue(state, 'vertical-text', 'Vertical PSD text is imported as horizontal text.', 'approximated', layerPath);
  const warpStyle = source.text?.warp?.style;
  if (warpStyle === 'custom' || warpStyle === 'cylinder') issue(state, 'text-warp', 'A custom or cylinder text warp keeps the saved preview; it is not rendered after editing.', 'not-rendered', layerPath);
  else if (warpStyle && warpStyle !== 'none') issue(state, 'text-warp', 'Warped PSD text is re-rendered with Fernwork’s envelope for its style after editing.', 'approximated', layerPath);
  if (source.text?.textPath) issue(state, 'text-path', 'PSD type on a path keeps its saved preview; after editing it is laid out as point text.', 'approximated', layerPath);
  if (source.placedLayer?.filter) issue(state, 'smart-filter',
    'Smart-object filters remain in the PSD preview; their editable parameters are not imported.', 'editability-only', layerPath);
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
  if (source.transparencyShapesLayer === false || (hasClippedChildren && source.blendClippendElements === false)) {
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

function meshDimensions(count: number, rowsHint?: number, columnsHint?: number): { x: number; y: number } | null {
  let best: { x: number; y: number; score: number } | null = null;
  for (let y = 1; y <= MAX_MESH_SPLITS; y++) for (let x = 1; x <= MAX_MESH_SPLITS; x++) {
    if ((x * 3 + 1) * (y * 3 + 1) !== count) continue;
    const score = Math.abs((columnsHint ?? x) - x) + Math.abs((rowsHint ?? y) - y);
    if (!best || score < best.score) best = { x, y, score };
  }
  return best ? { x: best.x, y: best.y } : null;
}

/** ag-psd PlLd/SoLd `warp`/`quiltWarp`; mesh coordinates are in placed-content space. */
function placedWarp(source: AgLayer, transform: LayerTransform,
  quad: import('../../core/model').WarpQuad | null): import('../../core/model').LayerWarp | null {
  const warp = source.placedLayer?.warp;
  if (!warp || warp.style === 'none') return quad;
  const envelope = warp.customEnvelopeWarp, dimensions = envelope
    ? meshDimensions(envelope.meshPoints.length, warp.deformNumRows, warp.deformNumCols) : null;
  if (envelope && dimensions) {
    const width = source.placedLayer?.width ?? transform.size.width, height = source.placedLayer?.height ?? transform.size.height;
    const left = warp.bounds?.left?.value ?? 0, top = warp.bounds?.top?.value ?? 0;
    const right = warp.bounds?.right?.value ?? width, bottom = warp.bounds?.bottom?.value ?? height;
    const rangeX = Math.abs(right - left) > 1e-9 ? right - left : width;
    const rangeY = Math.abs(bottom - top) > 1e-9 ? bottom - top : height;
    const units = envelope.meshPoints.map((point) => ({ x: (point.x - left) / rangeX, y: (point.y - top) / rangeY }));
    // Writers such as ag-psd store an identity envelope on every placed layer; it must not hide a perspective quad.
    const columns = dimensions.x * 3 + 1, rows = dimensions.y * 3 + 1;
    const identity = units.every((point, index) => Math.abs(point.x - (index % columns) / (columns - 1)) < 1e-6
      && Math.abs(point.y - Math.floor(index / columns) / (rows - 1)) < 1e-6);
    if (identity) return quad;
    const map = unitToDocument(transform);
    const points = units.map((point) => apply(map, point));
    return { kind: 'mesh', schemaVersion: 1, splits: dimensions, points, preset: 'custom' };
  }
  const preset = warp.style === 'arc' || warp.style === 'flag' || warp.style === 'bulge' || warp.style === 'wave'
    || warp.style === 'fish' || warp.style === 'rise' || warp.style === 'inflate' || warp.style === 'squeeze'
    ? warp.style : null;
  return preset ? meshPreset(transform, preset, (warp.value ?? 0) / 100) : quad;
}

function placedTransform(source: AgLayer, fallback: LayerTransform): { transform: LayerTransform; warp: import('../../core/model').LayerWarp | null } {
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
  const transform = makeTransform({ x: centre.x - width / 2, y: centre.y - height / 2 }, { width, height }, {
    rotation: Math.atan2(corners[1].y - corners[0].y, corners[1].x - corners[0].x) * 180 / Math.PI,
    flipY: cross < 0, sampling: 'High quality',
  });
  const quad = nonAffine ? { kind: 'quad' as const, schemaVersion: 1 as const, corners } : null;
  return { transform, warp: placedWarp(source, transform, quad) };
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

function labDocumentColor(l: number, a: number, b: number): RGB {
  const inverse = (value: number) => value ** 3 > 216 / 24389 ? value ** 3 : (116 * value - 16) / 903.3;
  const encode = (value: number) => { const v = Math.max(0, value);
    return Math.min(1, v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055); };
  const fy = (l + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const x = inverse(fx) * 0.96422, y = inverse(fy), z = inverse(fz) * 0.82521;
  return { red: encode(3.1338561 * x - 1.6168667 * y - 0.4906146 * z),
    green: encode(-0.9787684 * x + 1.9161415 * y + 0.033454 * z),
    blue: encode(0.0719453 * x - 0.2289914 * y + 1.4052427 * z) };
}

function cmykDocumentColor(state: ImportState, values: readonly number[]): RGB {
  const transfer = state.cmykTransfer;
  if (!transfer) return { red: (1 - values[0]!) * (1 - values[3]!),
    green: (1 - values[1]!) * (1 - values[3]!), blue: (1 - values[2]!) * (1 - values[3]!) };
  const size = transfer.forwardSize, positions = values.map((value) => Math.min(1, Math.max(0, value)) * (size - 1));
  const low = positions.map(Math.floor), high = low.map((value) => Math.min(size - 1, value + 1));
  const fraction = positions.map((value, index) => value - low[index]!);
  const output = [0, 0, 0];
  for (let dk = 0; dk < 2; dk++) for (let dy = 0; dy < 2; dy++) for (let dm = 0; dm < 2; dm++) for (let dc = 0; dc < 2; dc++) {
    const c = dc ? high[0]! : low[0]!, m = dm ? high[1]! : low[1]!, y = dy ? high[2]! : low[2]!, k = dk ? high[3]! : low[3]!;
    const weight = (dc ? fraction[0]! : 1 - fraction[0]!) * (dm ? fraction[1]! : 1 - fraction[1]!)
      * (dy ? fraction[2]! : 1 - fraction[2]!) * (dk ? fraction[3]! : 1 - fraction[3]!);
    const at = (((k * size + y) * size + m) * size + c) * 4;
    for (let channel = 0; channel < 3; channel++) output[channel] = output[channel]! + transfer.forward[at + channel]! * weight / 255;
  }
  return { red: output[0]!, green: output[1]!, blue: output[2]! };
}

function mixedDocumentColor(left: AgColor, right: AgColor, amount: number, state: ImportState): RGB {
  const mix = (a: number, b: number) => a + (b - a) * amount;
  if ('r' in left && 'r' in right) return { red: mix(left.r, right.r) / 255,
    green: mix(left.g, right.g) / 255, blue: mix(left.b, right.b) / 255 };
  if ('k' in left && !('c' in left) && 'k' in right && !('c' in right)) {
    const native = 1 - mix(left.k, right.k) / 100, transfer = state.grayTransfer;
    if (!transfer?.length) return { red: native, green: native, blue: native };
    const position = native * (transfer.length - 1), low = Math.floor(position), high = Math.min(transfer.length - 1, low + 1);
    const value = transfer[low]! + (transfer[high]! - transfer[low]!) * (position - low);
    return { red: value, green: value, blue: value };
  }
  if ('c' in left && 'c' in right) return cmykDocumentColor(state,
    [mix(left.c, right.c) / 100, mix(left.m, right.m) / 100, mix(left.y, right.y) / 100, mix(left.k, right.k) / 100]);
  if ('l' in left && 'l' in right) return labDocumentColor(mix(left.l, right.l), mix(left.a, right.a), mix(left.b, right.b));
  const a = rgbColor(left), b = rgbColor(right);
  return { red: mix(a.red, b.red), green: mix(a.green, b.green), blue: mix(a.blue, b.blue) };
}

function importedAdjustment(source: AgLayer, state: ImportState, layerPath: string): LayerAdjustment | null {
  const adjustment = source.adjustment;
  if (!adjustment) return null;
  const cmyk = source.id === undefined ? undefined : state.cmykAdjustmentChannels.get(source.id);
  switch (adjustment.type) {
    case 'levels': {
      const channels = [adjustment.rgb, adjustment.red, adjustment.green, adjustment.blue];
      const defaults = defaultLevels();
      const ranges = channels.map((channel, i) => channel ? {
        black: channel.shadowInput, gamma: channel.midtoneInput, white: channel.highlightInput,
        outputBlack: channel.shadowOutput, outputWhite: channel.highlightOutput,
      } : defaults.ranges[i]!);
      if (cmyk?.levelsBlack) ranges.push(cmyk.levelsBlack);
      return { kind: 'Levels', schemaVersion: 1, parameters: { ...defaults, ranges } };
    }
    case 'curves': {
      const defaults = defaultCurves(), channels = [adjustment.rgb, adjustment.red, adjustment.green, adjustment.blue];
      const values = channels.map((channel, i) =>
        channel?.length ? channel.map((point) => ({ x: point.input, y: point.output })) : defaults.channels[i]!);
      if (cmyk?.curvesBlack?.length) values.push(cmyk.curvesBlack);
      return { kind: 'Curves', schemaVersion: 1, parameters: { ...defaults, channels: values } };
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

function rectanglePath(left: number, top: number, right: number, bottom: number): VectorPath {
  const point = (x: number, y: number) => ({ in: { x, y }, anchor: { x, y }, out: { x, y }, kind: 'corner' as const });
  return { schemaVersion: 1, closed: true, fillRule: 'nonzero',
    points: [point(left, top), point(right, top), point(right, bottom), point(left, bottom)] };
}

function pathBounds(paths: readonly VectorPath[]): { x: number; y: number; width: number; height: number } | null {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const path of paths) for (const point of path.points) for (const value of [point.in, point.anchor, point.out]) {
    left = Math.min(left, value.x); top = Math.min(top, value.y);
    right = Math.max(right, value.x); bottom = Math.max(bottom, value.y);
  }
  if (![left, top, right, bottom].every(Number.isFinite)) return null;
  const x = Math.floor(left), y = Math.floor(top);
  return { x, y, width: Math.max(1, Math.ceil(right) - x), height: Math.max(1, Math.ceil(bottom) - y) };
}

function localPaths(paths: readonly VectorPath[], x: number, y: number): readonly VectorPath[] {
  return paths.map((path) => ({ ...path, points: path.points.map((point) => ({ ...point,
    in: { x: point.in.x - x, y: point.in.y - y }, anchor: { x: point.anchor.x - x, y: point.anchor.y - y },
    out: { x: point.out.x - x, y: point.out.y - y },
  })) }));
}

interface FlatPath { readonly points: Float64Array; readonly evenOdd: boolean }

function flattenedPaths(paths: readonly VectorPath[]): FlatPath[] {
  const result: FlatPath[] = [];
  for (const path of paths) {
    if (path.points.length < 2) continue;
    const values: number[] = [];
    const segments = path.closed ? path.points.length : path.points.length - 1;
    for (let index = 0; index < segments; index++) {
      const from = path.points[index]!, to = path.points[(index + 1) % path.points.length]!;
      if (index === 0) values.push(from.anchor.x, from.anchor.y);
      for (let step = 1; step <= 12; step++) {
        const t = step / 12, u = 1 - t;
        values.push(u ** 3 * from.anchor.x + 3 * u * u * t * from.out.x + 3 * u * t * t * to.in.x + t ** 3 * to.anchor.x,
          u ** 3 * from.anchor.y + 3 * u * u * t * from.out.y + 3 * u * t * t * to.in.y + t ** 3 * to.anchor.y);
      }
    }
    result.push({ points: new Float64Array(values), evenOdd: path.fillRule === 'evenodd' });
  }
  return result;
}

function pathContains(paths: readonly FlatPath[], x: number, y: number): boolean {
  let winding = 0, parity = false;
  for (const path of paths) {
    let local = 0;
    const values = path.points, count = values.length / 2;
    for (let index = 0, previous = count - 1; index < count; previous = index++) {
      const x0 = values[previous * 2]!, y0 = values[previous * 2 + 1]!;
      const x1 = values[index * 2]!, y1 = values[index * 2 + 1]!;
      if ((y0 > y) !== (y1 > y) && x < (x1 - x0) * (y - y0) / (y1 - y0) + x0) {
        parity = !parity; local += y1 > y0 ? 1 : -1;
      }
    }
    if (!path.evenOdd) winding += local;
  }
  return parity || winding !== 0;
}

function pathDistanceSquared(paths: readonly FlatPath[], x: number, y: number): number {
  let best = Infinity;
  for (const path of paths) {
    const values = path.points, count = values.length / 2;
    for (let index = 0, previous = count - 1; index < count; previous = index++) {
      const x0 = values[previous * 2]!, y0 = values[previous * 2 + 1]!;
      const dx = values[index * 2]! - x0, dy = values[index * 2 + 1]! - y0;
      const length = dx * dx + dy * dy;
      const t = length ? Math.min(1, Math.max(0, ((x - x0) * dx + (y - y0) * dy) / length)) : 0;
      const px = x0 + dx * t - x, py = y0 + dy * t - y;
      best = Math.min(best, px * px + py * py);
    }
  }
  return best;
}

/** Layer-owned fallback for PSD generated fills whose high-depth records contain no pixel cache. */
function generatedVectorRaster(source: AgLayer, paths: readonly VectorPath[], width: number, height: number,
  patterns: ReadonlyMap<string, PatternInfo>, origin: { readonly x: number; readonly y: number }, state: ImportState): Raster | null {
  const content = source.vectorFill;
  if (!content || (content.type !== 'color' && content.type !== 'solid' && content.type !== 'pattern')
    || width * height > MAX_PIXELS) return null;
  const flat = flattenedPaths(paths);
  if (!flat.length) return null;
  const pixels = new Uint8Array(width * height * 4), samples = width * height <= 4_000_000 ? 4 : 1;
  const offsets = samples === 4 ? [0.25, 0.75] as const : [0.5] as const;
  const stops = content.type === 'solid' ? content.colorStops.slice().sort((a, b) => a.location - b.location) : [];
  const opacity = content.type === 'solid' ? content.opacityStops.slice().sort((a, b) => a.location - b.location) : [];
  // Photoshop's cache-less high-depth reflected fills use the legacy preview
  // orientation (15 degrees clockwise from the descriptor angle).
  const angle = ((content.type === 'solid'
    ? content.style === 'reflected' ? (content.angle ?? 0) + 15 : content.angle ?? 0 : 0) * Math.PI) / 180;
  // PSD gradient angles use the document's upward-positive axis; raster rows grow downward.
  const cos = Math.cos(angle), sin = -Math.sin(angle), scale = content.type === 'solid' ? Math.max(0.01, content.scale ?? 1) : 1;
  const cx = width * (0.5 + (content.type === 'solid' ? content.offset?.x ?? 0 : 0) / 100);
  const cy = height * (0.5 + (content.type === 'solid' ? content.offset?.y ?? 0 : 0) / 100);
  const extent = Math.max(1e-9, (Math.abs(cos) * width + Math.abs(sin) * height) * 0.5 * scale);
  const stroke = source.vectorStroke?.strokeEnabled === true ? source.vectorStroke : null;
  const strokeWidth = stroke ? Math.max(0.01, units(stroke.lineWidth)) : 0;
  const strokeColor = stroke?.content?.type === 'color' ? rgb(stroke.content.color) : null;
  const pattern = content.type === 'pattern' ? patterns.get(content.id) : undefined;
  if (content.type === 'pattern' && (!pattern || pattern.data.length !== pattern.bounds.w * pattern.bounds.h * 4)) return null;
  const stopValue = (location: number): readonly [number, number, number, number] => {
    if (content.type === 'color') { const color = rgb(content.color); return [color.red, color.green, color.blue, 1]; }
    let left = stops[0]!, right = stops.at(-1)!;
    for (let index = 1; index < stops.length; index++) if (location <= stops[index]!.location) {
      left = stops[index - 1]!; right = stops[index]!; break;
    }
    const mix = right.location === left.location ? 0 : Math.min(1, Math.max(0,
      (location - left.location) / (right.location - left.location)));
    const color = mixedDocumentColor(left.color, right.color, mix, state);
    let alpha = 1;
    if (opacity.length) {
      let lo = opacity[0]!, hi = opacity.at(-1)!;
      for (let index = 1; index < opacity.length; index++) if (location <= opacity[index]!.location) {
        lo = opacity[index - 1]!; hi = opacity[index]!; break;
      }
      const amount = hi.location === lo.location ? 0 : Math.min(1, Math.max(0,
        (location - lo.location) / (hi.location - lo.location)));
      alpha = lo.opacity + (hi.opacity - lo.opacity) * amount;
    }
    return [color.red, color.green, color.blue, alpha];
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let covered = 0, stroked = 0;
    for (const oy of offsets) for (const ox of offsets) {
      const inside = pathContains(flat, x + ox, y + oy);
      if (inside) covered++;
      if (strokeColor) {
        const reach = stroke!.lineAlignment === 'inside' ? strokeWidth
          : stroke!.lineAlignment === 'outside' ? (inside ? 0 : strokeWidth) : strokeWidth / 2;
        if (reach > 0 && pathDistanceSquared(flat, x + ox, y + oy) <= reach * reach) stroked++;
      }
    }
    if (!covered) continue;
    let location = ((x + 0.5 - cx) * cos + (y + 0.5 - cy) * sin) / (extent * 2) + 0.5;
    if (content.type === 'solid') {
      if (content.style === 'reflected') location = Math.abs(location * 2 - 1);
      else if (content.style === 'radial') location = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / extent;
      else if (content.style === 'diamond') location = (Math.abs(x + 0.5 - cx) + Math.abs(y + 0.5 - cy)) / extent;
      else if (content.style === 'angle') location = (Math.atan2(y + 0.5 - cy, x + 0.5 - cx) / (Math.PI * 2) + 1) % 1;
      if (content.reverse) location = 1 - location;
      // Photoshop's classic gradient interpolation eases around the midpoint even when the
      // stop midpoint is 50%; its high-depth generated-fill cache pins this ≈1.3 response.
      if ((content.style !== 'reflected' || state.colorMode === 1)
        && (!content.interpolationMethod || content.interpolationMethod === 'classic')) {
        location = location < 0.5 ? 0.5 * (location * 2) ** 1.3
          : 1 - 0.5 * ((1 - location) * 2) ** 1.3;
      }
    }
    let color: readonly [number, number, number, number];
    if (pattern) {
      const px = ((Math.floor(origin.x + x) - pattern.bounds.x) % pattern.bounds.w + pattern.bounds.w) % pattern.bounds.w;
      const py = ((Math.floor(origin.y + y) - pattern.bounds.y) % pattern.bounds.h + pattern.bounds.h) % pattern.bounds.h;
      const at = (py * pattern.bounds.w + px) * 4;
      color = [pattern.data[at]! / 255, pattern.data[at + 1]! / 255,
        pattern.data[at + 2]! / 255, pattern.data[at + 3]! / 255];
    } else color = stopValue(Math.min(1, Math.max(0, location)));
    const coverage = covered / samples;
    const strokeMix = strokeColor ? Math.min(1, stroked / covered) : 0;
    const at = (y * width + x) * 4, alpha = color[3] * coverage;
    pixels[at] = Math.round((color[0] * (1 - strokeMix) + (strokeColor?.red ?? 0) * strokeMix) * 255);
    pixels[at + 1] = Math.round((color[1] * (1 - strokeMix) + (strokeColor?.green ?? 0) * strokeMix) * 255);
    pixels[at + 2] = Math.round((color[2] * (1 - strokeMix) + (strokeColor?.blue ?? 0) * strokeMix) * 255);
    pixels[at + 3] = Math.round(alpha * 255);
  }
  return Raster.fromPixels(width, height, 4, pixels);
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

const PSD_WARP_STYLES = new Set(['arc', 'arcLower', 'arcUpper', 'arch', 'bulge', 'shellLower', 'shellUpper', 'flag', 'wave', 'fish',
  'rise', 'fisheye', 'inflate', 'squeeze', 'twist']);

/** Photoshop's warp preset (style, bend, perspective distortions, orientation) as the editable text warp. */
function psdTextWarp(data: LayerTextData): import('../../core/model').TextWarp | null {
  const warp = data.warp;
  if (!warp?.style || !PSD_WARP_STYLES.has(warp.style)) return null;
  const percent = (value: number | undefined) => (Number.isFinite(value) ? Math.max(-100, Math.min(100, value!)) : 0);
  return { schemaVersion: 1, style: warp.style as import('../../core/model').TextWarpStyle,
    orientation: warp.rotate === 'vertical' ? 'vertical' : 'horizontal', bend: percent(warp.value),
    horizontalDistortion: percent(warp.perspective), verticalDistortion: percent(warp.perspectiveOther) };
}

function psdTextBox(data: LayerTextData, width: number, height: number): { width: number; height: number } | null {
  if (data.shapeType !== 'box') return null;
  const bounds = data.boxBounds;
  return bounds && bounds.length >= 4 ? { width: Math.max(1, Math.abs(bounds[2]! - bounds[0]!)),
    height: Math.max(1, Math.abs(bounds[3]! - bounds[1]!)) } : { width: Math.max(1, width), height: Math.max(1, height) };
}

function psdTextTransform(data: LayerTextData, fallback: LayerTransform,
  box: { width: number; height: number } | null, resolution: number): LayerTransform {
  const matrix = data.transform;
  if (!matrix || matrix.length !== 6 || !matrix.every(Number.isFinite)) return fallback;
  const [a, b, c, d, tx, ty] = matrix as [number, number, number, number, number, number];
  const pointSizes = (data.styleRuns?.length ? data.styleRuns.map((run) => run.style) : [data.style ?? {}]);
  const fontSize = Math.max(1, ...pointSizes.map((style) => style.fontSize ?? DEFAULT_TEXT_STYLE.fontSize)) * resolution / 72;
  const leading = Math.max(fontSize * 1.2, ...pointSizes.map((style) => style.autoLeading === false && style.leading
    ? style.leading * resolution / 72 : fontSize * 1.2));
  const lines = data.text.replace(/\r/g, '\n').split('\n');
  const localWidth = box?.width ?? Math.max(1, fallback.size.width,
    Math.max(...lines.map((line) => [...line].length), 1) * fontSize * 0.6);
  const localHeight = box?.height ?? Math.max(1, fallback.size.height, lines.length * leading);
  const scaleX = Math.hypot(a, b), scaleY = Math.hypot(c, d);
  if (!(scaleX > 0) || !(scaleY > 0)) return fallback;
  const left = Number.isFinite(data.left) ? data.left! : 0;
  // PSD point-text transforms locate the first baseline. Use the shaped line metrics rather than
  // absent TySh bounds; area text continues to use its explicit box origin.
  const top = Number.isFinite(data.top) ? data.top! : box ? 0 : -fontSize * 1.069;
  return makeTransform({ x: tx + left * a + top * c,
    y: ty + left * b + top * d },
  { width: Math.max(1, localWidth * scaleX), height: Math.max(1, localHeight * scaleY) },
  { rotation: Math.atan2(b, a) * 180 / Math.PI, flipX: a < 0, flipY: d < 0, sampling: 'High quality' });
}

function legacyArtboard(source: AgLayer, state: ImportState): AgLayer['artboard'] {
  if (source.artboard || source.nameSource !== 'artb' || !source.children?.length) return source.artboard;
  let top = Infinity, left = Infinity, bottom = -Infinity, right = -Infinity;
  for (const child of source.children) {
    if (child.top == null || child.left == null || child.bottom == null || child.right == null
      || child.right <= child.left || child.bottom <= child.top || child.left < 0 || child.top < 0
      || child.right > state.documentWidth || child.bottom > state.documentHeight) continue;
    top = Math.min(top, child.top); left = Math.min(left, child.left);
    bottom = Math.max(bottom, child.bottom); right = Math.max(right, child.right);
  }
  if (!Number.isFinite(left)) return undefined;
  // Early Photoshop artboards can contain only the two-byte `artb` marker. Their bounded
  // descendants still define the native clip rectangle; off-canvas children are the bleed.
  return { rect: { top, left, bottom, right }, backgroundType: 3 };
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
    const nativeAdjustment = importedAdjustment(source, state, layerPath);
    const adjustment = nativeAdjustment ? Object.assign({}, nativeAdjustment, { psdColorMode: state.colorMode,
      psdBitsPerChannel: state.bitsPerChannel,
      ...(state.grayTransfer ? { psdGrayTransfer: state.grayTransfer } : {}),
      ...(state.cmykTransfer ? { psdCmykTransfer: state.cmykTransfer } : {}) }) as LayerAdjustment : null;
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
    if (source.clipping && !clippingBaseId) issue(state, 'orphan-clipping',
      'Clipping layer has no visible base in its group.', 'not-rendered', layerPath);
    reportLayerFeatures(source, isGroup, state, layerPath);
    const opacity = Math.min(1, Math.max(0, source.opacity ?? 1));
    const fillOpacity = Math.min(1, Math.max(0, source.fillOpacity ?? 1));
    const textData = !isGroup ? source.text : undefined;
    const editableText = textData?.text.replace(/\r/g, '\n') ?? '';
    const textBox = textData ? psdTextBox(textData, width, height) : null;
    const editableTransform = textData ? psdTextTransform(textData, layerTransform, textBox, state.resolution) : layerTransform;
    const vectorContent = !isGroup && !textData && !!(source.vectorFill || source.vectorStroke)
      && (state.bitsPerChannel !== 8 || (!!source.vectorMask?.paths.length && !state.artboards));
    const fillBounds = source.mask && (source.mask.right ?? 0) > (source.mask.left ?? 0)
      && (source.mask.bottom ?? 0) > (source.mask.top ?? 0)
      ? { left: source.mask.left!, top: source.mask.top!, right: source.mask.right!, bottom: source.mask.bottom! }
      : { left: 0, top: 0, right: state.documentWidth, bottom: state.documentHeight };
    const globalVectorPaths = vectorContent
      ? source.vectorMask?.paths.length ? psdVectorPaths(source.vectorMask.paths, { x: 0, y: 0 })
        : [rectanglePath(fillBounds.left, fillBounds.top, fillBounds.right, fillBounds.bottom)] : [];
    const vectorBounds = vectorContent && !image ? pathBounds(globalVectorPaths) : null;
    const vectorTransform = vectorBounds
      ? transform(vectorBounds.x, vectorBounds.y, vectorBounds.width, vectorBounds.height) : editableTransform;
    const vectorPaths = vectorContent ? localPaths(globalVectorPaths, vectorTransform.origin.x, vectorTransform.origin.y) : [];
    const vectorRaster = vectorContent && !image
      ? generatedVectorRaster(source, vectorPaths, Math.round(vectorTransform.size.width), Math.round(vectorTransform.size.height),
        state.patterns, vectorTransform.origin, state) : null;
    const vectorStyle = vectorContent ? psdVectorStyle(source, state.resolution, state, layerPath) : null;
    if (vectorRaster) issue(state, 'generated-fill-cache',
      'A cache-less PSD generated fill is rendered from its editable descriptor and path; its paint is retained as PSD metadata.',
      'editability-only', layerPath);
    const placed = !isGroup ? placedContent(source, state) : null;
    const placedPixels = placed ? placedRaster(source, state) : null;
    // When ag-psd exposes only Photoshop's already-transformed cache, keep its pixel placement until the source
    // runtime resolves. Decodable embedded PNGs use their true original grid and the PlLd/SoLd transform directly.
    const placement = placed && placedPixels ? placedTransform(source, layerTransform) : { transform: vectorTransform, warp: null };
    const vectorMask = vectorContent ? null : psdVectorMask(source, editableTransform.origin);
    const importedMaskResult = maskFor(source, placement.transform, state, layerPath);
    let importedMask = importedMaskResult.mask;
    const artboard = isGroup ? legacyArtboard(source, state) : undefined;
    if (artboard && !importedMask) {
      const rect = artboard.rect;
      const width = Math.max(1, rect.right - rect.left), height = Math.max(1, rect.bottom - rect.top);
      // Photoshop artboards clip their descendants to the artboard rectangle. A one-sample mask
      // preserves that native group semantic without allocating a document-sized raster.
      importedMask = { raster: Raster.fromPixels(1, 1, 1, new Uint8Array([255])), enabled: true,
        placement: transform(rect.left, rect.top, width, height), linked: false };
    }
    let imported: Layer = newLayer({
      id, name: source.name ?? `Layer ${sourceIndex + 1}`, parentId, kind: isGroup ? 'group' : placed ? 'embedded' : textData ? 'text' : vectorContent ? 'vector' : adjustment ? 'adjustment' : 'pixel',
      visible: source.hidden !== true, opacity, fillOpacity, blendMode: mappedMode,
      locks: importedLocks(source), colorLabel: importedColorLabel(source, state, layerPath), transform: placement.transform,
      warp: placement.warp,
      raster: placedPixels ?? (image ? rasterFromPixelData(image) : vectorRaster),
      ...(placed ? { content: placed } : {}),
      ...(textData ? { text: editableText, runs: psdTextRuns(textData, editableText),
        paragraphs: psdParagraphs(textData, editableText), box: textBox,
        alignment: psdAlignment(textData.paragraphStyle?.justification), renderedTransform: layerTransform,
        textWarp: psdTextWarp(textData) } : {}),
      ...(vectorContent ? { paths: vectorPaths,
        // Force every renderer to use the same descriptor-derived cache. CanvasKit's generic gradient
        // lacks Photoshop classic interpolation and non-linear gradient styles.
        style: vectorRaster ? { ...vectorStyle!, fill: null, stroke: null } : vectorStyle!, sourceShape: null } : {}),
      mask: importedMask,
      vectorMask,
      maskSourceId: source.clipping ? clippingBaseId : null,
      effects: importEffects(source, state, layerPath),
      ...(adjustment ? { adjustment } : {}),
    });
    const knockoutMode = source.id === undefined ? undefined : state.knockoutModes.get(source.id);
    if (isGroup) imported = { ...imported,
      psdIsolated: sourceMode !== 'pass through', psdKnockout: knockoutMode ?? (source.knockout === true ? 'deep' : false) } as Layer
        & { readonly psdIsolated: boolean; readonly psdKnockout: PsdKnockoutMode | false };
    else if (knockoutMode || source.knockout === true) imported = { ...imported,
      psdKnockout: knockoutMode ?? 'deep' } as Layer & { readonly psdKnockout: PsdKnockoutMode };
    if (importedMaskResult.defaultColor !== undefined) imported = { ...imported,
      psdMaskDefault: importedMaskResult.defaultColor } as Layer
      & { readonly psdMaskDefault: number };
    else if (artboard) imported = { ...imported, psdMaskDefault: 0 } as Layer
      & { readonly psdMaskDefault: number };
    if (artboard) imported = { ...imported, psdArtboardRect: { x: artboard.rect.left, y: artboard.rect.top,
      width: artboard.rect.right - artboard.rect.left, height: artboard.rect.bottom - artboard.rect.top } } as Layer
        & { readonly psdArtboardRect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } };
    if (vectorRaster) imported = { ...imported, psdGeneratedStyle: vectorStyle } as Layer
      & { readonly psdGeneratedStyle: VectorStyle };
    if (source.effects && source.blendInteriorElements === true) imported = { ...imported,
      psdBlendInteriorEffects: true } as Layer & { readonly psdBlendInteriorEffects: true };
    if (source.blendClippendElements !== undefined) imported = { ...imported,
      psdBlendClippedElements: source.blendClippendElements } as Layer
        & { readonly psdBlendClippedElements: boolean };
    result.push(imported);
    if (isGroup) {
      if (artboard && (artboard.backgroundType ?? 1) !== 3) {
        const rect = artboard.rect, kind = artboard.backgroundType ?? 1;
        const color = kind === 2 ? { red: 0, green: 0, blue: 0 } : kind === 4 ? rgb(artboard.color)
          : { red: 1, green: 1, blue: 1 };
        result.push(newLayer({ id: `psd-layer-${state.nextId++}`, name: 'Artboard background', parentId: id,
          kind: 'pixel', locks: { transparency: false, pixels: true, position: true, all: true },
          transform: transform(rect.left, rect.top, Math.max(1, rect.right - rect.left), Math.max(1, rect.bottom - rect.top)),
          raster: Raster.fromPixels(1, 1, 4, new Uint8Array([
            Math.round(color.red * 255), Math.round(color.green * 255), Math.round(color.blue * 255), 255,
          ])) }));
      }
      // Photoshop permits a whole group to be a clipping member. Keep the preceding base alive
      // across that group; an unclipped group starts a new sibling stack but is not yet a live-mask base.
      if (!source.clipping) clippingBaseId = null;
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
  // psd-tools writes generator/content-authentication/OCIO bookkeeping on otherwise pixel-identical files.
  // ag-psd also reports descriptor padding as unread bytes; neither participates in compositing.
  if (/^Unhandled additional info: (?:CAI\s*|GenI|OCIO|Mt32)$/.test(message)
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
    const converted = raw.bitsPerChannel === 16
      ? lcms.transform16(profile, raw.managedSamples as Uint16Array, model, raw.managedAlpha as Uint16Array | null)
      : lcms.transform(profile, raw.managedSamples, model, raw.bitsPerChannel, raw.managedAlpha);
    return Raster.fromPixels(raw.width, raw.height, 4, converted,
      raw.bitsPerChannel === 16 ? { format: 'rgba16' } : {});
  }
  return Raster.fromPixels(raw.width, raw.height, 4, raw.rgba);
}

function grayTransfer(raw: ReturnType<typeof readRawPsdComposite>, lcms: LittleCms | null): Float32Array | null {
  if (!lcms || raw.colorMode !== 1 || (raw.bitsPerChannel !== 8 && raw.bitsPerChannel !== 16)) return null;
  const profile = raw.iccProfile ?? lcms.createGrayProfile([0.3127, 0.329], 2.2);
  const size = raw.bitsPerChannel === 16 ? 65_536 : 256;
  const source = raw.bitsPerChannel === 16
    ? Uint16Array.from({ length: size }, (_, value) => value)
    : Uint8Array.from({ length: size }, (_, value) => value);
  const converted = raw.bitsPerChannel === 16
    ? lcms.transform16(profile, source as Uint16Array, 'gray')
    : lcms.transform(profile, source, 'gray', 8);
  const maximum = raw.bitsPerChannel === 16 ? 65_535 : 255;
  const transfer = new Float32Array(size);
  for (let value = 0; value < size; value++) transfer[value] = converted[value * 4]! / maximum;
  return transfer;
}

function cmykTransfer(raw: ReturnType<typeof readRawPsdComposite>, lcms: LittleCms | null): ImportState['cmykTransfer'] {
  if (!lcms || raw.colorMode !== 4 || (raw.bitsPerChannel !== 8 && raw.bitsPerChannel !== 16)) return null;
  const profile = raw.iccProfile ?? lcms.createCmykProfile(), inverseSize = 33;
  const inverse = new Uint8Array(inverseSize ** 3 * 4);
  for (let b = 0; b < inverseSize; b++) for (let g = 0; g < inverseSize; g++) for (let r = 0; r < inverseSize; r++) {
    const at = ((b * inverseSize + g) * inverseSize + r) * 4;
    inverse[at] = Math.round(r * 255 / (inverseSize - 1));
    inverse[at + 1] = Math.round(g * 255 / (inverseSize - 1));
    inverse[at + 2] = Math.round(b * 255 / (inverseSize - 1)); inverse[at + 3] = 255;
  }
  lcms.transformRgbToCmykInPlace(profile, inverse, 'perceptual', false);
  const forwardSize = 17, samples = forwardSize ** 4, source = new Uint8Array(samples * 4);
  for (let k = 0; k < forwardSize; k++) for (let y = 0; y < forwardSize; y++) {
    for (let m = 0; m < forwardSize; m++) for (let c = 0; c < forwardSize; c++) {
      const at = (((k * forwardSize + y) * forwardSize + m) * forwardSize + c) * 4;
      source[at] = Math.round(c * 255 / (forwardSize - 1)); source[at + 1] = Math.round(m * 255 / (forwardSize - 1));
      source[at + 2] = Math.round(y * 255 / (forwardSize - 1)); source[at + 3] = Math.round(k * 255 / (forwardSize - 1));
    }
  }
  return { inverseSize, inverse, forwardSize, forward: lcms.transform(profile, source, 'cmyk', 8) };
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
  let documentGrayTransfer: Float32Array | null = null;
  let documentCmykTransfer: ImportState['cmykTransfer'] = null;
  const originalMode = sourceColorMode(bytes);
  try {
    if ([4, 7, 8, 9].includes(originalMode) || (originalMode === 1 && lcms)) {
      const raw = readRawPsdComposite(bytes);
      psd = readRawLayerPsd(bytes, raw, lcms, parserWarnings);
      oracleOverride = colorManagedComposite(raw, lcms);
      documentGrayTransfer = grayTransfer(raw, lcms);
      documentCmykTransfer = cmykTransfer(raw, lcms);
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
    message: bitsPerChannel === 16 ? '16-bit layer channels and colour-managed CMS output are retained as RGBA16.'
      : '32-bit floating channels use a bounded display conversion.', impact: 'approximated' });
  if (colorMode !== 3) unsupported.push({ code: `color-mode:${colorMode}`,
    message: `PSD color mode ${colorMode} layer channels were converted independently to sRGB.`,
    impact: colorMode === 1 || colorMode === 4 ? 'editability-only' : 'approximated' });
  if (oracleOverride && colorMode === 4 && !lcms) unsupported.push({ code: 'embedded-icc',
    message: 'The synchronous CMYK path uses a deterministic fallback; product open applies Little CMS.', impact: 'approximated' });
  if (psd.artboards) unsupported.push({ code: 'artboards',
    message: 'Artboard rectangles and backgrounds are rendered as locked group masks and background layers; layout metadata is not editable.',
    impact: 'editability-only' });
  const documentResolution = resolution(psd);
  const state: ImportState = { nextId: 1, documentWidth: psd.width, documentHeight: psd.height,
    bitsPerChannel, colorMode, artboards: !!psd.artboards, resolution: documentResolution,
    unsupported, resources: [], linkedFiles: new Map((psd.linkedFiles ?? []).map((file) => [file.id, file])),
    patterns: new Map((psd.patterns ?? []).map((pattern) => [pattern.id, pattern])),
    grayTransfer: documentGrayTransfer, cmykTransfer: documentCmykTransfer,
    knockoutModes: readPsdLayerKnockouts(bytes), cmykAdjustmentChannels: readPsdCmykAdjustmentChannels(bytes) };
  const layers = importSiblings(psd.children ?? [], null, '', state);
  // PSD's negative layer-count flag is the native declaration that the merged result carries
  // transparency. Otherwise Photoshop composites the editable stack over an opaque white canvas.
  // The PSD canvas is opaque unless layer info (including the HDR Mt32 convention) declares
  // merged transparency. This also applies to zero-layer documents: their Photoshop canvas is white.
  const opaqueCanvas = !psdHasMergedTransparency(bytes);
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
  const document = {
    id: 'psd-document', width: psd.width, height: psd.height, resolution: resolution(psd),
    globalLightAngle: psd.imageResources?.globalAngle ?? 120, layers: documentLayers, resources: state.resources, selection: null,
    psdOpaqueCanvas: opaqueCanvas,
  } as CanvasDocument & { readonly psdOpaqueCanvas: boolean };
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
