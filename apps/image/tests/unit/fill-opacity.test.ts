import { writePsdUint8Array, type Psd } from 'ag-psd';
import { describe, expect, it } from 'vitest';
import { compositeRegion } from '../../src/core/composite';
import { newLayer, type BlendMode, type CanvasDocument } from '../../src/core/document';
import { makeTransform } from '../../src/core/geometry';
import { Raster } from '../../src/core/raster';
import { readPsdDocument } from '../../src/io/psd';

const transform = makeTransform({ x: 0, y: 0 }, { width: 1, height: 1 }, { sampling: 'Nearest' });
const pixel = (rgba: readonly number[]) => Raster.fromPixels(1, 1, 4, new Uint8Array(rgba));

function rendered(mode: BlendMode, source: readonly number[], fillOpacity: number, opacity = 1,
  mask?: number): Uint8Array {
  const base = newLayer({ id: 'base', name: 'Base', transform, raster: pixel([64, 128, 192, 255]) });
  const top = newLayer({ id: 'top', name: 'Top', transform, raster: pixel(source), blendMode: mode,
    opacity, fillOpacity,
    ...(mask === undefined ? {} : { mask: { raster: Raster.fromPixels(1, 1, 1, new Uint8Array([mask])),
      enabled: true, placement: null, linked: true } }),
    effects: [{ kind: 'stroke', schemaVersion: 1, enabled: true, width: 3, position: 'outside',
      color: { red: 1, green: 0, blue: 0 } }],
  });
  const document: CanvasDocument = { id: 'fill', width: 1, height: 1, resolution: 72, selection: null,
    layers: [base, top] };
  return compositeRegion(document, { x: 0, y: 0, width: 1, height: 1 }).rgba;
}

describe('fill opacity compositing (Photoshop Fill)', () => {
  it('multiplies ordinary pixel coverage with opacity without changing the mask or effect data', () => {
    expect(rendered('normal', [255, 0, 0, 255], 0.5, 0.5)).toEqual(new Uint8Array([112, 96, 144, 255]));
    expect(rendered('normal', [255, 0, 0, 255], 0.5, 1, 128)).toEqual(new Uint8Array([112, 96, 144, 255]));

    const mask = Raster.fromPixels(1, 1, 1, new Uint8Array([128]));
    const top = newLayer({ id: 'top', name: 'Top', transform, raster: pixel([255, 0, 0, 255]), fillOpacity: 0,
      mask: { raster: mask, enabled: true, placement: null, linked: true },
      effects: [{ kind: 'stroke', schemaVersion: 1, enabled: true, width: 2, position: 'outside',
        color: { red: 1, green: 1, blue: 1 } }] });
    expect(top.mask?.raster).toBe(mask);
    expect(top.effects).toHaveLength(1);
  });

  it('matches calibrated 50% Fill pixels for Photoshop special-eight modes', () => {
    const expected: Readonly<Record<BlendMode, readonly number[]>> = {
      colorBurn: [51, 70, 143], linearBurn: [49, 49, 81], colorDodge: [114, 158, 205],
      linearDodge: [176, 176, 208], vividLight: [103, 110, 154], linearLight: [160, 95, 95],
      hardMix: [98, 98, 161], difference: [48, 80, 176],
    } as Partial<Record<BlendMode, readonly number[]>> as Readonly<Record<BlendMode, readonly number[]>>;
    for (const [mode, rgb] of Object.entries(expected) as [BlendMode, readonly number[]][]) {
      expect(rendered(mode, [224, 96, 32, 255], 0.5), mode).toEqual(new Uint8Array([...rgb, 255]));
    }
  });

  it('applies master opacity after the special Fill kernel', () => {
    expect(rendered('difference', [224, 96, 32, 255], 0.5, 0.5))
      .toEqual(new Uint8Array([56, 104, 184, 255]));
  });

  it('imports ag-psd fill opacity, protection bits, and layer colour labels without approximation', () => {
    const imageData = { width: 1, height: 1, data: new Uint8ClampedArray([224, 96, 32, 255]) };
    const psd: Psd = { width: 1, height: 1, imageData, children: [{
      name: 'Protected', top: 0, left: 0, right: 1, bottom: 1, imageData,
      fillOpacity: 0.4, layerColor: 'violet', transparencyProtected: true,
      protected: { composite: true, position: false, transparency: false },
    }] };
    const imported = readPsdDocument(writePsdUint8Array(psd, { generateThumbnail: false }));
    expect(imported.document.layers[0]).toMatchObject({ fillOpacity: 0.4, colorLabel: 'violet',
      locks: { transparency: true, pixels: true, position: false, all: false } });
    expect(imported.unsupported.some((feature) => feature.code === 'fill-opacity')).toBe(false);
  });
});
