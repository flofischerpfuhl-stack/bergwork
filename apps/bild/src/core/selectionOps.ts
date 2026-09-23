/**
 * Coverage based selection geometry. This ports Document/Selection.swift and
 * Document/MaskTracing.swift. CoreGraphics paths are represented by an 8-bit mask;
 * curved and polygon edges use a fixed 4x4 grid (16 samples/pixel).
 */

import { type Point, type Rect, integralRect, rectIntersection, roundHalfAway } from './geometry';
import { Raster, TILE } from './raster';
import { selectionIsEmpty, type DocumentSelection, type SelectionMode } from './selection';

export interface CanvasSize { readonly width: number; readonly height: number }
export type SelectionPolyline = readonly Point[];

const EMPTY_MASK = (): Raster => Raster.blank(1, 1, 1);
const boundsCache = new WeakMap<DocumentSelection, Rect | null>();

function maskRaster(width: number, height: number, pixels: Uint8Array): Raster {
  const cols = Math.ceil(width / TILE), rows = Math.ceil(height / TILE), tiles: (Uint8Array | null)[] = [];
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
    const tw = Math.min(TILE, width - col * TILE), th = Math.min(TILE, height - row * TILE);
    const tile = new Uint8Array(tw * th); let any = false;
    for (let y = 0; y < th; y++) {
      const source = (row * TILE + y) * width + col * TILE;
      const line = pixels.subarray(source, source + tw); tile.set(line, y * tw);
      if (!any) for (let x = 0; x < line.length; x++) if (line[x]) { any = true; break; }
    }
    tiles.push(any ? tile : null);
  }
  return new Raster(width, height, 1, tiles);
}

function solidMaskRaster(width: number, height: number, value: number): Raster {
  const cols = Math.ceil(width / TILE), rows = Math.ceil(height / TILE), tiles: Uint8Array[] = [];
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
    const tile = new Uint8Array(Math.min(TILE, width - col * TILE) * Math.min(TILE, height - row * TILE));
    tile.fill(value); tiles.push(tile);
  }
  return new Raster(width, height, 1, tiles);
}

function withKnownBounds(selection: DocumentSelection, bounds: Rect | null): DocumentSelection {
  boundsCache.set(selection, bounds); return selection;
}

export function emptySelection(antialiased = true): DocumentSelection {
  return withKnownBounds({ mask: EMPTY_MASK(), x: 0, y: 0, antialiased }, null);
}

/** Selection.swift DragBox.rect; Swift rounds halves away from zero. */
export function dragBoxRect(anchor: Point, point: Point, square = false, fromCenter = false): Rect {
  let dx = roundHalfAway(point.x) - anchor.x;
  let dy = roundHalfAway(point.y) - anchor.y;
  if (square) {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    dx = dx < 0 ? -side : side;
    dy = dy < 0 ? -side : side;
  }
  return fromCenter
    ? { x: anchor.x - Math.abs(dx), y: anchor.y - Math.abs(dy), width: Math.abs(dx) * 2, height: Math.abs(dy) * 2 }
    : { x: Math.min(anchor.x, anchor.x + dx), y: Math.min(anchor.y, anchor.y + dy), width: Math.abs(dx), height: Math.abs(dy) };
}

function canvasRect(canvas: CanvasSize): Rect { return { x: 0, y: 0, width: canvas.width, height: canvas.height }; }

function clippedBounds(bounds: Rect, canvas: CanvasSize): Rect | null {
  const r = rectIntersection(integralRect(bounds), canvasRect(canvas));
  if (!r) return null;
  return { x: Math.trunc(r.x), y: Math.trunc(r.y), width: Math.trunc(r.width), height: Math.trunc(r.height) };
}

