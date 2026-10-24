import { describe, expect, it } from 'vitest';
import { compositeRegion } from '../../src/core/composite';
import { newLayer, type CanvasDocument } from '../../src/core/document';
import { makeTransform } from '../../src/core/geometry';
import { createMeshWarp, inverseMeshPoint, meshPoint, meshPreset } from '../../src/core/meshWarp';
import { Raster } from '../../src/core/raster';
import { WarpStroke } from '../../src/core/retouch';
import { detectStraightenAngle, straightenDocument } from '../../src/core/straighten';

function raster(width: number, height: number, pixel: (x: number, y: number) => readonly number[]): Raster {
  const bytes = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) bytes.set(pixel(x, y), (y * width + x) * 4);
  return Raster.fromPixels(width, height, 4, bytes);
}

function document(source: Raster, warp: ReturnType<typeof createMeshWarp> | null): CanvasDocument {
  const transform = makeTransform({ x: 8, y: 8 }, { width: source.width, height: source.height }, { sampling: 'High quality' });
  return { id: 'warp', width: 32, height: 32, resolution: 72, selection: null,
    layers: [newLayer({ id: 'pixels', name: 'Pixels', raster: source, transform, warp })] };
}

describe('non-destructive mesh warp', () => {
  it('renders an identity 4x4 Bezier patch pixel-identically', () => {
    const checker = raster(16, 16, (x, y) => (x + y) % 2 ? [240, 30, 10, 255] : [5, 90, 220, 255]);
    const plain = document(checker, null), mesh = createMeshWarp(plain.layers[0]!.transform);
    const expected = compositeRegion(plain, { x: 0, y: 0, width: 32, height: 32 }).rgba;
    const actual = compositeRegion(document(checker, mesh), { x: 0, y: 0, width: 32, height: 32 }).rgba;
    expect(actual).toEqual(expected);
    const inverse = inverseMeshPoint(mesh, meshPoint(mesh, { x: 0.37, y: 0.62 }))!;
    expect(inverse.x).toBeCloseTo(0.37, 5); expect(inverse.y).toBeCloseTo(0.62, 5);
  });

  it('renders a known arc into the curved destination rather than the affine rectangle', () => {
    const source = raster(16, 16, () => [220, 80, 20, 255]);
    const transform = makeTransform({ x: 8, y: 8 }, { width: 16, height: 16 }, { sampling: 'High quality' });
    const warped = meshPreset(transform, 'arc', 0.25);
    const result = compositeRegion(document(source, warped), { x: 0, y: 0, width: 32, height: 32 }).rgba;
    const alpha = (x: number, y: number) => result[(y * 32 + x) * 4 + 3]!;
    expect(alpha(16, 5)).toBeGreaterThan(100);
    expect(alpha(8, 5)).toBeLessThan(10);
    expect(meshPoint(warped, { x: 0.5, y: 0 }).y).toBeCloseTo(5.4, 1);
  });

  it('projects a checkerboard into a known perspective trapezoid', () => {
    const checker = raster(8, 8, (x, y) => (Math.floor(x / 2) + Math.floor(y / 2)) % 2
      ? [255, 255, 255, 255] : [0, 0, 0, 255]);
    const transform = makeTransform({ x: 8, y: 8 }, { width: 16, height: 16 }, { sampling: 'Nearest' });
    const warp = { kind: 'quad' as const, schemaVersion: 1 as const, corners: [
      { x: 8, y: 8 }, { x: 24, y: 8 }, { x: 20, y: 24 }, { x: 12, y: 24 },
    ] as const };
    const doc: CanvasDocument = { id: 'perspective', width: 32, height: 32, resolution: 72, selection: null,
      layers: [newLayer({ id: 'checker', name: 'Checker', raster: checker, transform, warp })] };
    const pixels = compositeRegion(doc, { x: 0, y: 0, width: 32, height: 32 }).rgba;
    const rgba = (x: number, y: number) => Array.from(pixels.slice((y * 32 + x) * 4, (y * 32 + x) * 4 + 4));
    expect(rgba(9, 9)).toEqual([0, 0, 0, 255]);
    expect(rgba(22, 9)).toEqual([255, 255, 255, 255]);
    expect(rgba(9, 22)[3]).toBe(0);
    expect(rgba(22, 22)[3]).toBe(0);
  });
});

