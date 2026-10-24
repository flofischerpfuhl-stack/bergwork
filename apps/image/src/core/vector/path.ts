import type { Point, VectorPath } from '../model';

const NUMBER = '-?(?:\\d*\\.\\d+|\\d+\\.?)(?:[eE][+-]?\\d+)?';

function finite(value: number): number {
  if (!Number.isFinite(value)) throw new RangeError('Vector coordinates must be finite');
  return Object.is(value, -0) ? 0 : value;
}

function n(value: number): string {
  const safe = finite(value);
  return Number(safe.toFixed(6)).toString();
}

export function normalizedPath(path: VectorPath): VectorPath {
  return {
    schemaVersion: 1,
    closed: path.closed,
    fillRule: path.fillRule ?? 'nonzero',
    points: path.points.map((point) => ({
      anchor: { x: finite(point.anchor.x), y: finite(point.anchor.y) },
      in: { x: finite(point.in.x), y: finite(point.in.y) },
      out: { x: finite(point.out.x), y: finite(point.out.y) },
      kind: point.kind ?? 'corner',
    })),
  };
}

/** Cubic representation used by CanvasKit's SVG parser. Handles belong to their anchor. */
export function pathToSvg(path: VectorPath, scale = 1, offset: Point = { x: 0, y: 0 }): string {
  const points = path.points;
  if (!points.length) return '';
  const xy = (point: Point) => `${n((point.x + offset.x) * scale)} ${n((point.y + offset.y) * scale)}`;
  let result = `M${xy(points[0]!.anchor)}`;
  const count = path.closed ? points.length : points.length - 1;
  for (let index = 0; index < count; index++) {
    const from = points[index]!, to = points[(index + 1) % points.length]!;
    const straight = from.out.x === from.anchor.x && from.out.y === from.anchor.y
      && to.in.x === to.anchor.x && to.in.y === to.anchor.y;
    result += straight ? `L${xy(to.anchor)}` : `C${xy(from.out)} ${xy(to.in)} ${xy(to.anchor)}`;
  }
  return path.closed ? `${result}Z` : result;
}

export function pathsToSvg(paths: readonly VectorPath[], scale = 1, offset: Point = { x: 0, y: 0 }): string {
  return paths.map((path) => pathToSvg(path, scale, offset)).filter(Boolean).join(' ');
}

/** Parses the absolute M/L/C/Q/Z subset emitted by Skia Path.toSVGString(). */
export function svgToPaths(svg: string): VectorPath[] {
  const tokens = svg.match(new RegExp(`[MLCQZmlcqz]|${NUMBER}`, 'g')) ?? [];
  const paths: VectorPath[] = [];
  let index = 0, command = '', current: Point = { x: 0, y: 0 }, start: Point = current;
  let points: Array<{ anchor: Point; in: Point; out: Point; kind: 'corner' | 'smooth' }> = [];
  const number = () => {
    const token = tokens[index++];
    if (token === undefined || /[A-Za-z]/.test(token)) throw new Error('Invalid SVG path data');
    return Number(token);
  };
  const point = (relative: boolean): Point => {
    const x = number(), y = number();
    return relative ? { x: current.x + x, y: current.y + y } : { x, y };
  };
  const finish = (closed: boolean) => {
    if (points.length) paths.push({ schemaVersion: 1, closed, fillRule: 'nonzero', points });
    points = [];
  };
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (/[A-Za-z]/.test(token)) { command = token; index++; }
    if (!command) throw new Error('Invalid SVG path data');
    const relative = command === command.toLowerCase();
    switch (command.toUpperCase()) {
      case 'M': {
        if (points.length) finish(false);
        current = point(relative); start = current;
        points.push({ anchor: current, in: current, out: current, kind: 'corner' });
        command = relative ? 'l' : 'L';
        break;
      }
      case 'L': {
        current = point(relative);
        points.push({ anchor: current, in: current, out: current, kind: 'corner' });
        break;
      }
      case 'C': {
        const c1 = point(relative), c2 = point(relative), target = point(relative);
        const previous = points.at(-1);
        if (!previous) throw new Error('Invalid SVG cubic segment');
        previous.out = c1;
        current = target;
        points.push({ anchor: target, in: c2, out: target, kind: 'smooth' });
        break;
      }
      case 'Q': {
        const control = point(relative), target = point(relative), previous = points.at(-1);
        if (!previous) throw new Error('Invalid SVG quadratic segment');
        previous.out = { x: current.x + (control.x - current.x) * 2 / 3, y: current.y + (control.y - current.y) * 2 / 3 };
        const incoming = { x: target.x + (control.x - target.x) * 2 / 3, y: target.y + (control.y - target.y) * 2 / 3 };
        current = target;
        points.push({ anchor: target, in: incoming, out: target, kind: 'smooth' });
        break;
      }
      case 'Z': current = start; finish(true); command = ''; break;
      default: throw new Error(`Unsupported SVG path command ${command}`);
    }
  }
  finish(false);
  return paths;
}

function cubic(a: number, b: number, c: number, d: number, t: number): number {
  const u = 1 - t;
  return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
}

function extrema(a: number, b: number, c: number, d: number): number[] {
  const qa = -a + 3 * b - 3 * c + d, qb = 2 * (a - 2 * b + c), qc = b - a;
  if (Math.abs(qa) < 1e-12) return Math.abs(qb) < 1e-12 ? [] : [-qc / qb].filter((t) => t > 0 && t < 1);
  const discriminant = qb * qb - 4 * qa * qc;
  if (discriminant < 0) return [];
  const root = Math.sqrt(discriminant);
  return [(-qb + root) / (2 * qa), (-qb - root) / (2 * qa)].filter((t) => t > 0 && t < 1);
}

export function vectorBounds(paths: readonly VectorPath[]): { x: number; y: number; width: number; height: number } | null {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  const add = (point: Point) => { left = Math.min(left, point.x); top = Math.min(top, point.y); right = Math.max(right, point.x); bottom = Math.max(bottom, point.y); };
  for (const path of paths) {
    for (const point of path.points) add(point.anchor);
    const segments = path.closed ? path.points.length : Math.max(0, path.points.length - 1);
    for (let i = 0; i < segments; i++) {
      const a = path.points[i]!, d = path.points[(i + 1) % path.points.length]!;
      for (const t of extrema(a.anchor.x, a.out.x, d.in.x, d.anchor.x)) add({ x: cubic(a.anchor.x, a.out.x, d.in.x, d.anchor.x, t), y: cubic(a.anchor.y, a.out.y, d.in.y, d.anchor.y, t) });
      for (const t of extrema(a.anchor.y, a.out.y, d.in.y, d.anchor.y)) add({ x: cubic(a.anchor.x, a.out.x, d.in.x, d.anchor.x, t), y: cubic(a.anchor.y, a.out.y, d.in.y, d.anchor.y, t) });
    }
  }
  return Number.isFinite(left) ? { x: left, y: top, width: right - left, height: bottom - top } : null;
}
