/**
 * The Artboard tool (PRODUCT-PLAN 6.1 "Zeichenflächen mit Formatvorlagen", Photoshop's Artboard tool):
 * drag on empty canvas to draw an artboard, drag an artboard (or its name) to move it with its content,
 * drag a handle of the selected artboard to resize it (content stays), a context bar with size presets,
 * name, background and delete. Frames and names are painted over the canvas for every tool.
 *
 * Photoshop keeps the Artboard tool in the Move tool's slot (V, Shift-V cycles). The rail here has no
 * flyout groups, so the Artboard tool gets its own button right under Move; V still selects Move and
 * Shift-V switches between Move and Artboard, which is Photoshop's cycle within the group.
 *
 * Each gesture is one undo step (a transaction around the live commands). The compositors do not draw
 * artboard backgrounds yet (exports do), so the name label carries a background swatch.
 */

import { useEffect, useState } from 'react';
import styles from '../ui/editor.module.css';
import type { EditorController } from '../ui/controller';
import type { ToolContext, ToolHandler } from '../ui/canvas/tools';
import { resizeCursor } from '../ui/canvas/tools';
import { useSession } from '../ui/hooks';
import { confirmDeleteArtboard, resizedRect, selectArtboard, selectedArtboard } from '../ui/artboardState';
import type { EditorSession } from '../core/session';
import type { Artboard } from '../core/document';
import type { Point, Rect } from '../core/geometry';
import { artboardAt, findArtboard, TRANSPARENT_ARTBOARD_BACKGROUND, type ArtboardBackground } from '../core/artboards';
import { createArtboard, lastArtboardError, moveArtboard, renameArtboard, resizeArtboard, setArtboardBackground } from '../core/artboardCommands';
import { ARTBOARD_PRESETS, artboardPreset, type ArtboardPresetCategory } from '../core/artboardPresets';

const LABEL_FONT = '500 11px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, Roboto, sans-serif';
const LABEL_HEIGHT = 16;
const LABEL_GAP = 4;
const SWATCH = 9;

let measuring: CanvasRenderingContext2D | null = null;
function measureContext(): CanvasRenderingContext2D | null {
  measuring ??= globalThis.document?.createElement('canvas').getContext('2d') ?? null;
  if (measuring) measuring.font = LABEL_FONT;
  return measuring;
}
/** Artboard being drawn, in document pixels (painted until released). */
const drafts = new WeakMap<EditorSession, Rect>();

function viewRect(session: EditorSession, rect: Rect): Rect {
  const document = session.document!;
  const origin = session.viewport.documentRect(document), ppp = session.viewport.pointsPerPixel;
  return { x: origin.x + rect.x * ppp, y: origin.y + rect.y * ppp, width: rect.width * ppp, height: rect.height * ppp };
}

/** Handles TL, T, TR, R, BR, B, BL, L in view points (the order of `resizeCursor`). */
function handlePoints(rect: Rect): Point[] {
  const { x, y, width: w, height: h } = rect;
  return [{ x, y }, { x: x + w / 2, y }, { x: x + w, y }, { x: x + w, y: y + h / 2 }, { x: x + w, y: y + h }, { x: x + w / 2, y: y + h }, { x, y: y + h }, { x, y: y + h / 2 }];
}

function inside(point: Point, rect: Rect): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
}

/** Where an artboard's name label goes (above its top-left corner, cut to the artboard's width), in view points. */
function labelLayout(context: CanvasRenderingContext2D, session: EditorSession, artboard: Artboard): { name: string; x: number; top: number; hit: Rect } {
  const r = viewRect(session, artboard.rect);
  const name = ellipsized(context, artboard.name, Math.max(40, Math.round(r.width) - SWATCH - 6));
  const x = Math.round(r.x), top = Math.round(r.y) - LABEL_GAP - LABEL_HEIGHT;
  return { name, x, top, hit: { x: x - 2, y: top, width: SWATCH + 5 + context.measureText(name).width + 4, height: LABEL_HEIGHT + LABEL_GAP } };
}

type Hit = { kind: 'handle'; id: string; handle: number } | { kind: 'label' | 'body'; id: string } | null;

