import { effectiveVisibleIds, maskTransform, renderLayers, type CanvasDocument, type Layer } from '../document';
import { invert, pixelToDocument, type Point } from '../geometry';
import { TILE, type Raster } from '../raster';
import type { CloneSample } from './stroke';

export interface CloneSettings {
  readonly aligned: boolean;
  readonly sampleAllLayers: boolean;
}

export const DEFAULT_CLONE_TOOL_SETTINGS: CloneSettings = { aligned: true, sampleAllLayers: false };

/** Option-click state and alignment math from Document/CloneStamp.swift. */
export class CloneStampState {
  settings: CloneSettings = DEFAULT_CLONE_TOOL_SETTINGS;
  source: Point | null = null;
  offset: { width: number; height: number } | null = null;

  setSource(point: Point): void {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    this.source = { ...point };
    this.offset = null;
  }

  strokeOffset(point: Point): { width: number; height: number } | null {
    if (!this.source) return null;
    return (this.settings.aligned ? this.offset : null) ?? {
      width: Math.round(this.source.x - point.x),
      height: Math.round(this.source.y - point.y),
    };
  }

  samplePoint(point: Point, strokeActive = false): Point | null {
    if (!this.source) return null;
    if (!this.offset || (!this.settings.aligned && !strokeActive)) return this.source;
    return { x: point.x + this.offset.width, y: point.y + this.offset.height };
  }
}

/** Snapshot sampler used by Clone Stamp. It reads immutable rasters captured at stroke start. */
export function cloneSample(document: CanvasDocument, active: Layer, offset: { width: number; height: number },
  allLayers: boolean): CloneSample {
  const visible = effectiveVisibleIds(document.layers);
  const layers = (allLayers ? renderLayers(document.layers) : [active]).filter((layer) => visible.has(layer.id) && layer.raster)
    .map((layer) => ({
      layer,
      raster: layer.raster!,
      inverse: invert(pixelToDocument(layer.transform, layer.raster!.width, layer.raster!.height)),
      maskInverse: layer.mask && layer.mask.raster.width > 1 && layer.mask.raster.height > 1
        ? invert(pixelToDocument(maskTransform(layer), layer.mask.raster.width, layer.mask.raster.height)) : null,
    }));
  const maximum = layers.some((sampled) => sampled.raster.format === 'rgba16') ? 65535 : 255;
  return {
    offset,
    maximum,
    workerSource: { document, activeLayerId: active.id, allLayers },
    sample(point) {
      let out: [number, number, number, number] = [0, 0, 0, 0];
      for (const sampled of layers) {
        const source = sampleRaster(sampled.raster, sampled.inverse, point, maximum);
        let alpha = source[3] / maximum * sampled.layer.opacity;
        if (sampled.layer.mask?.enabled) alpha *= sampleMask(sampled.layer, sampled.maskInverse, point) / 255;
        if (alpha <= 0) continue;
        // CloneStamp.cloneSample uses the rendered canvas. Normal source-over is exact for normal layers;
        // renderer-specific blend modes remain the renderer's responsibility.
        const ba = out[3] / maximum, oa = alpha + ba * (1 - alpha);
        out = oa <= 0 ? [0, 0, 0, 0] : [
          sample((source[0] * alpha + out[0] * ba * (1 - alpha)) / oa, maximum),
          sample((source[1] * alpha + out[1] * ba * (1 - alpha)) / oa, maximum),
          sample((source[2] * alpha + out[2] * ba * (1 - alpha)) / oa, maximum),
          sample(oa * maximum, maximum),
        ];
      }
      return out;
    },
  };
}

function sampleRaster(raster: Raster, inverse: ReturnType<typeof invert>, point: Point,
  maximum: 255 | 65535): [number, number, number, number] {
  const x = Math.floor(inverse.a * point.x + inverse.c * point.y + inverse.tx);
  const y = Math.floor(inverse.b * point.x + inverse.d * point.y + inverse.ty);
  if (x < 0 || y < 0 || x >= raster.width || y >= raster.height) return [0, 0, 0, 0];
  const col = Math.floor(x / TILE), row = Math.floor(y / TILE), tile = raster.tiles[row * raster.cols + col];
  if (!tile) return [0, 0, 0, 0];
  const offset = ((y - row * TILE) * raster.tileWidth(col) + (x - col * TILE)) * 4;
  const scale = maximum / raster.maximum;
  return [sample((tile[offset] ?? 0) * scale, maximum), sample((tile[offset + 1] ?? 0) * scale, maximum),
    sample((tile[offset + 2] ?? 0) * scale, maximum), sample((tile[offset + 3] ?? 0) * scale, maximum)];
}

function sampleMask(layer: Layer, inverse: ReturnType<typeof invert> | null, point: Point): number {
  const mask = layer.mask;
  if (!mask) return 255;
  if (mask.raster.width === 1 && mask.raster.height === 1) return mask.raster.pixel(0, 0)[0] ?? 0;
  if (!inverse) return 0;
  const x = Math.floor(inverse.a * point.x + inverse.c * point.y + inverse.tx);
  const y = Math.floor(inverse.b * point.x + inverse.d * point.y + inverse.ty);
  if (x < 0 || y < 0 || x >= mask.raster.width || y >= mask.raster.height) return 0;
  const col = Math.floor(x / TILE), row = Math.floor(y / TILE), tile = mask.raster.tiles[row * mask.raster.cols + col];
  if (!tile) return 0;
  return tile[(y - row * TILE) * mask.raster.tileWidth(col) + x - col * TILE] ?? 0;
}

function sample(value: number, maximum: number): number { return Math.min(maximum, Math.max(0, Math.round(value))); }
