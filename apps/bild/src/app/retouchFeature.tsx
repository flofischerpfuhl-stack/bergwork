/**
 * Magic Wand, Spot Healing Brush and Content-Aware Fill in the UI (MagicWand.swift, LassoControls'
 * wand options, BrushControls' healing type, the Content-Aware Fill filter panel, EditorCanvas's wand
 * click/drag rules).
 */

import styles from '../ui/editor.module.css';
import type { EditorController } from '../ui/controller';
import { useSession } from '../ui/hooks';
import { NumberField } from '../ui/ContextBar';
import type { EditorSession } from '../core/session';
import type { Point } from '../core/geometry';
import { DEFAULT_WAND_SETTINGS, magicWand, type WandSampleSize, type WandSettings } from '../core/wand';
import {
  addSpotHealingPoints, beginSpotHealing, cancelSpotHealing, currentSpotHealingPreview, finishSpotHealing, getSpotHealingMode,
  setSpotHealingMode, spotHealingState, SPOT_HEALING_MODES, type SpotHealingMode,
} from '../core/heal';
import { getBrushSettings } from '../core/brush';
import {
  applyContentAwareFill, beginContentAwareFill, canContentAwareFill, cancelContentAwareFill, contentFillState,
} from '../core/contentFill';
import { beginSelectionMove, canMoveSelection, endSelectionMove, previewSelectionMove } from '../core/selectionCommands';
import { selectionState } from './selectionFeature';
import type { SelectionMode } from '../core/selection';
import type { ToolContext, ToolHandler } from '../ui/canvas/tools';

const wandSettings = new WeakMap<EditorSession, WandSettings>();
function wand(session: EditorSession): WandSettings { return wandSettings.get(session) ?? DEFAULT_WAND_SETTINGS; }
function setWand(session: EditorSession, patch: Partial<WandSettings>): void { wandSettings.set(session, { ...wand(session), ...patch }); session.notify('ui'); }

const installedPreviews = new WeakSet<EditorSession>();
function ensurePreviews(session: EditorSession): void {
  if (installedPreviews.has(session)) return;
  installedPreviews.add(session);
  session.previewSources.push((s) => {
    const heal = currentSpotHealingPreview(s);
    if (heal) return heal;
    const fill = contentFillState(s);
    return fill?.previewRaster ? { layerId: fill.layerId, mask: false, raster: fill.previewRaster, transform: fill.previewTransform } : null;
  });
}

class WandTool implements ToolHandler {
  private moveStart: Point | null = null;
  private moved = false;
  private pixelMoving = false;
  constructor(private readonly controller: EditorController) {}
  down(c: ToolContext): void {
    const session = c.session, state = selectionState(session);
    if (!session.document || !session.canEditLayers) return;
    const mode: SelectionMode = c.modifiers.option ? 'Subtract' : c.modifiers.shift ? 'Add' : state.modeChoice;
    if (c.modifiers.command && this.controller.pixelMove && canMoveSelection(session, c.pixel)) {
      if (this.controller.pixelMove.begin(session, c.modifiers.option)) { this.moveStart = c.pixel; this.pixelMoving = true; }
      return;
    }
    // Dragging inside the selection in New mode moves the outline; a click there selects afresh.
    if (mode === 'New' && canMoveSelection(session, c.pixel) && beginSelectionMove(session)) {
      this.moveStart = c.pixel;
      this.moved = false;
      return;
    }
    void this.run(session, c.pixel, mode);
  }
  private async run(session: EditorSession, point: Point, mode: SelectionMode): Promise<void> {
    await magicWand(session, point, mode, { ...wand(session), antialias: selectionState(session).antialiased }).catch((error: Error) => {
      this.controller.reportError('wand-failed', error);
    });
    session.notify('document');
  }
  move(c: ToolContext): void {
    if (!this.moveStart) return;
    let dx = c.pixel.x - this.moveStart.x, dy = c.pixel.y - this.moveStart.y;
    if (c.modifiers.shift) { if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0; }
    if (this.pixelMoving) { this.controller.pixelMove?.move(c.session, Math.round(dx), Math.round(dy)); return; }
    if (Math.round(dx) || Math.round(dy)) this.moved = true;
    previewSelectionMove(c.session, Math.round(dx), Math.round(dy));
    c.session.notify('document');
  }
  up(c: ToolContext): void {
    const start = this.moveStart;
    if (!start) return;
    this.moveStart = null;
    if (this.pixelMoving) { this.pixelMoving = false; this.controller.pixelMove?.finish(c.session); return; }
    endSelectionMove(c.session);
    if (!this.moved) void this.run(c.session, start, 'New');
  }
  cancel(session: EditorSession): void {
    if (!this.moveStart) return;
    this.moveStart = null;
    if (this.pixelMoving) { this.pixelMoving = false; this.controller.pixelMove?.cancel(session); return; }
    previewSelectionMove(session, 0, 0);
    endSelectionMove(session);
  }
  hover(c: ToolContext): string {
    const state = selectionState(c.session);
    const mode = c.modifiers.option ? 'Subtract' : c.modifiers.shift ? 'Add' : state.modeChoice;
    if (mode === 'New' && canMoveSelection(c.session, c.pixel)) return 'move';
    return mode === 'Add' ? 'copy' : mode === 'Subtract' ? 'alias' : 'crosshair';
  }
}

