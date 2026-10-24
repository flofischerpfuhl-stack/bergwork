/**
 * Select › Refine Edge…: the one workspace that replaces Photoshop's Select and Mask (PRODUCT-PLAN 6.2). A floating
 * panel over the canvas previews the refined selection live (worker), in five views drawn on the canvas; the Refine
 * Edge brush marks hair and fur for recomputation. OK commits one undo step to the chosen output; Cancel leaves the
 * document untouched.
 */

import type { ReactNode } from 'react';
import styles from '../../ui/editor.module.css';
import css from './objsel.module.css';
import type { EditorController } from '../../ui/controller';
import { useSession } from '../../ui/hooks';
import type { ToolContext, ToolHandler } from '../../ui/canvas/tools';
import type { EditorSession } from '../../core/session';
import type { Point } from '../../core/geometry';
import { applyRefineEdgeResult, type RefineEdgeOutput } from '../../core/refine/commands';
import { decontaminateColours, DEFAULT_REFINE_EDGE_SETTINGS, type RefineEdgeResult, type RefineEdgeSettings } from '../../core/refine/engine';
import { selectionMaskOnCanvas } from '../../core/refine/quickMask';
import { refineEdgeWorker } from '../../workers/refineClient';
import { Check, FloatingPanel, SliderRow } from '../adjustmentsFeature';
import { documentMaskToLayer, DocumentOverlay, drawBrushOutline, drawChecker, stampSegment, type DocRect } from './overlay';
import { panelTranslator } from './strings';

export type RefineView = 'overlay' | 'onBlack' | 'onWhite' | 'blackWhite' | 'onLayers';
const VIEWS: readonly [RefineView, string][] = [
  ['overlay', 'Overlay'], ['onBlack', 'On Black'], ['onWhite', 'On White'], ['blackWhite', 'Black & White'], ['onLayers', 'On Layers'],
];
const OUTPUTS: readonly [RefineEdgeOutput, string][] = [
  ['selection', 'Selection'], ['layerMask', 'Layer Mask'], ['newLayer', 'New Layer'], ['newLayerWithMask', 'New Layer with Layer Mask'],
];

interface Controls {
  radius: number; smartRadius: boolean; smooth: number; feather: number; contrast: number; shiftEdge: number;
  decontaminate: boolean; amount: number;
}

export interface RefineState {
  phase: 'preparing' | 'refining' | 'ready' | 'applying' | 'error';
  error: string | null;
  controls: Controls;
  view: RefineView;
  output: RefineEdgeOutput;
  brush: boolean;
  brushSize: number;
  width: number;
  height: number;
  rgba: Uint8Array | null;
  input: Uint8Array | null;
  hair: Uint8Array | null;
  result: RefineEdgeResult | null;
  stale: boolean;
  generation: number;
  abort: AbortController | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** The composite without the active layer, for On Layers. */
  below: Uint8Array | null;
  belowRequested: boolean;
  overlay: DocumentOverlay | null;
  overlayOf: { result: RefineEdgeResult; view: RefineView; below: Uint8Array | null } | null;
  /** The brush stroke being painted, shown until the stroke ends. */
  stroke: { coverage: Uint8Array; overlay: DocumentOverlay; erase: boolean; last: Point } | null;
}

const states = new WeakMap<EditorSession, RefineState>();
export function refineState(session: EditorSession): RefineState | null { return states.get(session) ?? null; }

/**
 * The panel's settings carry over between uses (per page load), as Photoshop remembers them. The first use starts
 * as Photoshop does, with Radius 0 and Smart Radius off, so the preview first shows the selection unchanged.
 */
let remembered: { controls: Controls; view: RefineView; output: RefineEdgeOutput; brushSize: number } = {
  controls: { radius: 0, smartRadius: false, smooth: 0, feather: 0, contrast: 0, shiftEdge: 0, decontaminate: false, amount: 100 },
  view: 'overlay', output: 'selection', brushSize: 40,
};

export function refineBlocksEditing(session: EditorSession): boolean {
  const state = states.get(session);
  return !!state && state.phase !== 'applying';
}

function hasPixelLayer(session: EditorSession): boolean {
  const raster = session.activeLayer?.raster;
  return !!raster && raster.channels === 4;
}

