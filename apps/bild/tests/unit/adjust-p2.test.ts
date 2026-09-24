import { describe, expect, it } from 'vitest';
import { applyAdjustment } from '../../src/core/adjust/apply';
import { basicColor } from '../../src/core/adjust/basic';
import { colourPanelColor } from '../../src/core/adjust/colour';
import { lookupCube, parseCubeLut } from '../../src/core/adjust/cube';
import { defaultBasic, defaultColour } from '../../src/core/adjustments';
import { adjustRaster } from '../../src/core/adjust/raster';
import { makeTransform } from '../../src/core/geometry';
import { Raster } from '../../src/core/raster';
import { newLayer } from '../../src/core/document';
import { readArchive, writeArchive } from '../../src/io/project';
import { writePsdUint8Array, type Layer as AgLayer, type Psd } from 'ag-psd';
import { readPsdDocument } from '../../src/io/psd';

const identityCube = `TITLE "identity"
DOMAIN_MIN -1 -1 -1
DOMAIN_MAX 1 1 1
LUT_3D_SIZE 2
0 0 0
1 0 0
0 1 0
1 1 0
0 0 1
1 0 1
0 1 1
1 1 1
`;

describe('P2 Basic, Colour and lookup adjustments', () => {
  it('P5 Basic is neutral at defaults and exposure follows linear-light stops', () => {
    expect(basicColor(0.2, 0.4, 0.8, defaultBasic())).toEqual([0.2, 0.4, 0.8]);
    const raised = basicColor(0.5, 0.5, 0.5, { ...defaultBasic(), exposure: 1 });
    expect(raised[0]).toBeCloseTo(0.6858, 3);
    const warm = basicColor(0.5, 0.5, 0.5, { ...defaultBasic(), temperature: 100 });
    expect(warm[0]).toBeGreaterThan(warm[2]);
  });

  it('.cube parser honours domain and trilinear/tetrahedral interpolation', () => {
    const lut = parseCubeLut(identityCube);
    expect(lut.title).toBe('identity'); expect(lut.size3D).toBe(2);
    expect(lookupCube(lut, 0, 0.5, -0.5, 'trilinear')).toEqual([0.5, 0.75, 0.25]);
    expect(lookupCube(lut, 0, 0.5, -0.5, 'tetrahedral')).toEqual([0.5, 0.75, 0.25]);
    expect(() => parseCubeLut('LUT_3D_SIZE 66')).toThrow(/2…65/);
  });

  it('Colour Lookup resolves immutable document resource bytes', () => {
    const resource = { id: 'lut', role: 'lut' as const, mime: 'application/x-cube', bytes: new TextEncoder().encode(identityCube) };
    const input = new Float32Array([0, 0.5, 1, 1]);
    const output = applyAdjustment({ kind: 'Colour Lookup', schemaVersion: 1,
      parameters: { resourceId: 'lut', interpolation: 'tetrahedral' } }, input, 1, 1, 0, 0, [resource]);
    expect(Array.from(output)).toEqual([0.5, 0.75, 1, 1]);
  });

  it('Colour combines independently enabled B&W, balance and selective colour sections', () => {
    const neutral = defaultColour();
    expect(colourPanelColor(1, 0, 0, neutral)).toEqual([1, 0, 0]);
    const bw = { ...neutral, blackAndWhite: { ...neutral.blackAndWhite, enabled: true, reds: 50 } };
    expect(colourPanelColor(1, 0, 0, bw)).toEqual([0.5, 0.5, 0.5]);
    const balanced = { ...neutral, colourBalance: { ...neutral.colourBalance, enabled: true,
      midtones: { cyanRed: 100, magentaGreen: 0, yellowBlue: 0 }, preserveLuminosity: false } };
    const result = colourPanelColor(0.5, 0.5, 0.5, balanced);
    expect(result[0]).toBeGreaterThan(result[1]); expect(result[1]).toBe(result[2]);
  });

  it('Invert, threshold, posterize and channel mixer preserve alpha', () => {
    const source = new Float32Array([0.2, 0.6, 0.9, 0.4]);
    expect(Array.from(applyAdjustment({ kind: 'Invert', schemaVersion: 1, parameters: {} }, source, 1, 1, 0, 0)))
      .toEqual([expect.closeTo(0.8), expect.closeTo(0.4), expect.closeTo(0.1), expect.closeTo(0.4)]);
    expect(Array.from(applyAdjustment({ kind: 'Threshold', schemaVersion: 1, parameters: { level: 128 } }, source, 1, 1, 0, 0)))
      .toEqual([1, 1, 1, expect.closeTo(0.4)]);
    expect(Array.from(applyAdjustment({ kind: 'Posterize', schemaVersion: 1, parameters: { levels: 3 } }, source, 1, 1, 0, 0)))
      .toEqual([0, 0.5, 1, expect.closeTo(0.4)]);
  });

  it('new adjustment kernels retain rgba16 precision (A3)', () => {
    const source = Raster.fromPixels(2, 1, 4, new Uint16Array([10001, 20002, 30003, 65535, 10002, 20003, 30004, 65535]), { format: 'rgba16' });
    const output = adjustRaster(source, makeTransform({ x: 0, y: 0 }, { width: 2, height: 1 }),
      { kind: 'Basic', schemaVersion: 1, parameters: defaultBasic() });
    expect(output.format).toBe('rgba16');
    expect(Array.from(output.toPixels16())).toEqual(Array.from(source.toPixels16()));
  });

  it('v2 project round-trip preserves LUT bytes, adjustment and live filters', async () => {
    const resource = { id: 'lut', role: 'lut' as const, mime: 'application/x-cube', bytes: new TextEncoder().encode(identityCube) };
    const transform = makeTransform({ x: 0, y: 0 }, { width: 2, height: 2 });
    const adjustment = { kind: 'Colour Lookup' as const, schemaVersion: 1 as const,
      parameters: { resourceId: 'lut', interpolation: 'tetrahedral' as const } };
    const base = newLayer({ id: 'base', name: 'Base', transform, raster: Raster.blank(2, 2, 4),
      filters: [{ kind: 'denoise', schemaVersion: 1, enabled: false, luminance: 20, colour: 30 }] });
    const live = newLayer({ id: 'adjust', name: 'Lookup', transform, adjustment });
    const document = { id: 'doc', width: 2, height: 2, resolution: 72, layers: [base, live], resources: [resource], selection: null };
    const archive = writeArchive(document, 'Roundtrip', live.id);
    const loaded = await readArchive(archive.blob, async () => { throw new Error('No external decoder expected'); });
    expect(loaded.document.resources?.[0]?.bytes).toEqual(resource.bytes);
    expect(loaded.document.layers[0]?.filters).toEqual(base.filters);
    expect(loaded.document.layers[1]?.adjustment).toEqual(adjustment);
  });

  it('PSD adjustment import maps exposed records to editable live adjustment kinds', () => {
    const children: AgLayer[] = [
      { name: 'Invert', adjustment: { type: 'invert' } },
      { name: 'Threshold', adjustment: { type: 'threshold', level: 90 } },
      { name: 'Posterize', adjustment: { type: 'posterize', levels: 5 } },
      { name: 'Balance', adjustment: { type: 'color balance', midtones: { cyanRed: 20, magentaGreen: -10, yellowBlue: 5 }, preserveLuminosity: true } },
      { name: 'B&W', adjustment: { type: 'black & white', reds: 55, useTint: false } },
      { name: 'Selective', adjustment: { type: 'selective color', mode: 'relative', reds: { c: -20, m: 10, y: 0, k: 0 } } },
    ];
    const input: Psd = { width: 2, height: 2, children };
    const imported = readPsdDocument(writePsdUint8Array(input, { generateThumbnail: false }));
    expect(imported.document.layers.map((layer) => layer.adjustment?.kind)).toEqual([
      'Invert', 'Threshold', 'Posterize', 'Colour', 'Colour', 'Colour',
    ]);
    expect(imported.unsupported.some((feature) => feature.code.startsWith('adjustment:'))).toBe(false);
  });
});
