/** Perspective distortion ported from Document/Distort.swift (`DistortWarp`). */

import { apply, corners as transformCorners, following, invert, unitToDocument,
  type Affine, type LayerTransform, type Point, type Rect, type Size } from './geometry';
import type { Layer, LayerMask } from './document';
import { alphaBounds, cropRaster, Raster, TILE } from './raster';

export type DistortCorners = readonly [Point, Point, Point, Point];

export interface WarpResult {
  readonly raster: Raster;
  readonly transform: LayerTransform;
}

export interface TrimmedWarpResult extends WarpResult { readonly crop: Rect }

export function distortCorners(transform: LayerTransform): DistortCorners {
  const c = transformCorners(transform);
  return [c[0]!, c[1]!, c[2]!, c[3]!];
}

/** DistortWarp.isUsable: finite, convex, non-collapsed, and not a bow-tie. */
export function isUsableDistort(corners: readonly Point[]): corners is DistortCorners {
  if (corners.length !== 4 || corners.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y)
    || Math.abs(p.x) > 1_000_000 || Math.abs(p.y) > 1_000_000)) return false;
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = corners[i]!, b = corners[(i + 1) % 4]!, c = corners[(i + 2) % 4]!;
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) <= 0.01) return false;
    if (sign === 0) sign = cross < 0 ? -1 : 1;
    else if ((cross < 0) !== (sign < 0)) return false;
  }
  return true;
}

interface Projective { a: number; b: number; x0: number; d: number; e: number; y0: number; g: number; h: number }

function coefficients(c: DistortCorners): Projective {
  const sx = c[0].x - c[1].x + c[2].x - c[3].x;
  const sy = c[0].y - c[1].y + c[2].y - c[3].y;
  let g = 0, h = 0;
  if (Math.abs(sx) > 1e-9 || Math.abs(sy) > 1e-9) {
    const dx1 = c[1].x - c[2].x, dx2 = c[3].x - c[2].x;
    const dy1 = c[1].y - c[2].y, dy2 = c[3].y - c[2].y;
    const den = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(den) > 1e-12) { g = (sx * dy2 - dx2 * sy) / den; h = (dx1 * sy - sx * dy1) / den; }
  }
  return {
    a: c[1].x - c[0].x + g * c[1].x, b: c[3].x - c[0].x + h * c[3].x, x0: c[0].x,
    d: c[1].y - c[0].y + g * c[1].y, e: c[3].y - c[0].y + h * c[3].y, y0: c[0].y,
    g, h,
  };
}

/** The unit-square-to-quad mapping from DistortWarp.homography. */
export function homography(corners: readonly Point[]): (point: Point) => Point {
  const m = coefficients(corners as DistortCorners);
  return (p) => {
    const w = m.g * p.x + m.h * p.y + 1;
    return { x: (m.a * p.x + m.b * p.y + m.x0) / w, y: (m.d * p.x + m.e * p.y + m.y0) / w };
  };
}

function inverseHomography(corners: DistortCorners): (point: Point) => Point {
  const m = coefficients(corners);
  const a = m.a, b = m.b, c = m.x0, d = m.d, e = m.e, f = m.y0, g = m.g, h = m.h;
  const A = e - f * h, B = c * h - b, C = b * f - c * e;
  const D = f * g - d, E = a - c * g, F = c * d - a * f;
  const G = d * h - e * g, H = b * g - a * h, I = a * e - b * d;
  return (p) => {
    const w = G * p.x + H * p.y + I;
    return { x: (A * p.x + B * p.y + C) / w, y: (D * p.x + E * p.y + F) / w };
  };
}

function imageCorners(c: DistortCorners, flipX: boolean, flipY: boolean): DistortCorners {
  const corner = (x: number, y: number): Point => {
    const u = flipX ? 1 - x : x, v = flipY ? 1 - y : y;
    return c[[0, 1, 3, 2][v * 2 + u]!]!;
  };
  return [corner(0, 0), corner(1, 0), corner(1, 1), corner(0, 1)];
}

function scalar(raster: Raster, x: number, y: number, channel: number): number {
  if (x < 0 || y < 0 || x >= raster.width || y >= raster.height) return 0;
  const col = Math.floor(x / TILE), row = Math.floor(y / TILE), tile = raster.tiles[row * raster.cols + col];
  if (!tile) return 0;
  return tile[((y - row * TILE) * raster.tileWidth(col) + x - col * TILE) * raster.channels + channel]!;
}

