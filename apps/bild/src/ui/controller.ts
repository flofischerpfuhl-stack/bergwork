/**
 * Glue between the host page, the project workspace, the renderer and the React views.
 * Holds no document state of its own: documents live in the core sessions.
 */

import type { EditorHandle, HostAdapter, LayerId, ProjectManifestV1 } from '../../contracts';
import { MAX_SIDE, type CanvasDocument } from '../core/document';
import { Raster, alphaBounds, cropRaster } from '../core/raster';
import type { EditorSession, SessionServices, Tool } from '../core/session';
import type { ReactNode } from 'react';
import type { FeatureRegistry } from './menus';
import type { IconName } from './icons';
import type { CanvasView } from './canvas/CanvasView';
import type { ToolHandler } from './canvas/tools';
import type { ClipboardHooks } from '../core/clipboard';
import { ProjectWorkspace, type ProjectTab } from '../core/workspace';
import { buildManifest, readArchive, ProjectError } from '../io/project';
import { encodeArchive } from '../workers/archiveClient';
import { isQuotaError, RecoveryStore } from '../platform/recovery';
import { browserDecode, decodeImageFile, fileBaseName, ImageImportError } from '../io/imageImport';
import { DEFAULT_JPEG, jpegBlob, pngBlob, type JpegOptions } from '../io/export';
import type { GpuCompositor } from '../render/gpuCompositor';
import { translator, type Locale } from './i18n';
import { createUiStore, type Dialog, type UiStore } from './store';

export interface ColorPickRequest {
  readonly title: string;
  readonly initial: { red: number; green: number; blue: number };
  /** Live preview while the picker is open (optional). */
  preview?(color: { red: number; green: number; blue: number }): void;
  commit(color: { red: number; green: number; blue: number }): void;
  cancel?(): void;
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
}

export class EditorController {
  readonly workspace: ProjectWorkspace;
  readonly host: HostAdapter;
  readonly t: (text: string) => string;
  readonly locale: Locale;
  readonly theme: 'dark' | 'light';
  readonly ui: UiStore = createUiStore();
  canvas: CanvasHost | null = null;
  /** The mounted canvas view (tools, overlay painters, touch toggles). */
  canvasView: CanvasView | null = null;
  private canvasWaiters: (() => void)[] = [];
  /** Commands provided by feature modules (selection, brushes, adjustments…), keyed by menu command. */
  features: FeatureRegistry = {};
  /** Tools with a working canvas handler; the rest are shown disabled. */
  availableTools = new Set<Tool>(['move', 'hand', 'zoom', 'idle']);
  contextBars: Partial<Record<Tool, (session: EditorSession) => ReactNode>> = {};
  statusHints: Partial<Record<Tool, (session: EditorSession) => string>> = {};
  toolIcon: ((tool: Tool) => IconName | null) | null = null;
  openColorPicker: ((background: boolean) => void) | null = null;
  /** Opens the app's color picker panel for any color (palette, Gradient Map ends…), provided by the painting module. */
  pickColor: ((request: ColorPickRequest) => void) | null = null;
  /** Called once the canvas view exists, so modules can register tools and overlay painters. */
  canvasSetups: ((view: CanvasView) => void)[] = [];
  /** Extra dialogs by kind (Canvas Size, Image Size, adjustment panels…). */
  dialogs: Record<string, (close: () => void) => ReactNode> = {};
  /** Module key handlers; return true when the key was handled. */
  keyHandlers: ((event: KeyboardEvent) => boolean)[] = [];
  /** Non-modal panels drawn over the canvas (adjustment and filter panels). */
  panels: (() => ReactNode)[] = [];
  /** Canvas input taken over by an open panel (eyedroppers), ahead of the current tool. */
  canvasInterceptors: ((session: EditorSession) => ToolHandler | null)[] = [];
  /** Secondary-button (right) drags on the canvas, e.g. resizing the brush; the first that accepts the press owns it. */
  secondaryDrags: ((session: EditorSession) => SecondaryDrag | null)[] = [];
  /** Number keys for tools with their own opacity (brushes, gradient); true when handled. */
  opacityKey: ((digit: number) => boolean) | null = null;
  clipboardImageSize: (() => Promise<{ width: number; height: number } | null>) | null = null;

