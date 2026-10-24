/**
 * Artboards (PRODUCT-PLAN A2 / 6.1): document-level frames above the flat layer stack.
 *
 * Membership rule (docs/format-v2.md "Artboards": membership is spatial, not stored):
 * - The unit of membership is a top-level layer together with its descendants (a folder moves as a
 *   whole). Top-level layers clipped to / live-masked by another top-level unit join that unit.
 * - A unit's bounds are the union of its layers' content bounds: the alpha-trimmed pixels mapped
 *   through the layer transform for raster-backed layers, the transform box for vector/text/embedded
 *   layers without a rendered cache. Folders, adjustment and fill layers have no bounds of their own.
 * - A unit belongs to the topmost artboard (last in document order) whose rect contains the centre of
 *   its bounds. Units without bounds (e.g. a top-level adjustment layer) or whose centre lies outside
 *   every artboard are "loose": they are rendered into every export region they overlap.
 * - Exporting an artboard renders its members and the loose units, hides every other artboard's
 *   members, clips to the artboard rect and puts the artboard background underneath.
 *
 * Artboards live inside the document canvas (the compositors clip to it): commands grow the canvas to
 * the right/bottom so every artboard fits, and never move content to make room.
 */

import { descendantIds, MAX_PIXELS, MAX_SIDE, type Artboard, type CanvasDocument, type Layer } from './document';
import type { ColorLabel, RGB } from './model';
import { apply, boundingBox, pixelToDocument, type Point, type Rect } from './geometry';
import { alphaBounds, type Raster } from './raster';
import { unionRect } from './align';

export type ArtboardBackground = RGB & { readonly alpha: number };

/** Photoshop's default artboard background is white. */
export const DEFAULT_ARTBOARD_BACKGROUND: ArtboardBackground = { red: 1, green: 1, blue: 1, alpha: 1 };
export const TRANSPARENT_ARTBOARD_BACKGROUND: ArtboardBackground = { red: 1, green: 1, blue: 1, alpha: 0 };
/** Space between an automatically placed artboard and its neighbour, in document pixels. */
export const ARTBOARD_GAP = 100;

const COLOR_LABELS: ReadonlySet<string> = new Set(['none', 'red', 'orange', 'yellow', 'green', 'blue', 'violet', 'gray']);

export class ArtboardError extends Error {
  readonly code: 'not-found' | 'invalid-rect' | 'too-large' | 'no-document' | 'locked';
  constructor(code: ArtboardError['code'], message: string) {
    super(message); this.name = 'ArtboardError'; this.code = code;
  }
}

export function artboardsOf(document: CanvasDocument | null): readonly Artboard[] { return document?.artboards ?? []; }

export function findArtboard(document: CanvasDocument | null, id: string): Artboard | undefined {
  return artboardsOf(document).find((artboard) => artboard.id === id);
}

// MARK: Validation and persistence

export function isValidArtboardRect(rect: Rect): boolean {
  return [rect.x, rect.y, rect.width, rect.height].every(Number.isInteger)
    && rect.x >= 0 && rect.y >= 0 && rect.width >= 1 && rect.height >= 1
    && rect.x + rect.width <= MAX_SIDE && rect.y + rect.height <= MAX_SIDE;
}

export function isValidBackground(background: unknown): background is ArtboardBackground {
  const value = background as Partial<ArtboardBackground> | null;
  return !!value && [value.red, value.green, value.blue, value.alpha]
    .every((channel) => typeof channel === 'number' && Number.isFinite(channel) && channel >= 0 && channel <= 1);
}

/**
 * Reader-side normalisation for format v2 `artboards` (older writers stored only id/name/rect).
 * Missing backgrounds become white, unknown labels `none`, duplicate ids are dropped.
 */
export function normalizeArtboards(records: readonly Partial<Artboard>[]): Artboard[] {
  const seen = new Set<string>();
  const result: Artboard[] = [];
  for (const record of records) {
    if (!record.id || seen.has(record.id) || !record.rect) continue;
    seen.add(record.id);
    result.push({
      id: record.id, name: typeof record.name === 'string' ? record.name : '',
      rect: { x: record.rect.x, y: record.rect.y, width: record.rect.width, height: record.rect.height },
      background: isValidBackground(record.background)
        ? { red: record.background.red, green: record.background.green, blue: record.background.blue, alpha: record.background.alpha }
        : DEFAULT_ARTBOARD_BACKGROUND,
      colorLabel: COLOR_LABELS.has(record.colorLabel as string) ? record.colorLabel as ColorLabel : 'none',
    });
  }
  return result;
}

// MARK: Membership

const contentCache = new WeakMap<Raster, Rect | null>();

