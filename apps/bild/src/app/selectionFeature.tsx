/**
 * Selection tools and Select/Edit menu commands in the UI: Marquee (rectangle/ellipse), Lasso
 * (freehand/polygonal), selection moving, marching ants, the LassoControls header and the menu
 * items. Ported from Selection.swift (drafts, modes), EditorCanvas.swift (lassoMouseDown,
 * dragMarqueeDraft, selection drags), TransformOverlay.swift (ants, drafts), LassoControls.swift.
 * Pixel work comes from the selection engine (selectionOps/selectionCommands/clipboard).
 */

import styles from '../ui/editor.module.css';
import type { EditorController } from '../ui/controller';
import { useSession } from '../ui/hooks';
import { NumberField } from '../ui/ContextBar';
import type { EditorSession } from '../core/session';
import type { CanvasDocument } from '../core/document';
import { Raster } from '../core/raster';
import type { Point } from '../core/geometry';
import type { DocumentSelection, LassoKind, SelectionMode } from '../core/selection';
import { selectionIsEmpty } from '../core/selection';
import {
  dragBoxRect, ellipseSelection, polygonSelection, rectangleSelection, selectionOutline, type SelectionPolyline,
} from '../core/selectionOps';
import {
  addMaskFromSelection, applySelection, beginSelectionMove, beginSelectionTransform, canEditPixels, canEditSelection,
  canInvertPixels, canModifySelection, canMoveSelection, canTransformSelection, clearSelectedPixels, contractSelection,
  deleteKeyPressed, deselect, displayedSelection, endSelectionMove, expandSelection, fillSelection, invertPixels,
  beginPixelMove, cancelPixelMove, finishPixelMove, movePixels, nudgePixels, pixelMoveState,
  invertSelection, loadLayerSelection, loadMaskSelection, nudgeSelection, previewSelectionMove, selectAll,
} from '../core/selectionCommands';
import {
  canCopyMerged, canCopyPixels, canCutPixels, canPaste, copyMergedSelection, copySelection, cutSelection, layerViaCopy, paste,
} from '../core/clipboard';
import type { ToolContext, ToolHandler } from '../ui/canvas/tools';
import { pixelClipboard } from '../core/clipboard';
import { encodePng } from '../io/png';
import { sha256Hex } from '../io/sha256';
import { decodeImageFile } from '../io/imageImport';

interface LassoDraft { points: Point[]; cursor: Point | null; mode: SelectionMode; kind: LassoKind; anchor: Point | null }

/** Per-project selection tool settings (EditorSession: lassoKind, marqueeKind, selectionModeChoice…). */
export interface SelectionToolState {
  draft: LassoDraft | null;
  marqueeKind: LassoKind;
  lassoKind: LassoKind;
  modeChoice: SelectionMode;
  heldMode: SelectionMode | null;
  antialiased: boolean;
  expandAmount: number;
  contractAmount: number;
}

const states = new WeakMap<EditorSession, SelectionToolState>();
export function selectionState(session: EditorSession): SelectionToolState {
  let state = states.get(session);
  if (!state) {
    state = { draft: null, marqueeKind: 'Rectangle', lassoKind: 'Freehand', modeChoice: 'New', heldMode: null, antialiased: true, expandAmount: 1, contractAmount: 1 };
    states.set(session, state);
  }
  return state;
}

/** Shift adds, Option (with or without Shift) subtracts; otherwise the options-bar mode. */
function modeFor(state: SelectionToolState, shift: boolean, option: boolean): SelectionMode {
  return option ? 'Subtract' : shift ? 'Add' : state.modeChoice;
}

