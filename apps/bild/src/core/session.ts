/**
 * Editor session: document state, tools and every layer command. Ported from
 * Document/EditorSession.swift and its extensions (LayerGroups, LayerAppearance, LayerMask,
 * LiveLayerMask, LayerFlip, LayerMerge, SelectionClipboard duplicate commands, ColorPalette).
 *
 * The session is framework-free. Views subscribe to change notifications; the renderer reads the
 * current document and transient previews (transform drafts, blend previews) from here.
 */

import {
  adoptClipping, descendantIds, documentsEqual, effectiveVisibleIds, hierarchyEntries,
  isValidStructure, layerPixelHeight, layerPixelWidth, maskTransform, MAX_LAYERS, MAX_PIXELS, MAX_SIDE, newLayer,
  releaseDetachedClipping, renderLayers as renderLayersOf, uniqueName, usedPixels, withLayerRaster,
  ALL_ADJUSTMENT_KINDS, type AdjustmentKind, type LayerAdjustmentKind, type BlendMode, type CanvasDocument, type HierarchyEntry, type Layer, type LayerAdjustment,
  type LayerEffect, type LayerMask, type LiveFilter, BLEND_MODES,
  type DocumentLimits, type Guide, LITE_DOCUMENT_LIMITS,
} from './document';
import type { ColorLabel, LayerLocks } from './model';
import type { TextParagraphStyle, TextRunStyle } from './model';
import {
  apply, boundingBox, center, corners as transformCorners, following, invert, isValidTransform, makeTransform, mirrored,
  pixelToDocument, samePlacement, snapOffset, transformsEqual, type LayerTransform, type Point, type Rect, type Size,
} from './geometry';
import { DocumentHistory, type HistorySnapshot, type PersistedHistoryState } from './history';
import { uuid } from './ids';
import { alignOffsets, alignUnits, distributeOffsets, type AlignEdge, type AlignUnit, type DistributeMode } from './align';
import { artboardMembership } from './artboards';
import { translated } from './canvasOps';
import { selectionBounds } from './selectionOps';
import { Raster } from './raster';
import { CanvasViewport } from './viewport';
import { defaultAdjustment } from './adjustments';
import { cancelShape, redrawShapeLayer } from './shape';
import { vectorLayerWithTransform } from './vector/transform';
import { cancelGradient, hasPendingGradient, refreshGradientPalette, resolveGradient } from './gradient';
import { distortLayer, groupDistortTarget, maskBackground, warpMask } from './distort';
import { meshPoint } from './meshWarp';
import {
  effectiveLayerLocks, layerLockBlocker, preserveLayerTransparency,
  type LayerEditKind, type LayerLockBlocker,
} from './locks';
import { DEFAULT_TEXT_STYLE, defaultTextParagraphs } from './document';
import { applyParagraphStyle, applyTextStyle, convertTextBox, replaceTextRange, scaleTextWithTransform,
  type ParagraphStylePatch, type TextStylePatch } from './text/model';
import { isValidLayerEffect } from './effects/validate';

export type Tool =
  | 'move' | 'artboard' | 'marquee' | 'lasso' | 'wand' | 'objectSelect' | 'crop' | 'brush' | 'spotHealing' | 'cloneStamp' | 'blur'
  | 'gradient' | 'shape' | 'eyedropper' | 'hand' | 'zoom' | 'idle'
  | 'text' | 'pen' | 'directSelect' | 'warp' | 'straighten' | 'liquify';

export const TOOLS: readonly Tool[] = ['move', 'artboard', 'marquee', 'lasso', 'wand', 'objectSelect', 'crop', 'brush', 'spotHealing', 'cloneStamp',
  'blur', 'gradient', 'text', 'pen', 'directSelect', 'shape', 'eyedropper', 'hand', 'zoom'];

export const TOOL_LABELS: Record<Tool, string> = {
  move: 'Move / Transform (V)', artboard: 'Artboard Tool (Shift-V)', marquee: 'Marquee (M)', lasso: 'Lasso (L)', wand: 'Magic Wand (W)',
  objectSelect: 'Object Selection Tool (Shift-W)', crop: 'Crop (C)',
  brush: 'Brush (B) · Eraser (E)', spotHealing: 'Spot Healing Brush (J)',
  cloneStamp: 'Clone Stamp (S) · Option-click sets the source', blur: 'Smear (R)', gradient: 'Gradient (G)',
  shape: 'Shape (U) · Shift-U switches Rectangle/Ellipse/Polygon/Star/Line', eyedropper: 'Eyedropper (I)', hand: 'Hand (H)', zoom: 'Zoom (Z)',
  idle: 'No tool',
  text: 'Horizontal Type (T)',
  pen: 'Pen (P)', directSelect: 'Direct Selection (A) · Shift-A switches Path Selection',
  warp: 'Warp', straighten: 'Straighten', liquify: 'Liquify',
};

export function isBrushTool(tool: Tool): boolean { return tool === 'brush' || tool === 'spotHealing' || tool === 'cloneStamp' || tool === 'blur'; }
export function isSelectionTool(tool: Tool): boolean { return tool === 'marquee' || tool === 'lasso' || tool === 'wand' || tool === 'objectSelect'; }

export interface PaletteColor { readonly red: number; readonly green: number; readonly blue: number }
export const BLACK: PaletteColor = { red: 0, green: 0, blue: 0 };
export const WHITE: PaletteColor = { red: 1, green: 1, blue: 1 };
function colorsEqual(a: PaletteColor, b: PaletteColor): boolean { return a.red === b.red && a.green === b.green && a.blue === b.blue; }

export interface TransformGroup { readonly box: LayerTransform; readonly originals: ReadonlyMap<string, LayerTransform> }

export interface FloatingTransform {
  readonly sourceId: string;
  readonly before: CanvasDocument;
  readonly beforeActive: string | null;
  readonly original: LayerTransform;
  readonly pixelSize: Size;
}

export interface TransformEdit {
  readonly layerId: string;
  readonly draft: LayerTransform;
  readonly persistent: boolean;
  readonly floating?: FloatingTransform;
  /** Distort corners TL, TR, BR, BL in document pixels, once a handle is Cmd-dragged. */
  readonly corners?: readonly Point[];
  /** An unlinked mask transformed on its own. */
  readonly mask: boolean;
  readonly group?: TransformGroup;
}

/** 'overlay': only on-canvas guides changed (e.g. a crop frame inside the canvas); the composite stays valid. */
export type ChangeKind = 'document' | 'view' | 'ui' | 'overlay';

/** Pixels a tool shows in place of a layer's (or its mask's) stored raster while it works. */
export interface LayerPreview { readonly layerId: string; readonly mask: boolean; readonly raster: Raster; readonly transform: LayerTransform }
export type Listener = (kind: ChangeKind) => void;

/** Renderer/compositor capabilities the session needs for merges and bakes. */
export interface SessionServices {
  /** The whole canvas composited as shown (blend modes, masks, clipping, adjustments). */
  flatten(document: CanvasDocument): Promise<Raster>;
  /** A layer's pixels with only its live (clipping) coverage baked in. */
  bakeLiveMask(document: CanvasDocument, targetId: string): Promise<Raster | null>;
  /** Resamples pixels into a quadrilateral (Distort Apply). */
  distort?(raster: Raster, transform: LayerTransform, corners: readonly Point[]): Promise<{ raster: Raster; transform: LayerTransform }>;
  /** Asks what to do when deleted layers feed live masks; resolves 'bake', 'unlink' or 'cancel'. */
  confirmLiveMaskDeletion?(count: number): Promise<'bake' | 'unlink' | 'cancel'>;
  /** Translates generated names ('Layer', 'Folder', adjustment kinds, 'copy', 'Untitled') into the UI language. */
  label?(text: string): string;
  /** Async storage boundary used before existing synchronous commands touch raster bytes. */
  residency?: {
    ensureResident(rasters: Iterable<Raster>, rect?: Rect): Promise<{ release(): void }>;
    ensureResidentRegions?(regions: Iterable<{ raster: Raster; rect?: Rect }>): Promise<{ release(): void }>;
  };
  limits?: DocumentLimits;
}

export type RasterCommandKind = 'brush' | 'fill' | 'filter' | 'adjustment' | 'transform'
  | 'clipboard' | 'clipboardMerged' | 'export' | 'save' | 'history';

/** Open edits outside the session (adjustment and filter panels) that make the document read-only meanwhile. */
export const editBlockers: ((session: EditorSession) => boolean)[] = [];
/** Pending external edits can consume Undo now and perform it once their transaction lands. */
export const pendingUndoHandlers: ((session: EditorSession) => boolean)[] = [];
/** Pixels derived from editable layer content (text shaped by the lazily loaded engine, PRODUCT-PLAN A5). */
export interface DerivedLayerPixels { readonly raster: Raster; readonly transform: LayerTransform }
export const derivedLayerSources: ((session: EditorSession, layer: Layer) => DerivedLayerPixels | null)[] = [];
/** Where a vector layer's derived pixels sit for a placement of the layer: strokes and markers reach past its box. */
export const derivedPlacements: ((session: EditorSession, layer: Layer, transform: LayerTransform) => LayerTransform | null)[] = [];
/** Masks derived from editable content (vector masks); they cover the layer's displayed grid (placement null). */
export const derivedMaskSources: ((session: EditorSession, layer: Layer) => Raster | null)[] = [];

export class EditorSession {
  document: CanvasDocument | null = null;
  readonly history: DocumentHistory;
  readonly viewport = new CanvasViewport();
  tool: Tool = 'move';
  activeLayerId: string | null = null;
  selectedLayerIds: ReadonlySet<string> = new Set();
  isMaskSelected = false;
  collapsedGroupIds: ReadonlySet<string> = new Set();
  transformEdit: TransformEdit | null = null;
  /** The Crop tool's frame (document pixels) and ratio choice (Crop.swift). */
  cropRect: Rect | null = null;
  cropRatioChoice = 'Free';
  transformDuplicate: { copy: string; source: string } | null = null;
  snapGuides: { xs: number[]; ys: number[] } = { xs: [], ys: [] };
  locksTransformRatio = true;
  transformAutoSelect = false;
  /** Edit › Transform › Perspective constrains paired quad corners until apply/cancel. */
  perspectiveConstrained = false;
  showsTransformControls = true;
  showsPixelGrid = true;
  blendPreview: { layerId: string; mode: BlendMode } | null = null;
  opacityEditLayerId: string | null = null;
  fillOpacityEditLayerIds: readonly string[] | null = null;
  layerEffectEditId: string | null = null;
  globalLightEdit = false;
  copiedLayerStyle: readonly LayerEffect[] | null = null;
  renamingLayerId: string | null = null;
  adjustmentEditingId: string | null = null;
  private liveFilterEdit: { readonly layerId: string; readonly original: readonly LiveFilter[] } | null = null;
  foregroundColor: PaletteColor = BLACK;
  backgroundColor: PaletteColor = WHITE;
  maskPaintWhite = false;
  /** Blocks overlapping edits (import, merge, export). */
  isProjectBusy = false;
  isImporting = false;
  errorMessage: string | null = null;
  /** Last structured refusal; command surfaces may translate `code` and fall back to `message`. */
  lastEditBlocker: LayerLockBlocker | null = null;
  projectName: string | null = null;
  pendingOpacityDigit: { digit: number; time: number } | null = null;
  services: SessionServices | null = null;
  /** Pixels a tool is previewing in place of a layer's stored raster (brush strokes, moves, filters). */
  rasterOverrides = new Map<string, Raster>();
  maskOverrides = new Map<string, Raster>();
  /** Placement for an overridden raster whose working grid differs from the layer's. */
  transformOverrides = new Map<string, LayerTransform>();
  /**
   * Live previews queried on every draw (strokes, pending gradients); unlike the override maps they
   * can never go stale when a tool's state is resolved elsewhere.
   */
  previewSources: ((session: EditorSession) => LayerPreview | null)[] = [];
  private livePreview(layerId: string): LayerPreview | null {
    for (const source of this.previewSources) {
      const preview = source(this);
      if (preview && preview.layerId === layerId) return preview;
    }
    return null;
  }
  /** Tool previews with their own drawing (lasso drafts, gradient lines…) ask the canvas to redraw. */
  overlayRevision = 0;
  /** Called after long-running edits so the canvas can redraw immediately. */
  private listeners = new Set<Listener>();
  private revisionValue = 0;

  constructor(services?: SessionServices, historyOptions: { enabled?: boolean; retainedByteLimit?: number; entryLimit?: number } = {}) {
    this.services = services ?? null;
    this.history = new DocumentHistory(historyOptions.entryLimit, historyOptions.retainedByteLimit, historyOptions.enabled);
  }

  // MARK: Observation

  get revision(): number { return this.revisionValue; }
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  notify(kind: ChangeKind = 'ui'): void {
    this.revisionValue++;
    for (const listener of [...this.listeners]) listener(kind);
  }
  private changed(): void { this.notify('document'); }

  // MARK: Derived state

  get activeLayer(): Layer | null {
    const id = this.activeLayerId;
    return id ? this.document?.layers.find((l) => l.id === id) ?? null : null;
  }
  layer(id: string | null | undefined): Layer | null { return id ? this.document?.layers.find((l) => l.id === id) ?? null : null; }
  get isModified(): boolean { return this.history.isModified; }
  get selection() { return this.document?.selection ?? null; }
  get limits(): DocumentLimits { return this.services?.limits ?? LITE_DOCUMENT_LIMITS; }

