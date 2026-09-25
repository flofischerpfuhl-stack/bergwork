/** Non-destructive bicubic mesh warp used by the CPU/GPU compositors and warp tool. */

import { apply, unitToDocument, type LayerTransform, type Point } from './geometry';
import type { WarpMesh } from './model';

export const MAX_MESH_SPLITS = 8;
export type WarpPreset = NonNullable<WarpMesh['preset']>;

function finitePoint(point: Point): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y)
    && Math.abs(point.x) <= 1_000_000 && Math.abs(point.y) <= 1_000_000;
}

export function meshColumns(mesh: Pick<WarpMesh, 'splits'>): number { return mesh.splits.x * 3 + 1; }
export function meshRows(mesh: Pick<WarpMesh, 'splits'>): number { return mesh.splits.y * 3 + 1; }

export function isValidMeshWarp(value: unknown): value is WarpMesh {
  if (!value || typeof value !== 'object') return false;
  const mesh = value as Partial<WarpMesh>;
  if (mesh.kind !== 'mesh' || mesh.schemaVersion !== 1 || !mesh.splits || !Array.isArray(mesh.points)) return false;
  const { x, y } = mesh.splits;
  if (!Number.isInteger(x) || !Number.isInteger(y) || x! < 1 || y! < 1 || x! > MAX_MESH_SPLITS || y! > MAX_MESH_SPLITS) return false;
  return mesh.points.length === (x! * 3 + 1) * (y! * 3 + 1) && mesh.points.every(finitePoint);
}

export function createMeshWarp(transform: LayerTransform, splits = { x: 1, y: 1 }): WarpMesh {
  if (!Number.isInteger(splits.x) || !Number.isInteger(splits.y) || splits.x < 1 || splits.y < 1
    || splits.x > MAX_MESH_SPLITS || splits.y > MAX_MESH_SPLITS) throw new RangeError('Invalid mesh split count');
  const columns = splits.x * 3 + 1, rows = splits.y * 3 + 1;
  const map = unitToDocument(transform), points: Point[] = [];
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    points.push(apply(map, { x: column / (columns - 1), y: row / (rows - 1) }));
  }
  return { kind: 'mesh', schemaVersion: 1, splits: { ...splits }, points, preset: 'custom' };
}

function basis(t: number): readonly [number, number, number, number] {
  const s = 1 - t;
  return [s * s * s, 3 * s * s * t, 3 * s * t * t, t * t * t];
}

function derivativeBasis(t: number): readonly [number, number, number, number] {
  const s = 1 - t;
  return [-3 * s * s, 3 * s * s - 6 * s * t, 6 * s * t - 3 * t * t, 3 * t * t];
}

function patchPoint(mesh: WarpMesh, patchX: number, patchY: number, u: number, v: number,
  du = false, dv = false): Point {
  const columns = meshColumns(mesh), bu = du ? derivativeBasis(u) : basis(u), bv = dv ? derivativeBasis(v) : basis(v);
  let x = 0, y = 0;
  for (let row = 0; row < 4; row++) for (let column = 0; column < 4; column++) {
    const point = mesh.points[(patchY * 3 + row) * columns + patchX * 3 + column]!;
    const weight = bu[column]! * bv[row]!;
    x += point.x * weight; y += point.y * weight;
  }
  return { x, y };
}

/** Evaluates the document-space surface at source unit coordinates. */
export function meshPoint(mesh: WarpMesh, unit: Point): Point {
  const sx = Math.min(mesh.splits.x - 1, Math.max(0, Math.floor(unit.x * mesh.splits.x)));
  const sy = Math.min(mesh.splits.y - 1, Math.max(0, Math.floor(unit.y * mesh.splits.y)));
  return patchPoint(mesh, sx, sy, unit.x * mesh.splits.x - sx, unit.y * mesh.splits.y - sy);
}

export interface MeshInverse { readonly x: number; readonly y: number; readonly error: number }

