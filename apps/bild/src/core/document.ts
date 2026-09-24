/**
 * The editable document. Ported from EditorSession.swift (`ImageLayer`, `CanvasDocument`),
 * LayerGroups.swift (`LayerHierarchy`), LiveLayerMask.swift (`LiveMaskGraph`, clipping stacks),
 * LayerMask.swift and LayerAppearance.swift.
 *
 * Documents and layers are immutable values: an edit builds new objects and shares rasters, so a
 * history snapshot is just a reference to the previous document.
 */

import type { LayerTransform, Point } from './geometry';
import { transformsEqual } from './geometry';
import type {
  AdjustmentKind, BlendMode, CanvasDocument, Layer, LayerAdjustment, LayerMask, LayerShape,
} from './model';
export type {
  AdjustmentKind, Artboard, BlendMode, CanvasDocument, ColorLabel, CropParameters, DocumentResource, EmbeddedLayer,
  FillLayer, FillParameters, GroupLayer, Layer, LayerAdjustment, LayerEffect, LayerLocks, LayerMask, ModelLayer,
  LayerShape, LiveFilter, PixelLayer, TextLayer, VectorLayer, VectorMask, WarpQuad,
} from './model';

/** Blend menu order (LayerBlendMode.allCases) with upstream raw values as labels. */
export const BLEND_MODES: readonly { mode: BlendMode; label: string }[] = [
  { mode: 'normal', label: 'Normal' }, { mode: 'multiply', label: 'Multiply' }, { mode: 'screen', label: 'Screen' },
  { mode: 'overlay', label: 'Overlay' }, { mode: 'darken', label: 'Darken' }, { mode: 'lighten', label: 'Lighten' },
  { mode: 'difference', label: 'Difference' }, { mode: 'colorDodge', label: 'Color Dodge' },
  { mode: 'colorBurn', label: 'Color Burn' }, { mode: 'hue', label: 'Hue' }, { mode: 'saturation', label: 'Saturation' },
  { mode: 'color', label: 'Color' }, { mode: 'luminosity', label: 'Luminosity' },
];
export const BLEND_MODE_SET: ReadonlySet<string> = new Set(BLEND_MODES.map((b) => b.mode));
export function blendLabel(mode: BlendMode): string { return BLEND_MODES.find((b) => b.mode === mode)?.label ?? mode; }

export const ADJUSTMENT_KINDS: readonly AdjustmentKind[] = ['Hue/Saturation', 'Levels', 'Curves', 'Exposure', 'Gradient Map', 'Grain'];

export const MAX_SIDE = 30_000;
export const MAX_PIXELS = 100_000_000;
export const MAX_LAYERS = 10_000;
export const MAX_DEPTH = 64;

export function validDimension(value: string | number): number | null {
  const n = typeof value === 'number' ? value : Number(value.trim());
  return Number.isInteger(n) && n >= 1 && n <= MAX_SIDE ? n : null;
}

export function layerPixelWidth(layer: Layer): number { return layer.raster?.width ?? Math.max(1, Math.round(layer.transform.size.width)); }
export function layerPixelHeight(layer: Layer): number { return layer.raster?.height ?? Math.max(1, Math.round(layer.transform.size.height)); }

/** Where the mask's pixels sit on the document: its own placement, else the layer's. */
export function maskTransform(layer: Layer): LayerTransform { return layer.mask?.placement ?? layer.transform; }

export function masksEqual(a: LayerMask | null, b: LayerMask | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.raster === b.raster && a.enabled === b.enabled && a.linked === b.linked
    && (a.placement === b.placement || (!!a.placement && !!b.placement && transformsEqual(a.placement, b.placement)));
}

