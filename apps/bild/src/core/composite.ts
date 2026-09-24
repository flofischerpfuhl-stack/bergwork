/** CPU reference for LiveMaskRenderer, LayerRenderer, FolderMaskClip, AdjustmentSurface and ImageExporter.render. */
import {
  blendRgbInto, blendSeed as seedForBlend, clamp01, compositePremultiplied,
  compositePremultipliedWithFill, dissolveNoise,
} from './blend';
import { ancestorIds, renderLayers, type BlendMode, type CanvasDocument, type Layer, type LayerAdjustment } from './document';
import type { Affine, LayerSampling, LayerTransform, Rect } from './geometry';
import { concat, invert, pixelToDocument, samePlacement } from './geometry';
import { alphaBounds, Raster, TILE } from './raster';
import {
  mapPlacement, maskBackground, preparePlacement, prepareSampler, sampleMask, sampleRgba,
  type PreparedPlacement, type RasterSampler,
} from './resample';

export type AdjustmentApplier = (adjustment: LayerAdjustment, rgba: Float32Array,
  width: number, height: number, originX: number, originY: number) => Float32Array;

export interface CompositeOptions {
  readonly transform?: (layer: Layer) => LayerTransform;
  readonly maskPlacement?: (layer: Layer) => LayerTransform | null;
  readonly blendMode?: (layer: Layer) => BlendMode;
  readonly raster?: (layer: Layer) => Raster | null | undefined;
  readonly maskRaster?: (layer: Layer) => Raster | null | undefined;
  readonly sampler?: (raster: Raster, sampling: LayerSampling, drawnWidth: number) => RasterSampler;
  readonly adjust?: AdjustmentApplier;
}

export interface CompositeResult { readonly rgba: Uint8Array; readonly adjustmentsApplied: boolean }
export interface CompositeFloatResult { readonly rgba: Float32Array; readonly adjustmentsApplied: boolean }

interface Stack { readonly base: Layer; readonly children: readonly Layer[] }

const BAND_ROWS = 256;

function opaqueChannel(premultiplied: number, alpha8: number): number {
  if (!alpha8) return 0;
  const byte = Math.round(clamp01(premultiplied) * 255);
  return Math.min(255, Math.floor((byte * 255 + Math.floor(alpha8 / 2)) / alpha8)) / 255;
}

class BandRenderer {
  private readonly byId: ReadonlyMap<string, Layer>;
  private readonly ancestors = new Map<string, readonly Layer[]>();
  private readonly folderMaskFlags = new Map<string, boolean>();
  private readonly rgbaSamplers = new Map<string, RasterSampler>();
  private readonly maskSamplers = new Map<Raster, Map<string, RasterSampler>>();
  private readonly backgrounds = new Map<Raster, number>();
  private readonly transforms = new Map<string, LayerTransform>();
  private readonly maskPlacements = new Map<string, LayerTransform | null>();
  private readonly placements = new Map<string, PreparedPlacement>();
  private readonly stacks = new Map<string, Stack>();
  private readonly stacked = new Set<string>();
  private readonly location = new Float64Array(3);
  private readonly liveSample = new Float32Array(4);
  private readonly blendScratch = new Float64Array(6);
  private readonly blendSeeds = new Map<string, number>();
  private readonly documentToOutput: Affine | undefined;
  skippedAdjustment = false;

  constructor(private readonly document: CanvasDocument, private readonly options: CompositeOptions,
    private readonly outputToDocument?: Affine) {
    this.documentToOutput = outputToDocument ? invert(outputToDocument) : undefined;
    this.byId = new Map(document.layers.map((layer) => [layer.id, layer]));
    const ids = renderLayers(document.layers);
    for (let index = 0; index < ids.length; index++) {
      const base = ids[index]!;
      if (base.maskSourceId || base.adjustment) continue;
      const children: Layer[] = [];
      for (let childIndex = index + 1; childIndex < ids.length; childIndex++) {
        const child = ids[childIndex]!;
        if (child.maskSourceId !== base.id || child.parentId !== base.parentId) break;
        children.push(child);
      }
      if (children.length) {
        this.stacks.set(base.id, { base, children });
        for (const child of children) this.stacked.add(child.id);
      }
    }
  }

