import { describe, expect, it } from 'vitest';
import { makeTransform } from '../../src/core/geometry';
import { Raster } from '../../src/core/raster';
import { EditorSession } from '../../src/core/session';
import { BlurStroke, WarpStroke, beginRetouch, cancelRetouch, commitRetouch, currentRetouch, updateRetouch } from '../../src/core/retouch';

function splitRaster(width: number, height: number): Raster {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    pixels[i + (x < width / 2 ? 0 : 2)] = 255;
    pixels[i + 3] = 255;
  }
  return Raster.fromPixels(width, height, 4, pixels);
}

describe('retouch (SmudgeLiquify.swift, BlurTool.swift)', () => {
  it('measures 200 px warp moves on a tiled 4096² layer', () => {
    const size = 4096, band = new Uint8Array(768 * 384 * 4);
    for (let y = 0; y < 384; y++) for (let x = 0; x < 768; x++) {
      const i = (y * 768 + x) * 4;
      band[i] = x & 255; band[i + 1] = y & 255; band[i + 2] = (x + y) & 255; band[i + 3] = 255;
    }
    const base = Raster.blank(size, size, 4).withRegion(1600, 1800, 768, 384, band);
    const transform = makeTransform({ x: 0, y: 0 }, { width: size, height: size });
    for (const mode of ['smudge', 'liquify'] as const) {
      const stroke = new WarpStroke(base, transform, mode, { diameter: 200, hardness: 0.5, strength: 0.7 });
      stroke.addPoints([{ x: 1800, y: 2000 }]);
      const times: number[] = [];
      for (let move = 1; move <= 12; move++) {
        const before = performance.now();
        stroke.addPoints([{ x: 1800 + move * 16, y: 2000 + (move % 2) * 4 }]);
        if (move > 1) times.push(performance.now() - before);
      }
      times.sort((a, b) => a - b);
      const mean = times.reduce((sum, value) => sum + value, 0) / times.length;
      console.info(`RET0UCH_BENCH ${mode} mean=${mean.toFixed(2)}ms median=${times[Math.floor(times.length / 2)]!.toFixed(2)}ms p95=${times[Math.floor(times.length * 0.95)]!.toFixed(2)}ms n=${times.length}`);
      expect(stroke.currentRaster().pixel(1900, 2000)).not.toEqual(base.pixel(1900, 2000));
    }
  });

  it('WarpStroke smudge carries the picked-up colour along the stroke', () => {
    const raster = splitRaster(40, 20);
    const stroke = new WarpStroke(raster, makeTransform({ x: 0, y: 0 }, { width: 40, height: 20 }), 'smudge',
      { diameter: 10, hardness: 0.5, strength: 1 });
    expect(stroke.addPoints([{ x: 10, y: 10 }])).toEqual([]); // first point only picks up, like WarpStroke.append
    const dirty = stroke.addPoints([{ x: 30, y: 10 }]);
    expect(dirty).toHaveLength(1);
    const result = stroke.finish();
    expect(result.pixel(27, 10)[0]).toBeGreaterThan(result.pixel(27, 10)[2]!);
    expect(raster.pixel(27, 10)).toEqual([0, 0, 255, 255]);
  });

  it('WarpStroke liquify pushes pixels in the drag direction and cancel restores the original', () => {
    const pixels = new Uint8Array(31 * 15 * 4);
    for (let y = 4; y <= 10; y++) for (let x = 7; x <= 9; x++) pixels.set([255, 255, 255, 255], (y * 31 + x) * 4);
    const raster = Raster.fromPixels(31, 15, 4, pixels);
    const stroke = new WarpStroke(raster, makeTransform({ x: 0, y: 0 }, { width: 31, height: 15 }), 'liquify',
      { diameter: 14, hardness: 0.8, strength: 1 });
    stroke.addPoints([{ x: 8, y: 7 }, { x: 16, y: 7 }]);
    const result = stroke.currentRaster();
    let weightedX = 0, alpha = 0;
    for (let y = 0; y < 15; y++) for (let x = 0; x < 31; x++) {
      const value = result.pixel(x, y)[3]!; weightedX += x * value; alpha += value;
    }
    expect(weightedX / alpha).toBeGreaterThan(8);
    expect(stroke.cancel()).toBe(raster);
  });

  it('BlurStroke uses diameter/10 sigma and paints the fixed Gaussian sample through its tip', () => {
    const pixels = new Uint8Array(25 * 25 * 4);
    pixels.set([255, 255, 255, 255], (12 * 25 + 12) * 4);
    const raster = Raster.fromPixels(25, 25, 4, pixels);
    const stroke = new BlurStroke(raster, makeTransform({ x: 0, y: 0 }, { width: 25, height: 25 }),
      { diameter: 20, hardness: 1, strength: 1 });
    expect(stroke.sigma).toBe(2);
    stroke.addPoints([{ x: 12.5, y: 12.5 }]);
    const result = stroke.finish();
    expect(result.pixel(12, 12)[3]).toBeLessThan(255);
    expect(result.pixel(11, 12)[3]).toBeGreaterThan(0);
    expect(result.pixel(0, 0)[3]).toBe(0);
  });

  it('BlurTool mask sampling keeps the majority edge tone beyond mask pixels', () => {
    const mask = Raster.fromPixels(9, 9, 1, new Uint8Array(81).fill(255));
    const stroke = new BlurStroke(mask, makeTransform({ x: 0, y: 0 }, { width: 9, height: 9 }),
      { diameter: 8, hardness: 1, strength: 1 });
    stroke.addPoints([{ x: 0, y: 0 }]);
    expect(stroke.finish().pixel(0, 0)[0]).toBe(255);
  });

  it('clips retouch pixels by DocumentSelection coverage', () => {
    const raster = splitRaster(30, 10);
    const selection = { mask: Raster.fromPixels(5, 10, 1, new Uint8Array(50).fill(255)), x: 20, y: 0, antialiased: false };
    const stroke = new WarpStroke(raster, makeTransform({ x: 0, y: 0 }, { width: 30, height: 10 }), 'smudge',
      { diameter: 8, hardness: 0.5, strength: 1 }, selection);
    stroke.addPoints([{ x: 10, y: 5 }, { x: 25, y: 5 }]);
    const result = stroke.finish();
    expect(result.pixel(18, 5)).toEqual(raster.pixel(18, 5));
    expect(result.pixel(22, 5)).not.toEqual(raster.pixel(22, 5));
  });

  it('session wrappers commit one named undo step and cancellation leaves pixels untouched', () => {
    const session = new EditorSession();
    session.createNewProject(40, 20);
    const id = session.insertRaster(splitRaster(40, 20), 'split', { x: 20, y: 10 });
    const count = session.history.undoCount;
    beginRetouch(session, { x: 10, y: 10 }, 'smudge', { diameter: 10, hardness: 0.5, strength: 1 });
    updateRetouch(session, [{ x: 30, y: 10 }]);
    expect(currentRetouch(session)).not.toBeNull();
    expect(commitRetouch(session)).toBe(true);
    expect(session.history.undoCount).toBe(count + 1);
    expect(session.history.undoName).toBe('Smudge');
    expect(session.layer(id)!.raster!.pixel(27, 10)[0]).toBeGreaterThan(0);
    session.undo();
    const before = session.layer(id)!.raster;
    beginRetouch(session, { x: 8, y: 10 }, 'liquify', { diameter: 10, hardness: 0.5, strength: 1 });
    updateRetouch(session, [{ x: 15, y: 10 }]);
    expect(cancelRetouch(session)).toBe(true);
    expect(session.layer(id)!.raster).toBe(before);
  });
});
