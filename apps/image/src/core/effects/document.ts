import { descendantIds, newLayer, type CanvasDocument, type Layer } from '../document';
import { compositeRegion } from '../composite';
import { apply, concat, pixelToDocument, placing, samePlacement, scaling, translation, type LayerTransform, type Point } from '../geometry';
import { mapPlacement, maskBackground, preparePlacement, prepareSampler, sampleMask } from '../resample';
import { Raster, TILE } from '../raster';
import { renderEffectPasses, type EffectPass } from './render';
import { homography } from '../distort';
import { meshPoint } from '../meshWarp';
import { layerCropCoverage } from '../crop';

export interface EffectSourceHooks {
  transform(layer: Layer): LayerTransform;
  maskPlacement(layer: Layer): LayerTransform | null;
  raster(layer: Layer): Raster | null | undefined;
  maskRaster(layer: Layer): Raster | null | undefined;
}

export interface EffectRenderDiagnostics { effectRegenerations: number }

const cache = new WeakMap<Raster, Map<string, readonly EffectPass[]>>();
const expandedDocuments = new WeakMap<CanvasDocument, Map<string, CanvasDocument>>();
const resourceSerials = new WeakMap<Uint8Array, number>();
let nextResourceSerial = 1;

function resourceSerial(bytes: Uint8Array | undefined): number {
  if (!bytes) return 0;
  let serial = resourceSerials.get(bytes);
  if (!serial) { serial = nextResourceSerial++; resourceSerials.set(bytes, serial); }
  return serial;
}

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
      : effect.kind === 'innerShadow' ? { ...effect, distance: effect.distance * scale, size: effect.size * scale }
        : effect.kind === 'innerGlow' ? { ...effect, size: effect.size * scale }
          : effect.kind === 'bevelEmboss' ? { ...effect, size: effect.size * scale, soften: effect.soften * scale }
            : effect.kind === 'satin' ? { ...effect, distance: effect.distance * scale, size: effect.size * scale }
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

function shiftedTransform(value: LayerTransform, x: number, y: number): LayerTransform {
  return { ...value, origin: { x: value.origin.x - x, y: value.origin.y - y } };
}

/** A group style traces the unbounded child surface, not the document-clipped group preview. */
function groupEffectSource(document: CanvasDocument, group: Layer, hooks: EffectSourceHooks): ResolvedEffectSource | null {
  const ids = descendantIds(document.layers, group.id);
  const descendants = document.layers.filter((layer) => ids.has(layer.id));
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const layer of descendants) {
    const raster = hooks.raster(layer);
    if (!layer.visible || layer.kind === 'group' || layer.adjustment || !raster || raster.channels !== 4) continue;
    const transform = hooks.transform(layer), map = pixelToDocument(transform, raster.width, raster.height);
    for (const point of [{ x: 0, y: 0 }, { x: raster.width, y: 0 },
      { x: raster.width, y: raster.height }, { x: 0, y: raster.height }]) {
      const placed = apply(map, point);
      left = Math.min(left, placed.x); top = Math.min(top, placed.y);
      right = Math.max(right, placed.x); bottom = Math.max(bottom, placed.y);
    }
  }
  if (!Number.isFinite(left)) return null;
  left = Math.floor(left); top = Math.floor(top); right = Math.ceil(right); bottom = Math.ceil(bottom);
  const width = Math.max(1, right - left), height = Math.max(1, bottom - top);
  const originals = new Map(descendants.map((layer) => [layer.id, layer]));
  const layers = descendants.map((layer) => ({ ...layer,
    parentId: layer.parentId === group.id ? null : layer.parentId,
    transform: shiftedTransform(hooks.transform(layer), left, top),
    mask: layer.mask ? { ...layer.mask, placement: (hooks.maskPlacement(layer) ?? layer.mask.placement)
      ? shiftedTransform((hooks.maskPlacement(layer) ?? layer.mask.placement)!, left, top) : null } : null,
    effects: [],
  }));
  const local: CanvasDocument = { ...document, id: `${document.id}:${group.id}:effect-source`, width, height,
    layers, selection: null };
  const rendered = compositeRegion(local, { x: 0, y: 0, width, height }, {
    transform: (layer) => layer.transform,
    maskPlacement: (layer) => layer.mask?.placement ?? null,
    raster: (layer) => hooks.raster(originals.get(layer.id) ?? layer),
    maskRaster: (layer) => hooks.maskRaster(originals.get(layer.id) ?? layer),
  }).rgba;
  return { raster: Raster.fromPixels(width, height, 4, rendered), maskRaster: null,
    transform: { ...group.transform, origin: { x: left, y: top }, size: { width, height },
      rotation: 0, flipX: false, flipY: false }, maskPlacement: null, rasterScale: 1 };
}

