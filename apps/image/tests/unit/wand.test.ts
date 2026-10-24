import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { makeTransform } from '../../src/core/geometry';
import { newLayer } from '../../src/core/document';
import { Raster } from '../../src/core/raster';
import { EditorSession } from '../../src/core/session';
import { selectionCoverage } from '../../src/core/selectionOps';
import { createMainThreadKernelClient } from '../../src/workers/kernelClient';
import { DEFAULT_WAND_SETTINGS, magicWand } from '../../src/core/wand';

function rgba(width: number, height: number, color: (x: number, y: number) => readonly number[]): Raster {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels.set(color(x, y), (y * width + x) * 4);
  return Raster.fromPixels(width, height, 4, pixels);
}

function selected(session: EditorSession): number[] {
  const selection = session.selection, document = session.document!;
  if (!selection) return [];
  const coverage = selectionCoverage(selection, { x: 0, y: 0, width: document.width, height: document.height });
  const result: number[] = [];
  for (let i = 0; i < coverage.length; i++) if (coverage[i]! >= 128) result.push(i);
  return result;
}

describe('Magic Wand (MagicWandTests.swift)', () => {
  it('contiguousStopsAtOtherColorsWhileNonContiguousFindsEveryMatch', async () => {
    const red = [255, 0, 0, 255], blue = [0, 0, 255, 255];
    const raster = rgba(10, 4, (x) => x < 3 || x >= 6 ? red : blue);
    const session = new EditorSession(); session.createDocument(10, 4); session.insertRaster(raster, 'Stripes');
    const kernels = createMainThreadKernelClient();
    await magicWand(session, { x: 1.5, y: 2.5 }, 'New', DEFAULT_WAND_SETTINGS, kernels);
    expect(selected(session)).toEqual([0, 1, 2, 10, 11, 12, 20, 21, 22, 30, 31, 32]);
    await magicWand(session, { x: 1.5, y: 2.5 }, 'New', { ...DEFAULT_WAND_SETTINGS, contiguous: false }, kernels);
    expect(selected(session)).toHaveLength(28);
    kernels.destroy();
  });

  it('toleranceAppliesToEveryChannelIncludingAlpha and sampleSizeAverages', async () => {
    const columns = [[100, 100, 100, 255], [132, 100, 100, 255], [133, 100, 100, 255], [100, 100, 100, 222]];
    const session = new EditorSession(); session.createDocument(4, 1); session.insertRaster(rgba(4, 1, x => columns[x]!), 'Row');
    const kernels = createMainThreadKernelClient();
    for (const [tolerance, expected] of [[0, [0]], [32, [0, 1]], [33, [0, 1, 2, 3]]] as const) {
      await magicWand(session, { x: 0.5, y: 0.5 }, 'New', { ...DEFAULT_WAND_SETTINGS, tolerance, contiguous: false }, kernels);
      expect(selected(session)).toEqual(expected);
    }
    const dot = new EditorSession(); dot.createDocument(5, 5);
    dot.insertRaster(rgba(5, 5, (x, y) => x === 2 && y === 2 ? [255, 255, 255, 255] : [0, 0, 0, 255]), 'Dot');
    await magicWand(dot, { x: 2.5, y: 2.5 }, 'New',
      { ...DEFAULT_WAND_SETTINGS, tolerance: 30, sampleSize: 'threeByThree', contiguous: false }, kernels);
    expect(selected(dot)).toEqual(Array.from({ length: 25 }, (_, i) => i).filter(i => i !== 12));
    kernels.destroy();
  });

  it('reads transformed active pixels or the injected merged composite and combines modes as one undo', async () => {
    const source = rgba(2, 1, x => x === 0 ? [255, 0, 0, 255] : [0, 0, 255, 255]);
    const merged = rgba(6, 2, x => x < 3 ? [255, 0, 0, 255] : [0, 0, 255, 255]);
    const session = new EditorSession({ flatten: async () => merged, bakeLiveMask: async () => null });
    session.installProject({ id: 'doc', width: 6, height: 2, resolution: 72,
      layers: [newLayer({ id: 'layer', name: 'Layer', raster: source,
        transform: makeTransform({ x: 2, y: 0 }, { width: 2, height: 1 }, { sampling: 'Nearest' }) })], selection: null }, 'layer', null);
    const kernels = createMainThreadKernelClient();
    await magicWand(session, { x: 2.2, y: 0.2 }, 'New', DEFAULT_WAND_SETTINGS, kernels);
    expect(selected(session)).toEqual([2]);
    const count = session.history.undoCount;
    await magicWand(session, { x: 1, y: 1 }, 'New', { ...DEFAULT_WAND_SETTINGS, sampleAllLayers: true }, kernels);
    expect(selected(session)).toEqual([0, 1, 2, 6, 7, 8]);
    await magicWand(session, { x: 4, y: 1 }, 'Add', { ...DEFAULT_WAND_SETTINGS, sampleAllLayers: true }, kernels);
    expect(selected(session)).toHaveLength(12);
    expect(session.history.undoCount).toBe(count + 2);
    await magicWand(session, { x: 1, y: 1 }, 'Subtract', { ...DEFAULT_WAND_SETTINGS, sampleAllLayers: true }, kernels);
    expect(selected(session)).toEqual([3, 4, 5, 9, 10, 11]);
    kernels.destroy();
  });
});

describe('Magic Wand performance', () => {
  it('reports contiguous and non-contiguous wand on 4096²', async () => {
    const side = 4096, pixels = new Uint8Array(side * side * 4);
    new Uint32Array(pixels.buffer).fill(0xff808080);
    const session = new EditorSession(); session.createDocument(side, side);
    session.insertRaster(Raster.fromPixels(side, side, 4, pixels), 'Large');
    const kernels = createMainThreadKernelClient();
    let start = performance.now();
    await magicWand(session, { x: 2048, y: 2048 }, 'New', { ...DEFAULT_WAND_SETTINGS, tolerance: 0 }, kernels);
    const contiguous = performance.now() - start;
    start = performance.now();
    await magicWand(session, { x: 2048, y: 2048 }, 'New',
      { ...DEFAULT_WAND_SETTINGS, tolerance: 0, contiguous: false }, kernels);
    const noncontiguous = performance.now() - start;
    expect(session.selection?.mask.pixel(0, 0)[0]).toBe(255);
    expect(session.selection?.mask.pixel(side - 1, side - 1)[0]).toBe(255);
    console.info(`WAND BENCH 4096² contiguous=${contiguous.toFixed(1)}ms non-contiguous=${noncontiguous.toFixed(1)}ms`);
    kernels.destroy();
  }, 60_000);
});