function sampleBilinear(raster: Raster, edgeX: number, edgeY: number, out: number[]): void {
  const x = edgeX - 0.5, y = edgeY - 0.5, x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  out.fill(0);
  for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
    const w = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
    const px = x0 + dx, py = y0 + dy;
    if (raster.channels === 1) out[0] = out[0]! + scalar(raster, px, py, 0) * w;
    else {
      const alpha = scalar(raster, px, py, 3), pm = alpha / 255 * w;
      out[0] = out[0]! + scalar(raster, px, py, 0) * pm;
      out[1] = out[1]! + scalar(raster, px, py, 1) * pm;
      out[2] = out[2]! + scalar(raster, px, py, 2) * pm;
      out[3] = out[3]! + alpha * w;
    }
  }
}

function insideUnit(p: Point): boolean { return p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1; }

function boundsOf(corners: DistortCorners): Rect {
  const xs = corners.map((p) => p.x), ys = corners.map((p) => p.y);
  const x = Math.floor(Math.min(...xs)), y = Math.floor(Math.min(...ys));
  return { x, y, width: Math.ceil(Math.max(...xs)) - x, height: Math.ceil(Math.max(...ys)) - y };
}

/**
 * CIPerspectiveTransform equivalent: inverse homography, bilinear premultiplied sampling, and
 * transparent pixels beyond the quad. Pixel-edge sampling provides antialiasing at its boundary.
 */
export function warpRaster(raster: Raster, transform: LayerTransform, corners: readonly Point[]): WarpResult {
  return warp(raster, transform, corners, 0, false);
}

function warp(raster: Raster, transform: LayerTransform, corners: readonly Point[],
  background: number, maskBackground: boolean): WarpResult {
  if (!isUsableDistort(corners)) throw new RangeError('This is not a valid Compositor project, or its metadata is damaged.');
  const bounds = boundsOf(corners);
  if (bounds.width < 1 || bounds.height < 1 || bounds.width > 30_000 || bounds.height > 30_000
    || bounds.width * bounds.height > 100_000_000) {
    throw new RangeError('This project exceeds the supported canvas, layer, file-size, or 100-megapixel image limit.');
  }
  const placed: LayerTransform = { ...transform, origin: { x: bounds.x, y: bounds.y },
    size: { width: bounds.width, height: bounds.height }, rotation: 0, flipX: false, flipY: false };
  if (raster.channels === 1 && raster.width === 1 && raster.height === 1) return { raster, transform: placed };
  const target = imageCorners(corners, transform.flipX, transform.flipY);
  const inverse = inverseHomography(target);
  const cols = Math.ceil(bounds.width / TILE), rows = Math.ceil(bounds.height / TILE);
  const tiles: (Uint8Array | null)[] = new Array(cols * rows).fill(null);
  const sample = new Array<number>(raster.channels).fill(0);
  const bg = background <= 1 ? background * 255 : background;
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
    const tw = Math.min(TILE, bounds.width - col * TILE), th = Math.min(TILE, bounds.height - row * TILE);
    const tile = new Uint8Array(tw * th * raster.channels);
    let any = false;
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
      const documentPoint = { x: bounds.x + col * TILE + x + 0.5, y: bounds.y + row * TILE + y + 0.5 };
      const unit = inverse(documentPoint);
      let coverage = 1;
      if (maskBackground) {
        coverage = 0;
        for (const oy of [-0.25, 0.25]) for (const ox of [-0.25, 0.25]) {
          if (insideUnit(inverse({ x: documentPoint.x + ox, y: documentPoint.y + oy }))) coverage += 0.25;
        }
      }
      sampleBilinear(raster, unit.x * raster.width, unit.y * raster.height, sample);
      const p = (y * tw + x) * raster.channels;
      if (raster.channels === 1) {
        const value = (insideUnit(unit) ? sample[0]! : 0) * coverage + bg * (1 - coverage);
        tile[p] = Math.max(0, Math.min(255, Math.round(value)));
        any ||= tile[p] !== 0;
      } else if (insideUnit(unit) || (unit.x >= -1 / raster.width && unit.x <= 1 + 1 / raster.width
        && unit.y >= -1 / raster.height && unit.y <= 1 + 1 / raster.height)) {
        const alpha = Math.max(0, Math.min(255, sample[3]!));
        const unpremultiply = alpha > 0 ? 255 / alpha : 0;
        tile[p] = Math.round(Math.max(0, Math.min(alpha, sample[0]!)) * unpremultiply);
        tile[p + 1] = Math.round(Math.max(0, Math.min(alpha, sample[1]!)) * unpremultiply);
        tile[p + 2] = Math.round(Math.max(0, Math.min(alpha, sample[2]!)) * unpremultiply);
        tile[p + 3] = Math.round(alpha);
        any ||= tile[p + 3] !== 0;
      }
    }
    tiles[row * cols + col] = any ? tile : null;
  }
  return { raster: new Raster(bounds.width, bounds.height, raster.channels, tiles), transform: placed };
}