  private transform(layer: Layer): LayerTransform {
    let result = this.transforms.get(layer.id);
    if (!result) { result = this.options.transform?.(layer)
      ?? (layer.kind === 'text' ? layer.renderedTransform ?? layer.transform : layer.transform); this.transforms.set(layer.id, result); }
    return result;
  }
  private blendMode(layer: Layer): BlendMode { return this.options.blendMode?.(layer) ?? layer.blendMode; }
  private blendSeed(layer: Layer): number {
    let seed = this.blendSeeds.get(layer.id);
    if (seed === undefined) { seed = seedForBlend(layer.id); this.blendSeeds.set(layer.id, seed); }
    return seed;
  }
  private raster(layer: Layer): Raster | null { return this.options.raster?.(layer) ?? layer.raster ?? null; }
  private maskRaster(layer: Layer): Raster | null { return this.options.maskRaster?.(layer) ?? layer.mask?.raster ?? null; }
  private sampler(raster: Raster, sampling: LayerSampling, drawnWidth: number): RasterSampler {
    return this.options.sampler?.(raster, sampling, drawnWidth) ?? prepareSampler(raster, sampling, drawnWidth);
  }
  private maskPlacement(layer: Layer): LayerTransform | null {
    if (!this.maskPlacements.has(layer.id)) {
      this.maskPlacements.set(layer.id, this.options.maskPlacement?.(layer) ?? layer.mask?.placement ?? null);
    }
    return this.maskPlacements.get(layer.id) ?? null;
  }

  private preparedPlacement(key: string, transform: LayerTransform, width: number, height: number,
    documentToOutput?: Affine): PreparedPlacement {
    const suffix = documentToOutput
      ? `:${documentToOutput.a}:${documentToOutput.b}:${documentToOutput.c}:${documentToOutput.d}:${documentToOutput.tx}:${documentToOutput.ty}` : '';
    const cacheKey = key + suffix;
    let result = this.placements.get(cacheKey);
    if (!result) { result = preparePlacement(transform, width, height, documentToOutput); this.placements.set(cacheKey, result); }
    return result;
  }

  private rgbaSampler(layer: Layer, documentToOutput?: Affine): RasterSampler | null {
    const raster = this.raster(layer);
    if (!raster || raster.channels !== 4) return null;
    const suffix = documentToOutput
      ? `:${documentToOutput.a}:${documentToOutput.b}:${documentToOutput.c}:${documentToOutput.d}` : '';
    const key = layer.id + suffix;
    let sampler = this.rgbaSamplers.get(key);
    if (!sampler) {
      const transform = this.transform(layer);
      const map = pixelToDocument(transform, raster.width, raster.height);
      const device = documentToOutput ? concat(map, documentToOutput) : map;
      sampler = this.sampler(raster, transform.sampling, Math.hypot(device.a, device.b) * raster.width);
      this.rgbaSamplers.set(key, sampler);
    }
    return sampler;
  }

  private maskSampler(raster: Raster, transform: LayerTransform, documentToOutput?: Affine): RasterSampler {
    // Masks are always high-quality in LayerMask.clipImage/FolderMaskClip.
    let variants = this.maskSamplers.get(raster);
    if (!variants) { variants = new Map(); this.maskSamplers.set(raster, variants); }
    const map = pixelToDocument(transform, raster.width, raster.height);
    const device = documentToOutput ? concat(map, documentToOutput) : map;
    const drawnWidth = Math.hypot(device.a, device.b) * raster.width;
    const key = `${drawnWidth}:${transform.sampling}`;
    let sampler = variants.get(key);
    if (!sampler) {
      sampler = this.sampler(raster, 'High quality', drawnWidth);
      variants.set(key, sampler);
    }
    return sampler;
  }

