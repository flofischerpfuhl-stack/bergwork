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
  AdjustmentKind, BlendMode, CanvasDocument, ColorLabel, CropParameters, EmbeddedLayer, FillParameters, Layer,
  LayerAdjustment, LayerEffect, LayerLocks, LayerMask, LayerShape, LiveFilter, TextRun, VectorMask, VectorPath,
  VectorStyle, WarpQuad,
} from './model';
export type {
  AdjustmentKind, Artboard, Guide, BlendMode, CanvasDocument, ColorLabel, CropParameters, DocumentResource, EmbeddedLayer,
  FillLayer, FillParameters, GroupLayer, Layer, LayerAdjustment, LayerEffect, LayerLocks, LayerMask, ModelLayer,
  LayerShape, LiveFilter, PixelLayer, TextLayer, VectorLayer, VectorMask, WarpQuad,
} from './model';

/** Photoshop menu groups; the first 13 modes came from upstream LayerBlendMode.allCases. */
export const BLEND_MODES: readonly { mode: BlendMode; label: string }[] = [
  { mode: 'normal', label: 'Normal' }, { mode: 'dissolve', label: 'Dissolve' },
  { mode: 'darken', label: 'Darken' }, { mode: 'multiply', label: 'Multiply' },
  { mode: 'colorBurn', label: 'Color Burn' }, { mode: 'linearBurn', label: 'Linear Burn' },
  { mode: 'darkerColor', label: 'Darker Color' },
  { mode: 'lighten', label: 'Lighten' }, { mode: 'screen', label: 'Screen' },
  { mode: 'colorDodge', label: 'Color Dodge' }, { mode: 'linearDodge', label: 'Linear Dodge (Add)' },
  { mode: 'lighterColor', label: 'Lighter Color' },
  { mode: 'overlay', label: 'Overlay' }, { mode: 'softLight', label: 'Soft Light' },
  { mode: 'hardLight', label: 'Hard Light' }, { mode: 'vividLight', label: 'Vivid Light' },
  { mode: 'linearLight', label: 'Linear Light' }, { mode: 'pinLight', label: 'Pin Light' },
  { mode: 'hardMix', label: 'Hard Mix' },
  { mode: 'difference', label: 'Difference' }, { mode: 'exclusion', label: 'Exclusion' },
  { mode: 'subtract', label: 'Subtract' }, { mode: 'divide', label: 'Divide' },
  { mode: 'hue', label: 'Hue' }, { mode: 'saturation', label: 'Saturation' },
  { mode: 'color', label: 'Color' }, { mode: 'luminosity', label: 'Luminosity' },
];
export const BLEND_MODE_SET: ReadonlySet<string> = new Set(BLEND_MODES.map((b) => b.mode));
export function blendLabel(mode: BlendMode): string { return BLEND_MODES.find((b) => b.mode === mode)?.label ?? mode; }

export const ADJUSTMENT_KINDS: readonly AdjustmentKind[] = ['Hue/Saturation', 'Levels', 'Curves', 'Exposure', 'Gradient Map', 'Grain'];

export const MAX_SIDE = 30_000;
export const MAX_PIXELS = 100_000_000;
export const PRO_MAX_SIDE = 60_000;
export const PRO_MAX_PIXELS = 300_000_000;
export const MAX_LAYERS = 10_000;
export const MAX_DEPTH = 64;