function rasterizeSpans(bounds: Rect, canvas: CanvasSize, antialiased: boolean,
  spansAtY: (y: number) => readonly (readonly [number, number])[]): DocumentSelection {
  const region = clippedBounds(bounds, canvas);
  if (!region) return emptySelection(antialiased);
  const samples = antialiased ? 4 : 1, counts = new Uint8Array(region.width * region.height);
  const addRange = (row: number, from: number, to: number): void => {
    let first = Math.max(0, Math.ceil((from - region.x) * samples - 0.5));
    const end = Math.min(region.width * samples, Math.ceil((to - region.x) * samples - 0.5));
    while (first < end && first % samples !== 0) { counts[row * region.width + Math.floor(first / samples)]!++; first++; }
    while (first + samples <= end) {
      const index = row * region.width + first / samples; counts[index] = counts[index]! + samples; first += samples;
    }
    while (first < end) { counts[row * region.width + Math.floor(first / samples)]!++; first++; }
  };
  for (let row = 0; row < region.height; row++) {
    for (let sy = 0; sy < samples; sy++) {
      const y = region.y + row + (sy + 0.5) / samples;
      for (const span of spansAtY(y)) if (span[1] > span[0]) addRange(row, span[0], span[1]);
    }
  }
  const scale = 255 / (samples * samples);
  for (let i = 0; i < counts.length; i++) counts[i] = Math.round(counts[i]! * scale);
  return withKnownBounds({ mask: maskRaster(region.width, region.height, counts), x: region.x, y: region.y, antialiased }, region);
}

/** Whole-pixel rectangular marquee (Selection.swift `DragBox` / `finishLasso`). */
export function rectangleSelection(rect: Rect, canvas: CanvasSize, antialiased = false): DocumentSelection {
  const x0 = Math.min(rect.x, rect.x + rect.width), x1 = Math.max(rect.x, rect.x + rect.width);
  const y0 = Math.min(rect.y, rect.y + rect.height), y1 = Math.max(rect.y, rect.y + rect.height);
  if (!(x1 > x0 && y1 > y0)) return emptySelection(antialiased);
  if ([x0, x1, y0, y1].every(Number.isInteger)) {
    const region = clippedBounds({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, canvas);
    return region ? withKnownBounds({ mask: solidMaskRaster(region.width, region.height, 255), x: region.x, y: region.y, antialiased }, region)
      : emptySelection(antialiased);
  }
  return rasterizeSpans({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, canvas, antialiased,
    (y) => y >= y0 && y < y1 ? [[x0, x1]] : []);
}

/** Elliptical marquee, filled using the same pixel-centre convention as CGContext. */
export function ellipseSelection(rect: Rect, canvas: CanvasSize, antialiased = true): DocumentSelection {
  const x0 = Math.min(rect.x, rect.x + rect.width), x1 = Math.max(rect.x, rect.x + rect.width);
  const y0 = Math.min(rect.y, rect.y + rect.height), y1 = Math.max(rect.y, rect.y + rect.height);
  if (!(x1 > x0 && y1 > y0)) return emptySelection(antialiased);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = (x1 - x0) / 2, ry = (y1 - y0) / 2;
  return rasterizeSpans({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, canvas, antialiased, (y) => {
    const q = 1 - ((y - cy) / ry) ** 2;
    if (q < 0) return [];
    const dx = rx * Math.sqrt(q); return [[cx - dx, cx + dx]];
  });
}

/** Freehand and polygonal lasso fill, using the NONZERO winding rule. */
export function polygonSelection(points: readonly Point[], canvas: CanvasSize, antialiased = true): DocumentSelection {
  if (points.length < 3 || !points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) return emptySelection(antialiased);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  if (!(maxX > minX && maxY > minY)) return emptySelection(antialiased);
  return rasterizeSpans({ x: minX, y: minY, width: maxX - minX, height: maxY - minY }, canvas, antialiased, (y) => {
    const events: { x: number; delta: number }[] = [];
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const a = points[j]!, b = points[i]!;
      if (a.y <= y && b.y > y) events.push({ x: a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y), delta: 1 });
      else if (b.y <= y && a.y > y) events.push({ x: a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y), delta: -1 });
    }
    events.sort((a, b) => a.x - b.x);
    const spans: [number, number][] = [];
    let winding = 0, previous = 0, index = 0;
    while (index < events.length) {
      const x = events[index]!.x;
      if (winding !== 0 && x > previous) spans.push([previous, x]);
      let delta = 0;
      while (index < events.length && Math.abs(events[index]!.x - x) < 1e-12) { delta += events[index]!.delta; index++; }
      winding += delta; previous = x;
    }
    return spans;
  });
}