  private ownMask(layer: Layer, x: number, y: number, adjustment = false, documentToOutput?: Affine): number {
    const mask = layer.mask, raster = this.maskRaster(layer);
    if (!(mask?.enabled || layer.vectorMask?.enabled) || !raster || raster.channels !== 1) return 1;
    const layerTransform = this.transform(layer);
    // LiveMaskRenderer.adjust uses FolderMaskClip(mask, layer.transform), not LayerMask.clipImage.
    const candidate = adjustment ? layerTransform : this.maskPlacement(layer);
    const placement = candidate && !samePlacement(candidate, layerTransform) ? candidate : null;
    const transform = { ...(placement ?? layerTransform), sampling: 'High quality' as const };
    const prepared = this.preparedPlacement(`${adjustment ? 'adjustment-mask' : 'mask'}:${layer.id}`,
      transform, raster.width, raster.height, documentToOutput);
    mapPlacement(prepared, x, y, this.location);
    const sampler = this.maskSampler(raster, transform, documentToOutput);
    const sampled = sampleMask(sampler, this.location[0]!, this.location[1]!);
    if (!placement && !adjustment) return sampled;
    if (adjustment) return sampled * this.location[2]!;
    let background = this.backgrounds.get(raster);
    if (background === undefined) {
      // Upstream reads the <=96 px thumbnail; the browser core has only the full raster.
      background = maskBackground(raster); this.backgrounds.set(raster, background);
    }
    return background + (sampled - background) * this.location[2]!;
  }

  private folderCoverage(layer: Layer, x: number, y: number, documentToOutput = this.documentToOutput): number {
    let folders = this.ancestors.get(layer.id);
    if (!folders) {
      folders = ancestorIds(this.document.layers, layer.id).map((id) => this.byId.get(id)).filter((v): v is Layer => !!v);
      this.ancestors.set(layer.id, folders);
    }
    let coverage = 1;
    for (const folder of folders) {
      const mask = folder.mask, raster = this.maskRaster(folder);
      if (!(mask?.enabled || folder.vectorMask?.enabled) || !raster || raster.channels !== 1) continue;
      const transform = { ...this.transform(folder), sampling: 'High quality' as const };
      const prepared = this.preparedPlacement(`folder:${folder.id}`, transform, raster.width, raster.height, documentToOutput);
      mapPlacement(prepared, x, y, this.location);
      if (this.location[2]! <= 0) return 0;
      coverage *= sampleMask(this.maskSampler(raster, transform, documentToOutput), this.location[0]!, this.location[1]!) * this.location[2]!;
      if (coverage <= 0) return 0;
    }
    return coverage;
  }

  private hasFolderMask(layer: Layer): boolean {
    let result = this.folderMaskFlags.get(layer.id);
    if (result !== undefined) return result;
    result = ancestorIds(this.document.layers, layer.id).some((id) => {
      const folder = this.byId.get(id); return folder?.mask?.enabled === true || folder?.vectorMask?.enabled === true;
    });
    this.folderMaskFlags.set(layer.id, result);
    return result;
  }

  /** Common export path: an aligned 1:1 raster samples texel centres at every interpolation quality. */
  private drawAlignedOneToOne(layer: Layer, target: Float32Array, width: number, height: number,
    originX: number, originY: number, mode: BlendMode): boolean {
    const raster = this.raster(layer), transform = this.transform(layer);
    if (this.outputToDocument || !raster || raster.channels !== 4 || transform.rotation % 360 !== 0 || transform.flipX || transform.flipY
      || transform.size.width !== raster.width || transform.size.height !== raster.height
      || !Number.isInteger(transform.origin.x) || !Number.isInteger(transform.origin.y)) return false;
    const opacity = clamp01(layer.opacity), fillOpacity = clamp01(layer.fillOpacity);
    const seed = mode === 'dissolve' ? this.blendSeed(layer) : 0;
    for (let py = 0; py < height; py++) {
      const sy = originY + py - transform.origin.y;
      if (sy < 0 || sy >= raster.height || originY + py < 0 || originY + py >= this.document.height) continue;
      const tileRow = Math.floor(sy / TILE), tileY = sy - tileRow * TILE;
      for (let px = 0; px < width; px++) {
        const sx = originX + px - transform.origin.x;
        if (sx < 0 || sx >= raster.width || originX + px < 0 || originX + px >= this.document.width) continue;
        const tileCol = Math.floor(sx / TILE), tile = raster.tiles[tileRow * raster.cols + tileCol];
        if (!tile) continue;
        const source = (tileY * raster.tileWidth(tileCol) + sx - tileCol * TILE) * 4;
        const maximum = raster.maximum;
        const alpha = tile[source + 3]! / maximum;
        if (alpha <= 0) continue;
        const offset = (py * width + px) * 4;
        const sr = tile[source]! / maximum * alpha, sg = tile[source + 1]! / maximum * alpha,
          sb = tile[source + 2]! / maximum * alpha;
        compositePremultipliedWithFill(target, offset, sr, sg, sb, alpha, 1, opacity, fillOpacity,
          mode, this.blendScratch,
          mode === 'dissolve' ? dissolveNoise(originX + px, originY + py, seed) : 0);
      }
    }
    return true;
  }

