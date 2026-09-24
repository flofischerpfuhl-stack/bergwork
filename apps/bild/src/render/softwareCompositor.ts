/** CPU canvas fallback for LayerRenderer, DownsampleCache and ImageExporter.render. */
import { applyAdjustment } from '../core/adjust/apply';
import {
  compositeRegion, compositeRegionFloat, compositeView, compositeViewFloat,
  type AdjustmentApplier, type CompositeOptions,
} from '../core/composite';
import { renderLayers, type CanvasDocument } from '../core/document';
import { concat, invert, pixelToDocument, type Affine, type LayerSampling } from '../core/geometry';
import type { Raster } from '../core/raster';
import { floatToRgba16, rgba16To8 } from '../core/pixel/format';
import { downsampleLevel, prepareSampler, type RasterSampler } from '../core/resample';
import type { ViewSpec } from './gpuCompositor';
import { DEFAULT_HOOKS, type CompositeHooks } from './hooks';
import { prepareCpuRender } from './cpuRender';

export interface SoftwareSurface {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array | null;
  readonly commands: readonly SoftwareDrawCommand[] | null;
}

export interface SoftwareDrawCommand {
  readonly source: OffscreenCanvas;
  readonly transform: Affine;
  readonly opacity: number;
  readonly smoothing: boolean;
  readonly quality: ImageSmoothingQuality;
}

type SoftwareCanvas = HTMLCanvasElement | OffscreenCanvas;
type SoftwareContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/**
 * Per-raster mip selection. `prepareSampler` owns the weak pixel pyramid; this small front cache
 * reuses the selected level during repeated pan/zoom frames and bounds zoom variants per raster.
 * Mirrors Rendering/DownsampleCache.swift (`level(for:)`, at most six sharp halvings).
 */
export class SoftwareDownsampleCache {
  static readonly maxLevel = 6;
  private readonly entries = new WeakMap<Raster, Map<string, RasterSampler>>();

  level(factor: number): number { return downsampleLevel(factor); }

  sampler(raster: Raster, sampling: LayerSampling, drawnWidth: number): RasterSampler {
    const level = sampling === 'Nearest' ? 0 : this.level(drawnWidth / Math.max(1, raster.width));
    const key = `${sampling}:${level}`;
    let variants = this.entries.get(raster);
    if (!variants) { variants = new Map(); this.entries.set(raster, variants); }
    let selected = variants.get(key);
    if (!selected) {
      selected = prepareSampler(raster, sampling, drawnWidth);
      // A raster needs no more than the three level-zero sampling modes plus six mip levels.
      if (variants.size >= 9) variants.delete(variants.keys().next().value as string);
      variants.set(key, selected);
    }
    return selected;
  }
}

/** A compositor-compatible CPU target rendered and presented through Canvas 2D. */
export class SoftwareCompositor {
  readonly kind = 'software' as const;
  readonly floatTargets = false;
  readonly maxTextureSize = 30_000;
  readonly gl = { finish(): void {} };
  readonly downsampleCache = new SoftwareDownsampleCache();
  adjustmentPrograms: AdjustmentApplier = applyAdjustment;
  skippedAdjustments = 0;
  private readonly rasterSurfaces = new WeakMap<Raster, Map<string, OffscreenCanvas>>();
  private constructor(private readonly canvas: SoftwareCanvas, private readonly context: SoftwareContext) {}

  static async create(canvas: SoftwareCanvas, width = 1, height = 1): Promise<SoftwareCompositor> {
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d', { alpha: false }) as SoftwareContext | null;
    if (!context) throw new Error('Canvas 2D is unavailable for software rendering.');
    return new SoftwareCompositor(canvas, context);
  }

  destroy(): void {}

  resize(width: number, height: number): void {
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
  }

