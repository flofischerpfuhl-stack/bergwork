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

const cache = new WeakMap<Raster, Map<string, readonly EffectPass[]>>();

function effectAlpha(layer: Layer, hooks: EffectSourceHooks, raster: Raster): Uint8Array {
  const alpha = new Uint8Array(raster.width * raster.height);
  for (let row = 0; row < raster.rows; row++) for (let col = 0; col < raster.cols; col++) {
    const tile = raster.tiles[row * raster.cols + col];
    if (!tile) continue;
    const width = raster.tileWidth(col), height = raster.tileHeight(row);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      alpha[(row * TILE + y) * raster.width + col * TILE + x] = Math.round(tile[(y * width + x) * 4 + 3]! * 255 / raster.maximum);
    }
  }
  const mask = layer.mask, maskRaster = mask?.enabled ? hooks.maskRaster(layer) : null;
  if (!mask || !maskRaster || maskRaster.channels !== 1) return alpha;
  const layerTransform = hooks.transform(layer), placement = hooks.maskPlacement(layer) ?? layerTransform;
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
export function documentWithLayerEffects(document: CanvasDocument, hooks: EffectSourceHooks): CanvasDocument {
  if (!document.layers.some((layer) => layer.effects.some((effect) => effect.enabled))) return document;
  const layers: Layer[] = [];
  for (const layer of document.layers) {
    const raster = hooks.raster(layer);
    if (!layer.visible || !raster || raster.channels !== 4 || !layer.effects.some((effect) => effect.enabled)) { layers.push(layer); continue; }
    const key = `${JSON.stringify(layer.effects)}|${document.globalLightAngle ?? 120}|${layer.mask?.enabled ? hooks.maskRaster(layer)?.serial ?? 0 : 0}`
      + `|${JSON.stringify(hooks.transform(layer))}|${JSON.stringify(hooks.maskPlacement(layer))}`;
    let variants = cache.get(raster);
    if (!variants) { variants = new Map(); cache.set(raster, variants); }
    let passes = variants.get(key);
    if (!passes) {
      passes = renderEffectPasses(effectAlpha(layer, hooks, raster), raster.width, raster.height, layer.effects,
        { globalLightAngle: document.globalLightAngle });
      if (variants.size >= 8) variants.delete(variants.keys().next().value as string);
      variants.set(key, passes);
    }
    const transform = hooks.transform(layer);
    const behind = passes.filter((value) => value.placement === 'behind');
    const above = passes.filter((value) => value.placement === 'above');
    for (let i = 0; i < behind.length; i++) layers.push(synthetic(layer, behind[i]!, i,
      passTransform(transform, raster.width, raster.height, behind[i]!)));
    layers.push({ ...layer, effects: [] });
    for (let i = 0; i < above.length; i++) layers.push(synthetic(layer, above[i]!, i,
      passTransform(transform, raster.width, raster.height, above[i]!)));
  }
  return { ...document, layers };
}