  private sourceAt(layer: Layer, x: number, y: number, sample: Float32Array, documentToOutput?: Affine): number {
    const sampler = this.rgbaSampler(layer, documentToOutput);
    if (!sampler) return 0;
    const raster = this.raster(layer)!;
    const prepared = this.preparedPlacement(`source:${layer.id}`, this.transform(layer), raster.width,
      raster.height, documentToOutput);
    mapPlacement(prepared, x, y, this.location);
    if (this.location[2]! <= 0) return 0;
    sampleRgba(sampler, this.location[0]!, this.location[1]!, sample);
    return this.location[2]!;
  }

  /** LiveMaskRenderer.coverage: visibility/folder clips/colour are deliberately absent. */
  liveCoverage(id: string, x: number, y: number, visiting: Set<string>, documentToOutput?: Affine): number {
    if (visiting.size >= 256 || visiting.has(id)) return 0;
    const layer = this.byId.get(id);
    if (!layer || layer.kind === 'group' || layer.adjustment) return 0;
    visiting.add(id);
    const edge = this.sourceAt(layer, x, y, this.liveSample, documentToOutput);
    let coverage = this.liveSample[3]! * edge * clamp01(layer.opacity) * clamp01(layer.fillOpacity)
      * this.ownMask(layer, x, y, false, documentToOutput);
    if (layer.maskSourceId) coverage *= this.liveCoverage(layer.maskSourceId, x, y, visiting, documentToOutput);
    visiting.delete(id);
    return coverage;
  }

  private drawLayer(layer: Layer, target: Float32Array, width: number, height: number, originX: number, originY: number,
    includeLive: boolean, includeFolders: boolean, mode = this.blendMode(layer)): void {
    if ((!includeLive || !layer.maskSourceId) && (!includeFolders || !this.hasFolderMask(layer))
      && !layer.mask?.enabled && !layer.vectorMask?.enabled
      && this.drawAlignedOneToOne(layer, target, width, height, originX, originY, mode)) return;
    const sample = new Float32Array(4);
    const visiting = new Set<string>();
    const map = this.outputToDocument;
    const seed = mode === 'dissolve' ? this.blendSeed(layer) : 0;
    for (let py = 0; py < height; py++) {
      for (let px = 0; px < width; px++) {
        const ox = originX + px + 0.5, oy = originY + py + 0.5;
        const x = map ? map.a * ox + map.c * oy + map.tx : ox;
        const y = map ? map.b * ox + map.d * oy + map.ty : oy;
        if (x < 0 || x >= this.document.width) continue;
        if (y < 0 || y >= this.document.height) continue;
        const edge = this.sourceAt(layer, x, y, sample, this.documentToOutput);
        if (edge <= 0 || sample[3] === 0) continue;
        let coverage = edge * this.ownMask(layer, x, y, false, this.documentToOutput);
        if (includeLive && layer.maskSourceId) {
          visiting.clear();
          coverage *= this.liveCoverage(layer.maskSourceId, x, y, visiting, this.documentToOutput);
        }
        if (includeFolders) coverage *= this.folderCoverage(layer, x, y);
        if (coverage <= 0) continue;
        const offset = (py * width + px) * 4;
        compositePremultipliedWithFill(target, offset, sample[0]!, sample[1]!, sample[2]!, sample[3]!,
          coverage, layer.opacity, layer.fillOpacity, mode, this.blendScratch,
          mode === 'dissolve' ? dissolveNoise(Math.floor(x), Math.floor(y), seed) : 0);
      }
    }
  }

