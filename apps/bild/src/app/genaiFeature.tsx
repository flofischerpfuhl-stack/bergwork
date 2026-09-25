/** Local Remove and Upscale UI (PRODUCT-PLAN 6.3/6.4, A6 and E6). Model resolution is cache-only until a click. */
import { useEffect, useState } from 'react';
import styles from '../ui/editor.module.css';
import type { EditorController } from '../ui/controller';
import { useSession } from '../ui/hooks';
import type { EditorSession } from '../core/session';
import { Raster } from '../core/raster';
import {
  applyContentAwareFill, beginContentAwareFill, canContentAwareFill, cancelContentAwareFill, contentFillState,
} from '../core/contentFill';
import { cachedGenAiModel, downloadGenAiModel, GENAI_MODELS, type GenAiModelId } from '../core/genai/models';
import { genAiInference } from '../workers/genAiClient';
import type { GenAiStage } from '../workers/genAiProtocol';
import { profileHasFeature } from './profiles';

type ModelPhase = 'unknown' | 'checking' | 'absent' | 'downloading' | 'ready' | 'error';
interface ModelState {
  phase: ModelPhase;
  loaded: number;
  url: string | null;
  abort: AbortController | null;
  error: string | null;
}

const modelStores = new WeakMap<EditorController, Map<GenAiModelId, ModelState>>();
function modelState(controller: EditorController, id: GenAiModelId): ModelState {
  let store = modelStores.get(controller);
  if (!store) { store = new Map(); modelStores.set(controller, store); }
  let state = store.get(id);
  if (!state) { state = { phase: 'unknown', loaded: 0, url: null, abort: null, error: null }; store.set(id, state); }
  return state;
}

function adopt(state: ModelState, bytes: Uint8Array): void {
  if (state.url) URL.revokeObjectURL(state.url);
  state.url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/octet-stream' }));
  state.phase = 'ready'; state.error = null;
}

/** Public for unit tests: this path cannot fetch because the request has no URL and is not user initiated. */
export async function checkCachedGenAiModel(controller: EditorController, id: GenAiModelId): Promise<void> {
  const state = modelState(controller, id), host = controller.capabilities.models;
  if (state.phase !== 'unknown') return;
  if (!host) { state.phase = 'absent'; return; }
  state.phase = 'checking';
  try {
    const value = await cachedGenAiModel(host, id);
    if (state.phase === 'checking') { if (value) adopt(state, value.bytes); else state.phase = 'absent'; }
  } catch { if (state.phase === 'checking') state.phase = 'absent'; }
  controller.session.notify('ui');
}

/** Public for unit tests: the only path with userInitiated=true and a remote URL. */
export async function requestGenAiModel(controller: EditorController, id: GenAiModelId): Promise<boolean> {
  const state = modelState(controller, id), host = controller.capabilities.models;
  if (!host || state.phase === 'downloading') return false;
  if (state.phase === 'ready') return true;
  const abort = state.abort = new AbortController();
  Object.assign(state, { phase: 'downloading', loaded: 0, error: null }); controller.session.notify('ui');
  try {
    const value = await downloadGenAiModel(host, id, (loaded) => { if (state.abort === abort) { state.loaded = loaded; controller.session.notify('ui'); } }, abort.signal);
    if (state.abort !== abort) return false;
    adopt(state, value.bytes); return true;
  } catch (error) {
    if (state.abort === abort) {
      const cancelled = abort.signal.aborted || (error instanceof DOMException && error.name === 'AbortError');
      Object.assign(state, cancelled ? { phase: 'absent', error: null } : {
        phase: 'error', error: error instanceof Error ? error.message : String(error),
      });
    }
    return false;
  } finally {
    if (state.abort === abort) state.abort = null;
    controller.session.notify('ui');
  }
}

function cancelModel(controller: EditorController, id: GenAiModelId): void {
  const state = modelState(controller, id);
  state.abort?.abort(); state.abort = null; state.phase = 'absent'; state.loaded = 0; state.error = null;
  controller.session.notify('ui');
}

