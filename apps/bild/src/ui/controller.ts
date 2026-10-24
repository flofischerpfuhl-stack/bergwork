/**
 * Glue between the host page, the project workspace, the renderer and the React views.
 * Holds no document state of its own: documents live in the core sessions.
 */

import type { HostAdapter, LayerId, ProjectManifestV1 } from '../../contracts';
import type { EditorHandleV2, ProjectManifestV2 } from '../../contracts-v2';
import { documentLimits, type CanvasDocument, type DocumentLimits, type Layer } from '../core/document';
import type { LayerEffect } from '../core/model/types';
import { Raster, alphaBounds, cropRaster } from '../core/raster';
import type { EditorSession, RasterCommandKind, SessionServices, Tool } from '../core/session';
import type { ReactNode } from 'react';
import { setShortcutLocale, type FeatureRegistry, type MenuEntry } from './menus';
import type { IconName } from './icons';
import type { CanvasView } from './canvas/CanvasView';
import type { Modifiers, ToolContext, ToolHandler } from './canvas/tools';
import type { Point } from '../core/geometry';
import { pixelClipboard, type ClipboardHooks, type PixelClipboardEntry } from '../core/clipboard';
import { failureMessage, ImportQueue } from '../core/importQueue';
import { ProjectWorkspace, type ProjectTab } from '../core/workspace';
import { buildManifest, buildManifestV2, readArchive, writeArchiveStreaming, ProjectError } from '../io/project';
import { readCompPackage, readCompZip, writeCompZip } from '../io/compPackage';
import { unzipSync } from 'fflate';
import { isQuotaError, RecoveryStore } from '../platform/recovery';
import { decodeImageFile, fileBaseName, ImageImportError } from '../io/imageImport';
import { decodeImageAssetInBackground, decodeImageFileInBackground } from '../workers/imageDecodeClient';
import { DEFAULT_JPEG, type JpegOptions } from '../io/export';
import {
  planExport, type ExportFile, type ExportFormat, type ExportPlanItem, type ExportRenderer, type ExportRequest, type ExportRunOptions,
} from '../io/exportPlan';
import type { ExportSizeEstimate } from '../io/exportPipeline';
import { zipSync } from 'fflate';
import { encodePng } from '../io/png';
import { sha256Hex } from '../io/sha256';
import { installPsdColorTransfer, type PsdReadResult, type PsdWriteNotice } from '../io/psd';
import { uuid } from '../core/ids';
import type { GpuCompositor } from '../render/gpuCompositor';
import { capabilitiesOf, type FileSaveTarget, type HostCapabilityMap, type HostFileReference } from '../platform/hosts';
import { profileFor, profileHasFeature, type EditorProfile } from '../app/profiles';
import { buildCmykLut, bundledCmykProfile, type CmykProfile, type ProofOptions } from '../core/color/cmyk';
import type { FileTargetHost } from '../platform/browserHost';
import { LITE_TILE_BUDGET, PRO_TILE_BUDGET, type ScratchHostCapability } from '../platform/scratchHost';
import { RasterResidency, TileCache } from '../core/storage';
import { waitForBrushStroke } from '../core/brush';
import { translator, type Locale } from './i18n';
import { createUiStore, type Dialog, type UiStore } from './store';
import { describeError, isCancellation } from './errors';
import type { RawDecodeOptions } from '../io/dng';

export interface ColorPickRequest {
  readonly title: string;
  readonly initial: { red: number; green: number; blue: number };
  /** Live preview while the picker is open (optional). */
  preview?(color: { red: number; green: number; blue: number }): void;
  commit(color: { red: number; green: number; blue: number }): void;
  cancel?(): void;
}

/** Layer styles (drop shadow, stroke, glow, overlays), provided by the layer-styles module. */
export interface LayerStyleCommands {
  /** Opens the Layer Style dialog on a layer: on an effect kind (added with defaults when absent), an effect index, or the first effect. */
  open(layerId: string, target?: LayerEffect['kind'] | number): void;
  /** Whether the layer can carry a style (pixel, shape, text and embedded layers; not folders or adjustment layers). */
  styleable(layerId: string): boolean;
  /** The effect's name in the UI language. */
  label(kind: LayerEffect['kind']): string;
  /** Effect kinds in Photoshop's list order (top of the stack first). */
  readonly kinds: readonly LayerEffect['kind'][];
  /** The Layer Style submenu for a layer: the effects, then Copy, Paste and Clear Layer Style. */
  menu(layerId: string): MenuEntry[];
}

export interface SecondaryDrag {
  move(dx: number, modifiers: { shift: boolean }): void;
  end(): void;
}

export interface CanvasHost {
  readonly gpu: GpuCompositor | null;
  redraw(): void;
  /** Straight-alpha pixels of a document region composited like the canvas. */
  readRegion(document: CanvasDocument, x: number, y: number, width: number, height: number): Uint8Array;
  /** Export rendering at any scale (`ExportRenderer`); optional for hosts that only read regions. */
  readView?(document: CanvasDocument, width: number, height: number, viewToDoc: import('../core/geometry').Affine, scale: number): Uint8Array;
  readViewFloat?(document: CanvasDocument, width: number, height: number, viewToDoc: import('../core/geometry').Affine, scale: number): Float32Array | null;
}

