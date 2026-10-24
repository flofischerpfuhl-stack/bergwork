/** Horizon detection and non-destructive document straighten (rotate, then maximal safe crop). */

import { cropDocument } from './canvasOps';
import { center, type Point } from './geometry';
import type { CanvasDocument, Layer, LayerWarp } from './model';
import type { Raster } from './raster';

function luminance(raster: Raster, x: number, y: number): number {
  const pixel = raster.pixel(x, y);
  return raster.channels === 1 ? pixel[0]! : pixel[0]! * 0.2126 + pixel[1]! * 0.7152 + pixel[2]! * 0.0722;
}

function lineAngle(degrees: number): number {
  let value = degrees;
  while (value > 90) value -= 180;
  while (value <= -90) value += 180;
  return value;
}

/** Gradient-guided Hough transform, limited to useful straighten angles (-45°…45°). */
export function detectStraightenAngle(raster: Raster): number | null {
  if (raster.width < 3 || raster.height < 3) return null;
  const stride = Math.max(1, Math.ceil(Math.max(raster.width, raster.height) / 512));
  const edges: { x: number; y: number; magnitude: number; angle: number }[] = [];
  let mean = 0;
  for (let y = stride; y < raster.height - stride; y += stride) for (let x = stride; x < raster.width - stride; x += stride) {
    const gx = luminance(raster, x + stride, y - stride) + 2 * luminance(raster, x + stride, y) + luminance(raster, x + stride, y + stride)
      - luminance(raster, x - stride, y - stride) - 2 * luminance(raster, x - stride, y) - luminance(raster, x - stride, y + stride);
    const gy = luminance(raster, x - stride, y + stride) + 2 * luminance(raster, x, y + stride) + luminance(raster, x + stride, y + stride)
      - luminance(raster, x - stride, y - stride) - 2 * luminance(raster, x, y - stride) - luminance(raster, x + stride, y - stride);
    const magnitude = Math.hypot(gx, gy);
    mean += magnitude;
    edges.push({ x: x / stride, y: y / stride, magnitude, angle: lineAngle(Math.atan2(gy, gx) * 180 / Math.PI + 90) });
  }
  if (!edges.length) return null;
  mean /= edges.length;
  const width = raster.width / stride, height = raster.height / stride;
  const rhoBins = Math.ceil(Math.hypot(width, height) * 2) + 1, angleBins = 361;
  const votes = new Float32Array(rhoBins * angleBins), rhoOffset = (rhoBins - 1) / 2;
  for (const edge of edges) {
    if (edge.magnitude < mean * 1.8 || Math.abs(edge.angle) > 47) continue;
    // Vote every plausible horizon angle. Stair-stepped raster edges have locally horizontal/vertical
    // gradients; the shared rho peak, rather than a single Sobel sample, recovers the actual line.
    for (let bin = 0; bin < angleBins; bin++) {
      const angle = (bin / 4 - 45) * Math.PI / 180;
      const normal = angle + Math.PI / 2;
      const rho = Math.round(edge.x * Math.cos(normal) + edge.y * Math.sin(normal) + rhoOffset);
      if (rho >= 0 && rho < rhoBins) votes[bin * rhoBins + rho]! += Math.sqrt(edge.magnitude);
    }
  }
  let best = 0, score = 0;
  for (let index = 0; index < votes.length; index++) if (votes[index]! > score) { score = votes[index]!; best = index; }
  return score > 0 ? Math.round(((Math.floor(best / rhoBins) / 4 - 45) * 100)) / 100 : null;
}

function rotatePoint(point: Point, pivot: Point, radians: number): Point {
  const x = point.x - pivot.x, y = point.y - pivot.y, c = Math.cos(radians), s = Math.sin(radians);
  return { x: pivot.x + x * c - y * s, y: pivot.y + x * s + y * c };
}

function rotateWarp(warp: LayerWarp | null, pivot: Point, radians: number): LayerWarp | null {
  if (!warp) return null;
  return warp.kind === 'quad' ? { ...warp, corners: warp.corners.map((p) => rotatePoint(p, pivot, radians)) as
    [Point, Point, Point, Point] } : { ...warp, points: warp.points.map((p) => rotatePoint(p, pivot, radians)) };
}

function rotateLayer(layer: Layer, pivot: Point, degrees: number): Layer {
  const radians = degrees * Math.PI / 180, oldCenter = center(layer.transform), nextCenter = rotatePoint(oldCenter, pivot, radians);
  const transform = { ...layer.transform, rotation: layer.transform.rotation + degrees,
    origin: { x: nextCenter.x - layer.transform.size.width / 2, y: nextCenter.y - layer.transform.size.height / 2 } };
  const placement = layer.mask?.placement;
  const mask = layer.mask && placement ? { ...layer.mask, placement: rotateLayerTransform(placement, pivot, degrees) } : layer.mask;
  return { ...layer, transform, warp: rotateWarp(layer.warp, pivot, radians), mask };
}

function rotateLayerTransform(transform: Layer['transform'], pivot: Point, degrees: number): Layer['transform'] {
  const nextCenter = rotatePoint(center(transform), pivot, degrees * Math.PI / 180);
  return { ...transform, rotation: transform.rotation + degrees,
    origin: { x: nextCenter.x - transform.size.width / 2, y: nextCenter.y - transform.size.height / 2 } };
}

/** Largest axis-aligned rectangle contained by a centred rectangle rotated through `radians`. */
export function straightenedCropSize(width: number, height: number, radians: number): { width: number; height: number } {
  const sin = Math.abs(Math.sin(radians)), cos = Math.abs(Math.cos(radians));
  if (sin < 1e-9) return { width, height };
  const long = Math.max(width, height), short = Math.min(width, height);
  let cropWidth: number, cropHeight: number;
  if (short <= 2 * sin * cos * long) {
    const x = 0.5 * short;
    if (width >= height) { cropWidth = x / sin; cropHeight = x / cos; }
    else { cropWidth = x / cos; cropHeight = x / sin; }
  } else {
    const cos2 = cos * cos - sin * sin;
    cropWidth = (width * cos - height * sin) / cos2;
    cropHeight = (height * cos - width * sin) / cos2;
  }
  return { width: Math.max(1, Math.floor(cropWidth)), height: Math.max(1, Math.floor(cropHeight)) };
}

/** Rotates every editable layer around the canvas centre and crops away exposed corners. */
export function straightenDocument(document: CanvasDocument, horizonDegrees: number): CanvasDocument {
  if (!Number.isFinite(horizonDegrees) || Math.abs(horizonDegrees) > 45) throw new RangeError('Invalid straighten angle');
  if (Math.abs(horizonDegrees) < 0.005) return document;
  const degrees = -horizonDegrees, radians = degrees * Math.PI / 180;
  const pivot = { x: document.width / 2, y: document.height / 2 };
  const rotated = { ...document, layers: document.layers.map((layer) => rotateLayer(layer, pivot, degrees)), selection: null };
  const size = straightenedCropSize(document.width, document.height, radians);
  return cropDocument(rotated, { x: Math.floor((document.width - size.width) / 2),
    y: Math.floor((document.height - size.height) / 2), width: size.width, height: size.height });
}
