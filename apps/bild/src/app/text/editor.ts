/**
 * In-place text editing on the canvas (PRODUCT-PLAN A5/6.6, Photoshop's Horizontal Type tool): click for point text,
 * drag for area text, click text to edit it. Keys arrive through a hidden textarea (IME, paste, copy and cut stay
 * native); the text itself is only ever drawn by the engine, the caret and selection by the canvas overlay. One
 * editing session is one undo step ("Edit Text"); while it lasts, ⌘Z steps through the typing itself.
 */

import { editBlockers, type EditorSession } from '../../core/session';
import {
  defaultTextParagraphStyle, DEFAULT_TEXT_STYLE, effectiveVisibleIds, renderLayers,
  type CanvasDocument, type TextLayer, type TextParagraphStyle, type TextRunStyle,
} from '../../core/document';
import { PathMeasure, PathTextMapping, styleAt, type ParagraphStylePatch, type TextStylePatch } from '../../core/text';
import { noteColorUsed } from '../../core/color/recent';
import { apply, containsPoint, invert, radians, unitPoint, type LayerTransform, type Point, type Rect, type Size } from '../../core/geometry';
import type { TextOnPath, TextWarp, VectorPath } from '../../core/model';
import type { EditorController } from '../../ui/controller';
import type { ToolContext, ToolHandler } from '../../ui/canvas/tools';
import type { TextGeometry, TextRuntime } from './runtime';
import {
  frameToDocument, nearPathText, PATH_TEXT_CURSOR, pathUnderPointer, textPathFraction, textPathFrame, textPathMarkers, textPathPolyline,
} from './pathTool';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
/** Noto Sans ascender and line height in em: a new point text puts its first baseline where the click was. */
const ASCENT = 1.069, LINE = 1.362;

interface Snapshot { readonly layer: TextLayer; readonly anchor: number; readonly focus: number }

export interface EditState {
  readonly session: EditorSession;
  readonly layerId: string;
  readonly created: boolean;
  readonly before: { readonly document: CanvasDocument; readonly active: string | null };
  anchor: number;
  focus: number;
  /** Style of the next typed characters (the character before the caret, or what the controls set). */
  typing: TextRunStyle;
  preferredX: number | null;
  composition: { readonly from: number; length: number } | null;
  undo: Snapshot[];
  redo: Snapshot[];
  /** Photoshop names text layers after their text until they are renamed. */
  autoName: boolean;
}

export interface TextDefaults { style: TextRunStyle; paragraph: TextParagraphStyle }
const defaults = new WeakMap<EditorSession, TextDefaults>();
const SIZES = [6, 8, 9, 10, 11, 12, 14, 18, 24, 30, 36, 48, 60, 72, 96, 120, 144, 192, 240, 288];

/** The Type tool's own settings per tab; the first size suits the canvas (about a sixteenth of its short side). */
export function textDefaults(session: EditorSession): TextDefaults {
  let value = defaults.get(session);
  if (!value) {
    const document = session.document;
    const points = document ? Math.min(document.width, document.height) / 16 * 72 / document.resolution : 24;
    const size = SIZES.reduce((best, step) => (Math.abs(step - points) < Math.abs(best - points) ? step : best), 12);
    value = { style: { ...DEFAULT_TEXT_STYLE, fontSize: size }, paragraph: defaultTextParagraphStyle() };
    defaults.set(session, value);
  }
  return value;
}

export function sameStyle(a: TextRunStyle, b: TextRunStyle): boolean { return a === b || JSON.stringify(a) === JSON.stringify(b); }

/** The layer name Photoshop derives from the text: its first non-empty line. */
export function autoName(text: string): string {
  const line = text.split('\n').map((value) => value.replace(/\s+/g, ' ').trim()).find((value) => value) ?? '';
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}

function replaceLayer(document: CanvasDocument, layer: TextLayer): CanvasDocument {
  return { ...document, layers: document.layers.map((value) => (value.id === layer.id ? layer : value)) };
}

/** The new placement of point text after reshaping: it grows from its alignment anchor (Photoshop's type origin). */
export function resizedPlacement(layer: TextLayer, shaped: Size): LayerTransform {
  const t = layer.transform;
  const size = { width: Math.max(1, shaped.width), height: Math.max(1, shaped.height) };
  if (Math.abs(size.width - t.size.width) < 0.01 && Math.abs(size.height - t.size.height) < 0.01) return t;
  const alignment = layer.paragraphs[0]?.style.alignment ?? 'left';
  const anchor = { x: alignment === 'center' ? 0.5 : alignment === 'right' ? 1 : 0, y: 0 };
  const fixed = unitPoint(t, anchor), moved = unitPoint({ ...t, size }, anchor);
  return { ...t, size, origin: { x: t.origin.x + fixed.x - moved.x, y: t.origin.y + fixed.y - moved.y } };
}

/**
 * The topmost visible text layer under a document point (with a small margin for thin, empty lines). Text on a path
 * is hit on its band of glyphs along the path, not anywhere in its box (a circle's middle stays free for new text).
 */
export function textLayerAt(session: EditorSession, pixel: Point, margin = 0): TextLayer | null {
  const document = session.document;
  if (!document) return null;
  const visible = effectiveVisibleIds(document.layers);
  for (const layer of [...renderLayers(document.layers)].reverse()) {
    if (layer.kind !== 'text' || !visible.has(layer.id)) continue;
    const t = session.displayedTransform(layer);
    const padded = { ...t, origin: { x: t.origin.x - margin, y: t.origin.y - margin },
      size: { width: t.size.width + margin * 2, height: t.size.height + margin * 2 } };
    if (containsPoint(padded, pixel) && nearPathText(session, layer, pixel, margin)) return layer;
  }
  return null;
}

// MARK: Graphemes and words

type Segment = { segment: string; index: number; isWordLike?: boolean };
const segmenter = (granularity: 'grapheme' | 'word') => {
  const Segmenter = (Intl as unknown as { Segmenter?: new (locale?: string, options?: { granularity: string }) => { segment(text: string): Iterable<Segment> } }).Segmenter;
  return Segmenter ? new Segmenter(undefined, { granularity }) : null;
};
const graphemes = segmenter('grapheme'), words = segmenter('word');

