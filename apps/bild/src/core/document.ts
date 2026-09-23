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
import type { Raster } from './raster';
import type { DocumentSelection } from './selection';

export type BlendMode =
  | 'normal' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten' | 'difference'
  | 'colorDodge' | 'colorBurn' | 'hue' | 'saturation' | 'color' | 'luminosity';

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

export type AdjustmentKind = 'Hue/Saturation' | 'Levels' | 'Curves' | 'Exposure' | 'Gradient Map' | 'Grain';
export const ADJUSTMENT_KINDS: readonly AdjustmentKind[] = ['Hue/Saturation', 'Levels', 'Curves', 'Exposure', 'Gradient Map', 'Grain'];

/** Upstream `LayerAdjustment` in its Codable JSON shape; `kind` selects which settings apply. */
export interface LayerAdjustment {
  readonly kind: AdjustmentKind;
  readonly [key: string]: unknown;
}

/** Upstream `LayerShapeStyle` (ShapeTool.swift) in its Codable JSON shape. */
export interface LayerShape {
  readonly [key: string]: unknown;
}

/** Normalized layer-local coverage: 1-channel raster, white reveals. */
export interface LayerMask {
  readonly raster: Raster;
  readonly enabled: boolean;
  /** Where the mask sits once moved apart from its layer; null while it covers the layer's grid. */
  readonly placement: LayerTransform | null;
  readonly linked: boolean;
}

export interface Layer {
  readonly id: string;
  readonly name: string;
  readonly visible: boolean;
  /** Not an upstream concept; carried for the shared contract and always false from this editor. */
  readonly locked: boolean;
  readonly parentId: string | null;
  readonly isGroup: boolean;
  readonly opacity: number;
  readonly blendMode: BlendMode;
  readonly transform: LayerTransform;
  /** Pixels; null for groups, adjustments and blank layers that have not been painted yet. */
  readonly raster: Raster | null;
  readonly mask: LayerMask | null;
  /** Live alpha source (clipping mask base or another layer). */
  readonly maskSourceId: string | null;
  readonly adjustment: LayerAdjustment | null;
  readonly shape: LayerShape | null;
}

export interface CanvasDocument {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  /** Pixels per inch (Image Size); 72 by default. */
  readonly resolution: number;
  /** Bottom to top; groups are contiguous subtrees ordered by array position. */
  readonly layers: readonly Layer[];
  /** Part of the document so undo covers selection changes; never saved. */
  readonly selection: DocumentSelection | null;
}

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
    && a.maskSourceId === b.maskSourceId && jsonEqual(a.adjustment, b.adjustment) && jsonEqual(a.shape, b.shape));
}

export function documentsEqual(a: CanvasDocument | null, b: CanvasDocument | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.id !== b.id || a.width !== b.width || a.height !== b.height || a.resolution !== b.resolution) return false;
  if (a.selection !== b.selection) return false;
  if (a.layers.length !== b.layers.length) return false;
  return a.layers.every((layer, i) => layersEqual(layer, b.layers[i]!));
}

function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

export function newLayer(fields: Partial<Layer> & Pick<Layer, 'id' | 'name' | 'transform'>): Layer {
  return {
    visible: true, locked: false, parentId: null, isGroup: false, opacity: 1, blendMode: 'normal',
    raster: null, mask: null, maskSourceId: null, adjustment: null, shape: null, ...fields,
  };
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
  constructor(message = 'This is not a valid Compositor project, or its metadata is damaged.') { super(message); this.name = 'InvalidProjectError'; }
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
