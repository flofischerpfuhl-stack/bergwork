import { describe, expect, it } from 'vitest';
import { EditorSession } from '../../src/core/session';
import { Raster } from '../../src/core/raster';
import { boundingBox } from '../../src/core/geometry';
import { readArchive, writeArchive } from '../../src/io/project';

const solid = (w: number, h: number) => Raster.fromPixels(w, h, 4, new Uint8Array(w * h * 4).fill(255));
const decoder = async () => { throw new Error('no external decoding in this test'); };

function sessionWithThree() {
  const session = new EditorSession();
  session.createNewProject(300, 200, 'Align');
  const a = session.insertRaster(solid(20, 10), 'A');
  const b = session.insertRaster(solid(40, 20), 'B');
  const c = session.insertRaster(solid(10, 30), 'C');
  const move = (id: string, x: number, y: number) => session.replaceDocument({ ...session.document!,
    layers: session.document!.layers.map((l) => (l.id === id ? { ...l, transform: { ...l.transform, origin: { x, y } } } : l)) });
  move(a, 10, 50); move(b, 100, 20); move(c, 250, 120);
  return { session, a, b, c };
}
const box = (session: EditorSession, id: string) => boundingBox(session.layer(id)!.transform);

describe('align and distribute (Photoshop rules)', () => {
  it('several layers align to their common box, as one undo step', () => {
    const { session, a, b, c } = sessionWithThree();
    session.selectLayers([a, b, c], a);
    session.alignLayers('left');
    expect([box(session, a).x, box(session, b).x, box(session, c).x]).toEqual([10, 10, 10]);
    session.alignLayers('bottom');
    expect([a, b, c].map((id) => box(session, id).y + box(session, id).height)).toEqual([150, 150, 150]);
    expect(session.undo()).toBe(true);
    expect(box(session, b).y).toBe(20);
  });
  it('a single layer aligns to the canvas, or to the selection when there is one', () => {
    const { session, b } = sessionWithThree();
    session.selectLayers([b], b);
    session.alignLayers('hcenter');
    expect(box(session, b).x + box(session, b).width / 2).toBe(150);
    session.alignLayers('right');
    expect(box(session, b).x + box(session, b).width).toBe(300);
  });
  it('distributes centres and spacing between the outermost layers', () => {
    const { session, a, b, c } = sessionWithThree();
    session.selectLayers([a, b, c], a);
    session.distributeLayers('hcenters');
    const centres = [a, b, c].map((id) => box(session, id).x + box(session, id).width / 2).sort((x, y) => x - y);
    expect(Math.abs((centres[1]! - centres[0]!) - (centres[2]! - centres[1]!))).toBeLessThanOrEqual(1);
    session.distributeLayers('hspacing');
    const boxes = [a, b, c].map((id) => box(session, id)).sort((p, q) => p.x - q.x);
    const gap1 = boxes[1]!.x - (boxes[0]!.x + boxes[0]!.width), gap2 = boxes[2]!.x - (boxes[1]!.x + boxes[1]!.width);
    expect(Math.abs(gap1 - gap2)).toBeLessThanOrEqual(1);
    expect(session.canDistribute()).toBe(true);
    session.selectLayers([a, b], a);
    expect(session.canDistribute()).toBe(false);
  });
});

describe('guides', () => {
  it('are undoable, snap targets, and saved with the project', async () => {
    const session = new EditorSession();
    session.createNewProject(100, 80, 'Guides');
    const g = session.addGuide('vertical', 33.4)!;
    session.addGuide('horizontal', 50);
    expect(session.guides.map((x) => x.position)).toEqual([33, 50]);
    expect(session.transformSnapTargets(new Set()).xs).toContain(33);
    session.snapsToGuides = false;
    expect(session.transformSnapTargets(new Set()).xs).not.toContain(33);
    session.snapsToGuides = true;
    session.beginGuideDrag(); session.moveGuide(g, 40); session.moveGuide(g, 41); session.endGuideDrag();
    expect(session.guides[0]!.position).toBe(41);
    expect(session.undo()).toBe(true);
    expect(session.guides[0]!.position).toBe(33);
    expect(session.redo()).toBe(true);
    const archive = writeArchive(session.document!, 'Guides', null);
    const loaded = await readArchive(archive.blob, decoder);
    expect(loaded.document.guides?.map((x) => [x.orientation, x.position])).toEqual([['vertical', 41], ['horizontal', 50]]);
    session.guidesLocked = true;
    session.clearGuides();
    expect(session.guides).toHaveLength(2);
    session.guidesLocked = false;
    session.clearGuides();
    expect(session.guides).toHaveLength(0);
    expect(session.undo()).toBe(true);
    expect(session.guides).toHaveLength(2);
  });
});