  get canEditLayers(): boolean {
    return this.document !== null && !editBlockers.some((blocks) => blocks(this)) && !this.isProjectBusy && !this.isImporting && this.renamingLayerId === null
      && this.transformEdit === null && this.cropRect === null && this.adjustmentEditingId === null && !hasPendingGradient(this);
  }
  get canUseHistory(): boolean {
    return !editBlockers.some((blocks) => blocks(this)) && !this.isProjectBusy && !this.isImporting && this.renamingLayerId === null && this.transformEdit === null
      && !this.history.isInTransaction;
  }
  get canUndo(): boolean { return this.canUseHistory && (this.history.canUndo || hasPendingGradient(this)); }
  get canRedo(): boolean { return this.canUseHistory && this.history.canRedo; }
  get canEditAppearance(): boolean {
    return this.canEditLayers && this.selectedLayerIds.size === 1 && !!this.activeLayer && this.activeLayer.kind !== 'group'
      && !this.editBlocker(this.activeLayer.id, 'appearance');
  }
  get canEditMask(): boolean { return this.canEditLayers && this.selectedLayerIds.size === 1 && this.activeLayer !== null; }
  get canStartProjectOperation(): boolean {
    return !editBlockers.some((blocks) => blocks(this)) && !this.isProjectBusy && !this.isImporting
      && this.renamingLayerId === null && this.adjustmentEditingId === null;
  }

  get layerRows(): HierarchyEntry[] {
    return hierarchyEntries(this.document?.layers ?? [], true, this.collapsedGroupIds);
  }

  lockState(id: string): LayerLocks {
    return this.document ? effectiveLayerLocks(this.document, id)
      : { transparency: false, pixels: false, position: false, all: false };
  }
  editBlocker(id: string, kind: LayerEditKind): LayerLockBlocker | null {
    return this.document ? layerLockBlocker(this.document, id, kind) : null;
  }
  /** Records a blocker only when an edit is actually attempted. */
  refuseLayerEdit(id: string, kind: LayerEditKind): boolean {
    const blocker = this.editBlocker(id, kind);
    if (!blocker) return false;
    this.lastEditBlocker = blocker;
    this.notify('ui');
    return true;
  }

  // MARK: Transactions

  beginEdit(name: string): void { this.history.begin(name, this.document, this.activeLayerId); }
  endEdit(): void {
    this.history.end(this.document, this.activeLayerId);
    this.changed();
  }
  /** Runs `body` as one undo step. */
  edit(name: string, body: () => void): void {
    this.beginEdit(name);
    try { body(); } finally { this.endEdit(); }
  }

  /** The complete synchronous pixel input set for one command dispatch. */
  rastersForCommand(kind: RasterCommandKind): Raster[] {
    const document = this.document;
    if (!document) return [];
    const result = new Set<Raster>();
    const addLayer = (layer: Layer | null | undefined) => {
      if (!layer) return;
      if (layer.raster) result.add(layer.raster);
      const displayed = this.displayedRaster(layer);
      if (displayed) result.add(displayed);
      if (layer.mask?.enabled) result.add(layer.mask.raster);
      const displayedMask = this.displayedMaskRaster(layer);
      if (layer.mask?.enabled && displayedMask) result.add(displayedMask);
      if (layer.maskSourceId) {
        const base = document.layers.find((candidate) => candidate.id === layer.maskSourceId);
        addLayer(base);
      }
    };
    const addDocument = (value: CanvasDocument | null) => {
      if (!value) return;
      for (const layer of value.layers) addLayer(layer);
      if (value.selection) result.add(value.selection.mask);
    };
    if (kind === 'save') {
      addDocument(document);
      const history = this.history.exportState();
      for (const entry of [...history.past, ...history.future]) {
        addDocument(entry.before.document);
        addDocument(entry.after.document);
      }
    } else if (kind === 'export' || kind === 'clipboardMerged' || kind === 'adjustment') {
      for (const layer of renderLayersOf(document.layers)) addLayer(layer);
    } else {
      const ids = this.selectedLayerIds.size ? this.selectedLayerIds : new Set(this.activeLayerId ? [this.activeLayerId] : []);
      for (const id of ids) addLayer(document.layers.find((layer) => layer.id === id));
    }
    if (kind !== 'save' && document.selection) result.add(document.selection.mask);
    return [...result];
  }

  /** Maps a document-space tool bound into each input's own pixel grid. */
  rasterRegionsForCommand(kind: RasterCommandKind, documentRect: Rect): { raster: Raster; rect: Rect }[] {
    const document = this.document;
    if (!document) return [];
    const wanted = new Set(this.rastersForCommand(kind));
    const result = new Map<Raster, Rect>();
    const map = (raster: Raster, transform: LayerTransform) => {
      if (!wanted.has(raster)) return;
      const inverse = invert(pixelToDocument(transform, raster.width, raster.height));
      const points = [
        apply(inverse, { x: documentRect.x, y: documentRect.y }),
        apply(inverse, { x: documentRect.x + documentRect.width, y: documentRect.y }),
        apply(inverse, { x: documentRect.x + documentRect.width, y: documentRect.y + documentRect.height }),
        apply(inverse, { x: documentRect.x, y: documentRect.y + documentRect.height }),
      ];
      const x = Math.floor(Math.min(...points.map((point) => point.x)));
      const y = Math.floor(Math.min(...points.map((point) => point.y)));
      const right = Math.ceil(Math.max(...points.map((point) => point.x)));
      const bottom = Math.ceil(Math.max(...points.map((point) => point.y)));
      const next = { x, y, width: right - x, height: bottom - y };
      const old = result.get(raster);
      result.set(raster, old ? {
        x: Math.min(old.x, next.x), y: Math.min(old.y, next.y),
        width: Math.max(old.x + old.width, next.x + next.width) - Math.min(old.x, next.x),
        height: Math.max(old.y + old.height, next.y + next.height) - Math.min(old.y, next.y),
      } : next);
    };
    for (const layer of document.layers) {
      if (layer.raster) map(layer.raster, layer.transform);
      const derived = this.derivedPixels(layer);
      if (derived) map(derived.raster, derived.transform);
      const override = this.rasterOverrides.get(layer.id);
      if (override) map(override, this.transformOverrides.get(layer.id) ?? layer.transform);
      if (layer.mask) map(layer.mask.raster, maskTransform(layer));
      const maskOverride = this.maskOverrides.get(layer.id);
      if (maskOverride) map(maskOverride, maskTransform(layer));
    }
    if (document.selection && wanted.has(document.selection.mask)) {
      result.set(document.selection.mask, {
        x: documentRect.x - document.selection.x, y: documentRect.y - document.selection.y,
        width: documentRect.width, height: documentRect.height,
      });
    }
    return [...result].map(([raster, rect]) => ({ raster, rect }));
  }

  /** Hydrates, pins, executes, then unpins at the one async→sync command boundary. */
  async runHydrated<T>(kind: RasterCommandKind, body: () => T | Promise<T>, rect?: Rect): Promise<T> {
    const residency = this.services?.residency;
    const lease = rect && residency?.ensureResidentRegions
      ? await residency.ensureResidentRegions(this.rasterRegionsForCommand(kind, rect))
      : await residency?.ensureResident(this.rastersForCommand(kind), rect);
    try { return await body(); }
    finally { lease?.release(); }
  }

  private setLayers(layers: readonly Layer[]): void {
    if (!this.document) return;
    this.document = { ...this.document, layers };
  }
  private updateLayer(id: string, update: (layer: Layer) => Layer): void {
    if (!this.document) return;
    const index = this.document.layers.findIndex((l) => l.id === id);
    if (index < 0) return;
    const layers = this.document.layers.slice();
    layers[index] = update(layers[index]!);
    this.setLayers(layers);
  }

  /** Live mesh-handle preview; the feature restores `original` before creating the single history item. */
  previewLayerWarp(id: string, warp: Layer['warp']): boolean {
    const layer = this.layer(id);
    if (!layer || layer.kind === 'group' || this.editBlocker(id, 'position')) return false;
    this.updateLayer(id, (value) => ({ ...value, warp }));
    this.notify('document');
    return true;
  }

  commitLayerWarp(id: string, original: Layer['warp'], warp: Layer['warp'], name = 'Warp'): boolean {
    const layer = this.layer(id);
    if (!layer || layer.kind === 'group' || this.editBlocker(id, 'position')) return false;
    this.updateLayer(id, (value) => ({ ...value, warp: original }));
    this.edit(name, () => this.updateLayer(id, (value) => ({ ...value, warp })));
    this.notify('document');
    return true;
  }

  setActiveLayer(id: string | null): void {
    if (id !== this.activeLayerId) this.isMaskSelected = false;
    this.activeLayerId = id;
    this.selectedLayerIds = new Set(id ? [id] : []);
  }

  private targetLayers(ids: Iterable<string>): Layer[] | null {
    const document = this.document;
    if (!document) return null;
    const wanted = new Set(ids);
    if (!wanted.size) return null;
    const targets = document.layers.filter((layer) => wanted.has(layer.id));
    return targets.length === wanted.size ? targets : null;
  }

  // MARK: Undo

  undo(): boolean {
    if (pendingUndoHandlers.some((handle) => handle(this))) return true;
    // Gradient.swift / EditorSession.swift: the first Undo only discards the pending preview.
    if (this.canUseHistory && cancelGradient(this)) return true;
    if (!this.canUndo) return false;
    const snapshot = this.history.undo();
    if (!snapshot) return false;
    this.restore(snapshot);
    return true;
  }
  redo(): boolean {
    if (!this.canRedo) return false;
    const snapshot = this.history.redo();
    if (!snapshot) return false;
    this.restore(snapshot);
    return true;
  }
  private restore(snapshot: HistorySnapshot): void {
    this.cropRect = null;
    const changedCanvas = this.document?.id !== snapshot.document?.id;
    const keepMaskTarget = this.isMaskSelected && this.activeLayerId === snapshot.activeLayerId;
    this.document = snapshot.document;
    this.setActiveLayer(snapshot.activeLayerId);
    this.isMaskSelected = keepMaskTarget && !!this.activeLayer?.mask;
    if (changedCanvas && this.document) this.viewport.fit(this.document);
    this.changed();
  }

  // MARK: Documents

  createDocument(width: number, height: number, emptyLayer = false): void {
    if (this.isProjectBusy || this.isImporting || !(width >= 1 && width <= this.limits.maxSide && height >= 1 && height <= this.limits.maxSide)
      || width * height > this.limits.maxPixels) return;
    this.commitTransform();
    this.beginEdit('New Canvas');
    const document: CanvasDocument = { id: uuid(), width, height, resolution: 72, layers: [], artboards: [], selection: null };
    const layer = emptyLayer ? newLayer({ id: uuid(), name: `${this.label('Layer')} 1`, transform: makeTransform({ x: 0, y: 0 }, { width, height }) }) : null;
    this.document = layer ? { ...document, layers: [layer] } : document;
    this.setActiveLayer(layer?.id ?? null);
    this.renamingLayerId = null;
    this.viewport.fit(this.document);
    this.endEdit();
  }

  /** File > New as a fresh project: clean history, one blank layer. */
  createNewProject(width: number, height: number, name?: string): void {
    this.clearProject();
    this.createDocument(width, height, true);
    this.history.reset();
    if (name) this.projectName = name;
    this.changed();
  }

  clearProject(): void {
    this.collapsedGroupIds = new Set();
    this.isMaskSelected = false;
    this.transformEdit = null;
    this.document = null;
    this.setActiveLayer(null);
    this.renamingLayerId = null;
    this.projectName = null;
    this.history.reset();
    this.changed();
  }

  /** Installs a validated project and its optional saved command history. */
  installProject(document: CanvasDocument, activeLayerId: string | null, name: string | null, history?: PersistedHistoryState): void {
    this.collapsedGroupIds = new Set();
    this.isMaskSelected = false;
    this.transformEdit = null;
    this.document = document;
    this.setActiveLayer(activeLayerId && document.layers.some((l) => l.id === activeLayerId) ? activeLayerId : null);
    this.projectName = name;
    this.renamingLayerId = null;
    if (history) this.history.importState(history, document); else this.history.reset();
    this.viewport.fit(document);
    this.changed();
  }

  // MARK: Layers

  /** Adds decoded pixels as a new layer centred at `point` (or the canvas centre), creating the canvas if needed. */
  insertRaster(raster: Raster, name: string, point?: Point | null): string {
    this.beginEdit('Import Image');
    try {
      if (!this.document) {
        this.document = { id: uuid(), width: raster.width, height: raster.height, resolution: 72, layers: [], artboards: [], selection: null };
        this.viewport.fit(this.document);
        point = null;
      }
      const document = this.document;
      const c = point ?? { x: document.width / 2, y: document.height / 2 };
      const layer = newLayer({
        id: uuid(), name, raster,
        transform: makeTransform({ x: Math.floor(c.x - raster.width / 2), y: Math.floor(c.y - raster.height / 2) }, { width: raster.width, height: raster.height }),
        parentId: this.activeLayer?.kind === 'group' ? this.activeLayerId : this.activeLayer?.parentId ?? null,
      });
      if (layer.parentId) this.expand(layer.parentId);
      this.setLayers([...document.layers, layer]);
      this.setActiveLayer(layer.id);
      return layer.id;
    } finally { this.endEdit(); }
  }