function modulo(value: number, divisor: number): number { return ((value % divisor) + divisor) % divisor; }

/** Pattern resources are document-owned raw RGBA8 inputs; imported PSD and user patterns share this path. */
function patternPasses(alpha: Uint8Array, width: number, height: number, transform: LayerTransform,
  overlays: readonly Extract<import('../model').LayerEffect, { kind: 'patternOverlay' }>[],
  resources: CanvasDocument['resources']): readonly EffectPass[] {
  if (!overlays.length) return [];
  const localToDocument = pixelToDocument(transform, width, height), output: EffectPass[] = [];
  for (const overlay of overlays) {
    const resource = resources?.find((value) => value.id === overlay.resourceId && value.role === 'pattern');
    if (!resource || resource.bytes.length !== overlay.patternWidth * overlay.patternHeight * 4) continue;
    const pattern = resource.bytes, pixels = new Uint8Array(width * height * 4);
    const scale = Math.max(0.01, overlay.scale / 100), layerBaseX = overlay.linkWithLayer ? transform.origin.x : 0;
    const layerBaseY = overlay.linkWithLayer ? transform.origin.y : 0;
    const radians = overlay.angle * Math.PI / 180, cos = Math.cos(radians), sin = Math.sin(radians);
    const phase = overlay.phase ?? { x: 0, y: 0 };
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const point = apply(localToDocument, { x: x + 0.5, y: y + 0.5 });
      const px = point.x - layerBaseX - phase.x, py = point.y - layerBaseY - phase.y;
      // Photoshop's pattern-effect grid is edge-aligned horizontally and row-centre-aligned vertically.
      // patterns.psd pins the distinct scaled-origin compensation at 200%; both vanish at 100%.
      const phaseCorrection = scale - 1;
      const fx = (px * cos - py * sin - 0.5) / scale - phaseCorrection;
      const fy = (px * sin + py * cos - 0.5) / scale - phaseCorrection / 2;
      const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
      const sample = (sx: number, sy: number, channel: number): number => pattern[
        (Math.floor(modulo(sy, overlay.patternHeight)) * overlay.patternWidth
          + Math.floor(modulo(sx, overlay.patternWidth))) * 4 + channel]!;
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
      blendMode: overlay.blendMode, opacity: overlay.opacity, scalesWithFillOpacity: false, stackOrder: 4 });
  }
  return output;
}

interface EffectFlatPath { readonly values: Float64Array; readonly evenOdd: boolean }