class SpotHealingTool implements ToolHandler {
  private active = false;
  down(c: ToolContext): void {
    ensurePreviews(c.session);
    this.active = beginSpotHealing(c.session, c.pixel) !== null;
    c.session.notify('document');
  }
  move(c: ToolContext): void {
    if (!this.active) return;
    addSpotHealingPoints(c.session, c.pixel, c.pressure === null ? undefined : { pressure: c.pressure });
    c.session.notify('document');
  }
  up(c: ToolContext): void {
    if (!this.active) return;
    this.active = false;
    void finishSpotHealing(c.session).then(() => c.session.notify('document'));
  }
  cancel(session: EditorSession): void {
    if (!this.active) return;
    this.active = false;
    cancelSpotHealing(session);
  }
  hover(): string { return 'none'; }
  hydrationBounds(c: ToolContext): import('../core/geometry').Rect {
    const diameter = getBrushSettings(c.session).diameter;
    // BrushStroke.heal searches about three spot widths away (core/heal.ts SpotHealingStroke.heal).
    const radius = diameter / 2 + (diameter + 32) * 3.2;
    return { x: c.pixel.x - radius, y: c.pixel.y - radius, width: radius * 2, height: radius * 2 };
  }
}

function WandControls({ controller, session }: { controller: EditorController; session: EditorSession }) {
  useSession(session);
  const t = controller.t;
  const settings = wand(session);
  const sizes: [WandSampleSize, string][] = [['point', 'Point Sample'], ['threeByThree', '3 by 3 Average'], ['fiveByFive', '5 by 5 Average']];
  return (
    <>
      <span title={t('How far each color channel (0–255) can differ from the clicked color and still be selected')} style={{ display: 'contents' }}>
        <NumberField label={t('Tolerance')} width={44} value={settings.tolerance} onChange={(v) => setWand(session, { tolerance: Math.min(255, Math.max(0, Math.round(v))) })} />
      </span>
      <select className={styles.select} value={settings.sampleSize} aria-label={t('Sample Size')} title={t('Match the clicked pixel, or the average of the pixels around it')}
        onChange={(e) => setWand(session, { sampleSize: e.target.value as WandSampleSize })}>
        {sizes.map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
      </select>
      <div className={styles.segmented} role="radiogroup" aria-label="Sample">
        {([false, true] as const).map((all) => (
          <button key={String(all)} type="button" role="radio" aria-checked={settings.sampleAllLayers === all}
            className={`${styles.segment} ${settings.sampleAllLayers === all ? styles.segmentOn : ''}`}
            onClick={() => setWand(session, { sampleAllLayers: all })}>{t(all ? 'All Layers' : 'This Layer')}</button>
        ))}
      </div>
      <label className={styles.check} title={t('Select only similar pixels connected to the one you click; off selects them everywhere')}>
        <input type="checkbox" checked={settings.contiguous} onChange={(e) => setWand(session, { contiguous: e.target.checked })} />{t('Contiguous')}
      </label>
    </>
  );
}

const MODE_LABELS: Record<SpotHealingMode, string> = { contentAware: 'Content-Aware', createTexture: 'Create Texture', proximityMatch: 'Proximity Match' };

function SpotHealingControls({ controller, session }: { controller: EditorController; session: EditorSession }) {
  useSession(session);
  const t = controller.t;
  const mode = getSpotHealingMode(session);
  return (
    <div className={styles.segmented} role="radiogroup" aria-label={t('Type')} data-testid="spotHealingType">
      {SPOT_HEALING_MODES.map((m) => (
        <button key={m} type="button" role="radio" aria-checked={mode === m} className={`${styles.segment} ${mode === m ? styles.segmentOn : ''}`}
          onClick={() => setSpotHealingMode(session, m)}>{t(MODE_LABELS[m])}</button>
      ))}
    </div>
  );
}

function ContentFillPanel({ controller, close }: { controller: EditorController; close: () => void }) {
  const session = useSession(controller.session);
  const t = controller.t;
  const state = contentFillState(session);
  const phase = state?.phase ?? 'cancelled';
  return (
    <div className={styles.dialog} role="dialog" aria-label={t('Content-Aware Fill…')} data-testid="content-fill-panel"
      style={{ position: 'absolute', right: 16, top: 16, width: 320 }}>
      <h2 className={styles.dialogTitle}>{t('Content-Aware Fill…').replace('…', '')}</h2>
      <p className={styles.dialogMessage}>
        {phase === 'preparing' ? t('Filling the selection…') : phase === 'ready' ? t('Preview shown on the canvas.') : phase === 'error' ? state?.error ?? '' : phase === 'applying' ? t('Applying…') : ''}
      </p>
      <div className={styles.dialogButtons}>
        <button type="button" className={styles.pill} onClick={() => { cancelContentAwareFill(session); session.notify('document'); close(); }}>{t('Cancel')}</button>
        <button type="button" className={`${styles.pill} ${styles.pillPrimary}`} disabled={phase !== 'ready'} data-testid="content-fill-apply"
          onClick={() => void applyContentAwareFill(session).then(() => { session.notify('document'); close(); })}>{t('OK')}</button>
      </div>
    </div>
  );
}

export function installRetouch(controller: EditorController): void {
  controller.availableTools.add('wand');
  controller.availableTools.add('spotHealing');
  controller.canvasSetups.push((view) => {
    view.tools.wand = new WandTool(controller);
    view.tools.spotHealing = new SpotHealingTool();
  });
  controller.wandControls = (session) => <WandControls controller={controller} session={session} />;
  controller.spotHealingControls = (session) => <SpotHealingControls controller={controller} session={session} />;
  const brushBar = controller.contextBars.brush;
  if (brushBar) controller.contextBars.spotHealing = brushBar;
  const t = controller.t;
  controller.statusHints.wand = () => t('Click to select similar colors · Shift add · Option subtract · Drag inside to move · ⌘-drag moves pixels · Delete clears · ⌘D deselect');
  controller.statusHints.spotHealing = () => t('Drag over blemishes to heal · [ ] size · Shift-[ ] hardness · Escape cancel · Space to pan');
  controller.dialogs.contentFill = (close) => <ContentFillPanel controller={controller} close={close} />;
  controller.features.contentAwareFill = {
    enabled: () => canContentAwareFill(controller.session),
    run: () => {
      const session = controller.session;
      ensurePreviews(session);
      if (beginContentAwareFill(session)) controller.showDialog({ kind: 'custom', name: 'contentFill' });
    },
  };
  controller.keyHandlers.push((event) => {
    const session = controller.session;
    if (event.key === 'Escape' && spotHealingState(session)?.active) { cancelSpotHealing(session); return true; }
    if (event.key === 'Escape' && contentFillState(session)) { cancelContentAwareFill(session); controller.showDialog(null); return true; }
    return false;
  });
}
