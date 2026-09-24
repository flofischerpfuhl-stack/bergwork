/**
 * Glue between the host page, the project workspace, the renderer and the React views.
 * Holds no document state of its own: documents live in the core sessions.
 */

import type { HostAdapter, LayerId, ProjectManifestV1 } from '../../contracts';
import type { EditorHandleV2, ProjectManifestV2 } from '../../contracts-v2';
import { MAX_SIDE, type CanvasDocument } from '../core/document';
import { Raster, alphaBounds, cropRaster } from '../core/raster';
import type { EditorSession, SessionServices, Tool } from '../core/session';
import type { ReactNode } from 'react';
import { setShortcutLocale, type FeatureRegistry } from './menus';
import type { IconName } from './icons';
import type { CanvasView } from './canvas/CanvasView';
import type { Modifiers, ToolHandler } from './canvas/tools';
import type { Point } from '../core/geometry';
import { pixelClipboard, type ClipboardHooks, type PixelClipboardEntry } from '../core/clipboard';
import { failureMessage, ImportQueue } from '../core/importQueue';
import { ProjectWorkspace, type ProjectTab } from '../core/workspace';
import { buildManifest, buildManifestV2, readArchive, writeArchive, ProjectError } from '../io/project';
import { readCompPackage, readCompZip, writeCompZip } from '../io/compPackage';
import { unzipSync } from 'fflate';
import { encodeArchive } from '../workers/archiveClient';
import { isQuotaError, RecoveryStore } from '../platform/recovery';
import { browserDecode, decodeImageFile, fileBaseName, ImageImportError } from '../io/imageImport';
import { DEFAULT_JPEG, jpegBlob, pngBlob, type JpegOptions } from '../io/export';
import { encodePng } from '../io/png';
import { sha256Hex } from '../io/sha256';
import type { GpuCompositor } from '../render/gpuCompositor';
import type { FileTargetHost, SaveTarget } from '../platform/browserHost';
import type { ImageDecoderHost } from '../platform/imageDecoder';
import { translator, type Locale } from './i18n';
import { createUiStore, type Dialog, type UiStore } from './store';
import { describeError, isCancellation } from './errors';

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
const saveTargets = new WeakMap<EditorSession, SaveTarget>();

export class EditorController {
  readonly workspace: ProjectWorkspace;
  readonly host: HostAdapter;
  readonly t: (text: string) => string;
  readonly locale: Locale;
  readonly theme: 'dark' | 'light';
  readonly ui: UiStore = createUiStore();
  private readonly imports: ImportQueue;
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
  canvasInterceptors: ((session: EditorSession, modifiers: Modifiers, point: Point | null) => ToolHandler | null)[] = [];
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
  jpegOptions: JpegOptions = { ...DEFAULT_JPEG, quality: storedQuality() };

