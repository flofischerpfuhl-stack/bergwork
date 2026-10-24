import { describe, expect, it } from 'vitest';
import { newLayer, type Artboard, type CanvasDocument, type Layer } from '../../src/core/document';
import { makeTransform } from '../../src/core/geometry';
import { Raster } from '../../src/core/raster';
import { EditorSession } from '../../src/core/session';
import { groupRowsByArtboard, resizedRect, toggleArtboardCollapsed } from '../../src/ui/artboardState';

function pixel(id: string, x: number, y: number, size = 10, parentId: string | null = null): Layer {
  const data = new Uint8Array(size * size * 4).fill(255);
  return newLayer({ id, name: id, raster: Raster.fromPixels(size, size, 4, data), transform: makeTransform({ x, y }, { width: size, height: size }), parentId });
}
const board = (id: string, x: number): Artboard => ({ id, name: id, rect: { x, y: 0, width: 100, height: 100 }, background: { red: 1, green: 1, blue: 1, alpha: 1 }, colorLabel: 'none' });

function session(layers: Layer[], artboards: Artboard[]): EditorSession {
  const document: CanvasDocument = { id: 'd', width: 400, height: 100, resolution: 72, layers, artboards, selection: null };
  const s = new EditorSession();
  s.installProject(document, null, 'Test');
  return s;
}

const outline = (s: EditorSession) => groupRowsByArtboard(s, s.layerRows).map((row) => (row.kind === 'artboard' ? `[${row.artboard.id}:${row.count}]` : `${'  '.repeat(row.entry.depth)}${row.entry.layer.id}`));

describe('Layers panel grouping by artboard', () => {
  it('shows each artboard where its topmost member is, members indented, loose layers in place', () => {
    const folder = newLayer({ id: 'folder', name: 'folder', kind: 'group', transform: makeTransform({ x: 0, y: 0 }, { width: 1, height: 1 }) });
    const s = session([pixel('a1', 10, 10), folder, pixel('in-folder', 20, 20, 10, 'folder'), pixel('loose', 250, 10), pixel('b1', 120, 10), pixel('a2', 50, 50)],
      [board('A', 0), board('B', 110), board('Empty', 300)]);
    expect(outline(s)).toEqual(['[Empty:0]', '[A:4]', '  a2', '  folder', '    in-folder', '  a1', '[B:1]', '  b1', 'loose']);
    toggleArtboardCollapsed(s, 'A');
    expect(outline(s)).toEqual(['[Empty:0]', '[A:4]', '[B:1]', '  b1', 'loose']);
  });
  it('leaves the rows alone without artboards', () => {
    const s = session([pixel('x', 0, 0), pixel('y', 5, 5)], []);
    expect(outline(s)).toEqual(['y', 'x']);
  });
});

describe('artboard handle resizing', () => {
  const origin = { x: 100, y: 100, width: 200, height: 100 };
  it('moves only the dragged edges and never flips or leaves the canvas origin', () => {
    expect(resizedRect(origin, 4, 50, 20, false)).toEqual({ x: 100, y: 100, width: 250, height: 120 });
    expect(resizedRect(origin, 7, -30, 999, false)).toEqual({ x: 70, y: 100, width: 230, height: 100 });
    expect(resizedRect(origin, 0, 500, 500, false)).toEqual({ x: 299, y: 199, width: 1, height: 1 });
    expect(resizedRect(origin, 0, -500, -500, false)).toEqual({ x: 0, y: 0, width: 300, height: 200 });
  });
  it('keeps the aspect ratio on corners with Shift', () => {
    expect(resizedRect(origin, 4, 200, 0, true)).toEqual({ x: 100, y: 100, width: 400, height: 200 });
    expect(resizedRect(origin, 0, -100, 0, true)).toEqual({ x: 0, y: 50, width: 300, height: 150 });
  });
});