describe('straighten', () => {
  it('detects a generated tilted horizon with the Hough accumulator', () => {
    const degrees = 12, slope = Math.tan(degrees * Math.PI / 180);
    const tilted = raster(96, 64, (x, y) => y >= 31 + (x - 48) * slope ? [20, 20, 20, 255] : [235, 235, 235, 255]);
    expect(detectStraightenAngle(tilted)).toBeCloseTo(degrees, 0);
  });

  it('rotates and crops all layers in one document result without exposed corners', () => {
    const source = raster(80, 60, () => [255, 255, 255, 255]);
    const doc: CanvasDocument = { id: 'straighten', width: 80, height: 60, resolution: 72, selection: null,
      layers: [newLayer({ id: 'photo', name: 'Photo', raster: source,
        transform: makeTransform({ x: 0, y: 0 }, { width: 80, height: 60 }) })] };
    const result = straightenDocument(doc, 10);
    expect(result.width).toBeLessThan(80); expect(result.height).toBeLessThan(60);
    expect(result.layers[0]!.transform.rotation).toBe(-10);
    const pixels = compositeRegion(result, { x: 0, y: 0, width: result.width, height: result.height }).rgba;
    expect(Math.min(...Array.from(pixels.filter((_value, index) => index % 4 === 3)))).toBeGreaterThan(200);
  });
});

describe('liquify light', () => {
  it('pushes a bright feature and reconstruct restores it toward the workspace source', () => {
    const source = raster(41, 21, (x, y) => x >= 8 && x <= 10 && y >= 7 && y <= 13 ? [255, 255, 255, 255] : [0, 0, 0, 255]);
    const transform = makeTransform({ x: 0, y: 0 }, { width: 41, height: 21 });
    const push = new WarpStroke(source, transform, 'push', { diameter: 16, hardness: 0.8, strength: 1, density: 1 });
    push.addPoints([{ x: 9, y: 10 }, { x: 20, y: 10 }]);
    const moved = push.finish();
    const centre = (value: Raster) => {
      let weighted = 0, total = 0;
      for (let y = 0; y < value.height; y++) for (let x = 0; x < value.width; x++) {
        const red = value.pixel(x, y)[0]!; weighted += x * red; total += red;
      }
      return weighted / total;
    };
    expect(centre(moved)).toBeGreaterThan(centre(source) + 2);
    const reconstruct = new WarpStroke(moved, transform, 'reconstruct',
      { diameter: 24, hardness: 0.8, strength: 1, density: 1 }, null, source);
    reconstruct.addPoints([{ x: 15, y: 10 }]);
    const restored = reconstruct.finish();
    let movedError = 0, restoredError = 0;
    for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) {
      movedError += Math.abs(moved.pixel(x, y)[0]! - source.pixel(x, y)[0]!);
      restoredError += Math.abs(restored.pixel(x, y)[0]! - source.pixel(x, y)[0]!);
    }
    expect(restoredError).toBeLessThan(movedError);
  });

  it('bloat and pucker displace a ring in opposite radial directions', () => {
    const source = raster(41, 41, (x, y) => Math.abs(Math.hypot(x - 20, y - 20) - 7) < 1 ? [255, 255, 255, 255] : [0, 0, 0, 255]);
    const transform = makeTransform({ x: 0, y: 0 }, { width: 41, height: 41 });
    const bloat = new WarpStroke(source, transform, 'bloat', { diameter: 30, hardness: 0.4, strength: 1, density: 1 });
    const pucker = new WarpStroke(source, transform, 'pucker', { diameter: 30, hardness: 0.4, strength: 1, density: 1 });
    bloat.addPoints([{ x: 20, y: 20 }]); pucker.addPoints([{ x: 20, y: 20 }]);
    const radius = (value: Raster) => {
      let weighted = 0, total = 0;
      for (let y = 0; y < 41; y++) for (let x = 0; x < 41; x++) {
        const red = value.pixel(x, y)[0]!; weighted += Math.hypot(x - 20, y - 20) * red; total += red;
      }
      return weighted / total;
    };
    expect(radius(bloat.finish())).toBeGreaterThan(radius(source));
    expect(radius(pucker.finish())).toBeLessThan(radius(source));
  });
});