function graphemeBoundaries(text: string): number[] {
  if (graphemes) return [...[...graphemes.segment(text)].map((value) => value.index), text.length];
  const result: number[] = [];
  for (let index = 0; index < text.length;) { result.push(index); index += (text.codePointAt(index) ?? 0) > 0xffff ? 2 : 1; }
  return [...result, text.length];
}
export function nextGrapheme(text: string, index: number): number { return graphemeBoundaries(text).find((value) => value > index) ?? text.length; }
export function previousGrapheme(text: string, index: number): number { return [...graphemeBoundaries(text)].reverse().find((value) => value < index) ?? 0; }

function wordSegments(text: string): Segment[] {
  if (words) return [...words.segment(text)];
  return [...text.matchAll(/[\p{L}\p{N}_]+|[^\p{L}\p{N}_]+/gu)].map((match) => ({ segment: match[0], index: match.index ?? 0,
    isWordLike: /[\p{L}\p{N}_]/u.test(match[0]) }));
}
export function nextWord(text: string, index: number): number {
  const hit = wordSegments(text).find((value) => value.isWordLike && value.index + value.segment.length > index);
  return hit ? hit.index + hit.segment.length : text.length;
}
export function previousWord(text: string, index: number): number {
  const hit = wordSegments(text).reverse().find((value) => value.isWordLike && value.index < index);
  return hit ? hit.index : 0;
}
function wordAt(text: string, index: number): [number, number] {
  const hit = wordSegments(text).find((value) => value.index <= index && index < value.index + value.segment.length)
    ?? wordSegments(text).at(-1);
  return hit ? [hit.index, hit.index + hit.segment.length] : [index, index];
}
function paragraphAt(text: string, index: number): [number, number] {
  const start = text.lastIndexOf('\n', index - 1) + 1, newline = text.indexOf('\n', index);
  return [start, newline < 0 ? text.length : newline];
}

// MARK: Editor

export class TextEditor {
  editing: EditState | null = null;
  private input: HTMLTextAreaElement | null = null;
  private draft: { session: EditorSession; start: Point; startView: Point; current: Point; moved: boolean } | null = null;
  private selecting = false;
  /** A start or end marker of text on a path being dragged along its path. */
  private marker: { e: EditState; which: 'start' | 'end' } | null = null;
  /** An open Warp Text popover: its layer before the popover opened, and whether it opened its own undo step. */
  private warping: { session: EditorSession; layerId: string; before: TextLayer; own: boolean } | null = null;
  private clicks = { time: 0, point: { x: 0, y: 0 }, count: 0 };
  readonly tool: ToolHandler;
  /** Open popovers of the controls: Escape in the text closes the newest one before it would commit. */
  readonly popovers = new Set<() => void>();

  constructor(private readonly controller: EditorController, private readonly runtime: TextRuntime) {
    // While text is being edited the rest of the document is read-only (menus disabled, Photoshop's type mode).
    editBlockers.push((session) => this.editing?.session === session);
    this.tool = {
      down: (c) => this.down(c), move: (c) => this.move(c), up: (c) => this.up(c), cancel: (s) => this.cancelGesture(s),
      hover: (c) => this.hover(c), overlayOnly: () => true,
    };
  }

  private layer(e: EditState): TextLayer | null {
    const layer = e.session.layer(e.layerId);
    return layer?.kind === 'text' ? layer : null;
  }
  range(e: EditState): [number, number] { return e.anchor <= e.focus ? [e.anchor, e.focus] : [e.focus, e.anchor]; }

  // MARK: Sessions

  /** Starts a new point (at a document point) or area (in a rectangle) text layer. */
  startNew(session: EditorSession, at: Point | Rect): boolean {
    if (this.editing) this.commit();
    const document = session.document;
    if (!document || !session.canEditLayers) return false;
    const settings = textDefaults(session);
    const style: TextRunStyle = { ...settings.style, color: { ...session.foregroundColor, alpha: 1 } };
    noteColorUsed(session, session.foregroundColor);
    const active = session.activeLayerId;
    session.beginEdit('Edit Text');
    let id: string | null = null;
    try {
      if ('width' in at) id = session.createAreaText(at, '', style);
      else {
        const pixels = style.fontSize * document.resolution / 72;
        id = session.createPointText({ x: at.x, y: at.y - pixels * ASCENT }, '', style);
      }
      const { alignment, direction } = settings.paragraph;
      if (id && (alignment !== 'left' || direction !== 'auto')) session.changeParagraphSettings(id, 0, 0, { alignment, direction });
    } catch { id = null; }
    if (!id) { session.endEdit(); return false; }
    this.editing = { session, layerId: id, created: true, before: { document, active },
      anchor: 0, focus: 0, typing: style, preferredX: null, composition: null, undo: [], redo: [], autoName: true };
    this.attachInput();
    session.notify('ui');
    return true;
  }
  /**
   * Starts text on a path (Photoshop's type on a path): the text layer gets its own copy of the path, in a frame at the
   * path's bounds; the text starts where the path was clicked and runs to its end (around a closed path).
   */
  startOnPath(session: EditorSession, documentPath: VectorPath, fraction: number): boolean {
    if (this.editing) this.commit();
    const document = session.document;
    if (!document || !session.canEditLayers) return false;
    const settings = textDefaults(session);
    const style: TextRunStyle = { ...settings.style, color: { ...session.foregroundColor, alpha: 1 } };
    noteColorUsed(session, session.foregroundColor);
    const active = session.activeLayerId;
    const frame = textPathFrame(documentPath);
    session.beginEdit('Edit Text');
    let id: string | null = null;
    try {
      id = session.createPointText(frame.transform.origin, '', style);
      const created = id ? session.layer(id) : null;
      if (id && created?.kind === 'text' && session.document) {
        const start = Math.max(0, Math.min(1, fraction));
        const textPath: TextOnPath = { schemaVersion: 1, path: frame.path, start, end: frame.path.closed ? start : 1, flipped: false,
          baselineOffset: 0 };
        session.replaceDocument(replaceLayer(session.document, { ...created, transform: frame.transform, textPath, raster: null,
          renderedTransform: null }));
        const { alignment, direction } = settings.paragraph;
        if (alignment !== 'left' || direction !== 'auto') session.changeParagraphSettings(id, 0, 0, { alignment, direction });
      }
    } catch { id = null; }
    if (!id) { session.endEdit(); return false; }
    this.editing = { session, layerId: id, created: true, before: { document, active },
      anchor: 0, focus: 0, typing: style, preferredX: null, composition: null, undo: [], redo: [], autoName: true };
    this.attachInput();
    session.notify('ui');
    return true;
  }

