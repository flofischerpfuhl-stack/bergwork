import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { ProjectManifestV2 } from '../../contracts-v2';
import { makeTransform } from '../../src/core/geometry';
import { readArchive } from '../../src/io/project';

const transform = makeTransform({ x: 0, y: 0 }, { width: 16, height: 12 });
const common = (id: string, name: string) => ({
  id, parentId: null, name, visible: true, opacity: 1, fillOpacity: 1, blendMode: 'normal',
  locks: { transparency: false, pixels: false, position: false, all: false }, colorLabel: 'none' as const,
  transform, warp: null, crop: null, mask: null, vectorMask: null, clippedTo: null, effects: [], filters: [],
});

describe('strict model migration', () => {
  it('loads a v2 archive written before the strict in-memory model change', async () => {
    const manifest: ProjectManifestV2 = {
      format: 'fernwork-image', version: 2, id: 'pre-strict-v2', name: 'Pre-strict fixture', width: 16, height: 12,
      resolution: 72, colorSpace: 'srgb', activeLayerId: 'adjustment', artboards: [], assets: [],
      layers: [
        { ...common('group', 'Folder'), kind: 'group' },
        { ...common('adjustment', 'Exposure'), parentId: 'group', kind: 'adjustment', adjustment: {
          kind: 'Exposure', schemaVersion: 1, parameters: { exposure: 1.25, offset: 0.1, gamma: 0.9 },
        } },
      ],
    };
    const bytes = zipSync({ 'manifest.json': new TextEncoder().encode(JSON.stringify(manifest)) });
    const loaded = await readArchive(new Blob([bytes as BlobPart]), async () => {
      throw new Error('The fixture has no image assets.');
    });

    expect(loaded.document.layers[0]).toMatchObject({ kind: 'group', parentId: null });
    expect('isGroup' in loaded.document.layers[0]!).toBe(false);
    const adjustment = loaded.document.layers[1]!;
    expect(adjustment.kind).toBe('adjustment');
    if (adjustment.kind !== 'adjustment') throw new Error('Expected adjustment layer');
    expect(adjustment.adjustment).toEqual({ kind: 'Exposure', schemaVersion: 1,
      parameters: { exposure: 1.25, offset: 0.1, gamma: 0.9 } });
    expect('raster' in adjustment).toBe(false);
  });
});
