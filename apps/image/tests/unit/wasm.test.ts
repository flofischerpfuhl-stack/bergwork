import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { KernelError, loadKernels, type Kernels } from '../../src/wasm/kernels.js';
import { createMainThreadKernelClient, KernelCancelledError } from '../../src/workers/kernelClient';

let loaded: Promise<Kernels>;
function kernels(): Promise<Kernels> { return loaded ??= loadKernels(); }

function rgba(width: number, height: number, color: (x: number, y: number) => readonly number[]): Uint8Array {
  const result = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    result.set(color(x, y), (y * width + x) * 4);
  }
  return result;
}

function indices(mask: Uint8Array): number[] {
  const result: number[] = [];
  for (let i = 0; i < mask.length; i++) if (mask[i]) result.push(i);
  return result;
}

function identityTables(): Float32Array {
  const result = new Float32Array(3 * 256);
  for (let channel = 0; channel < 3; channel++) for (let i = 0; i < 256; i++) result[channel * 256 + i] = i / 255;
  return result;
}

function tracedPixels(points: Int32Array, loops: Int32Array, width: number, height: number): number[] {
  const result: number[] = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const px = x + 0.5, py = y + 0.5;
    let winding = 0, start = 0;
    for (const length of loops) {
      for (let i = 0; i < length; i++) {
        const j = (i + 1) % length;
        const ax = points[(start + i) * 2]!, ay = points[(start + i) * 2 + 1]!;
        const bx = points[(start + j) * 2]!, by = points[(start + j) * 2 + 1]!;
        if (ay <= py && by > py && (bx - ax) * (py - ay) - (px - ax) * (by - ay) > 0) winding++;
        if (ay > py && by <= py && (bx - ax) * (py - ay) - (px - ax) * (by - ay) < 0) winding--;
      }
      start += length;
    }
    if (winding !== 0) result.push(y * width + x);
  }
  return result;
}

