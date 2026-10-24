/**
 * Rulers, guides, align and distribute (PRODUCT-PLAN 6.1, Photoshop muscle memory): rulers along the top and left of
 * the canvas; dragging out of a ruler creates a guide (top ruler → horizontal, left ruler → vertical); the Move tool
 * drags guides, and dropping one back on its ruler deletes it. Guides are document data (saved, undoable); showing,
 * locking and snapping are view settings.
 */

import { useState } from 'react';
import styles from '../ui/editor.module.css';
import type { EditorController } from '../ui/controller';
import type { ToolContext, ToolHandler } from '../ui/canvas/tools';
import type { EditorSession } from '../core/session';
import type { Guide } from '../core/document';
import type { Point } from '../core/geometry';
import type { AlignEdge, DistributeMode } from '../core/align';

/** Ruler thickness in view points. */
export const RULER = 18;
const GUIDE_COLOR = '#00c8ff';
const HIT = 4;

/** A tick step (document pixels) that keeps labelled ticks at least ~60 view points apart. */
function tickStep(pointsPerPixel: number): number {
  const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000];
  return steps.find((s) => s * pointsPerPixel >= 60) ?? 10000;
}

function guideAt(session: EditorSession, point: Point, tolerance: number): Guide | null {
  const document = session.document;
  if (!document) return null;
  const origin = session.viewport.documentRect(document), ppp = session.viewport.pointsPerPixel;
  let best: Guide | null = null, distance = tolerance;
  for (const guide of session.guides) {
    const d = guide.orientation === 'vertical' ? Math.abs(origin.x + guide.position * ppp - point.x) : Math.abs(origin.y + guide.position * ppp - point.y);
    if (d <= distance) { best = guide; distance = d; }
  }
  return best;
}

/** Guide being created from a ruler, drawn until released. */
const pending = new WeakMap<EditorSession, Guide>();

class GuideTool implements ToolHandler {
  target: { kind: 'create'; orientation: Guide['orientation'] } | { kind: 'move'; id: string } | null = null;
  private moving: string | null = null;

  private overRuler(c: ToolContext, orientation: Guide['orientation']): boolean {
    return c.session.showsRulers && (orientation === 'horizontal' ? c.point.y < RULER : c.point.x < RULER);
  }
  down(c: ToolContext): void {
    const target = this.target;
    if (!target) return;
    if (target.kind === 'create') pending.set(c.session, { id: 'pending', orientation: target.orientation, position: target.orientation === 'horizontal' ? c.pixel.y : c.pixel.x });
    else { this.moving = target.id; c.session.beginGuideDrag(); }
    c.session.notify('overlay');
  }
  move(c: ToolContext): void {
    const session = c.session, draft = pending.get(session);
    if (draft) { pending.set(session, { ...draft, position: Math.round(draft.orientation === 'horizontal' ? c.pixel.y : c.pixel.x) }); session.notify('overlay'); return; }
    if (!this.moving) return;
    const guide = session.guides.find((g) => g.id === this.moving);
    if (guide) session.moveGuide(guide.id, guide.orientation === 'horizontal' ? c.pixel.y : c.pixel.x);
  }
  up(c: ToolContext): void {
    const session = c.session, draft = pending.get(session);
    pending.delete(session);
    if (draft) {
      // Released back over the ruler: no guide (Photoshop).
      if (!this.overRuler(c, draft.orientation)) session.addGuide(draft.orientation, draft.position);
      else session.notify('overlay');
    } else if (this.moving) {
      const guide = session.guides.find((g) => g.id === this.moving);
      if (guide && this.overRuler(c, guide.orientation)) session.dropGuideInDrag(guide.id);
      session.endGuideDrag();
    }
    this.moving = null;
    this.target = null;
  }
  cancel(session: EditorSession): void {
    pending.delete(session);
    if (this.moving) session.cancelGuideDrag();
    this.moving = null;
    this.target = null;
  }
  hover(c: ToolContext): string {
    const target = this.target;
    if (!target) return 'default';
    const orientation = target.kind === 'create' ? target.orientation : c.session.guides.find((g) => g.id === target.id)?.orientation;
    return orientation === 'horizontal' ? 'ns-resize' : 'ew-resize';
  }
}

