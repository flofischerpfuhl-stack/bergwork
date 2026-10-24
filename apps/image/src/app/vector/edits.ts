/**
 * Vector edits behind the tools, the context bar and the menus. Paths live in layer units (the layer box); the tools
 * work in document pixels and map through the layer's placement. Every gesture or committed field value is one undo
 * step: drags and slider moves run inside one open transaction (`LiveEdit`), like the engine's live variants.
 */

import { MAX_LAYERS, newLayer, uniqueName, type CanvasDocument, type Layer, type LayerShape, type VectorMask, type VectorPath,
  type VectorStyle } from '../../core/document';
import { apply, invert, makeTransform, pixelToDocument, type Affine, type LayerTransform, type Point, type Rect } from '../../core/geometry';
import { uuid } from '../../core/ids';
import { noteColorUsed } from '../../core/color/recent';
import type { EditorSession } from '../../core/session';
import { applySelection } from '../../core/selectionCommands';
import { Raster } from '../../core/raster';
import type { TextEngine } from '../../text';
import { booleanPaths, combinePathSets, paintVectorToRaster, pathsToSelection, primitivePaths, vectorBounds,
  type VectorBooleanOperation } from '../../core/vector';
import { vectorState, type PathOperation, type PathTarget } from './state';

// MARK: Geometry

export function layerToDocument(layer: Layer): Affine {
  return pixelToDocument(layer.transform, layer.transform.size.width, layer.transform.size.height);
}

export function mapPaths(paths: readonly VectorPath[], map: Affine): VectorPath[] {
  return paths.map((path) => ({ ...path, points: path.points.map((point) => ({ ...point,
    anchor: apply(map, point.anchor), in: apply(map, point.in), out: apply(map, point.out) })) }));
}

export function translatePaths(paths: readonly VectorPath[], dx: number, dy: number): VectorPath[] {
  return mapPaths(paths, { a: 1, b: 0, c: 0, d: 1, tx: dx, ty: dy });
}

/** Paths in document pixels. */
export function documentPaths(layer: Layer, mask = false): VectorPath[] {
  const paths = mask ? layer.vectorMask?.paths ?? [] : layer.kind === 'vector' ? layer.paths : [];
  return mapPaths(paths, layerToDocument(layer));
}

/** A box with at least one pixel on each side around the paths (lines have no height). */
function pathBox(paths: readonly VectorPath[]): Rect | null {
  const bounds = vectorBounds(paths);
  if (!bounds) return null;
  let { x, y, width, height } = bounds;
  if (width < 1) { x -= (1 - width) / 2; width = 1; }
  if (height < 1) { y -= (1 - height) / 2; height = 1; }
  return { x, y, width, height };
}

/** Document-space paths as layer paths plus the axis-aligned placement that fits them. */
export function fitDocumentPaths(paths: readonly VectorPath[]): { paths: VectorPath[]; transform: LayerTransform } | null {
  const box = pathBox(paths);
  if (!box) return null;
  return { paths: translatePaths(paths, -box.x, -box.y), transform: makeTransform({ x: box.x, y: box.y }, { width: box.width, height: box.height }) };
}

/**
 * A vector layer with new layer paths: the box follows the paths (Photoshop's shape bounds), keeping rotation and
 * flips, so strokes and anchors dragged outside are never cut off.
 */
