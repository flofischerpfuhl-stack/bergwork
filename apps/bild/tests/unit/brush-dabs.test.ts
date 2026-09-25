import { describe, expect, it } from 'vitest';
import { newLayer, type Layer } from '../../src/core/document';
import { makeTransform, type Point } from '../../src/core/geometry';
import { Raster, TILE } from '../../src/core/raster';
import {
  DEFAULT_BRUSH_DYNAMICS, DEFAULT_BRUSH_SETTINGS, DabPlacer, RecordedBrushStroke, beginSettledStroke, beginStroke,
  brushReach, brushSegment, dabCoverage, prepareDab, tipLevels, usesDabs,
  type BrushDynamics, type BrushSettings, type BrushTipImage,
} from '../../src/core/brush';

function layer(width: number, height: number, raster: Raster | null = null): Layer {
  return newLayer({ id: 'paint', name: 'Paint', raster, transform: makeTransform({ x: 0, y: 0 }, { width, height }) });
}

function solid(width: number, height: number, rgba: readonly number[], format: 'rgba8' | 'rgba16' = 'rgba8'): Raster {
  const data = format === 'rgba16' ? new Uint16Array(width * height * 4) : new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(rgba, i * 4);
  return Raster.fromPixels(width, height, 4, data as Uint8Array, format === 'rgba16' ? { format } : undefined);
}

function dabSettings(dynamics: Partial<BrushDynamics>, fields: Partial<BrushSettings> = {}): BrushSettings {
  return { ...DEFAULT_BRUSH_SETTINGS, red: 1, green: 0, blue: 0, diameter: 20, hardness: 1,
    dynamics: { ...DEFAULT_BRUSH_DYNAMICS, ...dynamics }, ...fields };
}

/** A soft ring tip, generated here: 0 in the middle, 255 on a ring (texture that differs from any procedural tip). */
function ringTip(size: number): BrushTipImage {
  const data = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const d = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / (size / 2);
    data[y * size + x] = d > 0.55 && d < 0.95 ? 255 : 0;
  }
  return { id: `ring-${size}`, width: size, height: size, data };
}

const path: Point[] = [{ x: 30, y: 60 }, { x: 90, y: 110 }, { x: 170, y: 70 }, { x: 250, y: 160 }, { x: 330, y: 120 }, { x: 420, y: 300 }];

/** Runs the same points through the synchronous stroke and through worker-style settled partitions. */
function syncAndPartitions(settings: BrushSettings, base: Raster | null, size: { width: number; height: number }, count: number,
  pressure?: readonly number[], tilt?: readonly number[]) {
  const options = { layer: layer(size.width, size.height, base), canvas: size, settings };
  const recorded = new RecordedBrushStroke(options);
  path.forEach((point, index) => recorded.addPoints([point], {
    ...(pressure ? { pressure: pressure[index]! } : {}), ...(tilt ? { tilt: tilt[index]! } : {}) }));
  const sync = recorded.finish();
  const segments = recorded.gpuPreview.settled;
  const third = Math.ceil(segments.length / 3);
  const partitions = Array.from({ length: count }, (_, index) => {
    const stroke = beginSettledStroke({ ...options, tilePartition: { index, count } });
    stroke.addSettled(segments.slice(0, third));
    stroke.addSettled(segments.slice(third, third * 2));
    return stroke.finish(segments.slice(third * 2));
  });
  return { sync, partitions, dabs: recorded.gpuPreview.dabs ?? [] };
}

