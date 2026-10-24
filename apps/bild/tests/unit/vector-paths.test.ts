import { describe, expect, it } from 'vitest';
import { hitTestPaths, hitTestVectorLayer, pathToSvg, polygonPath, rectanglePath, selectionToPaths, starPath, svgToPaths,
  vectorBounds } from '../../src/core/vector';
import { Raster } from '../../src/core/raster';
import { newLayer } from '../../src/core/document';
import { makeTransform } from '../../src/core/geometry';

describe('PRODUCT-PLAN A5 vector geometry', () => {
  it('keeps cubic handles and multiple subpaths editable through SVG', () => {
    const source = [rectanglePath(40, 20, [2, 4, 6, 8]), starPath(30, 30, 5, 0.42, 0)];
    const parsed = svgToPaths(source.map((value) => pathToSvg(value)).join(' '));
    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.closed).toBe(true);
    expect(parsed[0]!.points[0]!.anchor).toEqual(source[0]!.points[0]!.anchor);
    expect(parsed[0]!.points.some((point) => point.out.x !== point.anchor.x || point.out.y !== point.anchor.y)).toBe(true);
    expect(vectorBounds(parsed)).toMatchObject({ x: 0, y: 0, width: 40 });
    expect(vectorBounds(parsed)!.height).toBeGreaterThan(27);
  });

  it('constructs bounded polygons and stars with validated point counts', () => {
    expect(polygonPath(100, 80, 6).points).toHaveLength(6);
    expect(starPath(100, 80, 5, 0.5).points).toHaveLength(10);
    expect(polygonPath(100, 80, 2).points).toHaveLength(3);
  });

  it('hit-tests anchors, handles and cubic segments in document tolerance', () => {
    const path = rectanglePath(40, 20, 5);
    expect(hitTestPaths([path], path.points[0]!.anchor, 0.1)).toMatchObject({ kind: 'anchor', pathIndex: 0, pointIndex: 0 });
    expect(hitTestPaths([path], { x: 20, y: 0 }, 0.5)).toMatchObject({ kind: 'segment', pathIndex: 0 });
    expect(hitTestPaths([path], { x: 100, y: 100 }, 2)).toBeNull();
    const layer = newLayer({ id: 'hit', name: 'Hit', kind: 'vector', paths: [path],
      style: { fill: null, stroke: null }, transform: makeTransform({ x: 10, y: 25 }, { width: 40, height: 20 }) });
    expect(hitTestVectorLayer(layer, { x: 15, y: 25 }, 0.1)).toMatchObject({ kind: 'anchor', point: { x: 15, y: 25 } });
  });

  it('traces selection coverage into simplified editable outlines', () => {
    const pixels = new Uint8Array(8 * 8);
    for (let y = 2; y < 6; y++) for (let x = 1; x < 7; x++) pixels[y * 8 + x] = 255;
    const paths = selectionToPaths({ mask: Raster.fromPixels(8, 8, 1, pixels), x: 10, y: 20, antialiased: true }, 0.25);
    expect(paths).toHaveLength(1);
    expect(paths[0]!.closed).toBe(true);
    expect(vectorBounds(paths)).toEqual({ x: 11, y: 22, width: 6, height: 4 });
  });
});