  /** `hooks` must already carry live filters (see `prepareCpuRender`). */
  private options(hooks: CompositeHooks): CompositeOptions {
    return {
      transform: hooks.transform, maskPlacement: hooks.maskPlacement, blendMode: hooks.blendMode,
      raster: hooks.raster, maskRaster: hooks.maskRaster, adjust: this.adjustmentPrograms,
      sampler: (raster, sampling, drawnWidth) => this.downsampleCache.sampler(raster, sampling, drawnWidth),
    };
  }

  composite(document: CanvasDocument, view: ViewSpec, hooks: CompositeHooks = DEFAULT_HOOKS): SoftwareSurface {
    ({ document, hooks } = prepareCpuRender(document, hooks));
    const fast = this.simpleComposite(document, view, hooks);
    if (fast) { this.skippedAdjustments = 0; return fast; }
    const result = compositeView(document, view.width, view.height, view.viewToDoc, this.options(hooks));
    this.skippedAdjustments = result.adjustmentsApplied ? 0 : 1;
    return { width: view.width, height: view.height, pixels: result.rgba, commands: null };
  }

  /** Native Canvas 2D source-over path for ordinary layers; complex scenes retain the exact core compositor. */
  private simpleComposite(document: CanvasDocument, view: ViewSpec, hooks: CompositeHooks): SoftwareSurface | null {
    if (typeof OffscreenCanvas === 'undefined') return null;
    const layers = renderLayers(document.layers);
    if (document.layers.some((layer) => layer.kind === 'group' && (layer.mask?.enabled || layer.vectorMask?.enabled))
      || layers.some((layer) => layer.adjustment || layer.filters.length || layer.maskSourceId || layer.mask?.enabled || layer.vectorMask?.enabled
      || hooks.blendMode(layer) !== 'normal')) return null;
    const documentToTarget = invert(view.viewToDoc);
    const commands: SoftwareDrawCommand[] = [];
    for (const layer of layers) {
      const raster = hooks.raster(layer);
      if (!raster || raster.channels !== 4) continue;
      const transform = hooks.transform(layer);
      const gridToDocument = pixelToDocument(transform, raster.width, raster.height);
      const gridToTarget = concat(gridToDocument, documentToTarget);
      const drawnWidth = Math.hypot(gridToTarget.a, gridToTarget.b) * raster.width;
      const selected = this.rasterSurface(raster, transform.sampling, drawnWidth);
      const sourceToDocument = pixelToDocument(transform, selected.width, selected.height);
      const sourceToTarget = concat(sourceToDocument, documentToTarget);
      commands.push({ source: selected, transform: sourceToTarget,
        opacity: Math.min(1, Math.max(0, layer.opacity * layer.fillOpacity)),
        smoothing: transform.sampling !== 'Nearest' && !view.snap,
        quality: transform.sampling === 'High quality' ? 'high' : 'medium' });
    }
    return { width: view.width, height: view.height, pixels: null, commands };
  }

  private rasterSurface(raster: Raster, sampling: LayerSampling, drawnWidth: number): OffscreenCanvas {
    const sampler = this.downsampleCache.sampler(raster, sampling, drawnWidth), key = `${sampling}:${sampler.level}`;
    let variants = this.rasterSurfaces.get(raster);
    if (!variants) { variants = new Map(); this.rasterSurfaces.set(raster, variants); }
    const existing = variants.get(key); if (existing) return existing;
    const canvas = new OffscreenCanvas(sampler.width, sampler.height), context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D is unavailable for a software mip level.');
    const native = sampler.reduced?.bytes ?? raster.toPixelsNative();
    const source = native instanceof Uint16Array ? rgba16To8(native) : native;
    const straight = new Uint8ClampedArray(source.length);
    if (!sampler.reduced) straight.set(source);
    else {
      // DownsampleCache stores colour levels premultiplied so transparent edges cannot glow.
      for (let offset = 0; offset < source.length; offset += 4) {
        const alpha = source[offset + 3]!; straight[offset + 3] = alpha;
        if (!alpha) continue;
        straight[offset] = Math.min(255, Math.round(source[offset]! * 255 / alpha));
        straight[offset + 1] = Math.min(255, Math.round(source[offset + 1]! * 255 / alpha));
        straight[offset + 2] = Math.min(255, Math.round(source[offset + 2]! * 255 / alpha));
      }
    }
    context.putImageData(new ImageData(straight, sampler.width, sampler.height), 0, 0);
    variants.set(key, canvas);
    return canvas;
  }