interface RemoveState { ai: boolean; stage: GenAiStage | null; progress: number; backend: 'webgpu' | 'wasm' | null; inferenceMs: number | null }
const removals = new WeakMap<EditorSession, RemoveState>();
function removeState(session: EditorSession): RemoveState {
  let state = removals.get(session);
  if (!state) { state = { ai: false, stage: null, progress: 0, backend: null, inferenceMs: null }; removals.set(session, state); }
  return state;
}

function beginRemove(controller: EditorController, ai: boolean): boolean {
  const session = controller.session, state = removeState(session), model = modelState(controller, 'migan-512');
  if (session.document && session.document.width * session.document.height > 12_000_000 && ai) {
    controller.alert(controller.t('Remove'), controller.t('AI Remove supports images up to 12 megapixels. Use the local fallback for this image.'));
    return false;
  }
  state.ai = ai; state.stage = ai ? 'loading-model' : null; state.progress = 0; state.backend = null; state.inferenceMs = null;
  const inference = ai && model.url ? genAiInference.contentFill(model.url, (stage, progress, backend) => {
    Object.assign(state, { stage, progress, backend }); session.notify('ui');
  }, (result) => { state.backend = result.backend; state.inferenceMs = result.inferenceMs; }) : undefined;
  return !!beginContentAwareFill(session, { inference });
}

function RemovePanel({ controller, close }: { controller: EditorController; close: () => void }) {
  const session = useSession(controller.session), state = removeState(session), model = modelState(controller, 'migan-512');
  const fill = contentFillState(session), phase = fill?.phase ?? 'cancelled', t = controller.t;
  useEffect(() => {
    void checkCachedGenAiModel(controller, 'migan-512').then(() => {
      const current = modelState(controller, 'migan-512');
      if (current.phase === 'ready' && !state.ai && contentFillState(session)) {
        cancelContentAwareFill(session); beginRemove(controller, true);
      }
    });
  }, [controller, session, state]);
  const cancel = () => { cancelContentAwareFill(session); model.abort?.abort(); session.notify('document'); close(); };
  const download = async () => {
    cancelContentAwareFill(session);
    if (await requestGenAiModel(controller, 'migan-512')) beginRemove(controller, true);
  };
  const status = phase === 'preparing' ? (state.ai ? stageText(t, state.stage, state.progress) : t('Filling the selection locally…'))
    : phase === 'ready' ? t('Preview shown on the canvas.') : phase === 'error' ? fill?.error ?? '' : phase === 'applying' ? t('Applying…') : '';
  return (
    <div className={styles.dialog} role="dialog" aria-modal aria-label={t('Remove…')} data-testid="remove-panel">
      <h2 className={styles.dialogTitle}>{t('Remove')}</h2>
      <p className={styles.dialogMessage}>{status}</p>
      <p className={styles.secondary}>{state.ai ? t('MI-GAN runs on this device. The result is placed on a new layer.')
        : t('Using the built-in content-aware fallback. Download MI-GAN for local AI removal.')}</p>
      {model.phase === 'downloading' ? <ModelProgress controller={controller} id="migan-512" testId="remove-model-progress" />
        : model.phase !== 'ready' ? <button type="button" className={styles.pill} data-testid="download-remove-model"
          disabled={!controller.capabilities.models || model.phase === 'checking'} onClick={() => void download()}>
          {`${t('Download AI model')} (${megabytes(GENAI_MODELS['migan-512'].byteLength)})`}</button> : null}
      {model.error ? <span className={styles.panelError} role="alert">{model.error}</span> : null}
      <div className={styles.dialogButtons}>
        <button type="button" className={styles.pill} onClick={cancel}>{t('Cancel')}</button>
        <button type="button" className={`${styles.pill} ${styles.pillPrimary}`} disabled={phase !== 'ready'} data-testid="remove-apply"
          onClick={() => void applyContentAwareFill(session, { newLayer: true }).then((done) => { if (done) close(); session.notify('document'); })}>{t('Apply')}</button>
      </div>
    </div>
  );
}