function paintRulersAndGuides(context: CanvasRenderingContext2D, session: EditorSession): void {
  const document = session.document;
  if (!document) return;
  const { width, height } = session.viewport.viewSize;
  const origin = session.viewport.documentRect(document), ppp = session.viewport.pointsPerPixel;
  const guides = session.showsGuides ? [...session.guides] : [];
  const draft = pending.get(session);
  if (draft) guides.push(draft);
  context.lineWidth = 1;
  for (const guide of guides) {
    context.strokeStyle = guide.id === 'pending' ? 'rgba(0, 200, 255, 0.7)' : GUIDE_COLOR;
    context.beginPath();
    if (guide.orientation === 'vertical') { const x = Math.round(origin.x + guide.position * ppp) + 0.5; context.moveTo(x, 0); context.lineTo(x, height); }
    else { const y = Math.round(origin.y + guide.position * ppp) + 0.5; context.moveTo(0, y); context.lineTo(width, y); }
    context.stroke();
  }
  if (!session.showsRulers) return;
  const style = getComputedStyle(context.canvas);
  context.fillStyle = style.getPropertyValue('--cmp-raised').trim() || '#2b2b2b';
  context.fillRect(0, 0, width, RULER);
  context.fillRect(0, 0, RULER, height);
  // Theme colours, so the rulers read in the light theme too.
  context.strokeStyle = style.getPropertyValue('--cmp-border-strong').trim() || 'rgba(255,255,255,0.25)';
  context.fillStyle = style.getPropertyValue('--cmp-text-secondary').trim() || 'rgba(255,255,255,0.7)';
  context.font = `9px ${style.getPropertyValue('--cmp-font').trim() || 'system-ui, sans-serif'}`;
  const step = tickStep(ppp), minor = step / (step % 5 === 0 ? 5 : 2);
  context.beginPath();
  const firstX = Math.floor(-origin.x / ppp / minor) * minor;
  for (let v = firstX; origin.x + v * ppp < width; v += minor) {
    const x = Math.round(origin.x + v * ppp) + 0.5;
    if (x < RULER) continue;
    const major = Math.abs(v % step) < 1e-6;
    context.moveTo(x, RULER); context.lineTo(x, major ? 2 : RULER - 5);
    if (major) context.fillText(String(Math.round(v)), x + 2, 9);
  }
  const firstY = Math.floor(-origin.y / ppp / minor) * minor;
  for (let v = firstY; origin.y + v * ppp < height; v += minor) {
    const y = Math.round(origin.y + v * ppp) + 0.5;
    if (y < RULER) continue;
    const major = Math.abs(v % step) < 1e-6;
    context.moveTo(RULER, y); context.lineTo(major ? 2 : RULER - 5, y);
    if (major) { context.save(); context.translate(9, y + 2); context.rotate(-Math.PI / 2); context.fillText(String(Math.round(v)), 0, 0); context.restore(); }
  }
  context.stroke();
  context.fillStyle = style.getPropertyValue('--cmp-raised').trim() || '#2b2b2b';
  context.fillRect(0, 0, RULER, RULER);
}

