/**
 * The Object Selection tool (W / Shift-W with the Magic Wand): click an object, drag a rectangle or a loose lasso
 * around it. The SlimSAM model is fetched only after the explicit "Download model" click (PRODUCT-PLAN E6), then
 * lives in the host's model cache and works offline. Select Subject reuses the bundled U²-Netp subject model.
 */

import { useEffect } from 'react';
import styles from '../../ui/editor.module.css';
import css from './objsel.module.css';
import type { EditorController } from '../../ui/controller';
import { useSession } from '../../ui/hooks';
import type { ToolContext, ToolHandler } from '../../ui/canvas/tools';
import type { EditorSession } from '../../core/session';
import { apply, invert, pixelToDocument, type Point } from '../../core/geometry';
import type { DocumentSelection, SelectionMode } from '../../core/selection';
import { combineSelection, selectionContains } from '../../core/selectionOps';
import { canEditSelection, setSelection } from '../../core/selectionCommands';
import { OBJECT_SELECT_MODELS, resolveObjectSelectModels } from '../../core/objectSelect/models';
import { layerMaskSelection, selectSubjectMask } from '../../core/objectSelect/selection';
import type { ObjectPrompt, ObjectSelectStage, ObjectSelectTiming } from '../../core/objectSelect/types';
import { DEFAULT_BACKGROUND_SETTINGS } from '../../core/subject/maskProcessing';
import { objectSelectInference } from '../../workers/objectSelectClient';
import { modeFor, selectionState } from '../selectionFeature';
import { modelInference } from '../subjectFeature';

const TOTAL_BYTES = OBJECT_SELECT_MODELS.encoder.byteLength + OBJECT_SELECT_MODELS.decoder.byteLength;
const megabytes = (bytes: number) => `${Math.round(bytes / 1_048_576)} MB`;

// MARK: Model (one per editor: every tab shares the downloaded bytes)

interface ModelState {
  phase: 'unknown' | 'checking' | 'absent' | 'downloading' | 'ready' | 'error';
  loaded: number;
  urls: { encoder: string; decoder: string } | null;
  abort: AbortController | null;
  error: string | null;
}
const models = new WeakMap<EditorController, ModelState>();
export function modelState(controller: EditorController): ModelState {
  let state = models.get(controller);
  if (!state) { state = { phase: 'unknown', loaded: 0, urls: null, abort: null, error: null }; models.set(controller, state); }
  return state;
}

function adoptBytes(state: ModelState, encoder: Uint8Array, decoder: Uint8Array): void {
  state.urls = {
    encoder: URL.createObjectURL(new Blob([encoder as BlobPart], { type: 'application/octet-stream' })),
    decoder: URL.createObjectURL(new Blob([decoder as BlobPart], { type: 'application/octet-stream' })),
  };
  state.phase = 'ready';
}

/** Looks in the host's model cache only (no URL, not user-initiated), so nothing goes over the network. */
async function checkCachedModel(controller: EditorController): Promise<void> {
  const state = modelState(controller), host = controller.capabilities.models;
  if (state.phase !== 'unknown') return;
  if (!host) { state.phase = 'absent'; return; }
  state.phase = 'checking';
  try {
    const [encoder, decoder] = await Promise.all((['encoder', 'decoder'] as const).map((part) => host.resolveModel({
      id: OBJECT_SELECT_MODELS[part].id, sha256: OBJECT_SELECT_MODELS[part].sha256, userInitiated: false })));
    if (state.phase !== 'checking') return;
    if (encoder && decoder) adoptBytes(state, encoder.bytes, decoder.bytes); else state.phase = 'absent';
  } catch { if (state.phase === 'checking') state.phase = 'absent'; }
  controller.session.notify('ui');
}

/** The only path that may fetch the model: a direct response to the Download button. */
export async function downloadModel(controller: EditorController): Promise<void> {
  const state = modelState(controller), host = controller.capabilities.models;
  if (!host || state.phase === 'downloading' || state.phase === 'ready') return;
  const abort = state.abort = new AbortController();
  Object.assign(state, { phase: 'downloading', loaded: 0, error: null });
  controller.session.notify('ui');
  try {
    const resolved = await resolveObjectSelectModels(host, ({ part, loaded }) => {
      state.loaded = (part === 'decoder' ? OBJECT_SELECT_MODELS.encoder.byteLength : 0) + loaded;
      controller.session.notify('ui');
    }, abort.signal);
    if (state.abort === abort) adoptBytes(state, resolved.encoder.bytes, resolved.decoder.bytes);
  } catch (error) {
    if (state.abort === abort) {
      const cancelled = abort.signal.aborted || (error instanceof DOMException && error.name === 'AbortError');
      Object.assign(state, cancelled ? { phase: 'absent', error: null } : { phase: 'error', error: error instanceof Error ? error.message : String(error) });
    }
  } finally {
    if (state.abort === abort) state.abort = null;
    controller.session.notify('ui');
  }
}