  /** Tool keys: some keys also switch a tool's mode (E erases, Shift-U switches shapes). */
  selectToolByKey(tool: Tool, key: string, shift: boolean): void {
    const special = this.toolKeyHandlers[key];
    if (special) { special(shift); return; }
    this.session.selectTool(tool);
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
  pasteEvent: ((event: ClipboardEvent) => boolean) | null = null;
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
  jpegOptions: JpegOptions = { ...DEFAULT_JPEG, quality: storedQuality() };

  constructor(host: HostAdapter, locale: Locale, theme: 'dark' | 'light') {
    this.host = host;
    this.locale = locale;
    this.theme = theme;
    this.t = translator(locale);
    const services: SessionServices = {
      flatten: async (document) => this.flatten(document),
      bakeLiveMask: async (document, targetId) => this.bakeLiveMask(document, targetId),
      confirmLiveMaskDeletion: async (count) => (await this.confirm(
        this.t(count === 1 ? 'This layer supplies a live mask' : 'These layers supply live masks'),
        this.t('Bake keeps the current masked appearance in the dependent layers’ pixels. Remove Links reveals their pixels. You can undo either choice.'),
        [{ label: this.t('Bake and Delete'), value: 'bake', role: 'default' }, { label: this.t('Cancel'), value: 'cancel', role: 'cancel' },
          { label: this.t('Remove Links and Delete'), value: 'unlink' }])) as 'bake' | 'unlink' | 'cancel',
    };
    this.workspace = new ProjectWorkspace(services);
  }

  get session(): EditorSession { return this.workspace.current.session; }

  attachCanvas(canvas: CanvasHost | null): void {
    this.canvas = canvas;
    if (canvas) { for (const waiter of this.canvasWaiters.splice(0)) waiter(); }
  }
  private async readyCanvas(): Promise<CanvasHost> {
    if (this.canvas) return this.canvas;
    await new Promise<void>((resolve) => this.canvasWaiters.push(resolve));
    return this.canvas!;
  }

  // MARK: Dialogs

  showDialog(dialog: Dialog | null): void { this.ui.setState({ dialog, openMenu: null }); }
  alert(title: string, message: string): void { this.showDialog({ kind: 'alert', title, message }); }
  confirm(title: string, message: string, buttons: Extract<Dialog, { kind: 'confirm' }>['buttons']): Promise<string> {
    return new Promise((resolve) => this.showDialog({ kind: 'confirm', title, message, buttons, resolve: (value) => { this.showDialog(null); resolve(value); } }));
  }
  reportError(code: string, error: unknown, title = this.t('Something went wrong')): void {
    const message = error instanceof Error ? error.message : String(error);
    this.host.reportError({ code, message });
    this.alert(title, message);
  }

  // MARK: Rendering services

  private async flatten(document: CanvasDocument): Promise<Raster> {
    const canvas = await this.readyCanvas();
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

  async importFiles(files: readonly File[], into: ProjectTab = this.workspace.current, point: { x: number; y: number } | null = null): Promise<string[]> {
    const session = into.session;
    const failures: string[] = [];
    const ids: string[] = [];
    if (!files.length) return ids;
    session.commitTransform();
    session.isImporting = true;
    session.notify('ui');
    try {
      session.beginEdit('Import Images');
      for (const file of files) {
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const raster = await decodeImageFile(bytes, session.remainingPixelBudget());
          session.isImporting = false;
          ids.push(session.insertRaster(raster, fileBaseName(file.name), session.document ? point : null));
          session.isImporting = true;
        } catch (error) {
          failures.push(`${file.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } finally {
      session.isImporting = false;
      session.endEdit();
    }
    if (failures.length) this.reportError('import-failed', new Error(failures.join('\n\n')), this.t('Import couldn’t finish'));
    return ids;
  }

  async chooseAndImport(): Promise<void> {
    try {
      const files = await this.host.chooseImages();
      if (files.length) await this.importFiles(files);
    } catch (error) { this.reportError('import-failed', error, this.t('Import couldn’t finish')); }
  }

  async openArchive(blob: Blob, name?: string): Promise<void> {
    const loaded = await readArchive(blob, (bytes, mime) => browserDecode(bytes, mime));
    const tab = this.workspace.createTab(name ?? loaded.name);
    tab.session.installProject(loaded.document, loaded.activeLayerId, name ?? loaded.name);
    this.workspace.adopt(tab);
  }

  async chooseAndOpen(): Promise<void> {
    if (!this.workspace.canSwitch) return;
    try {
      const blob = await this.host.chooseProject();
      if (blob) await this.openArchive(blob, blob instanceof File ? fileBaseName(blob.name) : undefined);
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

  async archive(session: EditorSession = this.session): Promise<Blob> {
    const document = session.document;
    if (!document) throw new ProjectError('no-document', 'There is no canvas to save.');
    session.commitTransform();
    const final = session.document ?? document;
    return encodeArchive(final, session.projectName ?? this.workspace.current.title, session.activeLayerId);
  }

  // MARK: Recovery copies (IndexedDB)

  private recovery: RecoveryStore | null = null;
  private recoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private recoveryPaused = new Set<string>();
  private recoveryWatchers = new Map<string, () => void>();

  /** Offers archives left by an earlier page load, then keeps copies of modified tabs. */
  async startRecovery(): Promise<void> {
    if (!RecoveryStore.available()) return;
    this.recovery = new RecoveryStore();
    try {
      const previous = await this.recovery.previous();
      if (previous.length) {
        const answer = await this.confirm(this.t(previous.length === 1 ? 'Recover an unsaved project?' : 'Recover unsaved projects?'),
          previous.map((r) => `${r.name} · ${new Date(r.savedAt).toLocaleString(this.locale)}`).join('\n'),
          [{ label: this.t('Recover'), value: 'recover', role: 'default' }, { label: this.t('Discard'), value: 'discard', role: 'destructive' },
            { label: this.t('Later'), value: 'later', role: 'cancel' }]);
        if (answer === 'recover') {
          for (const record of previous) {
            try { await this.openArchive(record.archive, record.name); await this.recovery.remove(record.id); } catch (error) { this.reportError('recovery-failed', error); }
          }
          for (const tab of this.workspace.tabs) tab.session.history.markUnsaved();
        } else if (answer === 'discard') {
          for (const record of previous) await this.recovery.remove(record.id);
        }
      }
    } catch (error) {
      this.host.reportError({ code: 'recovery-unavailable', message: (error as Error).message });
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
      this.recoveryWatchers.set(tab.id, tab.session.subscribe((kind) => { if (kind === 'document') this.scheduleRecoveryCopy(tab); }));
    }
  }

  private scheduleRecoveryCopy(tab: ProjectTab): void {
    clearTimeout(this.recoveryTimers.get(tab.id));
    this.recoveryTimers.set(tab.id, setTimeout(() => void this.writeRecoveryCopy(tab), 2500));
  }

  private async writeRecoveryCopy(tab: ProjectTab): Promise<void> {
    const store = this.recovery, session = tab.session;
    if (!store || this.recoveryPaused.has(tab.id)) return;
    if (session.isProjectBusy || session.transformEdit || session.history.isInTransaction) { this.scheduleRecoveryCopy(tab); return; }
    if (!session.document || !session.isModified) { await store.remove(tab.id).catch(() => undefined); return; }
    try {
      const archive = await encodeArchive(session.document, session.projectName ?? tab.title, session.activeLayerId);
      await store.put({ id: tab.id, name: session.projectName ?? tab.title, savedAt: Date.now(), size: archive.size, archive });
    } catch (error) {
      if (isQuotaError(error)) {
        this.recoveryPaused.add(tab.id);
        this.reportError('storage-quota', new Error(this.t('Browser storage is full. Automatic recovery copies of this project are paused; save the project to keep your work.')));
      } else this.host.reportError({ code: 'recovery-write-failed', message: (error as Error).message });
    }
  }

  async save(): Promise<void> {
    const session = this.session;
    if (!session.document || !this.workspace.canSwitch) return;
    try {
      const blob = await this.archive(session);
      const name = `${session.projectName ?? this.workspace.current.title}.compositor.zip`;
      await this.host.saveFile(blob, name);
      session.projectName ??= this.workspace.current.title;
      session.history.markSaved();
      this.recoveryPaused.delete(this.workspace.current.id);
      void this.recovery?.remove(this.workspace.current.id);
      session.notify('ui');
    } catch (error) { this.reportError('save-failed', error); }
  }

  async exportBlob(format: 'png' | 'jpeg', options: Partial<JpegOptions> = {}, session: EditorSession = this.session): Promise<Blob> {
    const document = session.document;
    if (!document) throw new ProjectError('no-document', 'There is no canvas to export.');
    if (document.width * document.height > 100_000_000 || document.width > MAX_SIDE || document.height > MAX_SIDE) {
      throw new ProjectError('too-large', 'Image export supports canvases up to 100 megapixels and 30,000 pixels per side.');
    }
    session.commitTransform();
    const canvas = await this.readyCanvas();
    const pixels = canvas.readRegion(document, 0, 0, document.width, document.height);
    if (format === 'png') return pngBlob(pixels, document.width, document.height, document.resolution);
    return jpegBlob(pixels, document.width, document.height, document.resolution, { ...this.jpegOptions, ...options });
  }

  async exportTo(format: 'png' | 'jpeg'): Promise<void> {
    const session = this.session;
    if (!session.document) return;
    try {
      const blob = await this.exportBlob(format);
      if (format === 'jpeg') storeQuality(this.jpegOptions.quality);
      await this.host.saveFile(blob, `${session.projectName ?? this.workspace.current.title}.${format === 'png' ? 'png' : 'jpg'}`);
    } catch (error) { this.reportError('export-failed', error); }
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

  handle(destroy: () => void): EditorHandle {
    return {
      newProject: async ({ name, width, height }) => {
        if (!(Number.isInteger(width) && Number.isInteger(height) && width >= 1 && height >= 1 && width <= MAX_SIDE && height <= MAX_SIDE)) {
          throw new ProjectError('invalid-size', 'Enter whole numbers from 1 to 30,000 pixels.');
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
        session.commitTransform();
        const bytes = new Uint8Array(await file.arrayBuffer());
        let raster: Raster;
        try { raster = await decodeImageFile(bytes, session.remainingPixelBudget()); } catch (error) {
          const code = error instanceof ImageImportError ? error.code : 'unreadable';
          this.host.reportError({ code: `import-${code}`, message: (error as Error).message });
          throw error;
        }
        return session.insertRaster(raster, name);
      },
      openProject: async (archive: Blob) => {
        try { await this.openArchive(archive); } catch (error) {
          this.host.reportError({ code: error instanceof ProjectError ? error.code : 'open-failed', message: (error as Error).message });
          throw error;
        }
      },
      saveProject: async () => this.archive(),
      exportImage: async ({ format, quality }) => this.exportBlob(format, quality === undefined ? {} : { quality }),
      getManifest: () => this.manifest(),
      undo: async () => this.session.undo(),
      redo: async () => this.session.redo(),
      destroy,
    };
  }

  destroy(): void {
    for (const timer of this.recoveryTimers.values()) clearTimeout(timer);
    for (const off of this.recoveryWatchers.values()) off();
    this.workspaceRecoveryOff?.();
    this.recovery?.close();
    this.workspace.destroy();
  }
}

/** PixelFilter.trimmed semantics for merge results: tight alpha bounds, or null when empty. */
export function trimToAlpha(raster: Raster): { raster: Raster; x: number; y: number } | null {
  const bounds = alphaBounds(raster);
  if (!bounds) return null;
  if (bounds.x === 0 && bounds.y === 0 && bounds.width === raster.width && bounds.height === raster.height) return { raster, x: 0, y: 0 };
  return { raster: cropRaster(raster, bounds.x, bounds.y, bounds.width, bounds.height), x: bounds.x, y: bounds.y };
}

function storedQuality(): number {
  const value = Number(globalThis.localStorage?.getItem('compositor.jpegExportQuality'));
  return Number.isFinite(value) && value >= 0 && value <= 1 && globalThis.localStorage?.getItem('compositor.jpegExportQuality') !== null ? value : DEFAULT_JPEG.quality;
}
function storeQuality(value: number): void { try { globalThis.localStorage?.setItem('compositor.jpegExportQuality', String(value)); } catch { /* private mode */ } }