function NewGuideDialog({ controller, close }: { controller: EditorController; close: () => void }) {
  const t = controller.t;
  const [orientation, setOrientation] = useState<Guide['orientation']>('horizontal');
  const [position, setPosition] = useState('0');
  const value = Number(position.replace(',', '.'));
  const valid = position.trim() !== '' && Number.isFinite(value);
  const create = () => { if (valid) { controller.session.addGuide(orientation, value); close(); } };
  return (
    <form className={styles.dialog} role="dialog" aria-label={t('New Guide')} data-testid="new-guide-dialog"
      onSubmit={(event) => { event.preventDefault(); create(); }}>
      <h2 className={styles.dialogTitle}>{t('New Guide')}</h2>
      <div className={styles.segmented} role="radiogroup" aria-label={t('Orientation')}>
        {(['horizontal', 'vertical'] as const).map((o) => (
          <button key={o} type="button" role="radio" aria-checked={orientation === o}
            className={`${styles.segment} ${orientation === o ? styles.segmentOn : ''}`} onClick={() => setOrientation(o)}>
            {t(o === 'horizontal' ? 'Horizontal' : 'Vertical')}
          </button>
        ))}
      </div>
      <label className={styles.field}><span>{t('Position')}</span>
        <input autoFocus value={position} data-testid="guide-position" onChange={(event) => setPosition(event.target.value)} inputMode="decimal" style={{ width: 80 }} />
        <span>px</span>
      </label>
      <div className={styles.dialogButtons}>
        <button type="button" className={styles.pill} onClick={close}>{t('Cancel')}</button>
        <button type="submit" className={`${styles.pill} ${styles.pillPrimary}`} disabled={!valid} data-testid="guide-ok">{t('OK')}</button>
      </div>
    </form>
  );
}

export function installGuides(controller: EditorController): void {
  const tool = new GuideTool();
  controller.canvasSetups.push((view) => { view.painters.push((context, session) => paintRulersAndGuides(context, session)); });
  controller.canvasInterceptors.push((session, _modifiers, point) => {
    if (!session.document || !point || session.guidesLocked) return null;
    if (session.showsRulers && (point.y < RULER || point.x < RULER)) {
      // The corner square belongs to neither ruler.
      if (point.x < RULER && point.y < RULER) return null;
      tool.target = { kind: 'create', orientation: point.y < RULER ? 'horizontal' : 'vertical' };
      return tool;
    }
    if (session.showsGuides && session.tool === 'move') {
      const guide = guideAt(session, point, HIT);
      if (guide) { tool.target = { kind: 'move', id: guide.id }; return tool; }
    }
    return null;
  });
  const view = (change: (session: EditorSession) => void) => () => {
    const session = controller.session;
    change(session);
    session.notify('overlay');
    session.notify('ui');
  };
  const f = controller.features;
  f.toggleRulers = { enabled: () => !!controller.session.document, checked: () => controller.session.showsRulers, run: view((s) => { s.showsRulers = !s.showsRulers; }) };
  f.toggleGuides = { enabled: () => !!controller.session.document, checked: () => controller.session.showsGuides, run: view((s) => { s.showsGuides = !s.showsGuides; }) };
  f.lockGuides = { enabled: () => !!controller.session.document, checked: () => controller.session.guidesLocked, run: view((s) => { s.guidesLocked = !s.guidesLocked; }) };
  f.snapToGuides = { enabled: () => !!controller.session.document, checked: () => controller.session.snapsToGuides, run: view((s) => { s.snapsToGuides = !s.snapsToGuides; }) };
  f.clearGuides = { enabled: () => controller.session.guides.length > 0 && !controller.session.guidesLocked, run: () => controller.session.clearGuides() };
  f.newGuide = { enabled: () => !!controller.session.document && !controller.session.guidesLocked, run: () => controller.showDialog({ kind: 'custom', name: 'newGuide' }) };
  controller.dialogs.newGuide = (close) => <NewGuideDialog controller={controller} close={close} />;
  const edges: AlignEdge[] = ['left', 'hcenter', 'right', 'top', 'vcenter', 'bottom'];
  for (const edge of edges) f[`align-${edge}`] = { enabled: () => !!controller.session.document && controller.session.canAlign(), run: () => controller.session.alignLayers(edge) };
  const modes: DistributeMode[] = ['hcenters', 'vcenters', 'hspacing', 'vspacing'];
  for (const mode of modes) f[`distribute-${mode}`] = { enabled: () => !!controller.session.document && controller.session.canDistribute(), run: () => controller.session.distributeLayers(mode) };
}