export function layersEqual(a: Layer, b: Layer): boolean {
  return a === b || (a.id === b.id && a.name === b.name && a.visible === b.visible && a.locked === b.locked
    && transformsEqual(a.transform, b.transform) && a.raster === b.raster && a.parentId === b.parentId
    && a.isGroup === b.isGroup && a.opacity === b.opacity && a.blendMode === b.blendMode && masksEqual(a.mask, b.mask)
    && a.kind === b.kind && (a.fillOpacity ?? 1) === (b.fillOpacity ?? 1) && jsonEqual(a.locks, b.locks)
    && (a.colorLabel ?? 'none') === (b.colorLabel ?? 'none')
    && jsonEqual(a.warp ?? null, b.warp ?? null) && jsonEqual(a.crop ?? null, b.crop ?? null)
    && jsonEqual(a.vectorMask ?? null, b.vectorMask ?? null)
    && jsonEqual(a.effects ?? [], b.effects ?? []) && jsonEqual(a.filters ?? [], b.filters ?? [])
    && a.maskSourceId === b.maskSourceId && jsonEqual(a.adjustment, b.adjustment) && jsonEqual(a.shape, b.shape)
    && jsonEqual(kindPayload(a), kindPayload(b)));
}

export function documentsEqual(a: CanvasDocument | null, b: CanvasDocument | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.id !== b.id || a.width !== b.width || a.height !== b.height || a.resolution !== b.resolution
    || !jsonEqual(a.artboards ?? [], b.artboards ?? []) || !resourcesEqual(a.resources ?? [], b.resources ?? [])) return false;
  if (a.selection !== b.selection) return false;
  if (a.layers.length !== b.layers.length) return false;
  return a.layers.every((layer, i) => layersEqual(layer, b.layers[i]!));
}

function resourcesEqual(a: NonNullable<CanvasDocument['resources']>, b: NonNullable<CanvasDocument['resources']>): boolean {
  return a.length === b.length && a.every((value, index) => {
    const other = b[index];
    if (!other || value.id !== other.id || value.role !== other.role || value.mime !== other.mime || value.bytes.length !== other.bytes.length) return false;
    if (value.bytes === other.bytes) return true;
    for (let i = 0; i < value.bytes.length; i++) if (value.bytes[i] !== other.bytes[i]) return false;
    return true;
  });
}

function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

export type NewLayerFields = Partial<Omit<Layer, 'kind'>> & Pick<Layer, 'id' | 'name' | 'transform'> & {
  kind?: Exclude<Layer['kind'], undefined>;
  fill?: import('./model').FillParameters;
  paths?: readonly import('./model').VectorPath[];
  style?: import('./model').VectorStyle;
  text?: string;
  runs?: readonly import('./model').TextRun[];
  box?: { readonly width: number; readonly height: number } | null;
  alignment?: 'left' | 'center' | 'right' | 'justify';
  content?: import('./model').EmbeddedLayer['content'];
};

export function newLayer(fields: NewLayerFields): import('./model').ModelLayer {
  const candidate = fields;
  const kind = candidate.kind ?? (candidate.isGroup ? 'group' : candidate.adjustment ? 'adjustment' : candidate.shape ? 'vector' : 'pixel');
  const base = {
    visible: true, locked: false, parentId: null, isGroup: kind === 'group', opacity: 1, fillOpacity: 1,
    blendMode: 'normal' as const, locks: { transparency: false, pixels: false, position: false, all: false },
    colorLabel: 'none' as const, warp: null, crop: null, raster: null, mask: null, vectorMask: null,
    maskSourceId: null, effects: [], filters: [], adjustment: null, shape: null, ...candidate, kind,
  };
  if (kind === 'fill') return { ...base, isGroup: false, fill: candidate.fill ?? { kind: 'solid', schemaVersion: 1, color: { red: 0, green: 0, blue: 0 } } } as import('./model').ModelLayer;
  if (kind === 'vector') return { ...base, isGroup: false, paths: candidate.kind === 'vector' ? candidate.paths : [],
    style: candidate.kind === 'vector' ? candidate.style : { fill: null, stroke: null } } as import('./model').ModelLayer;
  if (kind === 'text') return { ...base, isGroup: false, text: candidate.kind === 'text' ? candidate.text : '',
    runs: candidate.kind === 'text' ? candidate.runs : [], box: candidate.kind === 'text' ? candidate.box : null,
    alignment: candidate.kind === 'text' ? candidate.alignment : 'left' } as import('./model').ModelLayer;
  if (kind === 'embedded') return { ...base, isGroup: false, content: candidate.kind === 'embedded' ? candidate.content
    : { mode: 'embedded', mediaType: 'image', sourceName: '' } } as import('./model').ModelLayer;
  return { ...base, isGroup: kind === 'group' } as import('./model').ModelLayer;
}