/** Decontamination writes new pixels, so it always goes to a new layer (Photoshop does the same). */
function effectiveOutput(state: RefineState): RefineEdgeOutput {
  if (state.controls.decontaminate && (state.output === 'selection' || state.output === 'layerMask')) return 'newLayerWithMask';
  return state.output;
}

export async function openRefineEdge(controller: EditorController): Promise<void> {
  const session = controller.session, document = session.document, selection = session.selection;
  if (!document || !selection || !session.services?.flatten || states.has(session)) return;
  const state: RefineState = {
    phase: 'preparing', error: null, controls: { ...remembered.controls }, view: remembered.view, output: remembered.output,
    brush: false, brushSize: remembered.brushSize, width: document.width, height: document.height, rgba: null, input: null, hair: null,
    result: null, stale: true, generation: 0, abort: null, timer: null, below: null, belowRequested: false, overlay: null, overlayOf: null,
    stroke: null,
  };
  if (state.output !== 'selection' && !hasPixelLayer(session)) state.output = 'selection';
  states.set(session, state);
  session.notify('document');
  try {
    const image = await session.services.flatten({ ...document, selection: null });
    if (states.get(session) !== state) return;
    state.rgba = image.toPixels();
    state.input = selectionMaskOnCanvas(selection, document.width, document.height);
    await compute(controller, session, state);
  } catch (error) {
    if (states.get(session) !== state) return;
    state.phase = 'error';
    state.error = error instanceof Error ? error.message : String(error);
    session.notify('ui');
  }
}

function engineSettings(state: RefineState): Partial<RefineEdgeSettings> {
  const c = state.controls;
  return {
    // Painted hair needs a matting radius even while the global Radius is 0; the engine's default then applies there only.
    radius: c.radius > 0 || !state.hair ? c.radius : DEFAULT_REFINE_EDGE_SETTINGS.radius, smartRadius: c.smartRadius, smooth: c.smooth, feather: c.feather, contrast: c.contrast, shiftEdge: c.shiftEdge,
    decontaminate: c.decontaminate ? c.amount : 0, hairRegion: state.hair,
  };
}

/** Refines in the worker; a newer request supersedes an older one. */
async function compute(controller: EditorController, session: EditorSession, state: RefineState): Promise<void> {
  if (!state.rgba || !state.input) return;
  const generation = ++state.generation;
  state.abort?.abort();
  const abort = state.abort = new AbortController();
  if (state.phase !== 'applying') state.phase = 'refining';
  session.notify('ui');
  try {
    const result = await refineEdgeWorker.refine(state.rgba.slice(), state.width, state.height, state.input.slice(), engineSettings(state), abort.signal);
    if (states.get(session) !== state || state.generation !== generation) return;
    state.result = result;
    state.stale = false;
    if (state.phase !== 'applying') state.phase = 'ready';
    controller.canvasView?.redraw();
    session.notify('ui');
  } catch (error) {
    if (states.get(session) !== state || state.generation !== generation || abort.signal.aborted) return;
    state.phase = 'error';
    state.error = error instanceof Error ? error.message : String(error);
    session.notify('ui');
  }
}

/** Slider drags coalesce: only the last change in 120 ms is refined. */
function schedule(controller: EditorController, session: EditorSession, state: RefineState, delay = 120): void {
  state.stale = true;
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => { state.timer = null; void compute(controller, session, state); }, delay);
  session.notify('ui');
}

function change(controller: EditorController, session: EditorSession, next: Partial<Controls>): void {
  const state = states.get(session);
  if (!state || state.phase === 'applying') return;
  state.controls = { ...state.controls, ...next };
  remembered = { ...remembered, controls: state.controls };
  schedule(controller, session, state);
}

function close(session: EditorSession): void {
  const state = states.get(session);
  if (!state) return;
  state.abort?.abort();
  if (state.timer) clearTimeout(state.timer);
  states.delete(session);
  session.notify('document');
}

export function cancelRefineEdge(session: EditorSession): void { close(session); }