  remainingPixelBudget(): number { return this.limits.maxPixels - usedPixels(this.document?.layers ?? []); }

  addBlankLayer(): void {
    const document = this.document;
    if (!this.canEditLayers || !document) return;
    const active = this.activeLayer;
    const layer = newLayer({
      id: uuid(), name: uniqueName(document.layers, this.label('Layer')),
      transform: makeTransform({ x: 0, y: 0 }, { width: document.width, height: document.height }),
      parentId: active?.kind === 'group' ? this.activeLayerId : active?.parentId ?? null,
    });
    if (layer.parentId) this.expand(layer.parentId);
    let insertion = document.layers.findIndex((l) => l.id === this.activeLayerId);
    insertion = insertion >= 0 ? insertion + 1 : document.layers.length;
    if (active?.kind === 'group') {
      const inside = descendantIds(document.layers, active.id);
      let topmost = -1;
      document.layers.forEach((l, i) => { if (inside.has(l.id)) topmost = i; });
      if (topmost >= 0) insertion = Math.max(insertion, topmost + 1);
    }
    this.edit('New Blank Layer', () => {
      const layers = document.layers.slice();
      layers.splice(insertion, 0, layer);
      this.setLayers(layers);
      this.setActiveLayer(layer.id);
    });
  }

  addGroup(): void {
    const document = this.document;
    if (!this.canEditLayers || !document || document.layers.length >= MAX_LAYERS) return;
    const active = this.activeLayer;
    const group = newLayer({
      id: uuid(), name: uniqueName(document.layers, this.label('Folder')), kind: 'group',
      transform: makeTransform({ x: 0, y: 0 }, { width: document.width, height: document.height }),
      parentId: active?.kind === 'group' ? this.activeLayerId : active?.parentId ?? null,
    });
    const layers = document.layers.slice();
    const index = layers.findIndex((l) => l.id === this.activeLayerId);
    layers.splice(index >= 0 ? index + 1 : layers.length, 0, group);
    if (!isValidStructure(layers)) return;
    this.edit('New Folder', () => {
      this.setLayers(layers);
      this.setActiveLayer(group.id);
      if (group.parentId) this.expand(group.parentId);
    });
  }

  // MARK: Text layers (PRODUCT-PLAN A5)

  private insertTextLayer(text: string, transform: LayerTransform, box: { width: number; height: number } | null,
    style: TextRunStyle): string | null {
    const document = this.document;
    if (!this.canEditLayers || !document || document.layers.length >= MAX_LAYERS) return null;
    const active = this.activeLayer;
    const layer = newLayer({ id: uuid(), name: uniqueName(document.layers, this.label('Text')), kind: 'text', text,
      runs: text.length ? [{ from: 0, to: text.length, style }] : [], paragraphs: defaultTextParagraphs(text), box,
      transform, parentId: active?.kind === 'group' ? active.id : active?.parentId ?? null });
    const index = document.layers.findIndex((value) => value.id === this.activeLayerId);
    this.edit(box ? 'New Area Text' : 'New Point Text', () => {
      const layers = document.layers.slice();
      layers.splice(index >= 0 ? index + 1 : layers.length, 0, layer);
      this.setLayers(layers); this.setActiveLayer(layer.id);
      if (layer.parentId) this.expand(layer.parentId);
    });
    return layer.id;
  }