function kindPayload(layer: Layer): unknown {
  const model = layer as import('./model').ModelLayer;
  switch (layer.kind) {
    case 'fill': return (model as import('./model').FillLayer).fill;
    case 'vector': { const value = model as import('./model').VectorLayer; return { paths: value.paths, style: value.style }; }
    case 'text': { const value = model as import('./model').TextLayer; return { text: value.text, runs: value.runs, box: value.box, alignment: value.alignment }; }
    case 'embedded': return (model as import('./model').EmbeddedLayer).content;
    default: return null;
  }
}

// MARK: Hierarchy (LayerHierarchy)

export interface HierarchyEntry { readonly layer: Layer; readonly depth: number; readonly visible: boolean }

export function hierarchyEntries(layers: readonly Layer[], topFirst = false, collapsed: ReadonlySet<string> = new Set()): HierarchyEntry[] {
  const children = new Map<string | null, Layer[]>();
  for (const layer of layers) {
    const list = children.get(layer.parentId);
    if (list) list.push(layer); else children.set(layer.parentId, [layer]);
  }
  const result: HierarchyEntry[] = [];
  const visit = (parent: string | null, depth: number, visible: boolean) => {
    if (depth > MAX_DEPTH) return;
    const siblings = children.get(parent) ?? [];
    for (const layer of topFirst ? [...siblings].reverse() : siblings) {
      const effective = visible && layer.visible;
      result.push({ layer, depth, visible: effective });
      if (layer.isGroup && !collapsed.has(layer.id)) visit(layer.id, depth + 1, effective);
    }
  };
  visit(null, 0, true);
  return result;
}

/** Visible pixel/adjustment layers in compositing order (CanvasDocument.renderLayers). */
export function renderLayers(layers: readonly Layer[]): Layer[] {
  return hierarchyEntries(layers).filter((e) => e.visible && !e.layer.isGroup).map((e) => e.layer);
}

export function effectiveVisibleIds(layers: readonly Layer[]): Set<string> {
  return new Set(hierarchyEntries(layers).filter((e) => e.visible).map((e) => e.layer.id));
}

export function descendantIds(layers: readonly Layer[], id: string): Set<string> {
  const children = new Map<string | null, Layer[]>();
  for (const layer of layers) {
    const list = children.get(layer.parentId);
    if (list) list.push(layer); else children.set(layer.parentId, [layer]);
  }
  const result = new Set<string>();
  const pending = [id];
  while (pending.length) {
    const parent = pending.pop()!;
    for (const child of children.get(parent) ?? []) {
      if (!result.has(child.id)) { result.add(child.id); pending.push(child.id); }
    }
  }
  return result;
}

export function ancestorIds(layers: readonly Layer[], id: string): string[] {
  const byId = new Map(layers.map((l) => [l.id, l]));
  const result: string[] = [];
  let parent = byId.get(id)?.parentId ?? null;
  while (parent && result.length <= MAX_DEPTH) { result.push(parent); parent = byId.get(parent)?.parentId ?? null; }
  return result;
}

export class InvalidProjectError extends Error {
  constructor(message = 'This is not a valid Fernwork Bildeditor project, or its metadata is damaged.') { super(message); this.name = 'InvalidProjectError'; }
}

/** Minimal record shape the validators need, shared by live documents and loaded manifests. */
export interface HierarchyRecord {
  id: string;
  parentId: string | null;
  isGroup: boolean;
  hasImage: boolean;
  maskSourceId: string | null;
  isAdjustment: boolean;
}

export function hierarchyRecord(layer: Layer): HierarchyRecord {
  return { id: layer.id, parentId: layer.parentId, isGroup: layer.isGroup, hasImage: !!layer.raster,
    maskSourceId: layer.maskSourceId, isAdjustment: !!layer.adjustment };
}