function finishLasso(session: EditorSession): void {
  const state = selectionState(session);
  const draft = state.draft;
  state.draft = null;
  const document = session.document;
  if (!draft || !document) { session.notify('document'); return; }
  const canvas = { width: document.width, height: document.height };
  const xs = draft.points.map((p) => p.x), ys = draft.points.map((p) => p.y);
  const box = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
  if ((draft.points.length < 3 && draft.kind !== 'Ellipse') || !(box.width > 0 && box.height > 0)) {
    if (draft.mode === 'New') deselect(session);
    session.notify('document');
    return;
  }
  const shape: DocumentSelection = draft.kind === 'Ellipse' ? ellipseSelection(box, canvas, state.antialiased)
    : draft.kind === 'Rectangle' ? rectangleSelection(box, canvas, false)
      : polygonSelection(draft.points, canvas, state.antialiased);
  applySelection(session, shape, draft.mode,
    draft.kind === 'Freehand' ? 'Lasso' : draft.kind === 'Polygonal' ? 'Polygonal Lasso' : draft.kind === 'Ellipse' ? 'Elliptical Marquee' : 'Rectangular Marquee');
  session.notify('document');
}

function cancelLasso(session: EditorSession): void {
  const state = selectionState(session);
  if (!state.draft) return;
  state.draft = null;
  session.notify('document');
}

class SelectionTool implements ToolHandler {
  private moveStart: Point | null = null;
  private moved = false;
  private constrainArmed = true;
  constructor(private readonly controller: EditorController, private readonly marquee: boolean) {}

  /** Drawing a Marquee box or moving a selection scrolls at the canvas edge (stepMarqueeAutoscroll). */
  autoscrolls(session: EditorSession): boolean {
    const kind = selectionState(session).draft?.kind;
    return kind === 'Rectangle' || kind === 'Ellipse' || this.moveStart !== null;
  }

  down(c: ToolContext): void {
    const session = c.session, state = selectionState(session);
    if (!session.document || !canEditSelection(session)) return;
    this.constrainArmed = !c.modifiers.shift;
    const draft = state.draft;
    if (draft?.kind === 'Polygonal') {
      const first = session.viewport.viewPoint(draft.points[0]!, session.document);
      const radius = c.pointerType === 'touch' ? 22 : 8;
      const now = performance.now();
      const doubleClick = this.lastDown !== null && now - this.lastDown.time < 400 && Math.hypot(c.point.x - this.lastDown.point.x, c.point.y - this.lastDown.point.y) < 6;
      this.lastDown = { time: now, point: c.point };
      if (doubleClick || (draft.points.length >= 3 && Math.hypot(c.point.x - first.x, c.point.y - first.y) <= radius)) finishLasso(session);
      else { draft.points.push(c.pixel); session.notify('document'); }
      return;
    }
    const mode = modeFor(state, c.modifiers.shift, c.modifiers.option);
    // Cmd-drag inside the selection moves pixels; that engine lives with the selection commands.
    if (c.modifiers.command && this.controller.pixelMove && canMoveSelection(session, c.pixel)) {
      if (this.controller.pixelMove.begin(session, c.modifiers.option)) { this.moveStart = c.pixel; this.pixelMoving = true; }
      return;
    }
    // In New mode, dragging inside the selection moves its outline instead of drawing.
    if (mode === 'New' && canMoveSelection(session, c.pixel) && beginSelectionMove(session)) {
      this.moveStart = c.pixel;
      this.moved = false;
      return;
    }
    this.lastDown = { time: performance.now(), point: c.point };
    if (this.marquee) {
      const anchor = { x: Math.round(c.pixel.x), y: Math.round(c.pixel.y) };
      state.draft = { points: [anchor], cursor: null, mode, kind: state.marqueeKind, anchor };
    } else {
      state.draft = { points: [c.pixel], cursor: null, mode, kind: state.lassoKind, anchor: null };
    }
    session.notify('document');
  }
  private pixelMoving = false;
  private lastDown: { time: number; point: Point } | null = null;