  private adjustmentInput(surface: Float32Array): Float32Array {
    const straight = new Float32Array(surface.length);
    for (let offset = 0; offset < surface.length; offset += 4) {
      const alpha = surface[offset + 3]!;
      straight[offset + 3] = alpha;
      if (alpha > 0) {
        straight[offset] = surface[offset]! / alpha;
        straight[offset + 1] = surface[offset + 1]! / alpha;
        straight[offset + 2] = surface[offset + 2]! / alpha;
      }
    }
    return straight;
  }

  private adjust(layer: Layer, target: Float32Array, width: number, height: number, originX: number, originY: number,
    includeFolders: boolean): void {
    if (!layer.adjustment) return;
    const original = target.slice();
    const input = this.adjustmentInput(original);
    let straight: Float32Array;
    if (this.options.adjust) {
      const point = this.outputToDocument
        ? { x: this.outputToDocument.a * originX + this.outputToDocument.c * originY + this.outputToDocument.tx,
          y: this.outputToDocument.b * originX + this.outputToDocument.d * originY + this.outputToDocument.ty }
        : { x: originX, y: originY };
      straight = this.options.adjust(layer.adjustment, input, width, height, point.x, point.y);
      if (straight.length !== input.length) throw new RangeError('AdjustmentApplier returned a buffer of the wrong size');
    } else {
      straight = input;
      this.skippedAdjustment = true;
    }
    const adjusted = new Float32Array(original.length);
    for (let offset = 0; offset < adjusted.length; offset += 4) {
      const alpha = original[offset + 3]!;
      adjusted[offset] = clamp01(straight[offset]!) * alpha;
      adjusted[offset + 1] = clamp01(straight[offset + 1]!) * alpha;
      adjusted[offset + 2] = clamp01(straight[offset + 2]!) * alpha;
      adjusted[offset + 3] = alpha;
    }
    const mode = this.blendMode(layer);
    if (mode !== 'normal') this.adjustmentBlend(original, adjusted, mode);
    const opacity = clamp01(layer.opacity) * clamp01(layer.fillOpacity);
    if (opacity < 1) this.adjustmentOpacity(original, adjusted, opacity);
    for (let py = 0; py < height; py++) for (let px = 0; px < width; px++) {
      const offset = (py * width + px) * 4;
      const ox = originX + px + 0.5, oy = originY + py + 0.5, map = this.outputToDocument;
      const x = map ? map.a * ox + map.c * oy + map.tx : ox;
      const y = map ? map.b * ox + map.d * oy + map.ty : oy;
      let clip = this.ownMask(layer, x, y, true, this.documentToOutput);
      if (includeFolders) clip *= this.folderCoverage(layer, x, y);
      if (clip >= 1) {
        target[offset] = adjusted[offset]!; target[offset + 1] = adjusted[offset + 1]!;
        target[offset + 2] = adjusted[offset + 2]!; target[offset + 3] = adjusted[offset + 3]!;
      } else if (clip > 0) {
        for (let channel = 0; channel < 4; channel++) {
          target[offset + channel] = original[offset + channel]! * (1 - clip) + adjusted[offset + channel]! * clip;
        }
      }
    }
  }

  /** LiveMaskRenderer.adjust's opaque 8-bit blend and layer_restore_alpha round trip. */
  private adjustmentBlend(original: Float32Array, adjusted: Float32Array, mode: BlendMode): void {
    for (let offset = 0; offset < adjusted.length; offset += 4) {
      const alpha8 = Math.round(clamp01(original[offset + 3]!) * 255);
      blendRgbInto(mode, opaqueChannel(original[offset]!, alpha8), opaqueChannel(original[offset + 1]!, alpha8),
        opaqueChannel(original[offset + 2]!, alpha8), opaqueChannel(adjusted[offset]!, alpha8),
        opaqueChannel(adjusted[offset + 1]!, alpha8), opaqueChannel(adjusted[offset + 2]!, alpha8),
        this.blendScratch, false);
      for (let channel = 0; channel < 3; channel++) {
        const color8 = Math.round(clamp01(this.blendScratch[channel]!) * 255);
        adjusted[offset + channel] = Math.floor((color8 * alpha8 + 127) / 255) / 255;
      }
      adjusted[offset + 3] = alpha8 / 255;
    }
  }