/** LayerHierarchy.validate: unique ids, parents are groups, no cycles, depth ≤ 64, groups carry no image. */
export function validateHierarchy(records: readonly HierarchyRecord[]): void {
  const byId = new Map<string, HierarchyRecord>();
  for (const record of records) {
    if (byId.has(record.id) || (record.isGroup && record.hasImage)) throw new InvalidProjectError();
    byId.set(record.id, record);
  }
  for (const record of records) {
    const seen = new Set([record.id]);
    let parent = record.parentId;
    while (parent) {
      const node = byId.get(parent);
      if (seen.size > MAX_DEPTH || seen.has(parent) || !node || !node.isGroup) throw new InvalidProjectError();
      seen.add(parent);
      parent = node.parentId;
    }
    if (record.isGroup && seen.size > MAX_DEPTH) throw new InvalidProjectError();
  }
}

/** LiveMaskGraph.validate: sources exist, are not groups/adjustments, no cycles, chains < 256. */
export function validateLiveMasks(records: readonly HierarchyRecord[]): void {
  const byId = new Map<string, HierarchyRecord>();
  for (const record of records) {
    if (byId.has(record.id)) throw new InvalidProjectError();
    byId.set(record.id, record);
  }
  for (const record of records) {
    const path = new Set<string>();
    let current: string | null = record.id;
    while (current) {
      const node = byId.get(current);
      if (path.size >= 256 || path.has(current) || !node) throw new InvalidProjectError();
      path.add(current);
      if (node.maskSourceId) {
        const source = byId.get(node.maskSourceId);
        if (node.isGroup || !source || source.isGroup || source.isAdjustment) throw new InvalidProjectError();
      }
      current = node.maskSourceId;
    }
  }
}

export function isValidStructure(layers: readonly Layer[]): boolean {
  try {
    const records = layers.map(hierarchyRecord);
    validateHierarchy(records);
    validateLiveMasks(records);
    return true;
  } catch { return false; }
}

/** A moved layer stops clipping when it no longer belongs to the contiguous stack above its base. */
export function releaseDetachedClipping(layers: Layer[]): void {
  const stacks = new Map<string | null, Layer[]>();
  for (const layer of layers) {
    const list = stacks.get(layer.parentId);
    if (list) list.push(layer); else stacks.set(layer.parentId, [layer]);
  }
  const release = new Set<string>();
  for (const stack of stacks.values()) {
    let base: string | null = null;
    for (const layer of stack) {
      if (layer.maskSourceId) {
        if (layer.maskSourceId !== base) { release.add(layer.id); base = layer.id; }
      } else base = layer.isGroup ? null : layer.id;
    }
  }
  for (let i = 0; i < layers.length; i++) {
    if (release.has(layers[i]!.id)) layers[i] = { ...layers[i]!, maskSourceId: null };
  }
}

/** A layer dropped between a base and a layer clipped to it joins that clipping group. */
export function adoptClipping(id: string, layers: Layer[]): void {
  const layer = layers.find((l) => l.id === id);
  if (!layer || layer.isGroup) return;
  const siblings = layers.filter((l) => l.parentId === layer.parentId);
  const index = siblings.findIndex((l) => l.id === id);
  if (index <= 0 || index + 1 >= siblings.length) return;
  const source = siblings[index + 1]!.maskSourceId;
  if (!source || source === id) return;
  const below = siblings[index - 1]!;
  if (below.id !== source && below.maskSourceId !== source) return;
  const position = layers.findIndex((l) => l.id === id);
  layers[position] = { ...layers[position]!, maskSourceId: source };
}

/** Pixels the document's layers hold (the 100-megapixel import budget). */
export function usedPixels(layers: readonly Layer[]): number {
  return layers.reduce((total, layer) => total + (layer.raster ? layer.raster.width * layer.raster.height : 0), 0);
}

export function uniqueName(layers: readonly Layer[], prefix: string): string {
  const names = new Set(layers.map((l) => l.name));
  let number = 1;
  while (names.has(`${prefix} ${number}`)) number++;
  return `${prefix} ${number}`;
}

export type { Point };