interface UpscaleState {
  phase: 'idle' | 'running' | 'error'; stage: GenAiStage | null; progress: number; backend: 'webgpu' | 'wasm' | null;
  abort: AbortController | null; error: string | null; inferenceMs: number | null;
}
const upscales = new WeakMap<EditorSession, UpscaleState>();
function upscaleState(session: EditorSession): UpscaleState {
  let state = upscales.get(session);
  if (!state) { state = { phase: 'idle', stage: null, progress: 0, backend: null, abort: null, error: null, inferenceMs: null }; upscales.set(session, state); }
  return state;
}

function UpscalePanel({ controller, close }: { controller: EditorController; close: () => void }) {
  const session = useSession(controller.session), state = upscaleState(session), t = controller.t;
  const [scale, setScale] = useState<2 | 4>(2), [strength, setStrength] = useState(75);
  const id: GenAiModelId = scale === 2 ? 'realesrgan-x2plus' : 'realesrgan-x4plus', model = modelState(controller, id);
  const layer = session.activeLayer, raster = layer?.raster, outputPixels = raster ? raster.width * scale * raster.height * scale : 0;
  const valid = !!raster && raster.channels === 4 && raster.width * raster.height <= 12_000_000
    && outputPixels <= controller.limits.maxPixels && raster.width * scale <= controller.limits.maxSide && raster.height * scale <= controller.limits.maxSide;
  useEffect(() => { void checkCachedGenAiModel(controller, id); }, [controller, id]);
  const cancel = () => { state.abort?.abort(); if (model.phase === 'downloading') cancelModel(controller, id); close(); };
  const run = async () => {
    const source = session.activeLayer, sourceRaster = source?.raster;
    if (!valid || !source || !sourceRaster) return;
    if (model.phase !== 'ready' && !(await requestGenAiModel(controller, id))) return;
    const ready = modelState(controller, id); if (!ready.url) return;
    const abort = state.abort = new AbortController();
    Object.assign(state, { phase: 'running', stage: 'loading-model', progress: 0, backend: null, error: null, inferenceMs: null });
    session.isProjectBusy = true; session.notify('ui');
    try {
      const result = await genAiInference.upscale(ready.url, sourceRaster.toPixels(), sourceRaster.width, sourceRaster.height,
        scale, strength / 100, (stage, progress, backend) => {
          if (state.abort === abort) { Object.assign(state, { stage, progress, backend }); session.notify('ui'); }
        }, abort.signal);
      state.inferenceMs = result.inferenceMs; state.backend = result.backend;
      if (state.abort !== abort || session.layer(source.id)?.raster !== sourceRaster) return;
      const pixels = sourceRaster.format === 'rgba16' ? Uint16Array.from(result.rgba, (value) => value * 257) : result.rgba;
      session.replaceLayerPixels(source.id, Raster.fromPixels(result.width, result.height, 4, pixels,
        { format: sourceRaster.format }), `AI Upscale ${scale}×`, source.transform);
      close();
    } catch (error) {
      if (!abort.signal.aborted) { state.phase = 'error'; state.error = error instanceof Error ? error.message : String(error); }
    } finally {
      if (state.abort === abort) state.abort = null;
      if (state.phase === 'running') state.phase = 'idle';
      session.isProjectBusy = false; session.notify('document');
    }
  };
  return (
    <div className={styles.dialog} role="dialog" aria-modal aria-label={t('Upscale…')} data-testid="upscale-panel">
      <h2 className={styles.dialogTitle}>{t('Upscale')}</h2>
      <div className={styles.segmented} role="radiogroup" aria-label={t('Scale')}>
        {([2, 4] as const).map((value) => <button key={value} type="button" role="radio" aria-checked={scale === value}
          className={`${styles.segment} ${scale === value ? styles.segmentOn : ''}`} disabled={state.phase === 'running'}
          onClick={() => setScale(value)}>{value}×</button>)}
      </div>
      <label className={styles.field}><span>{t('Denoise strength')}</span><input type="range" min="0" max="100" value={strength}
        data-testid="upscale-strength" disabled={state.phase === 'running'} onChange={(event) => setStrength(Number(event.target.value))} /><span>{strength}%</span></label>
      <p className={valid ? styles.secondary : styles.warning}>{raster
        ? valid ? `${raster.width} × ${raster.height} → ${raster.width * scale} × ${raster.height * scale}. ${t('The layer keeps its placed size and gains pixel detail.')}`
          : t('AI Upscale accepts RGBA layers up to 12 megapixels within the document limits.') : t('Select a pixel layer first.')}</p>
      {model.phase === 'downloading' ? <ModelProgress controller={controller} id={id} testId="upscale-model-progress" /> : null}
      {state.phase === 'running' ? <p role="status" data-testid="upscale-status">{stageText(t, state.stage, state.progress)}</p> : null}
      {model.error || state.error ? <span className={styles.panelError} role="alert">{model.error ?? state.error}</span> : null}
      <div className={styles.dialogButtons}>
        <button type="button" className={styles.pill} onClick={cancel}>{t('Cancel')}</button>
        <button type="button" className={`${styles.pill} ${styles.pillPrimary}`} data-testid="upscale-run" disabled={!valid || state.phase === 'running' || model.phase === 'checking'}
          onClick={() => void run()}>{model.phase === 'ready' ? t('Upscale') : `${t('Download and Upscale')} (${megabytes(GENAI_MODELS[id].byteLength)})`}</button>
      </div>
    </div>
  );
}