  /**
   * CIBlendWithMask: a lerp from the original to the adjusted colour by the opacity. Computed on sRGB
   * values like the Color Dodge/Burn paths, whose upstream test pins sRGB results.
   */
  private adjustmentOpacity(original: Float32Array, adjusted: Float32Array, opacity: number): void {
    for (let offset = 0; offset < adjusted.length; offset += 4) {
      const alpha = original[offset + 3]!;
      if (alpha <= 0) { adjusted[offset] = adjusted[offset + 1] = adjusted[offset + 2] = 0; continue; }
      for (let channel = 0; channel < 3; channel++) {
        const from = clamp01(original[offset + channel]! / alpha);
        const to = clamp01(adjusted[offset + channel]! / Math.max(adjusted[offset + 3]!, 1e-30));
        adjusted[offset + channel] = (from * (1 - opacity) + to * opacity) * alpha;
      }
      adjusted[offset + 3] = alpha;
    }
  }

  private stackRoundTrip(group: Float32Array, alpha: Uint8Array, restore: boolean): void {
    for (let pixel = 0; pixel < alpha.length; pixel++) {
      const offset = pixel * 4;
      if (!restore) {
        const a = Math.round(clamp01(group[offset + 3]!) * 255);
        alpha[pixel] = a;
        for (let channel = 0; channel < 3; channel++) {
          const p = Math.round(clamp01(group[offset + channel]!) * 255);
          group[offset + channel] = a ? Math.min(255, Math.floor((p * 255 + Math.floor(a / 2)) / a)) / 255 : 0;
        }
        group[offset + 3] = 1;
      } else {
        const a = alpha[pixel]!;
        for (let channel = 0; channel < 3; channel++) {
          const c = Math.round(clamp01(group[offset + channel]!) * 255);
          group[offset + channel] = Math.floor((c * a + 127) / 255) / 255;
        }
        group[offset + 3] = a / 255;
      }
    }
  }

  private drawStack(stack: Stack, target: Float32Array, width: number, height: number, originX: number, originY: number): void {
    const group = new Float32Array(width * height * 4);
    this.drawLayer(stack.base, group, width, height, originX, originY, false, false);
    const alpha = new Uint8Array(width * height);
    // BrushPixels.c layer_unpremultiply_opaque / layer_restore_alpha.
    this.stackRoundTrip(group, alpha, false);
    for (const child of stack.children) {
      if (child.adjustment) this.adjust(child, group, width, height, originX, originY, false);
      else this.drawLayer(child, group, width, height, originX, originY, false, false);
    }
    this.stackRoundTrip(group, alpha, true);
    const mode = this.blendMode(stack.base);
    const seed = mode === 'dissolve' ? this.blendSeed(stack.base) : 0;
    for (let py = 0; py < height; py++) for (let px = 0; px < width; px++) {
      const offset = (py * width + px) * 4;
      const ox = originX + px + 0.5, oy = originY + py + 0.5, map = this.outputToDocument;
      const x = map ? map.a * ox + map.c * oy + map.tx : ox;
      const y = map ? map.b * ox + map.d * oy + map.ty : oy;
      const folder = this.folderCoverage(stack.base, x, y);
      if (folder <= 0) continue;
      compositePremultiplied(target, offset, group[offset]! * folder, group[offset + 1]! * folder,
        group[offset + 2]! * folder, group[offset + 3]! * folder, mode, false, this.blendScratch,
        mode === 'dissolve' ? dissolveNoise(Math.floor(x), Math.floor(y), seed) : 0);
    }
  }

  render(width: number, height: number, originX: number, originY: number): Float32Array {
    const target = new Float32Array(width * height * 4);
    for (const layer of renderLayers(this.document.layers)) {
      if (this.stacked.has(layer.id)) continue;
      const stack = this.stacks.get(layer.id);
      if (stack) this.drawStack(stack, target, width, height, originX, originY);
      else if (layer.adjustment) {
        // LiveMaskRenderer skips adjustment layers linked outside a clipping stack.
        if (!layer.maskSourceId) this.adjust(layer, target, width, height, originX, originY, true);
      } else this.drawLayer(layer, target, width, height, originX, originY, true, true);
    }
    return target;
  }
}