export async function commitRefineEdge(controller: EditorController, session: EditorSession): Promise<boolean> {
  const state = states.get(session);
  if (!state || state.phase === 'applying' || state.phase === 'preparing' || !state.rgba) return false;
  state.phase = 'applying';
  session.notify('ui');
  if (state.timer) { clearTimeout(state.timer); state.timer = null; }
  if (state.stale || !state.result) await compute(controller, session, state);
  const result = state.result;
  if (states.get(session) !== state || !result || state.stale) { if (states.get(session) === state) state.phase = 'error'; session.notify('ui'); return false; }
  const output = effectiveOutput(state);
  let applied = false;
  try {
    if (output === 'selection') applied = applyRefineEdgeResult(session, { ...result, decontaminatedRgba: null }, 'selection');
    else {
      const layer = session.activeLayer, raster = layer?.raster;
      if (layer && raster && raster.channels === 4) {
        const mask = documentMaskToLayer(result.mask, state.width, state.height, session.displayedTransform(layer), raster.width, raster.height);
        const pixels = state.controls.decontaminate && output !== 'layerMask'
          ? decontaminateColours(raster.toPixels(), mask, raster.width, raster.height, state.controls.amount / 100) : null;
        applied = applyRefineEdgeResult(session, { mask, width: raster.width, height: raster.height, decontaminatedRgba: pixels }, output);
      }
    }
  } catch (error) {
    controller.reportError('refine-edge-failed', error);
  }
  close(session);
  controller.canvasView?.redraw();
  return applied;
}

// MARK: Canvas preview

async function requestBelow(controller: EditorController, session: EditorSession, state: RefineState): Promise<void> {
  const document = session.document, flatten = session.services?.flatten;
  if (state.belowRequested || !document || !flatten) return;
  state.belowRequested = true;
  const active = session.activeLayerId;
  try {
    const image = await flatten({ ...document, selection: null, layers: document.layers.map((layer) => (layer.id === active ? { ...layer, visible: false } : layer)) });
    if (states.get(session) !== state) return;
    state.below = image.toPixels();
    controller.canvasView?.redraw();
  } catch { /* On Layers falls back to transparency */ }
}

function rebuildOverlay(state: RefineState): DocumentOverlay | null {
  const result = state.result, rgba = state.rgba;
  if (!result || !rgba) return null;
  const view = state.view, below = view === 'onLayers' ? state.below : null;
  if (state.overlay && state.overlayOf?.result === result && state.overlayOf.view === view && state.overlayOf.below === below) return state.overlay;
  const overlay = state.overlay && state.overlay.docWidth === state.width && state.overlay.docHeight === state.height
    ? state.overlay : new DocumentOverlay(state.width, state.height);
  const mask = result.mask, colour = result.decontaminatedRgba ?? rgba;
  if (view === 'overlay') {
    // Photoshop's default overlay: 50 % red over what is not selected.
    overlay.update((out, o, i) => { out[o] = 255; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = Math.round((255 - mask[i]!) / 2); });
  } else if (view === 'blackWhite') {
    overlay.update((out, o, i) => { const m = mask[i]!; out[o] = m; out[o + 1] = m; out[o + 2] = m; out[o + 3] = 255; });
  } else if (view === 'onBlack' || view === 'onWhite') {
    const back = view === 'onWhite' ? 255 : 0;
    overlay.update((out, o, i) => {
      const p = i * 4, k = mask[i]! * rgba[p + 3]! / 65025;
      out[o] = colour[p]! * k + back * (1 - k); out[o + 1] = colour[p + 1]! * k + back * (1 - k); out[o + 2] = colour[p + 2]! * k + back * (1 - k);
      out[o + 3] = 255;
    });
  } else {
    overlay.update((out, o, i) => {
      const p = i * 4, fa = mask[i]! * rgba[p + 3]! / 65025, ba = below ? below[p + 3]! / 255 * (1 - fa) : 0, a = fa + ba;
      if (a <= 0) { out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 0; return; }
      for (let c = 0; c < 3; c++) out[o + c] = (colour[p + c]! * fa + (below ? below[p + c]! * ba : 0)) / a;
      out[o + 3] = a * 255;
    });
  }
  state.overlay = overlay;
  state.overlayOf = { result, view, below };
  return overlay;
}

export function paintRefineEdge(controller: EditorController, context: CanvasRenderingContext2D, session: EditorSession, hover: Point | null): void {
  const state = states.get(session);
  if (!state || state.phase === 'applying') return;
  if (state.view === 'onLayers' && !state.belowRequested) void requestBelow(controller, session, state);
  const overlay = rebuildOverlay(state);
  if (overlay) {
    if (state.view === 'onLayers') drawChecker(context, session);
    overlay.draw(context, session);
  }
  if (state.stroke) {
    context.globalAlpha = 0.45;
    state.stroke.overlay.draw(context, session);
    context.globalAlpha = 1;
  }
  if (state.brush) drawBrushOutline(context, session, hover, state.brushSize);
}