function ModelProgress({ controller, id, testId }: { controller: EditorController; id: GenAiModelId; testId: string }) {
  const state = modelState(controller, id), total = GENAI_MODELS[id].byteLength, t = controller.t;
  return <span role="status" data-testid={testId}>
    <progress max={total} value={state.loaded} aria-label={t('Downloading the model…')} />
    <span className={styles.secondary}>{megabytes(state.loaded)} / {megabytes(total)}</span>
    <button type="button" className={styles.pill} onClick={() => cancelModel(controller, id)}>{t('Cancel')}</button>
  </span>;
}

function stageText(t: EditorController['t'], stage: GenAiStage | null, progress: number): string {
  const label = stage === 'loading-model' ? t('Loading the model…') : stage === 'assembling' ? t('Blending tiles…') : t('Running local AI…');
  return `${label}${progress > 0 && progress < 1 ? ` ${Math.round(progress * 100)} %` : ''}`;
}
function megabytes(bytes: number): string { return `${Math.round(bytes / 1_048_576)} MB`; }

/** Measurement hook: values are produced by the worker clock and contain no user data or telemetry. */
export function genAiTiming(session: EditorSession): { readonly remove: { backend: string | null; inferenceMs: number | null };
  readonly upscale: { backend: string | null; inferenceMs: number | null } } {
  const remove = removeState(session), upscale = upscaleState(session);
  return { remove: { backend: remove.backend, inferenceMs: remove.inferenceMs },
    upscale: { backend: upscale.backend, inferenceMs: upscale.inferenceMs } };
}

export function installGenAi(controller: EditorController): void {
  if (!profileHasFeature(controller.profile, 'local-generative-fill', controller.capabilities)
    && !profileHasFeature(controller.profile, 'upscale', controller.capabilities)) return;
  controller.dialogs.contentFill = (close) => <RemovePanel controller={controller} close={close} />;
  controller.dialogs.upscale = (close) => <UpscalePanel controller={controller} close={close} />;
  if (profileHasFeature(controller.profile, 'local-generative-fill', controller.capabilities)) {
    controller.features.contentAwareFill = {
      enabled: () => canContentAwareFill(controller.session),
      run: () => {
        const model = modelState(controller, 'migan-512');
        if (beginRemove(controller, model.phase === 'ready')) controller.showDialog({ kind: 'custom', name: 'contentFill' });
      },
    };
  }
  if (profileHasFeature(controller.profile, 'upscale', controller.capabilities)) {
    controller.features.upscale = { enabled: () => !!controller.session.activeLayer?.raster && controller.workspace.canSwitch,
      run: () => controller.showDialog({ kind: 'custom', name: 'upscale' }) };
  }
}