  /** Edits an existing text layer: caret at an index, or everything selected (double-click on its thumbnail). */
  startExisting(session: EditorSession, layerId: string, selection: number | 'all'): boolean {
    const current = this.editing;
    if (current && current.session === session && current.layerId === layerId) {
      const length = this.layer(current)?.text.length ?? 0;
      this.select(current, selection === 'all' ? 0 : selection, selection === 'all' ? length : selection);
      return true;
    }
    if (current) this.commit();
    const layer = session.layer(layerId);
    if (layer?.kind !== 'text' || !session.document) return false;
    if (session.activeLayerId !== layerId || session.selectedLayerIds.size !== 1) session.selectLayer(layerId);
    if (!session.canEditLayers || session.refuseLayerEdit(layerId, 'pixels')) return false;
    const document = session.document;
    session.beginEdit('Edit Text');
    const caret = selection === 'all' ? layer.text.length : Math.max(0, Math.min(layer.text.length, selection));
    const label = session.label('Text');
    const automatic = layer.name === label || layer.name === autoName(layer.text)
      || (layer.name.startsWith(`${label} `) && /^\d+$/.test(layer.name.slice(label.length + 1)));
    this.editing = { session, layerId, created: false, before: { document, active: layerId },
      anchor: selection === 'all' ? 0 : caret, focus: caret,
      typing: layer.text.length ? styleAt(layer, Math.max(0, caret - 1)) : textDefaults(session).style,
      preferredX: null, composition: null, undo: [], redo: [], autoName: automatic };
    this.attachInput();
    session.notify('ui');
    return true;
  }

  /** Ends editing and records the session as one undo step; an emptied layer is removed (Photoshop). */
  commit(): void {
    const e = this.editing;
    if (!e) return;
    this.editing = null;
    this.detachInput();
    const session = e.session;
    if (session.history.isInTransaction) {
      const layer = session.layer(e.layerId), document = session.document;
      if (document && layer?.kind === 'text' && layer.text.length === 0) {
        const index = document.layers.findIndex((value) => value.id === layer.id);
        const layers = document.layers.filter((value) => value.id !== layer.id);
        session.replaceDocument({ ...document, layers });
        session.setActiveLayer(e.created ? (layers.some((value) => value.id === e.before.active) ? e.before.active : null)
          : layers[Math.max(0, index - 1)]?.id ?? null);
      }
      session.endEdit();
    }
    session.notify('ui');
  }

  /** Throws the whole editing session away (the context bar's Cancel). */
  cancel(): void {
    const e = this.editing;
    if (!e) return;
    this.editing = null;
    this.detachInput();
    const session = e.session;
    if (session.history.isInTransaction) {
      session.replaceDocument(e.before.document);
      session.setActiveLayer(e.created ? e.before.active : e.layerId);
      session.endEdit();
    }
    session.notify('ui');
  }

  /** Commits when the user moves on: another tool, layer or tab. Abandons silently if the transaction went away. */
  check(): void {
    const e = this.editing;
    if (!e) return;
    const session = e.session;
    if (!session.history.isInTransaction || !this.layer(e)) { this.editing = null; this.detachInput(); return; }
    if (this.controller.session !== session || session.tool !== 'text' || session.activeLayerId !== e.layerId) this.commit();
  }

  // MARK: Changes

  private mutate(e: EditState, change: () => void, record = true): void {
    const layer = this.layer(e);
    if (!layer) return;
    if (record) {
      e.undo.push({ layer, anchor: e.anchor, focus: e.focus });
      if (e.undo.length > 200) e.undo.shift();
      e.redo = [];
    }
    change();
    this.settle(e);
  }

  /** After a change: the shaped size (point text grows from its anchor) and the automatic layer name. */
  private settle(e: EditState): void {
    const session = e.session, layer = this.layer(e), document = session.document;
    if (!layer || !document) return;
    const shaped = this.runtime.shapedSize(session, e.layerId);
    let next = layer;
    if (shaped && !layer.box && !layer.textPath && layer.text.length) {
      const transform = resizedPlacement(layer, shaped);
      if (transform !== layer.transform) next = { ...next, transform };
    }
    if (e.autoName) {
      const name = autoName(layer.text) || session.label('Text');
      if (name !== layer.name) next = { ...next, name };
    }
    if (next !== layer) session.replaceDocument(replaceLayer(document, next));
    session.notify('document');
    this.syncInput();
  }

  /** Replaces the selection (or inserts at the caret) in the typing style. */
  insert(text: string): void {
    const e = this.editing;
    if (!e) return;
    const value = text.replace(/\r\n?/g, '\n');
    const [from, to] = this.range(e);
    if (!value && from === to) return;
    this.mutate(e, () => {
      e.session.replaceText(e.layerId, from, to, value);
      const next = this.layer(e);
      if (value && next && !sameStyle(styleAt(next, from), e.typing)) e.session.applyTextStyle(e.layerId, from, from + value.length, e.typing);
    });
    e.anchor = e.focus = from + value.length;
    e.preferredX = null;
    this.syncInput();
  }

  private remove(e: EditState, direction: -1 | 1, word: boolean): void {
    const layer = this.layer(e);
    if (!layer) return;
    const [from, to] = this.range(e);
    if (from !== to) { this.insert(''); return; }
    const other = direction < 0 ? (word ? previousWord : previousGrapheme)(layer.text, from) : (word ? nextWord : nextGrapheme)(layer.text, from);
    if (other === from) return;
    e.anchor = Math.min(from, other); e.focus = Math.max(from, other);
    this.insert('');
    this.updateTyping(e);
  }

  undoLocal(redo = false): void {
    const e = this.editing;
    const layer = e && this.layer(e);
    const document = e?.session.document;
    if (!e || !layer || !document) return;
    const snapshot = (redo ? e.redo : e.undo).pop();
    if (!snapshot) return;
    (redo ? e.undo : e.redo).push({ layer, anchor: e.anchor, focus: e.focus });
    e.session.replaceDocument(replaceLayer(document, snapshot.layer));
    e.anchor = snapshot.anchor; e.focus = snapshot.focus;
    this.updateTyping(e);
    e.session.notify('document');
    this.syncInput();
  }

  // MARK: Selection

  select(e: EditState, anchor: number, focus: number, keepColumn = false): void {
    const length = this.layer(e)?.text.length ?? 0;
    e.anchor = Math.max(0, Math.min(length, anchor));
    e.focus = Math.max(0, Math.min(length, focus));
    if (!keepColumn) e.preferredX = null;
    this.updateTyping(e);
    e.session.notify('overlay');
    this.syncInput();
  }

