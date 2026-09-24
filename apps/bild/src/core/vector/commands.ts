import type { TextEngine } from '../../text';
import { MAX_LAYERS, newLayer, type FillParameters, type LayerShape, type VectorMask, type VectorPath, type VectorStyle } from '../document';
import { apply, makeTransform, pixelToDocument, type Point, type Rect } from '../geometry';
import { uuid } from '../ids';
import { Raster } from '../raster';
import type { EditorSession } from '../session';
import { primitivePaths } from './primitives';
import { booleanPaths, type VectorBooleanOperation } from './operations';
import { renderVector } from './render';
import { vectorBounds } from './path';

const liveEdits = new WeakMap<EditorSession, { document: NonNullable<EditorSession['document']>; layerId: string }>();

export function beginVectorLiveEdit(session: EditorSession, layerId: string, name = 'Edit Vector'): boolean {
  if (liveEdits.has(session) || !session.document || session.layer(layerId)?.kind !== 'vector') return false;
  liveEdits.set(session, { document: session.document, layerId }); session.beginEdit(name); return true;
}

export function finishVectorLiveEdit(session: EditorSession): boolean {
  if (!liveEdits.delete(session)) return false;
  session.endEdit(); return true;
}

export function cancelVectorLiveEdit(session: EditorSession): boolean {
  const edit = liveEdits.get(session); if (!edit) return false;
  liveEdits.delete(session); session.replaceDocument(edit.document); session.endEdit(); return true;
}

function replaceLayer(session: EditorSession, id: string, update: (layer: NonNullable<ReturnType<EditorSession['layer']>>) => NonNullable<ReturnType<EditorSession['layer']>>): boolean {
  const document = session.document, current = session.layer(id);
  if (!document || !current) return false;
  session.replaceDocument({ ...document, layers: document.layers.map((layer) => layer.id === id ? update(current) : layer) });
  return true;
}

export function createParametricShape(session: EditorSession, shape: LayerShape, rect: Rect, style: VectorStyle): string | null {
  const document = session.document;
  if (!document || !session.canEditLayers || !(rect.width > 0 && rect.height > 0) || document.layers.length >= MAX_LAYERS) return null;
  const sourceShape: LayerShape = shape.kind === 'Polygon' ? { ...shape, schemaVersion: 1, sides: shape.sides ?? 3 }
    : shape.kind === 'Star' ? { ...shape, schemaVersion: 1, sides: shape.sides ?? 5, innerRatio: shape.innerRatio ?? 0.5 }
      : shape.kind === 'Line' ? { ...shape, schemaVersion: 1, lineWidth: shape.lineWidth ?? style.stroke?.width ?? 1 }
        : { ...shape, schemaVersion: 1 };
  const id = uuid(), active = session.activeLayer;
  const layer = newLayer({ id, name: sourceShape.kind, kind: 'vector', raster: null, sourceShape,
    paths: primitivePaths(sourceShape, rect.width, rect.height), style: { ...style, schemaVersion: 1 },
    transform: makeTransform({ x: rect.x, y: rect.y }, { width: rect.width, height: rect.height }, { sampling: 'High quality' }),
    parentId: active?.kind === 'group' ? active.id : active?.parentId ?? null });
  session.edit(`Create ${sourceShape.kind}`, () => {
    const layers = session.document!.layers.slice(), index = layers.findIndex((value) => value.id === session.activeLayerId);
    layers.splice(index < 0 ? layers.length : index + 1, 0, layer);
    session.replaceDocument({ ...session.document!, layers }); session.setActiveLayer(id);
  });
  return id;
}