/** Accepts a wand or other pre-rasterised result and clips it to the canvas. */
export function coverageSelection(mask: Raster, x: number, y: number, canvas: CanvasSize, antialiased = true): DocumentSelection {
  if (mask.channels !== 1) throw new RangeError('Selection coverage must be a one-channel raster');
  if (!Number.isInteger(x) || !Number.isInteger(y)) throw new RangeError('Selection coverage offset must be integral');
  const region = rectIntersection({ x, y, width: mask.width, height: mask.height }, canvasRect(canvas));
  if (!region) return emptySelection(antialiased);
  const ix = Math.ceil(region.x), iy = Math.ceil(region.y);
  const right = Math.floor(region.x + region.width), bottom = Math.floor(region.y + region.height);
  if (right <= ix || bottom <= iy) return emptySelection(antialiased);
  return { mask: maskRaster(right - ix, bottom - iy, mask.readRegion(ix - x, iy - y, right - ix, bottom - iy)), x: ix, y: iy, antialiased };
}

/** Selection.swift `applySelection`: New, max-union, or a*(1-b), then canvas clipping. */
export function combineSelection(current: DocumentSelection | null, shape: DocumentSelection, mode: SelectionMode,
  canvas: CanvasSize): DocumentSelection | null {
  const clipped = Number.isInteger(shape.x) && Number.isInteger(shape.y) && shape.x >= 0 && shape.y >= 0
    && shape.x + shape.mask.width <= canvas.width && shape.y + shape.mask.height <= canvas.height
    ? shape : coverageSelection(shape.mask, shape.x, shape.y, canvas, shape.antialiased);
  if (mode === 'New') return clipped;
  if (mode === 'Subtract' && current === null) return null;
  if (mode === 'Add' && current === null) return clipped;
  const a = current!;
  const ab = selectionBounds(a), bb = selectionBounds(clipped);
  if (!ab && mode === 'Add') return clipped;
  if (!ab) return emptySelection(a.antialiased);
  if (!bb) return a;
  const x = Math.max(0, Math.min(ab.x, bb.x));
  const y = Math.max(0, Math.min(ab.y, bb.y));
  const right = Math.min(canvas.width, Math.max(ab.x + ab.width, bb.x + bb.width));
  const bottom = Math.min(canvas.height, Math.max(ab.y + ab.height, bb.y + bb.height));
  if (right <= x || bottom <= y) return emptySelection(a.antialiased);
  const width = right - x, height = bottom - y;
  const av = selectionCoverage(a, { x, y, width, height });
  const bv = selectionCoverage(clipped, { x, y, width, height });
  let left = width, top = height, nonzeroRight = 0, nonzeroBottom = 0;
  for (let i = 0; i < av.length; i++) {
    av[i] = mode === 'Add' ? Math.max(av[i]!, bv[i]!) : Math.round(av[i]! * (255 - bv[i]!) / 255);
    if (av[i]) {
      const px = i % width, py = Math.floor(i / width);
      if (px < left) left = px; if (py < top) top = py;
      if (px + 1 > nonzeroRight) nonzeroRight = px + 1; if (py + 1 > nonzeroBottom) nonzeroBottom = py + 1;
    }
  }
  if (nonzeroRight <= left) return emptySelection(shape.antialiased);
  return withKnownBounds({ mask: maskRaster(width, height, av), x, y, antialiased: shape.antialiased },
    { x: x + left, y: y + top, width: nonzeroRight - left, height: nonzeroBottom - top });
}