  private updateTyping(e: EditState): void {
    const layer = this.layer(e);
    if (!layer?.text.length) return;
    const [from, to] = this.range(e);
    e.typing = styleAt(layer, from === to ? Math.max(0, from - 1) : from);
  }

  private geometry(e: EditState): TextGeometry | null { return this.runtime.geometry(e.session, e.layerId); }

  private vertical(e: EditState, direction: -1 | 1, extend: boolean): void {
    const length = this.layer(e)?.text.length ?? 0;
    const g = this.geometry(e);
    let target: number;
    if (!g) target = direction < 0 ? 0 : length;
    else {
      const caret = g.caretRect(e.focus);
      const x = e.preferredX ?? caret.x;
      const y = direction < 0 ? caret.y - caret.height * 0.5 : caret.y + caret.height * 1.5;
      target = y < 0 ? 0 : y > g.height ? length : g.layoutIndex({ x, y });
      this.select(e, extend ? e.anchor : target, target, true);
      e.preferredX = x;
      return;
    }
    this.select(e, extend ? e.anchor : target, target);
  }

  private lineEdge(e: EditState, direction: -1 | 1, extend: boolean): void {
    const layer = this.layer(e);
    if (!layer) return;
    const g = this.geometry(e);
    let target: number;
    if (g && layer.text.length) {
      const caret = g.caretRect(e.focus);
      target = g.layoutIndex({ x: direction < 0 ? -1e6 : 1e6, y: caret.y + caret.height / 2 });
    } else {
      const [start, end] = paragraphAt(layer.text, e.focus);
      target = direction < 0 ? start : end;
    }
    this.select(e, extend ? e.anchor : target, target);
  }

