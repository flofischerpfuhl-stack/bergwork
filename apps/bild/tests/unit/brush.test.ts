import { describe, expect, it } from 'vitest';
import { newLayer, type Layer } from '../../src/core/document';
import { apply, invert, makeTransform, pixelToDocument, type Point } from '../../src/core/geometry';
import { Raster } from '../../src/core/raster';
import { EditorSession } from '../../src/core/session';
import {
  DEFAULT_BRUSH_SETTINGS, beginStroke, brushOutlineDiameter, brushOutlineRect, changeBrushHardness,
  changeBrushSize, cloneSamplePoint, currentBrushRaster, extendBrushStroke, falloff, finishBrushStroke,
  getBrushSettings, setBrushSettings, setCloneSettings, setCloneSource, beginBrushStroke, cancelBrushStroke,
} from '../../src/core/brush';
import { recommendedBrushWorkerCount } from '../../src/core/brush/workerClient';

function layer(width: number, height: number, raster: Raster | null = null): Layer {
  return newLayer({ id: 'paint', name: 'Paint', raster,
    transform: makeTransform({ x: 0, y: 0 }, { width, height }) });
}

function settings(fields: Partial<typeof DEFAULT_BRUSH_SETTINGS> = {}) {
  return { ...DEFAULT_BRUSH_SETTINGS, red: 1, green: 0, blue: 0, ...fields };
}

function alpha(raster: Raster, x: number, y: number): number { return raster.pixel(x, y)[3] ?? 0; }
function resultAlpha(result: ReturnType<ReturnType<typeof beginStroke>['finish']>, x: number, y: number): number {
  const local = apply(invert(pixelToDocument(result.transform!, result.raster.width, result.raster.height)), { x, y });
  return alpha(result.raster, Math.floor(local.x), Math.floor(local.y));
}

