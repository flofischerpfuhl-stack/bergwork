import type { TextEngine } from '../../text';
import type { FillParameters, Layer, RGB, VectorMask, VectorPath, VectorStyle } from '../model';
import { apply, concat, invert, makeTransform, pixelToDocument, type LayerTransform } from '../geometry';
import { maskBackground } from '../distort';
import { gaussianBlur } from '../filters/blur';
import { Raster } from '../raster';
import { pathsToSvg } from './path';

export interface RenderedVector { readonly raster: Raster; readonly transform: LayerTransform }

const renderedPaths = new WeakMap<readonly VectorPath[], Map<string, Raster>>();

function rgba(color: RGB, alpha = 1) { return { ...color, alpha }; }
/** CanvasKit's Color constructor takes byte-range RGB and unit alpha. */
function canvasKitRgba(color: RGB, alpha = 1) {
  return { red: color.red * 255, green: color.green * 255, blue: color.blue * 255, alpha };
}
function clamp01(value: number): number { return Math.max(0, Math.min(1, value)); }

function fillColor(fill: FillParameters, x: number, y: number, width: number, height: number): [number, number, number, number] {
  if (fill.kind === 'solid') return [fill.color.red, fill.color.green, fill.color.blue, 1];
  if (fill.kind === 'pattern') return [0, 0, 0, 0];
  const angle = fill.angle * Math.PI / 180, cx = width / 2, cy = height / 2;
  const span = Math.max(1e-12, Math.abs(Math.cos(angle)) * width + Math.abs(Math.sin(angle)) * height);
  const t = clamp01(((x - cx) * Math.cos(angle) + (y - cy) * Math.sin(angle)) / span + 0.5);
  const stops = [...fill.stops].sort((a, b) => a.offset - b.offset);
  let left = stops[0]!, right = stops.at(-1)!;
  for (let i = 1; i < stops.length; i++) if (t <= stops[i]!.offset) { left = stops[i - 1]!; right = stops[i]!; break; }
  const mix = right.offset === left.offset ? 0 : clamp01((t - left.offset) / (right.offset - left.offset));
  return [left.color.red + (right.color.red - left.color.red) * mix,
    left.color.green + (right.color.green - left.color.green) * mix,
    left.color.blue + (right.color.blue - left.color.blue) * mix,
    left.opacity + (right.opacity - left.opacity) * mix];
}

function markerSvg(path: VectorPath, atStart: boolean, marker: NonNullable<NonNullable<VectorStyle['stroke']>['startMarker']>,
  size: number, scale: number): string {
  if (marker === 'none' || path.points.length < 2) return '';
  const endpoint = atStart ? path.points[0]! : path.points.at(-1)!;
  const neighbour = atStart ? path.points[1]! : path.points.at(-2)!;
  const control = atStart ? endpoint.out : endpoint.in;
  let dx = endpoint.anchor.x - control.x, dy = endpoint.anchor.y - control.y;
  if (Math.hypot(dx, dy) < 1e-9) { dx = endpoint.anchor.x - neighbour.anchor.x; dy = endpoint.anchor.y - neighbour.anchor.y; }
  const length = Math.max(1e-12, Math.hypot(dx, dy)), ux = dx / length, uy = dy / length, px = -uy, py = ux;
  const tip = endpoint.anchor, base = { x: tip.x - ux * size, y: tip.y - uy * size }, half = size * 0.45;
  const q = (v: number) => Number((v * scale).toFixed(6));
  if (marker === 'arrow') return `M${q(tip.x)} ${q(tip.y)}L${q(base.x + px * half)} ${q(base.y + py * half)}L${q(base.x - px * half)} ${q(base.y - py * half)}Z`;
  if (marker === 'openArrow') return `M${q(base.x + px * half)} ${q(base.y + py * half)}L${q(tip.x)} ${q(tip.y)}L${q(base.x - px * half)} ${q(base.y - py * half)}`;
  const cx = tip.x - ux * size / 2, cy = tip.y - uy * size / 2;
  if (marker === 'square') {
    const h = size / 2;
    return `M${q(cx + ux * h + px * h)} ${q(cy + uy * h + py * h)}L${q(cx + ux * h - px * h)} ${q(cy + uy * h - py * h)}L${q(cx - ux * h - px * h)} ${q(cy - uy * h - py * h)}L${q(cx - ux * h + px * h)} ${q(cy - uy * h + py * h)}Z`;
  }
  const r = size / 2, k = r * 0.5522847498307936;
  return `M${q(cx + r)} ${q(cy)}C${q(cx + r)} ${q(cy + k)} ${q(cx + k)} ${q(cy + r)} ${q(cx)} ${q(cy + r)}C${q(cx - k)} ${q(cy + r)} ${q(cx - r)} ${q(cy + k)} ${q(cx - r)} ${q(cy)}C${q(cx - r)} ${q(cy - k)} ${q(cx - k)} ${q(cy - r)} ${q(cx)} ${q(cy - r)}C${q(cx + k)} ${q(cy - r)} ${q(cx + r)} ${q(cy - k)} ${q(cx + r)} ${q(cy)}Z`;
}