export interface DocumentLimits { readonly maxSide: number; readonly maxPixels: number }
export const LITE_DOCUMENT_LIMITS: DocumentLimits = { maxSide: MAX_SIDE, maxPixels: MAX_PIXELS };
export const PRO_DOCUMENT_LIMITS: DocumentLimits = { maxSide: PRO_MAX_SIDE, maxPixels: PRO_MAX_PIXELS };
export function documentLimits(profile: 'lite' | 'pro'): DocumentLimits {
  return profile === 'pro' ? PRO_DOCUMENT_LIMITS : LITE_DOCUMENT_LIMITS;
}

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
    && a.opacity === b.opacity && a.blendMode === b.blendMode && masksEqual(a.mask, b.mask)
    && a.kind === b.kind && (a.fillOpacity ?? 1) === (b.fillOpacity ?? 1) && jsonEqual(a.locks, b.locks)
    && (a.colorLabel ?? 'none') === (b.colorLabel ?? 'none')
    && jsonEqual(a.warp ?? null, b.warp ?? null) && jsonEqual(a.crop ?? null, b.crop ?? null)
    && jsonEqual(a.vectorMask ?? null, b.vectorMask ?? null)
    && jsonEqual(a.effects ?? [], b.effects ?? []) && jsonEqual(a.filters ?? [], b.filters ?? [])
    && a.maskSourceId === b.maskSourceId && jsonEqual(a.adjustment, b.adjustment)
    && jsonEqual(kindPayload(a), kindPayload(b)));
}

export function documentsEqual(a: CanvasDocument | null, b: CanvasDocument | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.id !== b.id || a.width !== b.width || a.height !== b.height || a.resolution !== b.resolution
    || !jsonEqual(a.artboards ?? [], b.artboards ?? []) || !jsonEqual(a.guides ?? [], b.guides ?? []) || !resourcesEqual(a.resources ?? [], b.resources ?? [])) return false;
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

export interface NewLayerFields {
  id: string;
  name: string;
  transform: LayerTransform;
  kind?: Layer['kind'];
  visible?: boolean;
  locked?: boolean;
  parentId?: string | null;
  opacity?: number;
  fillOpacity?: number;
  blendMode?: BlendMode;
  locks?: LayerLocks;
  colorLabel?: ColorLabel;
  warp?: WarpQuad | null;
  crop?: CropParameters | null;
  raster?: import('./raster').Raster | null;
  mask?: LayerMask | null;
  vectorMask?: VectorMask | null;
  maskSourceId?: string | null;
  effects?: readonly LayerEffect[];
  filters?: readonly LiveFilter[];
  adjustment?: LayerAdjustment;
  sourceShape?: LayerShape | null;
  fill?: FillParameters;
  paths?: readonly VectorPath[];
  style?: VectorStyle;
  text?: string;
  runs?: readonly TextRun[];
  box?: { readonly width: number; readonly height: number } | null;
  alignment?: 'left' | 'center' | 'right' | 'justify';
  content?: EmbeddedLayer['content'];
}

export function newLayer(fields: NewLayerFields): import('./model').ModelLayer {
  const kind = fields.kind ?? (fields.adjustment ? 'adjustment' : fields.sourceShape ? 'vector' : 'pixel');
  const base = {
    id: fields.id, name: fields.name, transform: fields.transform,
    visible: fields.visible ?? true, locked: fields.locked ?? false, parentId: fields.parentId ?? null,
    opacity: fields.opacity ?? 1, fillOpacity: fields.fillOpacity ?? 1,
    blendMode: 'normal' as const, locks: { transparency: false, pixels: false, position: false, all: false },
    colorLabel: 'none' as const, warp: null, crop: null, mask: null, vectorMask: null,
    maskSourceId: null, effects: [], filters: [],
    ...pickCommon(fields), kind,
  };
  switch (kind) {
    case 'pixel': return { ...base, kind, raster: fields.raster ?? null };
    case 'group': return { ...base, kind };
    case 'adjustment': {
      if (!fields.adjustment) throw new TypeError('An adjustment layer requires adjustment parameters.');
      return { ...base, kind, adjustment: fields.adjustment };
    }
    case 'fill': return { ...base, kind, fill: fields.fill
      ?? { kind: 'solid', schemaVersion: 1, color: { red: 0, green: 0, blue: 0 } } };
    case 'vector': return { ...base, kind, raster: fields.raster ?? null, paths: fields.paths ?? [],
      style: fields.style ?? { fill: null, stroke: null }, sourceShape: fields.sourceShape ?? null };
    case 'text': return { ...base, kind, raster: fields.raster ?? null, text: fields.text ?? '', runs: fields.runs ?? [],
      box: fields.box ?? null, alignment: fields.alignment ?? 'left' };
    case 'embedded': return { ...base, kind, raster: fields.raster ?? null,
      content: fields.content ?? { mode: 'embedded', mediaType: 'image', sourceName: '' } };
  }
}

