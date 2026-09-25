import { newLayer, type CanvasDocument, type Layer } from '../document';
import { apply, concat, pixelToDocument, placing, samePlacement, scaling, translation, type LayerTransform, type Point } from '../geometry';
import { mapPlacement, maskBackground, preparePlacement, prepareSampler, sampleMask } from '../resample';
import { Raster, TILE } from '../raster';
import { renderEffectPasses, renderPsdInnerEffectPasses, type EffectPass, type PsdInnerEffect } from './render';
import { homography } from '../distort';
import { meshPoint } from '../meshWarp';

export interface EffectSourceHooks {
  transform(layer: Layer): LayerTransform;
  maskPlacement(layer: Layer): LayerTransform | null;
  raster(layer: Layer): Raster | null | undefined;
  maskRaster(layer: Layer): Raster | null | undefined;
}

export interface EffectRenderDiagnostics { effectRegenerations: number }

const cache = new WeakMap<Raster, Map<string, readonly EffectPass[]>>();
const expandedDocuments = new WeakMap<CanvasDocument, Map<string, CanvasDocument>>();

function effectRasterScale(raster: Raster, transform: LayerTransform): number {
  const sx = raster.width / Math.max(1e-9, transform.size.width);
  const sy = raster.height / Math.max(1e-9, transform.size.height);
  return Math.sqrt(sx * sy);
}

function rasterEffects(layer: Layer, scale: number): readonly import('../model').LayerEffect[] {
  if (Math.abs(scale - 1) < 1e-6) return layer.effects;
  // Effect records are document pixels. Text/vector/embedded caches can be oversampled, so their
  // distance fields must be converted to the cache grid before the pass is mapped back to the document.
  return layer.effects.map((effect) => effect.kind === 'stroke' ? { ...effect, width: effect.width * scale }
    : effect.kind === 'outerGlow' ? { ...effect, size: effect.size * scale }
      : effect.kind === 'dropShadow' ? { ...effect, distance: effect.distance * scale,
        blur: effect.blur * scale, ...(effect.size === undefined ? {} : { size: effect.size * scale }) }
        : effect);
}

interface ResolvedEffectSource {
  readonly raster: Raster;
  readonly maskRaster: Raster | null;
  readonly transform: LayerTransform;
  readonly maskPlacement: LayerTransform | null;
  readonly rasterScale: number;
}

interface PsdPatternOverlay {
  readonly pattern: Raster;
  readonly opacity: number;
  readonly blendMode: Layer['blendMode'];
  readonly scale: number;
  readonly phase: { readonly x: number; readonly y: number };
  readonly align: boolean;
}

function psdPatternOverlays(layer: Layer): readonly PsdPatternOverlay[] {
  return (layer as Layer & { readonly psdPatternOverlays?: readonly PsdPatternOverlay[] }).psdPatternOverlays ?? [];
}

function psdInnerEffects(layer: Layer): readonly PsdInnerEffect[] {
  return (layer as Layer & { readonly psdInnerEffects?: readonly PsdInnerEffect[] }).psdInnerEffects ?? [];
}

function modulo(value: number, divisor: number): number { return ((value % divisor) + divisor) % divisor; }

/** PSD pattern resources are layer-owned inputs; this pass never reads the saved document composite. */
function patternPasses(alpha: Uint8Array, width: number, height: number, transform: LayerTransform,
  overlays: readonly PsdPatternOverlay[]): readonly EffectPass[] {
  if (!overlays.length) return [];
  const localToDocument = pixelToDocument(transform, width, height), output: EffectPass[] = [];
  for (const overlay of overlays) {
    const pattern = overlay.pattern.toPixels(), pixels = new Uint8Array(width * height * 4);
    const scale = Math.max(0.01, overlay.scale), layerBaseX = overlay.align ? transform.origin.x : 0;
    const layerBaseY = overlay.align ? transform.origin.y : 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const point = apply(localToDocument, { x: x + 0.5, y: y + 0.5 });
      const fx = (point.x - layerBaseX - overlay.phase.x) / scale - 0.5;
      const fy = (point.y - layerBaseY - overlay.phase.y) / scale - 0.5;
      const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
      const sample = (sx: number, sy: number, channel: number): number => pattern[
        (Math.floor(modulo(sy, overlay.pattern.height)) * overlay.pattern.width
          + Math.floor(modulo(sx, overlay.pattern.width))) * 4 + channel]!;
      const channel = (index: number): number => {
        const top = sample(x0, y0, index) + (sample(x0 + 1, y0, index) - sample(x0, y0, index)) * tx;
        const bottom = sample(x0, y0 + 1, index) + (sample(x0 + 1, y0 + 1, index) - sample(x0, y0 + 1, index)) * tx;
        return Math.round(top + (bottom - top) * ty);
      };
      const target = (y * width + x) * 4;
      pixels[target] = channel(0); pixels[target + 1] = channel(1); pixels[target + 2] = channel(2);
      pixels[target + 3] = Math.round(alpha[y * width + x]! * channel(3) / 255);
    }
    output.push({ placement: 'above', raster: Raster.fromPixels(width, height, 4, pixels), sourceX: 0, sourceY: 0,
      blendMode: overlay.blendMode, opacity: overlay.opacity, scalesWithFillOpacity: false });
  }
  return output;
}