function coverage(engine: TextEngine, width: number, height: number, svgPath: string, stroke?: { width: number; dash?: readonly number[];
  dashOffset?: number; join?: 'miter' | 'round' | 'bevel'; cap?: 'butt' | 'round' | 'square'; miterLimit?: number },
  fillRule: 'nonzero' | 'evenodd' = 'nonzero'): Uint8Array {
  if (!svgPath.trim()) return new Uint8Array(width * height);
  const raster = engine.rasterizePath({ width, height, svgPath, fillRule, ...(stroke
    ? { stroke: { color: rgba({ red: 1, green: 1, blue: 1 }), width: stroke.width, dash: stroke.dash,
      dashPhase: stroke.dashOffset, join: stroke.join, cap: stroke.cap } }
    : { fill: { kind: 'solid' as const, color: rgba({ red: 1, green: 1, blue: 1 }) } }) }).raster;
  const pixels = raster.toPixels(), alpha = new Uint8Array(width * height);
  for (let i = 0; i < alpha.length; i++) alpha[i] = pixels[i * 4 + 3]!;
  return alpha;
}

export function pathFillCoverage(engine: TextEngine, width: number, height: number, paths: readonly VectorPath[], scale = 1,
  offset: { x: number; y: number } = { x: 0, y: 0 }): Uint8Array {
  if (paths.length && paths.every((path) => (path.fillRule ?? 'nonzero') === 'evenodd')) {
    const result = new Uint8Array(width * height);
    for (const path of paths) {
      const next = coverage(engine, width, height, pathsToSvg([path], scale, offset), undefined, 'evenodd');
      for (let i = 0; i < result.length; i++) {
        const a = result[i]! / 255, b = next[i]! / 255;
        result[i] = Math.round((a + b - 2 * a * b) * 255);
      }
    }
    return result;
  }
  return coverage(engine, width, height, pathsToSvg(paths, scale, offset));
}

