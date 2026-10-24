import type { TextEngine } from '../../text';
import type { Point, VectorPath } from '../model';
import { Raster } from '../raster';
import type { DocumentSelection } from '../selection';
import { pathFillCoverage } from './render';

export function pathsToSelection(engine: TextEngine, paths: readonly VectorPath[], bounds: { x: number; y: number; width: number; height: number },
  antialiased = true): DocumentSelection {
  // Upstream Document/Selection.swift (`DocumentSelection.coverage`) rasterizes white path coverage on black.
  const x = Math.floor(bounds.x), y = Math.floor(bounds.y);
  const width = Math.max(1, Math.ceil(bounds.x + bounds.width) - x);
  const height = Math.max(1, Math.ceil(bounds.y + bounds.height) - y);
  const coverage = pathFillCoverage(engine, width, height, paths, 1, { x: -x, y: -y });
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) {
    const value = coverage[i]!;
    mask[i] = antialiased ? value : value >= 128 ? 255 : 0;
  }
  return { mask: Raster.fromPixels(width, height, 1, mask), x, y, antialiased };
}

function perpendicularDistance(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  if (dx === 0 && dy === 0) return Math.hypot(point.x - a.x, point.y - a.y);
  return Math.abs(dy * point.x - dx * point.y + b.x * a.y - b.y * a.x) / Math.hypot(dx, dy);
}

function simplify(points: readonly Point[], tolerance: number): Point[] {
  if (points.length <= 2 || tolerance <= 0) return [...points];
  const keep = new Uint8Array(points.length), stack = [0, points.length - 1]; keep[0] = keep[points.length - 1] = 1;
  while (stack.length) {
    const end = stack.pop()!, start = stack.pop()!;
    let farthest = 0, index = 0;
    for (let i = start + 1; i < end; i++) {
      const d = perpendicularDistance(points[i]!, points[start]!, points[end]!);
      if (d > farthest) { farthest = d; index = i; }
    }
    if (farthest > tolerance) { keep[index] = 1; stack.push(start, index, index, end); }
  }
  const result: Point[] = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) result.push(points[i]!);
  return result;
}

/** Boundary tracing of the stored antialiased selection at the Photoshop-style 50% threshold. */
export function selectionToPaths(selection: DocumentSelection, tolerance = 1): readonly VectorPath[] {
  if (!(tolerance >= 0) || !Number.isFinite(tolerance)) throw new RangeError('Tracing tolerance must be non-negative');
  const width = selection.mask.width, height = selection.mask.height, pixels = selection.mask.toPixels();
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && pixels[y * width + x]! >= 128;
  const boundary = (x: number, y: number, direction: number): boolean => inside(x, y) && (direction === 0
    ? !inside(x, y - 1) : direction === 1 ? !inside(x + 1, y) : direction === 2 ? !inside(x, y + 1) : !inside(x - 1, y));
  const start = (x: number, y: number, direction: number): Point => direction === 0 ? { x, y }
    : direction === 1 ? { x: x + 1, y } : direction === 2 ? { x: x + 1, y: y + 1 } : { x, y: y + 1 };
  const end = (x: number, y: number, direction: number): Point => direction === 0 ? { x: x + 1, y }
    : direction === 1 ? { x: x + 1, y: y + 1 } : direction === 2 ? { x, y: y + 1 } : { x, y };
  const used = new Uint8Array(width * height), result: VectorPath[] = [], turns = [1, 0, 3, 2] as const;
  for (let initialY = 0; initialY < height; initialY++) for (let initialX = 0; initialX < width; initialX++) {
    for (let initialDirection = 0; initialDirection < 4; initialDirection++) {
      if (!boundary(initialX, initialY, initialDirection)
        || (used[initialY * width + initialX]! & (1 << initialDirection))) continue;
      const outline: Point[] = [], first = start(initialX, initialY, initialDirection);
      let x = initialX, y = initialY, direction = initialDirection;
      for (let guard = 0; guard <= width * height * 4; guard++) {
        used[y * width + x] = used[y * width + x]! | (1 << direction);
        outline.push(start(x, y, direction));
        const vertex = end(x, y, direction);
        if (vertex.x === first.x && vertex.y === first.y) break;
        let found = false;
        for (const turn of turns) {
          const nextDirection = (direction + turn) % 4;
          const nextX = nextDirection === 0 || nextDirection === 3 ? vertex.x : vertex.x - 1;
          const nextY = nextDirection === 0 || nextDirection === 1 ? vertex.y : vertex.y - 1;
          if (nextX >= 0 && nextY >= 0 && nextX < width && nextY < height && boundary(nextX, nextY, nextDirection)
            && !(used[nextY * width + nextX]! & (1 << nextDirection))) {
            x = nextX; y = nextY; direction = nextDirection; found = true; break;
          }
        }
        if (!found) break;
      }
      if (outline.length < 3) continue;
      const closed = [...outline, outline[0]!], reduced = simplify(closed, tolerance).slice(0, -1);
      result.push({ schemaVersion: 1, closed: true, fillRule: 'evenodd', points: reduced.map((anchor) => {
        const documentAnchor = { x: anchor.x + selection.x, y: anchor.y + selection.y };
        return { anchor: documentAnchor, in: documentAnchor, out: documentAnchor, kind: 'corner' as const };
      }) });
    }
  }
  return result;
}