function effectAlpha(layer: Layer, source: ResolvedEffectSource): Uint8Array {
  const { raster } = source;
  const alpha = new Uint8Array(raster.width * raster.height);
  for (let row = 0; row < raster.rows; row++) for (let col = 0; col < raster.cols; col++) {
    const tile = raster.tiles[row * raster.cols + col];
    if (!tile) continue;
    const width = raster.tileWidth(col), height = raster.tileHeight(row);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      alpha[(row * TILE + y) * raster.width + col * TILE + x] = Math.round(tile[(y * width + x) * 4 + 3]! * 255 / raster.maximum);
    }
  }
  const mask = layer.mask, maskRaster = mask?.enabled ? source.maskRaster : null;
  if (!mask || !maskRaster || maskRaster.channels !== 1) return alpha;
  const layerTransform = source.transform, placement = source.maskPlacement ?? layerTransform;
  const sourceToDocument = pixelToDocument(layerTransform, raster.width, raster.height);
  const sampler = prepareSampler(maskRaster, 'High quality', maskRaster.width);
  const prepared = preparePlacement({ ...placement, sampling: 'High quality' }, maskRaster.width, maskRaster.height);
  const placed = !samePlacement(placement, layerTransform), psdDefault =
    (layer as Layer & { readonly psdMaskDefault?: number }).psdMaskDefault;
  const background = placed ? psdDefault === undefined ? maskBackground(maskRaster) : psdDefault / 255 : 0;
  const location = new Float64Array(3);
  for (let y = 0; y < raster.height; y++) for (let x = 0; x < raster.width; x++) {
    const point = apply(sourceToDocument, { x: x + 0.5, y: y + 0.5 });
    mapPlacement(prepared, point.x, point.y, location);
    const sampled = sampleMask(sampler, location[0]!, location[1]!);
    const coverage = placed ? background + (sampled - background) * location[2]! : sampled;
    alpha[y * raster.width + x] = Math.round(alpha[y * raster.width + x]! * coverage);
  }
  return alpha;
}

function placementKey(transform: LayerTransform | null): string {
  if (!transform) return '-';
  return `${transform.origin.x},${transform.origin.y},${transform.size.width},${transform.size.height},${transform.rotation},`
    + `${transform.flipX ? 1 : 0},${transform.flipY ? 1 : 0},${transform.sampling}`;
}

function passTransform(source: LayerTransform, sourceWidth: number, sourceHeight: number, effect: EffectPass): LayerTransform {
  const sourceMap = pixelToDocument(source, sourceWidth, sourceHeight);
  const unitToEffect = concat(scaling(effect.raster.width, effect.raster.height), translation(effect.sourceX, effect.sourceY));
  return placing(source, concat(unitToEffect, sourceMap));
}

function effectWarp(source: Layer, effect: EffectPass, sourceWidth: number, sourceHeight: number): Layer['warp'] {
  if (!source.warp) return null;
  const left = effect.sourceX / sourceWidth, top = effect.sourceY / sourceHeight;
  const right = (effect.sourceX + effect.raster.width) / sourceWidth;
  const bottom = (effect.sourceY + effect.raster.height) / sourceHeight;
  if (source.warp.kind === 'mesh') {
    const columns = source.warp.splits.x * 3 + 1, rows = source.warp.splits.y * 3 + 1, points: Point[] = [];
    for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
      points.push(meshPoint(source.warp, { x: left + (right - left) * column / (columns - 1),
        y: top + (bottom - top) * row / (rows - 1) }));
    }
    return { ...source.warp, points };
  }
  const map = homography(source.warp.corners);
  return { kind: 'quad', schemaVersion: 1, corners: [map({ x: left, y: top }), map({ x: right, y: top }),
    map({ x: right, y: bottom }), map({ x: left, y: bottom })] };
}

function synthetic(source: Layer, effect: EffectPass, index: number, transform: LayerTransform,
  sourceWidth: number, sourceHeight: number): Layer {
  return newLayer({
    id: `${source.id}:effect:${effect.placement}:${index}`, name: `${source.name} effect`, kind: 'pixel',
    parentId: source.parentId, transform, raster: effect.raster, opacity: source.opacity * effect.opacity,
    fillOpacity: effect.scalesWithFillOpacity ? source.fillOpacity : 1, blendMode: effect.blendMode,
    warp: effectWarp(source, effect, sourceWidth, sourceHeight),
  });
}