function vectorEffectAlpha(layer: Layer, width: number, height: number): Uint8Array | null {
  if (layer.kind !== 'vector' || !layer.paths.length) return null;
  const paths: EffectFlatPath[] = layer.paths.filter((path) => path.closed && path.points.length > 1).map((path) => {
    const values: number[] = [];
    for (let index = 0; index < path.points.length; index++) {
      const from = path.points[index]!, to = path.points[(index + 1) % path.points.length]!;
      if (index === 0) values.push(from.anchor.x, from.anchor.y);
      for (let step = 1; step <= 12; step++) {
        const t = step / 12, u = 1 - t;
        values.push(u ** 3 * from.anchor.x + 3 * u * u * t * from.out.x + 3 * u * t * t * to.in.x + t ** 3 * to.anchor.x,
          u ** 3 * from.anchor.y + 3 * u * u * t * from.out.y + 3 * u * t * t * to.in.y + t ** 3 * to.anchor.y);
      }
    }
    return { values: new Float64Array(values), evenOdd: path.fillRule === 'evenodd' };
  });
  if (!paths.length) return null;
  const contains = (x: number, y: number): boolean => {
    let winding = 0, parity = false;
    for (const path of paths) {
      let local = 0;
      for (let index = 0, previous = path.values.length / 2 - 1; index < path.values.length / 2; previous = index++) {
        const x0 = path.values[previous * 2]!, y0 = path.values[previous * 2 + 1]!;
        const x1 = path.values[index * 2]!, y1 = path.values[index * 2 + 1]!;
        if ((y0 > y) !== (y1 > y) && x < (x1 - x0) * (y - y0) / (y1 - y0) + x0) {
          if (path.evenOdd) parity = !parity; else local += y1 > y0 ? 1 : -1;
        }
      }
      winding += local;
    }
    return parity || winding !== 0;
  };
  const alpha = new Uint8Array(width * height), scaleX = layer.transform.size.width / width;
  const scaleY = layer.transform.size.height / height;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let covered = 0;
    for (const oy of [0.25, 0.75]) for (const ox of [0.25, 0.75]) {
      if (contains((x + ox) * scaleX, (y + oy) * scaleY)) covered++;
    }
    alpha[y * width + x] = covered * 255 / 4;
  }
  return alpha;
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
  const vector = vectorEffectAlpha(layer, raster.width, raster.height);
  if (vector) {
    let difference = 0;
    for (let index = 0; index < alpha.length; index++) difference += Math.abs(alpha[index]! - vector[index]!);
    // Ordinary shape caches retain Photoshop's antialiasing and remain the better source. A large
    // disagreement means the cached paint is transparent/gradient while the style still traces the path.
    if (difference / alpha.length > 16) alpha.set(vector);
  }
  if (layer.crop) {
    for (let y = 0; y < raster.height; y++) for (let x = 0; x < raster.width; x++) {
      alpha[y * raster.width + x] = Math.round(alpha[y * raster.width + x]!
        * layerCropCoverage(layer.crop, x + 0.5, y + 0.5));
    }
  }
  const mask = layer.mask, maskRaster = mask?.enabled ? source.maskRaster : null;
  if (!mask || !maskRaster || maskRaster.channels !== 1) return alpha;
  const layerTransform = source.transform, placement = source.maskPlacement ?? layerTransform;
  const sourceToDocument = pixelToDocument(layerTransform, raster.width, raster.height);
  const sampler = prepareSampler(maskRaster, 'High quality', maskRaster.width);
  const prepared = preparePlacement({ ...placement, sampling: 'High quality' }, maskRaster.width, maskRaster.height);
  const placed = !samePlacement(placement, layerTransform), psdDefault = mask.defaultColor
    ?? (layer as Layer & { readonly psdMaskDefault?: number }).psdMaskDefault;
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
  if (!document.layers.some((layer) => layer.effects.some((effect) => effect.enabled))) return document;
  const resolved = new Map<Layer, ResolvedEffectSource>();
  let sourceKey = '';
  for (const layer of document.layers) {
    if (!layer.visible || !layer.effects.some((effect) => effect.enabled)) {
      sourceKey += ';'; continue;
    }
    const groupSource = layer.kind === 'group' ? groupEffectSource(document, layer, hooks) : null;
    const raster = groupSource?.raster ?? hooks.raster(layer);
    if (!raster || raster.channels !== 4) { sourceKey += `${raster?.serial ?? 0};`; continue; }
    const transform = groupSource?.transform ?? hooks.transform(layer);
    const source: ResolvedEffectSource = groupSource ?? {
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
  const layerById: ReadonlyMap<string, Layer> = new Map(document.layers.map((layer) => [layer.id, layer]));
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
    const patterns = effects.filter((effect): effect is Extract<typeof effect, { kind: 'patternOverlay' }> =>
      effect.kind === 'patternOverlay' && effect.enabled);
    const resourceKey = patterns.map((effect) => {
      const resource = document.resources?.find((value) => value.id === effect.resourceId);
      return `${effect.resourceId}/${resourceSerial(resource?.bytes)}`;
    }).join(',');
    const key = `${JSON.stringify(layer.crop)}|${JSON.stringify(effects)}|${resourceKey}|${document.globalLightAngle ?? 120}|${source.maskRaster?.serial ?? 0}`
      + `|${placementKey(transform)}|${placementKey(source.maskPlacement)}`;
    let variants = cache.get(raster);
    if (!variants) { variants = new Map(); cache.set(raster, variants); }
    let passes = variants.get(key);
    if (!passes) {
      const alpha = effectAlpha(layer, source);
      passes = [...renderEffectPasses(alpha, raster.width, raster.height, effects,
        { globalLightAngle: document.globalLightAngle, rasterScale: source.rasterScale }),
      ...patternPasses(alpha, raster.width, raster.height, transform, patterns, document.resources)]
        .sort((a, b) => a.placement === b.placement ? a.stackOrder - b.stackOrder : a.placement === 'behind' ? -1 : 1);
      if (diagnostics) diagnostics.effectRegenerations++;
      if (variants.size >= 8) variants.delete(variants.keys().next().value as string);
      variants.set(key, passes);
    }
    const behind = passes.filter((value) => value.placement === 'behind');
    const above = passes.filter((value) => value.placement === 'above');
    for (let i = 0; i < behind.length; i++) layers.push(synthetic(layer, behind[i]!, i,
      passTransform(transform, raster.width, raster.height, behind[i]!), raster.width, raster.height));
    const blendInterior = layer.kind !== 'group'
      && (layer as Layer & { readonly psdBlendInteriorEffects?: boolean }).psdBlendInteriorEffects === true;
    if (blendInterior && above.length) {
      flush();
      const group = { ...newLayer({ id: layer.id, name: layer.name, kind: 'group', parentId: layer.parentId,
        visible: layer.visible, opacity: layer.opacity, fillOpacity: layer.fillOpacity, blendMode: layer.blendMode,
        maskSourceId: layer.maskSourceId, transform: layer.transform }), psdIsolated: true } as Layer
        & { readonly psdIsolated: true };
      const sourceLayer = { ...layer, id: `${layer.id}:interior-source`, parentId: layer.id, maskSourceId: null,
        opacity: 1, fillOpacity: 1, blendMode: 'normal' as const, effects: [] };
      const interior = above.map((pass, i) => ({ ...synthetic(layer, pass, i,
        passTransform(transform, raster.width, raster.height, pass), raster.width, raster.height),
      parentId: layer.id, opacity: pass.opacity, fillOpacity: 1 }));
      layers.push(group, sourceLayer, ...interior);
      continue;
    }
    layers.push({ ...layer, effects: [] });
    const clippingBase: Layer | undefined = layer.maskSourceId ? layerById.get(layer.maskSourceId) : undefined;
    const clipEffects: boolean = !!clippingBase
      && (clippingBase as Layer & { readonly psdBlendClippedElements?: boolean }).psdBlendClippedElements !== false;
    const abovePasses: Layer[] = above.map((pass, i): Layer => {
      const value: Layer = synthetic(layer, pass, i, passTransform(transform, raster.width, raster.height, pass),
        raster.width, raster.height);
      return clipEffects ? { ...value, maskSourceId: layer.maskSourceId } : value;
    });
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