function hitTest(session: EditorSession, point: Point, pixel: Point, touch: boolean): Hit {
  const document = session.document;
  if (!document) return null;
  const selected = selectedArtboard(session);
  if (selected) {
    const radius = touch ? 16 : 7;
    const index = handlePoints(viewRect(session, selected.rect)).findIndex((p) => Math.hypot(p.x - point.x, p.y - point.y) <= radius);
    if (index >= 0) return { kind: 'handle', id: selected.id, handle: index };
  }
  const context = measureContext();
  for (const artboard of [...(document.artboards ?? [])].reverse()) {
    if (context && inside(point, labelLayout(context, session, artboard).hit)) return { kind: 'label', id: artboard.id };
  }
  const under = artboardAt(document, pixel);
  return under ? { kind: 'body', id: under.id } : null;
}

/** Keeps the document where it is on screen when a command grows the canvas (the view centres the canvas). */
function keepInPlace(session: EditorSession, before: { width: number; height: number }): void {
  const document = session.document;
  if (!document || (document.width === before.width && document.height === before.height)) return;
  const ppp = session.viewport.pointsPerPixel;
  session.viewport.pan = { x: session.viewport.pan.x + (document.width - before.width) * ppp / 2, y: session.viewport.pan.y + (document.height - before.height) * ppp / 2 };
  session.viewport.followsFit = false;
  session.notify('view');
}

function sizeOf(session: EditorSession): { width: number; height: number } {
  return { width: session.document?.width ?? 0, height: session.document?.height ?? 0 };
}