  // MARK: Keyboard (hidden textarea)

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const e = this.editing;
    if (!e) return;
    event.stopPropagation();
    if (event.isComposing || event.keyCode === 229 || e.composition) return;
    const layer = this.layer(e);
    if (!layer) return;
    const text = layer.text, key = event.key;
    const mod = isMac ? event.metaKey : event.ctrlKey;
    const word = isMac ? event.altKey : event.ctrlKey;
    const extend = event.shiftKey;
    const done = () => event.preventDefault();
    const [from, to] = this.range(e);
    switch (key) {
      case 'Escape': {
        done();
        const popover = [...this.popovers].at(-1);
        if (popover) popover(); else this.commit();
        return;
      }
      case 'Enter':
        done();
        if (mod || event.code === 'NumpadEnter') this.commit(); else this.insert('\n');
        return;
      case 'Tab': done(); this.insert('\t'); return;
      case 'Backspace': done(); this.remove(e, -1, word); return;
      case 'Delete': done(); this.remove(e, 1, word); return;
      case 'ArrowLeft': case 'ArrowRight': {
        done();
        const forward = key === 'ArrowRight';
        if (isMac && event.metaKey) { this.lineEdge(e, forward ? 1 : -1, extend); return; }
        let target: number;
        if (!extend && from !== to && !word) target = forward ? to : from;
        else target = forward ? (word ? nextWord : nextGrapheme)(text, e.focus) : (word ? previousWord : previousGrapheme)(text, e.focus);
        this.select(e, extend ? e.anchor : target, target);
        return;
      }
      case 'ArrowUp': case 'ArrowDown':
        done();
        if (isMac && event.metaKey) { const target = key === 'ArrowUp' ? 0 : text.length; this.select(e, extend ? e.anchor : target, target); return; }
        this.vertical(e, key === 'ArrowUp' ? -1 : 1, extend);
        return;
      case 'Home': case 'End':
        done();
        if (mod) { const target = key === 'Home' ? 0 : text.length; this.select(e, extend ? e.anchor : target, target); return; }
        this.lineEdge(e, key === 'Home' ? -1 : 1, extend);
        return;
      default: break;
    }
    if (!mod || event.altKey) return;
    const lower = key.toLowerCase();
    // Copy, cut and paste stay native: the hidden field holds exactly the selected text.
    if (lower === 'c' || lower === 'x' || lower === 'v') return;
    done();
    if (lower === 'a') this.select(e, 0, text.length);
    else if (lower === 'z') this.undoLocal(event.shiftKey);
    else if (lower === 'y') this.undoLocal(true);
    else if (event.shiftKey && (event.code === 'Period' || event.code === 'Comma')) {
      const size = this.controlsState(e.session).style.fontSize;
      void this.applyStyle(e.session, { fontSize: event.code === 'Period' ? Math.min(12_000, size + 2) : Math.max(1, size - 2) });
    } else if (event.shiftKey && (lower === 'l' || lower === 'c' || lower === 'r' || lower === 'j')) {
      void this.applyParagraph(e.session, { alignment: lower === 'l' ? 'left' : lower === 'c' ? 'center' : lower === 'r' ? 'right' : 'justify' });
    }
  };

  private readonly onInput = (event: Event): void => {
    const e = this.editing, input = this.input;
    if (!e || !input) return;
    const type = (event as InputEvent).inputType ?? '';
    if (e.composition || type === 'insertCompositionText' || (event as InputEvent).isComposing) return;
    if (type.startsWith('delete')) { const [from, to] = this.range(e); if (from !== to) this.insert(''); }
    else if (input.value) this.insert(input.value);
    this.syncInput();
  };

  private readonly onCompositionStart = (): void => {
    const e = this.editing;
    const layer = e && this.layer(e);
    if (!e || !layer) return;
    const [from, to] = this.range(e);
    e.undo.push({ layer, anchor: e.anchor, focus: e.focus });
    e.redo = [];
    // The first composition update replaces the selection.
    e.composition = { from, length: to - from };
  };
  private compose(data: string, final: boolean): void {
    const e = this.editing;
    const composition = e?.composition;
    if (!e || !composition) return;
    this.mutate(e, () => {
      e.session.replaceText(e.layerId, composition.from, composition.from + composition.length, data);
      const next = this.layer(e);
      if (data && next && !sameStyle(styleAt(next, composition.from), e.typing)) {
        e.session.applyTextStyle(e.layerId, composition.from, composition.from + data.length, e.typing);
      }
    }, false);
    composition.length = data.length;
    e.anchor = e.focus = composition.from + data.length;
    if (final) {
      e.composition = null;
      setTimeout(() => this.syncInput(), 0);
    }
    e.session.notify('overlay');
  }
  private readonly onCompositionUpdate = (event: CompositionEvent): void => this.compose(event.data ?? '', false);
  private readonly onCompositionEnd = (event: CompositionEvent): void => this.compose(event.data ?? '', true);

  /** Focus returns to the text when a control that took it goes away (Enter in a field, a closed popover). */
  private readonly onFocusOut = (): void => {
    setTimeout(() => {
      const active = globalThis.document.activeElement as HTMLElement | null;
      if (this.editing && (!active || active === globalThis.document.body || active.dataset.testid === 'compositor-editor')) this.focusInput();
    }, 0);
  };

  private attachInput(): void {
    const host = this.controller.canvasView?.element;
    if (!host) return;
    let input = this.input;
    if (!input) {
      input = globalThis.document.createElement('textarea');
      input.dataset.testid = 'text-input';
      input.setAttribute('aria-label', this.controller.t('Text'));
      input.setAttribute('autocomplete', 'off');
      input.setAttribute('autocorrect', 'off');
      input.setAttribute('autocapitalize', 'off');
      input.spellcheck = false;
      input.style.cssText = 'position:absolute;left:0;top:0;width:2px;height:16px;padding:0;margin:0;border:0;outline:0;opacity:0;'
        + 'resize:none;overflow:hidden;white-space:pre;color:transparent;background:transparent;caret-color:transparent;pointer-events:none;z-index:1';
      input.addEventListener('keydown', this.onKeyDown);
      input.addEventListener('input', this.onInput);
      input.addEventListener('compositionstart', this.onCompositionStart);
      input.addEventListener('compositionupdate', this.onCompositionUpdate);
      input.addEventListener('compositionend', this.onCompositionEnd);
      input.addEventListener('keyup', (event) => event.stopPropagation());
      this.input = input;
    }
    if (input.parentElement !== host) host.append(input);
    globalThis.document.addEventListener('focusout', this.onFocusOut, true);
    this.syncInput();
    this.focusInput();
  }

  private detachInput(): void {
    globalThis.document.removeEventListener('focusout', this.onFocusOut, true);
    const input = this.input;
    if (!input) return;
    const focused = globalThis.document.activeElement === input;
    input.value = '';
    input.remove();
    // Keyboard shortcuts go back to the editor.
    if (focused) (globalThis.document.querySelector('[data-testid="compositor-editor"]') as HTMLElement | null)?.focus({ preventScroll: true });
  }

  /**
   * Returns the keyboard to the text after a control was used. Deferred: a key still being dispatched (Enter in a
   * field) must not reach the text.
   */
  refocusLater(): void { setTimeout(() => this.focusInput(), 0); }

  focusInput(): void {
    const input = this.input;
    if (!this.editing || !input) return;
    if (!input.isConnected) this.controller.canvasView?.element.append(input);
    if (globalThis.document.activeElement !== input) input.focus({ preventScroll: true });
    if (!this.editing.composition) input.select();
  }

  /** The hidden field holds the selected text (native copy and cut) and sits at the caret (IME candidate window). */
  private syncInput(): void {
    const e = this.editing, input = this.input;
    if (!e || !input || e.composition) return;
    const layer = this.layer(e);
    const [from, to] = this.range(e);
    const selected = layer ? layer.text.slice(from, to) : '';
    if (input.value !== selected) input.value = selected;
    if (globalThis.document.activeElement === input) input.select();
    const caret = this.caretLine(e);
    const document = e.session.document;
    if (caret && document) {
      const top = e.session.viewport.viewPoint(caret[0], document), bottom = e.session.viewport.viewPoint(caret[1], document);
      input.style.left = `${Math.round(top.x)}px`;
      input.style.top = `${Math.round(top.y)}px`;
      input.style.height = `${Math.max(12, Math.round(Math.hypot(bottom.x - top.x, bottom.y - top.y)))}px`;
    }
  }

  // MARK: Style changes (context bar and shortcuts)

  /** Applies a character style: to the selection, the next typed text, the active text layer, or the tool settings. */
  async applyStyle(session: EditorSession, patch: TextStylePatch): Promise<void> {
    if (patch.fontFamily) await this.runtime.ensureFamily(patch.fontFamily);
    const settings = textDefaults(session);
    const { color, ...rest } = patch;
    if (color) noteColorUsed(session, color);
    settings.style = { ...settings.style, ...rest };
    const e = this.editing;
    if (e && e.session === session) {
      const [from, to] = this.range(e);
      e.typing = { ...e.typing, ...patch };
      if (from !== to) this.mutate(e, () => session.applyTextStyle(e.layerId, from, to, patch));
      else session.notify('ui');
      this.refocusLater();
      return;
    }
    const layer = session.activeLayer;
    if (layer?.kind === 'text' && layer.text.length && session.canEditLayers) {
      this.formatLayer(session, layer, 'Format Text', () => session.applyTextStyle(layer.id, 0, layer.text.length, patch));
      return;
    }
    if (color) session.setPaletteColor({ red: color.red, green: color.green, blue: color.blue }, false);
    session.notify('ui');
  }

  async applyParagraph(session: EditorSession, patch: ParagraphStylePatch): Promise<void> {
    const settings = textDefaults(session);
    settings.paragraph = { ...settings.paragraph, ...patch };
    const e = this.editing;
    if (e && e.session === session) {
      const [from, to] = this.range(e);
      this.mutate(e, () => session.changeParagraphSettings(e.layerId, from, to, patch));
      this.refocusLater();
      return;
    }
    const layer = session.activeLayer;
    if (layer?.kind === 'text' && session.canEditLayers) {
      this.formatLayer(session, layer, 'Format Paragraph', () => session.changeParagraphSettings(layer.id, 0, layer.text.length, patch));
      return;
    }
    session.notify('ui');
  }

  /** One undo step for a whole-layer change, including the point text's new size. */
  private formatLayer(session: EditorSession, layer: TextLayer, name: string, change: () => void): void {
    session.edit(name, () => {
      change();
      this.fitPointText(session, layer.id);
    });
  }

  private fitPointText(session: EditorSession, layerId: string): void {
    const next = session.layer(layerId), document = session.document;
    const shaped = this.runtime.shapedSize(session, layerId);
    if (next?.kind !== 'text' || next.box || next.textPath || !shaped || !document || !next.text.length) return;
    const transform = resizedPlacement(next, shaped);
    if (transform !== next.transform) session.replaceDocument(replaceLayer(document, { ...next, transform }));
  }

  /** A whole-layer change of the edited or active text layer: part of the editing session, or its own undo step. */
  private changeLayer(session: EditorSession, name: string, change: (layer: TextLayer) => TextLayer): void {
    const e = this.editing;
    if (e && e.session === session) {
      this.mutate(e, () => {
        const layer = this.layer(e), document = session.document;
        if (layer && document) session.replaceDocument(replaceLayer(document, change(layer)));
      });
      this.refocusLater();
      return;
    }
    const layer = session.activeLayer;
    if (layer?.kind !== 'text' || !session.canEditLayers || session.refuseLayerEdit(layer.id, 'pixels')) return;
    session.edit(name, () => {
      const document = session.document;
      if (document) session.replaceDocument(replaceLayer(document, change(layer)));
    });
    session.notify('document');
  }

  /** The text layer the controls act on: the one being edited, else the active one. */
  targetLayer(session: EditorSession): TextLayer | null {
    const e = this.editing;
    if (e && e.session === session) return this.layer(e);
    const layer = session.activeLayer;
    return layer?.kind === 'text' ? layer : null;
  }

  /** Changes text-on-path settings (start, end, flip, baseline offset) of the edited or active text layer. */
  setPathOptions(session: EditorSession, patch: Partial<Omit<TextOnPath, 'schemaVersion' | 'path'>>): void {
    this.changeLayer(session, 'Change Path Text', (layer) => {
      const current = layer.textPath;
      if (!current) return layer;
      let next: TextOnPath = { ...current, ...patch, schemaVersion: 1 };
      next = { ...next, start: Math.max(0, Math.min(1, next.start)), end: Math.max(0, Math.min(1, next.end)) };
      // An open path's range runs forward; the other marker gives way.
      if (!next.path.closed && next.end < next.start) next = 'start' in patch ? { ...next, end: next.start } : { ...next, start: next.end };
      return { ...layer, textPath: next, raster: null, renderedTransform: null };
    });
  }

  /** Opens a Warp Text session: the popover previews live and ends it with OK (one undo step) or Cancel. */
  beginWarp(session: EditorSession): boolean {
    const layer = this.targetLayer(session);
    if (!layer || layer.textPath || this.warping) return false;
    const e = this.editing;
    const inEdit = !!e && e.session === session;
    if (!inEdit && (!session.canEditLayers || session.refuseLayerEdit(layer.id, 'pixels'))) return false;
    if (inEdit) { e.undo.push({ layer, anchor: e.anchor, focus: e.focus }); e.redo = []; } else session.beginEdit('Warp Text');
    this.warping = { session, layerId: layer.id, before: layer, own: !inEdit };
    return true;
  }

  /** Shows a warp (or none) on the layer of the open Warp Text session. */
  previewWarp(warp: TextWarp | null): void {
    const w = this.warping, document = w?.session.document;
    const layer = w ? w.session.layer(w.layerId) : null;
    if (!w || !document || layer?.kind !== 'text') return;
    w.session.replaceDocument(replaceLayer(document, { ...layer, textWarp: warp, raster: null, renderedTransform: null }));
    w.session.notify('document');
  }

  endWarp(commit: boolean): void {
    const w = this.warping;
    if (!w) return;
    this.warping = null;
    const document = w.session.document;
    if (!commit && document && w.session.layer(w.layerId)?.kind === 'text') {
      // Cancel restores the layer as it was, including an imported preview the preview had to drop.
      w.session.replaceDocument(replaceLayer(document, w.before));
      w.session.notify('document');
      const e = this.editing;
      if (e && e.session === w.session) e.undo.pop();
    }
    if (w.own && w.session.history.isInTransaction) w.session.endEdit();
    w.session.notify('ui');
    if (this.editing) this.refocusLater();
  }

  get warpOpen(): boolean { return this.warping !== null; }

  /** P11: replaces a missing family everywhere in the document as one undo step. */
  async replaceFont(session: EditorSession, family: string, replacement: string): Promise<void> {
    await this.runtime.ensureFamily(replacement);
    const document = session.document;
    if (!document || !session.canEditLayers) return;
    const wanted = family.toLocaleLowerCase();
    session.edit('Replace Font', () => {
      for (const layer of document.layers) {
        if (layer.kind !== 'text') continue;
        const runs = layer.runs.filter((run) => run.style.fontFamily.toLocaleLowerCase() === wanted);
        if (!runs.length) continue;
        for (const run of runs) session.applyTextStyle(layer.id, run.from, run.to, { fontFamily: replacement });
        this.fitPointText(session, layer.id);
      }
    });
  }

  /** What the controls show: the selection's style while editing, the active text layer's, or the tool settings. */
  controlsState(session: EditorSession): { target: 'selection' | 'layer' | 'tool'; style: TextRunStyle;
    paragraph: TextParagraphStyle; mixed: ReadonlySet<keyof TextRunStyle> } {
    const e = this.editing;
    const covering = (layer: TextLayer, from: number, to: number) => {
      const runs = layer.runs.filter((run) => run.to > from && run.from < to);
      const mixed = new Set<keyof TextRunStyle>();
      const first = runs[0]?.style;
      if (first) for (const run of runs) for (const key of Object.keys(first) as (keyof TextRunStyle)[]) {
        if (JSON.stringify(run.style[key]) !== JSON.stringify(first[key])) mixed.add(key);
      }
      return mixed;
    };
    if (e && e.session === session) {
      const layer = this.layer(e);
      const [from, to] = this.range(e);
      const paragraph = layer?.paragraphs.find((value) => value.from <= from && from <= value.to)?.style ?? defaultTextParagraphStyle();
      if (!layer || from === to) return { target: 'selection', style: e.typing, paragraph, mixed: new Set() };
      return { target: 'selection', style: styleAt(layer, from), paragraph, mixed: covering(layer, from, to) };
    }
    const layer = session.activeLayer;
    if (layer?.kind === 'text') {
      return { target: 'layer', style: layer.runs[0]?.style ?? textDefaults(session).style,
        paragraph: layer.paragraphs[0]?.style ?? defaultTextParagraphStyle(), mixed: covering(layer, 0, layer.text.length) };
    }
    const settings = textDefaults(session);
    return { target: 'tool', style: { ...settings.style, color: { ...session.foregroundColor, alpha: 1 } }, paragraph: settings.paragraph,
      mixed: new Set() };
  }

  // MARK: Pointer (the Type tool)

  private local(g: TextGeometry, pixel: Point): Point { return apply(invert(g.toDocument), pixel); }

  private countClick(c: ToolContext): number {
    const now = performance.now();
    const near = Math.hypot(c.point.x - this.clicks.point.x, c.point.y - this.clicks.point.y) < 5;
    this.clicks = { time: now, point: c.point, count: now - this.clicks.time < 450 && near ? this.clicks.count + 1 : 1 };
    return this.clicks.count;
  }

  /** The start or end marker of the edited text on a path within reach of a document point. */
  private markerAt(e: EditState | null, pixel: Point, reach: number): 'start' | 'end' | null {
    const layer = e && this.layer(e);
    const markers = layer?.textPath ? textPathMarkers(layer) : null;
    if (!markers) return null;
    const ds = Math.hypot(markers.start.point.x - pixel.x, markers.start.point.y - pixel.y);
    const de = Math.hypot(markers.end.point.x - pixel.x, markers.end.point.y - pixel.y);
    if (Math.min(ds, de) > reach) return null;
    return ds <= de ? 'start' : 'end';
  }

  /** The I-beam, the type-on-a-path cursor over a shape's path, or a resize cursor over a path text marker. */
  private hover(c: ToolContext): string {
    const session = c.session;
    if (!session.document) return 'text';
    const reach = 6 / Math.max(session.viewport.pointsPerPixel, 1e-4);
    const e = this.editing?.session === session ? this.editing : null;
    if (this.markerAt(e, c.pixel, reach)) return 'ew-resize';
    if (textLayerAt(session, c.pixel, 4 / Math.max(session.viewport.pointsPerPixel, 1e-4))) return 'text';
    return session.canEditLayers && pathUnderPointer(session, c.pixel, reach) ? PATH_TEXT_CURSOR : 'text';
  }

  private down(c: ToolContext): void {
    const session = c.session;
    if (!session.document) return;
    const margin = 4 / Math.max(session.viewport.pointsPerPixel, 1e-4);
    const reach = 6 / Math.max(session.viewport.pointsPerPixel, 1e-4);
    const clicks = this.countClick(c);
    const e = this.editing?.session === session ? this.editing : null;
    const which = this.markerAt(e, c.pixel, reach);
    if (e && which) {
      // Dragging a marker moves where the text starts or ends along its path (Photoshop's path selection drag).
      const layer = this.layer(e);
      if (layer) { e.undo.push({ layer, anchor: e.anchor, focus: e.focus }); e.redo = []; }
      this.marker = { e, which };
      return;
    }
    const hit = textLayerAt(session, c.pixel, margin);
    if (e && hit?.id === e.layerId) {
      const layer = this.layer(e)!, g = this.geometry(e);
      const index = g ? g.caretIndex(this.local(g, c.pixel)) : layer.text.length;
      if (clicks === 2) { const [a, b] = wordAt(layer.text, index); this.select(e, a, b); }
      else if (clicks >= 3) { const [a, b] = paragraphAt(layer.text, index); this.select(e, a, b); }
      else { this.select(e, c.modifiers.shift ? e.anchor : index, index); this.selecting = true; }
      return;
    }
    if (this.editing) {
      // Photoshop: a click away from the text being edited commits it; the next click starts new text.
      this.commit();
      if (!hit) return;
    }
    if (hit) {
      if (this.startExisting(session, hit.id, 0)) {
        const e2 = this.editing!, g = this.geometry(e2);
        const index = g ? g.caretIndex(this.local(g, c.pixel)) : hit.text.length;
        this.select(e2, index, index);
        this.selecting = true;
      }
      return;
    }
    if (!session.canEditLayers) return;
    const path = pathUnderPointer(session, c.pixel, reach);
    if (path) { this.startOnPath(session, path.path, path.fraction); return; }
    this.draft = { session, start: c.pixel, startView: c.point, current: c.pixel, moved: false };
  }

  private move(c: ToolContext): void {
    const marker = this.marker;
    if (marker && marker.e === this.editing && marker.e.session === c.session) {
      const layer = this.layer(marker.e), document = c.session.document;
      if (layer?.textPath && document) {
        const fraction = textPathFraction(layer, c.pixel), current = layer.textPath;
        let next: TextOnPath = { ...current, [marker.which]: fraction };
        if (!current.path.closed) next = marker.which === 'start' ? { ...next, start: Math.min(fraction, current.end) } : { ...next, end: Math.max(fraction, current.start) };
        c.session.replaceDocument(replaceLayer(document, { ...layer, textPath: next, raster: null, renderedTransform: null }));
        c.session.notify('document');
      }
      return;
    }
    const e = this.editing;
    if (this.selecting && e && e.session === c.session) {
      const g = this.geometry(e);
      if (g) this.select(e, e.anchor, g.caretIndex(this.local(g, c.pixel)));
      return;
    }
    const draft = this.draft;
    if (!draft) return;
    draft.current = c.pixel;
    if (Math.hypot(c.point.x - draft.startView.x, c.point.y - draft.startView.y) >= 4) draft.moved = true;
    c.session.notify('overlay');
  }

  private up(c: ToolContext): void {
    if (this.marker) { this.marker = null; this.focusInput(); return; }
    const draft = this.draft;
    this.draft = null;
    this.selecting = false;
    if (draft) {
      const { start } = draft, end = c.pixel;
      const rect = { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) };
      if (draft.moved && rect.width >= 4 && rect.height >= 4) this.startNew(c.session, rect);
      else this.startNew(c.session, start);
    }
    this.focusInput();
    setTimeout(() => this.focusInput(), 0);
  }

  private cancelGesture(session: EditorSession): void {
    this.draft = null;
    this.marker = null;
    this.selecting = false;
    session.notify('overlay');
  }

  /** Double-click on text with another tool: switch to the Type tool and edit it there. */
  doubleClick(point: Point): void {
    const session = this.controller.session, document = session.document;
    if (!document || session.tool === 'text') return;
    const pixel = session.viewport.documentPoint(point, document);
    const hit = textLayerAt(session, pixel, 4 / Math.max(session.viewport.pointsPerPixel, 1e-4));
    if (!hit) return;
    session.selectTool('text');
    if (!this.startExisting(session, hit.id, hit.text.length)) return;
    const e = this.editing!, g = this.geometry(e);
    if (g) { const index = g.caretIndex(this.local(g, pixel)); this.select(e, index, index); }
    this.focusInput();
  }

  // MARK: Overlay

  /** The caret as a document-space segment (top, bottom). */
  private caretLine(e: EditState): [Point, Point] | null {
    const layer = this.layer(e);
    if (!layer) return null;
    const document = e.session.document!;
    if (!layer.text.length && layer.textPath) {
      // An empty text on a path: the caret stands on the path where the text will start, turned with it.
      const pixels = e.typing.fontSize * document.resolution / 72, settings = layer.textPath;
      const mapping = new PathTextMapping(new PathMeasure(settings.path), { start: settings.start, end: settings.end, flipped: settings.flipped,
        baselineOffset: settings.baselineOffset * document.resolution / 72 },
      [{ top: -pixels * ASCENT, bottom: pixels * (LINE - ASCENT), baseline: 0, left: 0, right: 0, alignment: layer.paragraphs[0]?.style.alignment ?? 'left' }]);
      const map = frameToDocument(layer.transform);
      return [apply(map, mapping.map({ x: 0, y: -pixels * ASCENT })), apply(map, mapping.map({ x: 0, y: pixels * (LINE - ASCENT) }))];
    }
    if (!layer.text.length) {
      const alignment = layer.paragraphs[0]?.style.alignment ?? 'left';
      const t = layer.box ? layer.transform : e.session.displayedTransform(layer);
      const top = unitPoint(t, { x: alignment === 'center' ? 0.5 : alignment === 'right' ? 1 : 0, y: 0 });
      const height = e.typing.fontSize * document.resolution / 72 * LINE, r = radians(t);
      return [top, { x: top.x - Math.sin(r) * height, y: top.y + Math.cos(r) * height }];
    }
    const g = this.geometry(e);
    if (!g) return null;
    const caret = g.caretRect(e.focus);
    return [apply(g.toDocument, g.toRaster({ x: caret.x, y: caret.y })), apply(g.toDocument, g.toRaster({ x: caret.x, y: caret.y + caret.height }))];
  }

  paint(context: CanvasRenderingContext2D, session: EditorSession, accent: string): void {
    const document = session.document;
    if (!document) return;
    const view = (p: Point) => session.viewport.viewPoint(p, document);
    const draft = this.draft;
    if (draft?.session === session && draft.moved) {
      const a = view(draft.start), b = view(draft.current);
      context.setLineDash([4, 3]);
      context.strokeStyle = 'rgba(0,0,0,0.8)'; context.lineWidth = 3;
      context.strokeRect(Math.min(a.x, b.x) + 0.5, Math.min(a.y, b.y) + 0.5, Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      context.strokeStyle = '#fff'; context.lineWidth = 1;
      context.strokeRect(Math.min(a.x, b.x) + 0.5, Math.min(a.y, b.y) + 0.5, Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      context.setLineDash([]);
    }
    const e = this.editing;
    if (!e || e.session !== session) return;
    const layer = this.layer(e);
    if (!layer) return;
    if (layer.textPath) this.paintPath(context, layer, view, accent);
    else {
      // Frame: the area text's box, or the point text's extent.
      const t = layer.box ? layer.transform : session.displayedTransform(layer);
      const corners = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }].map((u) => view(unitPoint(t, u)));
      context.beginPath();
      corners.forEach((p, i) => (i ? context.lineTo(p.x, p.y) : context.moveTo(p.x, p.y)));
      context.closePath();
      context.strokeStyle = accent; context.globalAlpha = 0.75; context.lineWidth = 1;
      if (!layer.box) context.setLineDash([3, 3]);
      context.stroke();
      context.setLineDash([]);
      context.globalAlpha = 1;
    }
    const g = layer.text.length ? this.geometry(e) : null;
    const [from, to] = this.range(e);
    const polygon = (rect: Rect) => {
      if (!g) return;
      // Layout rectangles bend with text on a path or a warp.
      const points = g.polygon(rect).map((p) => view(apply(g.toDocument, p)));
      context.beginPath();
      points.forEach((p, i) => (i ? context.lineTo(p.x, p.y) : context.moveTo(p.x, p.y)));
      context.closePath();
      context.fill();
    };
    if (g && from !== to) {
      context.fillStyle = accent; context.globalAlpha = 0.38;
      for (const rect of g.selectionRects(from, to)) polygon(rect);
      context.globalAlpha = 1;
    }
    if (g && e.composition && e.composition.length) {
      context.fillStyle = accent;
      for (const rect of g.selectionRects(e.composition.from, e.composition.from + e.composition.length)) {
        polygon({ x: rect.x, y: rect.y + rect.height - Math.max(1, rect.height * 0.06), width: rect.width, height: Math.max(1, rect.height * 0.06) });
      }
    }
    if (from === to) {
      const caret = this.caretLine(e);
      if (caret) {
        const a = view(caret[0]), b = view(caret[1]);
        context.lineCap = 'butt';
        context.strokeStyle = 'rgba(255,255,255,0.9)'; context.lineWidth = 3;
        context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.stroke();
        context.strokeStyle = '#000'; context.lineWidth = 1.25;
        context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.stroke();
      }
    }
    this.positionOnly();
  }

  /** Text on a path: the path itself and its start (circle) and end (bar) markers, as Photoshop shows them. */
  private paintPath(context: CanvasRenderingContext2D, layer: TextLayer, view: (p: Point) => Point, accent: string): void {
    const points = textPathPolyline(layer).map(view);
    context.beginPath();
    points.forEach((p, i) => (i ? context.lineTo(p.x, p.y) : context.moveTo(p.x, p.y)));
    context.strokeStyle = 'rgba(255,255,255,0.85)'; context.lineWidth = 3; context.stroke();
    context.strokeStyle = accent; context.lineWidth = 1.25; context.stroke();
    const markers = textPathMarkers(layer);
    if (!markers) return;
    for (const [which, marker] of [['start', markers.start], ['end', markers.end]] as const) {
      const p = view(marker.point), n = marker.normal;
      context.beginPath();
      context.moveTo(p.x - n.x * 9, p.y - n.y * 9); context.lineTo(p.x + n.x * 9, p.y + n.y * 9);
      context.strokeStyle = 'rgba(255,255,255,0.9)'; context.lineWidth = 3.5; context.stroke();
      context.strokeStyle = accent; context.lineWidth = 1.5; context.stroke();
      context.beginPath();
      if (which === 'start') context.arc(p.x, p.y, 4, 0, Math.PI * 2);
      else context.rect(p.x - 3.5, p.y - 3.5, 7, 7);
      context.fillStyle = '#fff'; context.fill();
      context.strokeStyle = accent; context.lineWidth = 1.5; context.stroke();
    }
  }

  private positionOnly(): void {
    const e = this.editing, input = this.input;
    if (!e || !input) return;
    const caret = this.caretLine(e), document = e.session.document;
    if (!caret || !document) return;
    const top = e.session.viewport.viewPoint(caret[0], document);
    input.style.left = `${Math.round(top.x)}px`;
    input.style.top = `${Math.round(top.y)}px`;
  }
}