function cancelDownload(controller: EditorController): void {
  const state = modelState(controller);
  state.abort?.abort();
  state.abort = null;
  Object.assign(state, { phase: 'absent', loaded: 0, error: null });
  controller.session.notify('ui');
}

// MARK: Per-document tool state

type Busy = { stage: ObjectSelectStage | 'subject'; progress: number };
/** The object the last prompts produced: Option-clicks inside it refine it with negative points. */
interface LiveObject {
  prompts: ObjectPrompt[];
  base: DocumentSelection | null;
  mode: SelectionMode;
  shape: DocumentSelection;
  applied: DocumentSelection | null;
}
export interface ObjectToolState {
  kind: 'rectangle' | 'lasso';
  busy: Busy | null;
  abort: AbortController | null;
  error: string | null;
  live: LiveObject | null;
  draft: { kind: 'rectangle' | 'lasso'; points: Point[] } | null;
  timing: ObjectSelectTiming | null;
}
const tools = new WeakMap<EditorSession, ObjectToolState>();
export function objectToolState(session: EditorSession): ObjectToolState {
  let state = tools.get(session);
  if (!state) {
    state = { kind: 'rectangle', busy: null, abort: null, error: null, live: null, draft: null, timing: null };
    tools.set(session, state);
  }
  return state;
}

function pixelLayer(session: EditorSession) {
  const layer = session.activeLayer, raster = layer?.raster;
  return layer && raster && raster.channels === 4 ? { layer, raster } : null;
}

/** Runs the prompts through the worker and combines the object with `base` (the selection when the object began). */
async function runObject(controller: EditorController, session: EditorSession, prompts: ObjectPrompt[], mode: SelectionMode,
  base: DocumentSelection | null): Promise<void> {
  const state = objectToolState(session), model = modelState(controller), t = controller.t;
  if (model.phase !== 'ready' || !model.urls) {
    // While the download runs its progress is on screen already.
    if (model.phase !== 'downloading') { state.error = t('Download the model to select objects.'); session.notify('ui'); }
    return;
  }
  const target = pixelLayer(session), document = session.document;
  if (!target || !document) { state.error = t('Object selection needs a pixel layer.'); session.notify('ui'); return; }
  if (!canEditSelection(session)) return;
  const { layer, raster } = target;
  state.abort?.abort();
  const abort = state.abort = new AbortController();
  state.error = null;
  state.busy = { stage: 'loading-model', progress: 0 };
  session.notify('ui');
  try {
    const placement = session.displayedTransform(layer), toPixels = invert(pixelToDocument(placement, raster.width, raster.height));
    const local = prompts.map((prompt): ObjectPrompt => {
      if (prompt.kind === 'point') { const p = apply(toPixels, prompt); return { ...prompt, x: p.x, y: p.y }; }
      const a = apply(toPixels, { x: prompt.x0, y: prompt.y0 }), b = apply(toPixels, { x: prompt.x1, y: prompt.y1 });
      return { kind: 'box', x0: a.x, y0: a.y, x1: b.x, y1: b.y };
    });
    const result = await objectSelectInference.select(`${layer.id}:${raster.serial}`, raster.toPixels(), raster.width, raster.height,
      local, model.urls, (stage, progress) => { if (state.abort === abort) { state.busy = { stage, progress }; session.notify('ui'); } }, abort.signal);
    state.timing = result.timing;
    const current = session.document;
    if (state.abort !== abort || session.layer(layer.id)?.raster !== raster || !current) return;
    const shape = layerMaskSelection(result.mask, result.width, result.height, placement, current.width, current.height);
    const next = combineSelection(base, shape, mode, current);
    if (setSelection(session, next, 'Object Selection') || session.selection === next) {
      state.live = { prompts, base, mode, shape, applied: session.selection };
    }
  } catch (error) {
    if (!abort.signal.aborted && !(error instanceof DOMException && error.name === 'AbortError')) state.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (state.abort === abort) { state.abort = null; state.busy = null; }
    session.notify('document');
  }
}