/** The rect spanned by two document points, in whole pixels, never left of or above the canvas origin. */
function spanned(a: Point, b: Point): Rect {
  const x0 = Math.max(0, Math.round(Math.min(a.x, b.x))), y0 = Math.max(0, Math.round(Math.min(a.y, b.y)));
  const x1 = Math.max(0, Math.round(Math.max(a.x, b.x))), y1 = Math.max(0, Math.round(Math.max(a.y, b.y)));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

type Drag =
  | { kind: 'create'; start: Point; startView: Point; current: Point }
  | { kind: 'move'; id: string; start: Point; origin: Rect; changed: boolean }
  | { kind: 'resize'; id: string; handle: number; start: Point; origin: Rect; changed: boolean };

class ArtboardTool implements ToolHandler {
  private drag: Drag | null = null;

  down(c: ToolContext): void {
    const session = c.session;
    if (!session.document || !session.canEditLayers) return;
    const hit = hitTest(session, c.point, c.pixel, c.pointerType === 'touch');
    if (!hit) {
      this.drag = { kind: 'create', start: c.pixel, startView: c.point, current: c.pixel };
      return;
    }
    const artboard = findArtboard(session.document, hit.id)!;
    selectArtboard(session, hit.id);
    session.beginEdit(hit.kind === 'handle' ? 'Resize Artboard' : 'Move Artboard');
    this.drag = hit.kind === 'handle'
      ? { kind: 'resize', id: hit.id, handle: hit.handle, start: c.pixel, origin: artboard.rect, changed: false }
      : { kind: 'move', id: hit.id, start: c.pixel, origin: artboard.rect, changed: false };
    c.setCursor(hit.kind === 'handle' ? this.cursorFor(session, hit.handle) : 'move');
  }

  move(c: ToolContext): void {
    const drag = this.drag, session = c.session;
    if (!drag) return;
    if (drag.kind === 'create') {
      drag.current = c.pixel;
      drafts.set(session, spanned(drag.start, drag.current));
      session.notify('overlay');
      return;
    }
    const current = findArtboard(session.document, drag.id);
    if (!current) return;
    let dx = Math.round(c.pixel.x - drag.start.x), dy = Math.round(c.pixel.y - drag.start.y);
    const before = sizeOf(session);
    if (drag.kind === 'move') {
      // Shift keeps the move horizontal or vertical.
      if (c.modifiers.shift) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      const x = Math.max(0, drag.origin.x + dx), y = Math.max(0, drag.origin.y + dy);
      if (x !== current.rect.x || y !== current.rect.y) drag.changed = moveArtboard(session, drag.id, x - current.rect.x, y - current.rect.y) || drag.changed;
    } else {
      const next = resizedRect(drag.origin, drag.handle, dx, dy, c.modifiers.shift);
      const r = current.rect;
      if (next.x !== r.x || next.y !== r.y || next.width !== r.width || next.height !== r.height) drag.changed = resizeArtboard(session, drag.id, next) || drag.changed;
    }
    keepInPlace(session, before);
  }

  up(c: ToolContext): void {
    const drag = this.drag, session = c.session;
    this.drag = null;
    if (!drag) return;
    if (drag.kind !== 'create') { session.endEdit(); this.reportRefusal(session); return; }
    drafts.delete(session);
    const rect = spanned(drag.start, c.pixel);
    const clicked = Math.hypot(c.point.x - drag.startView.x, c.point.y - drag.startView.y) < 4;
    if (clicked || rect.width < 1 || rect.height < 1) {
      selectArtboard(session, artboardAt(session.document!, c.pixel)?.id ?? null);
      session.notify('overlay');
      return;
    }
    const before = sizeOf(session);
    const id = createArtboard(session, { rect });
    keepInPlace(session, before);
    if (id) selectArtboard(session, id); else this.reportRefusal(session);
  }

  cancel(session: EditorSession): void {
    const drag = this.drag;
    this.drag = null;
    drafts.delete(session);
    if (!drag || drag.kind === 'create') { session.notify('overlay'); return; }
    session.endEdit();
    if (drag.changed) session.undo();
  }

  hover(c: ToolContext): string {
    const hit = hitTest(c.session, c.point, c.pixel, c.pointerType === 'touch');
    if (!hit) return 'crosshair';
    return hit.kind === 'handle' ? this.cursorFor(c.session, hit.handle) : 'move';
  }

  overlayOnly(): boolean { return this.drag?.kind === 'create'; }
  autoscrolls(): boolean { return this.drag !== null; }

  private cursorFor(session: EditorSession, handle: number): string {
    const artboard = selectedArtboard(session);
    if (!artboard) return 'default';
    return resizeCursor({ handles: handlePoints(viewRect(session, artboard.rect)), rotationHandle: { x: 0, y: 0 }, showsRotation: false }, handle);
  }

  private reportRefusal(session: EditorSession): void {
    // Lock refusals already show the lock notice; size limits become the editor's error alert.
    if (lastArtboardError?.code === 'too-large') { session.errorMessage = lastArtboardError.message; session.notify('ui'); }
  }
}

// MARK: Canvas overlay

function paintArtboards(context: CanvasRenderingContext2D, session: EditorSession): void {
  const document = session.document;
  const artboards = document?.artboards ?? [];
  const draft = drafts.get(session);
  if (!document || (!artboards.length && !draft)) return;
  const style = getComputedStyle(context.canvas);
  const accent = style.getPropertyValue('--cmp-accent').trim() || '#0a84ff';
  const text = style.getPropertyValue('--cmp-text').trim() || 'rgba(255,255,255,0.88)';
  const secondary = style.getPropertyValue('--cmp-text-secondary').trim() || 'rgba(255,255,255,0.55)';
  const selected = selectedArtboard(session);
  const toolActive = session.tool === 'artboard';
  context.font = LABEL_FONT;
  context.textBaseline = 'alphabetic';
  for (const artboard of artboards) {
    const r = viewRect(session, artboard.rect);
    const isSelected = selected?.id === artboard.id;
    const x = Math.round(r.x) + 0.5, y = Math.round(r.y) + 0.5, w = Math.round(r.width), h = Math.round(r.height);
    context.lineWidth = 1;
    context.strokeStyle = 'rgba(0,0,0,0.55)';
    context.strokeRect(x - 1, y - 1, w + 2, h + 2);
    context.strokeStyle = isSelected && toolActive ? accent : 'rgba(170,170,170,0.9)';
    context.strokeRect(x, y, w, h);
    // Name above the top-left corner, with a background swatch (the canvas does not draw backgrounds yet).
    const label = labelLayout(context, session, artboard);
    paintSwatch(context, artboard.background, label.x, label.top + (LABEL_HEIGHT - SWATCH) / 2);
    context.fillStyle = isSelected ? (toolActive ? accent : text) : secondary;
    context.fillText(label.name, label.x + SWATCH + 5, label.top + LABEL_HEIGHT - 4);
  }
  if (selected && toolActive) {
    const touch = matchMedia('(pointer: coarse)').matches, half = touch ? 6 : 3.5;
    context.fillStyle = '#fff';
    context.strokeStyle = accent;
    for (const p of handlePoints(viewRect(session, selected.rect))) {
      context.fillRect(p.x - half, p.y - half, half * 2, half * 2);
      context.strokeRect(p.x - half, p.y - half, half * 2, half * 2);
    }
  }
  if (draft && draft.width > 0 && draft.height > 0) {
    const r = viewRect(session, draft);
    context.setLineDash([4, 3]);
    context.strokeStyle = accent;
    context.strokeRect(Math.round(r.x) + 0.5, Math.round(r.y) + 0.5, Math.round(r.width), Math.round(r.height));
    context.setLineDash([]);
    const label = `${draft.width} × ${draft.height} px`;
    const width = context.measureText(label).width + 12;
    context.fillStyle = 'rgba(0,0,0,0.75)';
    context.fillRect(Math.round(r.x + r.width) + 8, Math.round(r.y + r.height) + 8, width, 20);
    context.fillStyle = '#fff';
    context.fillText(label, Math.round(r.x + r.width) + 14, Math.round(r.y + r.height) + 22);
  }
}

function paintSwatch(context: CanvasRenderingContext2D, background: ArtboardBackground, x: number, y: number): void {
  // A colour dot (not a square, which would read as a checkbox); transparent is a half-grey dot.
  const r = SWATCH / 2, cx = x + r, cy = y + r;
  context.save();
  context.beginPath();
  context.arc(cx, cy, r - 0.5, 0, Math.PI * 2);
  context.clip();
  if (background.alpha < 1) {
    context.fillStyle = '#d8d8d8'; context.fillRect(x, y, SWATCH, SWATCH);
    context.fillStyle = '#8a8a8a'; context.fillRect(x, y, r, r); context.fillRect(cx, cy, r, r);
  }
  if (background.alpha > 0) {
    context.fillStyle = `rgba(${Math.round(background.red * 255)},${Math.round(background.green * 255)},${Math.round(background.blue * 255)},${background.alpha})`;
    context.fillRect(x, y, SWATCH, SWATCH);
  }
  context.restore();
  context.beginPath();
  context.arc(cx, cy, r - 0.5, 0, Math.PI * 2);
  context.strokeStyle = 'rgba(0,0,0,0.55)';
  context.lineWidth = 1;
  context.stroke();
}

function ellipsized(context: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (context.measureText(text).width <= maxWidth) return text;
  let end = text.length;
  while (end > 1 && context.measureText(`${text.slice(0, end)}…`).width > maxWidth) end--;
  return `${text.slice(0, end)}…`;
}

// MARK: Context bar

const CATEGORIES: { id: ArtboardPresetCategory; label: string }[] = [
  { id: 'social', label: 'Social Media' }, { id: 'web', label: 'Web' }, { id: 'print', label: 'Print (300 ppi)' },
];

type BackgroundChoice = 'transparent' | 'white' | 'color';
function backgroundChoice(background: ArtboardBackground): BackgroundChoice {
  if (background.alpha === 0) return 'transparent';
  return background.red === 1 && background.green === 1 && background.blue === 1 && background.alpha === 1 ? 'white' : 'color';
}

function hex(background: ArtboardBackground): string {
  return `#${[background.red, background.green, background.blue].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`;
}

function NameField({ controller, session, artboard }: { controller: EditorController; session: EditorSession; artboard: Artboard }) {
  const t = controller.t;
  const [text, setText] = useState(artboard.name);
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setText(artboard.name); }, [artboard.name, artboard.id, focused]);
  const commit = (value: string) => { if (value.trim() && value.trim() !== artboard.name) renameArtboard(session, artboard.id, value); };
  return (
    <label className={styles.field}>
      <span>{t('Name')}</span>
      <input value={text} style={{ width: 150, textAlign: 'left' }} aria-label={t('Artboard name')} data-testid="artboard-name"
        onFocus={() => setFocused(true)}
        onBlur={(event) => { setFocused(false); commit(event.target.value); }}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
          if (event.key === 'Escape') { setText(artboard.name); setFocused(false); requestAnimationFrame(() => (event.target as HTMLInputElement).blur()); }
        }} />
    </label>
  );
}

