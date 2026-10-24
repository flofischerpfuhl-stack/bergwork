/**
 * Quick Mask mode (Q): the selection shown as a 50 % red tint over what is not selected, edited with the Brush —
 * black masks, white selects, grey is partial, the Eraser paints the background colour. Every stroke is one undo
 * step ("Quick Mask"), so leaving the mode needs no conversion.
 */

import styles from '../../ui/editor.module.css';
import type { EditorController } from '../../ui/controller';
import type { ToolContext, ToolHandler } from '../../ui/canvas/tools';
import type { EditorSession } from '../../core/session';
import type { DocumentSelection } from '../../core/selection';
import type { Point } from '../../core/geometry';
import { canEditSelection } from '../../core/selectionCommands';
import { commitQuickMask, selectionMaskOnCanvas } from '../../core/refine/quickMask';
import { getBrushSettings } from '../../core/brush/commands';
import { DocumentOverlay, stampSegment, type DocRect } from './overlay';

interface QuickMaskState {
  mask: Uint8Array | null;
  /** The selection the mask was made from; another one (undo, a selection tool) rebuilds it. */
  maskFor: DocumentSelection | null | undefined;
  overlay: DocumentOverlay | null;
  stroke: { base: Uint8Array; coverage: Uint8Array; value: number; last: Point; diameter: number; hardness: number; opacity: number } | null;
}

const states = new WeakMap<EditorSession, QuickMaskState>();
export function quickMaskOn(session: EditorSession): boolean { return states.has(session); }

export function toggleQuickMask(session: EditorSession): void {
  if (states.has(session)) states.delete(session);
  else if (session.document) states.set(session, { mask: null, maskFor: undefined, overlay: null, stroke: null });
  session.notify('document');
}

const tint = (mask: Uint8Array) => (out: Uint8ClampedArray, o: number, i: number) => {
  out[o] = 255; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = Math.round((255 - mask[i]!) / 2);
};

function ensureMask(session: EditorSession, state: QuickMaskState): boolean {
  const document = session.document;
  if (!document) return false;
  const { width, height } = document;
  if (state.mask && state.maskFor === session.selection && state.mask.length === width * height) return true;
  state.mask = selectionMaskOnCanvas(session.selection, width, height);
  state.maskFor = session.selection;
  if (!state.overlay || state.overlay.docWidth !== width || state.overlay.docHeight !== height) state.overlay = new DocumentOverlay(width, height);
  state.overlay.update(tint(state.mask));
  return true;
}

export function paintQuickMask(context: CanvasRenderingContext2D, session: EditorSession): void {
  const state = states.get(session);
  if (!state || !ensureMask(session, state)) return;
  state.overlay?.draw(context, session);
}

const luminance = (c: { red: number; green: number; blue: number }) => Math.round((0.2126 * c.red + 0.7152 * c.green + 0.0722 * c.blue) * 255);

/** The Brush while Quick Mask is on: paints into the mask instead of the layer. */
export class QuickMaskBrush implements ToolHandler {
  down(c: ToolContext): void {
    const session = c.session, state = states.get(session), document = session.document;
    if (!state || !document || !canEditSelection(session) || !ensureMask(session, state)) return;
    const settings = getBrushSettings(session);
    const value = luminance(session.paletteColor(settings.mode === 'erase'));
    state.stroke = { base: state.mask!.slice(), coverage: new Uint8Array(document.width * document.height), value, last: c.pixel,
      diameter: settings.diameter, hardness: settings.hardness, opacity: settings.opacity };
    this.paint(session, state, c.pixel);
  }
  move(c: ToolContext): void {
    const state = states.get(c.session);
    if (state?.stroke) this.paint(c.session, state, c.pixel);
  }
  up(c: ToolContext): void {
    const session = c.session, state = states.get(session);
    if (!state?.stroke || !state.mask) return;
    const stroke = state.stroke;
    state.stroke = null;
    if (commitQuickMask(session, state.mask)) state.maskFor = session.selection;
    else { state.mask = stroke.base; state.overlay?.update(tint(state.mask)); }
    session.notify('document');
  }
  cancel(session: EditorSession): void {
    const state = states.get(session);
    if (!state?.stroke) return;
    state.mask = state.stroke.base;
    state.stroke = null;
    state.overlay?.update(tint(state.mask));
  }
  overlayOnly(): boolean { return true; }
  hover(): string { return 'none'; }

  private paint(session: EditorSession, state: QuickMaskState, point: Point): void {
    const stroke = state.stroke!, mask = state.mask!, document = session.document!;
    const rect: DocRect | null = stampSegment(stroke.coverage, document.width, document.height, stroke.last, point,
      stroke.diameter, stroke.hardness, stroke.opacity);
    stroke.last = point;
    if (!rect) return;
    const w = document.width, { base, coverage, value } = stroke;
    for (let y = rect.y; y < rect.y + rect.height; y++) {
      for (let x = rect.x; x < rect.x + rect.width; x++) {
        const i = y * w + x, k = coverage[i]!;
        if (k) mask[i] = Math.round(base[i]! + (value - base[i]!) * k / 255);
      }
    }
    state.overlay?.update(tint(mask), rect);
  }
}

export function QuickMaskExit({ controller, session }: { controller: EditorController; session: EditorSession }) {
  return (
    <button type="button" className={`${styles.pill} ${styles.pillOn}`} data-testid="quick-mask-exit"
      onClick={() => toggleQuickMask(session)}>{controller.t('Exit Quick Mask (Q)')}</button>
  );
}
