import { describe, expect, it } from 'vitest';
import { getBrushSettings, setBrushSettings } from '../../src/core/brush';
import { compositeRegion } from '../../src/core/composite';
import { newLayer, type CanvasDocument } from '../../src/core/document';
import { makeTransform } from '../../src/core/geometry';
import { Raster } from '../../src/core/raster';
import { downsampleLevel, prepareSampler, sampleMask, sampleRgba } from '../../src/core/resample';
import { EditorSession } from '../../src/core/session';

function gray(width: number, height: number, value: (x: number, y: number) => number): Raster {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const v = value(x, y), offset = (y * width + x) * 4;
    pixels[offset] = v; pixels[offset + 1] = v; pixels[offset + 2] = v; pixels[offset + 3] = 255;
  }
  return Raster.fromPixels(width, height, 4, pixels);
}

function shrunk(source: Raster, width: number, height: number): Uint8Array {
  const layer = newLayer({ id: 'layer', name: 'Layer', raster: source,
    transform: makeTransform({ x: 0, y: 0 }, { width, height }, { sampling: 'High quality' }) });
  const document: CanvasDocument = { id: 'doc', width, height, resolution: 72, selection: null, layers: [layer] };
  return compositeRegion(document, { x: 0, y: 0, width, height }).rgba;
}

describe('upstream DownsampleTests', () => {
  it('halvingsAreReusedAndOnlyUsedForLargeReductions', () => {
    const source = gray(1024, 512, (x) => x % 2 ? 255 : 0);
    expect(downsampleLevel(.6)).toBe(0);
    const eighth = prepareSampler(source, 'High quality', 128);
    expect(eighth).toMatchObject({ width: 128, height: 64, level: 3 });
    expect(prepareSampler(source, 'High quality', 307).width).toBe(512);
    expect(prepareSampler(source, 'High quality', 128).reduced).toBe(eighth.reduced);
    expect(prepareSampler(source, 'Nearest', 1).level).toBe(0);
  });

  it('aHardEdgeStaysSharpShrunkEightTimes', () => {
    const source = gray(4096, 64, (x) => x < 2048 ? 0 : 255);
    const pixels = shrunk(source, 512, 8);
    const row = Array.from({ length: 512 }, (_, x) => pixels[(4 * 512 + x) * 4]!);
    expect(row.filter((value) => value > 40 && value < 215).length).toBeLessThanOrEqual(3);
    expect(row[250]).toBeLessThan(10); expect(row[262]).toBeGreaterThan(245);
  });

  it('translucentEdgesStayValidAndMasksStayGray', () => {
    const rgba = new Uint8Array(512 * 512 * 4);
    for (let y = 128; y < 384; y++) for (let x = 128; x < 384; x++) rgba.set([255, 255, 255, 128], (y * 512 + x) * 4);
    const sampler = prepareSampler(Raster.fromPixels(512, 512, 4, rgba), 'High quality', 128);
    const sampled = new Float32Array(4); sampleRgba(sampler, 128, 256, sampled);
    expect(sampled[0]).toBeLessThanOrEqual(sampled[3]!);
    expect(sampled[1]).toBeLessThanOrEqual(sampled[3]!);
    expect(sampled[2]).toBeLessThanOrEqual(sampled[3]!);
    const maskBytes = new Uint8Array(512 * 512);
    for (let y = 0; y < 512; y++) maskBytes.fill(255, y * 512, y * 512 + 256);
    const mask = prepareSampler(Raster.fromPixels(512, 512, 1, maskBytes), 'High quality', 128);
    expect(mask).toMatchObject({ width: 128, height: 128, channels: 1 });
    expect(sampleMask(mask, 64, 64)).toBe(1); expect(sampleMask(mask, 448, 64)).toBe(0);
  });
});

describe('upstream CloneStampTests', () => {
  it('cloneStampKeepsItsOwnSoftBrushTip', () => {
    const session = new EditorSession(); session.createDocument(40, 20);
    session.selectTool('brush');
    setBrushSettings(session, { ...getBrushSettings(session), diameter: 30 });
    expect(getBrushSettings(session)).toMatchObject({ hardness: 1, diameter: 30 });
    session.selectTool('cloneStamp');
    expect(getBrushSettings(session)).toMatchObject({ hardness: 0, diameter: 40 });
    setBrushSettings(session, { ...getBrushSettings(session), hardness: .5 });
    session.selectTool('spotHealing');
    expect(getBrushSettings(session)).toMatchObject({ hardness: 1, diameter: 30 });
    session.selectTool('cloneStamp');
    expect(getBrushSettings(session)).toMatchObject({ hardness: .5, diameter: 40 });
  });
});