function ArtboardBar({ controller, session }: { controller: EditorController; session: EditorSession }) {
  useSession(session);
  const t = controller.t;
  const artboard = selectedArtboard(session);
  const enabled = session.canEditLayers;
  const applyPreset = (id: string) => {
    const preset = artboardPreset(id);
    if (!preset) return;
    const before = sizeOf(session);
    if (artboard) resizeArtboard(session, artboard.id, { x: artboard.rect.x, y: artboard.rect.y, width: preset.width, height: preset.height });
    else { const created = createArtboard(session, { preset: id }); if (created) selectArtboard(session, created); }
    keepInPlace(session, before);
  };
  const setBackground = (choice: BackgroundChoice) => {
    if (!artboard) return;
    if (choice === 'transparent') setArtboardBackground(session, artboard.id, TRANSPARENT_ARTBOARD_BACKGROUND);
    else if (choice === 'white') setArtboardBackground(session, artboard.id, { red: 1, green: 1, blue: 1, alpha: 1 });
    else pickBackground();
  };
  const pickBackground = () => {
    if (!artboard) return;
    const initial = backgroundChoice(artboard.background) === 'color' ? artboard.background : { ...session.paletteColor(false), alpha: 1 };
    if (controller.pickColor) {
      controller.pickColor({ title: t('Artboard Background'), initial, commit: (color) => setArtboardBackground(session, artboard.id, { ...color, alpha: 1 }) });
    } else setArtboardBackground(session, artboard.id, { red: initial.red, green: initial.green, blue: initial.blue, alpha: 1 });
  };
  const choice = artboard ? backgroundChoice(artboard.background) : null;
  return (
    <>
      <span className={styles.headerTitle}>{t('Artboard')}</span>
      <select className={styles.select} value="" disabled={!enabled} aria-label={t('Artboard size preset')} data-testid="artboard-preset" style={{ width: 170 }}
        onChange={(event) => { applyPreset(event.target.value); event.target.blur(); }}>
        <option value="" disabled>{artboard ? t('Change size…') : t('New artboard…')}</option>
        {CATEGORIES.map((category) => (
          <optgroup key={category.id} label={t(category.label)}>
            {ARTBOARD_PRESETS.filter((p) => p.category === category.id).map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.name.includes('×') ? t(preset.name) : `${t(preset.name)} · ${preset.width.toLocaleString(controller.locale)} × ${preset.height.toLocaleString(controller.locale)}`}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {artboard ? (
        <>
          <NameField key={artboard.id} controller={controller} session={session} artboard={artboard} />
          <span className={styles.secondary} data-testid="artboard-size">
            {artboard.rect.width.toLocaleString(controller.locale)} × {artboard.rect.height.toLocaleString(controller.locale)} px
          </span>
          <span className={styles.field}><span>{t('Background')}</span></span>
          <div className={styles.segmented} role="radiogroup" aria-label={t('Background')}>
            {(['transparent', 'white', 'color'] as const).map((option) => (
              <button key={option} type="button" role="radio" aria-checked={choice === option} disabled={!enabled} data-testid={`artboard-bg-${option}`}
                className={`${styles.segment} ${choice === option ? styles.segmentOn : ''}`}
                onClick={() => (option === 'color' && choice === 'color' ? pickBackground() : setBackground(option))}>
                {option === 'color' ? (
                  <span className={styles.segmentSwatchLabel}>
                    {choice === 'color' ? <span className={styles.segmentSwatch} style={{ background: hex(artboard.background) }} /> : null}
                    {t('Color')}{choice === 'color' ? '' : ' …'}
                  </span>
                ) : t(option === 'transparent' ? 'Transparent' : 'White')}
              </button>
            ))}
          </div>
          <span className={styles.spacer} />
          <button type="button" className={styles.pill} disabled={!enabled} data-testid="artboard-delete"
            style={{ color: 'var(--cmp-danger)' }} onClick={() => void confirmDeleteArtboard(controller, artboard.id)}>{t('Delete…')}</button>
        </>
      ) : (
        <span className={styles.secondary}>{t('Drag on the canvas to draw an artboard, or pick a size.')}</span>
      )}
    </>
  );
}

export function installArtboards(controller: EditorController): void {
  const t = controller.t;
  controller.availableTools.add('artboard');
  const tool = new ArtboardTool();
  controller.canvasSetups.push((view) => {
    view.tools.artboard = tool;
    view.painters.push((context, session) => paintArtboards(context, session));
  });
  controller.contextBars.artboard = (session) => <ArtboardBar controller={controller} session={session} />;
  controller.statusHints.artboard = () => t('Drag on empty canvas to draw an artboard · Drag an artboard or its name to move it · Handles resize · Shift-V Move tool');
  // V selects Move; Shift-V cycles Move and Artboard (Photoshop's tool group cycle).
  const previous = controller.toolKeyHandlers.v;
  controller.toolKeyHandlers.v = (shift) => {
    if (!shift) { if (previous) previous(false); else controller.session.selectTool('move'); return; }
    controller.session.selectTool(controller.session.tool === 'artboard' ? 'move' : 'artboard');
  };
}