// MARK: Refine Edge brush

/** Paints the hair/fur region: those pixels get their alpha recomputed from the image (Option-drag erases). */
export class RefineBrushTool implements ToolHandler {
  constructor(private readonly controller: EditorController) {}
  down(c: ToolContext): void {
    const state = states.get(c.session);
    if (!state?.brush || state.phase === 'applying' || state.phase === 'preparing') return;
    state.hair ??= new Uint8Array(state.width * state.height);
    const stroke = { coverage: new Uint8Array(state.width * state.height), overlay: new DocumentOverlay(state.width, state.height),
      erase: c.modifiers.option, last: c.pixel };
    state.stroke = stroke;
    this.paint(state, c.pixel);
  }
  move(c: ToolContext): void {
    const state = states.get(c.session);
    if (state?.stroke) this.paint(state, c.pixel);
  }
  up(c: ToolContext): void {
    const state = states.get(c.session);
    if (!state?.stroke) return;
    state.stroke = null;
    state.overlay = null;
    state.overlayOf = null;
    schedule(this.controller, c.session, state, 0);
  }
  cancel(session: EditorSession): void { const state = states.get(session); if (state) state.stroke = null; }
  overlayOnly(): boolean { return true; }
  hover(): string { return 'none'; }

  private paint(state: RefineState, point: Point): void {
    const stroke = state.stroke!, hair = state.hair!;
    const rect = stampSegment(stroke.coverage, state.width, state.height, stroke.last, point, state.brushSize, 0.6, 1);
    stroke.last = point;
    if (!rect) return;
    const { coverage, erase } = stroke, w = state.width;
    for (let y = rect.y; y < rect.y + rect.height; y++) {
      for (let x = rect.x; x < rect.x + rect.width; x++) {
        const i = y * w + x, v = coverage[i]!;
        if (!v) continue;
        hair[i] = erase ? Math.min(hair[i]!, 255 - v) : Math.max(hair[i]!, v);
      }
    }
    const tint = erase ? [255, 80, 80] : [0, 200, 255];
    stroke.overlay.update((out, o, i) => { out[o] = tint[0]!; out[o + 1] = tint[1]!; out[o + 2] = tint[2]!; out[o + 3] = coverage[i]!; }, rect as DocRect);
  }
}


// MARK: Panel

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={css.section}>
      <h3 className={css.sectionTitle}>{title}</h3>
      {children}
    </section>
  );
}