  move(c: ToolContext): void {
    const session = c.session, state = selectionState(session);
    if (this.moveStart) {
      let dx = c.pixel.x - this.moveStart.x, dy = c.pixel.y - this.moveStart.y;
      if (c.modifiers.shift) { if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0; }
      if (this.pixelMoving) { this.controller.pixelMove?.move(session, Math.round(dx), Math.round(dy)); return; }
      if (Math.round(dx) || Math.round(dy)) this.moved = true;
      previewSelectionMove(session, Math.round(dx), Math.round(dy));
      session.notify('document');
      return;
    }
    const draft = state.draft;
    if (!draft) return;
    if (draft.kind === 'Freehand') {
      const last = draft.points.at(-1)!;
      if (Math.hypot(c.pixel.x - last.x, c.pixel.y - last.y) >= 0.25) draft.points.push(c.pixel);
    } else if (draft.kind === 'Polygonal') {
      draft.cursor = c.pixel;
    } else if (draft.anchor) {
      if (!c.modifiers.shift) this.constrainArmed = true;
      const rect = dragBoxRect(draft.anchor, c.pixel, this.constrainArmed && c.modifiers.shift, false);
      draft.points = [{ x: rect.x, y: rect.y }, { x: rect.x + rect.width, y: rect.y }, { x: rect.x + rect.width, y: rect.y + rect.height }, { x: rect.x, y: rect.y + rect.height }];
    }
    session.notify('document');
  }

  up(c: ToolContext): void {
    const session = c.session, state = selectionState(session);
    if (this.moveStart) {
      this.moveStart = null;
      if (this.pixelMoving) { this.pixelMoving = false; this.controller.pixelMove?.finish(session); return; }
      endSelectionMove(session);
      // A click without a drag deselects, as anywhere else with the lasso.
      if (!this.moved) deselect(session);
      session.notify('document');
      return;
    }
    if (state.draft && state.draft.kind !== 'Polygonal') finishLasso(session);
  }

  cancel(session: EditorSession): void {
    if (this.moveStart) {
      this.moveStart = null;
      if (this.pixelMoving) { this.pixelMoving = false; this.controller.pixelMove?.cancel(session); return; }
      previewSelectionMove(session, 0, 0);
      endSelectionMove(session);
      return;
    }
    if (selectionState(session).draft?.kind !== 'Polygonal') cancelLasso(session);
  }

  hover(c: ToolContext): string {
    const session = c.session, state = selectionState(session);
    const mode = state.draft?.mode ?? modeFor(state, c.modifiers.shift, c.modifiers.option);
    if ((c.modifiers.command || mode === 'New') && canMoveSelection(session, c.pixel)) return c.modifiers.command ? (c.modifiers.option ? 'copy' : 'move') : 'move';
    return mode === 'Add' ? 'copy' : mode === 'Subtract' ? 'alias' : 'crosshair';
  }
}

// MARK: Overlay

const outlines = new WeakMap<DocumentSelection, SelectionPolyline[]>();
function outlineOf(selection: DocumentSelection): SelectionPolyline[] {
  let cached = outlines.get(selection);
  if (!cached) { cached = selectionOutline(selection); outlines.set(selection, cached); }
  return cached;
}

