import {
  writePsdUint8Array, type AdjustmentLayer as AgAdjustment, type BezierPath, type BlendMode as AgBlendMode,
  type EffectSolidGradient, type Layer as AgLayer, type LayerEffectsInfo, type LayerTextData, type LinkedFile,
  type PatternInfo, type PixelData, type Psd, type VectorContent,
} from 'ag-psd';
import {
  PRO_MAX_PIXELS, PRO_MAX_SIDE, type BlendMode, type CanvasDocument, type FillParameters,
  type Layer, type LayerAdjustment, type LayerEffect, type TextLayer, type VectorPath,
} from '../../core/document';
import { curveValue, levelValue } from '../../core/adjust/levels';
import { artboardMembership } from '../../core/artboards';
import { boundingBox, integralRect, type LayerTransform, type Rect } from '../../core/geometry';
import { linearToSrgb, srgbToLinear } from '../../core/pixel/color';
import { floatToRgba16, rgba16To8 } from '../../core/pixel/format';
import type { Raster } from '../../core/raster';
import { cpuCompositeRegion, cpuCompositeRegionFloat } from '../../render/cpuRender';
import { DEFAULT_HOOKS, type CompositeHooks } from '../../render/hooks';
import { srgbIccProfile } from '../iccProfile';
import { sha256Hex } from '../sha256';
import type { PsdUnsupportedFeature } from './reader';
import { patchPsdLayerKnockouts, type PsdKnockoutMode } from './layerInfo';
import { attachPsdIccProfile } from './writerIcc';
import { promotePsdTo16, replacePsdComposite, type Native16Layer } from './writerDepth';
import { meshWarpToPsd } from './warp';

export type PsdWriteFormat = 'psd' | 'psb';
export type PsdWriteNotice = PsdUnsupportedFeature;

export interface PsdWriteOptions {
  /** `auto` chooses PSB only when a PSD dimension exceeds 30,000 pixels. */
  readonly format?: PsdWriteFormat | 'auto';
  /** Defaults to 16 when any stored/displayed colour raster is RGBA16, otherwise 8. */
  readonly bitsPerChannel?: 8 | 16;
  /** Product display rasters/transforms after the lazy text/vector/embedded runtimes have prepared. */
  readonly hooks?: CompositeHooks;
  /** Defaults to the editor's sRGB working profile; null deliberately writes an untagged PSD. */
  readonly iccProfile?: Uint8Array | null;
}

export interface PsdWriteResult {
  readonly bytes: Uint8Array;
  readonly format: PsdWriteFormat;
  readonly bitsPerChannel: 8 | 16;
  readonly notices: readonly PsdWriteNotice[];
}

const BLENDS: Readonly<Record<BlendMode, AgBlendMode>> = {
  normal: 'normal', dissolve: 'dissolve', darken: 'darken', multiply: 'multiply', colorBurn: 'color burn',
  linearBurn: 'linear burn', darkerColor: 'darker color', lighten: 'lighten', screen: 'screen', colorDodge: 'color dodge',
  linearDodge: 'linear dodge', lighterColor: 'lighter color', overlay: 'overlay', softLight: 'soft light', hardLight: 'hard light',
  vividLight: 'vivid light', linearLight: 'linear light', pinLight: 'pin light', hardMix: 'hard mix', difference: 'difference',
  exclusion: 'exclusion', subtract: 'subtract', divide: 'divide', hue: 'hue', saturation: 'saturation', color: 'color',
  luminosity: 'luminosity',
};

interface State {
  readonly document: CanvasDocument;
  readonly hooks: CompositeHooks;
  readonly bits: 8 | 16;
  readonly notices: PsdWriteNotice[];
  readonly linkedFiles: LinkedFile[];
  readonly native16Layers: Native16Layer[];
  readonly patterns: PatternInfo[];
  readonly resources: ReadonlyMap<string, NonNullable<CanvasDocument['resources']>[number]>;
  nextNativeLayerId: number;
  readonly knockoutModes: Map<number, PsdKnockoutMode>;
}

function notice(state: State, code: string, message: string, impact: PsdWriteNotice['impact'], layerPath?: string): void {
  state.notices.push({ code, message, impact, ...(layerPath ? { layerPath } : {}) });
}

function clamp01(value: number): number { return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0)); }
// ag-psd writes descriptor RGB components as doubles and independently rounds the legacy 16-bit colour record.
// Keep sub-byte descriptor precision so a read/write/read does not compound gradient/effect rounding.
function byte(value: number): number { return clamp01(value) * 255; }
function color(value: { readonly red: number; readonly green: number; readonly blue: number; readonly alpha?: number }) {
  return { r: byte(value.red), g: byte(value.green), b: byte(value.blue), ...(
    value.alpha === undefined ? {} : { a: byte(value.alpha) }) };
}
function pixelsUnit(value: number) { return { units: 'Pixels' as const, value }; }

function depthPixels(data: Uint8Array | Uint16Array, bits: 8 | 16): Uint8Array | Uint16Array {
  if (bits === 8) {
    if (data instanceof Uint8Array) return data;
    const output = new Uint8Array(data.length);
    for (let index = 0; index < data.length; index++) output[index] = Math.round(data[index]! * 255 / 65535);
    return output;
  }
  if (data instanceof Uint16Array) return data;
  const output = new Uint16Array(data.length);
  for (let index = 0; index < data.length; index++) output[index] = data[index]! * 257;
  return output;
}