export function RefineEdgePanel({ controller }: { controller: EditorController }) {
  const session = useSession(controller.session);
  const state = states.get(session);
  if (!state) return null;
  const t = panelTranslator(controller);
  const c = state.controls, busy = state.phase === 'applying';
  const layerOutputs = hasPixelLayer(session);
  const output = effectiveOutput(state);
  const set = (next: Partial<Controls>) => change(controller, session, next);
  const status = state.phase === 'preparing' || state.phase === 'refining' || state.stale ? t('Updating the preview…') : busy ? t('Applying…') : null;
  const labelWidth = 118;
  return (
    <FloatingPanel name="refineEdge" title={t('Refine Edge')} onClose={() => cancelRefineEdge(session)} closeLabel={t('Cancel')}
      testId="refine-edge-panel" className={css.refinePanel}>
      <fieldset className={styles.panelBody} disabled={busy} onKeyDown={(event) => {
        if (event.key === 'Escape') { cancelRefineEdge(session); event.preventDefault(); }
        else if (event.key === 'Enter' && !(event.target as Element).closest('input, select, textarea')) { void commitRefineEdge(controller, session); event.preventDefault(); }
      }}>
        <div className={styles.panelRow}>
          <span className={styles.panelLabel} style={{ width: labelWidth }}>{t('View')}</span>
          <select className={styles.select} value={state.view} aria-label={t('View')} data-testid="refine-edge-view"
            onChange={(event) => { state.view = event.target.value as RefineView; remembered = { ...remembered, view: state.view }; session.notify('ui'); controller.canvasView?.redraw(); }}>
            {VIEWS.map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
          </select>
        </div>
        <div className={styles.panelRow}>
          <button type="button" className={`${styles.pill} ${state.brush ? styles.pillOn : ''}`} aria-pressed={state.brush} data-testid="refine-edge-brush"
            onClick={() => { state.brush = !state.brush; session.notify('ui'); controller.canvasView?.redraw(); }}>{t('Refine Edge Brush')}</button>
        </div>
        {state.brush ? (
          <>
            <SliderRow label={t('Size')} value={state.brushSize} min={1} max={500} logarithmic suffix="px" labelWidth={labelWidth} testId="refine-edge-brush-size"
              onChange={(brushSize) => { state.brushSize = brushSize; remembered = { ...remembered, brushSize }; session.notify('ui'); }} />
            <p className={styles.panelNote}>{t('Paint over hair and fur to recompute their edge · Option-drag erases · [ ] size')}</p>
          </>
        ) : null}
        <Section title={t('Edge Detection')}>
          <Check label={t('Smart Radius')} checked={c.smartRadius} testId="refine-edge-smart-radius" onChange={(smartRadius) => set({ smartRadius })} />
          <SliderRow label={t('Radius')} value={c.radius} min={0} max={250} suffix="px" labelWidth={labelWidth} testId="refine-edge-radius" onChange={(radius) => set({ radius })} />
        </Section>
        <Section title={t('Global Refinements')}>
          <SliderRow label={t('Smooth')} value={c.smooth} min={0} max={100} labelWidth={labelWidth} testId="refine-edge-smooth" onChange={(smooth) => set({ smooth })} />
          <SliderRow label={t('Feather')} value={c.feather} min={0} max={250} decimals={1} suffix="px" labelWidth={labelWidth} testId="refine-edge-feather" onChange={(feather) => set({ feather })} />
          <SliderRow label={t('Contrast')} value={c.contrast} min={0} max={100} suffix="%" labelWidth={labelWidth} testId="refine-edge-contrast" onChange={(contrast) => set({ contrast })} />
          <SliderRow label={t('Shift Edge')} value={c.shiftEdge} min={-100} max={100} suffix="px" labelWidth={labelWidth} testId="refine-edge-shift" onChange={(shiftEdge) => set({ shiftEdge })} />
        </Section>
        <Section title={t('Output Settings')}>
          <Check label={t('Decontaminate Colors')} checked={c.decontaminate} testId="refine-edge-decontaminate" onChange={(decontaminate) => set({ decontaminate })} />
          {c.decontaminate ? (
            <SliderRow label={t('Amount')} value={c.amount} min={0} max={100} suffix="%" labelWidth={labelWidth} testId="refine-edge-amount" onChange={(amount) => set({ amount })} />
          ) : null}
          <div className={styles.panelRow}>
            <span className={styles.panelLabel} style={{ width: labelWidth }}>{t('Output To')}</span>
            <select className={styles.select} value={output} aria-label={t('Output To')} data-testid="refine-edge-output"
              onChange={(event) => { state.output = event.target.value as RefineEdgeOutput; remembered = { ...remembered, output: state.output }; session.notify('ui'); }}>
              {OUTPUTS.map(([value, label]) => (
                <option key={value} value={value} disabled={value === 'selection' || value === 'layerMask' ? c.decontaminate || (value === 'layerMask' && !layerOutputs) : !layerOutputs}>{t(label)}</option>
              ))}
            </select>
          </div>
          {c.decontaminate ? <p className={styles.panelNote}>{t('Decontaminating colors needs a new layer.')}</p> : null}
        </Section>
        {state.error ? <p className={styles.panelError}>{state.error}</p> : null}
      </fieldset>
      <div className={styles.dialogButtons}>
        <button type="button" className={styles.pill} disabled={busy} onClick={() => cancelRefineEdge(session)} data-testid="refine-edge-cancel">{t('Cancel')}</button>
        {status ? <span className={styles.panelNote} role="status" data-testid="refine-edge-status">{status}</span> : null}
        <button type="button" className={`${styles.pill} ${styles.pillPrimary}`} disabled={busy || state.phase === 'preparing' || state.phase === 'error'}
          data-testid="refine-edge-ok" onClick={() => void commitRefineEdge(controller, session)}>{t('OK')}</button>
      </div>
    </FloatingPanel>
  );
}