  createPointText(position: Point, text = '', style: TextRunStyle = DEFAULT_TEXT_STYLE): string | null {
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) throw new RangeError('Text position must be finite');
    const resolution = this.document?.resolution ?? 72;
    const pixels = style.fontSize * resolution / 72;
    const width = Math.max(1, text.length * pixels * 0.6), height = Math.max(1, (style.leading ?? style.fontSize * 1.2) * resolution / 72);
    return this.insertTextLayer(text, makeTransform(position, { width, height }), null, style);
  }

  createAreaText(rect: Rect, text = '', style: TextRunStyle = DEFAULT_TEXT_STYLE): string | null {
    if (!(rect.width > 0) || !(rect.height > 0) || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) {
      throw new RangeError('Area text rectangle must have positive finite dimensions');
    }
    return this.insertTextLayer(text, makeTransform({ x: rect.x, y: rect.y }, { width: rect.width, height: rect.height }),
      { width: rect.width, height: rect.height }, style);
  }

  replaceText(id: string, from: number, to: number, replacement: string): void {
    const layer = this.layer(id);
    if (layer?.kind !== 'text' || this.refuseLayerEdit(id, 'pixels')) return;
    const next = replaceTextRange(layer, from, to, replacement);
    this.edit('Edit Text', () => this.updateLayer(id, () => next));
  }

  applyTextStyle(id: string, from: number, to: number, patch: TextStylePatch): void {
    const layer = this.layer(id);
    if (layer?.kind !== 'text' || this.refuseLayerEdit(id, 'pixels')) return;
    const next = applyTextStyle(layer, from, to, patch);
    if (next === layer) return;
    this.edit('Format Text', () => this.updateLayer(id, () => next));
  }

  changeParagraphSettings(id: string, from: number, to: number,
    patch: ParagraphStylePatch | Partial<TextParagraphStyle>): void {
    const layer = this.layer(id);
    if (layer?.kind !== 'text' || this.refuseLayerEdit(id, 'pixels')) return;
    const next = applyParagraphStyle(layer, from, to, patch);
    this.edit('Format Paragraph', () => this.updateLayer(id, () => next));
  }

  convertTextKind(id: string, box: { width: number; height: number } | null): void {
    const layer = this.layer(id);
    if (layer?.kind !== 'text' || this.refuseLayerEdit(id, 'pixels')) return;
    const next = convertTextBox(layer, box);
    this.edit(box ? 'Convert to Area Text' : 'Convert to Point Text', () => this.updateLayer(id, () => next));
  }

  rasterizeTextLayer(id: string, raster: Raster, transform?: LayerTransform): void {
    const layer = this.layer(id);
    if (layer?.kind !== 'text' || this.refuseLayerEdit(id, 'pixels')) return;
    this.edit('Rasterize Text', () => this.updateLayer(id, (value) => withLayerRaster(value, raster, transform ?? value.transform)));
  }

  /** Wraps the selected layers (a selected folder brings its subtree) in a new folder (groupSelectedLayers). */
  groupSelectedLayers(): void {
    const document = this.document;
    if (!this.canEditLayers || !document || document.layers.length >= MAX_LAYERS) return;
    const byId = new Map(document.layers.map((l) => [l.id, l]));
    const selected = new Set([...this.selectedLayerIds].filter((id) => byId.has(id)));
    const ancestors = (id: string): (string | null)[] => {
      const result: (string | null)[] = [];
      let parent = byId.get(id)?.parentId ?? null;
      while (parent) { result.push(parent); parent = byId.get(parent)?.parentId ?? null; }
      result.push(null);
      return result;
    };
    const rootIds = new Set([...selected].filter((id) => !ancestors(id).some((a) => a !== null && selected.has(a))));
    const ordered = hierarchyEntries(document.layers).map((e) => e.layer.id).filter((id) => rootIds.has(id));
    let parent: string | null = null;
    if (ordered.length) {
      parent = ancestors(ordered[0]!).find((candidate) => ordered.every((id) => ancestors(id).includes(candidate))) ?? null;
    }
    const group = newLayer({
      id: uuid(), name: uniqueName(document.layers, this.label('Folder')), kind: 'group', parentId: parent,
      transform: makeTransform({ x: 0, y: 0 }, { width: document.width, height: document.height }),
    });
    const branches = ordered.map((id) => {
      let branch = id;
      for (;;) {
        const next = byId.get(branch)?.parentId ?? null;
        if (next === null || next === parent) break;
        branch = next;
      }
      return branch;
    });
    let highest = -1;
    document.layers.forEach((l, i) => { if (branches.includes(l.id)) highest = i; });
    const insertion = highest >= 0 ? document.layers.slice(0, highest + 1).filter((l) => !rootIds.has(l.id)).length : document.layers.length;
    const layers = document.layers.filter((l) => !rootIds.has(l.id));
    layers.splice(Math.min(insertion, layers.length), 0, group);
    for (const id of ordered) {
      const child = byId.get(id);
      if (child) layers.push({ ...child, parentId: group.id });
    }
    if (!isValidStructure(layers)) return;
    this.edit('Group Layers', () => {
      this.setLayers(layers);
      this.setActiveLayer(group.id);
      if (parent) this.expand(parent);
    });
  }

  private expand(id: string): void {
    if (!this.collapsedGroupIds.has(id)) return;
    const next = new Set(this.collapsedGroupIds);
    next.delete(id);
    this.collapsedGroupIds = next;
  }

  toggleGroupExpansion(id: string): void {
    if (this.isProjectBusy || this.layer(id)?.kind !== 'group') return;
    const next = new Set(this.collapsedGroupIds);
    if (next.has(id)) next.delete(id);
    else {
      if (this.activeLayerId && descendantIds(this.document!.layers, id).has(this.activeLayerId)) this.selectLayer(id);
      next.add(id);
    }
    this.collapsedGroupIds = next;
    this.notify('ui');
  }

  selectLayer(id: string | null): void {
    if (id !== this.activeLayerId) { resolveGradient(this); this.commitTransform(); }
    this.setActiveLayer(id);
    this.notify('ui');
  }

  selectLayers(ids: Iterable<string>, primary: string | null): void {
    const valid = new Set([...ids].filter((id) => this.document?.layers.some((l) => l.id === id)));
    const same = valid.size === this.selectedLayerIds.size && [...valid].every((id) => this.selectedLayerIds.has(id));
    if (!same) { resolveGradient(this); this.commitTransform(); }
    const active = primary && valid.has(primary) ? primary : valid.values().next().value ?? null;
    if (active !== this.activeLayerId) this.isMaskSelected = false;
    this.activeLayerId = active;
    this.selectedLayerIds = valid;
    this.notify('ui');
  }

  /** Clicking a thumbnail targets the layer's image or its mask (selectLayerTarget). */
  selectLayerTarget(id: string, mask: boolean): void {
    if (this.isProjectBusy || this.isImporting) return;
    resolveGradient(this);
    this.selectLayer(id);
    this.isMaskSelected = mask && !!this.activeLayer?.mask;
    this.notify('ui');
  }

  renameLayer(id: string, name: string): void {
    const trimmed = name.trim();
    if (this.isProjectBusy || this.isImporting || !trimmed || !this.layer(id)) return;
    this.edit('Rename Layer', () => this.updateLayer(id, (l) => ({ ...l, name: trimmed })));
  }

  toggleLayerVisibility(id: string): void {
    const layer = this.layer(id);
    if (!this.canEditLayers || !layer) return;
    this.edit(layer.visible ? 'Hide Layer' : 'Show Layer', () => this.updateLayer(id, (l) => ({ ...l, visible: !l.visible })));
  }

  /** Photoshop's eye swipe: one undo step from press to release. */
  beginVisibilitySwipe(id: string): boolean | null {
    const layer = this.layer(id);
    if (!this.canEditLayers || !layer) return null;
    const visible = !layer.visible;
    this.beginEdit(visible ? 'Show Layer' : 'Hide Layer');
    this.setVisibilityInSwipe(id, visible);
    return visible;
  }
  setVisibilityInSwipe(id: string, visible: boolean): void {
    const layer = this.layer(id);
    if (!layer || layer.visible === visible) return;
    this.updateLayer(id, (l) => ({ ...l, visible }));
    this.changed();
  }
  endVisibilitySwipe(): void { this.endEdit(); }

  canMoveActiveLayer(offset: number): boolean {
    const active = this.activeLayer;
    if (!this.canEditLayers || !active) return false;
    const siblings = this.document!.layers.filter((l) => l.parentId === active.parentId);
    const index = siblings.findIndex((l) => l.id === active.id);
    return index + offset >= 0 && index + offset < siblings.length;
  }
  moveActiveLayer(offset: number): void {
    if (!this.canMoveActiveLayer(offset)) return;
    const active = this.activeLayer!;
    const layers = this.document!.layers.slice();
    const siblings = layers.filter((l) => l.parentId === active.parentId);
    const index = siblings.findIndex((l) => l.id === active.id);
    const a = layers.findIndex((l) => l.id === active.id);
    const b = layers.findIndex((l) => l.id === siblings[index + offset]!.id);
    [layers[a], layers[b]] = [layers[b]!, layers[a]!];
    this.edit('Reorder Layers', () => this.setLayers(layers));
  }

  canPlaceLayer(id: string, parent: string | null): boolean {
    if (!this.canEditLayers || !this.layer(id)) return false;
    if (parent === null) return true;
    return parent !== id && !descendantIds(this.document!.layers, id).has(parent) && this.layer(parent)?.kind === 'group';
  }

  /** Moves a layer (with its subtree when a folder) into `parent`, above `target` or at the bottom. */
  placeLayer(id: string, parent: string | null, above: string | null = null, atBottom = false): boolean {
    if (!this.canPlaceLayer(id, parent) || above === id) return false;
    const layers = this.document!.layers.slice();
    const moving = new Set([id, ...descendantIds(layers, id)]);
    const block = layers.filter((l) => moving.has(l.id));
    const rest = layers.filter((l) => !moving.has(l.id));
    const head = { ...block.find((l) => l.id === id)!, parentId: parent };
    const moved = block.map((l) => (l.id === id ? head : l));
    let insertion = atBottom ? 0 : rest.length;
    if (above) {
      const targetIndex = rest.findIndex((l) => l.id === above && l.parentId === parent);
      if (targetIndex < 0) return false;
      // Above a folder means above its whole subtree.
      const targetSubtree = descendantIds(rest, above);
      let last = targetIndex;
      rest.forEach((l, i) => { if (targetSubtree.has(l.id)) last = Math.max(last, i); });
      insertion = last + 1;
    } else if (!atBottom && parent) {
      // Into a folder: on top of its contents.
      const inside = descendantIds(rest, parent);
      let last = rest.findIndex((l) => l.id === parent);
      rest.forEach((l, i) => { if (inside.has(l.id)) last = Math.max(last, i); });
      insertion = last + 1;
    } else if (atBottom && parent) {
      insertion = rest.findIndex((l) => l.id === parent);
    }
    rest.splice(insertion, 0, ...moved);
    adoptClipping(id, rest);
    releaseDetachedClipping(rest);
    if (!isValidStructure(rest)) return false;
    this.edit('Move Layer', () => {
      this.setLayers(rest);
      this.setActiveLayer(id);
      if (parent) this.expand(parent);
    });
    return true;
  }

  moveActiveLayerOutOfGroup(): void {
    const layer = this.activeLayer;
    const group = this.layer(layer?.parentId);
    if (!layer || !group) return;
    this.placeLayer(layer.id, group.parentId, group.id);
  }

  duplicateActiveLayer(): void {
    const layer = this.activeLayer;
    const document = this.document;
    if (!this.canEditLayers || !layer || layer.kind === 'group' || !document) return;
    const index = document.layers.findIndex((l) => l.id === layer.id);
    const copy: Layer = { ...layer, id: uuid(), name: `${layer.name} ${this.label('copy')}` };
    this.edit('Duplicate Layer', () => {
      const layers = document.layers.slice();
      layers.splice(index + 1, 0, copy);
      this.setLayers(layers);
      this.setActiveLayer(copy.id);
    });
  }

  duplicateLayer(id: string, parent: string | null, above: string | null = null, atBottom = false): boolean {
    const layer = this.layer(id);
    if (!this.canEditLayers || !layer || layer.kind === 'group' || !this.canPlaceLayer(id, parent)) return false;
    this.beginEdit('Duplicate Layer');
    try {
      this.selectLayer(id);
      this.duplicateActiveLayer();
      const copy = this.activeLayerId;
      if (!copy || copy === id) return false;
      return this.placeLayer(copy, parent, above, atBottom);
    } finally { this.endEdit(); }
  }

  // MARK: Deleting

  async deleteLayer(id: string): Promise<void> {
    if (!this.canEditLayers || !this.layer(id)) return;
    if (await this.deleteWithLiveMaskChoice([id])) return;
    this.finishDeletingLayer(id, new Map());
  }

  async deleteSelectedLayers(): Promise<void> {
    const document = this.document;
    if (!this.canEditLayers || !document) return;
    const ids = document.layers.map((l) => l.id).filter((id) => this.selectedLayerIds.has(id));
    if (ids.length <= 1) { if (this.activeLayerId) await this.deleteLayer(this.activeLayerId); return; }
    if (await this.deleteWithLiveMaskChoice(ids)) return;
    this.finishDeletingLayers(ids, new Map());
  }

  /** The trash button: the targeted mask alone, or every selected layer. */
  async deleteLayerOrMask(): Promise<void> {
    if (this.isMaskSelected && this.activeLayer?.mask && this.selectedLayerIds.size <= 1) this.deleteLayerMask();
    else await this.deleteSelectedLayers();
  }

  /** When deleted layers supply live masks to layers that stay, asks whether to bake or unlink. */
  private async deleteWithLiveMaskChoice(ids: string[]): Promise<boolean> {
    const document = this.document!;
    const removed = new Set<string>();
    for (const id of ids) { removed.add(id); for (const d of descendantIds(document.layers, id)) removed.add(d); }
    const targets = document.layers.filter((l) => !removed.has(l.id) && l.maskSourceId && removed.has(l.maskSourceId)).map((l) => l.id);
    if (!targets.length) return false;
    const choice = this.services?.confirmLiveMaskDeletion ? await this.services.confirmLiveMaskDeletion(ids.length) : 'unlink';
    if (choice === 'cancel') return true;
    if (choice === 'unlink' || !this.services) { this.finishDeletingLayers(ids, new Map()); return true; }
    this.isProjectBusy = true;
    this.notify('ui');
    try {
      const baked = new Map<string, Raster>();
      for (const target of targets) {
        const raster = await this.services.bakeLiveMask(document, target);
        if (raster) baked.set(target, raster);
      }
      this.isProjectBusy = false;
      this.finishDeletingLayers(ids, baked);
    } catch (error) {
      this.errorMessage = (error as Error).message;
    } finally {
      this.isProjectBusy = false;
      this.notify('ui');
    }
    return true;
  }

  finishDeletingLayer(id: string, baked: ReadonlyMap<string, Raster>): void {
    const document = this.document;
    if (!document) return;
    const index = document.layers.findIndex((l) => l.id === id);
    if (index < 0) return;
    const removed = new Set([id, ...descendantIds(document.layers, id)]);
    this.edit('Delete Layer', () => {
      const layers = document.layers.filter((l) => !removed.has(l.id)).map((l) => {
        if (l.maskSourceId && removed.has(l.maskSourceId)) {
          const raster = baked.get(l.id);
          if (raster) return { ...withLayerRaster(l, raster), maskSourceId: null };
          return { ...l, maskSourceId: null };
        }
        return l;
      });
      this.setLayers(layers);
      if (this.activeLayerId && removed.has(this.activeLayerId)) {
        this.setActiveLayer(layers.length ? layers[Math.min(index, layers.length - 1)]!.id : null);
      }
    });
  }

  finishDeletingLayers(ids: string[], baked: ReadonlyMap<string, Raster>): void {
    if (ids.length <= 1) { if (ids[0]) this.finishDeletingLayer(ids[0], baked); return; }
    this.edit('Delete Layers', () => { for (const id of ids) this.finishDeletingLayer(id, baked); });
  }

  // MARK: Appearance

  /** Lock toggles are always permitted, including unlocking a fully locked parent. */
  setLayerLocks(ids: Iterable<string>, partial: Partial<LayerLocks>): void {
    const targets = this.targetLayers(ids);
    if (!this.canEditLayers || !targets) return;
    const entries = Object.entries(partial).filter((entry): entry is [keyof LayerLocks, boolean] =>
      ['transparency', 'pixels', 'position', 'all'].includes(entry[0]) && typeof entry[1] === 'boolean');
    if (!entries.length) return;
    const changes = targets.filter((layer) => entries.some(([key, value]) => layer.locks[key] !== value));
    if (!changes.length) return;
    this.edit('Set Layer Locks', () => {
      for (const target of changes) this.updateLayer(target.id, (layer) => {
        const locks = { ...layer.locks };
        for (const [key, value] of entries) locks[key] = value;
        return { ...layer, locks };
      });
    });
  }

  setColorLabel(ids: Iterable<string>, label: ColorLabel): void {
    const targets = this.targetLayers(ids);
    if (!this.canEditLayers || !targets
      || !['none', 'red', 'orange', 'yellow', 'green', 'blue', 'violet', 'gray'].includes(label)) return;
    const changes = targets.filter((layer) => layer.colorLabel !== label);
    if (!changes.length) return;
    this.edit(changes.length === 1 ? 'Set Layer Color Label' : 'Set Layer Color Labels', () => {
      for (const target of changes) this.updateLayer(target.id, (layer) => ({ ...layer, colorLabel: label }));
    });
  }

  addLayerEffect(layerId: string, effect: LayerEffect, index?: number): boolean {
    const layer = this.layer(layerId);
    if (!layer || !isValidLayerEffect(effect) || !this.canEditLayers || this.refuseLayerEdit(layerId, 'appearance')) return false;
    const at = Math.min(layer.effects.length, Math.max(0, index ?? layer.effects.length));
    this.edit('Add Layer Effect', () => this.updateLayer(layerId, (value) => {
      const effects = value.effects.slice(); effects.splice(at, 0, effect); return { ...value, effects };
    }));
    return true;
  }

  removeLayerEffect(layerId: string, index: number): boolean {
    const layer = this.layer(layerId);
    if (!layer || !Number.isInteger(index) || !layer.effects[index] || !this.canEditLayers
      || this.refuseLayerEdit(layerId, 'appearance')) return false;
    this.edit('Remove Layer Effect', () => this.updateLayer(layerId, (value) => ({ ...value,
      effects: value.effects.filter((_effect, current) => current !== index) })));
    return true;
  }

  setLayerEffectEnabled(layerId: string, index: number, enabled: boolean): boolean {
    const effect = this.layer(layerId)?.effects[index];
    if (!effect || effect.enabled === enabled) return false;
    return this.setLayerEffectParameters(layerId, index, { enabled });
  }

  reorderLayerEffect(layerId: string, from: number, to: number): boolean {
    const layer = this.layer(layerId);
    if (!layer || !Number.isInteger(from) || !Number.isInteger(to) || !layer.effects[from]
      || from === to || !this.canEditLayers || this.refuseLayerEdit(layerId, 'appearance')) return false;
    const target = Math.min(layer.effects.length - 1, Math.max(0, to));
    this.edit('Reorder Layer Effect', () => this.updateLayer(layerId, (value) => {
      const effects = value.effects.slice(), moved = effects.splice(from, 1)[0]!;
      effects.splice(target, 0, moved); return { ...value, effects };
    }));
    return true;
  }

  beginLayerEffectEdit(layerId: string): boolean {
    if (this.layerEffectEditId || !this.layer(layerId) || !this.canEditLayers
      || this.refuseLayerEdit(layerId, 'appearance')) return false;
    this.beginEdit('Layer Effect');
    this.layerEffectEditId = layerId;
    return true;
  }

  finishLayerEffectEdit(): void {
    if (!this.layerEffectEditId) return;
    this.layerEffectEditId = null;
    this.endEdit();
  }

  setLayerEffectParameters(layerId: string, index: number, patch: Partial<LayerEffect>): boolean {
    const layer = this.layer(layerId), current = layer?.effects[index];
    if (!layer || !current || !this.canEditLayers || this.refuseLayerEdit(layerId, 'appearance')) return false;
    if (this.layerEffectEditId && this.layerEffectEditId !== layerId) return false;
    const next = { ...current, ...patch, kind: current.kind, schemaVersion: 1 } as LayerEffect;
    if (!isValidLayerEffect(next) || JSON.stringify(next) === JSON.stringify(current)) return false;
    const live = this.layerEffectEditId === layerId;
    if (!live) this.beginEdit('Layer Effect');
    this.updateLayer(layerId, (value) => ({ ...value,
      effects: value.effects.map((effect, currentIndex) => currentIndex === index ? next : effect) }));
    if (live) this.changed(); else this.endEdit();
    return true;
  }

  copyLayerStyle(layerId: string = this.activeLayerId ?? ''): readonly LayerEffect[] | null {
    const layer = this.layer(layerId);
    this.copiedLayerStyle = layer ? layer.effects.map((effect) => structuredClone(effect)) : null;
    return this.copiedLayerStyle;
  }

  pasteLayerStyle(layerId: string = this.activeLayerId ?? '', style = this.copiedLayerStyle): boolean {
    const layer = this.layer(layerId);
    if (!layer || !style || !style.every(isValidLayerEffect) || !this.canEditLayers || this.refuseLayerEdit(layerId, 'appearance')) return false;
    const effects = style.map((effect) => structuredClone(effect));
    if (JSON.stringify(effects) === JSON.stringify(layer.effects)) return false;
    this.edit('Paste Layer Style', () => this.updateLayer(layerId, (value) => ({ ...value, effects })));
    return true;
  }

  clearLayerStyle(layerId: string = this.activeLayerId ?? ''): boolean {
    const layer = this.layer(layerId);
    if (!layer?.effects.length || !this.canEditLayers || this.refuseLayerEdit(layerId, 'appearance')) return false;
    this.edit('Clear Layer Style', () => this.updateLayer(layerId, (value) => ({ ...value, effects: [] })));
    return true;
  }

  beginGlobalLightEdit(): boolean {
    if (this.globalLightEdit || !this.canEditLayers) return false;
    this.beginEdit('Global Light'); this.globalLightEdit = true; return true;
  }

  finishGlobalLightEdit(): void {
    if (!this.globalLightEdit) return;
    this.globalLightEdit = false; this.endEdit();
  }

  setGlobalLightAngle(angle: number): boolean {
    if (!this.document || !this.canEditLayers || !Number.isFinite(angle)) return false;
    const normalized = ((angle % 360) + 360) % 360;
    if ((this.document.globalLightAngle ?? 120) === normalized) return false;
    const live = this.globalLightEdit;
    if (!live) this.beginEdit('Global Light');
    this.document = { ...this.document, globalLightAngle: normalized };
    if (live) this.changed(); else this.endEdit();
    return true;
  }

  beginFillOpacityEdit(ids: Iterable<string> = this.selectedLayerIds): boolean {
    if (this.fillOpacityEditLayerIds || !this.canEditLayers) return false;
    const targets = this.targetLayers(ids);
    if (!targets || targets.some((layer) => this.refuseLayerEdit(layer.id, 'appearance'))) return false;
    this.finishOpacityEdit();
    this.beginEdit('Layer Fill Opacity');
    this.fillOpacityEditLayerIds = targets.map((layer) => layer.id);
    return true;
  }

  finishFillOpacityEdit(): void {
    if (!this.fillOpacityEditLayerIds) return;
    this.fillOpacityEditLayerIds = null;
    this.endEdit();
  }

  setFillOpacity(ids: Iterable<string>, opacity: number): void {
    if (!Number.isFinite(opacity) || !this.canEditLayers) return;
    const targets = this.targetLayers(ids);
    if (!targets || targets.some((layer) => this.refuseLayerEdit(layer.id, 'appearance'))) return;
    const value = Math.min(1, Math.max(0, opacity));
    const changes = targets.filter((layer) => layer.fillOpacity !== value);
    if (!changes.length) return;
    const live = this.fillOpacityEditLayerIds;
    if (live && (live.length !== targets.length || live.some((id) => !targets.some((layer) => layer.id === id)))) return;
    if (!live) this.beginEdit('Layer Fill Opacity');
    for (const target of changes) this.updateLayer(target.id, (layer) => ({ ...layer, fillOpacity: value }));
    if (live) this.changed(); else this.endEdit();
  }

  displayedBlendMode(layer: Layer): BlendMode {
    const preview = this.blendPreview;
    return preview && preview.layerId === layer.id && this.activeLayerId === layer.id ? preview.mode : layer.blendMode;
  }
  previewBlendMode(mode: BlendMode | null): void {
    this.blendPreview = mode && this.activeLayerId && this.canEditAppearance ? { layerId: this.activeLayerId, mode } : null;
    this.notify('document');
  }
  beginOpacityEdit(): void {
    if (!this.activeLayerId || this.refuseLayerEdit(this.activeLayerId, 'appearance')
      || !this.canEditAppearance || this.opacityEditLayerId) return;
    this.finishFillOpacityEdit();
    this.beginEdit('Layer Opacity');
    this.opacityEditLayerId = this.activeLayerId;
  }
  finishOpacityEdit(): void {
    if (!this.opacityEditLayerId) return;
    this.opacityEditLayerId = null;
    this.endEdit();
  }
  setLayerOpacity(opacity: number): void {
    const id = this.opacityEditLayerId ?? this.activeLayerId;
    if (!id || this.refuseLayerEdit(id, 'appearance') || !Number.isFinite(opacity) || !this.canEditAppearance) return;
    const standalone = this.opacityEditLayerId === null;
    if (standalone) this.beginEdit('Layer Opacity');
    this.updateLayer(id, (l) => ({ ...l, opacity: Math.min(1, Math.max(0, opacity)) }));
    if (standalone) this.endEdit(); else this.changed();
  }
  setSelectedLayersOpacity(opacity: number): void {
    const document = this.document;
    if (!Number.isFinite(opacity) || !this.canEditLayers || !document) return;
    const value = Math.min(1, Math.max(0, opacity));
    const selected = document.layers.filter((l) => this.selectedLayerIds.has(l.id) && l.kind !== 'group');
    if (selected.some((layer) => this.refuseLayerEdit(layer.id, 'appearance'))) return;
    const targets = selected.filter((l) => l.opacity !== value);
    if (!targets.length) return;
    this.finishOpacityEdit();
    this.edit('Layer Opacity', () => {
      for (const t of targets) this.updateLayer(t.id, (l) => ({ ...l, opacity: value }));
    });
  }
  setLayerBlendMode(mode: BlendMode): void {
    this.blendPreview = null;
    if (!this.activeLayerId || this.refuseLayerEdit(this.activeLayerId, 'appearance') || !this.canEditAppearance) return;
    this.finishOpacityEdit();
    const id = this.activeLayerId;
    this.edit('Layer Blend Mode', () => this.updateLayer(id, (l) => ({ ...l, blendMode: mode })));
  }
  cycleBlendMode(forward: boolean): void {
    const layer = this.activeLayer;
    if (!this.canEditAppearance || !layer) return;
    const index = Math.max(0, BLEND_MODES.findIndex((b) => b.mode === layer.blendMode));
    this.setLayerBlendMode(BLEND_MODES[(index + (forward ? 1 : BLEND_MODES.length - 1)) % BLEND_MODES.length]!.mode);
  }

  get usesOpacityKeys(): boolean { return isBrushTool(this.tool) || this.tool === 'gradient' || this.tool === 'move'; }

  /** 1 = 10% … 9 = 90%, 0 = 100%; two quick digits set an exact value. */
  typeOpacityDigit(digit: number, time = performance.now() / 1000): number | null {
    if (!this.usesOpacityKeys || this.isProjectBusy || digit < 0 || digit > 9) return null;
    let percent = digit === 0 ? 100 : digit * 10;
    if (this.pendingOpacityDigit && time - this.pendingOpacityDigit.time < 0.6) {
      percent = Math.max(1, this.pendingOpacityDigit.digit * 10 + digit);
      this.pendingOpacityDigit = null;
    } else this.pendingOpacityDigit = { digit, time };
    const value = percent / 100;
    if (this.tool === 'move') this.setSelectedLayersOpacity(value);
    return value;
  }

  // MARK: Palette

  get canEditPalette(): boolean { return !this.isProjectBusy; }
  paletteColor(background: boolean): PaletteColor {
    if (this.isMaskSelected) return (background ? !this.maskPaintWhite : this.maskPaintWhite) ? WHITE : BLACK;
    return background ? this.backgroundColor : this.foregroundColor;
  }
  setPaletteColor(color: PaletteColor, background: boolean): void {
    if (!this.canEditPalette) return;
    if (this.isMaskSelected) {
      const white = colorsEqual(color, WHITE);
      this.maskPaintWhite = background ? !white : white;
    } else if (background) this.backgroundColor = color;
    else this.foregroundColor = color;
    refreshGradientPalette(this);
    this.notify('ui');
  }
  swapPaletteColors(): void {
    if (!this.canEditPalette) return;
    if (this.isMaskSelected) this.maskPaintWhite = !this.maskPaintWhite;
    else [this.foregroundColor, this.backgroundColor] = [this.backgroundColor, this.foregroundColor];
    refreshGradientPalette(this);
    this.notify('ui');
  }
  resetPaletteColors(): void {
    if (!this.canEditPalette) return;
    if (this.isMaskSelected) this.maskPaintWhite = false;
    else { this.foregroundColor = BLACK; this.backgroundColor = WHITE; }
    refreshGradientPalette(this);
    this.notify('ui');
  }

  // MARK: Tools

  selectTool(value: Tool): void {
    if (this.isProjectBusy) return;
    // EditorSession.selectTool: switching tools resolves/cancels every in-progress direct manipulation.
    if (this.tool !== value) { resolveGradient(this); this.commitTransform(); this.cancelCrop(); cancelShape(this); }
    this.tool = value;
    if (value === 'crop' && !this.cropRect && this.document) {
      this.cropRatioChoice = 'Free';
      this.cropRect = { x: 0, y: 0, width: this.document.width, height: this.document.height };
    }
    this.notify('ui');
  }

  cancelCrop(): void {
    if (!this.cropRect) return;
    this.cropRect = null;
    this.notify('document');
  }

  // MARK: Transform

  get transformsAsGroup(): boolean {
    return this.selectedLayerIds.size > 1 || (this.selectedLayerIds.size === 1 && this.activeLayer?.kind === 'group');
  }

  get groupTransformMembers(): Layer[] {
    const document = this.document;
    if (!this.transformsAsGroup || !document) return [];
    const parents = new Map(document.layers.map((l) => [l.id, l.parentId]));
    const visible = effectiveVisibleIds(document.layers);
    return document.layers.filter((layer) => {
      if ((!layer.raster && layer.kind !== 'vector') || !visible.has(layer.id)) return false;
      let current: string | null = layer.id;
      for (let i = 0; i < 64 && current; i++) {
        if (this.selectedLayerIds.has(current)) return true;
        current = parents.get(current) ?? null;
      }
      return false;
    });
  }

  get groupTransformBox(): LayerTransform | null {
    const points = this.groupTransformMembers.flatMap((l) => transformCorners(l.transform));
    if (!points.length) return null;
    const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
    const minX = Math.min(...xs), minY = Math.min(...ys);
    return makeTransform({ x: minX, y: minY }, { width: Math.max(1, Math.max(...xs) - minX), height: Math.max(1, Math.max(...ys) - minY) });
  }

  get canTransform(): boolean {
    if (!(this.document !== null && !this.isProjectBusy && !this.isImporting && this.renamingLayerId === null && this.adjustmentEditingId === null)) return false;
    if (this.transformsAsGroup) {
      const members = this.groupTransformMembers;
      return members.length > 0 && !members.some((layer) => this.editBlocker(layer.id, 'position'));
    }
    const layer = this.activeLayer;
    return !!layer && (!!(layer.raster ?? this.displayedRaster(layer)) || layer.kind === 'vector') && effectiveVisibleIds(this.document!.layers).has(layer.id)
      && !this.editBlocker(layer.id, 'position');
  }

  /** Whether transforming places only the active layer's unlinked mask. */
  get transformTargetsMask(): boolean {
    return this.transformEdit ? this.transformEdit.mask : this.isMaskSelected && this.activeLayer?.mask?.linked === false;
  }

  beginTransform(persistent = true): void {
    if (this.transformEdit || !this.canTransform) return;
    const layer = this.activeLayer;
    if (!layer) return;
    this.tool = 'move';
    if (this.transformsAsGroup) {
      const box = this.groupTransformBox;
      if (!box) return;
      this.transformEdit = { layerId: layer.id, draft: box, persistent, mask: false,
        group: { box, originals: new Map(this.groupTransformMembers.map((m) => [m.id, m.transform])) } };
    } else {
      const maskAlone = this.isMaskSelected && layer.mask?.linked === false;
      this.transformEdit = { layerId: layer.id, draft: maskAlone ? maskTransform(layer) : layer.transform, persistent, mask: maskAlone };
    }
    this.notify('document');
  }

  previewTransform(value: LayerTransform): void {
    if (!isValidTransform(value) || !this.transformEdit) return;
    this.transformEdit = { ...this.transformEdit, draft: value };
    this.notify('document');
  }

  /** Cmd-dragging a handle starts a distortion (Distort.swift beginDistort). */
  beginDistort(): void {
    const edit = this.transformEdit;
    if (!edit || edit.corners || !isValidTransform(edit.draft)) return;
    const layer = this.layer(edit.layerId);
    const liveCorners = layer?.warp?.kind === 'quad' ? layer.warp.corners
      : layer?.warp?.kind === 'mesh' ? [meshPoint(layer.warp, { x: 0, y: 0 }), meshPoint(layer.warp, { x: 1, y: 0 }),
        meshPoint(layer.warp, { x: 1, y: 1 }), meshPoint(layer.warp, { x: 0, y: 1 })] : null;
    this.transformEdit = { ...edit, persistent: true,
      corners: !edit.group && liveCorners ? liveCorners.map((point) => ({ ...point })) : transformCorners(edit.draft) };
    this.notify('document');
  }

  /** Moves the distortion's corners; a twisted or collapsed shape is ignored. */
  previewCorners(corners: readonly Point[]): void {
    if (!this.transformEdit?.corners || !cornersUsable(corners)) return;
    this.transformEdit = { ...this.transformEdit, corners: corners.map((p) => ({ ...p })) };
    this.notify('document');
  }

  /** Canvas edges/centre and every other visible layer's box edges/centre (Crop.swift transformSnapTargets). */
  transformSnapTargets(excluding: ReadonlySet<string>): { xs: number[]; ys: number[] } {
    const document = this.document;
    if (!document) return { xs: [], ys: [] };
    const xs = [0, document.width / 2, document.width], ys = [0, document.height / 2, document.height];
    if (this.showsGuides && this.snapsToGuides) {
      for (const guide of document.guides ?? []) (guide.orientation === 'vertical' ? xs : ys).push(guide.position);
    }
    for (const layer of renderLayersOf(document.layers)) {
      if ((!layer.raster && layer.kind !== 'vector') || excluding.has(layer.id)) continue;
      const box = boundingBox(this.displayedTransform(layer));
      xs.push(Math.round(box.x), Math.round(box.x + box.width / 2), Math.round(box.x + box.width));
      ys.push(Math.round(box.y), Math.round(box.y + box.height / 2), Math.round(box.y + box.height));
    }
    return { xs, ys };
  }

  /** `draft` nudged so its box lines up with a nearby edge or centre; tolerance in document pixels. */
  snappedMove(draft: LayerTransform, moving: ReadonlySet<string>, tolerance: number): LayerTransform {
    const box = boundingBox(draft);
    const targets = this.transformSnapTargets(moving);
    const snap = snapOffset(box, targets.xs, targets.ys, tolerance);
    this.snapGuides = { xs: snap.x === null ? [] : [snap.x], ys: snap.y === null ? [] : [snap.y] };
    if (!snap.dx && !snap.dy) return draft;
    return { ...draft, origin: { x: draft.origin.x + snap.dx, y: draft.origin.y + snap.dy } };
  }

  get transformPixelSize(): Size | null {
    if (this.transformEdit?.group) return this.transformEdit.group.box.size;
    if (!this.transformEdit && this.transformsAsGroup) return this.groupTransformBox?.size ?? null;
    if (this.transformTargetsMask) return null;
    if (this.transformEdit?.floating) return this.transformEdit.floating.pixelSize;
    const layer = this.activeLayer, raster = layer?.raster;
    if (layer?.kind === 'embedded' && layer.content.width && layer.content.height) {
      return { width: layer.content.width, height: layer.content.height };
    }
    return raster ? { width: raster.width, height: raster.height } : layer?.kind === 'vector' ? layer.transform.size : null;
  }

  /** A layer's transform under the pending edit, or null when the edit doesn't move it. */
  pendingTransform(layer: Layer): LayerTransform | null {
    const edit = this.transformEdit;
    if (!edit || edit.mask) return null;
    if (edit.group) {
      const original = edit.group.originals.get(layer.id);
      return original ? following(original, edit.group.box, edit.draft) : null;
    }
    return edit.layerId === layer.id ? edit.draft : null;
  }
  displayedTransform(layer: Layer): LayerTransform {
    const pending = this.pendingTransform(layer);
    if (pending) return this.derivedPlacement(layer, pending);
    const preview = this.livePreview(layer.id);
    if (preview && !preview.mask) return preview.transform;
    const override = this.transformOverrides.get(layer.id);
    if (override) return this.derivedPlacement(layer, override);
    // Text: shaped pixels where the engine has them, else an imported preview at its saved placement.
    if (layer.kind === 'text') return this.derivedPixels(layer)?.transform ?? (layer.raster && layer.renderedTransform) ?? layer.transform;
    if (layer.kind === 'vector') return this.derivedPlacement(layer, layer.transform);
    // Other derived sources (embedded content, swapped rasters shown from their reduced copy) carry their own placement.
    return this.derivedPixels(layer)?.transform ?? layer.transform;
  }
  private derivedPlacement(layer: Layer, transform: LayerTransform): LayerTransform {
    if (layer.kind !== 'vector') return transform;
    for (const place of derivedPlacements) {
      const placed = place(this, layer, transform);
      if (placed) return placed;
    }
    return transform;
  }
  displayedRaster(layer: Layer): Raster | null {
    const preview = this.livePreview(layer.id);
    if (preview && !preview.mask) return preview.raster;
    const override = this.rasterOverrides.get(layer.id);
    if (override) return override;
    const derived = this.derivedPixels(layer);
    if (derived) return derived.raster;
    return layer.raster ?? null;
  }
  private derivedPixels(layer: Layer): DerivedLayerPixels | null {
    for (const source of derivedLayerSources) {
      const pixels = source(this, layer);
      if (pixels) return pixels;
    }
    return null;
  }
  displayedMaskRaster(layer: Layer): Raster | null {
    const preview = this.livePreview(layer.id);
    if (preview?.mask) return preview.raster;
    return this.maskOverrides.get(layer.id) ?? this.derivedMask(layer) ?? layer.mask?.raster ?? null;
  }
  private derivedMask(layer: Layer): Raster | null {
    if (!layer.vectorMask?.enabled && !(layer.kind === 'vector' && layer.mask?.enabled)) return null;
    for (const source of derivedMaskSources) {
      const raster = source(this, layer);
      if (raster) return raster;
    }
    return null;
  }

  /** Where the transform handles sit for `layer`. */
  editedTransform(layer: Layer): LayerTransform {
    if (this.transformEdit?.layerId === layer.id) return this.transformEdit.draft;
    if (!this.transformEdit && layer.id === this.activeLayerId && this.transformsAsGroup) {
      const box = this.groupTransformBox;
      if (box) return box;
    }
    return layer.id === this.activeLayerId && this.transformTargetsMask ? maskTransform(layer) : layer.transform;
  }

  /** Where a mask shows right now: null while it covers the layer's displayed grid (displayedMaskPlacement). */
  displayedMaskPlacement(layer: Layer): LayerTransform | null {
    const mask = layer.mask;
    if (!mask || (!this.maskOverrides.has(layer.id) && this.derivedMask(layer))) return null;
    // A preview that grows or moves the layer's pixel grid must not drag the mask along.
    const preview = this.livePreview(layer.id);
    if (preview && !preview.mask && !transformsEqual(preview.transform, layer.transform)) return mask.placement ?? layer.transform;
    const edit = this.transformEdit;
    if (edit?.group) {
      const original = edit.group.originals.get(layer.id);
      if (!original) return mask.placement;
      if (edit.corners) return mask.linked && !mask.placement ? null : mask.placement ?? layer.transform;
      return maskPlacementMoving(mask, layer.transform, following(original, edit.group.box, edit.draft));
    }
    if (!edit || edit.layerId !== layer.id || edit.floating) return mask.placement;
    if (edit.mask) return samePlacement(edit.draft, layer.transform) ? null : edit.draft;
    if (edit.corners) return mask.linked && !mask.placement ? null : mask.placement ?? layer.transform;
    return maskPlacementMoving(mask, layer.transform, edit.draft);
  }

  commitTransform(): void {
    this.snapGuides = { xs: [], ys: [] };
    this.blendPreview = null;
    this.finishOpacityEdit();
    const edit = this.transformEdit;
    this.perspectiveConstrained = false;
    if (!edit) return;
    this.transformEdit = null;
    try {
      if (edit.floating) { this.floatingCommit?.(edit); return; }
      if (edit.mask) { this.commitMaskTransform(edit); return; }
      if (edit.corners) { this.commitDistort(edit, edit.corners); return; }
      if (edit.group) {
        if (!isValidTransform(edit.draft)) return;
        for (const [id, original] of edit.group.originals) {
          const moved = following(original, edit.group.box, edit.draft);
          const resamples = moved.size.width !== original.size.width || moved.size.height !== original.size.height
            || moved.rotation !== original.rotation || moved.flipX !== original.flipX || moved.flipY !== original.flipY;
          if (this.refuseLayerEdit(id, 'position') || (resamples && this.refuseLayerEdit(id, 'pixels'))) return;
        }
        this.edit('Transform Layers', () => {
          for (const [id, original] of edit.group!.originals) {
            const moved = following(original, edit.group!.box, edit.draft);
            if (!isValidTransform(moved)) continue;
            this.updateLayer(id, (l) => redrawShapeLayer(scaleTextWithTransform(vectorLayerWithTransform({ ...l,
              mask: l.mask ? { ...l.mask, placement: maskPlacementMoving(l.mask, original, moved) } : null }, moved), original)));
          }
        });
        return;
      }
      const layer = this.layer(edit.layerId);
      if (!isValidTransform(edit.draft) || !layer) return;
      const resamples = edit.draft.size.width !== layer.transform.size.width || edit.draft.size.height !== layer.transform.size.height
        || edit.draft.rotation !== layer.transform.rotation || edit.draft.flipX !== layer.transform.flipX
        || edit.draft.flipY !== layer.transform.flipY;
      if (this.refuseLayerEdit(layer.id, 'position') || (resamples && this.refuseLayerEdit(layer.id, 'pixels'))) return;
      this.edit('Transform Layer', () => this.updateLayer(edit.layerId, (l) => redrawShapeLayer(scaleTextWithTransform(vectorLayerWithTransform({ ...l,
        mask: l.mask ? { ...l.mask, placement: maskPlacementMoving(l.mask, l.transform, edit.draft) } : null }, edit.draft), l.transform))));
    } finally {
      if (this.transformDuplicate) { this.transformDuplicate = null; this.endEdit(); }
      this.notify('document');
    }
  }

  /** Set by the selection module: merges a floating selection transform. */
  floatingCommit: ((edit: TransformEdit) => void) | null = null;
  floatingCancel: ((edit: TransformEdit) => void) | null = null;

  cancelTransform(): void {
    this.snapGuides = { xs: [], ys: [] };
    const edit = this.transformEdit;
    this.perspectiveConstrained = false;
    if (!edit) return;
    this.transformEdit = null;
    if (this.transformDuplicate) {
      const duplicate = this.transformDuplicate;
      this.setLayers(this.document!.layers.filter((l) => l.id !== duplicate.copy));
      this.setActiveLayer(duplicate.source);
      this.transformDuplicate = null;
      this.endEdit();
    }
    if (edit.floating) this.floatingCancel?.(edit);
    this.notify('document');
  }

  /** Option-drag: duplicates the single active layer and transforms the copy. */
  beginDuplicateTransform(): void {
    if (this.transformDuplicate || this.transformsAsGroup || !this.activeLayerId) return;
    const source = this.activeLayerId;
    this.commitTransform();
    if (!this.canTransform) return;
    this.beginEdit('Duplicate Layer');
    this.duplicateActiveLayer();
    const copy = this.activeLayerId;
    if (!copy || copy === source) { this.endEdit(); return; }
    this.transformDuplicate = { copy, source };
    this.beginTransform(false);
  }

  /** Shows the lock notice when a transform of the current target is refused by a position lock. */
  refuseTransform(): boolean {
    const ids = this.transformsAsGroup ? this.groupTransformMembers.map((layer) => layer.id)
      : this.activeLayerId ? [this.activeLayerId] : [];
    return ids.some((id) => this.refuseLayerEdit(id, 'position'));
  }

  nudgeLayer(dx: number, dy: number): void {
    if (this.refuseTransform()) return;
    const alreadyEditing = this.transformEdit !== null;
    if (!alreadyEditing) this.beginTransform(false);
    const edit = this.transformEdit;
    if (!edit) return;
    this.previewTransform({ ...edit.draft, origin: { x: edit.draft.origin.x + dx, y: edit.draft.origin.y + dy } });
    if (edit.corners) this.previewCorners(edit.corners.map((p) => ({ x: p.x + dx, y: p.y + dy })));
    if (!alreadyEditing) this.commitTransform();
  }

  private commitMaskTransform(edit: TransformEdit): void {
    const layer = this.layer(edit.layerId);
    const mask = layer?.mask;
    if (!isValidTransform(edit.draft) || !layer || !mask) return;
    if (this.refuseLayerEdit(layer.id, 'position')) return;
    if (edit.corners) {
      if (this.refuseLayerEdit(layer.id, 'pixels')) return;
      try {
        // LayerMask.commitMaskTransform: a mask distorted alone keeps its edge tone outside the quad.
        const moved = warpMask(mask.raster, edit.draft, edit.corners, maskBackground(mask.raster));
        this.edit('Distort Layer Mask', () => this.updateLayer(layer.id, (l) => ({ ...l,
          mask: { raster: moved.raster, enabled: mask.enabled, linked: mask.linked,
            placement: samePlacement(moved.transform, l.transform) ? null : moved.transform } })));
      } catch (error) {
        this.errorMessage = (error as Error).message;
        this.notify('ui');
      }
      return;
    }
    const placement = samePlacement(edit.draft, layer.transform) ? null : edit.draft;
    if (placement === mask.placement || (placement && mask.placement && transformsEqual(placement, mask.placement))) return;
    this.finishOpacityEdit();
    this.edit('Transform Layer Mask', () => this.updateLayer(layer.id, (l) => ({ ...l, mask: { ...l.mask!, placement } })));
  }

  /** Distort Apply: resamples the layer's pixels into the dragged quadrilateral. */
  private commitDistort(edit: TransformEdit, quad: readonly Point[]): void {
    const ids = edit.group ? [...edit.group.originals.keys()] : [edit.layerId];
    // A locked member refuses the whole distort (Photoshop): check every target before anything changes.
    if (ids.some((id) => this.refuseLayerEdit(id, 'position') || this.refuseLayerEdit(id, 'pixels'))) return;
    // Distort.commitDistort: one transaction for the whole group; a member that fails to warp does not stop the rest.
    this.beginEdit(edit.group ? 'Distort Layers' : 'Distort');
    try {
      for (const id of ids) {
        const layer = this.layer(id);
        if (!layer?.raster) continue;
        try {
          // Distort.distortTarget: group members take the box's projective warp, including rotation.
          const target = edit.group
            ? groupDistortTarget(edit.group.originals.get(id)!, edit.group.box, edit.draft, quad)
            : { transform: edit.draft, corners: quad };
          if (target) this.updateLayer(id, () => layer.kind === 'embedded' || layer.warp
            ? { ...layer, transform: target.transform,
              warp: { kind: 'quad', schemaVersion: 1, corners: [...target.corners] as [Point, Point, Point, Point] } }
            : distortLayer(layer, target.transform, target.corners));
        } catch (error) {
          this.errorMessage = (error as Error).message;
        }
      }
    } finally {
      this.endEdit();
    }
  }

  flipLayers(horizontally: boolean): void {
    this.commitTransform();
    const document = this.document;
    if (!this.canTransform || !document) return;
    let members: Layer[];
    let axis: number;
    if (this.transformsAsGroup) {
      const box = this.groupTransformBox;
      if (!box) return;
      members = this.groupTransformMembers;
      axis = horizontally ? center(box).x : center(box).y;
    } else {
      const layer = this.activeLayer;
      if (!layer) return;
      members = [layer];
      axis = horizontally ? center(layer.transform).x : center(layer.transform).y;
    }
    const ids = new Set(members.map((m) => m.id));
    if (!ids.size) return;
    if ([...ids].some((id) => this.refuseLayerEdit(id, 'position'))) return;
    this.finishOpacityEdit();
    this.edit(horizontally ? 'Flip Horizontal' : 'Flip Vertical', () => {
      for (const id of ids) {
        this.updateLayer(id, (l) => {
          const flipped = mirrored(l.transform, horizontally, axis);
          return vectorLayerWithTransform({ ...l,
            mask: l.mask ? { ...l.mask, placement: maskPlacementMoving(l.mask, l.transform, flipped) } : null }, flipped);
        });
      }
    });
  }

  flipCanvas(horizontally: boolean, mirrorSelection?: (document: CanvasDocument) => CanvasDocument['selection']): void {
    this.commitTransform();
    const document = this.document;
    if (!this.canEditLayers || !document) return;
    if (document.layers.some((layer) => this.refuseLayerEdit(layer.id, 'position'))) return;
    const axis = horizontally ? document.width / 2 : document.height / 2;
    this.finishOpacityEdit();
    this.edit(horizontally ? 'Flip Canvas Horizontal' : 'Flip Canvas Vertical', () => {
      this.document = {
        ...document,
        layers: document.layers.map((l) => ({ ...l, transform: mirrored(l.transform, horizontally, axis),
          mask: l.mask?.placement ? { ...l.mask, placement: mirrored(l.mask.placement, horizontally, axis) } : l.mask })),
        selection: mirrorSelection ? mirrorSelection(document) : document.selection,
      };
    });
  }

  // MARK: Masks

  /** Adds a solid mask (no selection) — reveal-all or hide-all. Selection-shaped masks come from the selection module. */
  addLayerMask(revealing = true): void {
    const layer = this.activeLayer;
    if (!this.canEditMask || !layer || layer.mask || this.refuseLayerEdit(layer.id, 'pixels')) return;
    this.finishOpacityEdit();
    this.edit(revealing ? 'Add Reveal-All Mask' : 'Add Hide-All Mask', () => {
      this.updateLayer(layer.id, (l) => ({ ...l, mask: { raster: Raster.solidMask(revealing), enabled: true, placement: null, linked: true } }));
      this.isMaskSelected = true;
    });
  }

  /** Installs a ready-made mask raster covering the layer's grid (Add Mask from Selection). */
  setMaskFromRaster(raster: Raster, name: string, clearSelection: boolean): void {
    const layer = this.activeLayer;
    if (!this.canEditMask || !layer || layer.mask || this.refuseLayerEdit(layer.id, 'pixels')) return;
    this.finishOpacityEdit();
    this.edit(name, () => {
      this.updateLayer(layer.id, (l) => ({ ...l, mask: { raster, enabled: true, placement: null, linked: true } }));
      if (clearSelection && this.document) this.document = { ...this.document, selection: null };
      this.isMaskSelected = true;
    });
  }

  toggleLayerMask(): void {
    const layer = this.activeLayer;
    if (!this.canEditMask || !layer?.mask || this.refuseLayerEdit(layer.id, 'appearance')) return;
    this.finishOpacityEdit();
    this.edit(layer.mask.enabled ? 'Disable Layer Mask' : 'Enable Layer Mask',
      () => this.updateLayer(layer.id, (l) => ({ ...l, mask: { ...l.mask!, enabled: !l.mask!.enabled } })));
  }

  deleteLayerMask(): void {
    const layer = this.activeLayer;
    if (!this.canEditMask || !layer?.mask || this.refuseLayerEdit(layer.id, 'pixels')) return;
    this.finishOpacityEdit();
    this.edit('Delete Layer Mask', () => {
      this.updateLayer(layer.id, (l) => ({ ...l, mask: null }));
      this.isMaskSelected = false;
    });
  }

  toggleMaskLink(id: string): void {
    const layer = this.layer(id);
    if (!this.canEditLayers || !layer?.mask || this.refuseLayerEdit(id, 'appearance')) return;
    this.commitTransform();
    this.finishOpacityEdit();
    this.edit(layer.mask.linked ? 'Unlink Layer Mask' : 'Link Layer Mask',
      () => this.updateLayer(id, (l) => ({ ...l, mask: { ...l.mask!, linked: !l.mask!.linked } })));
  }

  canCopyMask(source: string, target: string): boolean {
    if (!this.canEditLayers || source === target) return false;
    const from = this.layer(source), to = this.layer(target);
    return !!from?.mask && !!to && to.kind !== 'group' && !this.editBlocker(target, 'pixels');
  }
  copyMask(source: string, target: string): void {
    if (!this.canCopyMask(source, target)) return;
    const from = this.layer(source)!;
    this.commitTransform();
    this.finishOpacityEdit();
    const mask: LayerMask = { ...from.mask!, placement: maskTransform(from) };
    this.edit(this.layer(target)!.mask ? 'Replace Layer Mask' : 'Copy Layer Mask', () => {
      this.updateLayer(target, (l) => ({ ...l, mask: { ...mask, placement: samePlacement(mask.placement!, l.transform) ? null : mask.placement } }));
      this.selectLayer(target);
      this.isMaskSelected = true;
    });
  }

  // MARK: Clipping masks (live masks)

  canLinkMask(source: string, target: string): boolean {
    const layers = this.document?.layers;
    if (!this.canEditLayers || source === target || !layers || this.editBlocker(target, 'appearance')) return false;
    if (!layers.some((l) => l.id === source && l.kind !== 'group' && !l.adjustment)) return false;
    if (!layers.some((l) => l.id === target && l.kind !== 'group')) return false;
    return isValidStructure(layers.map((l) => (l.id === target ? { ...l, maskSourceId: source } : l)));
  }
  linkMask(source: string, target: string): boolean {
    if (!this.canLinkMask(source, target)) return false;
    if (this.layer(target)?.maskSourceId === source) return true;
    this.edit('Create Clipping Mask', () => this.updateLayer(target, (l) => ({ ...l, maskSourceId: source })));
    return true;
  }
  removeLiveMask(target: string): void {
    const document = this.document;
    const layer = this.layer(target);
    if (!this.canEditLayers || !document || !layer?.maskSourceId || this.refuseLayerEdit(target, 'appearance')) return;
    const source = layer.maskSourceId;
    const siblings = document.layers.filter((l) => l.parentId === layer.parentId);
    const index = siblings.findIndex((l) => l.id === target);
    const releases: string[] = [];
    for (const l of siblings.slice(index)) {
      if (l.id === target || l.maskSourceId === source) releases.push(l.id); else break;
    }
    this.edit('Release Clipping Mask', () => { for (const id of releases) this.updateLayer(id, (l) => ({ ...l, maskSourceId: null })); });
  }
  canToggleClippingMask(id: string): boolean {
    const layers = this.document?.layers;
    const layer = this.layer(id);
    if (!this.canEditLayers || !layers || !layer || layer.kind === 'group') return false;
    if (layer.maskSourceId) return true;
    const siblings = layers.filter((l) => l.parentId === layer.parentId);
    const index = siblings.findIndex((l) => l.id === id);
    if (index <= 0 || siblings[index - 1]!.kind === 'group') return false;
    const below = siblings[index - 1]!;
    return this.canLinkMask(below.maskSourceId ?? below.id, id);
  }
  /** Option-click: clips to the next lower sibling, sharing its base when that is clipped already. */
  toggleClippingMask(id: string): void {
    const layers = this.document?.layers;
    const layer = this.layer(id);
    if (!this.canEditLayers || !layers || !layer || layer.kind === 'group') return;
    if (layer.maskSourceId) { this.removeLiveMask(id); return; }
    const siblings = layers.filter((l) => l.parentId === layer.parentId);
    const index = siblings.findIndex((l) => l.id === id);
    if (index <= 0) return;
    const below = siblings[index - 1]!;
    if (below.kind === 'group') return;
    this.linkMask(below.maskSourceId ?? below.id, id);
  }

  // MARK: Rulers, guides, align

  /** View state (not saved in the document): rulers, guides shown, guides locked, snapping to guides. */
  showsRulers = false;
  showsGuides = true;
  guidesLocked = false;
  snapsToGuides = true;

  get guides(): readonly Guide[] { return this.document?.guides ?? []; }

  addGuide(orientation: Guide['orientation'], position: number): string | null {
    const document = this.document;
    if (!document || !Number.isFinite(position) || this.guidesLocked) return null;
    const guide: Guide = { id: uuid(), orientation, position: Math.round(position) };
    this.edit('New Guide', () => { this.document = { ...this.document!, guides: [...(this.document!.guides ?? []), guide] }; });
    return guide.id;
  }

  /** Moves a guide; `record` false while dragging (the drag's first move opens the step, `endGuideDrag` closes it). */
  moveGuide(id: string, position: number): void {
    const document = this.document;
    if (!document || this.guidesLocked || !Number.isFinite(position)) return;
    this.document = { ...document, guides: (document.guides ?? []).map((g) => (g.id === id ? { ...g, position: Math.round(position) } : g)) };
    this.notify('document');
  }

  /** Guides as they were when the open guide drag began; null when no drag step is open. */
  private guideDragBefore: readonly Guide[] | null = null;
  beginGuideDrag(): void {
    if (!this.document || this.guidesLocked || this.guideDragBefore) return;
    this.guideDragBefore = this.document.guides ?? [];
    this.beginEdit('Move Guide');
  }
  endGuideDrag(): void {
    if (!this.guideDragBefore) return;
    this.guideDragBefore = null;
    this.endEdit();
  }
  /** Escape during a guide drag: puts the guides back and closes the drag step without recording it. */
  cancelGuideDrag(): void {
    const before = this.guideDragBefore;
    if (!before) return;
    if (this.document) this.document = { ...this.document, guides: [...before] };
    this.endGuideDrag();
  }
  /** Deletes a guide inside the open drag step (dropped back on its ruler). */
  dropGuideInDrag(id: string): void {
    if (!this.document) return;
    this.document = { ...this.document, guides: (this.document.guides ?? []).filter((g) => g.id !== id) };
    this.notify('document');
  }

  removeGuide(id: string): void {
    const document = this.document;
    if (!document || this.guidesLocked || !(document.guides ?? []).some((g) => g.id === id)) return;
    this.edit('Delete Guide', () => { this.document = { ...this.document!, guides: (this.document!.guides ?? []).filter((g) => g.id !== id) }; });
  }

  clearGuides(): void {
    if (!this.document?.guides?.length || this.guidesLocked) return;
    this.edit('Clear Guides', () => { this.document = { ...this.document!, guides: [] }; });
  }

  /** Selected layer ids in document order, for align/distribute. */
  private alignSelection(): string[] {
    const document = this.document;
    if (!document) return [];
    return document.layers.map((l) => l.id).filter((id) => this.selectedLayerIds.has(id));
  }

  canAlign(): boolean { return this.canEditLayers && alignUnits(this.document!, this.alignSelection(), (l) => boundingBox(this.displayedTransform(l))).length >= 1; }
  canDistribute(): boolean { return this.canEditLayers && alignUnits(this.document!, this.alignSelection(), (l) => boundingBox(this.displayedTransform(l))).length >= 3; }

  /** Photoshop's rule: several layers align to their common box; one layer to the selection, its artboard, or the canvas. */
  alignLayers(edge: AlignEdge): void {
    const document = this.document;
    if (!document || !this.canEditLayers) return;
    const units = alignUnits(document, this.alignSelection(), (l) => boundingBox(this.displayedTransform(l)));
    if (!units.length) return;
    const selection = this.selection;
    let target: Rect | null = null;
    if (units.length === 1) {
      target = selection ? selectionBounds(selection) : null;
      if (!target) {
        const membership = artboardMembership(document, (layer) => layer.kind === 'group'
          || layer.kind === 'adjustment' ? null : boundingBox(this.displayedTransform(layer)));
        const boardIds = new Set(units[0]!.ids.map((id) => membership.get(id)).filter((id): id is string => !!id));
        const board = boardIds.size === 1 ? document.artboards?.find((value) => boardIds.has(value.id)) : null;
        target = board?.rect ?? { x: 0, y: 0, width: document.width, height: document.height };
      }
    }
    this.moveUnits(units, alignOffsets(units, edge, target), 'Align Layers');
  }

  distributeLayers(mode: DistributeMode): void {
    const document = this.document;
    if (!document || !this.canEditLayers) return;
    const units = alignUnits(document, this.alignSelection(), (l) => boundingBox(this.displayedTransform(l)));
    if (units.length < 3) return;
    this.moveUnits(units, distributeOffsets(units, mode), 'Distribute Layers');
  }

  private moveUnits(units: readonly AlignUnit[], offsets: readonly { dx: number; dy: number }[], name: string): void {
    const moves = new Map<string, { dx: number; dy: number }>();
    units.forEach((unit, i) => { const o = offsets[i]!; if (o.dx || o.dy) for (const id of unit.ids) moves.set(id, o); });
    if (!moves.size) return;
    if ([...moves.keys()].some((id) => this.refuseLayerEdit(id, 'position'))) return;
    this.commitTransform();
    this.edit(name, () => {
      this.document = { ...this.document!, layers: this.document!.layers.map((l) => {
        const o = moves.get(l.id);
        return o ? translated(l, o.dx, o.dy) : l;
      }) };
    });
  }

  // MARK: History panel

  /** Goes back or forward to the state after `steps` history entries (0 = the state before the first recorded step). */
  jumpToHistory(steps: number): boolean {
    if (!this.canUseHistory) return false;
    let moved = false;
    while (this.history.undoCount > steps && this.undo()) moved = true;
    while (this.history.undoCount < steps && this.history.canRedo && this.redo()) moved = true;
    return moved;
  }

  // MARK: Adjustment layers

  addAdjustment(kind: AdjustmentKind): void {
    const document = this.document;
    if (!this.canEditLayers || !document || document.layers.length >= MAX_LAYERS
      || !ALL_ADJUSTMENT_KINDS.includes(kind as LayerAdjustmentKind)) return;
    const active = this.activeLayer;
    const strictKind = kind as LayerAdjustmentKind;
    const adjustment: LayerAdjustment = defaultAdjustment(strictKind, this.foregroundColor, this.backgroundColor);
    const layer = newLayer({
      id: uuid(), name: this.label(kind), adjustment,
      transform: makeTransform({ x: 0, y: 0 }, { width: document.width, height: document.height }),
      parentId: active?.kind === 'group' ? this.activeLayerId : active?.parentId ?? null,
    });
    const index = document.layers.findIndex((l) => l.id === this.activeLayerId);
    this.edit(`New ${kind} Adjustment`, () => {
      const layers = document.layers.slice();
      layers.splice(index >= 0 ? index + 1 : layers.length, 0, layer);
      this.setLayers(layers);
      if (layer.parentId) this.expand(layer.parentId);
      this.setActiveLayer(layer.id);
    });
    this.adjustmentEditingId = layer.id;
    this.notify('ui');
  }

  /** Live update while the adjustment's panel is open (not an undo step by itself). */
  updateAdjustment(id: string, value: LayerAdjustment): void {
    if (this.layer(id)?.kind !== 'adjustment') return;
    this.updateLayer(id, (l) => l.kind === 'adjustment' ? { ...l, adjustment: value } : l);
    this.notify('document');
  }

  // MARK: Live filter stacks (PRODUCT-PLAN 6.4)

  addLayerLiveFilter(filter: LiveFilter, id = this.activeLayerId): boolean {
    const layer = id ? this.layer(id) : null;
    if (!id || !layer || layer.kind === 'group' || this.editBlocker(id, 'appearance')) return false;
    this.edit('Add Live Filter', () => this.updateLayer(id, (value) => ({ ...value, filters: [...value.filters, filter] })));
    return true;
  }

  updateLayerLiveFilter(index: number, filter: LiveFilter, id = this.activeLayerId, live = false): boolean {
    const layer = id ? this.layer(id) : null;
    if (!id || !layer || index < 0 || index >= layer.filters.length || this.editBlocker(id, 'appearance')) return false;
    const apply = () => this.updateLayer(id, (value) => { const filters = value.filters.slice(); filters[index] = filter; return { ...value, filters }; });
    if (live) { if (this.liveFilterEdit?.layerId !== id) return false; apply(); this.changed(); }
    else this.edit('Edit Live Filter', apply);
    return true;
  }

  removeLayerLiveFilter(index: number, id = this.activeLayerId): boolean {
    const layer = id ? this.layer(id) : null;
    if (!id || !layer || index < 0 || index >= layer.filters.length || this.editBlocker(id, 'appearance')) return false;
    this.edit('Remove Live Filter', () => this.updateLayer(id, (value) => {
      const filters = value.filters.slice(); filters.splice(index, 1); return { ...value, filters };
    })); return true;
  }

  moveLayerLiveFilter(from: number, to: number, id = this.activeLayerId): boolean {
    const layer = id ? this.layer(id) : null;
    if (!id || !layer || from < 0 || from >= layer.filters.length || to < 0 || to >= layer.filters.length
      || this.editBlocker(id, 'appearance')) return false;
    this.edit('Reorder Live Filters', () => this.updateLayer(id, (value) => {
      const filters = value.filters.slice(), moved = filters.splice(from, 1)[0]!; filters.splice(to, 0, moved);
      return { ...value, filters };
    })); return true;
  }

  beginLayerLiveFilterEdit(id = this.activeLayerId): boolean {
    const layer = id ? this.layer(id) : null;
    if (!id || !layer || this.liveFilterEdit || this.editBlocker(id, 'appearance')) return false;
    this.liveFilterEdit = { layerId: id, original: layer.filters }; this.beginEdit('Edit Live Filter'); return true;
  }

  endLayerLiveFilterEdit(commit = true): boolean {
    const edit = this.liveFilterEdit; if (!edit) return false;
    if (!commit) this.updateLayer(edit.layerId, (layer) => ({ ...layer, filters: edit.original }));
    this.liveFilterEdit = null; this.endEdit(); return true;
  }

  async applyLayerLiveFilters(id = this.activeLayerId): Promise<boolean> {
    if (!id) return false;
    const { bakeLiveFilters } = await import('./filters/live');
    return bakeLiveFilters(this, id);
  }

  // MARK: Merge

  mergePlan(): { ids: string[]; removed: Set<string>; name: string; parent: string | null; anchor: string; action: string } | null {
    const document = this.document;
    const active = this.activeLayer;
    if (!this.canEditLayers || !document || !active) return null;
    const layers = document.layers;
    if (this.selectedLayerIds.size > 1) {
      const picked = new Set(this.selectedLayerIds);
      for (const id of this.selectedLayerIds) for (const d of descendantIds(layers, id)) picked.add(d);
      const ordered = layers.filter((l) => picked.has(l.id));
      const top = [...ordered].reverse().find((l) => this.selectedLayerIds.has(l.id));
      if (!ordered.some((l) => l.kind !== 'group') || !top) return null;
      if (ordered.some((layer) => this.editBlocker(layer.id, 'pixels'))) return null;
      return { ids: ordered.map((l) => l.id), removed: picked, name: top.name, parent: top.parentId, anchor: top.id, action: 'Merge Layers' };
    }
    if (active.kind === 'group') {
      const inside = descendantIds(layers, active.id);
      if (!layers.some((l) => inside.has(l.id) && l.kind !== 'group')) return null;
      const ids = layers.filter((l) => inside.has(l.id) || l.id === active.id).map((l) => l.id);
      if (ids.some((id) => this.editBlocker(id, 'pixels'))) return null;
      return { ids, removed: new Set(ids), name: active.name, parent: active.parentId, anchor: active.id, action: 'Merge Group' };
    }
    const index = layers.findIndex((l) => l.id === active.id);
    const below = [...layers.slice(0, index)].reverse().find((l) => l.parentId === active.parentId);
    if (!below || below.kind === 'group') return null;
    if ([below.id, active.id].some((id) => this.editBlocker(id, 'pixels'))) return null;
    return { ids: [below.id, active.id], removed: new Set([below.id, active.id]), name: below.name, parent: active.parentId, anchor: active.id, action: 'Merge Down' };
  }
  get canMergeLayers(): boolean { return this.mergePlan() !== null; }
  get mergeTitle(): string { return this.mergePlan()?.action ?? 'Merge Down'; }

  /** ⌘E: the layers composited as shown into one trimmed pixel layer, as one undo step. */
  async mergeLayers(trim: (raster: Raster) => { raster: Raster; x: number; y: number } | null): Promise<void> {
    this.commitTransform();
    const plan = this.mergePlan();
    const document = this.document;
    if (!plan || !document || !this.services) return;
    const kept = new Set(plan.ids);
    const subset = document.layers.filter((l) => kept.has(l.id)).map((l) => ({ ...l,
      parentId: l.parentId && !kept.has(l.parentId) ? null : l.parentId,
      maskSourceId: l.maskSourceId && !kept.has(l.maskSourceId) ? null : l.maskSourceId }));
    this.isProjectBusy = true;
    this.notify('ui');
    let full: Raster;
    try {
      full = await this.services.flatten({ ...document, layers: subset, selection: null });
    } catch (error) {
      this.errorMessage = (error as Error).message;
      this.isProjectBusy = false;
      this.notify('ui');
      return;
    }
    this.isProjectBusy = false;
    const trimmed = trim(full);
    if (!trimmed) { this.notify('ui'); return; }
    const merged = newLayer({
      id: uuid(), name: plan.name, parentId: plan.parent, raster: trimmed.raster,
      transform: makeTransform({ x: trimmed.x, y: trimmed.y }, { width: trimmed.raster.width, height: trimmed.raster.height }),
    });
    const next = document.layers.filter((l) => !plan.removed.has(l.id))
      .map((l) => (l.maskSourceId && plan.removed.has(l.maskSourceId) ? { ...l, maskSourceId: merged.id } : l));
    const slot = document.layers.findIndex((l) => l.id === plan.anchor);
    const insertion = slot - document.layers.slice(0, slot).filter((l) => plan.removed.has(l.id)).length;
    next.splice(Math.min(Math.max(0, insertion), next.length), 0, merged);
    if (!isValidStructure(next)) { this.notify('ui'); return; }
    this.finishOpacityEdit();
    this.edit(plan.action, () => {
      this.setLayers(next);
      this.setActiveLayer(merged.id);
    });
  }

  // MARK: Pixel layer helpers used by tools

  /** Replaces a layer's pixels (and optionally transform) as one undo step. */
  constrainLayerPixels(id: string, raster: Raster, transform?: LayerTransform): Raster | null {
    const layer = this.layer(id);
    if (!layer || this.refuseLayerEdit(id, 'pixels')) return null;
    const nextTransform = transform ?? layer.transform;
    return layer.raster && this.lockState(id).transparency
      ? preserveLayerTransparency(layer.raster, layer.transform, raster, nextTransform) : raster;
  }
  replaceLayerPixels(id: string, raster: Raster, name: string, transform?: LayerTransform): void {
    const constrained = this.constrainLayerPixels(id, raster, transform);
    if (!constrained) return;
    this.edit(name, () => this.updateLayer(id, (layer) => {
      const nextTransform = transform ?? layer.transform;
      return withLayerRaster(layer, constrained, nextTransform);
    }));
  }
  replaceMaskPixels(id: string, raster: Raster, name: string): void {
    if (!this.layer(id)?.mask || this.refuseLayerEdit(id, 'pixels')) return;
    this.edit(name, () => this.updateLayer(id, (l) => ({ ...l, mask: { ...l.mask!, raster } })));
  }
  /** Inserts pixels as a new layer above the active one (addPixelLayer). */
  addPixelLayer(raster: Raster, origin: Point, name: string, editName: string, dropsSelection = true): string | null {
    const document = this.document;
    if (!document) return null;
    const active = this.activeLayer;
    const layer = newLayer({ id: uuid(), name, raster,
      transform: makeTransform(origin, { width: raster.width, height: raster.height }),
      parentId: active?.kind === 'group' ? this.activeLayerId : active?.parentId ?? null });
    const index = document.layers.findIndex((l) => l.id === this.activeLayerId);
    this.finishOpacityEdit();
    this.edit(editName, () => {
      const layers = document.layers.slice();
      layers.splice(index >= 0 ? index + 1 : layers.length, 0, layer);
      this.document = { ...document, layers, selection: dropsSelection ? null : document.selection };
      this.setActiveLayer(layer.id);
    });
    return layer.id;
  }
  nextLayerName(): string { return uniqueName(this.document?.layers ?? [], this.label('Layer')); }
  /** A generated name in the UI language. */
  label(text: string): string { return this.services?.label?.(text) ?? text; }

  /** Direct document replacement inside an open transaction (tools that build whole documents). */
  replaceDocument(document: CanvasDocument): void { this.document = document; }

  /** Session-level helpers for UI code. */
  layerGridSize(layer: Layer): Size { return { width: layerPixelWidth(layer), height: layerPixelHeight(layer) }; }
  documentBounds(): Rect | null { return this.document ? { x: 0, y: 0, width: this.document.width, height: this.document.height } : null; }
  boxOf(layer: Layer): Rect { return boundingBox(this.displayedTransform(layer)); }

  fit(): void { if (this.document) { this.viewport.fit(this.document); this.notify('view'); } }
  zoomTo(value: number, anchor?: Point): void {
    if (!this.document) return;
    this.viewport.setZoom(value, anchor ?? this.viewport.center, this.document);
    this.notify('view');
  }

  sameDocument(other: CanvasDocument | null): boolean { return documentsEqual(this.document, other); }
}