export function withLayerPaths(layer: Layer, paths: readonly VectorPath[], keepShape = false): Layer {
  if (layer.kind !== 'vector') return layer;
  const box = pathBox(paths);
  if (!box) return { ...layer, paths, sourceShape: keepShape ? layer.sourceShape : null, raster: null };
  const size = layer.transform.size;
  const same = Math.abs(box.x) < 1e-9 && Math.abs(box.y) < 1e-9 && Math.abs(box.width - size.width) < 1e-9 && Math.abs(box.height - size.height) < 1e-9;
  if (same) return { ...layer, paths, sourceShape: keepShape ? layer.sourceShape : null, raster: null };
  const center = apply(layerToDocument(layer), { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  const transform = { ...layer.transform, origin: { x: center.x - box.width / 2, y: center.y - box.height / 2 }, size: { width: box.width, height: box.height } };
  return { ...layer, transform, paths: translatePaths(paths, -box.x, -box.y), sourceShape: null, raster: null };
}

export function replaceLayer(document: CanvasDocument, layer: Layer): CanvasDocument {
  return { ...document, layers: document.layers.map((value) => (value.id === layer.id ? layer : value)) };
}

/** The target with new paths (layer units). */
export function withTargetPaths(target: PathTarget, paths: readonly VectorPath[]): Layer {
  if (target.mask) return { ...target.layer, vectorMask: { ...(target.layer.vectorMask ?? emptyMask(false)), paths } };
  return withLayerPaths(target.layer, paths);
}

export function emptyMask(inverted: boolean): VectorMask {
  return { schemaVersion: 1, enabled: true, inverted, density: 1, feather: 0, paths: [] };
}

// MARK: Transactions

/** One open undo step for a drag or a slider move (the engine's live variants, generalised to masks). */
export class LiveEdit {
  private before: CanvasDocument | null = null;
  constructor(private readonly session: EditorSession) {}
  get active(): boolean { return this.before !== null; }
  begin(name: string): boolean {
    if (this.before) return true;
    const document = this.session.document;
    if (!document) return false;
    this.before = document;
    this.session.beginEdit(name);
    return true;
  }
  replace(document: CanvasDocument): void {
    this.session.replaceDocument(document);
    this.session.notify('document');
  }
  end(): void {
    if (!this.before) return;
    this.before = null;
    this.session.endEdit();
  }
  cancel(): void {
    if (!this.before) return;
    this.session.replaceDocument(this.before);
    this.before = null;
    this.session.endEdit();
  }
}

const lives = new WeakMap<EditorSession, LiveEdit>();
/** The session's live edit for context-bar sliders. */
export function liveEdit(session: EditorSession): LiveEdit {
  let live = lives.get(session);
  if (!live) { live = new LiveEdit(session); lives.set(session, live); }
  return live;
}

/** Applies a layer change as one step, or into the open live edit. */
export function changeLayer(session: EditorSession, name: string, layer: Layer, live = false): void {
  const document = session.document;
  if (!document) return;
  const edit = liveEdit(session);
  if (live || edit.active) { if (edit.begin(name)) edit.replace(replaceLayer(session.document!, layer)); return; }
  session.edit(name, () => session.replaceDocument(replaceLayer(session.document!, layer)));
}

// MARK: Creating shapes and paths

function insertLayer(session: EditorSession, layer: Layer, name: string): string | null {
  const document = session.document;
  if (!document || !session.canEditLayers || document.layers.length >= MAX_LAYERS) return null;
  session.edit(name, () => {
    const layers = session.document!.layers.slice(), index = layers.findIndex((value) => value.id === session.activeLayerId);
    layers.splice(index < 0 ? layers.length : index + 1, 0, layer);
    session.replaceDocument({ ...session.document!, layers });
    session.setActiveLayer(layer.id);
  });
  // Recent colours: the new shape's fill (or stroke) colour.
  const style = layer.kind === 'vector' ? layer.style : null;
  const used = style?.fill?.kind === 'solid' ? style.fill.color : style?.stroke?.color;
  if (used) noteColorUsed(session, used);
  return layer.id;
}

function parentFor(session: EditorSession): string | null {
  const active = session.activeLayer;
  return active?.kind === 'group' ? active.id : active?.parentId ?? null;
}

/** A new parametric shape layer (PRODUCT-PLAN A5): editable primitive parameters, rendered by the engine. */
export function addShapeLayer(session: EditorSession, shape: LayerShape, rect: Rect, style: VectorStyle, label: string): string | null {
  if (!(rect.width >= 1 && rect.height >= 1) || !session.document) return null;
  const layer = newLayer({ id: uuid(), name: uniqueName(session.document.layers, label), kind: 'vector', raster: null, sourceShape: shape,
    paths: primitivePaths(shape, rect.width, rect.height), style,
    transform: makeTransform({ x: rect.x, y: rect.y }, { width: rect.width, height: rect.height }), parentId: parentFor(session) });
  return insertLayer(session, layer, `Create ${shape.kind}`);
}

/** A new path layer from document-space paths (Pen, Line). */
export function addPathLayer(session: EditorSession, paths: readonly VectorPath[], style: VectorStyle, label: string, name: string): string | null {
  const fitted = fitDocumentPaths(paths);
  if (!fitted || !session.document) return null;
  const layer = newLayer({ id: uuid(), name: uniqueName(session.document.layers, label), kind: 'vector', raster: null, sourceShape: null,
    paths: fitted.paths, style, transform: fitted.transform, parentId: parentFor(session) });
  return insertLayer(session, layer, name);
}

/**
 * Adds document-space paths to a target with a path operation: combining keeps separate editable subpaths (Photoshop
 * Combine Shapes); subtract, intersect and exclude run PathOps.
 */
export function addToTarget(session: EditorSession, engine: TextEngine | null, target: PathTarget, paths: readonly VectorPath[],
  operation: Exclude<PathOperation, 'new'>, name: string): boolean {
  if (!session.canEditLayers || session.refuseLayerEdit(target.layer.id, target.mask ? 'appearance' : 'pixels')) return false;
  const local = mapPaths(paths, invert(layerToDocument(target.layer)));
  const existing = target.mask ? target.layer.vectorMask?.paths ?? [] : target.layer.kind === 'vector' ? target.layer.paths : [];
  let result: readonly VectorPath[];
  if (operation === 'unite') result = [...existing, ...local];
  else if (!engine) return false;
  else result = booleanPaths(engine, existing, local, operation);
  changeLayer(session, name, withTargetPaths(target, result));
  return true;
}

// MARK: Parametric shapes

/** A shape layer with new primitive parameters (paths regenerated at the layer's size). */
export function withShapeParameters(layer: Layer, shape: LayerShape): Layer {
  if (layer.kind !== 'vector') return layer;
  return { ...layer, sourceShape: shape, raster: null, paths: primitivePaths(shape, layer.transform.size.width, layer.transform.size.height) };
}

// MARK: Layer › Combine Shapes, Merge Shapes

export function combinableLayers(session: EditorSession): Layer[] {
  const document = session.document;
  if (!document) return [];
  return document.layers.filter((layer) => session.selectedLayerIds.has(layer.id) && layer.kind === 'vector');
}

/**
 * Combines the selected shape layers (bottom layer first, its style kept), or the subpaths of one shape layer (the
 * first subpath against the rest), into one editable path.
 */
export function combineShapes(session: EditorSession, engine: TextEngine, operation: VectorBooleanOperation, name: string): boolean {
  const document = session.document;
  if (!document || !session.canEditLayers) return false;
  const layers = combinableLayers(session);
  if (layers.length >= 2 && layers.length === session.selectedLayerIds.size) {
    if (layers.some((layer) => session.refuseLayerEdit(layer.id, 'pixels'))) return false;
    const sets = layers.map((layer) => documentPaths(layer));
    const result = operation === 'subtract'
      ? booleanPaths(engine, sets[0]!, combinePathSets(engine, sets.slice(1), 'unite'), 'subtract')
      : combinePathSets(engine, sets, operation);
    const base = layers[0]!;
    const fitted = fitDocumentPaths(result);
    const combined: Layer = fitted ? { ...(base as Extract<Layer, { kind: 'vector' }>), paths: fitted.paths, transform: fitted.transform, sourceShape: null, raster: null }
      : { ...(base as Extract<Layer, { kind: 'vector' }>), paths: [], sourceShape: null, raster: null };
    const removed = new Set(layers.slice(1).map((layer) => layer.id));
    session.edit(name, () => {
      session.replaceDocument({ ...session.document!, layers: session.document!.layers.filter((layer) => !removed.has(layer.id)).map((layer) => (layer.id === base.id ? combined : layer)) });
      session.setActiveLayer(base.id);
    });
    return true;
  }
  const layer = session.activeLayer;
  if (layer?.kind !== 'vector' || layer.paths.length < 2 || session.refuseLayerEdit(layer.id, 'pixels')) return false;
  const [first, ...rest] = layer.paths;
  const result = operation === 'subtract' ? booleanPaths(engine, [first!], combinePathSets(engine, rest.map((path) => [path]), 'unite'), 'subtract')
    : combinePathSets(engine, layer.paths.map((path) => [path]), operation);
  changeLayer(session, name, withLayerPaths(layer, result));
  return true;
}

export function canCombineShapes(session: EditorSession): boolean {
  if (!session.canEditLayers) return false;
  const layers = combinableLayers(session);
  if (layers.length >= 2) return layers.length === session.selectedLayerIds.size;
  const layer = session.activeLayer;
  return session.selectedLayerIds.size === 1 && layer?.kind === 'vector' && layer.paths.length >= 2;
}

// MARK: Vector masks

export function setVectorMaskOf(session: EditorSession, layerId: string, mask: VectorMask | null, name: string): boolean {
  const layer = session.layer(layerId);
  if (!layer || layer.kind === 'adjustment' || !session.canEditLayers || session.refuseLayerEdit(layerId, 'appearance')) return false;
  session.edit(name, () => session.replaceDocument(replaceLayer(session.document!, { ...layer, vectorMask: mask })));
  return true;
}

/** The "current path": the last shape layer worked with, when it is not the layer being changed. */
export function currentPathLayer(session: EditorSession, excluding: string | null = null): Layer | null {
  const layer = session.layer(vectorState(session).pathLayerId);
  return layer?.kind === 'vector' && layer.id !== excluding && layer.paths.length ? layer : null;
}

/** Layer › Vector Mask › Current Path: the current path, in the target layer's units. */
export function maskFromPath(session: EditorSession, targetId: string, source: Layer, name: string): boolean {
  const target = session.layer(targetId);
  if (!target) return false;
  const paths = mapPaths(documentPaths(source), invert(layerToDocument(target)));
  return setVectorMaskOf(session, targetId, { ...emptyMask(false), paths }, name);
}

// MARK: Selection and painting from paths

/** The path Select › Load Selection from Path uses: the targeted vector mask or shape, else the current path. */
export function selectionSourcePaths(session: EditorSession, target: PathTarget | null): VectorPath[] | null {
  if (target) {
    const paths = documentPaths(target.layer, target.mask);
    if (paths.length) return paths;
  }
  const current = currentPathLayer(session);
  return current ? documentPaths(current) : null;
}

export function loadSelectionFromPaths(session: EditorSession, engine: TextEngine, paths: readonly VectorPath[], name: string): boolean {
  const document = session.document;
  if (!document || !session.canEditLayers) return false;
  const bounds = vectorBounds(paths);
  if (!bounds) return false;
  const x = Math.max(0, Math.floor(bounds.x)), y = Math.max(0, Math.floor(bounds.y));
  const right = Math.min(document.width, Math.ceil(bounds.x + bounds.width)), bottom = Math.min(document.height, Math.ceil(bounds.y + bounds.height));
  if (right <= x || bottom <= y) return false;
  const closed = paths.map((path) => ({ ...path, closed: true }));
  return applySelection(session, pathsToSelection(engine, closed, { x, y, width: right - x, height: bottom - y }), 'New', name);
}

/** Edit › Fill Path / Stroke Path: paints document-space paths onto a pixel layer (a blank layer gets canvas pixels). */
export function paintPathsOnLayer(session: EditorSession, engine: TextEngine, layerId: string, paths: readonly VectorPath[],
  style: VectorStyle, name: string): boolean {
  const document = session.document, layer = session.layer(layerId);
  if (!document || layer?.kind !== 'pixel' || !session.canEditLayers || session.refuseLayerEdit(layerId, 'pixels')) return false;
  const base = layer.raster ?? Raster.blank(document.width, document.height, 4);
  const transform = layer.raster ? layer.transform : makeTransform({ x: 0, y: 0 }, { width: document.width, height: document.height });
  const local = mapPaths(paths, invert(pixelToDocument(transform, base.width, base.height)));
  const raster = paintVectorToRaster(base, engine, local, style);
  session.replaceLayerPixels(layerId, raster, name, layer.raster ? undefined : transform);
  return true;
}

export function pointsEqual(a: Point, b: Point): boolean { return Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9; }