/** Inverts each bicubic patch with Newton iterations, retaining the best converged source coordinate. */
export function inverseMeshPoint(mesh: WarpMesh, target: Point): MeshInverse | null {
  let best: MeshInverse | null = null;
  for (let patchY = 0; patchY < mesh.splits.y; patchY++) for (let patchX = 0; patchX < mesh.splits.x; patchX++) {
    let u = 0.5, v = 0.5;
    // Four coarse seeds make strongly curved, but still non-folded, patches reliable.
    for (const seed of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]] as const) {
      u = seed[0]; v = seed[1];
      for (let iteration = 0; iteration < 12; iteration++) {
        const p = patchPoint(mesh, patchX, patchY, u, v);
        const a = patchPoint(mesh, patchX, patchY, u, v, true, false);
        const b = patchPoint(mesh, patchX, patchY, u, v, false, true);
        const rx = p.x - target.x, ry = p.y - target.y;
        const det = a.x * b.y - a.y * b.x;
        if (Math.abs(det) < 1e-10) break;
        const stepU = (rx * b.y - ry * b.x) / det;
        const stepV = (a.x * ry - a.y * rx) / det;
        u -= stepU; v -= stepV;
        if (Math.abs(stepU) + Math.abs(stepV) < 1e-7) break;
      }
      const p = patchPoint(mesh, patchX, patchY, u, v);
      const error = Math.hypot(p.x - target.x, p.y - target.y);
      if (u >= -1e-5 && u <= 1.00001 && v >= -1e-5 && v <= 1.00001 && (!best || error < best.error)) {
        best = { x: (patchX + Math.min(1, Math.max(0, u))) / mesh.splits.x,
          y: (patchY + Math.min(1, Math.max(0, v))) / mesh.splits.y, error };
      }
    }
  }
  return best && best.error <= 0.35 ? best : null;
}

/** Generates document-space mesh triangles. UV interpolation converges to the bicubic surface as density rises. */
export function tessellateMesh(mesh: WarpMesh, segmentsPerPatch = 24): {
  positions: Float32Array; uvs: Float32Array; indices: Uint32Array;
} {
  const sx = mesh.splits.x * segmentsPerPatch, sy = mesh.splits.y * segmentsPerPatch;
  const positions = new Float32Array((sx + 1) * (sy + 1) * 2), uvs = new Float32Array(positions.length);
  for (let row = 0; row <= sy; row++) for (let column = 0; column <= sx; column++) {
    const u = column / sx, v = row / sy, point = meshPoint(mesh, { x: u, y: v });
    const offset = (row * (sx + 1) + column) * 2;
    positions[offset] = point.x; positions[offset + 1] = point.y; uvs[offset] = u; uvs[offset + 1] = v;
  }
  const indices = new Uint32Array(sx * sy * 6);
  let offset = 0;
  for (let row = 0; row < sy; row++) for (let column = 0; column < sx; column++) {
    const a = row * (sx + 1) + column, b = a + 1, d = (row + 1) * (sx + 1) + column, c = d + 1;
    indices.set([a, b, c, a, c, d], offset); offset += 6;
  }
  return { positions, uvs, indices };
}

/** Presets are deterministic control-grid edits; custom handle dragging can continue from the result. */
export function meshPreset(transform: LayerTransform, preset: WarpPreset, amount = 0.25,
  splits = { x: 1, y: 1 }): WarpMesh {
  const mesh = createMeshWarp(transform, splits), columns = meshColumns(mesh), rows = meshRows(mesh);
  const points = mesh.points.map((point, index) => {
    const u = (index % columns) / (columns - 1), v = Math.floor(index / columns) / (rows - 1);
    let dx = 0, dy = 0;
    const w = transform.size.width, h = transform.size.height;
    if (preset === 'arc') dy = -Math.sin(Math.PI * u) * h * amount;
    else if (preset === 'flag') dy = Math.sin(2 * Math.PI * u) * h * amount * (0.35 + 0.65 * v);
    else if (preset === 'wave') dy = Math.sin(2 * Math.PI * u) * h * amount;
    else if (preset === 'bulge' || preset === 'inflate') {
      const factor = amount * 0.65 * Math.sin(Math.PI * u) * Math.sin(Math.PI * v);
      dx = (u - 0.5) * w * factor; dy = (v - 0.5) * h * factor;
    } else if (preset === 'squeeze') {
      dx = -(u - 0.5) * w * amount * Math.sin(Math.PI * v);
    } else if (preset === 'fish') {
      dx = (u - 0.5) * w * amount * Math.sin(Math.PI * v); dy = -Math.sin(Math.PI * u) * h * amount * 0.35;
    } else if (preset === 'rise') dy = -u * h * amount;
    return { x: point.x + dx, y: point.y + dy };
  });
  return { ...mesh, points, preset };
}