/** LayerMask.placement(movingLayer:to:) — where the mask sits once its layer moves. */
export function maskPlacementMoving(mask: LayerMask, from: LayerTransform, to: LayerTransform): LayerTransform | null {
  // A uniform mask looks the same wherever it sits.
  if (mask.raster.width <= 1 && mask.raster.height <= 1) return null;
  const moved = mask.linked ? (mask.placement ? following(mask.placement, from, to) : null) : mask.placement ?? from;
  return moved && !samePlacement(moved, to) ? moved : null;
}

/** A point of a quadrilateral (TL, TR, BR, BL) at unit coordinates (u, v), bilinearly. */
export function bilinearQuadPoint(q: readonly Point[], u: number, v: number): Point {
  const [a, b, c, d] = q as [Point, Point, Point, Point];
  const top = { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
  const bottom = { x: d.x + (c.x - d.x) * u, y: d.y + (c.y - d.y) * u };
  return { x: top.x + (bottom.x - top.x) * v, y: top.y + (bottom.y - top.y) * v };
}

/** DistortWarp.isUsable: four finite corners making a convex, non-degenerate shape. */
export function cornersUsable(corners: readonly Point[]): boolean {
  if (corners.length !== 4 || !corners.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Math.abs(p.x) <= 1_000_000 && Math.abs(p.y) <= 1_000_000)) return false;
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = corners[i]!, b = corners[(i + 1) % 4]!, c = corners[(i + 2) % 4]!;
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) <= 0.01) return false;
    if (sign === 0) sign = cross < 0 ? -1 : 1; else if ((cross < 0) !== (sign < 0)) return false;
  }
  return true;
}