export function selectAll(canvas: CanvasSize): DocumentSelection {
  return withKnownBounds({ mask: solidMaskRaster(canvas.width, canvas.height, 255), x: 0, y: 0, antialiased: true },
    { x: 0, y: 0, width: canvas.width, height: canvas.height });
}

export function inverseSelection(selection: DocumentSelection, canvas: CanvasSize): DocumentSelection {
  const pixels = selectionCoverage(selection, { x: 0, y: 0, width: canvas.width, height: canvas.height });
  for (let i = 0; i < pixels.length; i++) pixels[i] = 255 - pixels[i]!;
  return trimSelection({ mask: maskRaster(canvas.width, canvas.height, pixels), x: 0, y: 0, antialiased: selection.antialiased });
}

export function moveSelection(selection: DocumentSelection, dx: number, dy: number): DocumentSelection {
  const rx = roundHalfAway(dx), ry = roundHalfAway(dy);
  const moved = { ...selection, x: selection.x + rx, y: selection.y + ry }, bounds = selectionBounds(selection);
  return withKnownBounds(moved, bounds ? { ...bounds, x: bounds.x + rx, y: bounds.y + ry } : null);
}

export function selectionBounds(selection: DocumentSelection): Rect | null {
  if (boundsCache.has(selection)) return boundsCache.get(selection) ?? null;
  let left = selection.mask.width, top = selection.mask.height, right = 0, bottom = 0;
  for (let row = 0; row < selection.mask.rows; row++) {
    for (let col = 0; col < selection.mask.cols; col++) {
      const tile = selection.mask.tiles[row * selection.mask.cols + col];
      if (!tile) continue;
      const tw = selection.mask.tileWidth(col), th = selection.mask.tileHeight(row);
      for (let py = 0; py < th; py++) for (let px = 0; px < tw; px++) if (tile[py * tw + px] !== 0) {
        const gx = col * TILE + px, gy = row * TILE + py;
        if (gx < left) left = gx; if (gx + 1 > right) right = gx + 1;
        if (gy < top) top = gy; if (gy + 1 > bottom) bottom = gy + 1;
      }
    }
  }
  const result = right > left && bottom > top
    ? { x: selection.x + left, y: selection.y + top, width: right - left, height: bottom - top } : null;
  boundsCache.set(selection, result); return result;
}

export function selectionContains(selection: DocumentSelection, point: Point): boolean {
  const x = Math.floor(point.x - selection.x), y = Math.floor(point.y - selection.y);
  return selection.mask.pixel(x, y)[0]! >= 128;
}

/** Coverage for a document-space integer region; outside the stored mask is zero. */
export function selectionCoverage(selection: DocumentSelection, rect: Rect): Uint8Array {
  const x = Math.trunc(rect.x), y = Math.trunc(rect.y), width = Math.max(0, Math.trunc(rect.width)), height = Math.max(0, Math.trunc(rect.height));
  if (width === 0 || height === 0) return new Uint8Array();
  return selection.mask.readRegion(x - selection.x, y - selection.y, width, height);
}

function trimSelection(selection: DocumentSelection): DocumentSelection {
  const b = selectionBounds(selection);
  if (!b) return emptySelection(selection.antialiased);
  const sx = b.x - selection.x, sy = b.y - selection.y;
  if (sx === 0 && sy === 0 && b.width === selection.mask.width && b.height === selection.mask.height) return selection;
  return withKnownBounds({ mask: maskRaster(b.width, b.height, selection.mask.readRegion(sx, sy, b.width, b.height)), x: b.x, y: b.y,
    antialiased: selection.antialiased }, b);
}

