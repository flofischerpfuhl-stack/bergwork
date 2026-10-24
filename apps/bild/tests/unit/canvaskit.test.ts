import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadSharedTextEngine, type TextEngine } from '../../src/text';

const wasmPath = path.resolve('node_modules/canvaskit-wasm/bin/canvaskit.wasm');
const fontPath = path.resolve('public/fonts/NotoSans-Variable.ttf');

describe('PRODUCT-PLAN A5 CanvasKit CPU engine', () => {
  let engine: TextEngine;

  beforeAll(async () => {
    engine = await loadSharedTextEngine({ wasmUrl: wasmPath });
    engine.registerFont({ id: 'noto-variable', family: 'Noto Sans', bytes: fs.readFileSync(fontPath), source: fontPath });
  });

  afterAll(() => engine.dispose());

  it('shares one lazy CanvasKit engine between editor consumers', async () => {
    expect(await loadSharedTextEngine({ wasmUrl: wasmPath })).toBe(engine);
    expect(engine.memoryUsage().wasmHeapBytes).toBe(128 * 1024 * 1024);
  });

  it('shapes kerning, ligatures and German text into real tiled pixels', () => {
    const layout = engine.layoutParagraph({
      text: 'AVATAR office affine Übergrößenträger', width: 700, fontFamilies: ['Noto Sans'], fontSize: 31,
      fontFeatures: [{ name: 'kern', value: 1 }, { name: 'liga', value: 1 }],
      fontVariations: [{ axis: 'wght', value: 625 }, { axis: 'wdth', value: 85 }],
    });
    try {
      expect(layout.unresolvedCodepoints).toEqual([]);
      expect(layout.lineCount).toBe(1);
      expect(layout.longestLine).toBeGreaterThan(500);
      const output = engine.rasterizeParagraph(layout, 3);
      expect(output.raster.channels).toBe(4);
      expect(output.raster.cols).toBe(3);
      expect(output.raster.byteSize).toBeGreaterThan(10_000);
      let covered = 0;
      for (let x = 0; x < output.raster.width; x++) {
        for (let y = 0; y < output.raster.height; y++) if (output.raster.pixel(x, y)[3]! > 0) covered++;
      }
      expect(covered).toBeGreaterThan(2_000);
    } finally {
      layout.dispose();
    }
  });

  it('performs PathOps and rasterizes gradients and dashed strokes', () => {
    const first = 'M10 10H70V70H10Z';
    const second = 'M40 10H100V70H40Z';
    const union = engine.combinePaths(first, second, 'union');
    const difference = engine.combinePaths(first, second, 'difference');
    const unionRaster = engine.rasterizePath({ width: 110, height: 80, svgPath: union,
      fill: { kind: 'linear-gradient', start: [10, 0], end: [100, 0],
        colors: [{ red: 255, green: 0, blue: 0 }, { red: 0, green: 0, blue: 255 }] } }).raster;
    const differenceRaster = engine.rasterizePath({ width: 110, height: 80, svgPath: difference,
      fill: { kind: 'solid', color: { red: 20, green: 200, blue: 40 } } }).raster;
    expect(unionRaster.pixel(20, 30)[3]).toBe(255);
    expect(unionRaster.pixel(90, 30)[3]).toBe(255);
    expect(unionRaster.pixel(20, 30)[0]!).toBeGreaterThan(unionRaster.pixel(90, 30)[0]!);
    expect(differenceRaster.pixel(20, 30)).toEqual([20, 200, 40, 255]);
    expect(differenceRaster.pixel(50, 30)).toEqual([0, 0, 0, 0]);

    const dashed = engine.rasterizePath({ width: 110, height: 80, svgPath: 'M10 60L50 10L100 60',
      stroke: { color: { red: 12, green: 34, blue: 56 }, width: 8, dash: [12, 6], join: 'round', cap: 'round' } }).raster;
    expect(dashed.pixel(10, 60)[3]).toBeGreaterThan(0);
    expect(dashed.byteSize).toBeGreaterThan(1_000);
  });

  it('reports WASM and registered-font memory and rejects disposed layouts', () => {
    const memory = engine.memoryUsage();
    expect(memory.registeredFontCount).toBe(1);
    expect(memory.registeredFontBytes).toBe(fs.statSync(fontPath).size);
    expect(memory.wasmHeapBytes).toBeGreaterThan(16 * 1024 * 1024);
    const layout = engine.layoutParagraph({ text: 'memory', width: 200, fontFamilies: ['Noto Sans'], fontSize: 20 });
    layout.dispose();
    expect(() => engine.rasterizeParagraph(layout)).toThrow('disposed');
  });
});
