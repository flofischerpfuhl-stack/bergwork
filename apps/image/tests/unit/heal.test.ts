import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { Raster } from '../../src/core/raster';
import { EditorSession } from '../../src/core/session';
import { createMainThreadKernelClient } from '../../src/workers/kernelClient';
import {
  addSpotHealingPoints, beginSpotHealing, cancelSpotHealing, currentSpotHealingRaster, finishSpotHealing, SPOT_HEALING_MODES,
} from '../../src/core/heal';

function blemished(width = 120, height = 80, cx = 60, cy = 40): Raster {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const red = Math.abs(x - cx) < 5 && Math.abs(y - cy) < 5;
    const gray = x % 4 < 2 ? 100 : 112;
    pixels.set(red ? [230, 20, 20, 255] : [gray, gray, gray, 255], (y * width + x) * 4);
  }
  return Raster.fromPixels(width, height, 4, pixels);
}

function sessionWith(raster: Raster): EditorSession {
  const session = new EditorSession(); session.createDocument(raster.width, raster.height); session.insertRaster(raster, 'Surface');
  session.tool = 'spotHealing';
  return session;
}

describe('Spot Healing (SpotHealingTests.swift)', () => {
  it.each(SPOT_HEALING_MODES)('healsTheBlemishUnderTheBrushAndNothingElse: %s', async (mode) => {
    const original = blemished(), session = sessionWith(original), kernels = createMainThreadKernelClient();
    const count = session.history.undoCount;
    expect(beginSpotHealing(session, { x: 60, y: 40 },
      { diameter: 24, hardness: 1, opacity: 1, mode, seed: 7, kernels })).not.toBeNull();
    addSpotHealingPoints(session, { x: 60.5, y: 40 });
    const result = await finishSpotHealing(session);
    expect(result).not.toBeNull();
    expect(session.history.undoCount).toBe(count + 1);
    expect(session.history.undoName).toBe('Spot Healing');
    const after = session.activeLayer!.raster!;
    for (const [x, y] of [[60, 40], [56, 36], [64, 44]]) {
      const pixel = after.pixel(x!, y!);
      expect(pixel[0]! - pixel[1]!, `${mode}: ${x},${y}`).toBeLessThan(30);
      expect(pixel[1]!).toBeGreaterThanOrEqual(80); expect(pixel[1]!).toBeLessThanOrEqual(130); expect(pixel[3]).toBe(255);
    }
    for (const [x, y] of [[10, 10], [90, 40], [30, 40], [60, 10], [60, 70]]) {
      expect(after.pixel(x!, y!)).toEqual(original.pixel(x!, y!));
    }
    expect(session.undo()).toBe(true);
    expect(session.activeLayer!.raster).toBe(original);
    kernels.destroy();
  }, 20_000);

  it('cancel discards coverage without pixels or history', () => {
    const original = blemished(), session = sessionWith(original), count = session.history.undoCount;
    beginSpotHealing(session, { x: 60, y: 40 }, { diameter: 24, hardness: 1 });
    const wash = currentSpotHealingRaster(session)!.pixel(60, 40);
    expect(wash[0]).toBeLessThan(original.pixel(60, 40)[0]!);
    expect(cancelSpotHealing(session)).toBe(true);
    expect(session.activeLayer!.raster).toBe(original);
    expect(session.history.undoCount).toBe(count);
    expect(cancelSpotHealing(session)).toBe(false);
  });

  it('clips healing coverage to the document selection', async () => {
    const original = blemished(), session = sessionWith(original), kernels = createMainThreadKernelClient();
    const mask = new Uint8Array(12 * 12).fill(255);
    session.replaceDocument({ ...session.document!, selection: { mask: Raster.fromPixels(12, 12, 1, mask), x: 54, y: 34, antialiased: false } });
    beginSpotHealing(session, { x: 60, y: 40 }, { diameter: 40, hardness: 1, seed: 3, kernels });
    await finishSpotHealing(session);
    const after = session.activeLayer!.raster!;
    expect(after.pixel(60, 40)).not.toEqual(original.pixel(60, 40));
    expect(after.pixel(50, 40)).toEqual(original.pixel(50, 40));
    kernels.destroy();
  });
});

describe('Spot Healing performance', () => {
  it('reports a 100 px healing stroke', async () => {
    const raster = blemished(512, 512, 256, 256), session = sessionWith(raster), kernels = createMainThreadKernelClient();
    const start = performance.now();
    beginSpotHealing(session, { x: 220, y: 256 }, { diameter: 100, hardness: 0.5, seed: 9, kernels });
    for (let x = 228; x <= 292; x += 8) addSpotHealingPoints(session, { x, y: 256 });
    await finishSpotHealing(session);
    const elapsed = performance.now() - start;
    expect(session.activeLayer!.raster!.pixel(256, 256)[0]).toBeLessThan(180);
    console.info(`SPOT HEAL BENCH 100px/512² stroke=${elapsed.toFixed(1)}ms`);
    kernels.destroy();
  }, 30_000);
});
