import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Raster } from '../../src/core/raster';
import { EditorSession } from '../../src/core/session';
import { ellipseSelection, expandSelection, polygonSelection, selectionOutline } from '../../src/core/selectionOps';
import { encodePng, decodePng } from '../../src/io/png';
import { sha256Hex } from '../../src/io/sha256';
import { compositeRegion } from '../../src/core/composite';
import { newLayer } from '../../src/core/document';
import { makeTransform } from '../../src/core/geometry';

/**
 * CPU-side timings in Node (not the browser): tiled rasters, history, selection engine, codecs and the
 * reference compositor. Bounds are generous regression guards; the numbers are written to
 * artifacts/performance/core.json for the handoff report.
 */
const results: Record<string, number> = {};
function time(name: string, body: () => void, runs = 3): number {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) { const t = performance.now(); body(); samples.push(performance.now() - t); }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)]!;
  results[name] = Math.round(median * 10) / 10;
  return median;
}

function noise(width: number, height: number): Raster {
  const data = new Uint8Array(width * height * 4);
  let seed = 7;
  for (let i = 0; i < data.length; i++) { seed = (seed * 1103515245 + 12345) >>> 0; data[i] = seed >>> 24; }
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return Raster.fromPixels(width, height, 4, data);
}

afterAll(() => {
  const out = path.resolve('artifacts/performance');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'core.json'), JSON.stringify({ node: process.version, date: new Date().toISOString(), medianMs: results }, null, 2));
  console.log('core performance (median ms)', results);
});

describe('core performance', () => {
  it('copy-on-write region edits touch only their tiles', () => {
    const base = noise(4096, 4096);
    const patch = new Uint8Array(64 * 64 * 4).fill(200);
    const ms = time('raster.withRegion 64² on 4096²', () => { for (let i = 0; i < 100; i++) base.withRegion(i * 30, i * 30, 64, 64, patch); });
    expect(ms / 100).toBeLessThan(5);
  });

  it('history snapshots stay cheap for many layers', () => {
    const session = new EditorSession();
    session.createNewProject(2000, 2000);
    const raster = noise(256, 256);
    const ms = time('insert 200 layers with undo steps', () => { for (let i = 0; i < 200; i++) session.insertRaster(raster, `L${i}`); }, 1);
    expect(ms).toBeLessThan(3000);
    const undo = time('undo 200 steps', () => { while (session.undo()) { /* keep undoing */ } }, 1);
    expect(undo).toBeLessThan(3000);
  });

  it('selection engine on an 8000² canvas', () => {
    const canvas = { width: 8000, height: 8000 };
    const ellipse = time('ellipse 7000² selection', () => { ellipseSelection({ x: 500, y: 500, width: 7000, height: 7000 }, canvas, true); }, 1);
    const star = Array.from({ length: 400 }, (_, i) => {
      const a = i / 400 * Math.PI * 2, r = i % 2 ? 3500 : 1500;
      return { x: 4000 + Math.cos(a) * r, y: 4000 + Math.sin(a) * r };
    });
    const lasso = time('400-point lasso 7000²', () => { polygonSelection(star, canvas, true); }, 1);
    const selection = ellipseSelection({ x: 2000, y: 2000, width: 3000, height: 3000 }, canvas, true);
    const outline = time('outline of 3000² ellipse', () => { selectionOutline(selection); }, 1);
    const expand = time('expand 3000² ellipse by 20 px', () => { expandSelection(selection, 20, canvas); }, 1);
    expect(ellipse + lasso + outline + expand).toBeLessThan(20_000);
  });

  it('PNG codec and SHA-256 for 2048² assets', () => {
    const raster = noise(2048, 2048);
    const pixels = raster.toPixels();
    let bytes: Uint8Array = new Uint8Array();
    const encode = time('PNG encode 2048² noise', () => { bytes = encodePng(pixels, 2048, 2048, 4); }, 1);
    const decode = time('PNG decode 2048² noise', () => { decodePng(bytes); }, 1);
    const hash = time('SHA-256 16 MB', () => { sha256Hex(pixels); }, 1);
    expect(encode + decode + hash).toBeLessThan(30_000);
  });

  it('reference compositor, 1024² with five blended layers', () => {
    const modes = ['normal', 'multiply', 'screen', 'overlay', 'colorDodge'] as const;
    const layers = modes.map((mode, i) => newLayer({ id: `C${i}`, name: mode, raster: noise(1024, 1024), blendMode: mode, opacity: 0.8,
      transform: makeTransform({ x: 0, y: 0 }, { width: 1024, height: 1024 }) }));
    const document = { id: 'perf', width: 1024, height: 1024, resolution: 72, layers, selection: null };
    const ms = time('CPU composite 1024² × 5', () => { compositeRegion(document, { x: 0, y: 0, width: 1024, height: 1024 }); }, 1);
    expect(ms).toBeLessThan(30_000);
  });
});