/** Select › Subject and the bar's button: the bundled subject model, combined per the bar's mode. */
export async function selectSubject(controller: EditorController, session: EditorSession): Promise<void> {
  const state = objectToolState(session), target = pixelLayer(session), t = controller.t;
  if (!target) { state.error = t('Object selection needs a pixel layer.'); session.notify('ui'); return; }
  if (!canEditSelection(session)) return;
  const { layer, raster } = target, mode = modeFor(selectionState(session), false, false);
  state.abort?.abort();
  const abort = state.abort = new AbortController();
  state.error = null;
  state.busy = { stage: 'subject', progress: 0 };
  session.notify('ui');
  try {
    const result = await modelInference(controller).infer(`${layer.id}:${raster.serial}`, raster.toPixels(), raster.width, raster.height,
      DEFAULT_BACKGROUND_SETTINGS, 1400, 'fast', {}, (p) => { if (state.abort === abort) { state.busy = { stage: 'subject', progress: p.progress }; session.notify('ui'); } },
      abort.signal);
    if (state.abort !== abort || session.layer(layer.id)?.raster !== raster) return;
    selectSubjectMask(session, result.mask, raster.width, raster.height, mode);
    state.live = null;
  } catch (error) {
    if (!abort.signal.aborted && !(error instanceof DOMException && error.name === 'AbortError')) state.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (state.abort === abort) { state.abort = null; state.busy = null; }
    session.notify('document');
  }
}

export function canSelectSubject(controller: EditorController, session: EditorSession): boolean {
  return !!controller.capabilities.models && !!pixelLayer(session) && canEditSelection(session);
}

// MARK: Canvas tool

export class ObjectSelectTool implements ToolHandler {
  private start: { pixel: Point; point: Point; shift: boolean; option: boolean } | null = null;
  private dragging = false;
  constructor(private readonly controller: EditorController) {}

  down(c: ToolContext): void {
    if (!c.session.document || !canEditSelection(c.session)) return;
    this.start = { pixel: c.pixel, point: c.point, shift: c.modifiers.shift, option: c.modifiers.option };
    this.dragging = false;
    objectToolState(c.session).draft = null;
  }

  move(c: ToolContext): void {
    const start = this.start;
    if (!start) return;
    if (!this.dragging && Math.hypot(c.point.x - start.point.x, c.point.y - start.point.y) < 4) return;
    this.dragging = true;
    const state = objectToolState(c.session);
    state.draft = state.kind === 'lasso'
      ? { kind: 'lasso', points: [...(state.draft?.points ?? [start.pixel]), c.pixel] }
      : { kind: 'rectangle', points: [start.pixel, c.pixel] };
  }

  up(c: ToolContext): void {
    const start = this.start, session = c.session, state = objectToolState(session);
    this.start = null;
    const draft = state.draft;
    state.draft = null;
    if (!start || !session.document) return;
    const selection = selectionState(session);
    if (this.dragging && draft) {
      this.dragging = false;
      const xs = draft.points.map((p) => p.x), ys = draft.points.map((p) => p.y);
      const { width, height } = session.document;
      const x0 = Math.max(0, Math.min(...xs)), y0 = Math.max(0, Math.min(...ys));
      const x1 = Math.min(width, Math.max(...xs)), y1 = Math.min(height, Math.max(...ys));
      if (x1 - x0 < 2 || y1 - y0 < 2) { session.notify('document'); return; }
      void runObject(this.controller, session, [{ kind: 'box', x0, y0, x1, y1 }], modeFor(selection, start.shift, start.option), session.selection);
      return;
    }
    const point = start.pixel;
    const live = state.live && state.live.applied === session.selection ? state.live : null;
    if (start.option && live && selectionContains(live.shape, point)) {
      // Option-click inside the object just found: a negative point refines that object.
      void runObject(this.controller, session, [...live.prompts, { kind: 'point', x: point.x, y: point.y, positive: false }], live.mode, live.base);
      return;
    }
    void runObject(this.controller, session, [{ kind: 'point', x: point.x, y: point.y, positive: true }],
      modeFor(selection, start.shift, start.option), session.selection);
  }

  cancel(session: EditorSession): void {
    this.start = null;
    this.dragging = false;
    objectToolState(session).draft = null;
  }

  overlayOnly(): boolean { return true; }

