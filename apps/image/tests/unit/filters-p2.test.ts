import { describe, expect, it } from 'vitest';
import { makeTransform } from '../../src/core/geometry';
import { Raster } from '../../src/core/raster';
import { EditorSession } from '../../src/core/session';
import { denoise, highPass, unsharpMask } from '../../src/core/filters/sharpen';
import { addLiveFilter, applyLiveFilters, bakeLiveFilters, defaultLiveFilter, moveLiveFilter } from '../../src/core/filters/live';

function opaqueGray(values: readonly number[]): Raster {
  const bytes = new Uint8Array(values.length * 4);
  values.forEach((value, i) => bytes.set([value, value, value, 255], i * 4));
  return Raster.fromPixels(values.length, 1, 4, bytes);
}

describe('P2 sharpen, denoise and live filter stack', () => {
  it('Unsharp Mask sharpens above threshold and leaves alpha unchanged', () => {
    const source = opaqueGray([0, 0, 80, 160, 160]);
    const result = unsharpMask(source, 100, 1, 0);
    expect(result.pixel(3, 0)[0]).toBeGreaterThan(160);
    expect(result.toPixels()).not.toEqual(source.toPixels());
    expect(result.pixel(3, 0)[3]).toBe(255);
    expect(unsharpMask(source, 100, 1, 255).toPixels()).toEqual(source.toPixels());
  });

  it('High Pass emits neutral gray for flat areas and signed edge detail', () => {
    const flat = highPass(opaqueGray([80, 80, 80]), 1);
    expect(flat.pixel(1, 0)[0]).toBeCloseTo(128, 0);
    const edge = highPass(opaqueGray([0, 0, 255, 255]), 1);
    expect(edge.pixel(1, 0)[0]).toBeLessThan(128); expect(edge.pixel(2, 0)[0]).toBeGreaterThan(128);
  });

  it('basic luminance/chroma denoise reduces an isolated chroma outlier', () => {
    const pixels = new Uint8Array(3 * 3 * 4);
    for (let i = 0; i < 9; i++) pixels.set([128, 128, 128, 255], i * 4);
    pixels.set([255, 0, 128, 255], 4 * 4);
    const source = Raster.fromPixels(3, 3, 4, pixels), result = denoise(source, 0, 100);
    const before = source.pixel(1, 1), after = result.pixel(1, 1);
    expect(Math.abs(after[0]! - after[1]!)).toBeLessThan(Math.abs(before[0]! - before[1]!));
    expect(after[3]).toBe(255);
  });

  it('reduces ±30 luminance grain by at least half while preserving a hard edge', () => {
    const width = 80, height = 48, pixels = new Uint8Array(width * height * 4);
    let seed = 3;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const value = Math.max(0, Math.min(255, (x < width / 2 ? 80 : 170) + seed % 61 - 30));
      pixels.set([value, value, value, 255], (y * width + x) * 4);
    }
    const source = Raster.fromPixels(width, height, 4, pixels), result = denoise(source, 100, 100);
    const stats = (raster: Raster, x0: number) => {
      const values: number[] = [];
      for (let y = 6; y < height - 6; y++) for (let x = x0; x < x0 + 24; x++) values.push(raster.pixel(x, y)[0]!);
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
      return { mean, sigma: Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length) };
    };
    const darkBefore = stats(source, 5), darkAfter = stats(result, 5), lightAfter = stats(result, 51);
    expect(darkAfter.sigma).toBeLessThan(darkBefore.sigma * 0.5);
    expect(lightAfter.mean - darkAfter.mean).toBeGreaterThan(70);
  });

  it('filters remain native rgba16', () => {
    const source = Raster.fromPixels(3, 1, 4, new Uint16Array([
      1000, 1000, 1000, 65535, 30000, 30000, 30000, 65535, 60000, 60000, 60000, 65535,
    ]), { format: 'rgba16' });
    const result = unsharpMask(source, 50, 1, 0);
    expect(result.format).toBe('rgba16'); expect(result.toPixels16()[3]).toBe(65535);
  });

  it('live stack is ordered, cached, undoable and bake clears it', () => {
    const source = opaqueGray([0, 50, 100, 150, 200]);
    const filters = [defaultLiveFilter('gaussianBlur'), { ...defaultLiveFilter('unsharpMask'), amount: 150 }];
    const first = applyLiveFilters(source, filters), second = applyLiveFilters(source, filters);
    expect(second).toBe(first);
    const session = new EditorSession(); session.createDocument(5, 1);
    session.insertRaster(source, 'Ramp'); const id = session.activeLayerId!, undo = session.history.undoCount;
    expect(addLiveFilter(session, id, filters[0]!)).toBe(true);
    expect(addLiveFilter(session, id, filters[1]!)).toBe(true); expect(session.history.undoCount).toBe(undo + 2);
    expect(moveLiveFilter(session, id, 1, 0)).toBe(true);
    expect(bakeLiveFilters(session, id)).toBe(true); expect(session.layer(id)?.filters).toEqual([]);
    expect(session.layer(id)?.raster).not.toBe(source);
  });
});