function imageData(raster: Raster, bits: 8 | 16): PixelData {
  if (raster.channels !== 4) throw new RangeError('PSD colour layers require RGBA rasters');
  return { width: raster.width, height: raster.height,
    data: depthPixels(raster.toPixelsNative() as Uint8Array | Uint16Array, 8) };
}

function imageDataFromBytes(bytes: Uint8Array, width: number, height: number, bits: 8 | 16): PixelData {
  return { width, height, data: depthPixels(bytes, 8) };
}

function maskImage(raster: Raster, bits: 8 | 16): PixelData {
  const source = raster.toPixels(), rgba8 = new Uint8Array(raster.width * raster.height * 4);
  for (let pixel = 0; pixel < source.length; pixel++) {
    const value = source[pixel]!, at = pixel * 4;
    rgba8[at] = value; rgba8[at + 1] = value; rgba8[at + 2] = value; rgba8[at + 3] = 255;
  }
  return imageDataFromBytes(rgba8, raster.width, raster.height, bits);
}

function clipped(rect: Rect, document: CanvasDocument): Rect {
  const x = Math.max(-300_000, rect.x), y = Math.max(-300_000, rect.y);
  const right = Math.min(300_000, rect.x + rect.width), bottom = Math.min(300_000, rect.y + rect.height);
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}

function rasterizedLayer(layer: Layer, path: string, state: State): { data?: PixelData; left: number; top: number; right: number; bottom: number } {
  const raster = state.hooks.raster(layer) ?? layer.raster ?? null;
  const transform = state.hooks.transform(layer);
  if (!raster) return { left: Math.floor(transform.origin.x), top: Math.floor(transform.origin.y),
    right: Math.ceil(transform.origin.x + transform.size.width), bottom: Math.ceil(transform.origin.y + transform.size.height) };
  const simple = transform.rotation % 360 === 0 && !transform.flipX && !transform.flipY
    && Number.isInteger(transform.origin.x) && Number.isInteger(transform.origin.y)
    && transform.size.width === raster.width && transform.size.height === raster.height && !layer.filters.length && !layer.warp && !layer.crop;
  if (simple) {
    if (state.bits === 16 && raster.format === 'rgba16') state.native16Layers.push({ width: raster.width, height: raster.height,
      rgba: raster.toPixelsNative() as Uint16Array });
    return { data: imageData(raster, state.bits), left: transform.origin.x, top: transform.origin.y,
      right: transform.origin.x + raster.width, bottom: transform.origin.y + raster.height };
  }
  const rect = clipped(integralRect(boundingBox(transform)), state.document);
  const bare = { ...layer, parentId: null, visible: true, opacity: 1, fillOpacity: 1, blendMode: 'normal' as const,
    mask: null, vectorMask: null, maskSourceId: null, effects: [] } as Layer;
  const single = { ...state.document, layers: [bare], artboards: [] };
  let rendered: Uint8Array;
  if (state.bits === 16 && raster.format === 'rgba16') {
    const native = floatToRgba16(cpuCompositeRegionFloat(single, rect, state.hooks));
    state.native16Layers.push({ width: rect.width, height: rect.height, rgba: native });
    rendered = rgba16To8(native);
  } else rendered = cpuCompositeRegion(single, rect, state.hooks);
  return { data: imageDataFromBytes(rendered, rect.width, rect.height, state.bits), left: rect.x, top: rect.y,
    right: rect.x + rect.width, bottom: rect.y + rect.height };
}

function gradient(value: { readonly stops: readonly { offset: number; color: { red: number; green: number; blue: number }; opacity: number }[] },
  name = 'Fernwork Gradient'): EffectSolidGradient {
  const stops = value.stops.length ? [...value.stops].sort((a, b) => a.offset - b.offset) : [
    { offset: 0, color: { red: 0, green: 0, blue: 0 }, opacity: 1 },
    { offset: 1, color: { red: 1, green: 1, blue: 1 }, opacity: 1 },
  ];
  return { name, type: 'solid', smoothness: 1,
    colorStops: stops.map((stop) => ({ color: color(stop.color), location: clamp01(stop.offset), midpoint: 0.5 })),
    opacityStops: stops.map((stop) => ({ opacity: clamp01(stop.opacity), location: clamp01(stop.offset), midpoint: 0.5 })) };
}

function vectorPaint(fill: FillParameters, state: State, path: string): VectorContent | null {
  if (fill.kind === 'solid') return { type: 'color', color: color(fill.color) };
  if (fill.kind === 'gradient') return { ...gradient(fill), angle: fill.angle, style: 'linear', scale: 1 };
  notice(state, 'pattern-fill', 'Pattern paint was rasterized because the PSD pattern resource is not available.', 'editability-only', path);
  return null;
}

function bezier(paths: readonly VectorPath[], transform: LayerTransform): BezierPath[] {
  return paths.filter((path) => path.points.length > 0).map((path) => ({
    open: !path.closed, fillRule: path.fillRule === 'evenodd' ? 'even-odd' : 'non-zero', operation: 'combine',
    knots: path.points.map((point) => ({ linked: point.kind === 'smooth', points: [
      point.in.x + transform.origin.x, point.in.y + transform.origin.y,
      point.anchor.x + transform.origin.x, point.anchor.y + transform.origin.y,
      point.out.x + transform.origin.x, point.out.y + transform.origin.y,
    ] })),
  }));
}

function effectFill(value: LayerEffect & { readonly kind: 'gradientOverlay' }) {
  return gradient({ stops: value.gradient.stops });
}