  constructor(host: HostAdapter, locale: Locale, theme: 'dark' | 'light') {
    this.host = host;
    this.locale = locale;
    this.theme = theme;
    this.t = translator(locale);
    setShortcutLocale(locale);
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
    };
    this.workspace = new ProjectWorkspace(services);
  }

  /** Uses optional capabilities carried by the mount host without widening contracts.ts. */
  decodeImage(bytes: Uint8Array, remainingPixels: number) {
    return decodeImageFile(bytes, remainingPixels, { host: this.host as HostAdapter & ImageDecoderHost });
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

  /** Origin and licences (the MIT notice of the code base this editor grew from belongs here, not in menus or formats). */
  showAbout(): void {
    this.alert(this.t('Fernwork Image Editor'), [
      this.t('Works offline. No account, no telemetry.'),
      this.t('Parts of this editor are based on Compositor by Wonder Assembly LLC (MIT License).'),
      this.t('Third-party components and their licences: Little CMS (MIT), libjpeg-turbo (IJG/BSD), ONNX Runtime Web (MIT), U²-Netp (Apache-2.0), BiRefNet (MIT, optional download), PixiJS, React, zustand, immer, idb, fflate (MIT/ISC). The optional HEIC decoder (LGPL-3.0) is only loaded when the host enables it.'),
    ].join('\n\n'));
  }
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
    const result = await this.imports.enqueue(into.session, files.map((file) => ({
      name: file.name,
      layerName: fileBaseName(file.name),
      read: async () => new Uint8Array(await file.arrayBuffer()),
    })), { point });
    const message = failureMessage(result);
    if (message) this.reportError('import-failed', new Error(message), this.t('Import couldn’t finish'));
    return [...result.layerIds];
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
      if (files.length) await this.importFiles(files);
    } catch (error) { this.reportError('import-failed', error, this.t('Import couldn’t finish')); }
  }

  async openArchive(blob: Blob, name?: string): Promise<void> {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    // A zipped macOS Compositor package (`X.comp/…`, format com.compositor.project) or this port's own archive.
    if (isCompZip(bytes)) {
      const loaded = await readCompZip(bytes);
      this.installLoaded(loaded.document, loaded.activeLayerId, name?.replace(/\.comp$/i, '') ?? loaded.name);
      return;
    }
    const loaded = await readArchive(blob, (data, mime) => browserDecode(data, mime));
    const tab = this.workspace.createTab(name ?? loaded.name);
    tab.session.installProject(loaded.document, loaded.activeLayerId, name ?? loaded.name, loaded.history);
    this.workspace.adopt(tab);
  }

  private installLoaded(document: CanvasDocument, activeLayerId: string | null, name: string): void {
    const tab = this.workspace.createTab(name);
    tab.session.installProject(document, activeLayerId, name);
    this.workspace.adopt(tab);
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
      const host = this.host as FileTargetHost;
      const target = host.chooseSaveTarget ? await host.chooseSaveTarget(`${name}.comp.zip`, 'project') : null;
      if (host.chooseSaveTarget && !target) return;
      const bytes = await writeCompZip(session.document ?? document, { name, activeLayerId: session.activeLayerId });
      const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/zip' });
      if (target && host.saveFileTo) await host.saveFileTo(target, blob);
      else await this.host.saveFile(blob, `${name}.comp.zip`);
    } catch (error) { this.reportError('save-failed', error); }
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
    const document = session.document;
    if (!document) throw new ProjectError('no-document', 'There is no canvas to save.');
    session.commitTransform();
    const final = session.document ?? document;
    const name = session.projectName ?? this.workspace.current.title;
    // The worker populates the encoded-raster cache; the cheap second pass adds the command/tile history.
    await encodeArchive(final, name, session.activeLayerId);
    return writeArchive(final, name, session.activeLayerId, this.saveHistoryWithProject ? session.history.exportState() : undefined).blob;
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
      const name = session.projectName ?? tab.title;
      await encodeArchive(session.document, name, session.activeLayerId);
      const archive = writeArchive(session.document, name, session.activeLayerId, session.history.exportState()).blob;
      await store.put({ id: tab.id, name: session.projectName ?? tab.title, savedAt: Date.now(), size: archive.size, archive });
    } catch (error) {
      if (isQuotaError(error)) {
        this.recoveryPaused.add(tab.id);
        this.reportError('storage-quota', new Error(this.t('Browser storage is full. Automatic recovery copies of this project are paused; save the project to keep your work.')));
      } else this.host.reportError({ code: 'recovery-write-failed', message: (error as Error).message });
    }
  }

  /**
   * Save overwrites the place the project was last saved to; Save As (or the first save) asks where (ProjectController.save).
   * The destination is chosen before the archive is encoded: a browser shows its save dialog only while the click or key
   * press that asked for it still counts, and encoding a large document takes longer than that.
   */
  async save(saveAs = false): Promise<void> {
    const session = this.session;
    if (!session.document || !this.workspace.canSwitch) return;
    try {
      const name = `${session.projectName ?? this.workspace.current.title}.fwimg`;
      const host = this.host as FileTargetHost;
      let target = saveAs ? undefined : saveTargets.get(session);
      if (!target && host.chooseSaveTarget) {
        const chosen = await host.chooseSaveTarget(name, 'project');
        // Cancelled: nothing is written, so the project stays unsaved.
        if (!chosen) return;
        target = chosen;
      }
      const blob = await this.archive(session);
      if (target && host.saveFileTo) {
        await host.saveFileTo(target, blob);
        saveTargets.set(session, target);
        session.projectName = target.name.replace(/(\.fwimg|\.compositor\.zip|\.zip)$/i, '');
      } else await this.host.saveFile(blob, name);
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

  /** Export: choose the file first (see save), then read the pixels back and encode. */
  async exportTo(format: 'png' | 'jpeg'): Promise<void> {
    const session = this.session;
    if (!session.document) return;
    try {
      const name = `${session.projectName ?? this.workspace.current.title}.${format === 'png' ? 'png' : 'jpg'}`;
      const host = this.host as FileTargetHost;
      let target: SaveTarget | null = null;
      if (host.chooseSaveTarget) {
        target = await host.chooseSaveTarget(name, format);
        if (!target) return;
      }
      const blob = await this.exportBlob(format);
      if (format === 'jpeg') storeQuality(this.jpegOptions.quality);
      if (target && host.saveFileTo) await host.saveFileTo(target, blob);
      else await this.host.saveFile(blob, name);
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

  handle(destroy: () => void): EditorHandleV2 {
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
          this.host.reportError({ code: error instanceof ProjectError ? error.code : 'open-failed', message: (error as Error).message });
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