  releaseTarget(_surface: SoftwareSurface): void {}

  /** Workspace/checkerboard presentation matching shaders.ts PRESENT_FRAGMENT. */
  present(composite: SoftwareSurface | null, width: number, height: number,
    canvasRect: { x: number; y: number; width: number; height: number }, pointScale: number,
    grid: boolean, pixelSize: number, compositeOrigin: { x: number; y: number } = { x: 0, y: 0 }): void {
    this.resize(width, height);
    const context = this.context;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.fillStyle = 'rgb(27,27,27)'; context.fillRect(0, 0, width, height);
    if (canvasRect.width <= 0 || canvasRect.height <= 0) return;
    const left = Math.max(0, Math.floor(canvasRect.x)), top = Math.max(0, Math.floor(canvasRect.y));
    const right = Math.min(width, Math.ceil(canvasRect.x + canvasRect.width));
    const bottom = Math.min(height, Math.ceil(canvasRect.y + canvasRect.height));
    const cell = Math.max(1, 10 * pointScale);
    context.save();
    context.beginPath(); context.rect(left, top, right - left, bottom - top); context.clip();
    context.fillStyle = 'rgb(89,89,89)'; context.fillRect(left, top, right - left, bottom - top);
    context.fillStyle = 'rgb(77,77,77)';
    const firstCellX = Math.floor((left - canvasRect.x) / cell), firstCellY = Math.floor((top - canvasRect.y) / cell);
    for (let cy = firstCellY; canvasRect.y + cy * cell < bottom; cy++) {
      for (let cx = firstCellX; canvasRect.x + cx * cell < right; cx++) {
        if ((cx + cy) % 2 !== 0) context.fillRect(canvasRect.x + cx * cell, canvasRect.y + cy * cell, cell, cell);
      }
    }
    context.restore();

    if (composite?.commands) this.presentCommands(composite, compositeOrigin);
    else if (composite) this.presentPixels(composite, compositeOrigin, canvasRect, pointScale);
    if (grid && pixelSize > 0) {
      context.save(); context.beginPath(); context.rect(left, top, right - left, bottom - top); context.clip();
      context.strokeStyle = 'rgba(140,140,140,.45)'; context.lineWidth = 1;
      context.beginPath();
      for (let x = canvasRect.x; x <= canvasRect.x + canvasRect.width; x += pixelSize) {
        context.moveTo(Math.round(x) + .5, canvasRect.y); context.lineTo(Math.round(x) + .5, canvasRect.y + canvasRect.height);
      }
      for (let y = canvasRect.y; y <= canvasRect.y + canvasRect.height; y += pixelSize) {
        context.moveTo(canvasRect.x, Math.round(y) + .5); context.lineTo(canvasRect.x + canvasRect.width, Math.round(y) + .5);
      }
      context.stroke(); context.restore();
    }
    context.strokeStyle = 'rgba(255,255,255,.13)'; context.lineWidth = 1;
    context.strokeRect(Math.floor(canvasRect.x) + .5, Math.floor(canvasRect.y) + .5,
      Math.max(0, Math.ceil(canvasRect.width) - 1), Math.max(0, Math.ceil(canvasRect.height) - 1));
  }

  private presentCommands(surface: SoftwareSurface, origin: { x: number; y: number }): void {
    const context = this.context;
    context.save(); context.beginPath(); context.rect(origin.x, origin.y, surface.width, surface.height); context.clip();
    for (const command of surface.commands!) {
      const transform = command.transform;
      context.setTransform(transform.a, transform.b, transform.c, transform.d,
        transform.tx + origin.x, transform.ty + origin.y);
      context.globalAlpha = command.opacity; context.imageSmoothingEnabled = command.smoothing;
      context.imageSmoothingQuality = command.quality; context.drawImage(command.source, 0, 0);
    }
    context.restore();
  }