const LINEAR_CONTOUR = { name: 'Linear', curve: [{ x: 0, y: 0 }, { x: 255, y: 255 }] };

function effectPattern(effect: LayerEffect & { readonly kind: 'patternOverlay' }, state: State,
  path: string): { name: string; id: string } | undefined {
  const resource = state.resources.get(effect.resourceId);
  const validDimensions = Number.isInteger(effect.patternWidth) && Number.isInteger(effect.patternHeight)
    && effect.patternWidth > 0 && effect.patternHeight > 0;
  if (!resource || resource.role !== 'pattern' || !validDimensions
    || resource.bytes.length !== effect.patternWidth * effect.patternHeight * 4) {
    notice(state, 'pattern-overlay-resource',
      'Pattern Overlay was not written as editable because its RGBA8 document pattern resource is missing or invalid.',
      'editability-only', path);
    return undefined;
  }
  const id = `fernwork-${effect.patternWidth}x${effect.patternHeight}-${sha256Hex(resource.bytes).slice(0, 32)}`;
  if (!state.patterns.some((pattern) => pattern.id === id)) state.patterns.push({
    name: effect.resourceId, id, x: 0, y: 0,
    bounds: { x: 0, y: 0, w: effect.patternWidth, h: effect.patternHeight }, data: resource.bytes.slice(),
  });
  return { name: effect.resourceId, id };
}

function effects(values: readonly LayerEffect[], state: State, path: string): LayerEffectsInfo | undefined {
  if (!values.length) return undefined;
  const result: LayerEffectsInfo = { scale: 1 };
  for (const effect of values) switch (effect.kind) {
    case 'dropShadow': (result.dropShadow ??= []).push({ present: true, enabled: effect.enabled,
      opacity: clamp01(effect.opacity), angle: effect.angle, useGlobalLight: effect.useGlobalLight ?? false,
      distance: pixelsUnit(effect.distance), size: pixelsUnit(effect.size ?? effect.blur), choke: pixelsUnit(effect.spread ?? 0),
      color: color(effect.color), blendMode: BLENDS[effect.blendMode ?? 'multiply'], layerConceals: effect.knockout ?? true }); break;
    case 'outerGlow': result.outerGlow = { present: true, enabled: effect.enabled, opacity: clamp01(effect.opacity),
      size: pixelsUnit(effect.size), choke: pixelsUnit(effect.spread), color: color(effect.color), blendMode: BLENDS[effect.blendMode],
      source: 'edge', noise: 0 }; break;
    case 'colorOverlay': (result.solidFill ??= []).push({ present: true, enabled: effect.enabled,
      opacity: clamp01(effect.opacity), color: color(effect.color), blendMode: BLENDS[effect.blendMode ?? 'normal'] }); break;
    case 'gradientOverlay': (result.gradientOverlay ??= []).push({ present: true, enabled: effect.enabled,
      opacity: clamp01(effect.opacity), blendMode: BLENDS[effect.blendMode], angle: effect.angle, scale: effect.scale / 100,
      type: 'linear', reverse: effect.gradient.reverse ?? false, gradient: effectFill(effect) }); break;
    case 'innerShadow': (result.innerShadow ??= []).push({ present: true, enabled: effect.enabled,
      opacity: clamp01(effect.opacity), blendMode: BLENDS[effect.blendMode], color: color(effect.color), angle: effect.angle,
      useGlobalLight: effect.useGlobalLight, distance: pixelsUnit(effect.distance), choke: pixelsUnit(effect.choke),
      size: pixelsUnit(effect.size), contour: LINEAR_CONTOUR }); break;
    case 'innerGlow': result.innerGlow = { present: true, enabled: effect.enabled, opacity: clamp01(effect.opacity),
      blendMode: BLENDS[effect.blendMode], color: color(effect.color), source: effect.source, technique: 'softer',
      choke: pixelsUnit(effect.choke), size: pixelsUnit(effect.size), contour: LINEAR_CONTOUR, noise: 0, range: 1 }; break;
    case 'bevelEmboss': result.bevel = { present: true, enabled: effect.enabled,
      style: effect.style === 'innerBevel' ? 'inner bevel' : effect.style === 'outerBevel' ? 'outer bevel'
        : effect.style === 'pillowEmboss' ? 'pillow emboss' : 'emboss',
      technique: effect.technique === 'chiselHard' ? 'chisel hard' : effect.technique === 'chiselSoft' ? 'chisel soft' : 'smooth',
      strength: effect.depth / 100, direction: effect.direction, size: pixelsUnit(effect.size), soften: pixelsUnit(effect.soften),
      angle: effect.angle, altitude: effect.altitude, useGlobalLight: effect.useGlobalLight,
      highlightBlendMode: BLENDS[effect.highlightMode], highlightColor: color(effect.highlightColor),
      highlightOpacity: clamp01(effect.highlightOpacity), shadowBlendMode: BLENDS[effect.shadowMode],
      shadowColor: color(effect.shadowColor), shadowOpacity: clamp01(effect.shadowOpacity), contour: LINEAR_CONTOUR,
      useTexture: false, useShape: false }; break;
    case 'satin': result.satin = { present: true, enabled: effect.enabled, opacity: clamp01(effect.opacity),
      blendMode: BLENDS[effect.blendMode], color: color(effect.color), angle: effect.angle,
      distance: pixelsUnit(effect.distance), size: pixelsUnit(effect.size), invert: effect.invert,
      contour: LINEAR_CONTOUR }; break;
    case 'patternOverlay': {
      const pattern = effectPattern(effect, state, path);
      if (pattern) result.patternOverlay = { present: true, enabled: effect.enabled, opacity: clamp01(effect.opacity),
        blendMode: BLENDS[effect.blendMode], scale: effect.scale / 100, pattern, phase: effect.phase ?? { x: 0, y: 0 },
        align: effect.linkWithLayer, angle: effect.angle } as NonNullable<LayerEffectsInfo['patternOverlay']> & { angle: number };
      break;
    }
    case 'stroke': {
      const fill = effect.fill ?? (effect.color ? { kind: 'color' as const, color: effect.color } : null);
      result.stroke ??= [];
      if (fill?.kind === 'gradient') result.stroke.push({ present: true, enabled: effect.enabled, size: pixelsUnit(effect.width),
        position: effect.position, fillType: 'gradient', gradient: { ...gradient(fill.gradient), angle: fill.angle, style: 'linear', scale: fill.scale / 100 },
        opacity: clamp01(effect.opacity ?? 1), blendMode: BLENDS[effect.blendMode ?? 'normal'] });
      else result.stroke.push({ present: true, enabled: effect.enabled, size: pixelsUnit(effect.width), position: effect.position,
        fillType: 'color', color: color(fill?.kind === 'color' ? fill.color : { red: 0, green: 0, blue: 0 }),
        opacity: clamp01(effect.opacity ?? 1), blendMode: BLENDS[effect.blendMode ?? 'normal'] });
      break;
    }
  }
  return result;
}

