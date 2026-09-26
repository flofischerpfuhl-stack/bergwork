import { describe, expect, it } from 'vitest';
import { writePsdUint8Array, type BezierPath, type Layer as AgLayer, type Psd } from 'ag-psd';
import { readPsdDocument } from '../../src/io/psd';
import { cpuCompositeRegion } from '../../src/render/cpuRender';

function rectangle(left: number, top: number, right: number, bottom: number): BezierPath {
  const knot = (x: number, y: number) => ({ linked: false, points: [x, y, x, y, x, y] });
  return { open: false, fillRule: 'non-zero', operation: 'combine',
    knots: [knot(left, top), knot(right, top), knot(right, bottom), knot(left, bottom)] };
}

function pixels(width: number, height: number): { width: number; height: number; data: Uint8ClampedArray } {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

describe('PRODUCT-PLAN A5 PSD vector import', () => {
  it('imports vmsk/vstk shape geometry and style as an editable vector layer', () => {
    const shape: AgLayer = { name: 'PSD Shape', left: 20, top: 10, right: 80, bottom: 70, imageData: pixels(60, 60),
      vectorMask: { paths: [rectangle(20, 10, 80, 70)] },
      vectorFill: { type: 'color', color: { r: 255, g: 32, b: 16 } },
      vectorStroke: { strokeEnabled: true, fillEnabled: true, lineWidth: { units: 'Pixels', value: 6 },
        lineAlignment: 'inside', lineCapType: 'round', lineJoinType: 'bevel', miterLimit: 7,
        lineDashSet: [{ units: 'Pixels', value: 8 }, { units: 'Pixels', value: 4 }],
        content: { type: 'color', color: { r: 0, g: 128, b: 255 } } } };
    const input: Psd = { width: 100, height: 80, children: [shape], imageData: pixels(100, 80) };
    const layer = readPsdDocument(writePsdUint8Array(input, { generateThumbnail: false })).document.layers[0]!;
    expect(layer.kind).toBe('vector');
    if (layer.kind !== 'vector') throw new Error('Expected editable PSD vector');
    expect(layer.paths[0]!.points[0]!.anchor.x).toBeCloseTo(0); expect(layer.paths[0]!.points[0]!.anchor.y).toBeCloseTo(0);
    expect(layer.paths[0]!.points[2]!.anchor.x).toBeCloseTo(60); expect(layer.paths[0]!.points[2]!.anchor.y).toBeCloseTo(60);
    expect(layer.style.fill).toMatchObject({ kind: 'solid', color: { red: 1 } });
    expect(layer.style.stroke).toMatchObject({ width: 6, alignment: 'inside', cap: 'round', join: 'bevel',
      miterLimit: 7, dash: [8, 4], paint: { kind: 'solid' } });
  });

  it('imports a vector mask on a pixel layer with density, feather and inversion', () => {
    const layer: AgLayer = { name: 'Masked pixels', left: 0, top: 0, right: 40, bottom: 30, imageData: pixels(40, 30),
      mask: { vectorMaskDensity: 0.6, vectorMaskFeather: 2.5 },
      vectorMask: { invert: true, paths: [rectangle(5, 4, 30, 20)] } };
    const input: Psd = { width: 40, height: 30, children: [layer], imageData: pixels(40, 30) };
    const imported = readPsdDocument(writePsdUint8Array(input, { generateThumbnail: false })).document.layers[0]!;
    expect(imported.kind).toBe('pixel');
    expect(imported.vectorMask).toMatchObject({ enabled: true, inverted: true, density: 0.6, feather: 2.5 });
    expect(imported.vectorMask?.paths[0]!.points[0]!.anchor.x).toBeCloseTo(5);
    expect(imported.vectorMask?.paths[0]!.points[0]!.anchor.y).toBeCloseTo(4);
  });

  it('multiplies editable vector coverage by the independent real user-mask channel', () => {
    const maskPixels = (values: readonly number[]) => ({ width: 2, height: 1,
      data: new Uint8ClampedArray(values.flatMap((value) => [value, value, value, 255])) });
    const shape: AgLayer = { name: 'Two masks', left: 0, top: 0, right: 2, bottom: 1,
      imageData: maskPixels([255, 255]), vectorFill: { type: 'color', color: { r: 255, g: 0, b: 0 } },
      vectorMask: { paths: [rectangle(0, 0, 2, 1)] },
      mask: { top: 0, left: 0, bottom: 1, right: 2, defaultColor: 0, fromVectorData: true,
        vectorMaskDensity: 0.5, userMaskDensity: 0.5, imageData: maskPixels([255, 255]) },
      realMask: { top: 0, left: 0, bottom: 1, right: 2, defaultColor: 0,
        imageData: maskPixels([255, 0]) } };
    const input: Psd = { width: 2, height: 1, children: [shape], imageData: pixels(2, 1) };
    const document = readPsdDocument(writePsdUint8Array(input, { generateThumbnail: false })).document;
    expect(cpuCompositeRegion(document, { x: 0, y: 0, width: 2, height: 1 })).toEqual(new Uint8Array([
      255, 0, 0, 255, 255, 0, 0, 127,
    ]));
  });

  it('feathers the rebuilt vector component before combining its independent user mask', () => {
    const mask = pixels(9, 5);
    for (let index = 0; index < mask.data.length; index += 4) mask.data.set([255, 255, 255, 255], index);
    const layer: AgLayer = { name: 'Feathered vector mask', left: 0, top: 0, right: 9, bottom: 5,
      imageData: mask, vectorFill: { type: 'color', color: { r: 255, g: 0, b: 0 } },
      vectorMask: { paths: [rectangle(3, 0, 6, 5)] },
      mask: { top: 0, left: 0, right: 9, bottom: 5, defaultColor: 0, fromVectorData: true,
        vectorMaskDensity: 0.5, vectorMaskFeather: 1, imageData: mask } };
    const imported = readPsdDocument(writePsdUint8Array({ width: 9, height: 5, children: [layer],
      imageData: pixels(9, 5) }, { generateThumbnail: false })).document.layers[0]!;
    const coverage = imported.mask!.raster.toPixels();
    const row = [...coverage.slice(2 * 9, 3 * 9)];
    expect(row[0]).toBe(128);
    expect(row[2]).toBeGreaterThan(128);
    expect(row[3]).toBeGreaterThan(row[2]!);
    expect(row[4]).toBeGreaterThan(row[3]!);
    expect(row).toEqual([...row].reverse());
  });
});