function straightBytes(surface: Float32Array, out: Uint8Array, outputOffset: number): void {
  for (let offset = 0; offset < surface.length; offset += 4) {
    const alpha = clamp01(surface[offset + 3]!);
    const a = Math.round(alpha * 255), target = outputOffset + offset;
    out[target + 3] = a;
    if (a === 0 || alpha === 0) continue;
    out[target] = Math.round(clamp01(surface[offset]! / alpha) * 255);
    out[target + 1] = Math.round(clamp01(surface[offset + 1]! / alpha) * 255);
    out[target + 2] = Math.round(clamp01(surface[offset + 2]! / alpha) * 255);
  }
}

export function compositeRegion(document: CanvasDocument, region: Rect, options: CompositeOptions = {}): CompositeResult {
  if (![region.x, region.y, region.width, region.height].every(Number.isInteger)
    || region.width < 1 || region.height < 1 || region.width > 30_000 || region.height > 30_000
    || region.width * region.height > 100_000_000) {
    throw new RangeError('Composite region must be positive, at most 30,000 px per side and 100 megapixels');
  }
  const rgba = new Uint8Array(region.width * region.height * 4);
  const renderer = new BandRenderer(document, options);
  for (let row = 0; row < region.height; row += BAND_ROWS) {
    const height = Math.min(BAND_ROWS, region.height - row);
    const surface = renderer.render(region.width, height, region.x, region.y + row);
    straightBytes(surface, rgba, row * region.width * 4);
  }
  return { rgba, adjustmentsApplied: !renderer.skippedAdjustment };
}

/** Float straight-alpha reference output; no 8-bit round trip occurs between layers or adjustments. */
export function compositeRegionFloat(document: CanvasDocument, region: Rect,
  options: CompositeOptions = {}): CompositeFloatResult {
  if (![region.x, region.y, region.width, region.height].every(Number.isInteger)
    || region.width < 1 || region.height < 1 || region.width > 30_000 || region.height > 30_000
    || region.width * region.height > 100_000_000) {
    throw new RangeError('Composite region must be positive, at most 30,000 px per side and 100 megapixels');
  }
  const rgba = new Float32Array(region.width * region.height * 4);
  const renderer = new BandRenderer(document, options);
  for (let row = 0; row < region.height; row += BAND_ROWS) {
    const height = Math.min(BAND_ROWS, region.height - row);
    const premultiplied = renderer.render(region.width, height, region.x, region.y + row);
    for (let offset = 0; offset < premultiplied.length; offset += 4) {
      const alpha = clamp01(premultiplied[offset + 3]!), target = row * region.width * 4 + offset;
      rgba[target + 3] = alpha;
      if (alpha > 0) {
        rgba[target] = clamp01(premultiplied[offset]! / alpha);
        rgba[target + 1] = clamp01(premultiplied[offset + 1]! / alpha);
        rgba[target + 2] = clamp01(premultiplied[offset + 2]! / alpha);
      }
    }
  }
  return { rgba, adjustmentsApplied: !renderer.skippedAdjustment };
}

/**
 * Composites a target pixel grid whose pixel centres map through `viewToDocument`.
 * This is the software equivalent of `GpuCompositor.composite` and keeps viewport work bounded
 * to the visible target. LayerRenderer/DownsampleCache still choose source mip levels from the
 * inverse mapping.
 */
export function compositeView(document: CanvasDocument, width: number, height: number,
  viewToDocument: Affine, options: CompositeOptions = {}): CompositeResult {
  if (![width, height].every(Number.isInteger) || width < 1 || height < 1 || width > 30_000 || height > 30_000
    || width * height > 100_000_000 || !Object.values(viewToDocument).every(Number.isFinite)) {
    throw new RangeError('Composite view must be finite, positive, at most 30,000 px per side and 100 megapixels');
  }
  const rgba = new Uint8Array(width * height * 4);
  const renderer = new BandRenderer(document, options, viewToDocument);
  for (let row = 0; row < height; row += BAND_ROWS) {
    const bandHeight = Math.min(BAND_ROWS, height - row);
    const surface = renderer.render(width, bandHeight, 0, row);
    straightBytes(surface, rgba, row * width * 4);
  }
  return { rgba, adjustmentsApplied: !renderer.skippedAdjustment };
}