function grayscaleTransferAdjustment(value: Extract<LayerAdjustment, { kind: 'Levels' | 'Curves' }>): AgAdjustment {
  const decode = (sample: number) => Math.max(0, srgbToLinear(sample)) ** (1 / 2.2);
  const encode = (sample: number) => Math.min(1, Math.max(0, linearToSrgb(Math.min(1, Math.max(0, sample)) ** 2.2)));
  const rgb = Array.from({ length: 256 }, (_, input) => {
    const gray = decode(input / 255);
    const adjusted = value.kind === 'Levels' ? levelValue(gray, value.parameters, 'Red')
      : curveValue(curveValue(gray * 255, value.parameters, 1), value.parameters, 0) / 255;
    return { input, output: Math.round(encode(adjusted) * 255) };
  });
  const identity = [{ input: 0, output: 0 }, { input: 255, output: 255 }];
  return { type: 'curves', rgb, red: identity, green: identity, blue: identity };
}

function adjustment(value: LayerAdjustment, state: State, path: string): AgAdjustment | null {
  if ((value.kind === 'Invert' || value.kind === 'Posterize' || value.kind === 'Threshold')
    && (value as LayerAdjustment & { readonly psdColorMode?: number }).psdColorMode === 1) {
    notice(state, 'adjustment-grayscale-transfer',
      `“${value.kind}” was rasterized because the RGB PSD writer cannot encode its source gray-profile transfer.`,
      'editability-only', path);
    return null;
  }
  if ((value.kind === 'Levels' || value.kind === 'Curves')
    && (value as LayerAdjustment & { readonly psdColorMode?: number }).psdColorMode === 1) {
    notice(state, 'adjustment-grayscale-transfer',
      `“${value.kind}” was converted to an editable RGB Curves transfer because the PSD writer emits RGB documents.`,
      'approximated', path);
    return grayscaleTransferAdjustment(value);
  }
  switch (value.kind) {
    case 'Levels': { const p = value.parameters; const [rgb, red, green, blue] = p.ranges.map((range) => ({ shadowInput: range.black,
      highlightInput: range.white, shadowOutput: range.outputBlack, highlightOutput: range.outputWhite,
      midtoneInput: range.gamma })); return { type: 'levels', rgb, red, green, blue }; }
    case 'Curves': { const p = value.parameters; const map = (points: readonly { x: number; y: number }[]) => points.map((point) => ({ input: point.x, output: point.y }));
      return { type: 'curves', rgb: map(p.channels[0] ?? []), red: map(p.channels[1] ?? []),
        green: map(p.channels[2] ?? []), blue: map(p.channels[3] ?? []) }; }
    case 'Exposure': { const p = value.parameters; return { type: 'exposure', exposure: p.exposure, offset: p.offset, gamma: p.gamma }; }
    case 'Hue/Saturation': { const p = value.parameters; const names = ['Master', 'Reds', 'Yellows', 'Greens', 'Cyans', 'Blues', 'Magentas'] as const;
      const values = names.map((name) => { const a = p.settings.adjustments[name] ?? { hue: 0, saturation: 0, lightness: 0 };
        const band = p.settings.bands[name] ?? { falloffStart: 0, rangeStart: 0, rangeEnd: 0, falloffEnd: 0 };
        return p.colorize && name === 'Master' ? { a: 256, b: p.hue, c: p.saturation, d: p.lightness, hue: 0, saturation: 0, lightness: 0 }
          : { a: band.falloffStart, b: band.rangeStart, c: band.rangeEnd, d: band.falloffEnd, ...a }; });
      return { type: 'hue/saturation', master: values[0], reds: values[1], yellows: values[2], greens: values[3],
        cyans: values[4], blues: values[5], magentas: values[6] }; }
    case 'Gradient Map': { const p = value.parameters; return { type: 'gradient map', name: 'Fernwork Gradient Map', gradientType: 'solid', reverse: p.reversed,
      colorStops: [{ color: color(p.shadows), location: 0, midpoint: 0.5 }, { color: color(p.highlights), location: 1, midpoint: 0.5 }],
      opacityStops: [{ opacity: 1, location: 0, midpoint: 0.5 }, { opacity: 1, location: 1, midpoint: 0.5 }] }; }
    case 'Basic': {
      const p = value.parameters;
      const unsupported = Object.entries(p).some(([key, number]) => !['vibrance', 'saturation'].includes(key) && number !== 0);
      if (!unsupported) return { type: 'vibrance', vibrance: p.vibrance, saturation: p.saturation };
      break;
    }
    case 'Colour': {
      const p = value.parameters;
      const enabled = Number(p.blackAndWhite.enabled) + Number(p.colourBalance.enabled)
        + Number(Object.keys(p.selectiveColour.ranges).length > 0);
      if (enabled === 1 && p.blackAndWhite.enabled) return { type: 'black & white', reds: p.blackAndWhite.reds,
        yellows: p.blackAndWhite.yellows, greens: p.blackAndWhite.greens, cyans: p.blackAndWhite.cyans,
        blues: p.blackAndWhite.blues, magentas: p.blackAndWhite.magentas, useTint: p.blackAndWhite.tint,
        tintColor: color(p.blackAndWhite.tintColor) };
      if (enabled === 1 && p.colourBalance.enabled) return { type: 'color balance', shadows: p.colourBalance.shadows,
        midtones: p.colourBalance.midtones, highlights: p.colourBalance.highlights,
        preserveLuminosity: p.colourBalance.preserveLuminosity };
      if (enabled === 1) return { type: 'selective color', mode: p.selectiveColour.mode,
        ...Object.fromEntries(Object.entries(p.selectiveColour.ranges).map(([name, values]) => [name.toLowerCase(), values])) } as AgAdjustment;
      break;
    }
    case 'Colour Lookup': { const p = value.parameters; const resource = state.resources.get(p.resourceId);
      if (resource) return { type: 'color lookup', lookupType: '3dlut', lutFormat: 'cube',
        lut3DFileName: 'Fernwork.cube', lut3DFileData: resource.bytes.slice() }; break; }
    case 'Invert': return { type: 'invert' };
    case 'Threshold': { const p = value.parameters; return { type: 'threshold', level: p.level }; }
    case 'Posterize': { const p = value.parameters; return { type: 'posterize', levels: p.levels }; }
    case 'Brightness/Contrast': { const p = value.parameters; return { type: 'brightness/contrast', brightness: p.brightness, contrast: p.contrast, useLegacy: p.legacy }; }
    case 'Photo Filter': { const p = value.parameters; return { type: 'photo filter', color: color(p.color), density: p.density, preserveLuminosity: p.preserveLuminosity }; }
    case 'Channel Mixer': { const p = value.parameters; return { type: 'channel mixer', monochrome: p.monochrome, red: p.red, green: p.green, blue: p.blue, gray: p.gray }; }
    case 'Grain': break;
  }
  notice(state, `adjustment:${value.kind}`, `“${value.kind}” has no lossless Photoshop adjustment descriptor and was rasterized.`,
    'editability-only', path);
  return null;
}