  private presentPixels(surface: SoftwareSurface, origin: { x: number; y: number },
    canvasRect: { x: number; y: number; width: number; height: number }, pointScale: number): void {
    const out = this.context.createImageData(surface.width, surface.height), target = out.data, source = surface.pixels!;
    const cell = Math.max(1, 10 * pointScale);
    for (let y = 0; y < surface.height; y++) for (let x = 0; x < surface.width; x++) {
      const offset = (y * surface.width + x) * 4, alpha = source[offset + 3]! / 255;
      const cx = Math.floor((origin.x + x - canvasRect.x) / cell);
      const cy = Math.floor((origin.y + y - canvasRect.y) / cell);
      const checker = (cx + cy) % 2 === 0 ? 89 : 77;
      target[offset] = Math.round(source[offset]! * alpha + checker * (1 - alpha));
      target[offset + 1] = Math.round(source[offset + 1]! * alpha + checker * (1 - alpha));
      target[offset + 2] = Math.round(source[offset + 2]! * alpha + checker * (1 - alpha));
      target[offset + 3] = 255;
    }
    this.context.putImageData(out, Math.round(origin.x), Math.round(origin.y));
  }

  readRegion(document: CanvasDocument, x: number, y: number, width: number, height: number,
    hooks: CompositeHooks = DEFAULT_HOOKS): Uint8Array {
    ({ document, hooks } = prepareCpuRender(document, hooks));
    const result = compositeRegion(document, { x, y, width, height }, this.options(hooks));
    this.skippedAdjustments = result.adjustmentsApplied ? 0 : 1;
    return result.rgba;
  }

  /** Straight-alpha float output used by 16-bit export and precision tests. */
  readRegionFloat(document: CanvasDocument, x: number, y: number, width: number, height: number,
    hooks: CompositeHooks = DEFAULT_HOOKS): Float32Array {
    ({ document, hooks } = prepareCpuRender(document, hooks));
    const result = compositeRegionFloat(document, { x, y, width, height }, this.options(hooks));
    this.skippedAdjustments = result.adjustmentsApplied ? 0 : 1;
    return result.rgba;
  }

  readRegion16(document: CanvasDocument, x: number, y: number, width: number, height: number,
    hooks: CompositeHooks = DEFAULT_HOOKS): Uint16Array {
    return floatToRgba16(this.readRegionFloat(document, x, y, width, height, hooks));
  }

  readView(document: CanvasDocument, width: number, height: number, viewToDoc: Affine, _scale: number,
    hooks: CompositeHooks = DEFAULT_HOOKS): Uint8Array {
    ({ document, hooks } = prepareCpuRender(document, hooks));
    const out = new Uint8Array(width * height * 4), step = 2048;
    for (let ty = 0; ty < height; ty += step) for (let tx = 0; tx < width; tx += step) {
      const w = Math.min(step, width - tx), h = Math.min(step, height - ty);
      const view = concat({ a: 1, b: 0, c: 0, d: 1, tx, ty }, viewToDoc);
      const pixels = compositeView(document, w, h, view, this.options(hooks)).rgba;
      for (let row = 0; row < h; row++) {
        out.set(pixels.subarray(row * w * 4, (row + 1) * w * 4), ((ty + row) * width + tx) * 4);
      }
    }
    return out;
  }

  readViewFloat(document: CanvasDocument, width: number, height: number, viewToDoc: Affine, _scale: number,
    hooks: CompositeHooks = DEFAULT_HOOKS): Float32Array {
    ({ document, hooks } = prepareCpuRender(document, hooks));
    const result = compositeViewFloat(document, width, height, viewToDoc, this.options(hooks));
    this.skippedAdjustments = result.adjustmentsApplied ? 0 : 1;
    return result.rgba;
  }
}