/** Float straight-alpha viewport equivalent of `compositeView`. */
export function compositeViewFloat(document: CanvasDocument, width: number, height: number,
  viewToDocument: Affine, options: CompositeOptions = {}): CompositeFloatResult {
  if (![width, height].every(Number.isInteger) || width < 1 || height < 1 || width > 30_000 || height > 30_000
    || width * height > 100_000_000 || !Object.values(viewToDocument).every(Number.isFinite)) {
    throw new RangeError('Composite view must be finite, positive, at most 30,000 px per side and 100 megapixels');
  }
  const rgba = new Float32Array(width * height * 4);
  const renderer = new BandRenderer(document, options, viewToDocument);
  for (let row = 0; row < height; row += BAND_ROWS) {
    const bandHeight = Math.min(BAND_ROWS, height - row);
    const premultiplied = renderer.render(width, bandHeight, 0, row);
    for (let offset = 0; offset < premultiplied.length; offset += 4) {
      const alpha = clamp01(premultiplied[offset + 3]!), target = row * width * 4 + offset;
      rgba[target + 3] = alpha;
      if (alpha > 0) {
        rgba[target] = clamp01(premultiplied[offset]! / alpha);
        rgba[target + 1] = clamp01(premultiplied[offset + 1]! / alpha);
        rgba[target + 2] = clamp01(premultiplied[offset + 2]! / alpha);
      }
    }
  }
  return { rgba, adjustmentsApplied: !renderer.skippedAdjustment };
}

export function flattenDocument(document: CanvasDocument, options: CompositeOptions = {}): Raster {
  const result = compositeRegion(document, { x: 0, y: 0, width: document.width, height: document.height }, options);
  return Raster.fromPixels(document.width, document.height, 4, result.rgba);
}

/** LiveMaskBaker.bake: only the target's live dependency is materialised into its own grid. */
export function bakeLiveMask(document: CanvasDocument, targetId: string): Raster | null {
  const target = document.layers.find((layer) => layer.id === targetId);
  if (!target?.raster || target.raster.channels !== 4) return null;
  if (!target.maskSourceId) return target.raster;
  const renderer = new BandRenderer(document, {});
  const source = target.maskSourceId;
  const pixels = target.raster.toPixels();
  const map = pixelToDocument(target.transform, target.raster.width, target.raster.height);
  const documentToOutput = invert(map);
  // The dependency rule is independent of visibility and folder masks.
  const visiting = new Set<string>();
  const coverageAt = (x: number, y: number): number => {
    visiting.clear();
    return renderer.liveCoverage(source, x, y, visiting, documentToOutput);
  };
  for (let y = 0; y < target.raster.height; y++) for (let x = 0; x < target.raster.width; x++) {
    const px = x + 0.5, py = y + 0.5;
    const coverage = coverageAt(map.a * px + map.c * py + map.tx, map.b * px + map.d * py + map.ty);
    const offset = (y * target.raster.width + x) * 4;
    const alpha = Math.round(pixels[offset + 3]! * coverage);
    pixels[offset + 3] = alpha;
    if (alpha === 0) { pixels[offset] = 0; pixels[offset + 1] = 0; pixels[offset + 2] = 0; }
  }
  return Raster.fromPixels(target.raster.width, target.raster.height, 4, pixels);
}

export function trimToAlpha(raster: Raster): { raster: Raster; x: number; y: number } | null {
  if (raster.channels !== 4) throw new RangeError('trimToAlpha requires RGBA');
  const bounds = alphaBounds(raster);
  if (!bounds) return null;
  return { raster: Raster.fromPixels(bounds.width, bounds.height, 4,
    raster.readRegion(bounds.x, bounds.y, bounds.width, bounds.height)), x: bounds.x, y: bounds.y };
}