function textData(layer: TextLayer, transform: LayerTransform): LayerTextData {
  const text = layer.text.replace(/\n/g, '\r');
  const styleRuns = layer.runs.map((run) => ({ length: run.to - run.from, style: {
    font: { name: run.style.fontFamily }, fontSize: run.style.fontSize, fauxBold: run.style.fontWeight >= 600,
    fauxItalic: run.style.fontStyle !== 'normal', fillColor: color(run.style.color), tracking: run.style.tracking,
    autoKerning: run.style.kerning !== 'none', autoLeading: run.style.leading === null,
    ...(run.style.leading === null ? {} : { leading: run.style.leading }), baselineShift: run.style.baselineShift,
    ligatures: run.style.features.liga !== false, dLigatures: run.style.features.dlig === true,
  } }));
  const paragraphStyleRuns = layer.paragraphs.map((paragraph) => ({ length: paragraph.to - paragraph.from, style: {
    justification: paragraph.style.alignment === 'justify' ? 'justify-left' as const : paragraph.style.alignment,
    firstLineIndent: paragraph.style.firstLineIndent, startIndent: paragraph.style.startIndent,
    endIndent: paragraph.style.endIndent, spaceBefore: paragraph.style.spaceBefore, spaceAfter: paragraph.style.spaceAfter,
  } }));
  return { text, transform: [1, 0, 0, 1, transform.origin.x, transform.origin.y], orientation: 'horizontal', antiAlias: 'smooth',
    shapeType: layer.box ? 'box' : 'point', ...(layer.box ? { boxBounds: [0, 0, layer.box.width, layer.box.height] } : {}),
    styleRuns, paragraphStyleRuns, style: styleRuns[0]?.style, paragraphStyle: paragraphStyleRuns[0]?.style,
    ...(layer.textWarp ? { warp: { style: layer.textWarp.style, value: layer.textWarp.bend,
      perspective: layer.textWarp.horizontalDistortion, perspectiveOther: layer.textWarp.verticalDistortion,
      rotate: layer.textWarp.orientation } } : {}) };
}

