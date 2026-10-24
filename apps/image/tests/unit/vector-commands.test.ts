import { describe, expect, it } from 'vitest';
import { newLayer, type CanvasDocument, type LayerShape } from '../../src/core/document';
import { makeTransform } from '../../src/core/geometry';
import { EditorSession } from '../../src/core/session';
import { buildManifestV2, readArchive, writeArchive } from '../../src/io/project';
import { decodePng } from '../../src/io/png';
import { addAnchor, createParametricShape, deleteAnchor, dragHandle, mergeVectorLayers, moveAnchor, setAnchorKind, setVectorMask,
  setVectorStyle, vectorBounds } from '../../src/core/vector';

const style = { schemaVersion: 1 as const, fill: { kind: 'solid' as const, schemaVersion: 1 as const,
  color: { red: 0.2, green: 0.4, blue: 0.8 } }, stroke: null };

describe('PRODUCT-PLAN A5 undoable vector commands and v2 schema', () => {
  it('creates and edits parametric shapes as individual undo steps', () => {
    const session = new EditorSession(); session.createNewProject(200, 150);
    const shape: LayerShape = { schemaVersion: 1, kind: 'Star', red: 0.2, green: 0.4, blue: 0.8,
      cornerRadius: 2, sides: 5, innerRatio: 0.5 };
    const id = createParametricShape(session, shape, { x: 10, y: 20, width: 100, height: 80 }, style)!;
    expect(session.layer(id)).toMatchObject({ kind: 'vector', sourceShape: shape });
    const created = session.layer(id)!;
    expect(created.kind === 'vector' ? created.paths[0]!.points : []).toHaveLength(20);
    expect(addAnchor(session, id, 0, 1, { x: 60, y: 4 })).toBe(true);
    expect(moveAnchor(session, id, 0, 0, { x: 50, y: 1 })).toBe(true);
    expect(setAnchorKind(session, id, 0, 0, 'smooth')).toBe(true);
    expect(dragHandle(session, id, 0, 0, 'out', { x: 60, y: 1 })).toBe(true);
    expect(deleteAnchor(session, id, 0, 1)).toBe(true);
    expect(session.undo()).toBe(true);
    const restored = session.layer(id)!;
    expect(restored.kind === 'vector' ? restored.paths[0]!.points : []).toHaveLength(21);
  });

  it('merges shapes from separate transformed layers and undoes the layer replacement', () => {
    const session = new EditorSession(); session.createNewProject(200, 150);
    const first = createParametricShape(session, { kind: 'Rectangle', red: 1, green: 0, blue: 0, cornerRadius: 0 },
      { x: 10, y: 20, width: 30, height: 20 }, style)!;
    const second = createParametricShape(session, { kind: 'Ellipse', red: 0, green: 0, blue: 1, cornerRadius: 0 },
      { x: 70, y: 50, width: 40, height: 30 }, style)!;
    const merged = mergeVectorLayers(session, [first, second])!;
    expect(session.layer(merged)).toMatchObject({ kind: 'vector', name: 'Merged Shapes', transform: {
      origin: { x: 10, y: 20 }, size: { width: 100, height: 60 },
    } });
    const mergedLayer = session.layer(merged)!;
    expect(mergedLayer.kind === 'vector' ? mergedLayer.paths : []).toHaveLength(2);
    session.undo();
    expect(session.layer(first)?.kind).toBe('vector'); expect(session.layer(second)?.kind).toBe('vector');
  });

  it('transforms a raster-free vector and keeps its editable geometry at the new size', () => {
    const session = new EditorSession(); session.createNewProject(200, 150);
    const id = createParametricShape(session, { kind: 'Polygon', red: 1, green: 0, blue: 0, cornerRadius: 0, sides: 5 },
      { x: 10, y: 20, width: 40, height: 30 }, style)!;
    expect(session.layer(id)?.raster).toBeNull();
    session.beginTransform(); expect(session.transformEdit).not.toBeNull();
    session.previewTransform({ ...session.transformEdit!.draft, size: { width: 80, height: 60 } }); session.commitTransform();
    const transformed = session.layer(id)!;
    expect(transformed.transform.size).toEqual({ width: 80, height: 60 });
    const bounds = transformed.kind === 'vector' ? vectorBounds(transformed.paths) : null;
    expect(bounds?.width).toBeCloseTo(76.084521); expect(bounds?.height).toBeCloseTo(54.27051);
    session.undo(); expect(session.layer(id)!.transform.size).toEqual({ width: 40, height: 30 });
  });

  it('round-trips the full vector style, primitive and mask properties in format v2', async () => {
    const vector = newLayer({ id: 'v', name: 'Line', kind: 'vector', transform: makeTransform({ x: 2, y: 3 }, { width: 80, height: 20 }),
      sourceShape: { schemaVersion: 1, kind: 'Line', red: 1, green: 0, blue: 0, cornerRadius: 0, lineWidth: 4 }, paths: [],
      style: { schemaVersion: 1, fill: null, stroke: { color: { red: 1, green: 0, blue: 0 }, width: 4,
        alignment: 'center', cap: 'round', join: 'miter', miterLimit: 8, dash: [8, 4], dashOffset: 1,
        startMarker: 'circle', endMarker: 'arrow', markerSize: 3 } },
      vectorMask: { schemaVersion: 1, enabled: true, inverted: false, density: 0.75, feather: 2, paths: [] } });
    const document: CanvasDocument = { id: 'd', width: 100, height: 100, resolution: 72, layers: [vector], selection: null };
    const record = buildManifestV2(document, 'Vectors', 'v').layers[0];
    expect(record?.kind).toBe('vector');
    if (record?.kind !== 'vector') throw new Error('Expected vector record');
    expect(record.sourceShape).toMatchObject({ kind: 'Line', lineWidth: 4 });
    expect(record.style.stroke).toMatchObject({ dash: [8, 4], endMarker: 'arrow' });
    expect(record.vectorMask).toMatchObject({ density: 0.75, feather: 2 });
    const archive = writeArchive(document, 'Vectors', 'v');
    const loaded = await readArchive(archive.blob, async (bytes) => {
      const png = decodePng(bytes); return { width: png.width, height: png.height, channels: png.channels, data: png.data };
    });
    const restored = loaded.document.layers[0];
    expect(restored?.kind).toBe('vector');
    if (restored?.kind !== 'vector') throw new Error('Expected restored vector layer');
    expect(restored.sourceShape).toMatchObject({ kind: 'Line', lineWidth: 4 });
    expect(restored.style.stroke).toMatchObject({ dash: [8, 4], startMarker: 'circle', endMarker: 'arrow' });
    expect(restored.vectorMask).toMatchObject({ density: 0.75, feather: 2 });
  });

  it('style and vector-mask commands are undoable', () => {
    const session = new EditorSession(); session.createNewProject(30, 30);
    const id = createParametricShape(session, { kind: 'Rectangle', red: 1, green: 0, blue: 0, cornerRadius: 0 },
      { x: 0, y: 0, width: 20, height: 20 }, style)!;
    expect(setVectorStyle(session, id, { ...style, fill: null })).toBe(true);
    expect(setVectorMask(session, id, { enabled: true, inverted: false, paths: [] })).toBe(true);
    expect(session.layer(id)!.vectorMask).toMatchObject({ schemaVersion: 1, density: 1, feather: 0 });
    session.undo(); expect(session.layer(id)!.vectorMask).toBeNull();
  });
});
