import { expect, it } from 'vitest';
import {
  beginBrushStroke, beginReferenceStroke, beginStroke, currentBrushPreview, extendBrushStroke, finishBrushStroke, setBrushSettings,
} from '../../src/core/brush';
import { newLayer } from '../../src/core/document';
import { makeTransform } from '../../src/core/geometry';
import { alphaBounds, Raster, TILE } from '../../src/core/raster';
import { EditorSession } from '../../src/core/session';

function opaqueNoiseRaster(): Raster {
  const tiles: Uint8Array[] = [];
  let noise = 0x9e3779b9;
  for (let row = 0; row < 4096 / TILE; row++) for (let col = 0; col < 4096 / TILE; col++) {
    const tile = new Uint8Array(TILE * TILE * 4);
    for (let offset = 0; offset < tile.length; offset += 4) {
      noise ^= noise << 13; noise ^= noise >>> 17; noise ^= noise << 5;
      tile[offset] = noise; tile[offset + 1] = noise >>> 8; tile[offset + 2] = noise >>> 16; tile[offset + 3] = 255;
    }
    tiles.push(tile);
  }
  return new Raster(4096, 4096, 4, tiles);
}

function sessionWith(source: Raster | null): EditorSession {
  const session = new EditorSession();
  session.createNewProject(4096, 4096);
  if (source) {
    const document = session.document!, layer = document.layers[0]!;
    session.replaceDocument({ ...document, layers: [{ ...layer, raster: source }] });
  }
  session.tool = 'brush';
  setBrushSettings(session, {
    diameter: 300, hardness: 0, opacity: 1, red: 1, green: 1, blue: 1, mode: 'paint',
  });
  return session;
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * fraction)]!;
}

function irregularStroke(session: EditorSession, label: string): void {
  let seed = 5, x = 500, y = 2500;
  const rand = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  expect(beginBrushStroke(session, { x, y })).not.toBeNull();
  const times: number[] = [], snapshotTimes: number[] = [];
  for (let index = 1; index <= 60; index++) {
    x += 20 + rand() * 40;
    y += (rand() - 0.5) * 50;
    const before = performance.now();
    expect(extendBrushStroke(session, { x, y })).not.toBeNull();
    times.push(performance.now() - before);
    const snapshotStart = performance.now();
    expect(currentBrushPreview(session)).not.toBeNull();
    snapshotTimes.push(performance.now() - snapshotStart);
  }
  const finishStart = performance.now();
  const result = finishBrushStroke(session);
  const finish = performance.now() - finishStart;
  const median = percentile(times, 0.5), p95 = percentile(times, 0.95);
  const snapshotP95 = percentile(snapshotTimes, 0.95);
  console.log(`BRUSH_300_4096_IRREGULAR_${label}_MEDIAN_MS=${median.toFixed(2)} P95_MS=${p95.toFixed(2)} SNAPSHOT_P95_MS=${snapshotP95.toFixed(2)} FINISH_MS=${finish.toFixed(2)}`);
  expect(result && alphaBounds(result.raster)).not.toBeNull();
  expect(snapshotP95).toBeLessThan(100);
  expect(finish).toBeLessThan(100);
  // Shared-CI guards still reject the measured 52–75 ms regression.
  expect(median).toBeLessThan(35);
  expect(p95).toBeLessThan(50);
}

it('keeps irregular 300 px soft brush feedback interactive on a blank 4096² layer', () => {
  irregularStroke(sessionWith(null), 'BLANK');
}, 30_000);

it('keeps irregular 300 px soft brush feedback interactive on an opaque-noise 4096² layer', () => {
  irregularStroke(sessionWith(opaqueNoiseRaster()), 'OPAQUE');
}, 30_000);

it('reports evenly spaced 300 px soft brush feedback as a secondary number', () => {
  const session = sessionWith(null);
  expect(beginBrushStroke(session, { x: 500, y: 500 })).not.toBeNull();
  const times: number[] = [];
  for (let index = 1; index <= 60; index++) {
    const before = performance.now();
    expect(extendBrushStroke(session, { x: 500 + index * 40, y: 500 + index * 30 })).not.toBeNull();
    times.push(performance.now() - before);
  }
  const result = finishBrushStroke(session);
  console.log(`BRUSH_300_4096_EVEN_SECONDARY_MEDIAN_MS=${percentile(times, 0.5).toFixed(2)} P95_MS=${percentile(times, 0.95).toFixed(2)}`);
  expect(result && alphaBounds(result.raster)).not.toBeNull();
}, 30_000);

it('matches the straightforward reference on a random irregular soft stroke within one byte', () => {
  const width = 2048, height = 1024;
  const bytes = new Uint8Array(width * height * 4);
  let noise = 0x243f6a88;
  for (let offset = 0; offset < bytes.length; offset += 4) {
    noise = (noise * 1664525 + 1013904223) >>> 0;
    bytes[offset] = noise; bytes[offset + 1] = noise >>> 8; bytes[offset + 2] = noise >>> 16; bytes[offset + 3] = 255;
  }
  const source = Raster.fromPixels(width, height, 4, bytes);
  const target = newLayer({ id: 'reference', name: 'Reference', raster: source,
    transform: makeTransform({ x: 0, y: 0 }, { width, height }) });
  const options = { layer: target, canvas: { width, height }, settings: {
    diameter: 300, hardness: 0, opacity: 1, red: 0.91, green: 0.17, blue: 0.42, mode: 'paint' as const,
  } };
  const optimized = beginStroke(options), reference = beginReferenceStroke(options);
  let seed = 5, x = 300, y = 512;
  const rand = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  optimized.addPoints([{ x, y }]); reference.addPoints([{ x, y }]);
  for (let index = 1; index <= 30; index++) {
    x += 20 + rand() * 40; y += (rand() - 0.5) * 50;
    optimized.addPoints([{ x, y }]); reference.addPoints([{ x, y }]);
  }
  const actual = optimized.currentRaster(), expected = reference.currentRaster();
  let maxDelta = 0;
  for (let key = 0; key < actual.tiles.length; key++) {
    const a = actual.tiles[key], b = expected.tiles[key], length = Math.max(a?.length ?? 0, b?.length ?? 0);
    for (let offset = 0; offset < length; offset++) {
      maxDelta = Math.max(maxDelta, Math.abs((a?.[offset] ?? 0) - (b?.[offset] ?? 0)));
    }
  }
  expect(maxDelta).toBeLessThanOrEqual(1);
}, 30_000);