function layerMask(layer: Layer, state: State) {
  if (!layer.mask) return undefined;
  const transform = state.hooks.maskPlacement(layer) ?? state.hooks.transform(layer);
  const raster = state.hooks.maskRaster(layer) ?? layer.mask.raster;
  return { left: Math.floor(transform.origin.x), top: Math.floor(transform.origin.y),
    right: Math.ceil(transform.origin.x + transform.size.width), bottom: Math.ceil(transform.origin.y + transform.size.height),
    defaultColor: (layer as Layer & { readonly psdMaskDefault?: number }).psdMaskDefault ?? 0,
    disabled: !layer.mask.enabled, positionRelativeToLayer: false, imageData: maskImage(raster, state.bits),
    ...(layer.vectorMask?.density === undefined ? {} : { vectorMaskDensity: layer.vectorMask.density }),
    ...(layer.vectorMask?.feather === undefined ? {} : { vectorMaskFeather: layer.vectorMask.feather }),
  };
}

function placed(layer: Extract<Layer, { kind: 'embedded' }>, transform: LayerTransform, state: State, path: string) {
  const width = layer.content.width ?? layer.raster?.width ?? transform.size.width;
  const height = layer.content.height ?? layer.raster?.height ?? transform.size.height;
  const hash = layer.content.sha256 ?? sha256Hex(new TextEncoder().encode(`${layer.id}:${layer.content.sourceName}`));
  const hex = hash.padEnd(32, '0').replace(/[^0-9a-f]/gi, '0').slice(0, 32).toLowerCase();
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  const corners = [
    transform.origin.x, transform.origin.y, transform.origin.x + transform.size.width, transform.origin.y,
    transform.origin.x + transform.size.width, transform.origin.y + transform.size.height,
    transform.origin.x, transform.origin.y + transform.size.height,
  ];
  const quad = layer.warp?.kind === 'quad' ? layer.warp.corners.flatMap((point) => [point.x, point.y]) : null;
  const resource = layer.content.assetId ? state.resources.get(layer.content.assetId) : undefined;
  if (layer.content.mode === 'embedded' && resource) state.linkedFiles.push({ id, name: layer.content.sourceName, data: resource.bytes.slice() });
  else if (layer.content.mode === 'linked' && layer.content.uri) state.linkedFiles.push({ id, name: layer.content.sourceName,
    linkedFile: { fileSize: resource?.bytes.length ?? 0, name: layer.content.sourceName, fullPath: layer.content.uri,
      originalPath: layer.content.uri, relativePath: layer.content.uri } });
  else notice(state, 'placed-source', 'Placed-layer metadata was retained, but its original source bytes/path were unavailable.',
    'editability-only', path);
  return { id, placed: id, type: layer.content.mediaType === 'svg' || layer.content.mediaType === 'pdf' ? 'vector' as const : 'raster' as const,
    // Photoshop stores a perspective quad as the placed corners themselves (Trnf and the non-affine copy); a mesh goes in the warp.
    pageNumber: (layer.content.page ?? 0) + 1, totalPages: 1, transform: quad ?? corners, nonAffineTransform: quad ?? undefined,
    warp: layer.warp?.kind === 'mesh' ? meshWarpToPsd(layer.warp, transform, width, height)
      : { style: 'none' as const, value: 0, perspective: 0, perspectiveOther: 0, rotate: 'horizontal' as const },
    width, height, resolution: { units: 'Density' as const, value: state.document.resolution } };
}

function common(layer: Layer, path: string, state: State): AgLayer {
  const placement = rasterizedLayer(layer, path, state), locks = layer.locks.all
    ? { transparency: true, composite: true, position: true }
    : { transparency: layer.locks.transparency, composite: layer.locks.pixels, position: layer.locks.position };
  const output: AgLayer = { name: layer.name, hidden: !layer.visible, opacity: clamp01(layer.opacity), fillOpacity: clamp01(layer.fillOpacity),
    blendMode: BLENDS[state.hooks.blendMode(layer)], transparencyProtected: layer.locks.transparency || layer.locks.all,
    protected: locks, layerColor: layer.colorLabel, clipping: !!layer.maskSourceId, effects: effects(layer.effects, state, path),
    mask: layerMask(layer, state), left: placement.left, top: placement.top, right: placement.right, bottom: placement.bottom,
    ...(placement.data ? { imageData: placement.data } : {}) };
  if (layer.vectorMask) output.vectorMask = { invert: layer.vectorMask.inverted, disable: !layer.vectorMask.enabled,
    notLink: false, fillStartsWithAllPixels: layer.vectorMask.inverted,
    paths: bezier(layer.vectorMask.paths, state.hooks.transform(layer)) };
  if (layer.filters.length) notice(state, 'live-filters', 'Live filters were baked into the layer pixels; Photoshop filter parameters are unavailable.',
    'editability-only', path);
  if (layer.crop) notice(state, 'non-destructive-crop',
    'The non-destructive crop was baked into layer pixels because PSD has no equivalent editable layer crop.', 'editability-only', path);
  if (layer.warp && layer.kind !== 'embedded') notice(state, 'parametric-warp',
    'Warp appearance was baked into layer pixels.', 'editability-only', path);
  return output;
}