// Felzenszwalb-Huttenlocher exact squared Euclidean distance transform, one axis at a time.
function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let vk = v[k]!;
    let s = ((f[q]! + q * q) - (f[vk]! + vk * vk)) / (2 * q - 2 * vk);
    while (s <= z[k]!) {
      k--;
      const vk = v[k]!;
      s = ((f[q]! + q * q) - (f[vk]! + vk * vk)) / (2 * q - 2 * vk);
    }
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1]! < q) k++;
    const delta = q - v[k]!; d[q] = delta * delta + f[v[k]!]!;
  }
}

function distanceTo(binary: Uint8Array, width: number, height: number, target: number): Float64Array {
  const max = Math.max(width, height), inf = 1e20;
  const f = new Float64Array(max), d = new Float64Array(max), v = new Int32Array(max), z = new Float64Array(max + 1);
  const vertical = new Float64Array(width * height);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) f[y] = binary[y * width + x] === target ? 0 : inf;
    edt1d(f, height, d, v, z);
    for (let y = 0; y < height; y++) vertical[y * width + x] = d[y]!;
  }
  const result = new Float64Array(width * height);
  for (let y = 0; y < height; y++) {
    const offset = y * width;
    for (let x = 0; x < width; x++) f[x] = vertical[offset + x]!;
    edt1d(f, width, d, v, z);
    result.set(d.subarray(0, width), offset);
  }
  return result;
}

/** Exact local EDT from boundary pixels; faster for the compact, round offsets used by the menu. */
function boundaryOffset(binary: Uint8Array, width: number, height: number, grow: boolean, radius: number,
  antialiased: boolean): Uint8Array | null {
  const sourceValue = grow ? 1 : 0, sources: number[] = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = y * width + x;
    if (binary[index] !== sourceValue) continue;
    if ((x > 0 && binary[index - 1] !== sourceValue) || (x + 1 < width && binary[index + 1] !== sourceValue)
      || (y > 0 && binary[index - width] !== sourceValue) || (y + 1 < height && binary[index + width] !== sourceValue)) sources.push(index);
  }
  // Dense/noisy masks are better served by the linear-time FH transform below.
  if (sources.length * radius * radius * 3 > binary.length * 4) return null;
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary[i] ? 255 : 0;
  const limit = antialiased ? radius + 0.5 : radius, extent = Math.ceil(limit);
  for (const source of sources) {
    const sx = source % width, sy = Math.floor(source / width);
    for (let dy = -extent; dy <= extent; dy++) {
      const y = sy + dy; if (y < 0 || y >= height) continue;
      const squared = limit * limit - dy * dy; if (squared < 0) continue;
      const reach = Math.floor(Math.sqrt(squared));
      for (let dx = -reach; dx <= reach; dx++) {
        const x = sx + dx; if (x < 0 || x >= width) continue;
        const index = y * width + x;
        if (binary[index] === sourceValue) continue;
        let value: number;
        if (!antialiased) value = grow ? 255 : 0;
        else {
          const distance = Math.hypot(dx, dy);
          value = Math.round(Math.max(0, Math.min(1, grow ? radius + 0.5 - distance : distance - radius + 0.5)) * 255);
        }
        out[index] = grow ? Math.max(out[index]!, value) : Math.min(out[index]!, value);
      }
    }
  }
  return out;
}