/** DistortWarp.warpMask, using the mask's edge tone outside its quad. */
export function warpMask(raster: Raster, transform: LayerTransform, corners: readonly Point[], background: number): WarpResult {
  if (raster.channels !== 1) throw new TypeError('A mask raster must have one channel');
  return warp(raster, transform, corners, background, background > 0);
}

/** DistortWarp.warpTrimmed; an empty warp is deliberately left at its full bounds. */
export function warpRasterTrimmed(raster: Raster, transform: LayerTransform, corners: readonly Point[]): TrimmedWarpResult {
  const result = warpRaster(raster, transform, corners);
  const crop = alphaBounds(result.raster) ?? { x: 0, y: 0, width: result.raster.width, height: result.raster.height };
  if (crop.x === 0 && crop.y === 0 && crop.width === result.raster.width && crop.height === result.raster.height) {
    return { ...result, crop };
  }
  return {
    raster: cropRaster(result.raster, crop.x, crop.y, crop.width, crop.height), crop,
    transform: { ...result.transform, origin: { x: result.transform.origin.x + crop.x, y: result.transform.origin.y + crop.y },
      size: { width: crop.width, height: crop.height } },
  };
}

/** DistortWarp.carried: applies a layer's perspective to another placement's corners. */
export function carriedCorners(placement: LayerTransform, by: LayerTransform, to: readonly Point[]): DistortCorners {
  const toUnit = invert(unitToDocument(by)), map = homography(to);
  const points = transformCorners(placement).map((p) => map(apply(toUnit, p)));
  return [points[0]!, points[1]!, points[2]!, points[3]!];
}

/** DistortWarp.mapPath's point operation, usable by raster-selection outline adapters. */
export function mapDistortPoint(point: Point, pixelToDocument: Affine, pixelSize: Size,
  transform: LayerTransform, corners: readonly Point[]): Point | null {
  if (!isUsableDistort(corners) || !(pixelSize.width > 0) || !(pixelSize.height > 0)) return null;
  const pixel = apply(invert(pixelToDocument), point);
  let u = pixel.x / pixelSize.width, v = pixel.y / pixelSize.height;
  if (transform.flipX) u = 1 - u;
  if (transform.flipY) v = 1 - v;
  return homography(corners)({ x: u, y: v });
}

/** EditorSession.distortTarget: carries one group member through the group's pending perspective. */
export function groupDistortTarget(original: LayerTransform, groupBox: LayerTransform, draft: LayerTransform,
  shape: readonly Point[]): { transform: LayerTransform; corners: DistortCorners } | null {
  const transform = following(original, groupBox, draft);
  const carried = carriedCorners(transform, draft, shape);
  return isUsableDistort(carried) ? { transform, corners: carried } : null;
}

/** LayerMask.background(of:): white or black according to the majority of edge pixels. */
export function maskBackground(raster: Raster): 0 | 1 {
  if (raster.channels !== 1) return 1;
  let total = 0, count = 0;
  for (let y = 0; y < raster.height; y++) for (let x = 0; x < raster.width; x++) {
    if (y !== 0 && y !== raster.height - 1 && x !== 0 && x !== raster.width - 1) continue;
    total += scalar(raster, x, y, 0); count++;
  }
  return total * 2 >= count * 255 ? 1 : 0;
}

/** Commit helper from EditorSession.distort(at:transform:corners:), preserving mask placement rules. */
export function distortLayer(layer: Layer, transform: LayerTransform, corners: readonly Point[]): Layer {
  if (!layer.raster) return layer;
  const warped = warpRasterTrimmed(layer.raster, transform, corners);
  let mask: LayerMask | null = layer.mask;
  const original = layer.mask;
  if (original && original.placement === null && original.linked) {
    const full = warpMask(original.raster, transform, corners, 0);
    const raster = full.raster === original.raster ? original.raster
      : cropRaster(full.raster, warped.crop.x, warped.crop.y, warped.crop.width, warped.crop.height);
    mask = { ...original, raster };
  } else if (original?.linked && original.placement) {
    const placement = following(original.placement, layer.transform, transform);
    const carried = carriedCorners(placement, transform, corners);
    if (isUsableDistort(carried)) {
      const moved = warpMask(original.raster, placement, carried, maskBackground(original.raster));
      mask = { ...original, raster: moved.raster, placement: moved.transform };
    }
  } else if (original) mask = { ...original, placement: original.placement ?? layer.transform };
  return { ...layer, raster: warped.raster, transform: warped.transform, mask };
}