describe('dab placement (Photoshop spacing, scatter and jitter)', () => {
  it('places dabs every spacing × diameter along the path, carried across segments', () => {
    const placer = new DabPlacer(dabSettings({ spacing: 0.5 }));
    const dabs = placer.place([brushSegment({ x: 0, y: 0 }, { x: 0, y: 0 }, 1), brushSegment({ x: 0, y: 0 }, { x: 33, y: 0 }, 1),
      brushSegment({ x: 33, y: 0 }, { x: 100, y: 0 }, 1)]);
    expect(dabs.map((dab) => Math.round(dab.x * 1000) / 1000)).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    expect(dabs.every((dab) => dab.y === 0 && dab.size === 20 && dab.alpha === 1)).toBe(true);
  });

  it('is deterministic for the same segments and independent of batching, and a peeked tail changes nothing', () => {
    const settings = dabSettings({ spacing: 0.3, scatter: 1.5, count: 3, sizeJitter: 0.6, angleJitter: 0.5, opacityJitter: 0.4 },
      { tip: { kind: 'round', angle: 30, roundness: 0.4 } });
    const segments = [brushSegment({ x: 10, y: 10 }, { x: 10, y: 10 }, 1), brushSegment({ x: 10, y: 10 }, { x: 80, y: 40 }, 0.8),
      brushSegment({ x: 80, y: 40 }, { x: 160, y: 20 }, 0.5)];
    const whole = new DabPlacer(settings).place(segments);
    const split = new DabPlacer(settings);
    const first = split.place(segments.slice(0, 2));
    split.peek([brushSegment({ x: 80, y: 40 }, { x: 300, y: 300 }, 1)]);
    expect([...first, ...split.place(segments.slice(2))]).toEqual(whole);
    expect(whole.length % 3).toBe(0);
    // Scatter moves dabs off the path; jitter varies size, angle and strength.
    expect(Math.max(...whole.map((dab) => dab.size)) - Math.min(...whole.map((dab) => dab.size))).toBeGreaterThan(4);
    expect(new Set(whole.map((dab) => dab.angle.toFixed(3))).size).toBeGreaterThan(whole.length / 2);
    expect(Math.min(...whole.map((dab) => dab.alpha))).toBeLessThan(0.8);
    const toPath = (x: number, y: number) => Math.min(...segments.slice(1).map((s) => {
      const t = Math.min(1, Math.max(0, ((x - s.x0) * s.vx + (y - s.y0) * s.vy) / (s.length * s.length)));
      return Math.hypot(x - s.x0 - t * s.vx, y - s.y0 - t * s.vy);
    }));
    const farthest = Math.max(...whole.map((dab) => toPath(dab.x, dab.y)));
    expect(farthest).toBeGreaterThan(8);
    expect(farthest).toBeLessThanOrEqual(1.5 * 20 + 1e-9);
  });

  it('size follows pen pressure or tilt down to the minimum diameter', () => {
    const pressure = new DabPlacer(dabSettings({ spacing: 1, sizeControl: 'pressure', minimumDiameter: 0.25, opacityControl: 'off' }))
      .place([brushSegment({ x: 0, y: 0 }, { x: 0, y: 0 }, 0), brushSegment({ x: 0, y: 0 }, { x: 60, y: 0 }, 0.5)]);
    expect(pressure[0]!.size).toBeCloseTo(5);
    expect(pressure[1]!.size).toBeCloseTo(20 * (0.25 + 0.75 * 0.5));
    const tilt = new DabPlacer(dabSettings({ spacing: 1, sizeControl: 'tilt', minimumDiameter: 0 }))
      .place([brushSegment({ x: 0, y: 0 }, { x: 0, y: 0 }, 1, 0.3)]);
    expect(tilt[0]!.size).toBeCloseTo(6);
  });

  it('keeps plain round brushes on the continuous engine and widens the reach for scatter', () => {
    expect(usesDabs(DEFAULT_BRUSH_SETTINGS)).toBe(false);
    expect(usesDabs({ ...DEFAULT_BRUSH_SETTINGS, dynamics: DEFAULT_BRUSH_DYNAMICS, tip: { kind: 'round', angle: 45, roundness: 1 } })).toBe(false);
    expect(usesDabs(dabSettings({ flow: 0.5 }))).toBe(true);
    expect(brushReach(DEFAULT_BRUSH_SETTINGS)).toBe(22);
    expect(brushReach(dabSettings({ scatter: 2 }))).toBe(10 + 40 + 3);
  });
});