/** Selection.swift `resizeSelection`: round Euclidean offset, limited to 500 px. */
export function resizeSelection(selection: DocumentSelection, amount: number, canvas: CanvasSize): DocumentSelection {
  if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 500 || selectionIsEmpty(selection)) return selection;
  const bounds = selectionBounds(selection)!;
  const pad = amount > 0 ? amount + 2 : 2;
  const region = clippedBounds({ x: bounds.x - pad, y: bounds.y - pad, width: bounds.width + pad * 2, height: bounds.height + pad * 2 }, canvas);
  if (!region) return emptySelection(selection.antialiased);
  const coverage = selectionCoverage(selection, region);
  const binary = new Uint8Array(coverage.length);
  for (let i = 0; i < coverage.length; i++) binary[i] = coverage[i]! >= 128 ? 1 : 0;
  const grow = amount > 0;
  const radius = Math.abs(amount);
  let out = boundaryOffset(binary, region.width, region.height, grow, radius, selection.antialiased);
  if (!out) {
    const dist = distanceTo(binary, region.width, region.height, grow ? 1 : 0);
    out = new Uint8Array(binary.length);
    for (let i = 0; i < out.length; i++) {
      const inside = binary[i] === 1;
      if ((grow && inside) || (!grow && !inside)) { out[i] = grow ? 255 : 0; continue; }
      const distance = Math.sqrt(dist[i]!);
      if (!selection.antialiased) out[i] = grow ? (distance <= radius ? 255 : 0) : (distance > radius ? 255 : 0);
      else {
        const value = grow ? radius + 0.5 - distance : distance - radius + 0.5;
        out[i] = Math.round(Math.max(0, Math.min(1, value)) * 255);
      }
    }
  }
  return trimSelection({ mask: maskRaster(region.width, region.height, out), x: region.x, y: region.y,
    antialiased: selection.antialiased });
}

export function expandSelection(selection: DocumentSelection, amount: number, canvas: CanvasSize): DocumentSelection {
  return resizeSelection(selection, Math.abs(amount), canvas);
}

export function contractSelection(selection: DocumentSelection, amount: number, canvas: CanvasSize): DocumentSelection {
  return resizeSelection(selection, -Math.abs(amount), canvas);
}

/** MaskTracing-style marching boundary at the 50% coverage contour, simplified to corners. */
export function selectionOutline(selection: DocumentSelection): SelectionPolyline[] {
  const width = selection.mask.width, height = selection.mask.height, stride = width + 1;
  const pixels = selection.mask.toPixels();
  const selected = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < width && y < height
    && pixels[y * width + x]! >= 128;
  const outgoing = new Map<number, number[]>();
  const edge = (x0: number, y0: number, x1: number, y1: number): void => {
    const key = y0 * stride + x0, list = outgoing.get(key);
    if (list) list.push(y1 * stride + x1); else outgoing.set(key, [y1 * stride + x1]);
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (selected(x, y)) {
    if (!selected(x, y - 1)) edge(x, y, x + 1, y);
    if (!selected(x + 1, y)) edge(x + 1, y, x + 1, y + 1);
    if (!selected(x, y + 1)) edge(x + 1, y + 1, x, y + 1);
    if (!selected(x - 1, y)) edge(x, y + 1, x, y);
  }
  const result: Point[][] = [];
  while (outgoing.size) {
    const start = outgoing.keys().next().value as number;
    const loop: number[] = [];
    let current = start;
    do {
      const ends = outgoing.get(current);
      if (!ends?.length) break;
      const end = ends.pop()!;
      if (!ends.length) outgoing.delete(current);
      loop.push(current); current = end;
    } while (current !== start);
    if (current !== start || loop.length < 3) continue;
    const corners: Point[] = [];
    for (let i = 0; i < loop.length; i++) {
      const previous = loop[(i + loop.length - 1) % loop.length]!, vertex = loop[i]!, following = loop[(i + 1) % loop.length]!;
      const inX = vertex % stride - previous % stride, inY = Math.floor(vertex / stride) - Math.floor(previous / stride);
      const outX = following % stride - vertex % stride, outY = Math.floor(following / stride) - Math.floor(vertex / stride);
      if (inX !== outX || inY !== outY) corners.push({ x: selection.x + vertex % stride, y: selection.y + Math.floor(vertex / stride) });
    }
    if (corners.length >= 3) { corners.push({ ...corners[0]! }); result.push(corners); }
  }
  return result;
}
