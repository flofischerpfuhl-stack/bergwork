import type { Layer, Point, VectorPath } from '../model';
import { apply, invert, pixelToDocument } from '../geometry';

export type VectorHit =
  | { readonly kind: 'anchor' | 'in' | 'out'; readonly pathIndex: number; readonly pointIndex: number; readonly point: Point; readonly distance: number }
  | { readonly kind: 'segment'; readonly pathIndex: number; readonly segmentIndex: number; readonly t: number; readonly point: Point; readonly distance: number };

function distance(a: Point, b: Point): number { return Math.hypot(a.x - b.x, a.y - b.y); }
function cubic(a: Point, b: Point, c: Point, d: Point, t: number): Point {
  const u = 1 - t, aa = u * u * u, bb = 3 * u * u * t, cc = 3 * u * t * t, dd = t * t * t;
  return { x: aa * a.x + bb * b.x + cc * c.x + dd * d.x, y: aa * a.y + bb * b.y + cc * c.y + dd * d.y };
}

/** Nearest editable feature in layer-local/document units; no allocations occur per cubic sample. */
export function hitTestPaths(paths: readonly VectorPath[], query: Point, tolerance: number): VectorHit | null {
  if (!(tolerance >= 0) || !Number.isFinite(tolerance)) return null;
  let hit: VectorHit | null = null, best = tolerance;
  for (let pathIndex = 0; pathIndex < paths.length; pathIndex++) {
    const path = paths[pathIndex]!;
    for (let pointIndex = 0; pointIndex < path.points.length; pointIndex++) {
      const value = path.points[pointIndex]!;
      for (const kind of ['anchor', 'in', 'out'] as const) {
        const candidate = value[kind], d = distance(candidate, query);
        if ((hit === null && d <= best) || d < best) { best = d; hit = { kind, pathIndex, pointIndex, point: candidate, distance: d }; }
      }
    }
    const segmentCount = path.closed ? path.points.length : Math.max(0, path.points.length - 1);
    for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex++) {
      const a = path.points[segmentIndex]!, b = path.points[(segmentIndex + 1) % path.points.length]!;
      // 24 coarse intervals followed by ternary refinement gives stable UI hit testing for highly curved segments.
      let nearestT = 0, nearest = Infinity;
      for (let sample = 0; sample <= 24; sample++) {
        const t = sample / 24, d = distance(cubic(a.anchor, a.out, b.in, b.anchor, t), query);
        if (d < nearest) { nearest = d; nearestT = t; }
      }
      let low = Math.max(0, nearestT - 1 / 24), high = Math.min(1, nearestT + 1 / 24);
      for (let iteration = 0; iteration < 8; iteration++) {
        const t1 = low + (high - low) / 3, t2 = high - (high - low) / 3;
        if (distance(cubic(a.anchor, a.out, b.in, b.anchor, t1), query)
          < distance(cubic(a.anchor, a.out, b.in, b.anchor, t2), query)) high = t2; else low = t1;
      }
      const t = (low + high) / 2, candidate = cubic(a.anchor, a.out, b.in, b.anchor, t), d = distance(candidate, query);
      if ((hit === null && d <= best) || d < best) { best = d; hit = { kind: 'segment', pathIndex, segmentIndex, t, point: candidate, distance: d }; }
    }
  }
  return hit;
}

/** Hit-tests a vector layer with both query and returned hit point in document space. */
export function hitTestVectorLayer(layer: Layer, query: Point, tolerance: number): VectorHit | null {
  if (layer.kind !== 'vector') return null;
  const localToDocument = pixelToDocument(layer.transform, layer.transform.size.width, layer.transform.size.height);
  const hit = hitTestPaths(layer.paths, apply(invert(localToDocument), query), tolerance);
  return hit ? { ...hit, point: apply(localToDocument, hit.point) } : null;
}