/** Document-space bounds of what a layer draws by itself, or null when it has none (see the module rule). */
export function layerContentBounds(layer: Layer): Rect | null {
  if (layer.kind === 'group' || layer.kind === 'adjustment' || layer.kind === 'fill') return null;
  const raster = layer.raster ?? null;
  if (!raster) return layer.kind === 'pixel' ? null : boundingBox(layer.transform);
  let local = contentCache.get(raster);
  if (local === undefined) { local = alphaBounds(raster); contentCache.set(raster, local); }
  if (!local) return null;
  const toDocument = pixelToDocument(layer.transform, raster.width, raster.height);
  const points: Point[] = [
    { x: local.x, y: local.y }, { x: local.x + local.width, y: local.y },
    { x: local.x + local.width, y: local.y + local.height }, { x: local.x, y: local.y + local.height },
  ].map((point) => apply(toDocument, point));
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

export interface ArtboardUnit {
  /** Top-level layer ids of the unit, bottom first. */
  readonly roots: readonly string[];
  /** Every layer id in the unit (roots and descendants), document order. */
  readonly ids: readonly string[];
  readonly bounds: Rect | null;
  readonly artboardId: string | null;
}

export type ContentBounds = (layer: Layer) => Rect | null;

/** The top-level units of the layer stack with their artboard, bottom first. */
export function artboardUnits(document: CanvasDocument, bounds: ContentBounds = layerContentBounds): ArtboardUnit[] {
  const layers = document.layers;
  const byId = new Map(layers.map((layer) => [layer.id, layer]));
  const rootOf = (id: string): string => {
    let current = byId.get(id);
    for (let guard = 0; current?.parentId && guard < 128; guard++) current = byId.get(current.parentId);
    return current?.id ?? id;
  };
  // Union-find over top-level roots: a clipped/live-masked root joins its source's root.
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let at = id;
    while (parent.get(at) !== at && parent.has(at)) at = parent.get(at)!;
    return at;
  };
  const roots = layers.filter((layer) => layer.parentId === null);
  for (const root of roots) parent.set(root.id, root.id);
  const clippedRoots = new Set<string>();
  for (const layer of layers) {
    if (!layer.maskSourceId || !byId.has(layer.maskSourceId)) continue;
    const own = rootOf(layer.id), source = rootOf(layer.maskSourceId);
    if (own === source) continue;
    const a = find(own), b = find(source);
    if (a !== b) parent.set(a, b);
    clippedRoots.add(own);
  }
  const groups = new Map<string, string[]>();
  for (const root of roots) {
    const key = find(root.id);
    const list = groups.get(key);
    if (list) list.push(root.id); else groups.set(key, [root.id]);
  }
  const artboards = document.artboards ?? [];
  const units: ArtboardUnit[] = [];
  for (const unitRoots of groups.values()) {
    const members = new Set<string>();
    for (const root of unitRoots) { members.add(root); for (const id of descendantIds(layers, root)) members.add(id); }
    const ids = layers.filter((layer) => members.has(layer.id)).map((layer) => layer.id);
    const rectsFrom = (candidates: readonly string[]) => candidates.flatMap((id) => {
      const rect = bounds(byId.get(id)!);
      return rect && rect.width > 0 && rect.height > 0 ? [rect] : [];
    });
    // Clipped units take their extent from the base they are clipped to.
    const baseIds = ids.filter((id) => !clippedRoots.has(rootOf(id)));
    const unitBounds = unionRect(rectsFrom(baseIds)) ?? unionRect(rectsFrom(ids));
    units.push({ roots: unitRoots, ids, bounds: unitBounds, artboardId: unitBounds ? artboardContaining(artboards, centre(unitBounds)) : null });
  }
  const order = new Map(layers.map((layer, index) => [layer.id, index]));
  return units.sort((a, b) => order.get(a.roots[0]!)! - order.get(b.roots[0]!)!);
}

/** Layer id → artboard id (null = loose) for every layer. */
export function artboardMembership(document: CanvasDocument, bounds: ContentBounds = layerContentBounds): Map<string, string | null> {
  const result = new Map<string, string | null>();
  for (const unit of artboardUnits(document, bounds)) for (const id of unit.ids) result.set(id, unit.artboardId);
  return result;
}

/** Ids of the layers that belong to `artboardId` (not including loose layers). */
export function artboardLayerIds(document: CanvasDocument, artboardId: string, bounds: ContentBounds = layerContentBounds): Set<string> {
  const result = new Set<string>();
  for (const unit of artboardUnits(document, bounds)) if (unit.artboardId === artboardId) for (const id of unit.ids) result.add(id);
  return result;
}

/** Topmost artboard under a document point (hit testing for the artboard tool). */
export function artboardAt(document: CanvasDocument, point: Point): Artboard | null {
  const id = artboardContaining(document.artboards ?? [], point);
  return id ? findArtboard(document, id) ?? null : null;
}

function centre(rect: Rect): Point { return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; }

function artboardContaining(artboards: readonly Artboard[], point: Point): string | null {
  for (let index = artboards.length - 1; index >= 0; index--) {
    const { rect, id } = artboards[index]!;
    if (point.x >= rect.x && point.x < rect.x + rect.width && point.y >= rect.y && point.y < rect.y + rect.height) return id;
  }
  return null;
}

// MARK: Geometry helpers for commands

/** Where a new artboard goes when the caller gives no position: right of the rightmost artboard. */
export function nextArtboardOrigin(document: CanvasDocument): Point {
  const artboards = document.artboards ?? [];
  if (!artboards.length) return { x: 0, y: 0 };
  const right = Math.max(...artboards.map((a) => a.rect.x + a.rect.width));
  const top = Math.min(...artboards.map((a) => a.rect.y));
  return { x: right + ARTBOARD_GAP, y: top };
}

/** The document with its canvas grown (never shrunk) to contain every artboard. */
export function withCanvasFittingArtboards(document: CanvasDocument): CanvasDocument {
  const artboards = document.artboards ?? [];
  let width = document.width, height = document.height;
  for (const artboard of artboards) {
    width = Math.max(width, artboard.rect.x + artboard.rect.width);
    height = Math.max(height, artboard.rect.y + artboard.rect.height);
  }
  if (width === document.width && height === document.height) return document;
  if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) {
    throw new ArtboardError('too-large', 'The artboards do not fit in a canvas of 30,000 pixels per side and 100 megapixels.');
  }
  return { ...document, width, height };
}

export function roundedRect(rect: Rect): Rect {
  const x = Math.round(rect.x), y = Math.round(rect.y);
  return { x, y, width: Math.max(1, Math.round(rect.x + rect.width) - x), height: Math.max(1, Math.round(rect.y + rect.height) - y) };
}