function paintSelection(context: CanvasRenderingContext2D, session: EditorSession, time: number): void {
  const document = session.document;
  if (!document) return;
  const selection = displayedSelection(session);
  const view = (p: Point) => session.viewport.viewPoint(p, document);
  if (selection && !selectionIsEmpty(selection)) {
    const path = new Path2D();
    for (const line of outlineOf(selection)) {
      line.forEach((p, i) => { const v = view(p); if (i) path.lineTo(v.x, v.y); else path.moveTo(v.x, v.y); });
      path.closePath();
    }
    context.lineWidth = 1;
    context.strokeStyle = '#fff';
    context.stroke(path);
    context.setLineDash([4, 4]);
    context.lineDashOffset = -(Math.floor(time / 120) % 8);
    context.strokeStyle = '#000';
    context.stroke(path);
    context.setLineDash([]);
  }
  const draft = selectionState(session).draft;
  if (!draft) return;
  const points = draft.points.map(view);
  if (draft.kind === 'Polygonal' && draft.cursor) points.push(view(draft.cursor));
  if (!points.length) return;
  const path = new Path2D();
  if (draft.kind === 'Ellipse' && points.length === 4) {
    const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
    const x = Math.min(...xs), y = Math.min(...ys), w = Math.max(...xs) - x, h = Math.max(...ys) - y;
    path.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  } else {
    points.forEach((p, i) => (i ? path.lineTo(p.x, p.y) : path.moveTo(p.x, p.y)));
    if (draft.kind === 'Rectangle') path.closePath();
  }
  context.strokeStyle = 'rgba(0,0,0,0.8)';
  context.lineWidth = 2;
  context.stroke(path);
  context.strokeStyle = '#fff';
  context.lineWidth = 1;
  context.stroke(path);
  if (draft.kind === 'Polygonal') {
    const first = points[0]!;
    context.fillStyle = '#fff';
    context.strokeStyle = '#000';
    context.fillRect(first.x - 4, first.y - 4, 8, 8);
    context.strokeRect(first.x - 4, first.y - 4, 8, 8);
  }
}

// MARK: Header (LassoControls.swift)

function SelectionBar({ controller, session }: { controller: EditorController; session: EditorSession }) {
  useSession(session);
  const t = controller.t;
  const state = selectionState(session);
  const tool = session.tool;
  const shown = state.draft?.mode ?? state.heldMode ?? state.modeChoice;
  const selection = session.selection;
  const disabled = session.isProjectBusy || !session.document;
  const segmented = <T extends string>(values: readonly T[], value: T, set: (v: T) => void, label: string) => (
    <div className={styles.segmented} role="radiogroup" aria-label={label}>
      {values.map((v) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} disabled={disabled}
          className={`${styles.segment} ${value === v ? styles.segmentOn : ''}`} onClick={() => set(v)}>{t(v)}</button>
      ))}
    </div>
  );
  return (
    <>
      <span className={styles.headerTitle}>{tool === 'marquee' ? t('Marquee') : tool === 'wand' ? t('Magic Wand') : t('Lasso')}</span>
      {tool === 'marquee' ? segmented(['Rectangle', 'Ellipse'] as const, state.marqueeKind as 'Rectangle' | 'Ellipse',
        (v) => { cancelLasso(session); state.marqueeKind = v; session.notify('ui'); }, 'Shape') : null}
      {tool === 'lasso' ? segmented(['Freehand', 'Polygonal'] as const, state.lassoKind as 'Freehand' | 'Polygonal',
        (v) => { cancelLasso(session); state.lassoKind = v; session.notify('ui'); }, 'Lasso') : null}
      {segmented(['New', 'Add', 'Subtract'] as const, shown, (v) => { state.modeChoice = v; session.notify('ui'); }, 'Mode')}
      {controller.wandControls && tool === 'wand' ? controller.wandControls(session) : null}
      {tool === 'lasso' || tool === 'wand' || (tool === 'marquee' && state.marqueeKind === 'Ellipse') ? (
        <label className={styles.check}><input type="checkbox" checked={state.antialiased} disabled={disabled}
          onChange={(e) => { state.antialiased = e.target.checked; session.notify('ui'); }} />{t('Anti-alias')}</label>
      ) : null}
      {state.draft?.kind === 'Polygonal' ? (
        <>
          <button type="button" className={styles.pill} onClick={() => { state.draft!.points.pop(); if (!state.draft!.points.length) state.draft = null; session.notify('document'); }}>{t('Remove Corner')}</button>
          <button type="button" className={`${styles.pill} ${styles.pillPrimary}`} onClick={() => finishLasso(session)}>{t('Close Outline')}</button>
        </>
      ) : null}
      <button type="button" className={styles.pill} disabled={!canModifySelection(session)} onClick={() => expandSelection(session, state.expandAmount)}>{t('Expand')}</button>
      <NumberField label="" suffix="px" width={44} value={state.expandAmount} onChange={(v) => { state.expandAmount = Math.min(500, Math.max(1, Math.round(v))); session.notify('ui'); }} />
      <button type="button" className={styles.pill} disabled={!canModifySelection(session)} onClick={() => contractSelection(session, state.contractAmount)}>{t('Contract')}</button>
      <NumberField label="" suffix="px" width={44} value={state.contractAmount} onChange={(v) => { state.contractAmount = Math.min(500, Math.max(1, Math.round(v))); session.notify('ui'); }} />
      <span className={styles.spacer} />
      {selection ? (
        <>
          {selectionIsEmpty(selection) ? <span className={styles.secondary}>{t('Empty selection')}</span> : null}
          <button type="button" className={styles.pill} disabled={!canEditSelection(session)} onClick={() => deselect(session)}>{t('Deselect')}</button>
        </>
      ) : null}
    </>
  );
}

