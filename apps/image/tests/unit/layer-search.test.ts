import { describe, expect, it } from 'vitest';
import { newLayer, type CanvasDocument, type LayerLocks, type NewLayerFields } from '../../src/core/document';
import { makeTransform } from '../../src/core/geometry';
import { filterLayers } from '../../src/core/layerSearch';

const transform = makeTransform({ x: 0, y: 0 }, { width: 1, height: 1 });
const unlocked: LayerLocks = { transparency: false, pixels: false, position: false, all: false };
const item = (id: string, name: string, parentId: string | null,
  extra: Partial<Omit<NewLayerFields, 'id' | 'name' | 'transform' | 'parentId'>> = {}) =>
  newLayer({ id, name, parentId, transform, ...extra });

const document: CanvasDocument = { id: 'search', width: 10, height: 10, resolution: 72, selection: null, layers: [
  item('campaign', 'Kampagne', null, { kind: 'group', locks: { ...unlocked, position: true } }),
  item('hero', 'Übergrößes Café', 'campaign', { colorLabel: 'red', blendMode: 'multiply' }),
  item('hidden', 'Hintergrund', 'campaign', { visible: false, colorLabel: 'blue' }),
  item('logo', 'Logo', null, { kind: 'vector', colorLabel: 'red', blendMode: 'screen' }),
] };

describe('layer panel search (PRODUCT-PLAN P10)', () => {
  it('matches names case- and accent-insensitively and returns required ancestors', () => {
    const result = filterLayers(document, { text: 'UBERGROSSES CAFE' });
    expect([...result.matchingIds]).toEqual(['hero']);
    expect([...result.ancestorIds]).toEqual(['campaign']);
  });

  it('combines kind, label, visibility, blend-mode, and effective-lock filters', () => {
    const red = filterLayers(document, { labels: ['red'], blendModes: new Set(['multiply', 'screen']) });
    expect([...red.matchingIds]).toEqual(['hero', 'logo']);
    const vectors = filterLayers(document, { kinds: ['vector'], visible: true, locked: false });
    expect([...vectors.matchingIds]).toEqual(['logo']);
    const inheritedLocked = filterLayers(document, { locked: true });
    expect([...inheritedLocked.matchingIds]).toEqual(['campaign', 'hero', 'hidden']);
  });

  it('does not mutate the document or conflate matches with tree ancestors', () => {
    const before = document.layers.slice();
    const result = filterLayers(document, { text: 'hinter' });
    expect([...result.matchingIds]).toEqual(['hidden']);
    expect(result.matchingIds.has('campaign')).toBe(false);
    expect(result.ancestorIds.has('campaign')).toBe(true);
    expect(document.layers).toEqual(before);
  });
});