export function renderVector(engine: TextEngine, paths: readonly VectorPath[], style: VectorStyle,
  width: number, height: number, pixelsPerDocumentPixel = 1): Raster {
  if (!(width > 0 && height > 0 && pixelsPerDocumentPixel > 0) || ![width, height, pixelsPerDocumentPixel].every(Number.isFinite)) {
    throw new RangeError('Invalid vector render size');
  }
  const outWidth = Math.max(1, Math.ceil(width * pixelsPerDocumentPixel));
  const outHeight = Math.max(1, Math.ceil(height * pixelsPerDocumentPixel));
  if (outWidth > 30_000 || outHeight > 30_000 || outWidth * outHeight > 100_000_000) {
    throw new RangeError('Vector render exceeds document limits');
  }
  const cacheKey = JSON.stringify([outWidth, outHeight, pixelsPerDocumentPixel, style]);
  const cached = renderedPaths.get(paths)?.get(cacheKey);
  if (cached) return cached;
  const remember = (raster: Raster): Raster => {
    if (outWidth * outHeight > 4_000_000) return raster;
    let variants = renderedPaths.get(paths);
    if (!variants) { variants = new Map(); renderedPaths.set(paths, variants); }
    if (variants.size >= 3) variants.delete(variants.keys().next().value as string);
    variants.set(cacheKey, raster);
    return raster;
  };
  if (!paths.some((path) => path.points.length > 0)) return remember(Raster.blank(outWidth, outHeight, 4));
  const svg = pathsToSvg(paths, pixelsPerDocumentPixel);
  const simpleStroke = style.stroke && style.stroke.alignment === 'center' && !style.stroke.paint
    && (style.stroke.startMarker ?? 'none') === 'none' && (style.stroke.endMarker ?? 'none') === 'none';
  if ((!style.stroke || simpleStroke) && style.fill?.kind !== 'pattern'
    && paths.every((path) => (path.fillRule ?? 'nonzero') !== 'evenodd')) {
    const fill = style.fill?.kind === 'solid' ? { kind: 'solid' as const, color: canvasKitRgba(style.fill.color) }
      : style.fill?.kind === 'gradient' ? linearGradient(style.fill, outWidth, outHeight) : undefined;
    const strokePaint = simpleStroke ? { color: canvasKitRgba(style.stroke!.color), width: style.stroke!.width * pixelsPerDocumentPixel,
      dash: style.stroke!.dash?.map((value) => value * pixelsPerDocumentPixel),
      dashPhase: (style.stroke!.dashOffset ?? 0) * pixelsPerDocumentPixel, join: style.stroke!.join, cap: style.stroke!.cap,
      miterLimit: style.stroke!.miterLimit } : undefined;
    return remember(engine.rasterizePath({ width: outWidth, height: outHeight, svgPath: svg, fill, stroke: strokePaint }).raster);
  }
  const fillAlpha = style.fill && style.fill.kind !== 'pattern'
    ? pathFillCoverage(engine, outWidth, outHeight, paths, pixelsPerDocumentPixel) : null;
  const stroke = style.stroke;
  let strokeAlpha: Uint8Array | null = null, markerFill: Uint8Array | null = null;
  if (stroke && stroke.width > 0) {
    const markerPaths: string[] = [], openMarkerPaths: string[] = [];
    for (const path of paths) for (const [start, marker] of [[true, stroke.startMarker ?? 'none'], [false, stroke.endMarker ?? 'none']] as const) {
      const generated = markerSvg(path, start, marker, (stroke.markerSize ?? 3) * stroke.width, pixelsPerDocumentPixel);
      if (generated) (marker === 'openArrow' ? openMarkerPaths : markerPaths).push(generated);
    }
    strokeAlpha = coverage(engine, outWidth, outHeight, svg, {
      width: stroke.width * pixelsPerDocumentPixel * (stroke.alignment === 'center' ? 1 : 2),
      dash: stroke.dash?.map((v) => v * pixelsPerDocumentPixel), dashOffset: (stroke.dashOffset ?? 0) * pixelsPerDocumentPixel,
      join: stroke.join, cap: stroke.cap, miterLimit: stroke.miterLimit });
    if (openMarkerPaths.length) {
      const markerStroke = coverage(engine, outWidth, outHeight, openMarkerPaths.join(' '), {
        width: stroke.width * pixelsPerDocumentPixel, join: stroke.join, cap: stroke.cap, miterLimit: stroke.miterLimit,
      });
      for (let i = 0; i < strokeAlpha.length; i++) strokeAlpha[i] = Math.max(strokeAlpha[i]!, markerStroke[i]!);
    }
    if (markerPaths.length) markerFill = coverage(engine, outWidth, outHeight, markerPaths.join(' '));
  }
  const pixels = new Uint8Array(outWidth * outHeight * 4), strokePaint = stroke?.paint ?? (stroke
    ? { kind: 'solid' as const, schemaVersion: 1 as const, color: stroke.color } : null);
  for (let y = 0, i = 0; y < outHeight; y++) for (let x = 0; x < outWidth; x++, i++) {
    const fa = fillAlpha?.[i] ?? 0;
    let sa = Math.max(strokeAlpha?.[i] ?? 0, markerFill?.[i] ?? 0);
    if (stroke?.alignment === 'inside') sa = Math.round(sa * fa / 255);
    else if (stroke?.alignment === 'outside') sa = Math.round(sa * (255 - fa) / 255);
    const fill = style.fill ? fillColor(style.fill, x, y, outWidth, outHeight) : [0, 0, 0, 0] as const;
    const line = strokePaint ? fillColor(strokePaint, x, y, outWidth, outHeight) : [0, 0, 0, 0] as const;
    const af = fa / 255 * fill[3], as = sa / 255 * line[3], alpha = as + af * (1 - as), offset = i * 4;
    if (alpha > 0) {
      pixels[offset] = Math.round(clamp01((line[0] * as + fill[0] * af * (1 - as)) / alpha) * 255);
      pixels[offset + 1] = Math.round(clamp01((line[1] * as + fill[1] * af * (1 - as)) / alpha) * 255);
      pixels[offset + 2] = Math.round(clamp01((line[2] * as + fill[2] * af * (1 - as)) / alpha) * 255);
      pixels[offset + 3] = Math.round(alpha * 255);
    }
  }
  return remember(Raster.fromPixels(outWidth, outHeight, 4, pixels));
}