/** Flip Canvas mirrors the selection across the canvas middle too (LayerFlip.swift flipCanvas). */
export function mirrorSelection(document: CanvasDocument, horizontally: boolean): DocumentSelection | null {
  const selection = document.selection;
  if (!selection) return null;
  const { width, height, channels } = selection.mask;
  const pixels = selection.mask.toPixels();
  const out = new Uint8Array(pixels.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const tx = horizontally ? width - 1 - x : x, ty = horizontally ? y : height - 1 - y;
      out[ty * width + tx] = pixels[y * width + x]!;
    }
  }
  return {
    ...selection,
    mask: Raster.fromPixels(width, height, channels, out),
    x: horizontally ? document.width - selection.x - width : selection.x,
    y: horizontally ? selection.y : document.height - selection.y - height,
  };
}

export function installSelection(controller: EditorController): void {
  // M chooses the Marquee, pressed again it switches Rectangle/Ellipse; L likewise for Freehand/Polygonal. The shape
  // stays as last set (SelectionTests.mKeyChoosesTheMarqueeThenSwitchesItsShape, lKeyChoosesTheLassoThenSwitchesItsMode).
  controller.toolKeyHandlers.m = () => {
    const session = controller.session, state = selectionState(session);
    if (session.tool === 'marquee') { cancelLasso(session); state.marqueeKind = state.marqueeKind === 'Rectangle' ? 'Ellipse' : 'Rectangle'; session.notify('ui'); }
    else session.selectTool('marquee');
  };
  controller.toolKeyHandlers.l = () => {
    const session = controller.session, state = selectionState(session);
    if (session.tool === 'lasso') { cancelLasso(session); state.lassoKind = state.lassoKind === 'Freehand' ? 'Polygonal' : 'Freehand'; session.notify('ui'); }
    else session.selectTool('lasso');
  };
  controller.mirrorSelection = mirrorSelection;
  // Cmd-drag / Cmd-arrows move the selected pixels (SelectionEdits.swift); the preview shows through
  // a preview source so a grown layer keeps its place.
  const previewed = new WeakSet<EditorSession>();
  const withPreview = (session: EditorSession) => {
    if (previewed.has(session)) return;
    previewed.add(session);
    session.previewSources.push((s) => {
      const state = pixelMoveState(s);
      return state?.preview && state.previewTransform ? { layerId: state.layerId, mask: false, raster: state.preview, transform: state.previewTransform } : null;
    });
  };
  controller.pixelMove = {
    begin: (session, duplicate) => { withPreview(session); return beginPixelMove(session, duplicate); },
    move: (session, dx, dy) => { movePixels(session, dx, dy); },
    finish: (session) => { finishPixelMove(session); session.notify('document'); },
    cancel: (session) => { cancelPixelMove(session); session.notify('document'); },
    nudge: (session, dx, dy) => { withPreview(session); nudgePixels(session, dx, dy); session.notify('document'); },
  };
  // The rail icon follows the tool's mode (ContentView.toolRail).
  const previousIcon = controller.toolIcon;
  controller.toolIcon = (tool) => {
    const state = selectionState(controller.session);
    if (tool === 'marquee' && state.marqueeKind === 'Ellipse') return 'marqueeEllipse';
    if (tool === 'lasso' && state.lassoKind === 'Polygonal') return 'polygonalLasso';
    return previousIcon?.(tool) ?? null;
  };
  controller.availableTools.add('marquee');
  controller.availableTools.add('lasso');
  controller.canvasSetups.push((view) => {
    view.tools.marquee = new SelectionTool(controller, true);
    view.tools.lasso = new SelectionTool(controller, false);
    view.painters.push(paintSelection);
  });
  controller.contextBars.marquee = (session) => <SelectionBar controller={controller} session={session} />;
  controller.contextBars.lasso = (session) => <SelectionBar controller={controller} session={session} />;
  controller.contextBars.wand = (session) => <SelectionBar controller={controller} session={session} />;
  const t = controller.t;
  controller.statusHints.marquee = (session) => selectionState(session).marqueeKind === 'Ellipse'
    ? t('Drag an ellipse · Shift add · Option subtract · Shift again mid-drag circle · Drag inside to move · Delete clears · ⌘D deselect')
    : t('Drag a rectangle · Shift add · Option subtract · Shift again mid-drag square · Drag inside to move · ⌘-drag moves pixels · Delete clears · ⌘D deselect');
  controller.statusHints.lasso = (session) => selectionState(session).lassoKind === 'Freehand'
    ? t('Drag to select · Drag inside to move · Shift add · Option subtract · Delete clears · ⌥⌫/⌘⌫ fill · ⌘D deselect')
    : t('Click corners · Click start, double-click or Enter to close · Delete removes corner · Escape cancel');

  const s = () => controller.session;
  const f = controller.features;
  f.selectAll = { enabled: () => !!s().document, run: () => selectAll(s()) };
  f.deselect = { enabled: () => !!s().selection && canEditSelection(s()), run: () => deselect(s()) };
  f.inverse = { enabled: () => !!s().selection && canEditSelection(s()), run: () => invertSelection(s()) };
  f.loadLayerSelection = { enabled: () => !!s().activeLayer?.raster && canEditSelection(s()), run: () => { const id = s().activeLayerId; if (id) loadLayerSelection(s(), id); } };
  f.loadMaskSelection = { enabled: () => !!s().activeLayer?.mask && canEditSelection(s()), run: () => { const id = s().activeLayerId; if (id) loadMaskSelection(s(), id); } };
  f.expandSelection = { enabled: () => canModifySelection(s()), run: () => expandSelection(s(), selectionState(s()).expandAmount) };
  f.contractSelection = { enabled: () => canModifySelection(s()), run: () => contractSelection(s(), selectionState(s()).contractAmount) };
  f.fillForeground = { enabled: () => canEditPixels(s()), run: () => fillSelection(s(), 'foreground') };
  f.fillBackground = { enabled: () => canEditPixels(s()), run: () => fillSelection(s(), 'background') };
  f.clearSelection = { enabled: () => !!s().selection && canEditPixels(s()), run: () => clearSelectedPixels(s()) };
  f.deleteKey = { enabled: () => true, run: () => { if (!deleteKeyPressed(s())) void s().deleteLayerOrMask(); } };
  f.invert = { enabled: () => canInvertPixels(s()), run: () => invertPixels(s()) };
  f.copy = { enabled: () => canCopyPixels(s()), run: () => copySelection(s(), undefined, controller.clipboardHooks) };
  f.cut = { enabled: () => canCutPixels(s()), run: () => cutSelection(s(), undefined, controller.clipboardHooks) };
  f.copyMerged = { enabled: () => canCopyMerged(s()), run: () => void copyMergedSelection(s(), undefined, controller.clipboardHooks) };
  // System clipboard: copies also go out as PNG; a pasted image that is not our own last copy is
  // external and lands centred, our own copy returns to its place (SelectionClipboard.paste).
  let lastWritten: string | null = null;
  controller.clipboardHooks = {
    toPngBlobData: async (raster) => {
      const bytes = encodePng(raster.toPixels(), raster.width, raster.height, 4);
      lastWritten = sha256Hex(bytes);
      try { await navigator.clipboard?.write?.([new ClipboardItem({ 'image/png': new Blob([bytes as BlobPart], { type: 'image/png' }) })]); } catch { /* no permission */ }
    },
  };
  const pasteBytes = async (bytes: Uint8Array | null) => {
    const session = s();
    if (!session.document || !session.canEditLayers) return;
    if (bytes && sha256Hex(bytes) !== lastWritten) {
      try {
        const raster = await decodeImageFile(bytes, session.remainingPixelBudget());
        pixelClipboard.clear();
        await paste(session, undefined, { readExternalRaster: () => raster });
      } catch (error) { controller.reportError('paste-failed', error); }
      return;
    }
    await paste(session, undefined, controller.clipboardHooks);
  };
  controller.pasteEvent = (event) => {
    const file = [...(event.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
    if (!file && !pixelClipboard.entry) return false;
    void (file ? file.arrayBuffer().then((b) => pasteBytes(new Uint8Array(b))) : pasteBytes(null));
    return true;
  };
  f.paste = {
    enabled: () => canPaste(s(), undefined, true),
    run: () => void (async () => {
      let bytes: Uint8Array | null = null;
      try {
        for (const item of await navigator.clipboard.read()) {
          const type = item.types.find((t) => t.startsWith('image/'));
          if (type) { bytes = new Uint8Array(await (await item.getType(type)).arrayBuffer()); break; }
        }
      } catch { /* permission denied or unsupported: internal clipboard only */ }
      await pasteBytes(bytes);
    })(),
  };
  f.layerViaCopy = { enabled: () => canCopyPixels(s()), run: () => layerViaCopy(s()) };
  f.transformCommand = {
    enabled: () => s().canTransform || canTransformSelection(s()),
    run: () => { if (canTransformSelection(s())) beginSelectionTransform(s()); else s().beginTransform(); },
  };
  controller.maskFromSelection = (revealing) => addMaskFromSelection(controller.session, revealing);
  controller.loadSelection = (layerId, mask, event) => {
    const mode: SelectionMode = event.altKey ? 'Subtract' : event.shiftKey ? 'Add' : 'New';
    if (mask) loadMaskSelection(controller.session, layerId, mode); else loadLayerSelection(controller.session, layerId, mode);
  };
  controller.keyHandlers.push((event) => {
    const session = controller.session, state = selectionState(session);
    const shiftOrOption = event.shiftKey || event.altKey;
    state.heldMode = event.altKey ? 'Subtract' : event.shiftKey ? 'Add' : null;
    void shiftOrOption;
    if (state.draft && ['Escape', 'Enter', 'Backspace', 'Delete'].includes(event.key)) {
      if (event.key === 'Escape') cancelLasso(session);
      else if (event.key === 'Enter') finishLasso(session);
      else { state.draft.points.pop(); if (!state.draft.points.length) state.draft = null; session.notify('document'); }
      return true;
    }
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const arrow = arrows[event.key];
    if (arrow && session.selection && !selectionIsEmpty(session.selection) && !state.draft) {
      const step = event.shiftKey ? 10 : 1;
      const command = event.metaKey || event.ctrlKey;
      if (command && controller.pixelMove) { controller.pixelMove.nudge(session, arrow[0] * step, arrow[1] * step); return true; }
      if (!command && !event.altKey && (session.tool === 'marquee' || session.tool === 'lasso' || session.tool === 'wand')) {
        nudgeSelection(session, arrow[0] * step, arrow[1] * step);
        return true;
      }
    }
    return false;
  });
}