describe('real Emscripten rendering kernels', () => {
  it('ports MagicWandTests contiguous/non-contiguous, tolerance, sampling, and trace', async () => {
    const k = await kernels();
    const red = [255, 0, 0, 255], blue = [0, 0, 255, 255];
    const stripes = rgba(10, 4, x => x < 3 || x >= 6 ? red : blue);
    expect(indices(k.wandMask(stripes, 10, 4, 40, 1, 2, 0, 32, true).mask))
      .toEqual([0, 1, 2, 10, 11, 12, 20, 21, 22, 30, 31, 32]);
    expect(k.wandMask(stripes, 10, 4, 40, 1, 2, 0, 32, false).count).toBe(28);

    const tolerance = rgba(4, 1, x => [[100, 100, 100, 255], [132, 100, 100, 255],
      [133, 100, 100, 255], [100, 100, 100, 222]][x]!);
    expect(indices(k.wandMask(tolerance, 4, 1, 16, 0, 0, 0, 0, false).mask)).toEqual([0]);
    expect(indices(k.wandMask(tolerance, 4, 1, 16, 0, 0, 0, 32, false).mask)).toEqual([0, 1]);
    expect(indices(k.wandMask(tolerance, 4, 1, 16, 0, 0, 0, 33, false).mask)).toEqual([0, 1, 2, 3]);

    const dot = rgba(5, 5, (x, y) => x === 2 && y === 2 ? [255, 255, 255, 255] : [0, 0, 0, 255]);
    expect(indices(k.wandMask(dot, 5, 5, 20, 2, 2, 1, 30, false).mask)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
    ]);

    const mask = new Uint8Array(8 * 6);
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) if (x !== 1 || y !== 1) mask[y * 8 + x] = 255;
    mask[4 * 8 + 5] = 255; mask[5 * 8 + 6] = 255;
    const trace = k.wandTrace(mask, 8, 6);
    expect(tracedPixels(trace.points, trace.loops, 8, 6)).toEqual(indices(mask));
    expect(k.wandTrace(new Uint8Array(4), 2, 2)).toEqual({ points: new Int32Array(), loops: new Int32Array() });
  });

  it('ports LevelsTests LUT application and alpha/selection-weighted histogram', async () => {
    const k = await kernels();
    const source = new Uint8Array([
      0, 0, 0, 255, 64, 64, 64, 255, 128, 128, 128, 255, 255, 255, 255, 255,
      64, 32, 0, 128, 0, 0, 0, 0,
    ]);
    expect(k.levelsApply(source, 6, identityTables())).toEqual(source);

    const clippedTable = new Float32Array(3 * 256);
    for (let c = 0; c < 3; c++) for (let i = 0; i < 256; i++) clippedTable[c * 256 + i] = Math.min(1, Math.max(0, (i - 64) / 64));
    expect(Array.from(k.levelsApply(source, 6, clippedTable).subarray(0, 12)))
      .toEqual([0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255]);

    const pixels = new Uint8Array([255, 0, 0, 255, 0, 64, 0, 128, 0, 0, 0, 0]);
    const bins = k.levelsHistogram(pixels, null, 3);
    expect(bins[256 + 255]).toBe(1);
    expect(bins[512 + 128]).toBeCloseTo(128 / 255, 12);
    expect(bins.subarray(0, 256).reduce((a, b) => a + b, 0)).toBeCloseTo(1 + 128 / 255, 12);
    const selected = k.levelsHistogram(pixels, new Uint8Array([255, 0, 0]), 3);
    expect(selected[256 + 255]).toBe(1);
    expect(selected[512 + 128]).toBe(0);
  });

  it('ports ImageAdjustmentTests gradient map and document-fixed grain pixels', async () => {
    const k = await kernels();
    const table = new Uint8Array(256 * 3);
    for (let i = 0; i < 256; i++) { table[i * 3] = 255 - i; table[i * 3 + 2] = i; }
    const mapped = k.adjustGradientMap(new Uint8Array([
      0, 0, 0, 255, 128, 128, 128, 255, 255, 255, 255, 255, 128, 128, 128, 128,
    ]), 4, 1, 16, table);
    expect(Array.from(mapped)).toEqual([255, 0, 0, 255, 127, 0, 128, 255, 0, 0, 255, 255, 0, 0, 128, 128]);

    const gray = new Uint8Array(40 * 40 * 4);
    new Uint32Array(gray.buffer).fill(0xff808080);
    const whole = k.adjustGrain(gray, 40, 40, 160, 60, 2, 40, 7, 0, 0, 1);
    expect(new Set(Array.from({ length: 1600 }, (_, i) => whole[i * 4])).size).toBeGreaterThan(5);
    for (let i = 0; i < 1600; i++) expect(whole[i * 4]).toBe(whole[i * 4 + 1]);
    const partSource = new Uint8Array(20 * 20 * 4); new Uint32Array(partSource.buffer).fill(0xff808080);
    const part = k.adjustGrain(partSource, 20, 20, 80, 60, 2, 40, 7, 10, 10, 1);
    for (let y = 0; y < 20; y++) {
      expect(part.subarray(y * 80, y * 80 + 80)).toEqual(whole.subarray(((y + 10) * 40 + 10) * 4, ((y + 10) * 40 + 30) * 4));
    }
    expect(k.adjustGrain(partSource, 20, 20, 80, 0, 2, 40, 7, 10, 10, 1)).toEqual(partSource);
  });

  it('ports FilterTests deterministic noise and center-based lens distortion', async () => {
    const k = await kernels();
    const source = rgba(32, 8, x => x < 16 ? [128, 128, 128, 255] : [0, 0, 0, 0]);
    const color = k.noiseAdd(source, 32, 8, 128, 10, false, false, 7);
    expect(k.noiseAdd(source, 32, 8, 128, 10, false, false, 7)).toEqual(color);
    const opaqueOffsets = Array.from({ length: 128 }, (_, i) => (Math.floor(i / 16) * 32 + i % 16) * 4);
    expect(opaqueOffsets.every(i => color[i + 3] === 255 && color[i]! >= 112 && color[i]! <= 144)).toBe(true);
    expect(new Set(opaqueOffsets.map(i => color[i])).size).toBeGreaterThan(5);
    expect(opaqueOffsets.some(i => color[i] !== color[i + 1])).toBe(true);
    for (let y = 0; y < 8; y++) for (let x = 16; x < 32; x++) expect(Array.from(color.subarray((y * 32 + x) * 4, (y * 32 + x + 1) * 4))).toEqual([0, 0, 0, 0]);
    const mono = k.noiseAdd(source, 32, 8, 128, 10, true, true, 7);
    expect(opaqueOffsets.every(i => mono[i] === mono[i + 1] && mono[i + 1] === mono[i + 2])).toBe(true);

    const quadrants = rgba(40, 30, (x, y) => {
      const index = (y >= 15 ? 2 : 0) + (x >= 20 ? 1 : 0);
      return [Math.round(index * 255 / 3), 128, Math.round((3 - index) * 255 / 3), 255];
    });
    expect(k.lensDistort(quadrants, 40, 30, 160, 0)).toEqual(quadrants);
    const barrel = k.lensDistort(quadrants, 40, 30, 160, 0.35);
    expect(barrel[3]).toBe(255); expect(barrel[(40 * 30 - 1) * 4 + 3]).toBe(255);
    const pincushion = k.lensDistort(quadrants, 40, 30, 160, -0.35);
    expect(pincushion[3]).toBe(0); expect(pincushion[(40 * 30 - 1) * 4 + 3]).toBe(0);
    expect(pincushion.slice((15 * 40 + 20) * 4, (15 * 40 + 20) * 4 + 4))
      .toEqual(quadrants.slice((15 * 40 + 20) * 4, (15 * 40 + 20) * 4 + 4));
  });

  it('ports SpotHealingTests and HealPixels bounds for all three modes', async () => {
    const k = await kernels(), width = 120, height = 80;
    const original = rgba(width, height, (x, y) => {
      const red = x >= 55 && x < 65 && y >= 35 && y < 45, gray = x % 4 < 2 ? 100 : 112;
      return red ? [230, 20, 20, 255] : [gray, gray, gray, 255];
    });
    const coverage = new Uint8Array(width * height);
    for (let y = 28; y < 52; y++) for (let x = 48; x < 72; x++) {
      const dx = x + 0.5 - 60, dy = y + 0.5 - 40;
      if (dx * dx + dy * dy <= 12 * 12) coverage[y * width + x] = 255;
    }
    expect(k.healCoverageBounds(coverage, width, height, width)).toEqual({ left: 48, top: 28, right: 72, bottom: 52 });
    for (const mode of [0, 1, 2] as const) {
      const healed = k.spotHeal(original, coverage, width, height, width * 4, 1, mode, 123);
      for (const [x, y] of [[60, 40], [56, 36], [64, 44]]) {
        const i = (y! * width + x!) * 4;
        expect(healed[i]! - healed[i + 1]!).toBeLessThan(30);
        expect(healed[i + 1]).toBeGreaterThanOrEqual(80); expect(healed[i + 1]).toBeLessThanOrEqual(130);
        expect(healed[i + 3]).toBe(255);
      }
      for (const [x, y] of [[10, 10], [90, 40], [30, 40], [60, 10], [60, 70]]) {
        const i = (y! * width + x!) * 4;
        expect(healed.slice(i, i + 4)).toEqual(original.slice(i, i + 4));
      }
    }
  }, 30_000);

  it('ports SmartEditTests content fill texture and no-source status', async () => {
    const k = await kernels(), width = 80, height = 64;
    const source = rgba(width, height, (x, y) => {
      if (x >= 32 && x < 44 && y >= 26 && y < 36) return [255, 0, 0, 255];
      const value = Math.floor(x / 4) % 2 === 0 ? 51 : 204;
      return [value, value, value, 255];
    });
    const mask = new Uint8Array(width * height);
    for (let y = 26; y < 36; y++) mask.fill(255, y * width + 32, y * width + 44);
    const filled = k.contentFill(source, width * 4, mask, width, width, height);
    let matching = 0;
    for (let y = 26; y < 36; y++) for (let x = 32; x < 44; x++) {
      const expected = Math.floor(x / 4) % 2 === 0 ? 51 : 204;
      if (Math.abs(filled[(y * width + x) * 4]! - expected) <= 1) matching++;
    }
    expect(matching).toBeGreaterThanOrEqual(114);
    expect(() => k.contentFill(source, width * 4, new Uint8Array(width * height).fill(255), width, width, height))
      .toThrowError(expect.objectContaining<Partial<KernelError>>({ code: 'no-source' }));
  });

  it('ports BrushPixels bounds and LiveMaskRenderer alpha round trip', async () => {
    const k = await kernels();
    const pixels = new Uint8Array(3 * 3 * 4);
    pixels.set([20, 10, 5, 40], (1 * 3 + 2) * 4);
    pixels.set([64, 32, 16, 128], (2 * 3) * 4);
    expect(k.brushAlphaBounds(pixels, 3, 3, 12)).toEqual({ left: 0, top: 1, right: 3, bottom: 3 });
    expect(k.brushAlphaBounds(new Uint8Array(36), 3, 3, 12)).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });

    const premultiplied = new Uint8Array([64, 32, 16, 128, 0, 0, 0, 0]);
    const alpha = k.layerExtractAlpha(premultiplied, 8, 2, 2, 1);
    expect(alpha).toEqual(new Uint8Array([128, 0]));
    const opaque = k.layerUnpremultiplyOpaque(premultiplied, 8, 2, 1);
    expect(opaque).toEqual(new Uint8Array([128, 64, 32, 255, 0, 0, 0, 255]));
    expect(k.layerRestoreAlpha(opaque, 8, alpha, 2, 2, 1)).toEqual(premultiplied);
    expect(k.clampPremultiplied(new Uint8Array([200, 80, 64, 100]), 1)).toEqual(new Uint8Array([100, 80, 64, 100]));
  });

  it('main-thread worker fallback mirrors methods, reports progress, and discards cancellation', async () => {
    const progress: string[] = [];
    const client = createMainThreadKernelClient(event => progress.push(`${event.id}:${event.phase}`));
    const job = client.wandMask(new Uint8Array([1, 2, 3, 255]), 1, 1, 4, 0, 0, 0, 0, true);
    expect((await job).count).toBe(1);
    expect(progress).toEqual([`${job.id}:start`, `${job.id}:end`]);
    const cancelled = client.noiseAdd(new Uint8Array([128, 128, 128, 255]), 1, 1, 4, 10, false, false, 1);
    client.cancel(cancelled.id);
    await expect(cancelled).rejects.toBeInstanceOf(KernelCancelledError);
    client.destroy();
  });

  it('benchmarks wand_mask and noise_add on 4096² real wasm pixels', async () => {
    const k = await kernels(), side = 4096, source = new Uint8Array(side * side * 4);
    new Uint32Array(source.buffer).fill(0xff808080);
    let start = performance.now();
    const wand = k.wandMask(source, side, side, side * 4, 2048, 2048, 0, 0, true);
    const wandMs = performance.now() - start;
    expect(wand.count).toBe(side * side);
    start = performance.now();
    const noisy = k.noiseAdd(source, side, side, side * 4, 10, false, false, 7);
    const noiseMs = performance.now() - start;
    expect(noisy[3]).toBe(255);
    console.info(`WASM benchmark 4096²: wand_mask ${wandMs.toFixed(1)} ms; noise_add ${noiseMs.toFixed(1)} ms`);
  }, 60_000);
});