function linearGradient(fill: Extract<FillParameters, { kind: 'gradient' }>, width: number, height: number) {
  const angle = fill.angle * Math.PI / 180, cx = width / 2, cy = height / 2;
  const span = Math.abs(Math.cos(angle)) * width + Math.abs(Math.sin(angle)) * height;
  const dx = Math.cos(angle) * span / 2, dy = Math.sin(angle) * span / 2;
  const stops = [...fill.stops].sort((a, b) => a.offset - b.offset);
  return { kind: 'linear-gradient' as const, start: [cx - dx, cy - dy] as const, end: [cx + dx, cy + dy] as const,
    colors: stops.map((stop) => canvasKitRgba(stop.color, stop.opacity)), positions: stops.map((stop) => stop.offset) };
}

function blurMask(pixels: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const rgba = new Uint8Array(pixels.length * 4);
  for (let i = 0; i < pixels.length; i++) rgba[i * 4 + 3] = pixels[i]!;
  const blurred = gaussianBlur(Raster.fromPixels(width, height, 4, rgba), radius).toPixels(), result = new Uint8Array(pixels.length);
  for (let i = 0; i < result.length; i++) result[i] = blurred[i * 4 + 3]!;
  return result;
}

export function renderVectorMask(engine: TextEngine, mask: VectorMask, width: number, height: number,
  pixelsPerDocumentPixel = 1): Raster {
  const outWidth = Math.max(1, Math.ceil(width * pixelsPerDocumentPixel)), outHeight = Math.max(1, Math.ceil(height * pixelsPerDocumentPixel));
  if (outWidth > 30_000 || outHeight > 30_000 || outWidth * outHeight > 100_000_000) {
    throw new RangeError('Vector mask render exceeds document limits');
  }
  let pixels = pathFillCoverage(engine, outWidth, outHeight, mask.paths, pixelsPerDocumentPixel);
  if ((mask.feather ?? 0) > 0) pixels = blurMask(pixels, outWidth, outHeight, mask.feather! * pixelsPerDocumentPixel);
  const density = clamp01(mask.density ?? 1);
  for (let i = 0; i < pixels.length; i++) {
    const value = mask.inverted ? 255 - pixels[i]! : pixels[i]!;
    pixels[i] = Math.round(255 - (255 - value) * density);
  }
  return Raster.fromPixels(outWidth, outHeight, 1, pixels);
}