/** Installs destructive pixel output without leaking raster fields onto non-raster union members. */
export function withLayerRaster(layer: Layer, raster: import('./raster').Raster,
  transform: LayerTransform = layer.transform, mask: LayerMask | null = layer.mask): Layer {
  if (layer.kind === 'pixel') return { ...layer, raster, transform, mask };
  if (layer.kind === 'vector' || layer.kind === 'text' || layer.kind === 'embedded') {
    return newLayer({ ...layer, kind: 'pixel', raster, transform, mask });
  }
  return layer;
}

function pickCommon(fields: NewLayerFields): Partial<import('./model').LayerCommon> {
  return {
    ...(fields.visible === undefined ? {} : { visible: fields.visible }),
    ...(fields.locked === undefined ? {} : { locked: fields.locked }),
    ...(fields.parentId === undefined ? {} : { parentId: fields.parentId }),
    ...(fields.opacity === undefined ? {} : { opacity: fields.opacity }),
    ...(fields.fillOpacity === undefined ? {} : { fillOpacity: fields.fillOpacity }),
    ...(fields.blendMode === undefined ? {} : { blendMode: fields.blendMode }),
    ...(fields.locks === undefined ? {} : { locks: fields.locks }),
    ...(fields.colorLabel === undefined ? {} : { colorLabel: fields.colorLabel }),
    ...(fields.warp === undefined ? {} : { warp: fields.warp }),
    ...(fields.crop === undefined ? {} : { crop: fields.crop }),
    ...(fields.mask === undefined ? {} : { mask: fields.mask }),
    ...(fields.vectorMask === undefined ? {} : { vectorMask: fields.vectorMask }),
    ...(fields.maskSourceId === undefined ? {} : { maskSourceId: fields.maskSourceId }),
    ...(fields.effects === undefined ? {} : { effects: fields.effects }),
    ...(fields.filters === undefined ? {} : { filters: fields.filters }),
  };
}

function kindPayload(layer: Layer): unknown {
  const model = layer as import('./model').ModelLayer;
  switch (layer.kind) {
    case 'fill': return (model as import('./model').FillLayer).fill;
    case 'vector': { const value = model as import('./model').VectorLayer;
      return { paths: value.paths, style: value.style, sourceShape: value.sourceShape }; }
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
      if (layer.kind === 'group' && !collapsed.has(layer.id)) visit(layer.id, depth + 1, effective);
    }
  };
  visit(null, 0, true);
  return result;
}

/** Visible pixel/adjustment layers in compositing order (CanvasDocument.renderLayers). */
export function renderLayers(layers: readonly Layer[]): Layer[] {
  return hierarchyEntries(layers).filter((e) => e.visible && e.layer.kind !== 'group').map((e) => e.layer);
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
  return { id: layer.id, parentId: layer.parentId, isGroup: layer.kind === 'group', hasImage: !!layer.raster,
    maskSourceId: layer.maskSourceId, isAdjustment: layer.kind === 'adjustment' };
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
      } else base = layer.kind === 'group' ? null : layer.id;
    }
  }
  for (let i = 0; i < layers.length; i++) {
    if (release.has(layers[i]!.id)) layers[i] = { ...layers[i]!, maskSourceId: null };
  }
}

/** A layer dropped between a base and a layer clipped to it joins that clipping group. */
export function adoptClipping(id: string, layers: Layer[]): void {
  const layer = layers.find((l) => l.id === id);
  if (!layer || layer.kind === 'group') return;
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