export function createPathLayer(session: EditorSession, paths: readonly VectorPath[], style: VectorStyle,
  transform: ReturnType<typeof makeTransform>, name = 'Path'): string | null {
  const document = session.document;
  if (!document || !session.canEditLayers || document.layers.length >= MAX_LAYERS) return null;
  const id = uuid(), active = session.activeLayer;
  const layer = newLayer({ id, name, kind: 'vector', raster: null, sourceShape: null, paths,
    style: { ...style, schemaVersion: 1 }, transform,
    parentId: active?.kind === 'group' ? active.id : active?.parentId ?? null });
  session.edit('Create Path', () => {
    const layers = session.document!.layers.slice(), index = layers.findIndex((value) => value.id === session.activeLayerId);
    layers.splice(index < 0 ? layers.length : index + 1, 0, layer);
    session.replaceDocument({ ...session.document!, layers }); session.setActiveLayer(id);
  });
  return id;
}

export function editVectorPaths(session: EditorSession, layerId: string, paths: readonly VectorPath[], name = 'Edit Path'): boolean {
  const layer = session.layer(layerId);
  if (layer?.kind !== 'vector' || session.refuseLayerEdit(layerId, 'pixels')) return false;
  session.edit(name, () => replaceLayer(session, layerId, (value) => value.kind === 'vector' ? { ...value, paths, sourceShape: null, raster: null } : value));
  return true;
}

export function moveAnchor(session: EditorSession, layerId: string, pathIndex: number, pointIndex: number, position: Point): boolean {
  const layer = session.layer(layerId); if (layer?.kind !== 'vector') return false;
  const path = layer.paths[pathIndex], old = path?.points[pointIndex]; if (!path || !old) return false;
  const dx = position.x - old.anchor.x, dy = position.y - old.anchor.y, points = path.points.slice();
  points[pointIndex] = { ...old, anchor: position, in: { x: old.in.x + dx, y: old.in.y + dy }, out: { x: old.out.x + dx, y: old.out.y + dy } };
  const paths = layer.paths.slice(); paths[pathIndex] = { ...path, points };
  return editVectorPaths(session, layerId, paths, 'Move Anchor');
}

export function addAnchor(session: EditorSession, layerId: string, pathIndex: number, pointIndex: number, anchor: Point): boolean {
  const layer = session.layer(layerId); if (layer?.kind !== 'vector') return false;
  const path = layer.paths[pathIndex]; if (!path || pointIndex < 0 || pointIndex > path.points.length) return false;
  const points = path.points.slice(); points.splice(pointIndex, 0, { anchor, in: anchor, out: anchor, kind: 'corner' });
  const paths = layer.paths.slice(); paths[pathIndex] = { ...path, points };
  return editVectorPaths(session, layerId, paths, 'Add Anchor');
}

export function deleteAnchor(session: EditorSession, layerId: string, pathIndex: number, pointIndex: number): boolean {
  const layer = session.layer(layerId); if (layer?.kind !== 'vector') return false;
  const path = layer.paths[pathIndex]; if (!path?.points[pointIndex]) return false;
  const paths = layer.paths.slice(), points = path.points.filter((_, index) => index !== pointIndex);
  if (points.length < (path.closed ? 3 : 2)) paths.splice(pathIndex, 1); else paths[pathIndex] = { ...path, points };
  return editVectorPaths(session, layerId, paths, 'Delete Anchor');
}

export function setAnchorKind(session: EditorSession, layerId: string, pathIndex: number, pointIndex: number,
  kind: 'corner' | 'smooth'): boolean {
  const layer = session.layer(layerId); if (layer?.kind !== 'vector') return false;
  const path = layer.paths[pathIndex], point = path?.points[pointIndex]; if (!path || !point) return false;
  const points = path.points.slice(); points[pointIndex] = { ...point, kind }; const paths = layer.paths.slice(); paths[pathIndex] = { ...path, points };
  return editVectorPaths(session, layerId, paths, 'Convert Point');
}

