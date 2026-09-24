/**
 * Layers-panel thumbnails framed by the whole canvas (UI/CanvasThumbnail.swift): the layer's pixels
 * (or its mask) drawn where they sit on a canvas-shaped picture over a checkerboard; masks extend
 * their edge tone to the canvas edges.
 */

import { useEffect, useRef } from 'react';
import type { LayerTransform } from '../core/geometry';
import { pixelToDocument } from '../core/geometry';
import type { Raster } from '../core/raster';

const previews = new WeakMap<Raster, { canvas: HTMLCanvasElement | OffscreenCanvas; edge: number }>();

/** A ≤96 px preview of a raster (straight alpha, box-filtered), cached per raster. */
function preview(raster: Raster): { canvas: HTMLCanvasElement | OffscreenCanvas; edge: number } {
  // Recovered/swapped full rasters are intentionally never pinned for a list thumbnail.
  const reduced = raster.reducedCopy ?? raster.tileOverlay?.source.reducedCopy;
  const sourceRaster = raster.hasSwappedTiles && reduced ? reduced : raster;
  const cached = previews.get(sourceRaster);
  if (cached) return cached;
  const factor = Math.min(1, 96 / Math.max(sourceRaster.width, sourceRaster.height));
  const width = Math.max(1, Math.round(sourceRaster.width * factor)), height = Math.max(1, Math.round(sourceRaster.height * factor));
  const out = new Uint8ClampedArray(width * height * 4);
  const stepX = sourceRaster.width / width, stepY = sourceRaster.height / height;
  let edgeTotal = 0, edgeCount = 0;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * stepY), y1 = Math.max(y0 + 1, Math.floor((y + 1) * stepY));
    const band = sourceRaster.readRegion(0, y0, sourceRaster.width, y1 - y0);
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * stepX), x1 = Math.max(x0 + 1, Math.floor((x + 1) * stepX));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      // Sample a bounded grid of the block so huge reductions stay cheap.
      const sx = Math.max(1, Math.floor((x1 - x0) / 4)), sy = Math.max(1, Math.floor((y1 - y0) / 4));
      for (let yy = 0; yy < y1 - y0; yy += sy) {
        for (let xx = x0; xx < x1; xx += sx) {
          const i = (yy * sourceRaster.width + xx) * sourceRaster.channels;
          if (sourceRaster.channels === 4) {
            const alpha = band[i + 3]!;
            r += band[i]! * alpha; g += band[i + 1]! * alpha; b += band[i + 2]! * alpha; a += alpha;
          } else { r += band[i]!; }
          n++;
        }
      }
      const o = (y * width + x) * 4;
      if (raster.channels === 4) {
        if (a > 0) { out[o] = r / a; out[o + 1] = g / a; out[o + 2] = b / a; }
        out[o + 3] = a / n;
      } else {
        const v = r / n;
        out[o] = v; out[o + 1] = v; out[o + 2] = v; out[o + 3] = 255;
        if (y === 0 || x === 0 || y === height - 1 || x === width - 1) { edgeTotal += v; edgeCount++; }
      }
    }
  }
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height });
  (canvas.getContext('2d') as CanvasRenderingContext2D).putImageData(new ImageData(out, width, height), 0, 0);
  const result = { canvas, edge: edgeCount ? edgeTotal / edgeCount / 255 : 1 };
  previews.set(sourceRaster, result);
  return result;
}

export function fittedSize(canvas: { width: number; height: number }, box: number): { width: number; height: number } {
  if (!(canvas.width > 0 && canvas.height > 0)) return { width: box, height: box };
  const scale = box / Math.max(canvas.width, canvas.height);
  return { width: Math.max(1, Math.round(canvas.width * scale)), height: Math.max(1, Math.round(canvas.height * scale)) };
}

export function CanvasThumbnail({ raster, transform, canvasSize, box, mask = false, className }: {
  raster: Raster | null; transform: LayerTransform; canvasSize: { width: number; height: number }; box: number; mask?: boolean; className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const size = fittedSize(canvasSize, box);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const scale = 2;
    element.width = size.width * scale;
    element.height = size.height * scale;
    const context = element.getContext('2d');
    if (!context) return;
    const w = element.width, h = element.height;
    const perPixel = w / canvasSize.width;
    const source = raster ? preview(raster) : null;
    if (mask) {
      const tone = Math.round((source?.edge ?? 1) * 255);
      context.fillStyle = `rgb(${tone},${tone},${tone})`;
      context.fillRect(0, 0, w, h);
    } else {
      context.fillStyle = 'rgb(56,56,56)';
      context.fillRect(0, 0, w, h);
      context.fillStyle = 'rgb(82,82,82)';
      const tile = 6 * scale;
      for (let row = 0; row * tile < h; row++) for (let col = 0; col * tile < w; col++) if ((row + col) % 2 === 0) context.fillRect(col * tile, row * tile, tile, tile);
    }
    if (source && raster) {
      const m = pixelToDocument(transform, source.canvas.width, source.canvas.height);
      context.setTransform(m.a * perPixel, m.b * perPixel, m.c * perPixel, m.d * perPixel, m.tx * perPixel, m.ty * perPixel);
      context.imageSmoothingQuality = 'high';
      context.drawImage(source.canvas as CanvasImageSource, 0, 0);
    }
  }, [raster, transform, canvasSize.width, canvasSize.height, size.width, size.height, mask]);
  return <canvas ref={ref} className={className} style={{ width: size.width, height: size.height }} aria-hidden />;
}
