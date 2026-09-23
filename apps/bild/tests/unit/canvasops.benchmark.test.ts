import { expect, it } from 'vitest';
import { resizeImage } from '../../src/core/canvasOps';
import { makeTransform } from '../../src/core/geometry';
import { newLayer, type CanvasDocument } from '../../src/core/document';
import { Raster, TILE } from '../../src/core/raster';

it('benchmarks 4000² to 8000² RGBA Lanczos3', () => {
  const width = 4000, height = 4000, cols = Math.ceil(width / TILE), rows = Math.ceil(height / TILE);
  const tiles: Uint8Array[] = [];
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
    const tw = Math.min(TILE, width - col * TILE), th = Math.min(TILE, height - row * TILE);
    const tile = new Uint8Array(tw * th * 4);
    for (let p = 0; p < tw * th; p++) { tile[p * 4] = 80; tile[p * 4 + 1] = 120; tile[p * 4 + 2] = 160; tile[p * 4 + 3] = 255; }
    tiles.push(tile);
  }
  const raster = new Raster(width, height, 4, tiles);
  const doc: CanvasDocument = { id: 'benchmark', width, height, resolution: 72, selection: null,
    layers: [newLayer({ id: 'layer', name: 'Layer', raster,
      transform: makeTransform({ x: 0, y: 0 }, { width, height }) })] };
  const before = performance.now();
  const result = resizeImage(doc, 8000, 8000, 72, 'High quality');
  const elapsed = performance.now() - before;
  console.log(`BENCHMARK_4000_8000_MS=${elapsed.toFixed(1)} OUTPUT_BYTES=${result.layers[0]!.raster!.byteSize}`);
  expect(result.layers[0]!.raster!.pixel(7999, 7999)).toEqual([80, 120, 160, 255]);
}, 120_000);