function trace(points: readonly Point[], step: number, diameter = 120) {
  const stroke = beginStroke({ layer: layer(800, 800), canvas: { width: 800, height: 800 },
    settings: settings({ diameter, hardness: 0 }) });
  stroke.addPoints([points[0]!]);
  for (let p = 1; p < points.length; p++) {
    const a = points[p - 1]!, b = points[p]!;
    const count = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
    const samples: Point[] = [];
    for (let i = 1; i <= count; i++) {
      const t = i / count;
      samples.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
    stroke.addPoints(samples);
  }
  return stroke.finish();
}

describe('brush coverage (BrushStroke.swift, MetalBrushCoverage.swift)', () => {
  it('ports BrushRaster.falloff and produces a feathered click', () => {
    expect(falloff(0)).toBeCloseTo(1);
    expect(falloff(1)).toBeCloseTo(0);
    const stroke = beginStroke({ layer: layer(80, 80), canvas: { width: 80, height: 80 },
      settings: settings({ diameter: 40, hardness: 0 }) });
    stroke.addPoints([{ x: 40, y: 40 }]);
    const live = stroke.currentRaster();
    expect(alpha(live, 40, 40)).toBeGreaterThan(230);
    expect(alpha(live, 50, 40)).toBeGreaterThan(95);
    expect(alpha(live, 50, 40)).toBeLessThan(140);
    expect(alpha(live, 57, 40)).toBeLessThan(40);
    expect(alpha(live, 64, 40)).toBe(0);
  });

  it('BrushIntersectionTests accumulationDependsOnDistanceNotEventCount', () => {
    for (const diameter of [12, 120, 520]) {
      const sparse = trace([{ x: 60, y: 400 }, { x: 740, y: 400 }], 1000, diameter);
      const dense = trace([{ x: 60, y: 400 }, { x: 740, y: 400 }], 5, diameter);
      for (let y = 400; y < Math.min(800, 400 + diameter / 2); y += Math.max(1, Math.floor(diameter / 25))) {
        expect(Math.abs(resultAlpha(sparse, 400, y) - resultAlpha(dense, 400, y)), `diameter ${diameter}, row ${y}`).toBeLessThanOrEqual(3);
      }
    }
  }, 20_000);

  it('BrushIntersectionTests selfCrossingsBlendInsteadOfTakingTheStrongestEdge', () => {
    const vertical = trace([{ x: 400, y: 100 }, { x: 400, y: 700 }], 12);
    const horizontal = trace([{ x: 700, y: 400 }, { x: 100, y: 400 }], 12);
    const crossing = trace([{ x: 400, y: 100 }, { x: 400, y: 700 }, { x: 700, y: 700 },
      { x: 700, y: 400 }, { x: 100, y: 400 }], 12);
    for (const offset of [45, 48, 51]) {
      const a = resultAlpha(vertical, 400 + offset, 400 + offset);
      const b = resultAlpha(horizontal, 400 + offset, 400 + offset);
      const actual = resultAlpha(crossing, 400 + offset, 400 + offset);
      const expected = 255 - (255 - a) * (255 - b) / 255;
      expect(actual).toBeGreaterThan(Math.max(a, b) + 10);
      expect(Math.abs(actual - expected)).toBeLessThanOrEqual(4);
    }
  }, 20_000);

  it('replaces the straight tail with the final curve and keeps published rasters immutable', () => {
    const stroke = beginStroke({ layer: layer(300, 120), canvas: { width: 300, height: 120 },
      settings: settings({ diameter: 8 }) });
    stroke.addPoints([{ x: 20, y: 60 }, { x: 150, y: 20 }]);
    const oldPreview = stroke.currentRaster();
    expect(alpha(oldPreview, 85, 40)).toBeGreaterThan(0);
    stroke.addPoints([{ x: 280, y: 60 }]);
    expect(alpha(oldPreview, 85, 40)).toBeGreaterThan(0);
    expect(alpha(stroke.currentRaster(), 278, 60)).toBeGreaterThan(240);
    const result = stroke.finish();
    expect(resultAlpha(result, 215, 40)).toBe(0);
    expect(resultAlpha(result, 278, 60)).toBeGreaterThan(240);
  });

  it('caps opacity across overlaps, clips to selection, and erases alpha', () => {
    const selection = { mask: Raster.fromPixels(20, 80, 1, new Uint8Array(20 * 80).fill(255)), x: 40, y: 0, antialiased: false };
    const stroke = beginStroke({ layer: layer(100, 80), canvas: { width: 100, height: 80 }, selection,
      settings: settings({ diameter: 20, opacity: 0.5 }) });
    stroke.addPoints([{ x: 10, y: 40 }, { x: 90, y: 40 }, { x: 40, y: 40 }, { x: 90, y: 40 }]);
    const painted = stroke.finish();
    expect(resultAlpha(painted, 50, 40)).toBe(128);
    expect(resultAlpha(painted, 30, 40)).toBe(0);
    const opaque = new Uint8Array(100 * 80 * 4);
    for (let i = 0; i < 100 * 80; i++) opaque.set([10, 20, 30, 255], i * 4);
    const erase = beginStroke({ layer: layer(100, 80, Raster.fromPixels(100, 80, 4, opaque)),
      canvas: { width: 100, height: 80 }, settings: settings({ diameter: 20, opacity: 0.5, mode: 'erase' }) });
    erase.addPoints([{ x: 50, y: 40 }]);
    expect(alpha(erase.finish().raster, 50, 40)).toBe(128);
  });

  it('paints a mask black and preserves white outside the soft tip', () => {
    const target = { ...layer(80, 80), mask: { raster: Raster.solidMask(true), enabled: true, placement: null, linked: true } };
    const stroke = beginStroke({ layer: target, target: 'mask', canvas: { width: 80, height: 80 },
      settings: settings({ diameter: 20, red: 0, green: 0, blue: 0 }) });
    stroke.addPoints([{ x: 40, y: 40 }]);
    const result = stroke.finish().raster;
    expect(result.channels).toBe(1);
    expect(result.pixel(40, 40)[0]).toBe(0);
    expect(result.pixel(2, 2)[0]).toBe(255);
  });

  it('keeps a document-space round tip round on a nonuniform rotated flipped layer', () => {
    const transformed = newLayer({ id: 't', name: 'T', raster: Raster.blank(100, 100, 4),
      transform: makeTransform({ x: 25, y: -50 }, { width: 50, height: 200 }, { rotation: 90, flipX: true, flipY: true }) });
    const stroke = beginStroke({ layer: transformed, canvas: { width: 100, height: 100 }, settings: settings({ diameter: 16 }) });
    stroke.addPoints([{ x: 50, y: 50 }]);
    const result = stroke.finish();
    expect(result.transform?.rotation).toBe(90);
    expect(result.transform?.flipX).toBe(true);
    for (const [x, y] of [[50, 50], [54, 50], [50, 54]]) expect(resultAlpha(result, x!, y!)).toBeGreaterThan(240);
    for (const [x, y] of [[61, 50], [50, 61]]) expect(resultAlpha(result, x!, y!)).toBe(0);
  });

  it('RasterSnapshotTests shares untouched tiles and allocates a blank layer lazily', () => {
    const data = new Uint8Array(600 * 80 * 4).fill(255);
    const source = Raster.fromPixels(600, 80, 4, data);
    const stroke = beginStroke({ layer: layer(600, 80, source), canvas: { width: 600, height: 80 },
      settings: settings({ diameter: 20 }) });
    stroke.addPoints([{ x: 20, y: 40 }]);
    const live = stroke.currentRaster();
    expect(live.tiles[0]).not.toBe(source.tiles[0]);
    expect(live.tiles[1]).toBe(source.tiles[1]);
    const blank = beginStroke({ layer: layer(10_000, 10_000), canvas: { width: 10_000, height: 10_000 },
      settings: settings({ diameter: 20 }) });
    expect(blank.currentRaster().byteSize).toBe(0);
    blank.addPoints([{ x: 100, y: 100 }]);
    expect(blank.currentRaster().byteSize).toBeLessThanOrEqual(256 * 256 * 4);
  });
});

describe('brush session commands (EditorSession+Brush.swift, CloneStamp.swift)', () => {
  function session(): EditorSession {
    const value = new EditorSession();
    value.createNewProject(100, 80);
    value.tool = 'brush';
    return value;
  }

  it('commits as one undo step and Escape-style cancel restores exactly', () => {
    const value = session();
    setBrushSettings(value, settings({ diameter: 20 }));
    const count = value.history.undoCount;
    expect(beginBrushStroke(value, { x: 10, y: 40 })).not.toBeNull();
    extendBrushStroke(value, { x: 90, y: 40 });
    expect(value.activeLayer?.raster).toBeNull();
    finishBrushStroke(value);
    expect(value.history.undoCount).toBe(count + 1);
    expect(value.history.undoName).toBe('Brush Stroke');
    expect(value.activeLayer?.raster).not.toBeNull();
    expect(value.undo()).toBe(true);
    expect(value.activeLayer?.raster).toBeNull();
    const before = value.document;
    beginBrushStroke(value, { x: 50, y: 40 });
    expect(currentBrushRaster(value)).not.toBeNull();
    expect(cancelBrushStroke(value)).toBe(true);
    expect(value.document).toBe(before);
  });

  it('uses the last target point for Shift-click and steps size/hardness faithfully', () => {
    const value = session();
    setBrushSettings(value, settings({ diameter: 20, hardness: 0.8 }));
    expect(changeBrushHardness(value, true).hardness).toBe(1);
    setBrushSettings(value, { ...getBrushSettings(value), hardness: 0.8 });
    expect(changeBrushHardness(value, false).hardness).toBe(0.75);
    expect(changeBrushSize(value, true).diameter).toBe(24);
    beginBrushStroke(value, { x: 10, y: 40 });
    finishBrushStroke(value);
    beginBrushStroke(value, { x: 90, y: 40 }, { shift: true });
    const live = currentBrushRaster(value)!;
    expect(alpha(live, Math.floor(live.width / 2), Math.floor(live.height / 2))).toBeGreaterThan(0);
    finishBrushStroke(value);
  });

  it('CloneStampTests copies source pixels and keeps aligned offset', () => {
    const value = new EditorSession();
    value.createDocument(80, 40);
    const pixels = new Uint8Array(80 * 40 * 4);
    for (let y = 0; y < 40; y++) for (let x = 0; x < 80; x++) {
      const color = x >= 10 && x < 20 && y >= 15 && y < 25 ? [0, 255, 0, 255]
        : x < 40 ? [255, 0, 0, 255] : [0, 0, 255, 255];
      pixels.set(color, (y * 80 + x) * 4);
    }
    value.insertRaster(Raster.fromPixels(80, 40, 4, pixels), 'Colors');
    value.tool = 'cloneStamp';
    setBrushSettings(value, settings({ diameter: 6 }));
    expect(beginBrushStroke(value, { x: 60, y: 20 })).toBeNull();
    setCloneSource(value, { x: 15, y: 20 });
    beginBrushStroke(value, { x: 60, y: 20 });
    extendBrushStroke(value, { x: 60.5, y: 20 });
    finishBrushStroke(value);
    expect(value.activeLayer!.raster!.pixel(60, 20)).toEqual([0, 255, 0, 255]);
    beginBrushStroke(value, { x: 66, y: 20 });
    finishBrushStroke(value);
    expect(value.activeLayer!.raster!.pixel(66, 20)).toEqual([255, 0, 0, 255]);
    setCloneSettings(value, { aligned: false, sampleAllLayers: false });
    expect(cloneSamplePoint(value, { x: 50, y: 10 })).toEqual({ x: 15, y: 20 });
  });
});

describe('brush cursor geometry (BrushCursorOverlay.swift)', () => {
  it('uses document zoom with a one-view-point minimum', () => {
    expect(brushOutlineDiameter(40, 0.01)).toBe(1);
    expect(brushOutlineDiameter(40, 2)).toBe(80);
    expect(brushOutlineRect({ x: 20, y: 30 }, 10, 2)).toEqual({ x: 10, y: 20, width: 20, height: 20 });
  });
});

describe('brush performance (BrushPerformanceTests.swift)', () => {
  it('caps tile workers at the reference machine physical-core count', () => {
    expect([1, 2, 4, 8, 16].map(recommendedBrushWorkerCount)).toEqual([1, 2, 4, 4, 4]);
  });

  it('measures a 300 px soft brush on a 4096² blank layer', () => {
    const stroke = beginStroke({ layer: layer(4096, 4096), canvas: { width: 4096, height: 4096 },
      settings: settings({ diameter: 300, hardness: 0 }) });
    stroke.addPoints([{ x: 600, y: 2048 }]);
    const times: number[] = [];
    for (let i = 1; i <= 20; i++) {
      const start = performance.now();
      stroke.addPoints([{ x: 600 + i * 40, y: 2048 }]);
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    const finishStart = performance.now();
    const result = stroke.finish();
    const finish = performance.now() - finishStart;
    expect(resultAlpha(result, 1000, 2048)).toBeGreaterThan(250);
    console.info(`BRUSH BENCH 300px/4096² move median=${times[10]!.toFixed(2)}ms p95=${times[19]!.toFixed(2)}ms finish=${finish.toFixed(2)}ms`);
  }, 20_000);
});