/** Expands live styles to ordinary immutable layers consumed identically by CPU and WebGL compositors. */
export function documentWithLayerEffects(document: CanvasDocument, hooks: EffectSourceHooks,
  diagnostics?: EffectRenderDiagnostics): CanvasDocument {
  if (!document.layers.some((layer) => layer.effects.some((effect) => effect.enabled)
    || psdPatternOverlays(layer).length || psdInnerEffects(layer).length)) return document;
  const resolved = new Map<Layer, ResolvedEffectSource>();
  let sourceKey = '';
  for (const layer of document.layers) {
    if (!layer.visible || (!layer.effects.some((effect) => effect.enabled)
      && !psdPatternOverlays(layer).length && !psdInnerEffects(layer).length)) {
      sourceKey += ';'; continue;
    }
    const raster = hooks.raster(layer);
    if (!raster || raster.channels !== 4) { sourceKey += `${raster?.serial ?? 0};`; continue; }
    const transform = hooks.transform(layer);
    const source: ResolvedEffectSource = {
      raster,
      maskRaster: layer.mask?.enabled ? hooks.maskRaster(layer) ?? null : null,
      transform,
      maskPlacement: hooks.maskPlacement(layer),
      rasterScale: effectRasterScale(raster, transform),
    };
    resolved.set(layer, source);
    sourceKey += `${raster.serial}/${source.maskRaster?.serial ?? 0}/${source.rasterScale}/`
      + `${placementKey(source.transform)}/${placementKey(source.maskPlacement)};`;
  }
  const cachedDocuments = expandedDocuments.get(document);
  const cachedDocument = cachedDocuments?.get(sourceKey);
  if (cachedDocument) return cachedDocument;

  const layers: Layer[] = [];
  // Passes drawn above a layer go above its clipping stack: inserted between the base and the layers clipped to it,
  // they would break the stack and the clipped layers (adjustments) would stop applying.
  let pending: { readonly base: Layer; readonly passes: Layer[] } | null = null;
  const flush = () => { if (pending) layers.push(...pending.passes); pending = null; };
  for (const layer of document.layers) {
    if (pending && (layer.maskSourceId !== pending.base.id || layer.parentId !== pending.base.parentId)) flush();
    const source = resolved.get(layer);
    if (!source) { layers.push(layer); continue; }
    const { raster, transform } = source;
    const effects = rasterEffects(layer, source.rasterScale);
    const patterns = psdPatternOverlays(layer);
    const innerEffects = psdInnerEffects(layer);
    const key = `${JSON.stringify(effects)}|${JSON.stringify(innerEffects)}|${patterns.map((value) => `${value.pattern.serial}/${value.opacity}/${value.blendMode}/`
      + `${value.scale}/${value.phase.x}/${value.phase.y}/${value.align ? 1 : 0}`).join(',')}|${document.globalLightAngle ?? 120}|${source.maskRaster?.serial ?? 0}`
      + `|${placementKey(transform)}|${placementKey(source.maskPlacement)}`;
    let variants = cache.get(raster);
    if (!variants) { variants = new Map(); cache.set(raster, variants); }
    let passes = variants.get(key);
    if (!passes) {
      const alpha = effectAlpha(layer, source);
      passes = [...renderEffectPasses(alpha, raster.width, raster.height, effects,
        { globalLightAngle: document.globalLightAngle, rasterScale: source.rasterScale }),
      ...renderPsdInnerEffectPasses(alpha, raster.width, raster.height, innerEffects,
        { globalLightAngle: document.globalLightAngle, rasterScale: source.rasterScale }),
      ...patternPasses(alpha, raster.width, raster.height, transform, patterns)];
      if (diagnostics) diagnostics.effectRegenerations++;
      if (variants.size >= 8) variants.delete(variants.keys().next().value as string);
      variants.set(key, passes);
    }
    const behind = passes.filter((value) => value.placement === 'behind');
    const above = passes.filter((value) => value.placement === 'above');
    for (let i = 0; i < behind.length; i++) layers.push(synthetic(layer, behind[i]!, i,
      passTransform(transform, raster.width, raster.height, behind[i]!), raster.width, raster.height));
    layers.push({ ...layer, effects: [] });
    const abovePasses = above.map((pass, i) => synthetic(layer, pass, i, passTransform(transform, raster.width, raster.height, pass),
      raster.width, raster.height));
    if (layer.maskSourceId) layers.push(...abovePasses);
    else { flush(); pending = { base: layer, passes: abovePasses }; }
  }
  flush();
  const expanded = { ...document, layers };
  const variants = cachedDocuments ?? new Map<string, CanvasDocument>();
  if (variants.size >= 8) variants.delete(variants.keys().next().value as string);
  variants.set(sourceKey, expanded);
  if (!cachedDocuments) expandedDocuments.set(document, variants);
  return expanded;
}
