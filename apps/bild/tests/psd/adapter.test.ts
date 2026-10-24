import { describe, expect, it } from 'vitest';
import { writePsdUint8Array, type Layer as AgLayer, type Psd } from 'ag-psd';
import { compositeRegion } from '../../src/core/composite';
import { PSD_BLEND_MODES, pixelDataToRgba8, readPsdDocument, SUPPORTED_PSD_BLEND_MODES } from '../../src/io/psd';
import { differenceMetrics } from './fidelity';

function pixels(values: readonly number[]): { width: number; height: number; data: Uint8ClampedArray } {
  return { width: 2, height: 1, data: new Uint8ClampedArray(values) };
}

describe('PSD reader adapter', () => {
  it('maps all 27 Photoshop blend modes', () => {
    expect(PSD_BLEND_MODES).toHaveLength(27);
    expect([...SUPPORTED_PSD_BLEND_MODES]).toEqual([...PSD_BLEND_MODES]);
  });

  it('maps ag-psd compositing order to document pixels and clipping', () => {
    const base: AgLayer = { name: 'Base', top: 0, left: 0, bottom: 1, right: 2,
      imageData: pixels([255, 0, 0, 255, 255, 0, 0, 128]) };
    const clipped: AgLayer = { name: 'Clipped', top: 0, left: 0, bottom: 1, right: 2, clipping: true,
      imageData: pixels([0, 0, 255, 255, 0, 0, 255, 255]) };
    const oracle = pixels([0, 0, 255, 255, 0, 0, 255, 128]);
    const input: Psd = { width: 2, height: 1, children: [base, clipped], imageData: oracle };
    const imported = readPsdDocument(writePsdUint8Array(input, { generateThumbnail: false }));
    expect(imported.document.layers.map((layer) => layer.name)).toEqual(['Base', 'Clipped']);
    expect(imported.document.layers[1]!.maskSourceId).toBe(imported.document.layers[0]!.id);
    const actual = compositeRegion(imported.document, { x: 0, y: 0, width: 2, height: 1 }).rgba;
    expect(actual).toEqual(new Uint8Array(oracle.data));
  });

  it('quantizes ag-psd 16/32-bit pixel buffers and computes real byte deltas', () => {
    const sixteen = pixelDataToRgba8({ width: 1, height: 1, data: new Uint16Array([0, 32_768, 65_535, 65_535]) });
    const floats = pixelDataToRgba8({ width: 1, height: 1, data: new Float32Array([-1, 0.5, 2, 1]) });
    expect(Array.from(sixteen)).toEqual([0, 128, 255, 255]);
    expect(Array.from(floats)).toEqual([0, 128, 255, 255]);
    expect(differenceMetrics(new Uint8Array([0, 10, 20, 255]), new Uint8Array([0, 12, 25, 255])))
      .toEqual({ mean: 1.75, p99: 5, maximum: 5 });
  });

  it('maps a PSD raster mask to document coverage', () => {
    const layer: AgLayer = {
      name: 'Masked', top: 0, left: 0, bottom: 1, right: 2,
      imageData: pixels([0, 255, 0, 255, 0, 255, 0, 255]),
      mask: { top: 0, left: 0, bottom: 1, right: 2, defaultColor: 0,
        imageData: pixels([255, 255, 255, 255, 0, 0, 0, 255]) },
    };
    const oracle = pixels([0, 255, 0, 255, 0, 0, 0, 0]);
    const input: Psd = { width: 2, height: 1, children: [layer], imageData: oracle };
    const imported = readPsdDocument(writePsdUint8Array(input, { generateThumbnail: false }));
    expect(imported.document.layers[0]!.mask?.raster.toPixels()).toEqual(new Uint8Array([255, 0]));
    expect(compositeRegion(imported.document, { x: 0, y: 0, width: 2, height: 1 }).rgba)
      .toEqual(new Uint8Array(oracle.data));
  });
});
