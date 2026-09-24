import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { Raster } from '../../src/core/raster';
import { EditorSession } from '../../src/core/session';
import { rectangleSelection } from '../../src/core/selectionOps';
import { createMainThreadKernelClient } from '../../src/workers/kernelClient';
import {
  applyContentAwareFill, beginContentAwareFill, canContentAwareFill, cancelContentAwareFill,
  contentFillState, previewContentAwareFill, retouchCommands,
} from '../../src/core/contentFill';

function image(width: number, height: number, pixel: (x: number, y: number) => readonly number[]): Raster {
  const result = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) result.set(pixel(x, y), (y * width + x) * 4);
  return Raster.fromPixels(width, height, 4, result);
}

function selectRect(session: EditorSession, x: number, y: number, width: number, height: number): void {
  session.replaceDocument({ ...session.document!, selection: rectangleSelection({ x, y, width, height }, session.document!, false) });
}

function fixture(): EditorSession {
  const session = new EditorSession(); session.createDocument(64, 48);
  session.insertRaster(image(64, 48, (x, y) => x >= 20 && x < 32 && y >= 16 && y < 26
    ? [255, 0, 0, 255] : [51, 153, 204, 255]), 'Object');
  selectRect(session, 20, 16, 12, 10);
  return session;
}

describe('Content-Aware Fill (SmartEditTests / Filters.swift)', () => {
  it('fillReconstructsBackgroundInsideSelectionAndUndoes as one step', async () => {
    const session = fixture(), original = session.activeLayer!.raster!, count = session.history.undoCount;
    const kernels = createMainThreadKernelClient();
    expect(canContentAwareFill(session)).toBe(true);
    const state = beginContentAwareFill(session, { kernels });
    expect(state?.phase).toBe('preparing');
    expect(session.canEditLayers).toBe(false);
    expect(await applyContentAwareFill(session)).toBe(true);
    expect(contentFillState(session)).toBeNull();
    expect(session.history.undoCount).toBe(count + 1);
    expect(session.history.undoName).toBe('Content-Aware Fill');
    const result = session.activeLayer!.raster!;
    for (let y = 0; y < 48; y++) for (let x = 0; x < 64; x++) {
      const p = result.pixel(x, y);
      expect(Math.abs(p[0]! - 51)).toBeLessThanOrEqual(1);
      expect(Math.abs(p[1]! - 153)).toBeLessThanOrEqual(1);
      expect(Math.abs(p[2]! - 204)).toBeLessThanOrEqual(1);
      expect(p[3]).toBe(255);
    }
    expect(session.undo()).toBe(true); expect(session.activeLayer!.raster).toBe(original);
    kernels.destroy();
  });

  it('fillContinuesRepeatingTexture', async () => {
    const session = new EditorSession(); session.createDocument(80, 64);
    session.insertRaster(image(80, 64, (x, y) => x >= 32 && x < 44 && y >= 26 && y < 36
      ? [255, 0, 0, 255] : ((Math.floor(x / 4) % 2 === 0) ? [51, 51, 51, 255] : [204, 204, 204, 255])), 'Stripes');
    selectRect(session, 32, 26, 12, 10);
    const kernels = createMainThreadKernelClient(); beginContentAwareFill(session, { kernels });
    expect(await applyContentAwareFill(session)).toBe(true);
    let matching = 0;
    for (let y = 26; y < 36; y++) for (let x = 32; x < 44; x++) {
      if (Math.abs(session.activeLayer!.raster!.pixel(x, y)[0]! - (Math.floor(x / 4) % 2 === 0 ? 51 : 204)) <= 1) matching++;
    }
    expect(matching).toBeGreaterThanOrEqual(114);
    kernels.destroy();
  });

  it('cancelAndNoSourceLeaveOriginalUntouched and discard stale preview', async () => {
    const session = fixture(), original = session.activeLayer!.raster!, count = session.history.undoCount;
    const kernels = createMainThreadKernelClient(); beginContentAwareFill(session, { kernels });
    expect(cancelContentAwareFill(session)).toBe(true);
    await Promise.resolve(); await Promise.resolve();
    expect(session.activeLayer!.raster).toBe(original);
    expect(session.rasterOverrides.size).toBe(0);
    expect(session.history.undoCount).toBe(count);
    expect(session.adjustmentEditingId).toBeNull();

    selectRect(session, 0, 0, 64, 48);
    const state = beginContentAwareFill(session, { kernels })!;
    expect(await applyContentAwareFill(session)).toBe(false);
    expect(state.phase).toBe('error'); expect(state.error).toContain('Not enough unselected');
    expect(session.activeLayer!.raster).toBe(original);
    cancelContentAwareFill(session);
    kernels.destroy();
  });

  it('grows the layer through selection past its edge and exposes preview placement', async () => {
    const session = new EditorSession(); session.createDocument(40, 30);
    session.insertRaster(image(20, 20, () => [80, 120, 160, 255]), 'Small', { x: 20, y: 15 });
    selectRect(session, 5, 10, 10, 8);
    const kernels = createMainThreadKernelClient(), state = beginContentAwareFill(session, { kernels })!;
    expect(state.grownRaster.width).toBe(25);
    expect(state.grownTransform.origin.x).toBe(5);
    expect(await applyContentAwareFill(session)).toBe(true);
    expect(session.activeLayer!.raster!.width).toBe(25);
    expect(session.activeLayer!.transform.origin.x).toBe(5);
    kernels.destroy();
  });

  it('retouchCommands enables and starts only a valid content-aware edit', () => {
    const session = fixture(), commands = retouchCommands(session);
    expect(commands.contentAwareFill.enabled()).toBe(true);
    commands.contentAwareFill.run();
    expect(contentFillState(session)).not.toBeNull();
    expect(commands.contentAwareFill.enabled()).toBe(false);
    cancelContentAwareFill(session);
  });

  it('discards a worker result when its source document becomes stale', async () => {
    const session = fixture(), kernels = createMainThreadKernelClient();
    beginContentAwareFill(session, { kernels });
    const pending = previewContentAwareFill(session);
    const replacement = Raster.blank(64, 48, 4), layers = session.document!.layers.slice();
    const last = layers.at(-1);
    if (last?.kind !== 'pixel') throw new Error('Expected pixel layer');
    layers[layers.length - 1] = { ...last, raster: replacement };
    session.replaceDocument({ ...session.document!, layers });
    expect(await pending).toBeNull();
    expect(contentFillState(session)).toBeNull();
    expect(session.rasterOverrides.size).toBe(0);
    kernels.destroy();
  });
});

describe('Content-Aware Fill performance', () => {
  it('reports a 512² selected hole', async () => {
    const side = 768, hole = 512, edge = (side - hole) / 2;
    const session = new EditorSession(); session.createDocument(side, side);
    session.insertRaster(image(side, side, (x, y) => x >= edge && x < edge + hole && y >= edge && y < edge + hole
      ? [220, 20, 20, 255] : [96 + (x % 8), 96 + (x % 8), 96 + (x % 8), 255]), 'Benchmark');
    selectRect(session, edge, edge, hole, hole);
    const kernels = createMainThreadKernelClient(), start = performance.now();
    beginContentAwareFill(session, { kernels });
    expect(await applyContentAwareFill(session)).toBe(true);
    const elapsed = performance.now() - start;
    expect(session.activeLayer!.raster!.pixel(side / 2, side / 2)[0]).toBeLessThan(150);
    console.info(`CONTENT FILL BENCH 512² hole=${elapsed.toFixed(1)}ms`);
    kernels.destroy();
  }, 60_000);
});
