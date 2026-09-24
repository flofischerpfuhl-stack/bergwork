import { describe, expect, it } from 'vitest';
import { newLayer, type CanvasDocument } from '../../src/core/document';
import { makeTransform } from '../../src/core/geometry';
import { Raster } from '../../src/core/raster';

const transform = makeTransform({ x: 2, y: 3 }, { width: 8, height: 6 });

describe('document model v2 (PRODUCT-PLAN A2)', () => {
  it('constructs every layer as a kind-discriminated model value', () => {
    const common = (id: string, name: string) => ({ id, name, transform });
    const layers = [
      newLayer({ ...common('pixel', 'Pixel'), kind: 'pixel', raster: Raster.blank(8, 6, 4) }),
      newLayer({ ...common('group', 'Group'), kind: 'group' }),
      newLayer({ ...common('adjustment', 'Exposure'), kind: 'adjustment', adjustment: {
        kind: 'Exposure', schemaVersion: 1, exposureSettings: { exposure: 1, offset: 0, gamma: 1 },
      } }),
      newLayer({ ...common('fill', 'Fill'), kind: 'fill', fill: {
        kind: 'solid', schemaVersion: 1, color: { red: 1, green: 0.5, blue: 0 },
      } }),
      newLayer({ ...common('vector', 'Vector'), kind: 'vector', paths: [], style: { fill: null, stroke: null } }),
      newLayer({ ...common('text', 'Text'), kind: 'text', text: 'Fernwork', runs: [], box: null, alignment: 'left' }),
      newLayer({ ...common('embedded', 'Linked SVG'), kind: 'embedded', content: {
        mode: 'linked', mediaType: 'svg', uri: 'assets/logo.svg', sourceName: 'logo.svg',
      } }),
    ];
    expect(layers.map((layer) => layer.kind)).toEqual(['pixel', 'group', 'adjustment', 'fill', 'vector', 'text', 'embedded']);
    expect(layers.every((layer) => layer.fillOpacity === 1 && layer.effects.length === 0 && layer.filters.length === 0)).toBe(true);
    expect(layers[1]!.isGroup).toBe(true);
  });

  it('keeps artboards above the flat layer stack', () => {
    const document: CanvasDocument = { id: 'doc', width: 100, height: 80, resolution: 72, layers: [], selection: null,
      artboards: [{ id: 'a', name: 'Social', rect: { x: 10, y: 20, width: 50, height: 40 },
        background: { red: 1, green: 1, blue: 1, alpha: 1 }, colorLabel: 'blue' }] };
    expect(document.artboards?.[0]?.rect).toEqual({ x: 10, y: 20, width: 50, height: 40 });
  });
});
