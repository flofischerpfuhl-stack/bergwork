import type { Layer } from '../document';
import { layerPixelHeight, layerPixelWidth, maskTransform, MAX_PIXELS, MAX_SIDE } from '../document';
import { apply, invert, pixelToDocument, type Affine, type LayerTransform, type Point, type Rect, type Size } from '../geometry';
import { Raster, TILE } from '../raster';
import type { DocumentSelection } from '../selection';

export interface RasterTarget {
  readonly raster: Raster;
  readonly transform: LayerTransform;
  readonly mask: boolean;
}

/** Expands upstream's 1x1 uniform masks to the editable layer grid (BrushStroke.init). */
export function editableTarget(layer: Layer, mask: boolean, canvas?: Size): RasterTarget | null {
  if (!mask) {
    const width = layerPixelWidth(layer), height = layerPixelHeight(layer);
    const raster = layer.raster ?? Raster.blank(width, height, 4);
    return canvas ? expandedColorTarget(raster, layer.transform, canvas) : { raster, transform: layer.transform, mask: false };
  }
  if (!layer.mask) return null;
  let raster = layer.mask.raster;
  const transform = maskTransform(layer);
  if (layer.mask.placement === null && raster.width === 1 && raster.height === 1) {
    const width = layerPixelWidth(layer), height = layerPixelHeight(layer);
    const value = raster.pixel(0, 0)[0]!;
    const tiles: (Uint8Array | null)[] = [];
    for (let y = 0; y < height; y += TILE) for (let x = 0; x < width; x += TILE) {
      if (!value) tiles.push(null);
      else {
        const tile = new Uint8Array(Math.min(TILE, width - x) * Math.min(TILE, height - y));
        tile.fill(value); tiles.push(tile);
      }
    }
    raster = new Raster(width, height, 1, tiles);
  }
  return { raster, transform, mask: true };
}

/** BrushStroke.init: color edits may grow to the inverse-mapped canvas; masks never do. */
function expandedColorTarget(raster: Raster, transform: LayerTransform, canvas: Size): RasterTarget | null {
  const mapping = pixelToDocument(transform, raster.width, raster.height), inverse = invert(mapping);
  const corners = [{ x: 0, y: 0 }, { x: canvas.width, y: 0 }, { x: canvas.width, y: canvas.height }, { x: 0, y: canvas.height }]
    .map((point) => apply(inverse, point));
  const left = Math.min(0, Math.floor(Math.min(...corners.map((point) => point.x))));
  const top = Math.min(0, Math.floor(Math.min(...corners.map((point) => point.y))));
  const right = Math.max(raster.width, Math.ceil(Math.max(...corners.map((point) => point.x))));
  const bottom = Math.max(raster.height, Math.ceil(Math.max(...corners.map((point) => point.y))));
  const width = right - left, height = bottom - top;
  if (width === raster.width && height === raster.height && left === 0 && top === 0) {
    return { raster, transform, mask: false };
  }
  if (width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) return null;
  const cols = Math.ceil(width / TILE), rows = Math.ceil(height / TILE), tiles: (Uint8Array | null)[] = [];
  for (let row = 0; row < rows; row++) {
    const tileHeight = Math.min(TILE, height - row * TILE);
    for (let col = 0; col < cols; col++) {
      const tileWidth = Math.min(TILE, width - col * TILE);
      const sourceX = col * TILE + left, sourceY = row * TILE + top;
      const overlaps = sourceX < raster.width && sourceY < raster.height
        && sourceX + tileWidth > 0 && sourceY + tileHeight > 0;
      if (!overlaps) { tiles.push(null); continue; }
      const pixels = raster.readRegion(sourceX, sourceY, tileWidth, tileHeight);
      let any = false;
      for (let i = 0; i < pixels.length && !any; i++) any = pixels[i] !== 0;
      tiles.push(any ? pixels : null);
    }
  }
  const center = apply(mapping, { x: left + width / 2, y: top + height / 2 });
  const size = { width: width * transform.size.width / raster.width, height: height * transform.size.height / raster.height };
  return { raster: new Raster(width, height, 4, tiles), transform: { ...transform, size,
    origin: { x: center.x - size.width / 2, y: center.y - size.height / 2 } }, mask: false };
}

export class RasterMapping {
  readonly pixelToDocument: Affine;
  readonly documentToPixel: Affine;

  constructor(readonly raster: Raster, readonly transform: LayerTransform) {
    this.pixelToDocument = pixelToDocument(transform, raster.width, raster.height);
    this.documentToPixel = invert(this.pixelToDocument);
  }

  pixelPoint(documentPoint: Point): Point { return apply(this.documentToPixel, documentPoint); }
  documentPoint(pixelPoint: Point): Point { return apply(this.pixelToDocument, pixelPoint); }

  /** Conservative pixel-grid bounds of a document-space circle. */
  circleBounds(center: Point, radius: number, margin = 0): Rect | null {
    const r = radius + margin;
    const corners = [
      { x: center.x - r, y: center.y - r }, { x: center.x + r, y: center.y - r },
      { x: center.x + r, y: center.y + r }, { x: center.x - r, y: center.y + r },
    ].map((p) => this.pixelPoint(p));
    const left = Math.max(0, Math.floor(Math.min(...corners.map((p) => p.x)) - 1));
    const top = Math.max(0, Math.floor(Math.min(...corners.map((p) => p.y)) - 1));
    const right = Math.min(this.raster.width, Math.ceil(Math.max(...corners.map((p) => p.x)) + 1));
    const bottom = Math.min(this.raster.height, Math.ceil(Math.max(...corners.map((p) => p.y)) + 1));
    return right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : null;
  }

  documentBounds(rect: Rect): Rect {
    const points = [
      this.documentPoint({ x: rect.x, y: rect.y }), this.documentPoint({ x: rect.x + rect.width, y: rect.y }),
      this.documentPoint({ x: rect.x + rect.width, y: rect.y + rect.height }),
      this.documentPoint({ x: rect.x, y: rect.y + rect.height }),
    ];
    const x = Math.min(...points.map((p) => p.x)), y = Math.min(...points.map((p) => p.y));
    return { x, y, width: Math.max(...points.map((p) => p.x)) - x, height: Math.max(...points.map((p) => p.y)) - y };
  }

  documentScale(): { x: number; y: number } {
    return { x: Math.hypot(this.pixelToDocument.a, this.pixelToDocument.b), y: Math.hypot(this.pixelToDocument.c, this.pixelToDocument.d) };
  }
}

/** Selection coverage at a document position; null means unrestricted. */
export function selectionCoverage(selection: DocumentSelection | null, point: Point): number {
  if (!selection) return 1;
  const x = Math.floor(point.x - selection.x), y = Math.floor(point.y - selection.y);
  return selection.mask.pixel(x, y)[0]! / 255;
}

export function unionRects(a: Rect | null, b: Rect): Rect {
  if (!a) return b;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y };
}

export function clampByte(value: number): number { return Math.max(0, Math.min(255, Math.round(value))); }

export function validPoint(point: Point): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y) && Math.abs(point.x) <= 10_000_000 && Math.abs(point.y) <= 10_000_000;
}