function convertLayer(layer: Layer, path: string, children: AgLayer[], state: State): AgLayer {
  if (layer.kind === 'group') {
    const blendMode = state.hooks.blendMode(layer);
    const isolated = (layer as Layer & { readonly psdIsolated?: boolean }).psdIsolated === true
      || layer.opacity !== 1 || layer.fillOpacity !== 1 || blendMode !== 'normal';
    const output = common(layer, path, state);
    delete output.imageData;
    output.children = children;
    output.blendMode = isolated ? BLENDS[blendMode] : 'pass through';
    const knockout = (layer as Layer & { readonly psdKnockout?: 'shallow' | 'deep' | boolean }).psdKnockout;
    output.knockout = !!knockout;
    if (knockout) {
      output.id = state.nextNativeLayerId++;
      state.knockoutModes.set(output.id, knockout === 'shallow' ? 'shallow' : 'deep');
    }
    const artboard = (layer as Layer & { readonly psdArtboardRect?: Rect }).psdArtboardRect;
    if (artboard) output.artboard = { rect: { top: artboard.y, left: artboard.x,
      bottom: artboard.y + artboard.height, right: artboard.x + artboard.width }, backgroundType: 3,
    presetName: 'Photoshop artboard' };
    return output;
  }
  const output = common(layer, path, state), transform = state.hooks.transform(layer);
  if (layer.kind === 'adjustment') {
    const mapped = adjustment(layer.adjustment, state, path);
    if (mapped) { output.adjustment = mapped; delete output.imageData; }
    else {
      // Photoshop has no native record for this adjustment. Store the CPU appearance through this point in the
      // layer stack so opening the file retains a visible result instead of an empty placeholder.
      const index = state.document.layers.indexOf(layer);
      const rendered = cpuCompositeRegion({ ...state.document, layers: state.document.layers.slice(0, index + 1) },
        { x: 0, y: 0, width: state.document.width, height: state.document.height }, state.hooks);
      output.imageData = imageDataFromBytes(rendered, state.document.width, state.document.height, state.bits);
      output.left = 0; output.top = 0; output.right = state.document.width; output.bottom = state.document.height;
      output.opacity = 1; output.fillOpacity = 1; output.blendMode = 'normal'; output.clipping = false;
      delete output.mask;
    }
  } else if (layer.kind === 'text') {
    if (layer.textPath) notice(state, 'text-path-rasterized',
      'Text on a path was rasterized because ag-psd exposes Photoshop text paths as read-only data.', 'editability-only', path);
    else output.text = textData(layer, layer.renderedTransform ?? transform);
    if (layer.runs.some((run) => Object.keys(run.style.axes).length > 0)) notice(state, 'text-variable-axes',
      'Variable-font axis values remain in the rendered text pixels but are not encoded by ag-psd.', 'editability-only', path);
  } else if (layer.kind === 'vector') {
    const generated = (layer as Layer & { readonly psdGeneratedStyle?: typeof layer.style }).psdGeneratedStyle ?? layer.style;
    if (generated.fill) output.vectorFill = vectorPaint(generated.fill, state, path) ?? undefined;
    if (generated.stroke) output.vectorStroke = { strokeEnabled: true, fillEnabled: !!generated.fill,
      lineWidth: pixelsUnit(generated.stroke.width), lineAlignment: generated.stroke.alignment,
      lineCapType: generated.stroke.cap ?? 'butt', lineJoinType: generated.stroke.join ?? 'miter',
      miterLimit: generated.stroke.miterLimit ?? 4, lineDashSet: generated.stroke.dash?.map(pixelsUnit),
      lineDashOffset: pixelsUnit(generated.stroke.dashOffset ?? 0), opacity: 1,
      content: vectorPaint(generated.stroke.paint ?? { kind: 'solid', schemaVersion: 1, color: generated.stroke.color }, state, path) ?? undefined };
    output.vectorMask = { fillStartsWithAllPixels: false, paths: bezier(layer.paths, transform) };
    if (generated.stroke?.startMarker && generated.stroke.startMarker !== 'none' || generated.stroke?.endMarker && generated.stroke.endMarker !== 'none') {
      notice(state, 'vector-markers', 'Vector line markers remain in rendered pixels but not in Photoshop shape metadata.', 'editability-only', path);
    }
  } else if (layer.kind === 'fill') {
    output.vectorFill = vectorPaint(layer.fill, state, path) ?? undefined;
    output.vectorMask = { fillStartsWithAllPixels: false, paths: bezier([{
      schemaVersion: 1, closed: true, fillRule: 'nonzero', points: [
        { anchor: { x: 0, y: 0 }, in: { x: 0, y: 0 }, out: { x: 0, y: 0 }, kind: 'corner' },
        { anchor: { x: transform.size.width, y: 0 }, in: { x: transform.size.width, y: 0 }, out: { x: transform.size.width, y: 0 }, kind: 'corner' },
        { anchor: { x: transform.size.width, y: transform.size.height }, in: { x: transform.size.width, y: transform.size.height }, out: { x: transform.size.width, y: transform.size.height }, kind: 'corner' },
        { anchor: { x: 0, y: transform.size.height }, in: { x: 0, y: transform.size.height }, out: { x: 0, y: transform.size.height }, kind: 'corner' },
      ],
    }], transform) };
  } else if (layer.kind === 'embedded') output.placedLayer = placed(layer, transform, state, path);
  return output;
}

