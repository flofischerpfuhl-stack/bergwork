import { describe, expect, it, vi } from 'vitest';
import { Raster } from '../../src/core/raster';
import { EditorSession } from '../../src/core/session';
import { rectangleSelection } from '../../src/core/selectionOps';
import { applyContentAwareFill, beginContentAwareFill } from '../../src/core/contentFill';
import { aiTiles, accumulateTile, cropFixedTile, extractRgba, finishTiles, padFixedTile } from '../../src/core/genai/tiling';
import { blendRgba, lanczosRgba } from '../../src/core/genai/resample';
import { cachedGenAiModel, downloadGenAiModel, GENAI_MODELS } from '../../src/core/genai/models';
import type { ModelHost } from '../../src/platform/hosts/types';

function rgba(width: number, height: number): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    pixels.set([(x * 17 + y * 3) & 255, (x * 5 + y * 19) & 255, (x + y * 7) & 255, 255], (y * width + x) * 4);
  }
  return pixels;
}

describe('local AI model policy', () => {
  it('does a cache-only lookup without a URL, then exposes the pinned URL only for an explicit download', async () => {
    const requests: Parameters<ModelHost['resolveModel']>[0][] = [];
    const host: ModelHost = { version: 1, resolveModel: vi.fn(async (request) => { requests.push(request); return null; }) };
    expect(await cachedGenAiModel(host, 'migan-512')).toBeNull();
    expect(requests).toEqual([{ id: 'migan-512', sha256: GENAI_MODELS['migan-512'].sha256, userInitiated: false }]);
    await expect(downloadGenAiModel(host, 'migan-512')).rejects.toThrow('not cached');
    expect(requests[1]).toEqual({ id: 'migan-512', sha256: GENAI_MODELS['migan-512'].sha256,
      url: GENAI_MODELS['migan-512'].url, userInitiated: true });
  });
});

describe('local AI tiling', () => {
  it('covers a non-multiple image and feather-assembles identity tiles pixel-exactly', () => {
    const width = 913, height = 677, source = rgba(width, height), tiles = aiTiles(width, height, 512, 64);
    expect(Math.max(...tiles.map((tile) => tile.width))).toBe(512);
    expect(Math.max(...tiles.map((tile) => tile.height))).toBe(512);
    expect(tiles.some((tile) => tile.left > 0 && tile.right > 0)).toBe(true);
    const sums = new Float32Array(source.length), weights = new Float32Array(width * height);
    for (const tile of tiles) accumulateTile(sums, weights, width, extractRgba(source, width, tile), tile, 1);
    const assembled = finishTiles(sums, weights);
    let mismatch = -1, minimumWeight = Infinity;
    for (let i = 0; i < source.length; i++) if (assembled[i] !== source[i]) { mismatch = i; break; }
    for (const weight of weights) minimumWeight = Math.min(minimumWeight, weight);
    expect(mismatch).toBe(-1);
    expect(minimumWeight).toBeGreaterThan(0);
  });

  it('Lanczos preserves a constant image and AI-strength endpoints exactly', () => {
    const source = new Uint8Array(7 * 5 * 4);
    for (let i = 0; i < 35; i++) source.set([31, 97, 211, 173], i * 4);
    const resized = lanczosRgba(source, 7, 5, 19, 13);
    for (let i = 0; i < resized.length; i += 4) expect(Array.from(resized.subarray(i, i + 4))).toEqual([31, 97, 211, 173]);
    const other = new Uint8Array(resized.length).fill(240);
    expect(blendRgba(resized, other, 0)).toEqual(resized);
    expect(blendRgba(resized, other, 1)).toEqual(other);
  });

  it('pads a partial MI-GAN tile to 512 and crops its pixels back exactly', () => {
    const source = rgba(7, 5), mask = new Uint8Array(35); mask[9] = 255;
    const padded = padFixedTile(source, mask, 7, 5, 512);
    expect(padded.rgba).toHaveLength(512 * 512 * 4);
    expect(padded.mask[512 + 2]).toBe(255);
    expect(padded.mask[511 * 512 + 511]).toBe(0);
    expect(Array.from(padded.rgba.slice(-4))).toEqual(Array.from(source.slice(-4)));
    expect(cropFixedTile(padded.rgba, 512, 7, 5)).toEqual(source);
  });
});

describe('AI Remove document transaction', () => {
  it('uses the selection mask, preserves the source, and commits a transparent patch as one new layer', async () => {
    const session = new EditorSession(); session.createDocument(20, 16);
    const source = Raster.fromPixels(20, 16, 4, new Uint8Array(20 * 16 * 4).fill(0).map((_, i) => i % 4 === 3 ? 255 : 40));
    session.insertRaster(source, 'Source', { x: 10, y: 8 });
    session.replaceDocument({ ...session.document!, selection: rectangleSelection({ x: 6, y: 5, width: 5, height: 4 }, session.document!, false) });
    const original = session.activeLayer!, undoCount = session.history.undoCount;
    beginContentAwareFill(session, { inference: { async run(input, mask) {
      const result = input.slice();
      for (let i = 0; i < mask.length; i++) if (mask[i]! >= 128) result.set([20, 180, 70, 255], i * 4);
      return result;
    } } });
    expect(await applyContentAwareFill(session, { newLayer: true })).toBe(true);
    expect(session.document!.layers).toHaveLength(2);
    expect(session.document!.layers[0]).toBe(original);
    expect(session.history.undoCount).toBe(undoCount + 1);
    expect(session.history.undoName).toBe('Remove');
    const patch = session.activeLayer!.raster!;
    expect(patch.pixel(7, 6)).toEqual([20, 180, 70, 255]);
    expect(patch.pixel(0, 0)[3]).toBe(0);
    expect(session.undo()).toBe(true);
    expect(session.document!.layers).toHaveLength(1);
    expect(session.activeLayer).toBe(original);
  });
});