  hover(c: ToolContext): string {
    const mode = modeFor(selectionState(c.session), c.modifiers.shift, c.modifiers.option);
    return mode === 'Add' ? 'copy' : mode === 'Subtract' ? 'alias' : 'crosshair';
  }
}

/** The rectangle or lasso being dragged. */
export function paintObjectDraft(context: CanvasRenderingContext2D, session: EditorSession): void {
  const draft = objectToolState(session).draft, document = session.document;
  if (!draft || !document || draft.points.length < 2) return;
  const view = (p: Point) => session.viewport.viewPoint(p, document);
  const path = new Path2D();
  if (draft.kind === 'rectangle') {
    const a = view(draft.points[0]!), b = view(draft.points[1]!);
    path.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  } else {
    draft.points.forEach((p, i) => { const v = view(p); if (i) path.lineTo(v.x, v.y); else path.moveTo(v.x, v.y); });
  }
  context.strokeStyle = 'rgba(0,0,0,0.8)';
  context.lineWidth = 2;
  context.stroke(path);
  context.setLineDash([4, 3]);
  context.strokeStyle = '#fff';
  context.lineWidth = 1;
  context.stroke(path);
  context.setLineDash([]);
}

// MARK: Header

const STAGE_TEXT: Record<Busy['stage'], string> = {
  'loading-model': 'Loading the model…', encoding: 'Analyzing the image…', decoding: 'Finding the object…',
  refining: 'Refining edges…', subject: 'Finding the subject…',
};

export function ObjectSelectControls({ controller, session }: { controller: EditorController; session: EditorSession }) {
  useSession(session);
  const t = controller.t;
  const model = modelState(controller), state = objectToolState(session);
  useEffect(() => { void checkCachedModel(controller); }, [controller]);
  const disabled = session.isProjectBusy || !session.document;
  return (
    <>
      <div className={styles.segmented} role="radiogroup" aria-label={t('Object mode')} title={t('Object mode')}>
        {(['rectangle', 'lasso'] as const).map((kind) => (
          <button key={kind} type="button" role="radio" aria-checked={state.kind === kind} disabled={disabled}
            className={`${styles.segment} ${state.kind === kind ? styles.segmentOn : ''}`}
            onClick={() => { state.kind = kind; session.notify('ui'); }}>{t(kind === 'rectangle' ? 'Rectangle' : 'Lasso')}</button>
        ))}
      </div>
      {model.phase === 'downloading' ? (
        <>
          <span className={css.download} role="status" data-testid="object-select-download-progress">
            <progress className={css.progress} max={TOTAL_BYTES} value={model.loaded} aria-label={t('Downloading the model…')} />
            <span className={styles.secondary}>{megabytes(model.loaded)} / {megabytes(TOTAL_BYTES)}</span>
          </span>
          <button type="button" className={styles.pill} data-testid="object-select-cancel-download" onClick={() => cancelDownload(controller)}>{t('Cancel')}</button>
        </>
      ) : model.phase !== 'ready' ? (
        <button type="button" className={`${styles.pill} ${styles.pillPrimary}`} data-testid="enable-object-selection"
          disabled={!controller.capabilities.models || model.phase === 'checking' || model.phase === 'unknown'}
          title={t('The object selection model runs on this device. It is downloaded once and then works offline.')}
          onClick={() => void downloadModel(controller)}>{`${t('Download model')} (${megabytes(TOTAL_BYTES)})`}</button>
      ) : null}
      <button type="button" className={styles.pill} data-testid="select-subject" disabled={disabled || !canSelectSubject(controller, session) || !!state.busy}
        onClick={() => void selectSubject(controller, session)}>{t('Select Subject')}</button>
      {state.busy ? (
        <span className={styles.secondary} role="status" data-testid="object-select-status">
          {t(STAGE_TEXT[state.busy.stage])}{state.busy.progress > 0 && state.busy.progress < 1 ? ` ${Math.round(state.busy.progress * 100)} %` : ''}
        </span>
      ) : null}
      {model.phase === 'error' || state.error ? <span className={styles.panelError} role="alert" data-testid="object-select-error">{state.error ?? model.error}</span> : null}
      {state.timing ? (
        <span className={styles.visuallyHidden} data-testid="object-select-timing" data-encoder-ms={Math.round(state.timing.encoderMs)}
          data-decoder-ms={Math.round(state.timing.decoderMs)} data-refinement-ms={Math.round(state.timing.refinementMs)}
          data-backend={state.timing.backend} data-cache-hit={String(state.timing.embeddingCacheHit)} />
      ) : null}
    </>
  );
}