describe('dab rasterization (exact CPU and worker commit)', () => {
  it('spacing leaves gaps between hard dabs and flow builds up to the opacity', () => {
    const settings = dabSettings({ spacing: 2 }, { diameter: 10 });
    const stroke = beginStroke({ layer: layer(200, 40), canvas: { width: 200, height: 40 }, settings });
    stroke.addPoints([{ x: 20, y: 20 }, { x: 60, y: 20 }, { x: 100, y: 20 }, { x: 140, y: 20 }, { x: 180, y: 20 }]);
    const result = stroke.finish();
    const alphaAt = (x: number) => result.raster.pixel(x - result.bounds.x, 20 - result.bounds.y)[3] ?? 0;
    for (const x of [20, 40, 60, 80, 100]) expect(alphaAt(x), `dab at ${x}`).toBe(255);
    for (const x of [30, 50, 70, 90]) expect(alphaAt(x), `gap at ${x}`).toBe(0);

    // Many overlapping dabs (0.8 px apart) saturate the stroke at the opacity.
    const flow = dabSettings({ spacing: 0.02, flow: 0.2 }, { diameter: 40, opacity: 0.6 });
    const built = beginStroke({ layer: layer(200, 40), canvas: { width: 200, height: 40 }, settings: flow });
    built.addPoints([{ x: 20, y: 20 }]);
    const single = built.currentRaster().pixel(20, 20)[3]!;
    built.addPoints([{ x: 180, y: 20 }]);
    const done = built.finish();
    expect(single).toBe(Math.round(0.2 * 0.6 * 255));
    expect(done.raster.pixel(100 - done.bounds.x, 20 - done.bounds.y)[3]).toBe(Math.round(0.6 * 255));
  });

  it('paints a sampled tip image: the ring leaves its middle unpainted', () => {
    const settings: BrushSettings = { ...DEFAULT_BRUSH_SETTINGS, diameter: 40, red: 0, green: 0, blue: 1,
      tip: { kind: 'sampled', image: ringTip(160), angle: 0, roundness: 1 }, dynamics: { ...DEFAULT_BRUSH_DYNAMICS, spacing: 0.25 } };
    const stroke = beginStroke({ layer: layer(100, 100), canvas: { width: 100, height: 100 }, settings });
    stroke.addPoints([{ x: 50, y: 50 }]);
    const raster = stroke.currentRaster();
    expect(raster.pixel(50, 50)[3]).toBe(0);
    expect(raster.pixel(50 + 15, 50)[3]).toBe(255);
    expect(raster.pixel(50, 50 - 15)).toEqual([0, 0, 255, 255]);
    expect(raster.pixel(50 + 22, 50)[3]).toBe(0);
    // The 160 px tip is drawn at 40 px from its quarter-size mip level.
    expect(tipLevels(ringTip(160)).map((level) => level.width)).toEqual([160, 80, 40, 20, 10, 5, 3, 2, 1]);
    expect(prepareDab({ x: 0, y: 0, size: 40, angle: 0, alpha: 1 }, settings.tip, 1).level!.width).toBe(40);
  });

  it('draws elliptic procedural tips rotated by the angle', () => {
    const tip = { kind: 'round' as const, angle: 90, roundness: 0.25 };
    const dab = prepareDab({ x: 0, y: 0, size: 40, angle: Math.PI / 2, alpha: 1 }, tip, 1);
    expect(dabCoverage(dab, 0, 18, 1, 1)).toBeCloseTo(1, 9);
    expect(dabCoverage(dab, 18, 0, 1, 1)).toBe(0);
    expect(dabCoverage(dab, 4, 0, 1, 1)).toBeCloseTo(1, 9);
  });

  for (const [label, settings, format, pressure, tilt] of [
    ['scattered sampled tip', { ...DEFAULT_BRUSH_SETTINGS, diameter: 36, red: 0.2, green: 0.7, blue: 0.4, opacity: 0.8,
      tip: { kind: 'sampled', image: ringTip(90), angle: 20, roundness: 0.7 },
      dynamics: { ...DEFAULT_BRUSH_DYNAMICS, spacing: 0.35, scatter: 1.2, count: 2, angleJitter: 0.3, sizeJitter: 0.4, flow: 0.7, opacityJitter: 0.3 } }, 'rgba8'],
    ['soft elliptic erase with pressure', { ...DEFAULT_BRUSH_SETTINGS, diameter: 44, hardness: 0.3, mode: 'erase',
      tip: { kind: 'round', angle: -35, roundness: 0.45 }, dynamics: { ...DEFAULT_BRUSH_DYNAMICS, spacing: 0.15, sizeControl: 'pressure', flow: 0.6 } },
    'rgba8', [1, 0.8, 0.3, 0.9, 0.5, 1]],
    ['16-bit hard dabs with tilt', { ...DEFAULT_BRUSH_SETTINGS, diameter: 30, hardness: 1, red: 0.9, green: 0.1, blue: 0.3,
      dynamics: { ...DEFAULT_BRUSH_DYNAMICS, spacing: 0.5, sizeControl: 'tilt', minimumDiameter: 0.2, scatter: 0.5 } }, 'rgba16', undefined,
    [1, 0.2, 0.6, 0.4, 0.9, 0.7]],
  ] as const) {
    it(`worker partitions commit byte-identically to the synchronous stroke: ${label}`, () => {
      const size = { width: 600, height: 520 };
      const base = solid(size.width, size.height, format === 'rgba16' ? [20_000, 30_000, 40_000, 65535] : [120, 90, 60, 255], format);
      const { sync, partitions } = syncAndPartitions(settings as BrushSettings, base, size, 3,
        pressure as readonly number[] | undefined, tilt as readonly number[] | undefined);
      expect(sync.raster.format).toBe(format);
      expect(sync.raster.width).toBe(size.width);
      let tiles = 0, changed = 0;
      for (let index = 0; index < sync.raster.tiles.length; index++) {
        const col = index % sync.raster.cols, row = Math.floor(index / sync.raster.cols);
        const owner = (col * 31 + row * 17) % 3;
        const expected = sync.raster.tiles[index];
        const actual = partitions[owner]!.raster.tiles[index];
        expect(actual, `tile ${index}`).toEqual(expected);
        tiles++;
        if (expected !== base.tiles[index] && expected && !expected.every((v, i) => v === base.tiles[index]![i])) changed++;
      }
      expect(tiles).toBe(Math.ceil(600 / TILE) * Math.ceil(520 / TILE));
      expect(changed).toBeGreaterThan(2);
    });
  }

  it('a single worker on a blank layer commits the same raster and placement as the synchronous stroke', () => {
    const settings = dabSettings({ spacing: 0.25, scatter: 0.8, flow: 0.5 }, { diameter: 26, hardness: 0.5, tip: { kind: 'round', angle: 10, roundness: 0.6 } });
    const { sync, partitions } = syncAndPartitions(settings, null, { width: 500, height: 400 }, 1);
    const worker = partitions[0]!;
    expect(worker.bounds).toEqual(sync.bounds);
    expect(worker.transform).toEqual(sync.transform);
    expect(worker.raster.readRegion(0, 0, worker.raster.width, worker.raster.height))
      .toEqual(sync.raster.readRegion(0, 0, sync.raster.width, sync.raster.height));
  });
});