export function dragHandle(session: EditorSession, layerId: string, pathIndex: number, pointIndex: number,
  handle: 'in' | 'out', position: Point, live = false): boolean {
  const layer = session.layer(layerId); if (layer?.kind !== 'vector') return false;
  if (session.refuseLayerEdit(layerId, 'pixels')) return false;
  const path = layer.paths[pathIndex], point = path?.points[pointIndex]; if (!path || !point) return false;
  let updated = { ...point, [handle]: position };
  if ((point.kind ?? 'corner') === 'smooth') {
    const opposite = handle === 'in' ? 'out' : 'in', length = Math.hypot(point[opposite].x - point.anchor.x, point[opposite].y - point.anchor.y);
    const dx = position.x - point.anchor.x, dy = position.y - point.anchor.y, d = Math.max(1e-12, Math.hypot(dx, dy));
    updated = { ...updated, [opposite]: { x: point.anchor.x - dx / d * length, y: point.anchor.y - dy / d * length } };
  }
  const points = path.points.slice(); points[pointIndex] = updated; const paths = layer.paths.slice(); paths[pathIndex] = { ...path, points };
  if (live) {
    const current = liveEdits.get(session);
    if ((current && current.layerId !== layerId) || (!current && !beginVectorLiveEdit(session, layerId, 'Drag Handle'))) return false;
    const changed = replaceLayer(session, layerId, (value) => value.kind === 'vector' ? { ...value, paths, sourceShape: null, raster: null } : value);
    if (changed) session.notify('document'); return changed;
  }
  return editVectorPaths(session, layerId, paths, 'Drag Handle');
}

export function setVectorStyle(session: EditorSession, layerId: string, style: VectorStyle, live = false): boolean {
  if (session.layer(layerId)?.kind !== 'vector' || session.refuseLayerEdit(layerId, 'appearance')) return false;
  const change = () => replaceLayer(session, layerId, (layer) => layer.kind === 'vector'
    ? { ...layer, style: { ...style, schemaVersion: 1 as const }, raster: null } : layer);
  if (live) {
    const current = liveEdits.get(session);
    if ((current && current.layerId !== layerId) || (!current && !beginVectorLiveEdit(session, layerId, 'Set Vector Style'))) return false;
    const changed = change(); if (changed) session.notify('document'); return changed;
  }
  session.edit('Set Vector Style', change); return true;
}

export function applyBoolean(session: EditorSession, engine: TextEngine, layerId: string, first: readonly VectorPath[],
  second: readonly VectorPath[], operation: VectorBooleanOperation): boolean {
  return editVectorPaths(session, layerId, booleanPaths(engine, first, second, operation), 'Boolean Path Operation');
}

function mappedPath(path: VectorPath, map: ReturnType<typeof pixelToDocument>): VectorPath {
  return { ...path, points: path.points.map((point) => ({ ...point, anchor: apply(map, point.anchor),
    in: apply(map, point.in), out: apply(map, point.out) })) };
}

/** Merges vector layers in document space. The bottom-most selected layer supplies the one layer-wide style. */
export function mergeVectorLayers(session: EditorSession, layerIds: readonly string[], name = 'Merged Shapes'): string | null {
  const document = session.document, wanted = new Set(layerIds);
  if (!document || wanted.size < 2) return null;
  const layers = document.layers.filter((layer) => wanted.has(layer.id));
  if (layers.length !== wanted.size || layers.some((layer) => layer.kind !== 'vector')) return null;
  const vectors = layers.filter((layer) => layer.kind === 'vector'), documentPaths = vectors.flatMap((layer) => {
    const map = pixelToDocument(layer.transform, layer.transform.size.width, layer.transform.size.height);
    return layer.paths.map((path) => mappedPath(path, map));
  });
  const bounds = vectorBounds(documentPaths); if (!bounds) return null;
  const paths = documentPaths.map((path) => ({ ...path, points: path.points.map((point) => ({ ...point,
    anchor: { x: point.anchor.x - bounds.x, y: point.anchor.y - bounds.y },
    in: { x: point.in.x - bounds.x, y: point.in.y - bounds.y }, out: { x: point.out.x - bounds.x, y: point.out.y - bounds.y } })) }));
  const base = vectors[0]!, id = uuid(), firstIndex = document.layers.findIndex((layer) => wanted.has(layer.id));
  const merged = newLayer({ ...base, id, name, paths, sourceShape: null, raster: null,
    transform: makeTransform({ x: bounds.x, y: bounds.y }, { width: Math.max(1, bounds.width), height: Math.max(1, bounds.height) },
      { sampling: 'High quality' }) });
  session.edit('Merge Shapes', () => {
    const next = session.document!.layers.filter((layer) => !wanted.has(layer.id));
    next.splice(Math.max(0, firstIndex), 0, merged); session.replaceDocument({ ...session.document!, layers: next }); session.setActiveLayer(id);
  });
  return id;
}