function layerTree(document: CanvasDocument, state: State): AgLayer[] {
  const byParent = new Map<string | null, Layer[]>();
  for (const layer of document.layers) {
    const list = byParent.get(layer.parentId); if (list) list.push(layer); else byParent.set(layer.parentId, [layer]);
  }
  const walk = (parent: string | null, parentPath: string): AgLayer[] => (byParent.get(parent) ?? []).map((layer) => {
    const path = parentPath ? `${parentPath}/${layer.name}` : layer.name;
    return convertLayer(layer, path, layer.kind === 'group' ? walk(layer.id, path) : [], state);
  });
  const roots = walk(null, '');
  if (!(document.artboards?.length)) return roots;
  const membership = artboardMembership(document), rootModels = byParent.get(null) ?? [];
  const loose: AgLayer[] = [], grouped = new Map<string, AgLayer[]>();
  roots.forEach((root, index) => { const id = rootModels[index]?.id, board = id ? membership.get(id) : null;
    if (!board) loose.push(root); else { const list = grouped.get(board); if (list) list.push(root); else grouped.set(board, [root]); } });
  for (const board of document.artboards) {
    const children = grouped.get(board.id) ?? [];
    loose.push({ name: board.name, children, blendMode: 'pass through', layerColor: board.colorLabel, protected: { artboards: true },
      nameSource: 'artb', artboard: { rect: { top: board.rect.y, left: board.rect.x,
        bottom: board.rect.y + board.rect.height, right: board.rect.x + board.rect.width },
      backgroundType: board.background.alpha === 0 ? 3 : 4, color: color(board.background), presetName: 'Fernwork' } });
  }
  return loose;
}

function inferredDepth(document: CanvasDocument, hooks: CompositeHooks): 8 | 16 {
  return document.layers.some((layer) => (hooks.raster(layer) ?? layer.raster)?.format === 'rgba16') ? 16 : 8;
}

function validate(document: CanvasDocument, format: PsdWriteFormat): void {
  if (!Number.isInteger(document.width) || !Number.isInteger(document.height) || document.width < 1 || document.height < 1
    || document.width > PRO_MAX_SIDE || document.height > PRO_MAX_SIDE || document.width * document.height > PRO_MAX_PIXELS) {
    throw new RangeError(`Document size ${document.width}×${document.height} exceeds the Pro PSD/PSB limit`);
  }
  if (format === 'psd' && (document.width > 30_000 || document.height > 30_000)) {
    throw new RangeError('Documents larger than 30,000 pixels per side must be saved as PSB');
  }
}

/**
 * Encodes a layered PSD/PSB. The merged image is always produced independently by the product CPU compositor;
 * it is never reused as an oracle for writer tests (PRODUCT-PLAN M14).
 */
export function writePsdDocument(document: CanvasDocument, options: PsdWriteOptions = {}): PsdWriteResult {
  const format = options.format === 'psd' || options.format === 'psb' ? options.format
    : document.width > 30_000 || document.height > 30_000 ? 'psb' : 'psd';
  validate(document, format);
  const hooks = options.hooks ?? DEFAULT_HOOKS, bits = options.bitsPerChannel ?? inferredDepth(document, hooks);
  const state: State = { document, hooks, bits, notices: [], linkedFiles: [], native16Layers: [],
    patterns: [], nextNativeLayerId: 1, knockoutModes: new Map(),
    resources: new Map((document.resources ?? []).map((resource) => [resource.id, resource])) };
  const composite8 = cpuCompositeRegion(document, { x: 0, y: 0, width: document.width, height: document.height }, hooks);
  const psd: Psd = { width: document.width, height: document.height, bitsPerChannel: 8, colorMode: 3,
    imageData: imageDataFromBytes(composite8, document.width, document.height, bits), children: layerTree(document, state),
    imageResources: { resolutionInfo: { horizontalResolution: document.resolution, verticalResolution: document.resolution,
      horizontalResolutionUnit: 'PPI', verticalResolutionUnit: 'PPI', widthUnit: 'Inches', heightUnit: 'Inches' },
    globalAngle: document.globalLightAngle ?? 120, versionInfo: { hasRealMergedData: true,
      writerName: 'Fernwork Bildeditor', readerName: 'Fernwork Bildeditor', fileVersion: 1 },
    gridAndGuidesInformation: { guides: (document.guides ?? []).map((guide) => ({ location: guide.position,
      direction: guide.orientation })) } },
    ...(document.artboards?.length ? { artboards: { count: document.artboards.length, autoExpandEnabled: false,
      autoNestEnabled: true, autoPositionEnabled: false, shrinkwrapOnSaveEnabled: false,
      docDefaultNewArtboardBackgroundType: 1, docDefaultNewArtboardBackgroundColor: { r: 255, g: 255, b: 255 } } } : {}),
    ...(state.linkedFiles.length ? { linkedFiles: state.linkedFiles } : {}),
    ...(state.patterns.length ? { patterns: state.patterns } : {}) };
  let bytes = writePsdUint8Array(psd, { psb: format === 'psb', generateThumbnail: false, noBackground: true,
    trimImageData: false, invalidateTextLayers: false, logMissingFeatures: false, compress: format === 'psb' });
  if (bits === 16) {
    const composite16 = floatToRgba16(cpuCompositeRegionFloat(document,
      { x: 0, y: 0, width: document.width, height: document.height }, hooks));
    bytes = promotePsdTo16(bytes, composite16, state.native16Layers);
  } else bytes = replacePsdComposite(bytes, composite8);
  const profile = options.iccProfile === undefined ? srgbIccProfile() : options.iccProfile;
  if (profile) bytes = attachPsdIccProfile(bytes, profile);
  bytes = patchPsdLayerKnockouts(bytes, state.knockoutModes);
  return { bytes, format, bitsPerChannel: bits, notices: state.notices };
}

/** Exposed for tests and host save dispatch without parsing output bytes. */
export function psdFormatForName(name: string, document: Pick<CanvasDocument, 'width' | 'height'>): PsdWriteFormat {
  if (/\.psb$/i.test(name)) return 'psb';
  if (/\.psd$/i.test(name)) return 'psd';
  return document.width > 30_000 || document.height > 30_000 ? 'psb' : 'psd';
}
