/**
 * The Type tool on paths (PRODUCT-PLAN 6.6, Phase 3; Photoshop's type on a path): finding a shape or pen path under the
 * pointer, copying it into a new text layer's frame, and the geometry the canvas overlay needs for text on a path
 * (the path itself, its start/end markers, hit testing near the glyphs).
 */

import { effectiveVisibleIds, renderLayers, type TextLayer, type VectorPath } from '../../core/document';
import { apply, invert, makeTransform, pixelToDocument, type Affine, type LayerTransform, type Point } from '../../core/geometry';
import type { EditorSession } from '../../core/session';
import { PathMeasure } from '../../core/text';
import { vectorBounds } from '../../core/vector';

/** Photoshop's type-on-a-path cursor: an I-beam crossed by a curve (hotspot where they meet). */
export const PATH_TEXT_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke-linecap="round">'
  + '<g stroke="#fff" stroke-width="3.2"><path d="M9 4h6M12 4v16M9 20h6"/><path d="M3 17c4-6 6 2 9-3s5-4 9-2"/></g>'
  + '<g stroke="#000" stroke-width="1.3"><path d="M9 4h6M12 4v16M9 20h6"/><path d="M3 17c4-6 6 2 9-3s5-4 9-2" stroke-dasharray="2 1.6"/></g>'
  + '</svg>')}") 12 14, text`;

const measures = new WeakMap<VectorPath, PathMeasure>();
export function measureOf(path: VectorPath): PathMeasure {
  let measure = measures.get(path);
  if (!measure) { measure = new PathMeasure(path); measures.set(path, measure); }
  return measure;
}

function mapPath(path: VectorPath, map: Affine): VectorPath {
  return { ...path, points: path.points.map((point) => ({ ...point, anchor: apply(map, point.anchor), in: apply(map, point.in),
    out: apply(map, point.out) })) };
}

/** A layer's frame pixels → document pixels (vector layers and text on a path are drawn 1:1 in their frame). */
export function frameToDocument(transform: LayerTransform): Affine {
  return pixelToDocument(transform, transform.size.width, transform.size.height);
}

export interface PathUnderPointer {
  /** The path in document pixels. */
  readonly path: VectorPath;
  /** Where the pointer meets it, as a fraction of its length. */
  readonly fraction: number;
  readonly layerId: string;
}

/** The topmost visible shape layer's path within `tolerance` document pixels of `pixel`. */
export function pathUnderPointer(session: EditorSession, pixel: Point, tolerance: number): PathUnderPointer | null {
  const document = session.document;
  if (!document) return null;
  const visible = effectiveVisibleIds(document.layers);
  for (const layer of [...renderLayers(document.layers)].reverse()) {
    if (layer.kind !== 'vector' || !visible.has(layer.id) || !layer.paths.length) continue;
    const map = frameToDocument(layer.transform), local = apply(invert(map), pixel);
    for (const path of layer.paths) {
      if (path.points.length < 2) continue;
      const measure = measureOf(path);
      if (!(measure.length > 0)) continue;
      const hit = measure.project(local);
      if (Math.hypot(hit.point.x - local.x, hit.point.y - local.y) > tolerance) continue;
      // The frame map is rigid (rotation, flips), so arc-length fractions carry over to document space.
      return { path: mapPath(path, map), fraction: Math.max(0, Math.min(1, hit.s / measure.length)), layerId: layer.id };
    }
  }
  return null;
}

/** A text layer frame for a document-space path: its bounding box, with the path in frame pixels. */
export function textPathFrame(path: VectorPath): { transform: LayerTransform; path: VectorPath } {
  const bounds = vectorBounds([path]) ?? { x: 0, y: 0, width: 1, height: 1 };
  const transform = makeTransform({ x: bounds.x, y: bounds.y }, { width: Math.max(1, bounds.width), height: Math.max(1, bounds.height) });
  const shift = (point: Point) => ({ x: point.x - bounds.x, y: point.y - bounds.y });
  return { transform, path: { ...path, points: path.points.map((point) => ({ ...point, anchor: shift(point.anchor), in: shift(point.in), out: shift(point.out) })) } };
}

/** Largest type size of a layer, in document pixels. */
export function largestTypePixels(session: EditorSession, layer: TextLayer): number {
  const resolution = session.document?.resolution ?? 72;
  return Math.max(1, ...layer.runs.map((run) => run.style.fontSize)) * resolution / 72;
}

/** Whether a document point lies on the band of glyphs along a text path (rather than anywhere in its box). */
export function nearPathText(session: EditorSession, layer: TextLayer, pixel: Point, margin: number): boolean {
  const settings = layer.textPath;
  if (!settings) return true;
  const local = apply(invert(frameToDocument(layer.transform)), pixel);
  const hit = measureOf(settings.path).project(local);
  const size = largestTypePixels(session, layer), resolution = session.document?.resolution ?? 72;
  // Distance along the text's own normal (reversed when flipped), measured from the lifted baseline: glyphs stand
  // above it (negative), later lines follow below.
  const along = (settings.flipped ? -hit.normalDistance : hit.normalDistance) + settings.baselineOffset * resolution / 72;
  const lines = Math.max(1, layer.text.split('\n').length);
  return along >= -size * 1.25 - margin && along <= size * 0.5 + (lines - 1) * size * 1.4 + margin;
}

/** Document-space points along a text layer's path, every few pixels (overlay drawing). */
export function textPathPolyline(layer: TextLayer): Point[] {
  const settings = layer.textPath;
  if (!settings) return [];
  const measure = measureOf(settings.path), map = frameToDocument(layer.transform);
  const steps = Math.max(2, Math.min(2000, Math.ceil(measure.length / 3)));
  const result: Point[] = [];
  for (let i = 0; i <= steps; i++) result.push(apply(map, measure.at(measure.length * i / steps).point));
  return result;
}

export interface PathMarker { readonly point: Point; readonly normal: Point }

/** The start and end markers of the text range in document space, with the path's normal there. */
export function textPathMarkers(layer: TextLayer): { start: PathMarker; end: PathMarker } | null {
  const settings = layer.textPath;
  if (!settings) return null;
  const measure = measureOf(settings.path), map = frameToDocument(layer.transform);
  const linear: Affine = { ...map, tx: 0, ty: 0 };
  const marker = (fraction: number): PathMarker => {
    const sample = measure.at(measure.length * fraction), direction = apply(linear, sample.tangent);
    const length = Math.hypot(direction.x, direction.y) || 1;
    return { point: apply(map, sample.point), normal: { x: -direction.y / length, y: direction.x / length } };
  };
  return { start: marker(settings.start), end: marker(settings.end) };
}

/** Where a document point meets a text layer's path, as a fraction of its length. */
export function textPathFraction(layer: TextLayer, pixel: Point): number {
  const settings = layer.textPath;
  if (!settings) return 0;
  const measure = measureOf(settings.path);
  const hit = measure.project(apply(invert(frameToDocument(layer.transform)), pixel));
  return measure.length > 0 ? Math.max(0, Math.min(1, hit.s / measure.length)) : 0;
}