export function setVectorMask(session: EditorSession, layerId: string, mask: VectorMask | null): boolean {
  if (!session.layer(layerId) || session.refuseLayerEdit(layerId, 'appearance')) return false;
  session.edit(mask ? 'Add Vector Mask' : 'Remove Vector Mask', () => replaceLayer(session, layerId,
    (layer) => ({ ...layer, vectorMask: mask ? { ...mask, schemaVersion: 1,
      density: Math.max(0, Math.min(1, mask.density ?? 1)), feather: Math.max(0, Math.min(10_000, mask.feather ?? 0)) } : null })));
  return true;
}

export function rasterizeVectorLayer(session: EditorSession, engine: TextEngine, layerId: string, scale = 1): boolean {
  const layer = session.layer(layerId); if (layer?.kind !== 'vector' || session.refuseLayerEdit(layerId, 'pixels')) return false;
  const raster = renderVector(engine, layer.paths, layer.style, layer.transform.size.width, layer.transform.size.height, scale);
  session.edit('Rasterize Vector Layer', () => replaceLayer(session, layerId, (value) => value.kind === 'vector'
    ? newLayer({ ...value, kind: 'pixel', raster, sourceShape: undefined, paths: undefined, style: undefined }) : value));
  return true;
}

export function paintVectorToRaster(base: Raster, engine: TextEngine, paths: readonly VectorPath[], style: VectorStyle): Raster {
  if (base.channels !== 4) throw new RangeError('Vector paint requires an RGBA raster');
  const top = renderVector(engine, paths, style, base.width, base.height).toPixels(), bottom = base.toPixelsNative();
  const maximum = base.maximum, output = base.format === 'rgba16' ? new Uint16Array(bottom.length) : new Uint8Array(bottom.length);
  for (let i = 0; i < bottom.length; i += 4) {
    const sa = top[i + 3]! / 255, da = bottom[i + 3]! / maximum, a = sa + da * (1 - sa);
    output[i + 3] = Math.round(a * maximum);
    if (!a) continue;
    for (let channel = 0; channel < 3; channel++) {
      output[i + channel] = Math.round((top[i + channel]! / 255 * sa + bottom[i + channel]! / maximum * da * (1 - sa)) / a * maximum);
    }
  }
  return Raster.fromPixels(base.width, base.height, 4, output, { format: base.format });
}

export function paintPathOnPixelLayer(session: EditorSession, engine: TextEngine, layerId: string,
  paths: readonly VectorPath[], style: VectorStyle): boolean {
  const layer = session.layer(layerId);
  if (layer?.kind !== 'pixel' || !layer.raster || session.refuseLayerEdit(layerId, 'pixels')) return false;
  const raster = paintVectorToRaster(layer.raster, engine, paths, style);
  session.edit('Paint Vector Path', () => replaceLayer(session, layerId,
    (value) => value.kind === 'pixel' ? { ...value, raster } : value));
  return true;
}

export function solidVectorStyle(fill: FillParameters): VectorStyle { return { schemaVersion: 1, fill, stroke: null }; }
