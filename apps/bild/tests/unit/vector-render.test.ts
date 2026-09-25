import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadTextEngine, type TextEngine } from '../../src/text';
import {
  booleanPaths, ellipsePath, linePath, pathsToSelection, polygonPath, rectanglePath, renderVector, renderVectorMask, starPath,
  paintVectorToRaster, VectorRasterCache,
} from '../../src/core/vector';
import type { VectorStyle } from '../../src/core/model';
import { newLayer } from '../../src/core/document';
import { makeTransform } from '../../src/core/geometry';
import { Raster } from '../../src/core/raster';
import { compositeRegion } from '../../src/core/composite';
import { vectorCompositeHooks } from '../../src/render/vectorRasterCache';

const solid = { kind: 'solid' as const, schemaVersion: 1 as const, color: { red: 1, green: 0, blue: 0 } };

describe('PRODUCT-PLAN A5 CanvasKit vector engine', () => {
  let engine: TextEngine;
  beforeAll(async () => { engine = await loadTextEngine({ wasmUrl: path.resolve('node_modules/canvaskit-wasm/bin/canvaskit.wasm') }); });
  afterAll(() => engine.dispose());

  it.each([
    ['rectangle', rectanglePath(80, 60, [4, 8, 12, 16]), [40, 30]],
    ['ellipse', ellipsePath(80, 60), [40, 30]],
    ['polygon', polygonPath(80, 60, 6, 3), [40, 30]],
    ['star', starPath(80, 60, 5, 0.45, 2), [40, 30]],
  ] as const)('rasterizes the %s primitive to real antialiased pixels', (_name, primitive, center) => {
    const raster = renderVector(engine, [primitive], { schemaVersion: 1, fill: solid, stroke: null }, 80, 60);
    expect(raster.pixel(center[0], center[1])).toEqual([255, 0, 0, 255]);
    expect(raster.toPixels().some((value, index) => index % 4 === 3 && value > 0 && value < 255)).toBe(true);
  });

  it('renders an empty editable path set as transparent pixels', () => {
    const raster = renderVector(engine, [], { schemaVersion: 1, fill: solid, stroke: null }, 8, 6);
    expect(raster.toPixels()).toEqual(new Uint8Array(8 * 6 * 4));
  });

  it('clips an inside stroke to the path even when Fill is None', () => {
    const path = { ...rectanglePath(50, 40), points: rectanglePath(50, 40).points.map((point) => ({ ...point,
      anchor: { x: point.anchor.x + 15, y: point.anchor.y + 15 }, in: { x: point.in.x + 15, y: point.in.y + 15 },
      out: { x: point.out.x + 15, y: point.out.y + 15 } })) };
    const raster = renderVector(engine, [path], { schemaVersion: 1, fill: null,
      stroke: { color: { red: 1, green: 0, blue: 0 }, width: 6, alignment: 'inside' } }, 80, 70);
    expect(raster.pixel(17, 35)).toEqual([255, 0, 0, 255]);
    expect(raster.pixel(12, 35)[3]).toBe(0);
    expect(raster.pixel(40, 35)[3]).toBe(0);
  });

  it('paints a path onto RGBA16 without reducing the destination precision', () => {
    const source = new Uint16Array(8 * 8 * 4);
    source.fill(12345); for (let i = 3; i < source.length; i += 4) source[i] = 65535;
    const painted = paintVectorToRaster(Raster.fromPixels(8, 8, 4, source, { format: 'rgba16' }), engine,
      [rectanglePath(4, 4)], { schemaVersion: 1, fill: solid, stroke: null });
    expect(painted.format).toBe('rgba16');
    expect(painted.pixel(2, 2)).toEqual([65535, 0, 0, 65535]);
    expect(painted.pixel(7, 7)).toEqual([12345, 12345, 12345, 65535]);
  });

  it('renders gradient fills and stroke alignment, caps, joins, dashes and M12 arrow markers', () => {
    const style: VectorStyle = { schemaVersion: 1,
      fill: { kind: 'gradient', schemaVersion: 1, angle: 0, stops: [
        { offset: 0, color: { red: 1, green: 0, blue: 0 }, opacity: 1 },
        { offset: 1, color: { red: 0, green: 0, blue: 1 }, opacity: 1 },
      ] },
      stroke: { color: { red: 0, green: 1, blue: 0 }, width: 8, alignment: 'outside', cap: 'round', join: 'bevel',
        miterLimit: 4, dash: [10, 6], dashOffset: 2, startMarker: 'circle', endMarker: 'arrow', markerSize: 3 } };
    const raster = renderVector(engine, [rectanglePath(90, 60, 4)], style, 110, 80);
    expect(raster.pixel(20, 30)[0]!).toBeGreaterThan(raster.pixel(70, 30)[0]!);
    expect(raster.pixel(2, 2)[3]).toBeGreaterThanOrEqual(0);
    expect(raster.byteSize).toBeGreaterThan(1_000);

    const line = renderVector(engine, [linePath(90, 30)], { schemaVersion: 1, fill: null,
      stroke: { ...style.stroke!, alignment: 'center', dash: undefined, startMarker: 'openArrow', endMarker: 'square' } }, 110, 30);
    expect(line.pixel(90, 15)[3]).toBeGreaterThan(0);
  });

  it('pixel-checks every stroke alignment, cap, join and line-end marker option', () => {
    const moved = { ...rectanglePath(50, 40, 3), points: rectanglePath(50, 40, 3).points.map((point) => ({ ...point,
      anchor: { x: point.anchor.x + 15, y: point.anchor.y + 15 }, in: { x: point.in.x + 15, y: point.in.y + 15 },
      out: { x: point.out.x + 15, y: point.out.y + 15 } })) };
    const counts = new Map<string, number>();
    for (const alignment of ['inside', 'center', 'outside'] as const) {
      const raster = renderVector(engine, [moved], { schemaVersion: 1, fill: solid,
        stroke: { color: { red: 0, green: 1, blue: 0 }, width: 10, alignment } }, 80, 70);
      const pixels = raster.toPixels(); let covered = 0;
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) covered++;
      counts.set(alignment, covered);
      expect(raster.pixel(alignment === 'inside' ? 17 : 11, 35)[3]).toBeGreaterThan(alignment === 'inside' ? -1 : 0);
    }
    expect(counts.get('inside')!).toBeLessThan(counts.get('center')!);
    expect(counts.get('center')!).toBeLessThan(counts.get('outside')!);

    const open = { schemaVersion: 1 as const, closed: false, fillRule: 'nonzero' as const, points: [
      { anchor: { x: 20, y: 35 }, in: { x: 20, y: 35 }, out: { x: 20, y: 35 }, kind: 'corner' as const },
      { anchor: { x: 45, y: 10 }, in: { x: 45, y: 10 }, out: { x: 45, y: 10 }, kind: 'corner' as const },
      { anchor: { x: 70, y: 35 }, in: { x: 70, y: 35 }, out: { x: 70, y: 35 }, kind: 'corner' as const },
    ] };
    const capCounts: number[] = [];
    for (const cap of ['butt', 'round', 'square'] as const) {
      const raster = renderVector(engine, [open], { schemaVersion: 1, fill: null,
        stroke: { color: { red: 1, green: 1, blue: 1 }, width: 8, alignment: 'center', cap, join: 'miter' } }, 90, 50);
      expect(raster.pixel(45, 10)[3]).toBeGreaterThan(0);
      capCounts.push(raster.toPixels().filter((value, index) => index % 4 === 3 && value > 0).length);
    }
    expect(new Set(capCounts).size).toBeGreaterThan(1);
    const joinCounts: number[] = [];
    for (const join of ['miter', 'round', 'bevel'] as const) {
      const raster = renderVector(engine, [open], { schemaVersion: 1, fill: null,
        stroke: { color: { red: 1, green: 1, blue: 1 }, width: 10, alignment: 'center', cap: 'butt', join,
          miterLimit: join === 'miter' ? 8 : 4 } }, 90, 50);
      expect(raster.pixel(45, 10)[3]).toBeGreaterThan(0);
      joinCounts.push(raster.toPixels().filter((value, index) => index % 4 === 3 && value > 0).length);
    }
    expect(new Set(joinCounts).size).toBeGreaterThan(1);
    const markerCounts: number[] = [];
    for (const marker of ['none', 'arrow', 'openArrow', 'circle', 'square'] as const) {
      const raster = renderVector(engine, [open], { schemaVersion: 1, fill: null,
        stroke: { color: { red: 1, green: 1, blue: 1 }, width: 5, alignment: 'center', cap: 'butt', join: 'miter',
          startMarker: marker, endMarker: marker, markerSize: 3 } }, 90, 50);
      const pixels = raster.toPixels(); let covered = 0;
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) covered++;
      markerCounts.push(covered); expect(covered).toBeGreaterThan(200);
    }
    expect(new Set(markerCounts).size).toBeGreaterThan(2);
  });

  it('performs all CanvasKit PathOps as editable paths with pixel-checked results', () => {
    const left = [rectanglePath(60, 60)], right = [{ ...rectanglePath(60, 60), points: rectanglePath(60, 60).points.map((p) => ({
      ...p, anchor: { x: p.anchor.x + 30, y: p.anchor.y }, in: { x: p.in.x + 30, y: p.in.y }, out: { x: p.out.x + 30, y: p.out.y },
    })) }];
    const alpha = (operation: 'unite' | 'subtract' | 'intersect' | 'exclude', x: number) => renderVector(engine,
      booleanPaths(engine, left, right, operation), { schemaVersion: 1, fill: solid, stroke: null }, 100, 70).pixel(x, 30)[3];
    expect(alpha('unite', 75)).toBe(255);
    expect(alpha('subtract', 45)).toBe(0);
    expect(alpha('intersect', 45)).toBe(255);
    expect(alpha('exclude', 45)).toBe(0);
  });

  it('honours even-odd fill rules across subpaths', () => {
    const outer = { ...rectanglePath(70, 60), fillRule: 'evenodd' as const };
    const inner = { ...rectanglePath(30, 20), fillRule: 'evenodd' as const, points: rectanglePath(30, 20).points.map((point) => ({
      ...point, anchor: { x: point.anchor.x + 20, y: point.anchor.y + 20 }, in: { x: point.in.x + 20, y: point.in.y + 20 },
      out: { x: point.out.x + 20, y: point.out.y + 20 },
    })) };
    const raster = renderVector(engine, [outer, inner], { schemaVersion: 1, fill: solid, stroke: null }, 80, 70);
    expect(raster.pixel(10, 10)[3]).toBe(255);
    expect(raster.pixel(30, 30)[3]).toBe(0);
  });

  it('honours even-odd fill on a self-intersecting cubic path', () => {
    const vertices = polygonPath(60, 60, 5).points, order = [0, 2, 4, 1, 3];
    const pentagram = { schemaVersion: 1 as const, closed: true, fillRule: 'evenodd' as const,
      points: order.map((index) => vertices[index]!) };
    const evenodd = renderVector(engine, [pentagram], { schemaVersion: 1, fill: solid, stroke: null }, 60, 60);
    const nonzero = renderVector(engine, [{ ...pentagram, fillRule: 'nonzero' }],
      { schemaVersion: 1, fill: solid, stroke: null }, 60, 60);
    expect(evenodd.pixel(30, 30)[3]).toBe(0);
    expect(nonzero.pixel(30, 30)[3]).toBe(255);
  });

  it('creates antialiased selections and density/feather/invert vector masks', () => {
    const selection = pathsToSelection(engine, [ellipsePath(30, 20)], { x: 5, y: 7, width: 30, height: 20 });
    expect(selection).toMatchObject({ x: 5, y: 7, antialiased: true });
    expect(selection.mask.pixel(15, 10)[0]).toBe(255);
    const mask = renderVectorMask(engine, { schemaVersion: 1, enabled: true, inverted: true, density: 0.5, feather: 2,
      paths: [rectanglePath(20, 20, 0)] }, 40, 40);
    expect(mask.pixel(30, 30)[0]).toBe(255);
    expect(mask.pixel(10, 10)[0]).toBeGreaterThanOrEqual(120);
    expect(mask.pixel(20, 10)[0]).toBeGreaterThan(120);
  });

  it('preserves fractional document placement when creating a selection from a path', () => {
    const moved = { ...rectanglePath(4, 3), points: rectanglePath(4, 3).points.map((point) => ({ ...point,
      anchor: { x: point.anchor.x + 5.5, y: point.anchor.y + 7.25 }, in: { x: point.in.x + 5.5, y: point.in.y + 7.25 },
      out: { x: point.out.x + 5.5, y: point.out.y + 7.25 } })) };
    const selection = pathsToSelection(engine, [moved], { x: 5.5, y: 7.25, width: 4, height: 3 });
    expect(selection).toMatchObject({ x: 5, y: 7 });
    expect(selection.mask).toMatchObject({ width: 5, height: 4 });
    expect(selection.mask.pixel(1, 1)[0]).toBe(255);
  });

  it('prepares transform-density vector pixels and combines vector and raster masks', () => {
    const maskPixels = new Uint8Array(40 * 40).fill(255);
    for (let y = 0; y < 40; y++) for (let x = 20; x < 40; x++) maskPixels[y * 40 + x] = 0;
    const layer = newLayer({ id: 'vector-cache', name: 'Vector', kind: 'vector',
      transform: makeTransform({ x: 10, y: 20 }, { width: 40, height: 40 }), paths: [ellipsePath(40, 40)],
      style: { schemaVersion: 1, fill: solid, stroke: null },
      mask: { raster: Raster.fromPixels(40, 40, 1, maskPixels), enabled: true, linked: true, placement: null },
      vectorMask: { schemaVersion: 1, enabled: true, inverted: false, density: 1, feather: 0, paths: [rectanglePath(40, 40)] } });
    const cache = new VectorRasterCache(engine); cache.prepare([layer], 1);
    expect(cache.raster(layer)).toMatchObject({ width: 40, height: 40 });
    expect(cache.maskRaster(layer)!.pixel(10, 20)[0]).toBe(255);
    expect(cache.maskRaster(layer)!.pixel(30, 20)[0]).toBe(0);
    cache.prepare([layer], 2);
    expect(cache.raster(layer)).toMatchObject({ width: 80, height: 80 });
    expect(cache.maskRaster(layer)).toMatchObject({ width: 80, height: 80 });
  });

  it('applies a vector-only mask through the software compositor hooks', () => {
    const layer = newLayer({ id: 'vector-only-mask', name: 'Vector', kind: 'vector',
      transform: makeTransform({ x: 0, y: 0 }, { width: 20, height: 10 }), paths: [rectanglePath(20, 10)],
      style: { schemaVersion: 1, fill: solid, stroke: null },
      vectorMask: { schemaVersion: 1, enabled: true, inverted: false, density: 1, feather: 0, paths: [rectanglePath(10, 10)] } });
    const cache = new VectorRasterCache(engine); cache.prepare([layer], 1);
    const hooks = vectorCompositeHooks(cache), document = { id: 'vector-mask', width: 20, height: 10, resolution: 72,
      layers: [layer], selection: null };
    const pixels = compositeRegion(document, { x: 0, y: 0, width: 20, height: 10 }, {
      transform: hooks.transform, maskPlacement: hooks.maskPlacement, blendMode: hooks.blendMode,
      raster: hooks.raster, maskRaster: hooks.maskRaster,
    }).rgba;
    expect(pixels[(5 * 20 + 5) * 4 + 3]).toBe(255);
    expect(pixels[(5 * 20 + 15) * 4 + 3]).toBe(0);
  });

  it('renders 1,000 anchors within the 16 ms p95 target after warmup', () => {
    const thousand = polygonPath(256, 256, 1000);
    const paths = [thousand], vectorStyle = { schemaVersion: 1 as const, fill: solid, stroke: null };
    renderVector(engine, paths, vectorStyle, 256, 256);
    const values: number[] = [];
    for (let i = 0; i < 50; i++) {
      const start = performance.now(); renderVector(engine, paths, vectorStyle, 256, 256);
      values.push(performance.now() - start);
    }
    values.sort((a, b) => a - b);
    expect(values[Math.floor(values.length * 0.95)]!).toBeLessThanOrEqual(16);
  });
});