export class VectorRasterCache {
  private readonly entries = new Map<string, { key: string; raster: Raster }>();
  private readonly masks = new Map<string, { key: string; raster: Raster }>();
  constructor(private readonly engine: TextEngine) {}
  prepare(layers: readonly Layer[], pixelsPerDocumentPixel: number): void {
    const live = new Set<string>();
    for (const layer of layers) {
      if (layer.kind === 'vector') {
        live.add(layer.id);
        const key = JSON.stringify([pixelsPerDocumentPixel, layer.paths, layer.style, layer.transform]);
        if (this.entries.get(layer.id)?.key !== key) {
          const previewOnly = !!layer.raster && ((layer.style.fill?.kind === 'pattern')
            || layer.style.stroke?.paint?.kind === 'pattern' || (!layer.style.fill && !layer.style.stroke));
          const raster = previewOnly ? layer.raster
            : renderVector(this.engine, layer.paths, layer.style, layer.transform.size.width, layer.transform.size.height, pixelsPerDocumentPixel);
          this.entries.set(layer.id, { key, raster });
        }
      }
      if (layer.vectorMask?.enabled) {
        const key = JSON.stringify([pixelsPerDocumentPixel, layer.vectorMask, layer.transform, layer.mask?.placement ?? null,
          layer.mask?.raster.id ?? null]);
        if (this.masks.get(layer.id)?.key !== key) {
          let raster = renderVectorMask(this.engine, layer.vectorMask, layer.transform.size.width, layer.transform.size.height, pixelsPerDocumentPixel);
          if (layer.mask?.enabled) raster = combineRasterMask(layer, raster);
          this.masks.set(layer.id, { key, raster });
        }
      }
    }
    for (const id of this.entries.keys()) if (!live.has(id)) this.entries.delete(id);
    for (const id of this.masks.keys()) if (!layers.some((layer) => layer.id === id && layer.vectorMask?.enabled)) this.masks.delete(id);
  }
  raster(layer: Layer): Raster | null { return layer.kind === 'vector' ? this.entries.get(layer.id)?.raster ?? layer.raster : layer.raster ?? null; }
  transform(layer: Layer): LayerTransform { return layer.transform; }
  maskRaster(layer: Layer): Raster | null { return this.masks.get(layer.id)?.raster ?? layer.mask?.raster ?? null; }
  maskPlacement(layer: Layer): LayerTransform | null {
    return this.masks.has(layer.id) ? null : layer.mask?.placement ?? null;
  }
  clear(): void { this.entries.clear(); this.masks.clear(); }
}

function combineRasterMask(layer: Layer, vectorMask: Raster): Raster {
  const storedMask = layer.mask!;
  const stored = storedMask.raster, pixels = vectorMask.toPixels(), storedPixels = stored.toPixels();
  const vectorToDocument = pixelToDocument(layer.transform, vectorMask.width, vectorMask.height);
  const documentToStored = invert(pixelToDocument(storedMask.placement ?? layer.transform, stored.width, stored.height));
  const map = concat(vectorToDocument, documentToStored), outside = maskBackground(stored);
  const sample = (x: number, y: number): number => {
    if (x < 0 || y < 0 || x >= stored.width || y >= stored.height) return outside;
    return storedPixels[Math.floor(y) * stored.width + Math.floor(x)]! / 255;
  };
  for (let y = 0; y < vectorMask.height; y++) for (let x = 0; x < vectorMask.width; x++) {
    const point = apply(map, { x: x + 0.5, y: y + 0.5 }), sx = point.x - 0.5, sy = point.y - 0.5;
    const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
    const coverage = sample(x0, y0) * (1 - fx) * (1 - fy) + sample(x0 + 1, y0) * fx * (1 - fy)
      + sample(x0, y0 + 1) * (1 - fx) * fy + sample(x0 + 1, y0 + 1) * fx * fy;
    const index = y * vectorMask.width + x;
    pixels[index] = Math.round(pixels[index]! * coverage);
  }
  return Raster.fromPixels(vectorMask.width, vectorMask.height, 1, pixels);
}

export function vectorRasterTransform(x: number, y: number, width: number, height: number): LayerTransform {
  return makeTransform({ x, y }, { width, height }, { sampling: 'High quality' });
}
