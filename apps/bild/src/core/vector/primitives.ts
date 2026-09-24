import type { LayerShape, VectorPath } from '../model';

const KAPPA = 0.5522847498307936;
const point = (x: number, y: number, inX = x, inY = y, outX = x, outY = y, kind: 'corner' | 'smooth' = 'corner') => ({
  anchor: { x, y }, in: { x: inX, y: inY }, out: { x: outX, y: outY }, kind,
});

function path(points: ReturnType<typeof point>[], closed = true): VectorPath {
  return { schemaVersion: 1, closed, fillRule: 'nonzero', points };
}

export function rectanglePath(width: number, height: number,
  radii: number | readonly [number, number, number, number] = 0): VectorPath {
  const source = typeof radii === 'number' ? [radii, radii, radii, radii] as const : radii;
  const scale = Math.min(1, width / Math.max(1e-12, source[0] + source[1]), width / Math.max(1e-12, source[2] + source[3]),
    height / Math.max(1e-12, source[0] + source[3]), height / Math.max(1e-12, source[1] + source[2]));
  const [tl, tr, br, bl] = source.map((value) => Math.max(0, value) * scale) as [number, number, number, number];
  if (tl + tr + br + bl === 0) return path([point(0, 0), point(width, 0), point(width, height), point(0, height)]);
  return path([
    point(tl, 0, tl - tl * KAPPA, 0), point(width - tr, 0, width - tr, 0, width - tr + tr * KAPPA, 0),
    point(width, tr, width, tr - tr * KAPPA), point(width, height - br, width, height - br, width, height - br + br * KAPPA),
    point(width - br, height, width - br + br * KAPPA, height), point(bl, height, bl, height, bl - bl * KAPPA, height),
    point(0, height - bl, 0, height - bl + bl * KAPPA), point(0, tl, 0, tl, 0, tl - tl * KAPPA),
  ]);
}

export function ellipsePath(width: number, height: number): VectorPath {
  const cx = width / 2, cy = height / 2;
  return path([
    point(cx, 0, cx - cx * KAPPA, 0, cx + cx * KAPPA, 0, 'smooth'),
    point(width, cy, width, cy - cy * KAPPA, width, cy + cy * KAPPA, 'smooth'),
    point(cx, height, cx + cx * KAPPA, height, cx - cx * KAPPA, height, 'smooth'),
    point(0, cy, 0, cy + cy * KAPPA, 0, cy - cy * KAPPA, 'smooth'),
  ]);
}

export function polygonPath(width: number, height: number, sides: number, cornerRadius = 0): VectorPath {
  const count = Math.max(3, Math.min(1000, Math.round(sides))), cx = width / 2, cy = height / 2;
  const rx = width / 2, ry = height / 2;
  const vertices = Array.from({ length: count }, (_, i) => {
    const angle = -Math.PI / 2 + i * Math.PI * 2 / count;
    return { x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry };
  });
  if (!(cornerRadius > 0)) return path(vertices.map((p) => point(p.x, p.y)));
  const points: ReturnType<typeof point>[] = [];
  for (let i = 0; i < count; i++) {
    const previous = vertices[(i + count - 1) % count]!, current = vertices[i]!, next = vertices[(i + 1) % count]!;
    const before = Math.min(cornerRadius, Math.hypot(current.x - previous.x, current.y - previous.y) / 2);
    const after = Math.min(cornerRadius, Math.hypot(next.x - current.x, next.y - current.y) / 2);
    const into = before / Math.max(1e-12, Math.hypot(current.x - previous.x, current.y - previous.y));
    const out = after / Math.max(1e-12, Math.hypot(next.x - current.x, next.y - current.y));
    const a = { x: current.x + (previous.x - current.x) * into, y: current.y + (previous.y - current.y) * into };
    const b = { x: current.x + (next.x - current.x) * out, y: current.y + (next.y - current.y) * out };
    points.push(point(a.x, a.y, a.x, a.y, current.x, current.y), point(b.x, b.y, current.x, current.y, b.x, b.y));
  }
  return path(points);
}

export function starPath(width: number, height: number, points: number, innerRatio: number, cornerRadius = 0): VectorPath {
  const count = Math.max(2, Math.min(500, Math.round(points))), ratio = Math.max(0.01, Math.min(0.99, innerRatio));
  const cx = width / 2, cy = height / 2, rx = width / 2, ry = height / 2;
  const vertices = Array.from({ length: count * 2 }, (_, i) => {
    const inner = i % 2 === 1, angle = -Math.PI / 2 + i * Math.PI / count;
    return { x: cx + Math.cos(angle) * rx * (inner ? ratio : 1), y: cy + Math.sin(angle) * ry * (inner ? ratio : 1) };
  });
  if (!(cornerRadius > 0)) return path(vertices.map((p) => point(p.x, p.y)));
  // Reuse the corner construction with the already alternating radial vertices.
  const result: ReturnType<typeof point>[] = [];
  for (let i = 0; i < vertices.length; i++) {
    const previous = vertices[(i + vertices.length - 1) % vertices.length]!, current = vertices[i]!, next = vertices[(i + 1) % vertices.length]!;
    const da = Math.hypot(current.x - previous.x, current.y - previous.y), db = Math.hypot(next.x - current.x, next.y - current.y);
    const a = Math.min(cornerRadius, da / 2) / Math.max(da, 1e-12), b = Math.min(cornerRadius, db / 2) / Math.max(db, 1e-12);
    const p0 = { x: current.x + (previous.x - current.x) * a, y: current.y + (previous.y - current.y) * a };
    const p1 = { x: current.x + (next.x - current.x) * b, y: current.y + (next.y - current.y) * b };
    result.push(point(p0.x, p0.y, p0.x, p0.y, current.x, current.y), point(p1.x, p1.y, current.x, current.y, p1.x, p1.y));
  }
  return path(result);
}

export function linePath(width: number, height: number): VectorPath {
  return path([point(0, height / 2), point(width, height / 2)], false);
}

export function primitivePaths(shape: LayerShape, width: number, height: number): readonly VectorPath[] {
  switch (shape.kind) {
    case 'Rectangle': return [rectanglePath(width, height, shape.cornerRadii ?? shape.cornerRadius)];
    case 'Ellipse': return [ellipsePath(width, height)];
    case 'Polygon': return [polygonPath(width, height, shape.sides ?? 3, shape.cornerRadius)];
    case 'Star': return [starPath(width, height, shape.sides ?? 5, shape.innerRatio ?? 0.5, shape.cornerRadius)];
    case 'Line': return [linePath(width, height)];
  }
}