/** Whether a ZIP holds a macOS Compositor package rather than this port's archive (listing names only). */
function isCompZip(bytes: Uint8Array): boolean {
  const names: string[] = [];
  try { unzipSync(bytes, { filter: (file) => { names.push(file.name); return false; } }); } catch { return false; }
  if (names.some((n) => /(^|\/)[^/]+\.comp\//i.test(n))) return true;
  if (!names.includes('manifest.json')) return false;
  try {
    const manifest = unzipSync(bytes, { filter: (file) => file.name === 'manifest.json' })['manifest.json'];
    return !!manifest && (JSON.parse(new TextDecoder().decode(manifest)) as { format?: string }).format === 'com.compositor.project';
  } catch { return false; }
}

/** Where each project was last saved, for Save without asking again. */
const saveTargets = new WeakMap<EditorSession, FileSaveTarget>();

function technicalErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : String(error ?? fallback);
}

export class EditorController {
  readonly workspace: ProjectWorkspace;
  readonly host: HostAdapter;
  readonly capabilities: HostCapabilityMap;
  readonly profile: EditorProfile;
  readonly t: (text: string) => string;
  readonly locale: Locale;
  readonly ui: UiStore = createUiStore();
  /**
   * The mount option's theme; a host page's `html[data-theme="light|dark"]` overrides it live (EditorRoot watches the
   * attribute), so an embedding app switches the editor with its own theme switch.
   */
  get theme(): 'dark' | 'light' { return this.ui.getState().theme; }
  /** Installed by the RAW UI module; null means the user cancelled RAW files in this import batch. */
  requestRawImportOptions: ((files: readonly File[]) => Promise<RawDecodeOptions | null>) | null = null;
  private readonly imports: ImportQueue;
  canvas: CanvasHost | null = null;
  /** The mounted canvas view (tools, overlay painters, touch toggles). */
  canvasView: CanvasView | null = null;
  private canvasWaiters: (() => void)[] = [];
  /** Commands provided by feature modules (selection, brushes, adjustments…), keyed by menu command. */
  features: FeatureRegistry;
  /** Tools with a working canvas handler; the rest are shown disabled. */
  availableTools = new Set<Tool>(['move', 'hand', 'zoom', 'idle']);
  /** Startup registry hook: fetches a lazy tool module before selecting it. */
  loadFeatureForTool: ((tool: Tool) => Promise<void>) | null = null;
  /** Fetches the owner of a feature-only key before dispatching it; null means the key has no lazy owner. */
  loadFeatureForKey: ((key: string) => Promise<void> | null) | null = null;
  /** Loads every remaining lazy feature module now (menus list their commands and submenus only once loaded). */
  loadAllFeatures: (() => Promise<void>) | null = null;
  contextBars: Partial<Record<Tool, (session: EditorSession) => ReactNode>> = {};
  statusHints: Partial<Record<Tool, (session: EditorSession) => string>> = {};
  toolIcon: ((tool: Tool) => IconName | null) | null = null;
  openColorPicker: ((background: boolean) => void) | null = null;
  /** Opens the app's color picker panel for any color (palette, Gradient Map ends…), provided by the painting module. */
  pickColor: ((request: ColorPickRequest) => void) | null = null;
  /** Closes the color picker panel without calling back (its owner finished meanwhile). */
  closeColorPicker: (() => void) | null = null;
  /** Layer Style dialog and commands, provided by the layer-styles module. */
  layerStyles: LayerStyleCommands | null = null;
  /** Called once the canvas view exists, so modules can register tools and overlay painters. */
  canvasSetups: ((view: CanvasView) => void)[] = [];
  /** Extra dialogs by kind (Canvas Size, Image Size, adjustment panels…). */
  dialogs: Record<string, (close: () => void) => ReactNode> = {};
  /** Optional cancellation for custom dialogs that own a pending promise. */
  customDialogDismissers: Record<string, (() => void) | undefined> = {};
  /** Module key handlers; return true when the key was handled. */
  keyHandlers: ((event: KeyboardEvent) => boolean)[] = [];
  /** Non-modal panels drawn over the canvas (adjustment and filter panels). */
  panels: (() => ReactNode)[] = [];
  /** Canvas input taken over by an open panel (eyedroppers), ahead of the current tool. */
  canvasInterceptors: ((session: EditorSession, modifiers: Modifiers, point: Point | null) => ToolHandler | null)[] = [];
  /** Secondary-button (right) drags on the canvas, e.g. resizing the brush; the first that accepts the press owns it. */
  secondaryDrags: ((session: EditorSession) => SecondaryDrag | null)[] = [];
  /** Number keys for tools with their own opacity (brushes, gradient); true when handled. */
  opacityKey: ((digit: number) => boolean) | null = null;
  clipboardImageSize: (() => Promise<{ width: number; height: number } | null>) | null = null;
  /** Extra thumbnails after a layer row's mask (vector masks), provided by feature modules. */
  layerThumbs: ((session: EditorSession, layer: import('../core/document').Layer) => ReactNode)[] = [];
  /** Rows under a layer's row (live filters), after its effect rows, provided by feature modules. */
  layerSubRows: ((session: EditorSession, entry: import('../core/document').HierarchyEntry) => ReactNode)[] = [];
  /** Extra layer context-menu entries (Apply Smart Filters…), provided by feature modules. */
  layerMenuItems: ((session: EditorSession, layerId: string) => MenuEntry[])[] = [];
  /** Layer › Apply Recipe entries (the saved recipes), provided by the batch/recipes module. */
  recipeMenu: (() => MenuEntry[]) | null = null;
  /** Layer › New Adjustment Layer entries, when a module lists more kinds than the legacy six. */
  adjustmentLayerItems: ((withEllipsis: boolean) => MenuEntry[]) | null = null;
  /** Lazily loaded renderers (text) that must finish shaping before pixels are read for export or merges. */
  renderPreparers: ((session: EditorSession) => Promise<void>)[] = [];
  /** Feature-owned documents (for example Edit Contents tabs) can consume Save without writing a top-level file. */
  saveInterceptors: ((session: EditorSession, saveAs: boolean) => Promise<boolean>)[] = [];
  /** Extra tabs of the side panel after Layers and History (the Colour panel), provided by feature modules. */
  sidePanels: { readonly id: string; readonly label: string; render(): ReactNode }[] = [];
  /** Extra rows inside the colour picker (recent colours, swatches, screen eyedropper), provided by the colour module. */
  colorPickerExtras: ((color: { red: number; green: number; blue: number }, set: (color: { red: number; green: number; blue: number }) => void) => ReactNode) | null = null;
  /** Optional embedded-content drop bridge. Alt-drop places instead of opening/importing. */
  placeContentFiles: ((files: readonly File[], point: Point | null) => Promise<readonly string[]>) | null = null;
  private async prepareRender(): Promise<void> { for (const prepare of this.renderPreparers) await prepare(this.session); }

  /** Tool keys: some keys also switch a tool's mode (E erases, Shift-U switches shapes). */
  selectToolByKey(tool: Tool, key: string, shift: boolean): void {
    const special = this.toolKeyHandlers[key];
    if (special) { special(shift); return; }
    this.session.selectTool(tool);
  }
  async activateTool(tool: Tool, key = '', shift = false): Promise<void> {
    try {
      await this.loadFeatureForTool?.(tool);
      // Key handlers (Shift-V, E, Shift-U…) are registered by feature modules that may still be warming up.
      if (key && !this.toolKeyHandlers[key]) await this.loadAllFeatures?.();
    } catch { return; }
    this.selectToolByKey(tool, key, shift);
  }
  toolKeyHandlers: Record<string, (shift: boolean) => void> = {};

  /** Moving selected pixels (Cmd-drag, Cmd-arrows), provided by the selection engine. */
  pixelMove: {
    begin(session: EditorSession, duplicate: boolean): boolean;
    move(session: EditorSession, dx: number, dy: number): void;
    finish(session: EditorSession): void;
    cancel(session: EditorSession): void;
    nudge(session: EditorSession, dx: number, dy: number): void;
  } | null = null;
  /** Object Selection options in the selection header, provided by the object-selection module. */
  objectSelectControls: ((session: EditorSession) => ReactNode) | null = null;
  /** Whether a module draws the selection itself right now (Quick Mask, Refine Edge), so the ants stay hidden. */
  selectionOverlayHidden: ((session: EditorSession) => boolean)[] = [];
  /** Magic Wand options in the selection header, provided by the wand module. */
  wandControls: ((session: EditorSession) => ReactNode) | null = null;
  /** While the Color Picker is open, the Eyedropper samples into it. */
  colorPickerTarget: { get(): { red: number; green: number; blue: number }; set(color: { red: number; green: number; blue: number }): void } | null = null;
  /** Touch alternative for Option-click: the next canvas tap sets the Clone Stamp source. */
  cloneSourceArmed = false;
  lastOpacityDigit: { digit: number; time: number } | null = null;
  /** Spot Healing options in the brush header, provided by the healing module. */
  spotHealingControls: ((session: EditorSession) => ReactNode) | null = null;
  /** Handles a DOM paste event (⌘V); true when it pasted. */
  private assignedPasteEvent: ((event: ClipboardEvent) => boolean) | null = null;
  get pasteEvent(): ((event: ClipboardEvent) => boolean) | null {
    return this.assignedPasteEvent ? this.dispatchPasteEvent : null;
  }
  set pasteEvent(value: ((event: ClipboardEvent) => boolean) | null) { this.assignedPasteEvent = value; }
  /** Mirrors the selection for Flip Canvas. */
  mirrorSelection: ((document: CanvasDocument, horizontally: boolean) => CanvasDocument['selection']) | null = null;
  /** System clipboard bridges for copied pixels (platform work). */
  clipboardHooks: ClipboardHooks = {};

  /** A rename requested from a menu; the row picks it up and starts editing. */
  renamingLayerId: string | null = null;
  /** Provided by the selection module: mask from the selection, and Cmd-click thumbnail loading. */
  maskFromSelection: ((revealing: boolean) => void) | null = null;
  loadSelection: ((layerId: string, mask: boolean, event: { shiftKey: boolean; altKey: boolean }) => void) | null = null;

  /** Add Mask (LayerMaskMenu): with a selection, the selection-shaped mask; otherwise a solid one. */
  addMask(revealing: boolean): void {
    if (this.session.selection && this.maskFromSelection) this.maskFromSelection(revealing);
    else this.session.addLayerMask(revealing);
  }
  /** JPEG defaults for `EditorHandle.exportImage`; the Export As dialog keeps its own settings per document. */
  jpegOptions: JpegOptions = { ...DEFAULT_JPEG, quality: storedQuality() };
  readonly residency: RasterResidency | null;
  readonly tileBudgetBytes: number;
  readonly gpuTextureBudgetBytes: number;
  readonly gpuTextureChunkSize: number | undefined;
  readonly limits: DocumentLimits;
  private readonly hydrationPending = new WeakSet<Raster>();
  private suppressCompositorHydration = 0;
  private pendingResolutionCount = 0;
  private resolutionWaiters: (() => void)[] = [];
  private pendingContentResolutionCount = 0;
  private contentResolutionWaiters: (() => void)[] = [];
  private readonly saveWithoutCompositorBarrier: boolean;

  constructor(host: HostAdapter, locale: Locale, theme: 'dark' | 'light',
    profile: EditorProfile = profileFor((host as HostAdapter & Partial<ScratchHostCapability> & { defaultProfile?: 'lite' | 'pro' }).defaultProfile
      ?? (host as HostAdapter & Partial<ScratchHostCapability>).editorProfile ?? 'lite')) {
    this.host = host;
    this.recoveryStartup = new Promise((resolve) => { this.finishRecoveryStartup = resolve; });
    this.capabilities = capabilitiesOf(host);
    this.profile = profile;
    this.locale = locale;
    this.ui.setState({ theme });
    this.t = translator(locale);
    setShortcutLocale(locale);
    const scratch = host as HostAdapter & Partial<ScratchHostCapability>;
    this.limits = documentLimits(profile.id);
    this.tileBudgetBytes = scratch.tileBudgetBytes ?? (profile.id === 'pro' ? PRO_TILE_BUDGET : LITE_TILE_BUDGET);
    this.gpuTextureBudgetBytes = scratch.gpuTextureBudgetBytes ?? Math.min(1024 * 1024 * 1024, Math.floor(this.tileBudgetBytes / 4));
    this.gpuTextureChunkSize = scratch.gpuTextureChunkSize;
    this.saveWithoutCompositorBarrier = scratch.saveWithoutCompositorBarrier ?? false;
    this.residency = scratch.scratchHost ? new RasterResidency(new TileCache(scratch.scratchHost, this.tileBudgetBytes)) : null;
    this.features = this.hydratingFeatureRegistry();
    this.canvasSetups.push((view) => this.installHydratingTools(view));
    this.imports = new ImportQueue((bytes, remainingPixels) => this.decodeImage(bytes, remainingPixels));
    const services: SessionServices = {
      flatten: async (document) => this.flatten(document),
      label: (text) => this.t(text),
      bakeLiveMask: async (document, targetId) => this.bakeLiveMask(document, targetId),
      confirmLiveMaskDeletion: async (count) => (await this.confirm(
        this.t(count === 1 ? 'This layer supplies a live mask' : 'These layers supply live masks'),
        this.t('Bake keeps the current masked appearance in the dependent layers’ pixels. Remove Links reveals their pixels. You can undo either choice.'),
        [{ label: this.t('Bake and Delete'), value: 'bake', role: 'default' }, { label: this.t('Cancel'), value: 'cancel', role: 'cancel' },
          { label: this.t('Remove Links and Delete'), value: 'unlink' }])) as 'bake' | 'unlink' | 'cancel',
      ...(this.residency ? { residency: this.residency } : {}),
      limits: this.limits,
    };
    this.workspace = new ProjectWorkspace(services);
    (host as HostAdapter & { controllerReady?(controller: EditorController): void }).controllerReady?.(this);
  }

  /** Uses optional capabilities carried by the mount host without widening contracts.ts. */
  decodeImage(bytes: Uint8Array, remainingPixels: number, raw?: RawDecodeOptions) {
    return decodeImageFileInBackground(bytes, remainingPixels,
      { host: this.capabilities.codecs, maxSide: this.limits.maxSide, raw });
  }

  get session(): EditorSession { return this.workspace.current.session; }

  attachCanvas(canvas: CanvasHost | null): void {
    this.canvas = canvas;
    if (canvas) {
      canvas.gpu?.configureResidency({ textureByteBudget: this.gpuTextureBudgetBytes,
        ...(this.gpuTextureChunkSize === undefined ? {} : { textureChunkSize: this.gpuTextureChunkSize }),
        requestHydration: (raster, rect) => this.requestRasterHydration(raster, rect) });
      for (const waiter of this.canvasWaiters.splice(0)) waiter();
    }
  }

  private commandKind(command: string): RasterCommandKind {
    if (command === 'copyMerged') return 'clipboardMerged';
    if (command === 'copy' || command === 'cut' || command === 'paste' || command === 'layerViaCopy') return 'clipboard';
    if (command.startsWith('fill') || command === 'clearSelection') return 'fill';
    if (['gaussianBlur', 'motionBlur', 'noise', 'lensCorrection', 'removeBackground', 'contentAwareFill', 'vignette', 'bloom',
      'tonalContrast', 'progressiveBlur', 'rgbSplit', 'lastFilter'].includes(command)) return 'filter';
    if (['levels', 'curves', 'hueSaturation', 'exposure', 'gradientMap', 'grain', 'invert', 'editAdjustment'].includes(command)) return 'adjustment';
    if (command === 'transformCommand') return 'transform';
    return 'fill';
  }

  /** All menu feature modules pass through this one async hydration boundary. */
  private hydratingFeatureRegistry(): FeatureRegistry {
    const target: FeatureRegistry = {};
    return new Proxy(target, {
      set: (registry, property, value: FeatureRegistry[string]) => {
        if (typeof property !== 'string' || !value) return Reflect.set(registry, property, value);
        const original = value;
        return Reflect.set(registry, property, { ...original, run: () => {
          void this.trackResolution(this.session.runHydrated(this.commandKind(property), () => original.run()))
            .catch((error) => this.reportError('hydrate-failed', error));
        } });
      },
    });
  }

  private installHydratingTools(view: CanvasView): void {
    const target = view.tools;
    const wrappers = new WeakMap<ToolHandler, ToolHandler>();
    view.tools = new Proxy(target, {
      get: (registry, property, receiver) => {
        const handler = Reflect.get(registry, property, receiver) as ToolHandler | undefined;
        if (!handler || property === 'hand' || property === 'zoom' || property === 'idle') return handler;
        let wrapped = wrappers.get(handler);
        if (!wrapped) { wrapped = this.hydratingTool(handler, property === 'move' ? 'transform' : 'brush'); wrappers.set(handler, wrapped); }
        return wrapped;
      },
    });
  }

  get isFullyResolved(): boolean { return this.pendingResolutionCount === 0; }
  whenFullyResolved(): Promise<void> {
    return this.isFullyResolved ? Promise.resolve() : new Promise((resolve) => this.resolutionWaiters.push(resolve));
  }
  private whenContentResolved(): Promise<void> {
    return this.pendingContentResolutionCount === 0 ? Promise.resolve()
      : new Promise((resolve) => this.contentResolutionWaiters.push(resolve));
  }
  private trackResolution<T>(work: Promise<T>, content = true): Promise<T> {
    this.pendingResolutionCount++;
    if (content) this.pendingContentResolutionCount++;
    return work.finally(() => {
      this.pendingResolutionCount--;
      if (!this.pendingResolutionCount) for (const resolve of this.resolutionWaiters.splice(0)) resolve();
      if (content) {
        this.pendingContentResolutionCount--;
        if (!this.pendingContentResolutionCount) for (const resolve of this.contentResolutionWaiters.splice(0)) resolve();
      }
    });
  }

  /** Pointer samples hydrate and pin only their growing dab/kernel tile regions. */
  private hydratingTool(handler: ToolHandler, kind: RasterCommandKind): ToolHandler {
    let chain = Promise.resolve();
    let pendingDispatches = 0;
    let leases: { release(): void }[] = [];
    let failed = false;
    let previousBounds: import('../core/geometry').Rect | null = null;
    const release = () => { for (const lease of leases.splice(0)) lease.release(); };
    const enqueue = (context: ToolContext, action: () => void | Promise<void>) => {
      if (failed) return;
      const dab = handler.hydrationBounds?.(context);
      const rect = dab && previousBounds ? {
        x: Math.min(dab.x, previousBounds.x), y: Math.min(dab.y, previousBounds.y),
        width: Math.max(dab.x + dab.width, previousBounds.x + previousBounds.width) - Math.min(dab.x, previousBounds.x),
        height: Math.max(dab.y + dab.height, previousBounds.y + previousBounds.height) - Math.min(dab.y, previousBounds.y),
      } : dab;
      if (dab) previousBounds = dab;
      const regions: { raster: Raster; rect?: import('../core/geometry').Rect }[] = rect ? context.session.rasterRegionsForCommand(kind, rect)
        : context.session.rastersForCommand(kind).map((raster) => ({ raster }));
      if (!pendingDispatches && !regions.some((item) => item.raster.hasSwappedTilesIn(item.rect))) {
        try {
          const result = action();
          if (result) {
            pendingDispatches++;
            chain = this.trackResolution(Promise.resolve(result)).catch((error) => {
              failed = true; release(); this.reportError('hydrate-failed', error);
            }).finally(() => { pendingDispatches--; });
          }
        } catch (error) { failed = true; release(); this.reportError('hydrate-failed', error); }
        return;
      }
      pendingDispatches++;
      const work = chain.then(async () => {
        if (failed) return;
        const lease = rect && this.residency
          ? await this.residency.ensureResidentRegions(regions)
          : await context.session.services?.residency?.ensureResident(context.session.rastersForCommand(kind));
        if (lease) leases.push(lease);
        await action();
      });
      chain = this.trackResolution(work).catch((error) => {
        failed = true; release(); this.reportError('hydrate-failed', error);
      }).finally(() => { pendingDispatches--; });
    };
    return {
      down: (context: ToolContext) => {
        failed = false; previousBounds = null;
        let busy = false;
        const timer = setTimeout(() => { busy = true; context.session.isProjectBusy = true; context.session.notify('ui'); }, 150);
        enqueue(context, () => {
          clearTimeout(timer);
          if (busy) { context.session.isProjectBusy = false; context.session.notify('ui'); }
          handler.down(context);
        });
        void chain.finally(() => {
          clearTimeout(timer);
          if (busy && failed) { context.session.isProjectBusy = false; context.session.notify('ui'); }
        });
      },
      move: (context) => enqueue(context, () => handler.move(context)),
      up: (context) => enqueue(context, async () => {
        handler.up(context);
        // Recorded brush work commits after pointer-up. Serializing the next gesture here avoids
        // starting it against the preceding stroke's stale source raster.
        await waitForBrushStroke(context.session);
        release();
      }),
      cancel: (session) => {
        failed = true;
        void chain.finally(() => { handler.cancel(session); release(); });
      },
      ...(handler.hydrationBounds ? { hydrationBounds: (context: ToolContext) => handler.hydrationBounds!(context) } : {}),
      ...(handler.hover ? { hover: (context: ToolContext) => handler.hover!(context) } : {}),
      ...(handler.overlayOnly ? { overlayOnly: (session: EditorSession) => handler.overlayOnly!(session) } : {}),
      ...(handler.autoscrolls ? { autoscrolls: (session: EditorSession) => handler.autoscrolls!(session) } : {}),
    };
  }

  private requestRasterHydration(raster: Raster, rect: import('../core/geometry').Rect): void {
    if (!this.residency || this.suppressCompositorHydration || this.hydrationPending.has(raster)) return;
    this.hydrationPending.add(raster);
    void this.trackResolution(this.residency.ensureResident([raster], rect), false).then((lease) => {
      this.canvas?.redraw();
      const release = () => { lease.release(); this.hydrationPending.delete(raster); };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(release));
      else setTimeout(release, 32);
    }, (error) => { this.hydrationPending.delete(raster); this.host.reportError({ code: 'hydrate-failed',
      message: technicalErrorMessage(error, 'Raster hydration failed.') }); });
  }
  private async readyCanvas(): Promise<CanvasHost> {
    if (this.canvas) return this.canvas;
    await new Promise<void>((resolve) => this.canvasWaiters.push(resolve));
    return this.canvas!;
  }

  // MARK: Dialogs

  showDialog(dialog: Dialog | null): void { this.ui.setState({ dialog, openMenu: null }); }

  // MARK: Floating chrome

  /** Tab (Photoshop): hides or shows the tools, options bar, panels and status bar. */
  toggleChrome(): void { this.ui.setState((state) => ({ chromeHidden: !state.chromeHidden, openMenu: null })); }

  /** Shift+Tab and the top bar's Layers button: the panel stack on the right (the Layers sheet in compact layouts). */
  togglePanels(open?: boolean): void {
    const state = this.ui.getState();
    if (state.compact) { this.ui.setState({ sheet: (open ?? state.sheet !== 'layers') ? 'layers' : null }); return; }
    const next = open ?? (state.chromeHidden ? true : !state.panelsOpen);
    this.ui.setState({ panelsOpen: next, chromeHidden: false });
    try { globalThis.localStorage?.setItem('compositor.panelsOpen', String(next)); } catch { /* storage blocked */ }
  }

  /** Builds and installs the selected output-device LUT without changing document pixels. */
  async setProofSetup(profile: CmykProfile, options: ProofOptions, session: EditorSession = this.session): Promise<void> {
    if (!profileHasFeature(this.profile, 'softproof', this.capabilities)) throw new Error('CMYK soft-proof is a Pro feature.');
    const lut = await buildCmykLut(profile, options);
    session.proofProfile = profile; session.proofOptions = options; session.proofLut = lut;
    session.notify('view');
  }

  async ensureProofSetup(session: EditorSession = this.session): Promise<void> {
    if (session.proofProfile && session.proofLut) return;
    await this.setProofSetup(await bundledCmykProfile('fogra39-approx'), session.proofOptions, session);
  }

  async toggleProofColors(session: EditorSession = this.session): Promise<void> {
    if (!session.document || !profileHasFeature(this.profile, 'softproof', this.capabilities)) return;
    if (!session.proofColors) await this.ensureProofSetup(session);
    session.proofColors = !session.proofColors;
    if (!session.proofColors) session.gamutWarning = false;
    session.notify('view');
  }

  async toggleGamutWarning(session: EditorSession = this.session): Promise<void> {
    if (!session.document || !profileHasFeature(this.profile, 'softproof', this.capabilities)) return;
    await this.ensureProofSetup(session);
    session.proofColors = true; session.gamutWarning = !session.gamutWarning; session.notify('view');
  }
  alert(title: string, message: string): void { this.showDialog({ kind: 'alert', title, message }); }

  /** Origin and licences (the MIT notice of the code base this editor grew from belongs here, not in menus or formats). */
  showAbout(): void {
    this.showDialog({ kind: 'about' });
  }
  showLicenses(): void { this.showDialog({ kind: 'licenses' }); }
  confirm(title: string, message: string, buttons: Extract<Dialog, { kind: 'confirm' }>['buttons']): Promise<string> {
    return new Promise((resolve) => this.showDialog({ kind: 'confirm', title, message, buttons, resolve: (value) => { this.showDialog(null); resolve(value); } }));
  }
  reportError(code: string, error: unknown, title = this.t('Something went wrong')): void {
    // Closing a save or open dialog is not an error.
    if (isCancellation(error)) return;
    this.host.reportError({ code, message: error instanceof Error ? error.message : String(error) });
    const { message, details } = describeError(error, this.t, code);
    this.alert(title, details ? `${message}\n\n${this.t('Technical details')}: ${details}` : message);
  }

  // MARK: Rendering services

  private async flatten(document: CanvasDocument): Promise<Raster> {
    const canvas = await this.readyCanvas();
    await this.prepareRender();
    const pixels = canvas.readRegion(document, 0, 0, document.width, document.height);
    return Raster.fromPixels(document.width, document.height, 4, pixels);
  }

  /** LiveMaskBaker: the target's own pixels at its own grid with its live coverage baked into alpha. */
  private async bakeLiveMask(document: CanvasDocument, targetId: string): Promise<Raster | null> {
    const target = document.layers.find((l) => l.id === targetId);
    if (!target?.raster || !target.maskSourceId) return null;
    const canvas = await this.readyCanvas();
    if (!canvas.gpu) throw new Error('Baking a live mask needs WebGL 2.');
    const { bakeLiveMaskGpu } = await import('./bake');
    return bakeLiveMaskGpu(canvas.gpu, document, targetId);
  }

  // MARK: Projects

  newCanvasTab(width: number, height: number): void {
    const tab = this.workspace.newCanvas() ?? this.workspace.current;
    tab.session.createNewProject(width, height);
  }

  async importFiles(files: readonly File[], into: ProjectTab = this.workspace.current, point: { x: number; y: number } | null = null,
    importPsdAsLayers = false): Promise<string[]> {
    const psd = files.filter((file) => /\.ps[db]$/i.test(file.name));
    let images = files.filter((file) => !/\.ps[db]$/i.test(file.name));
    const psdIds: string[] = [];
    for (const file of psd) {
      try {
        const { readPsdDocumentInBackground } = await import('../workers/psdClient');
        let imported = await readPsdDocumentInBackground(new Uint8Array(await file.arrayBuffer()));
        if (importPsdAsLayers && imported.colorTransferReady) {
          imported = { ...imported, document: installPsdColorTransfer(imported.document,
            await imported.colorTransferReady) };
        }
        if (importPsdAsLayers) psdIds.push(...this.importPsdLayers(imported, into, fileBaseName(file.name)));
        else this.openPsd(imported, fileBaseName(file.name), into.session.document ? null : into);
      } catch (error) {
        this.reportError('import-failed', error, this.t('Import couldn’t finish'));
      }
    }
    const rawFiles = images.filter((file) => /\.(?:dng|3fr|arw|cr2|cr3|erf|kdc|mos|mrw|nef|nrw|orf|pef|raf|raw|rw2|rwl|srw)$/i.test(file.name));
    const rawOptions = rawFiles.length && this.requestRawImportOptions ? await this.requestRawImportOptions(rawFiles) : undefined;
    if (rawOptions === null) images = images.filter((file) => !rawFiles.includes(file));
    const result = await this.imports.enqueue(into.session, images.map((file) => ({
      name: file.name,
      layerName: fileBaseName(file.name),
      read: async () => new Uint8Array(await file.arrayBuffer()),
    })), { point, ...(rawOptions ? { decoder: (bytes, remaining) => this.decodeImage(bytes, remaining, rawOptions) } : {}) });
    const message = failureMessage(result);
    if (message) this.reportError('import-failed', new Error(message), this.t('Import couldn’t finish'));
    return [...psdIds, ...result.layerIds];
  }

  private psdNotices(imported: PsdReadResult): void {
    const notices = imported.unsupported.filter((feature) => feature.impact !== 'editability-only'
      || feature.code === 'compatibility-preview' || feature.code === 'flattened-composite');
    if (!notices.length) return;
    this.host.reportError({ code: 'psd-import-notice', message: notices.map((notice) =>
      `${notice.layerPath ? `${notice.layerPath}: ` : ''}${notice.message}`).join('\n') });
  }

  private psdWriteNotices(notices: readonly PsdWriteNotice[]): void {
    if (!notices.length) return;
    this.host.reportError({ code: 'psd-write-notice', message: notices.map((notice) =>
      `${notice.layerPath ? `${notice.layerPath}: ` : ''}${notice.message}`).join('\n') });
  }

  private openPsd(imported: PsdReadResult, name: string, target: ProjectTab | null): void {
    const active = [...imported.document.layers].reverse().find((layer) => layer.visible)?.id ?? null;
    const tab = target ?? this.installLoaded(imported.document, active, name);
    if (target) tab.session.installProject(imported.document, active, name);
    if (imported.colorTransferReady) void imported.colorTransferReady.then((result) => {
      const current = tab.session.document;
      if (!current) return;
      const updated = installPsdColorTransfer(current, result);
      if (updated === current) return;
      tab.session.replaceDocument(updated);
      tab.session.notify('document');
    }, (error) => this.host.reportError({ code: 'psd-colour-transfer',
      message: error instanceof Error ? error.message : String(error) }));
    this.psdNotices(imported);
  }

  private importPsdLayers(imported: PsdReadResult, into: ProjectTab, name: string): string[] {
    const session = into.session;
    if (!session.document) {
      const active = [...imported.document.layers].reverse().find((layer) => layer.visible)?.id ?? null;
      session.installProject(imported.document, active, name);
      this.psdNotices(imported);
      return active ? [active] : [];
    }
    const rasterPixels = imported.document.layers.reduce((sum, layer) => sum + (layer.raster
      ? layer.raster.width * layer.raster.height : 0), 0);
    if (rasterPixels > session.remainingPixelBudget()) throw new RangeError('The PSD layers exceed this project’s pixel budget.');
    const idMap = new Map(imported.document.layers.map((layer) => [layer.id, uuid()]));
    const resourceMap = new Map((imported.document.resources ?? []).map((resource) => [resource.id, uuid()]));
    const dx = Math.floor((session.document.width - imported.document.width) / 2);
    const dy = Math.floor((session.document.height - imported.document.height) / 2);
    const shift = (layer: Layer): Layer => {
      const adjustment = layer.adjustment?.kind === 'Colour Lookup' ? { ...layer.adjustment,
        parameters: { ...layer.adjustment.parameters,
          resourceId: resourceMap.get(layer.adjustment.parameters.resourceId) ?? layer.adjustment.parameters.resourceId } } : layer.adjustment;
      return { ...layer, id: idMap.get(layer.id)!, parentId: layer.parentId ? idMap.get(layer.parentId) ?? null : null,
        maskSourceId: layer.maskSourceId ? idMap.get(layer.maskSourceId) ?? null : null,
        transform: { ...layer.transform, origin: { x: layer.transform.origin.x + dx, y: layer.transform.origin.y + dy } },
        mask: layer.mask ? { ...layer.mask, placement: layer.mask.placement ? { ...layer.mask.placement,
          origin: { x: layer.mask.placement.origin.x + dx, y: layer.mask.placement.origin.y + dy } } : null } : null,
        ...(adjustment ? { adjustment } : {}) } as Layer;
    };
    const layers = imported.document.layers.map(shift);
    session.beginEdit('Import PSD Layers');
    try {
      session.replaceDocument({ ...session.document, layers: [...session.document.layers, ...layers],
        resources: [...(session.document.resources ?? []), ...(imported.document.resources ?? []).map((resource) => ({
          ...resource, id: resourceMap.get(resource.id)!, bytes: resource.bytes.slice(),
        }))] });
      session.setActiveLayer([...layers].reverse().find((layer) => layer.visible)?.id ?? null);
    } finally { session.endEdit(); }
    this.psdNotices(imported);
    return layers.map((layer) => layer.id);
  }

  /** Browser paste entry point: external decoding shares the same per-session queue as file drops. */
  private readonly dispatchPasteEvent = (event: ClipboardEvent): boolean => {
    const file = [...(event.clipboardData?.files ?? [])].find((candidate) => candidate.type.startsWith('image/'));
    const tab = this.workspace.current;
    const internal = pixelClipboard.entry;
    if (!file && internal && tab.session.document && (tab.session.isImporting || tab.session.isProjectBusy)) {
      void this.importInternalPaste(tab, internal);
      return true;
    }
    if (!file || !tab.session.document
      || !(tab.session.canEditLayers || tab.session.isImporting || tab.session.isProjectBusy)) {
      return this.assignedPasteEvent?.(event) ?? false;
    }
    void this.importPastedFile(file, tab, internal);
    return true;
  };

  private async importInternalPaste(into: ProjectTab, entry: PixelClipboardEntry): Promise<void> {
    await this.imports.enqueue(into.session, [{ name: 'Pasted image', read: async () => new Uint8Array() }], {
      transactionName: 'Paste',
      decoder: async () => entry.raster,
      insert: (session) => session.addPixelLayer(entry.raster, entry.origin, session.nextLayerName(), 'Paste'),
    });
  }

  private async importPastedFile(file: File, into: ProjectTab, internal: PixelClipboardEntry | null): Promise<void> {
    let usesInternalPixels = false;
    const internalHash = internal
      ? sha256Hex(encodePng(internal.raster.toPixels(), internal.raster.width, internal.raster.height, internal.raster.channels))
      : null;
    const result = await this.imports.enqueue(into.session, [{
      name: file.name || 'Pasted image',
      read: async () => new Uint8Array(await file.arrayBuffer()),
    }], {
      transactionName: 'Paste',
      decoder: async (bytes, remainingPixels) => {
        usesInternalPixels = internal !== null && sha256Hex(bytes) === internalHash;
        return usesInternalPixels ? internal!.raster : this.decodeImage(bytes, remainingPixels);
      },
      insert: (session, raster) => {
        const document = session.document;
        if (!document) return null;
        if (!usesInternalPixels) pixelClipboard.clear();
        const pasted = usesInternalPixels ? internal! : {
          raster,
          origin: {
            x: Math.floor((document.width - raster.width) / 2),
            y: Math.floor((document.height - raster.height) / 2),
          },
        };
        return session.addPixelLayer(pasted.raster, pasted.origin, session.nextLayerName(), 'Paste');
      },
    });
    const failure = result.failures[0];
    if (failure) this.reportError('paste-failed', failure.error);
  }

  async chooseAndImport(): Promise<void> {
    try {
      const files = await this.host.chooseImages();
      if (files.length) await this.importFiles(files, this.workspace.current, null, true);
    } catch (error) { this.reportError('import-failed', error, this.t('Import couldn’t finish')); }
  }

  /** File-association/second-instance entry point supplied by FileSystemHost. */
  async openHostFiles(files: readonly HostFileReference[]): Promise<void> {
    const capability = this.capabilities.files;
    if (!capability?.readFile) return;
    for (const reference of files) {
      try {
        const blob = await capability.readFile(reference);
        if (/\.ps[db]$/i.test(reference.name)) {
          const { readPsdDocumentInBackground } = await import('../workers/psdClient');
          const imported = await readPsdDocumentInBackground(new Uint8Array(await blob.arrayBuffer()));
          this.openPsd(imported, fileBaseName(reference.name), null);
          const target = capability.saveTargetFor?.(reference);
          if (target) saveTargets.set(this.session, target);
        } else if (/\.(fwimg|zip|comp)$/i.test(reference.name)) {
          const tab = await this.openArchive(blob, reference.name);
          const target = capability.saveTargetFor?.(reference);
          if (target) saveTargets.set(tab.session, target);
        } else await this.importFiles([new File([blob], reference.name)]);
        await capability.recordRecentFile(reference);
      } catch (error) { this.reportError('open-failed', error); }
    }
  }

  async openArchive(blob: Blob, name?: string): Promise<ProjectTab> {
    // Reserve and select the destination before the first await. A previous project must never remain
    // observable as if it were the just-dropped archive, and concurrent drops keep input order even
    // when their decoders finish out of order.
    const loadingName = name ? fileBaseName(name.replace(/\.comp$/i, '')) : this.t('Opening…');
    const tab = this.workspace.createTab(loadingName);
    tab.session.isProjectBusy = true;
    this.workspace.adopt(tab);
    try {
      // A zipped macOS Compositor package (`X.comp/…`, format com.compositor.project) or this port's own archive.
      if (/\.comp$/i.test(name ?? '')) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const loaded = await readCompZip(bytes);
        tab.session.isProjectBusy = false;
        tab.session.installProject(loaded.document, loaded.activeLayerId, name?.replace(/\.comp$/i, '') ?? loaded.name);
        return tab;
      }
      let loaded: Awaited<ReturnType<typeof readArchive>>;
      // Retained non-PNG sources must repeat ImageImporter.decode's colour/orientation pipeline;
      // PNG entries still take the reader's tile-streaming fast path when no conversion is needed.
      try {
        loaded = await readArchive(blob, (data) => decodeImageAssetInBackground(data, this.limits.maxPixels,
          { host: this.capabilities.codecs, maxSide: this.limits.maxSide }), this.limits, this.residency ?? undefined);
      } catch (error) {
        // Ambiguous legacy `.zip` files have no useful extension. Only pay for a contiguous copy
        // after the streaming Fernwork reader has established that this is not its format.
        if (!(error instanceof ProjectError) || error.code !== 'invalid' || /\.fwimg$/i.test(name ?? '')) throw error;
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (!isCompZip(bytes)) throw error;
        const legacy = await readCompZip(bytes);
        tab.session.isProjectBusy = false;
        tab.session.installProject(legacy.document, legacy.activeLayerId, name ?? legacy.name);
        return tab;
      }
      const projectName = name ? fileBaseName(name) : loaded.name;
      tab.session.isProjectBusy = false;
      tab.session.installProject(loaded.document, loaded.activeLayerId, projectName, loaded.history);
      return tab;
    } catch (error) {
      this.workspace.removeTab(tab.id);
      throw error;
    }
  }

  private installLoaded(document: CanvasDocument, activeLayerId: string | null, name: string): ProjectTab {
    const tab = this.workspace.createTab(name);
    tab.session.installProject(document, activeLayerId, name);
    this.workspace.adopt(tab);
    return tab;
  }

  /** Opens an unzipped `.comp` package directory (the macOS app's own project format) chosen as a folder. */
  async openCompFolder(files: readonly File[]): Promise<void> {
    if (!files.length || !this.workspace.canSwitch) return;
    try {
      const entries = new Map<string, Uint8Array>();
      for (const file of files) {
        const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
        entries.set(path.replace(/^[^/]*\.comp\//i, ''), new Uint8Array(await file.arrayBuffer()));
      }
      const root = ((files[0] as File & { webkitRelativePath?: string }).webkitRelativePath ?? '').split('/')[0] ?? '';
      const loaded = await readCompPackage(entries);
      this.installLoaded(loaded.document, loaded.activeLayerId, root.replace(/\.comp$/i, '') || loaded.name);
    } catch (error) { this.reportError(error instanceof ProjectError ? error.code : 'open-failed', error); }
  }

  async chooseCompFolder(): Promise<void> {
    if (!this.workspace.canSwitch) return;
    const files = await new Promise<File[]>((resolve) => {
      const input = globalThis.document.createElement('input');
      input.type = 'file';
      (input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;
      input.style.display = 'none';
      input.addEventListener('change', () => { resolve([...(input.files ?? [])]); input.remove(); });
      input.addEventListener('cancel', () => { resolve([]); input.remove(); });
      globalThis.document.body.append(input);
      input.click();
    });
    await this.openCompFolder(files);
  }

  /** @deprecated Compatibility hook for the legacy E2E fixture; no production menu exposes Mac-project writing. */
  async saveCompCopy(): Promise<void> {
    const session = this.session, document = session.document;
    if (!document) return;
    try {
      session.commitTransform();
      const name = session.projectName ?? this.workspace.current.title;
      const files = this.capabilities.files;
      const target = files ? await files.chooseSaveTarget(`${name}.comp.zip`, 'project') : null;
      if (files && !target) return;
      const bytes = await writeCompZip(session.document ?? document, { name, activeLayerId: session.activeLayerId });
      const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/zip' });
      if (target && files) await files.writeFile(target, blob);
      else await this.host.saveFile(blob, `${name}.comp.zip`);
    } catch (error) { this.reportError('save-failed', error); }
  }

  async chooseAndOpen(): Promise<void> {
    if (!this.workspace.canSwitch) return;
    try {
      const blob = await this.host.chooseProject();
      const sourceName = blob && typeof (blob as Blob & { name?: unknown }).name === 'string'
        ? (blob as Blob & { name: string }).name : undefined;
      if (blob && /\.ps[db]$/i.test(sourceName ?? '')) {
        const { readPsdDocumentInBackground } = await import('../workers/psdClient');
        const imported = await readPsdDocumentInBackground(new Uint8Array(await blob.arrayBuffer()));
        this.openPsd(imported, fileBaseName(sourceName!), null);
      } else if (blob) await this.openArchive(blob, sourceName);
    } catch (error) { this.reportError(error instanceof ProjectError ? error.code : 'open-failed', error); }
  }

  manifest(session: EditorSession = this.session): ProjectManifestV1 {
    const document = session.document;
    if (!document) {
      return { format: 'fernwork-compositor', version: 1, id: '', name: session.projectName ?? this.workspace.current.title, width: 0, height: 0,
        colorSpace: 'srgb', layers: [], assets: [] };
    }
    return buildManifest(document, session.projectName ?? this.workspace.current.title, session.activeLayerId);
  }

  manifestV2(session: EditorSession = this.session): ProjectManifestV2 {
    const document = session.document;
    if (!document) return { format: 'fernwork-image', version: 2, id: '', name: session.projectName ?? this.workspace.current.title,
      width: 0, height: 0, resolution: 72, colorSpace: 'srgb', activeLayerId: null, layers: [], artboards: [], assets: [] };
    return buildManifestV2(document, session.projectName ?? this.workspace.current.title, session.activeLayerId);
  }

  /** Whether saved projects carry their undo history (P7; on by default, remembered per device). Recovery copies always do. */
  get saveHistoryWithProject(): boolean { return globalThis.localStorage?.getItem('fernwork.saveHistory') !== 'off'; }
  set saveHistoryWithProject(value: boolean) {
    try { globalThis.localStorage?.setItem('fernwork.saveHistory', value ? 'on' : 'off'); } catch { /* storage unavailable */ }
  }

  async archive(session: EditorSession = this.session): Promise<Blob> {
    return (await this.archiveResult(session)).blob;
  }

  private async archiveResult(session: EditorSession,
    emitChunk?: (chunk: Uint8Array) => void | Promise<void>): Promise<{ blob: Blob; manifest: ProjectManifestV2; document: CanvasDocument }> {
    const document = session.document;
    if (!document) throw new ProjectError('no-document', 'There is no canvas to save.');
    if (this.saveWithoutCompositorBarrier) await this.whenContentResolved();
    else await this.whenFullyResolved();
    session.commitTransform();
    const final = session.document ?? document;
    const name = session.projectName ?? this.workspace.current.title;
    const archived = await writeArchiveStreaming(final, name, session.activeLayerId, this.residency ?? undefined,
      this.saveHistoryWithProject ? session.history.exportState() : undefined, emitChunk);
    return { ...archived, document: final };
  }

  // MARK: Crash journal recovery (ScratchHost / OPFS)

  private recovery: RecoveryStore | null = null;
  private readonly recoveryStartup: Promise<void>;
  private finishRecoveryStartup!: () => void;
  private recoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private recoveryPaused = new Set<string>();
  private recoveryWatchers = new Map<string, () => void>();
  private recoveryOperations = new Map<string, Promise<void>>();

  /** Resolves after startup garbage collection, before any recovery prompt needs user input. */
  whenRecoveryReady(): Promise<void> { return this.recoveryStartup; }

  /** Offers archives left by an earlier page load, then keeps copies of modified tabs. */
  async startRecovery(): Promise<void> {
    const scratch = (this.host as HostAdapter & Partial<ScratchHostCapability>).scratchHost;
    if (!RecoveryStore.available(scratch)) { this.finishRecoveryStartup(); return; }
    this.recovery = new RecoveryStore(scratch);
    try {
      await this.recovery.collectGarbage(this.liveScratchKeys());
      this.finishRecoveryStartup();
      const previous = await this.recovery.previous();
      if (previous.length) {
        const answer = await this.confirm(this.t(previous.length === 1 ? 'Recover an unsaved project?' : 'Recover unsaved projects?'),
          previous.map((r) => `${r.name} · ${new Date(r.savedAt).toLocaleString(this.locale)}`).join('\n'),
          [{ label: this.t('Recover'), value: 'recover', role: 'default' }, { label: this.t('Discard'), value: 'discard', role: 'destructive' },
            { label: this.t('Later'), value: 'later', role: 'cancel' }]);
        if (answer === 'recover') {
          for (const record of previous) {
            try {
              if (record.kind === 'state' && this.residency) {
                const loaded = await this.recovery.recover(record, this.residency);
                const rasters = documentRasters(loaded.document);
                const bytes = rasters.reduce((sum, raster) => sum + this.residency!.describe(raster).tiles.reduce((n, tile) => n + (tile?.byteLength ?? 0), 0), 0);
                // Current thumbnails are synchronous. Keep a modest recovered document pinned for
                // its first render; large documents stay on compositor LODs and hydrate on demand.
                const firstFrame = bytes <= 64 * 1024 * 1024 ? await this.residency.ensureResident(rasters) : null;
                const tab = this.workspace.createTab(loaded.name);
                tab.session.installProject(loaded.document, loaded.activeLayerId, loaded.name, loaded.history);
                this.workspace.adopt(tab);
                if (firstFrame) setTimeout(() => firstFrame.release(), 250);
              } else await this.openArchive(record.archive, record.name);
              await this.recovery.remove(record.id);
            } catch (error) { this.reportError('recovery-failed', error); }
          }
          for (const tab of this.workspace.tabs) tab.session.history.markUnsaved();
        } else if (answer === 'discard') {
          for (const record of previous) await this.recovery.remove(record.id);
        }
      }
    } catch (error) {
      this.finishRecoveryStartup();
      this.host.reportError({ code: 'recovery-unavailable', message: technicalErrorMessage(error, 'Recovery is unavailable.') });
      this.recovery = null;
      return;
    }
    this.watchTabsForRecovery();
    this.workspaceRecoveryOff = this.workspace.subscribe(() => this.watchTabsForRecovery());
  }
  private workspaceRecoveryOff: (() => void) | null = null;

  private watchTabsForRecovery(): void {
    const ids = new Set(this.workspace.tabs.map((t) => t.id));
    for (const [id, off] of this.recoveryWatchers) {
      if (!ids.has(id)) { off(); this.recoveryWatchers.delete(id); void this.recovery?.remove(id); }
    }
    for (const tab of this.workspace.tabs) {
      if (this.recoveryWatchers.has(tab.id)) continue;
      this.recoveryWatchers.set(tab.id, tab.session.subscribe((kind) => {
        if (kind === 'document') {
          this.startDocumentResidency(tab);
          this.scheduleRecoveryCopy(tab);
        }
      }));
      this.startDocumentResidency(tab);
    }
  }

  private startDocumentResidency(tab: ProjectTab): void {
    // Linux WebKit can continue background history registration while the streaming writer starts;
    // the writer still awaits/manages every raster it actually consumes. Other hosts keep the
    // original all-resolution barrier.
    void this.trackResolution(this.trackDocumentResidency(tab), !this.saveWithoutCompositorBarrier).catch((error) => {
      this.host.reportError({ code: 'scratch-write-failed', message: technicalErrorMessage(error, 'Scratch storage write failed.') });
    });
  }

  private async trackDocumentResidency(tab: ProjectTab): Promise<void> {
    if (!this.residency) return;
    const session = tab.session;
    const state = session.history.exportState();
    const historyDocuments = [...state.past, ...state.future].flatMap((entry) => [entry.before.document, entry.after.document]);
    const current = session.document;
    for (const document of historyDocuments) for (const raster of documentRasters(document)) {
      await this.residency.manage(raster, 'history');
    }
    if (current) for (const layer of current.layers) {
      for (const raster of [layer.raster, layer.mask?.raster ?? null,
        session.displayedRaster(layer), session.displayedMaskRaster(layer)]) if (raster) {
        await this.residency.manage(raster, layer.visible ? 'offscreen' : 'hidden');
      }
    }
    if (current?.selection) await this.residency.manage(current.selection.mask, 'visible');
  }

  private scheduleRecoveryCopy(tab: ProjectTab): void {
    // PRODUCT-PLAN section 8: journal commits are batched for at most one second.
    void this.recovery?.markPending(tab.id).catch(() => undefined);
    if (this.recoveryTimers.has(tab.id)) return;
    this.recoveryTimers.set(tab.id, setTimeout(() => {
      const operation = this.enqueueRecoveryOperation(tab.id, () => this.writeRecoveryCopy(tab));
      void operation.catch(() => {});
    }, 750));
  }

  /** Journal commits, deletion, and garbage collection share OPFS files and must not overlap for one tab. */
  private enqueueRecoveryOperation(id: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.recoveryOperations.get(id) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.recoveryOperations.set(id, current);
    void current.finally(() => { if (this.recoveryOperations.get(id) === current) this.recoveryOperations.delete(id); }).catch(() => {});
    return current;
  }

  private async writeRecoveryCopy(tab: ProjectTab): Promise<void> {
    this.recoveryTimers.delete(tab.id);
    const store = this.recovery, session = tab.session;
    if (!store || this.recoveryPaused.has(tab.id)) return;
    if (session.isProjectBusy || session.transformEdit || session.history.isInTransaction) { this.scheduleRecoveryCopy(tab); return; }
    if (!session.document || !session.isModified) { await store.remove(tab.id).catch(() => undefined); return; }
    try {
      const name = session.projectName ?? tab.title;
      if (this.residency) {
        const document = session.document;
        const written = await store.putState({ id: tab.id, name, savedAt: Date.now(), document,
          activeLayerId: session.activeLayerId, history: session.history.exportState(),
          ...(session.history.undoName ? { command: session.history.undoName } : {}) }, this.residency,
        () => session.document === document && session.isModified);
        if (!written && session.isModified) this.scheduleRecoveryCopy(tab);
      }
      else {
        const document = session.document;
        const archive = (await writeArchiveStreaming(document, name, session.activeLayerId, undefined,
          session.history.exportState())).blob;
        if (session.document !== document || !session.isModified) return;
        await store.put({ id: tab.id, name, savedAt: Date.now(), size: archive.size, archive,
          ...(session.history.undoName ? { command: session.history.undoName } : {}) });
      }
    } catch (error) {
      if (isQuotaError(error)) {
        this.recoveryPaused.add(tab.id);
        this.reportError('storage-quota', new Error(this.t('Browser storage is full. Automatic recovery copies of this project are paused; save the project to keep your work.')));
      } else this.host.reportError({ code: 'recovery-write-failed', message: technicalErrorMessage(error, 'Recovery write failed.') });
    }
  }

  /**
   * Save overwrites the place the project was last saved to; Save As (or the first save) asks where (ProjectController.save).
   * The destination is chosen before the archive is encoded: a browser shows its save dialog only while the click or key
   * press that asked for it still counts, and encoding a large document takes longer than that.
   */
  async save(saveAs = false): Promise<void> {
    const tab = this.workspace.current, session = tab.session;
    if (!session.document || !this.workspace.canSwitch) return;
    try {
      for (const intercept of this.saveInterceptors) if (await intercept(session, saveAs)) return;
      const name = `${session.projectName ?? tab.title}.fwimg`;
      const files = this.capabilities.files;
      const targetHost = this.host as FileTargetHost;
      let target = saveAs ? undefined : saveTargets.get(session);
      if (!target && files) {
        const chosen = await files.chooseSaveTarget(name, 'project');
        // Cancelled: nothing is written, so the project stays unsaved.
        if (!chosen) return;
        target = chosen;
      }
      const sink = target && targetHost.openFileSink ? await targetHost.openFileSink(target) : null;
      const photoshop = !!target && /\.ps[db]$/i.test(target.name);
      let savedDocument: CanvasDocument;
      if (target && photoshop) {
        try {
          await this.whenFullyResolved();
          session.commitTransform();
          await this.prepareRender();
          const document = session.document;
          if (!document) throw new ProjectError('no-document', 'There is no canvas to save.');
          // Resolve lazy display state once on the UI thread; the immutable tiles then transfer to
          // the PSD worker. This is equivalent to the writer's former CompositeHooks projection.
          const layers = document.layers.map((layer): Layer => {
            let prepared = { ...layer, transform: session.displayedTransform(layer),
              blendMode: session.displayedBlendMode(layer) } as Layer;
            if ('raster' in prepared) prepared = { ...prepared, raster: session.displayedRaster(layer) } as Layer;
            if (layer.mask) prepared = { ...prepared, mask: { ...layer.mask,
              raster: session.displayedMaskRaster(layer) ?? layer.mask.raster,
              placement: session.displayedMaskPlacement(layer) } } as Layer;
            return prepared;
          });
          const prepared = { ...document, layers };
          const [{ psdFormatForName }, { writePsdDocumentInBackground }] = await Promise.all([
            import('../io/psd'), import('../workers/psdClient'),
          ]);
          const written = await session.runHydrated('save', () => writePsdDocumentInBackground(prepared,
            { format: psdFormatForName(target.name, document) }));
          const blob = new Blob([written.bytes as Uint8Array<ArrayBuffer>], { type: 'image/vnd.adobe.photoshop' });
          if (sink) { await sink.write(written.bytes); await sink.close(); }
          else if (files) await files.writeFile(target, blob);
          else throw new Error('The selected PSD destination is unavailable.');
          savedDocument = document;
          this.psdWriteNotices(written.notices);
        } catch (error) { await sink?.abort().catch(() => {}); throw error; }
        saveTargets.set(session, target);
        session.projectName = target.name.replace(/\.(?:psd|psb)$/i, '');
      } else if (target && sink) {
        try { const archived = await this.archiveResult(session, (chunk) => sink.write(chunk)); savedDocument = archived.document; await sink.close(); }
        catch (error) { await sink.abort().catch(() => {}); throw error; }
        saveTargets.set(session, target);
        session.projectName = target.name.replace(/(\.fwimg|\.compositor\.zip|\.zip)$/i, '');
      } else {
        const archived = await this.archiveResult(session), blob = archived.blob;
        savedDocument = archived.document;
        if (target && files) {
          await files.writeFile(target, blob);
          saveTargets.set(session, target);
          session.projectName = target.name.replace(/(\.fwimg|\.compositor\.zip|\.zip)$/i, '');
        } else await this.host.saveFile(blob, name);
      }
      session.projectName ??= tab.title;
      if (session.document === savedDocument) session.history.markSaved();
      this.recoveryPaused.delete(tab.id);
      session.notify('ui');
      const recovery = this.recovery;
      if (recovery && !session.isModified) {
        const timer = this.recoveryTimers.get(tab.id);
        if (timer) { clearTimeout(timer); this.recoveryTimers.delete(tab.id); }
        // The file is already durable and the saved revision must become visible immediately. Cleanup follows any
        // journal writer that was already in flight; a later edit keeps/supersedes that recovery state.
        const cleanup = this.enqueueRecoveryOperation(tab.id, async () => {
          if (session.isModified) return;
          await recovery.remove(tab.id);
          if (!session.isModified) await recovery.collectGarbage(this.liveScratchKeys());
        });
        void cleanup.catch((error) => this.host.reportError({ code: 'recovery-write-failed',
          message: technicalErrorMessage(error, 'Recovery cleanup failed.') }));
      }
    } catch (error) { this.reportError('save-failed', error); }
  }

  // MARK: Export (one pipeline: src/io/exportPipeline.ts)

  /** The canvas compositor as export renderer (GPU where available, the same pixels as the canvas). */
  async exportRenderer(): Promise<ExportRenderer> {
    const canvas = await this.readyCanvas();
    await this.prepareRender();
    if (canvas.readView) {
      return {
        readView: (document, width, height, view, scale) => canvas.readView!(document, width, height, view, scale),
        readViewFloat: (document, width, height, view, scale) => canvas.readViewFloat?.(document, width, height, view, scale) ?? null,
      };
    }
    const cpu = (await import('../io/exportPipeline')).cpuExportRenderer();
    return {
      readView: (document, width, height, view, scale) => (view.a === 1 && view.d === 1 && view.b === 0 && view.c === 0
        && Number.isInteger(view.tx) && Number.isInteger(view.ty)
        ? canvas.readRegion(document, view.tx, view.ty, width, height) : cpu.readView(document, width, height, view, scale)),
      readViewFloat: cpu.readViewFloat!,
    };
  }

  /** Request defaults shared by every entry point (the Export As dialog, `EditorHandle.exportImage`): the project name and the JPEG defaults. */
  exportRequest(format: ExportFormat, overrides: Partial<ExportRequest> = {}, session: EditorSession = this.session): ExportRequest {
    if (overrides.cmyk && !profileHasFeature(this.profile, 'cmyk-export', this.capabilities)) {
      throw new Error('CMYK export is available in the Pro profile only.');
    }
    const jpeg = format === 'jpeg' ? { quality: this.jpegOptions.quality,
      matte: { red: this.jpegOptions.red, green: this.jpegOptions.green, blue: this.jpegOptions.blue } } : {};
    return { targets: [{ kind: 'document' }], format, baseName: session.projectName ?? this.workspace.current.title, ...jpeg, ...overrides };
  }

  /** File names and pixel sizes a request produces (synchronous; for the export dialog). */
  planExport(request: ExportRequest, session: EditorSession = this.session): ExportPlanItem[] {
    if (request.cmyk && !profileHasFeature(this.profile, 'cmyk-export', this.capabilities)) {
      throw new Error('CMYK export is available in the Pro profile only.');
    }
    return planExport(session.document, request);
  }

  /** Renders and encodes a request without saving (dialog previews, `EditorHandle.exportImage`). */
  async exportFiles(request: ExportRequest, options: ExportRunOptions = {}, session: EditorSession = this.session): Promise<ExportFile[]> {
    if (request.cmyk && !profileHasFeature(this.profile, 'cmyk-export', this.capabilities)) {
      throw new Error('CMYK export is available in the Pro profile only.');
    }
    await this.whenFullyResolved();
    session.commitTransform();
    planExport(session.document, request); // fail fast before waiting for the canvas
    const { runExport } = await import('../io/exportPipeline');
    const renderer = await this.exportRenderer();
    this.suppressCompositorHydration++;
    try {
      return await this.trackResolution(session.runHydrated('export', () => runExport(session.document, request, renderer, options)));
    } finally { this.suppressCompositorHydration--; }
  }

  /** File-size preview: really encodes (small outputs in full, large ones as a tile mosaic) in a worker; cancel with `signal`. */
  async estimateExport(request: ExportRequest, options: ExportRunOptions = {}, session: EditorSession = this.session): Promise<ExportSizeEstimate[]> {
    await this.whenFullyResolved();
    session.commitTransform();
    const { estimateExportSize } = await import('../io/exportPipeline');
    const renderer = await this.exportRenderer();
    this.suppressCompositorHydration++;
    try {
      return await this.trackResolution(session.runHydrated('export', () => estimateExportSize(session.document, request, renderer, options)));
    } finally { this.suppressCompositorHydration--; }
  }

  /**
   * Export with saving: the destination is chosen first, while the user's click still counts (see save),
   * then pixels are rendered and encoded. Several files are saved as one ZIP.
   */
  async exportWith(request: ExportRequest, options: ExportRunOptions = {}): Promise<boolean> {
    const session = this.session;
    if (!session.document) return false;
    if (request.cmyk && !profileHasFeature(this.profile, 'cmyk-export', this.capabilities)) return false;
    try {
      session.commitTransform();
      const plan = planExport(session.document, request);
      const single = plan.length === 1;
      const name = single ? plan[0]!.name : `${request.baseName ?? session.projectName ?? this.workspace.current.title} export.zip`;
      const files = this.capabilities.files;
      let target: FileSaveTarget | null = null;
      if (files) {
        target = await files.chooseSaveTarget(name, single ? request.format : 'zip');
        if (!target) return false;
      }
      const targetHost = this.host as FileTargetHost;
      const streamable = single && request.format === 'png' && !request.cmyk
        && plan[0]!.width * plan[0]!.height >= 1_000_000;
      const sink = streamable && target && targetHost.openFileSink ? await targetHost.openFileSink(target) : null;
      if (sink) {
        const pipeline = await import('../io/exportPipeline');
        if (pipeline.canStreamPngExport(session.document, request)) {
          try {
            await this.whenFullyResolved();
            session.commitTransform();
            const renderer = await this.exportRenderer();
            this.suppressCompositorHydration++;
            try {
              await this.trackResolution(session.runHydrated('export', () => pipeline.runPngExportToSink(
                session.document, request, renderer, (chunk) => sink.write(chunk), options)));
            } finally { this.suppressCompositorHydration--; }
            await sink.close();
            return true;
          } catch (error) { await sink.abort().catch(() => {}); throw error; }
        }
      }
      const encoded = await this.exportFiles(request, options, session);
      const blob = single
        ? new Blob([encoded[0]!.bytes as Uint8Array<ArrayBuffer>], { type: encoded[0]!.mime })
        : new Blob([zipSync(Object.fromEntries(encoded.map((file) => [file.name, [file.bytes, { level: 0 }]]))) as Uint8Array<ArrayBuffer>],
          { type: 'application/zip' });
      if (target && files) await files.writeFile(target, blob);
      else await this.host.saveFile(blob, name);
      if (request.format === 'jpeg') storeQuality(request.quality ?? this.jpegOptions.quality);
      return true;
    } catch (error) { this.reportError('export-failed', error); return false; }
  }

  async exportBlob(format: 'png' | 'jpeg', options: Partial<JpegOptions> = {}, session: EditorSession = this.session): Promise<Blob> {
    const jpeg = { ...this.jpegOptions, ...options };
    const request = this.exportRequest(format, format === 'jpeg'
      ? { quality: jpeg.quality, matte: { red: jpeg.red, green: jpeg.green, blue: jpeg.blue } } : {}, session);
    const [file] = await this.exportFiles(request, {}, session);
    return new Blob([file!.bytes as Uint8Array<ArrayBuffer>], { type: file!.mime });
  }

  async closeTab(id: string): Promise<void> {
    const tab = this.workspace.tabs.find((t) => t.id === id);
    if (!tab || !this.workspace.canSwitch) return;
    if (tab.session.isModified && tab.session.document) {
      const answer = await this.confirm(this.t('Close without saving?'), this.t('Unsaved changes will be lost.'),
        [{ label: this.t('Save'), value: 'save', role: 'default' }, { label: this.t('Cancel'), value: 'cancel', role: 'cancel' },
          { label: this.t('Don’t Save'), value: 'discard', role: 'destructive' }]);
      if (answer === 'cancel') return;
      if (answer === 'save') {
        this.workspace.select(id);
        await this.save();
        if (tab.session.isModified) return;
      }
    }
    this.workspace.removeTab(id);
  }

  async mergeLayers(): Promise<void> {
    await this.session.mergeLayers((raster) => trimToAlpha(raster));
  }

  // MARK: Public handle (contracts.ts EditorHandle)

  handle(destroy: () => void): EditorHandleV2 {
    return {
      newProject: async ({ name, width, height }) => {
        if (!(Number.isInteger(width) && Number.isInteger(height) && width >= 1 && height >= 1
          && width <= this.limits.maxSide && height <= this.limits.maxSide && width * height <= this.limits.maxPixels)) {
          throw new ProjectError('invalid-size', `Enter dimensions within ${this.limits.maxSide.toLocaleString()} pixels per side and ${Math.floor(this.limits.maxPixels / 1_000_000)} megapixels.`);
        }
        const tab = this.workspace.current.session.document ? this.workspace.newCanvas() ?? this.workspace.current : this.workspace.current;
        const session = tab.session;
        session.clearProject();
        session.createDocument(width, height, false);
        session.history.reset();
        session.projectName = name;
        session.notify('document');
      },
      importImage: async (file: Blob, name: string): Promise<LayerId> => {
        const session = this.session;
        const result = await this.imports.enqueue(session, [{ name, read: async () => new Uint8Array(await file.arrayBuffer()) }]);
        const failure = result.failures[0];
        if (failure) {
          const error = failure.error;
          const code = error instanceof ImageImportError ? error.code : 'unreadable';
          this.host.reportError({ code: `import-${code}`, message: error instanceof Error ? error.message : String(error) });
          throw error;
        }
        const id = result.layerIds[0];
        if (!id) throw new Error('The image could not be imported.');
        return id;
      },
      openProject: async (archive: Blob) => {
        try { await this.openArchive(archive); } catch (error) {
          this.host.reportError({ code: error instanceof ProjectError ? error.code : 'open-failed',
            message: technicalErrorMessage(error, 'Opening the project failed.') });
          throw error;
        }
      },
      saveProject: async () => this.archive(),
      exportImage: async ({ format, quality }) => this.exportBlob(format, quality === undefined ? {} : { quality }),
      getManifest: () => this.manifest(),
      getManifestV2: () => this.manifestV2(),
      undo: async () => this.session.undo(),
      redo: async () => this.session.redo(),
      destroy,
    };
  }

  destroy(): void {
    for (const timer of this.recoveryTimers.values()) clearTimeout(timer);
    for (const off of this.recoveryWatchers.values()) off();
    this.workspaceRecoveryOff?.();
    const recovery = this.recovery;
    if (recovery) {
      const ids = [...this.recoveryWatchers.keys()];
      void Promise.allSettled(ids.map((id) => this.enqueueRecoveryOperation(id, () => recovery.remove(id))))
        .then(() => recovery.collectGarbage()).finally(() => recovery.close());
    }
    this.workspace.destroy();
  }

  private liveScratchKeys(): Set<string> {
    if (!this.residency) return new Set();
    const rasters: Raster[] = [];
    for (const tab of this.workspace.tabs) {
      rasters.push(...tab.session.rastersForCommand('save'));
    }
    return this.residency.referencedKeys(rasters);
  }
}

/** PixelFilter.trimmed semantics for merge results: tight alpha bounds, or null when empty. */
export function trimToAlpha(raster: Raster): { raster: Raster; x: number; y: number } | null {
  const bounds = alphaBounds(raster);
  if (!bounds) return null;
  if (bounds.x === 0 && bounds.y === 0 && bounds.width === raster.width && bounds.height === raster.height) return { raster, x: 0, y: 0 };
  return { raster: cropRaster(raster, bounds.x, bounds.y, bounds.width, bounds.height), x: bounds.x, y: bounds.y };
}
function documentRasters(document: CanvasDocument | null): Raster[] {
  if (!document) return [];
  const rasters: Raster[] = [];
  for (const layer of document.layers) {
    if (layer.raster) rasters.push(layer.raster);
    if (layer.mask) rasters.push(layer.mask.raster);
  }
  if (document.selection) rasters.push(document.selection.mask);
  return rasters;
}

function storedQuality(): number {
  const value = Number(globalThis.localStorage?.getItem('compositor.jpegExportQuality'));
  return Number.isFinite(value) && value >= 0 && value <= 1 && globalThis.localStorage?.getItem('compositor.jpegExportQuality') !== null ? value : DEFAULT_JPEG.quality;
}
function storeQuality(value: number): void { try { globalThis.localStorage?.setItem('compositor.jpegExportQuality', String(value)); } catch { /* private mode */ } }
