import { newLayer, type CanvasDocument, type Layer } from '../document';
import { apply, concat, pixelToDocument, placing, samePlacement, scaling, translation, type LayerTransform } from '../geometry';
import { mapPlacement, maskBackground, preparePlacement, prepareSampler, sampleMask } from '../resample';
import { TILE, type Raster } from '../raster';
import { renderEffectPasses, type EffectPass } from './render';

export interface EffectSourceHooks {
  transform(layer: Layer): LayerTransform;
  maskPlacement(layer: Layer): LayerTransform | null;
  raster(layer: Layer): Raster | null | undefined;
  maskRaster(layer: Layer): Raster | null | undefined;
}

export interface EffectRenderDiagnostics { effectRegenerations: number }

const cache = new WeakMap<Raster, Map<string, readonly EffectPass[]>>();
const expandedDocuments = new WeakMap<CanvasDocument, Map<string, CanvasDocument>>();

interface ResolvedEffectSource {
  readonly raster: Raster;
  readonly maskRaster: Raster | null;
  readonly transform: LayerTransform;
  readonly maskPlacement: LayerTransform | null;
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
  const placed = !samePlacement(placement, layerTransform), background = placed ? maskBackground(maskRaster) : 0;
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

function synthetic(source: Layer, effect: EffectPass, index: number, transform: LayerTransform): Layer {
  return newLayer({
    id: `${source.id}:effect:${effect.placement}:${index}`, name: `${source.name} effect`, kind: 'pixel',
    parentId: source.parentId, transform, raster: effect.raster, opacity: source.opacity * effect.opacity,
    fillOpacity: effect.scalesWithFillOpacity ? source.fillOpacity : 1, blendMode: effect.blendMode,
  });
}

/** Expands live styles to ordinary immutable layers consumed identically by CPU and WebGL compositors. */
export function documentWithLayerEffects(document: CanvasDocument, hooks: EffectSourceHooks,
  diagnostics?: EffectRenderDiagnostics): CanvasDocument {
  if (!document.layers.some((layer) => layer.effects.some((effect) => effect.enabled))) return document;
  const resolved = new Map<Layer, ResolvedEffectSource>();
  let sourceKey = '';
  for (const layer of document.layers) {
    if (!layer.visible || !layer.effects.some((effect) => effect.enabled)) { sourceKey += ';'; continue; }
    const raster = hooks.raster(layer);
    if (!raster || raster.channels !== 4) { sourceKey += `${raster?.serial ?? 0};`; continue; }
    const source: ResolvedEffectSource = {
      raster,
      maskRaster: layer.mask?.enabled ? hooks.maskRaster(layer) ?? null : null,
      transform: hooks.transform(layer),
      maskPlacement: hooks.maskPlacement(layer),
    };
    resolved.set(layer, source);
    sourceKey += `${raster.serial}/${source.maskRaster?.serial ?? 0}/${placementKey(source.transform)}/${placementKey(source.maskPlacement)};`;
  }
  const cachedDocuments = expandedDocuments.get(document);
  const cachedDocument = cachedDocuments?.get(sourceKey);
  if (cachedDocument) return cachedDocument;

  const layers: Layer[] = [];
  for (const layer of document.layers) {
    const source = resolved.get(layer);
    if (!source) { layers.push(layer); continue; }
    const { raster, transform } = source;
    const key = `${JSON.stringify(layer.effects)}|${document.globalLightAngle ?? 120}|${source.maskRaster?.serial ?? 0}`
      + `|${placementKey(transform)}|${placementKey(source.maskPlacement)}`;
    let variants = cache.get(raster);
    if (!variants) { variants = new Map(); cache.set(raster, variants); }
    let passes = variants.get(key);
    if (!passes) {
      passes = renderEffectPasses(effectAlpha(layer, source), raster.width, raster.height, layer.effects,
        { globalLightAngle: document.globalLightAngle });
      if (diagnostics) diagnostics.effectRegenerations++;
      if (variants.size >= 8) variants.delete(variants.keys().next().value as string);
      variants.set(key, passes);
    }
    const behind = passes.filter((value) => value.placement === 'behind');
    const above = passes.filter((value) => value.placement === 'above');
    for (let i = 0; i < behind.length; i++) layers.push(synthetic(layer, behind[i]!, i,
      passTransform(transform, raster.width, raster.height, behind[i]!)));
    layers.push({ ...layer, effects: [] });
    for (let i = 0; i < above.length; i++) layers.push(synthetic(layer, above[i]!, i,
      passTransform(transform, raster.width, raster.height, above[i]!)));
  }
  const expanded = { ...document, layers };
  const variants = cachedDocuments ?? new Map<string, CanvasDocument>();
  if (variants.size >= 8) variants.delete(variants.keys().next().value as string);
  variants.set(sourceKey, expanded);
  if (!cachedDocuments) expandedDocuments.set(document, variants);
  return expanded;
}
