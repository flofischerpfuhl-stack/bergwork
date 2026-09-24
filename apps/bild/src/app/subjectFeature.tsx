/**
 * Filter > Remove Background: the FilterSheet.swift panel for the subject mask (quality, edge
 * refinement) over the local U²-Netp engine in core/subject. The layer's pixels stay; the result is
 * an enabled layer mask, previewed through a mask override until OK.
 */

import { useRef } from 'react';
import styles from '../ui/editor.module.css';
import type { EditorController } from '../ui/controller';
import { useSession } from '../ui/hooks';
import type { EditorSession } from '../core/session';
import { removeBackground, subjectCommands, subjectRemovalState, type SubjectRemovalPhase } from '../core/subject/commands';
import type { BackgroundSettings } from '../core/subject/maskProcessing';
import { SUBJECT_MODELS, type SubjectModel, type SubjectModelUrls } from '../core/subject/models';
import type { RemoveBackgroundOptions } from '../core/subject/commands';
import { subjectInference, type SubjectInferenceClient } from '../workers/subjectClient';
import { Check, FloatingPanel, Segmented, SliderRow } from './adjustmentsFeature';

const resolvedUrls = new WeakMap<object, Partial<Record<SubjectModel, string>>>();

/** A0/E6: model bytes are resolved and cached by ModelHost; workers only see its local blob URL. */
function modelInference(controller: EditorController): Pick<SubjectInferenceClient, 'infer' | 'refine'> {
  const host = controller.capabilities.models;
  return {
    async infer(cacheKey, rgba, width, height, settings, refinementLimit, model, _modelUrls, progress, signal) {
      if (!host) throw new Error('This host does not provide local AI models.');
      const selected = model ?? 'fast';
      let urls = resolvedUrls.get(host);
      let url = urls?.[selected];
      if (!url) {
        const spec = SUBJECT_MODELS[selected];
        const source = selected === 'fast' ? `${import.meta.env.BASE_URL}models/u2netp.onnx` : spec.defaultUrl;
        progress?.({ stage: 'downloading-model', progress: 0, downloadedBytes: 0, totalBytes: spec.byteLength });
        const result = await host.resolveModel({ id: selected === 'fast' ? 'u2netp' : 'birefnet-lite', sha256: spec.sha256,
          url: source, userInitiated: true }, (loaded, total) => progress?.({ stage: 'downloading-model',
            progress: total ? Math.min(1, loaded / total) : 0, downloadedBytes: loaded, totalBytes: total }), signal);
        if (!result) throw new Error('The model is not cached and this host did not allow downloading it.');
        url = URL.createObjectURL(new Blob([result.bytes as BlobPart], { type: 'application/octet-stream' }));
        urls ??= {}; urls[selected] = url; resolvedUrls.set(host, urls);
      }
      return subjectInference.infer(cacheKey, rgba, width, height, settings, refinementLimit, selected,
        { [selected]: url } as Partial<SubjectModelUrls>, progress, signal);
    },
    refine: subjectInference.refine.bind(subjectInference),
  };
}

function beginRemoval(controller: EditorController, model: SubjectModel,
  options: Omit<RemoveBackgroundOptions, 'model' | 'modelUrls' | 'inference'> = {}): Promise<Readonly<ReturnType<typeof subjectRemovalState>>> {
  return removeBackground(controller.session, { ...options, model, inference: modelInference(controller) });
}

const megabytes = (bytes: number) => `${Math.round(bytes / 1_048_576)} MB`;

const PHASE_TEXT: Partial<Record<SubjectRemovalPhase, string>> = {
  'downloading-model': 'Downloading the model…',
  'loading-model': 'Loading the subject model…', inferring: 'Finding the subject…', refining: 'Refining edges…', applying: 'Applying…',
};

function RemoveBackgroundPanel({ controller }: { controller: EditorController }) {
  const session = useSession(controller.session);
  const t = controller.t;
  const state = subjectRemovalState(session);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  if (state.phase === 'idle') return null;
  const settings = state.settings;
  // Slider drags coalesce: each change restarts refinement in the worker, so only the last one runs.
  const change = (next: Partial<BackgroundSettings>) => {
    Object.assign(state, { settings: { ...settings, ...next } });
    session.notify('ui');
    if (pending.current) clearTimeout(pending.current);
    pending.current = setTimeout(() => { pending.current = null; void removeBackground(session, { action: 'preview', settings: next }); }, 120);
  };
  const close = () => { if (pending.current) clearTimeout(pending.current); void removeBackground(session, { action: 'cancel' }); };
  const working = PHASE_TEXT[state.phase];
  return (
    <FloatingPanel name="removeBackground" title={t('Remove Background')} onClose={close} closeLabel={t('Cancel')} testId="remove-background-panel">
      <fieldset className={styles.panelBody} disabled={state.phase === 'applying'}>
        <p className={styles.panelNote}>{t('Hide the background behind a layer mask, keeping the foreground subjects. The pixels stay, so the background can be painted back at any time.')}</p>
        <div className={styles.panelRow}>
          <span className={styles.panelLabel}>{t('Model')}</span>
          <Segmented label={t('Model')} options={controller.profile.aiModels} value={state.model}
            labelOf={(m: SubjectModel) => t(m === 'fast' ? 'Fast' : 'Best quality')}
            onChange={(model) => {
              if (model === state.model || state.phase === 'applying') return;
              if (pending.current) { clearTimeout(pending.current); pending.current = null; }
              lastModel = model;
              // Another model means a new inference on the same layer, keeping the refinement settings.
              void beginRemoval(controller, model, { action: 'begin', settings });
            }} />
        </div>
        {state.model === 'best' ? (
          <p className={styles.panelNote}>{t('Best quality downloads a larger model once')} ({megabytes(SUBJECT_MODELS.best.byteLength)}) {t('and needs more time and memory; it handles hair, dark scenes and complex edges much better.')}</p>
        ) : null}
        <Segmented label={t('Quality')} options={['basic', 'advanced'] as const} value={settings.quality}
          labelOf={(q) => t(q === 'basic' ? 'Basic' : 'Advanced')} onChange={(quality) => change({ quality })} />
        {settings.quality === 'advanced' ? (
          <>
            <SliderRow label={t('Refine')} value={settings.refineEdges} min={0} max={40} suffix="px" onChange={(refineEdges) => change({ refineEdges })} />
            <SliderRow label={t('Contrast')} value={settings.matteContrast} min={0} max={100} suffix="%" onChange={(matteContrast) => change({ matteContrast })} />
            <SliderRow label={t('Shift Edge')} value={settings.shiftEdge} min={-10} max={10} suffix="px" onChange={(shiftEdge) => change({ shiftEdge })} />
          </>
        ) : null}
        {state.error ? <p className={styles.panelError}>{state.error}</p> : null}
        {state.error && state.downloadResumable ? (
          <button type="button" className={styles.pill} data-testid="remove-background-retry"
            onClick={() => void beginRemoval(controller, state.model, { action: 'begin', settings })}>
            {t('Resume download')}
          </button>
        ) : null}
        {session.selection ? <p className={styles.panelNote}>{t('Limited to the selection')}</p> : null}
      </fieldset>
      <div className={styles.dialogButtons}>
        <button type="button" className={styles.pill} onClick={close} disabled={state.phase === 'applying'} data-testid="remove-background-cancel">{t('Cancel')}</button>
        {working ? (
          <span className={styles.panelNote} role="status">
            {t(working)}
            {state.phase === 'downloading-model' && state.totalBytes ? ` ${megabytes(state.downloadedBytes)} / ${megabytes(state.totalBytes)}`
              : state.progress > 0 && state.progress < 1 ? ` ${Math.round(state.progress * 100)}%` : ''}
          </span>
        ) : null}
        <button type="button" className={`${styles.pill} ${styles.pillPrimary}`} disabled={state.phase !== 'ready' || !!pending.current} data-testid="remove-background-ok"
          onClick={() => void removeBackground(session, { action: 'apply' })}>{t('OK')}</button>
      </div>
    </FloatingPanel>
  );
}

/** The model chosen last time the panel was used (per page load). */
let lastModel: SubjectModel = 'fast';

export function installSubject(controller: EditorController): void {
  const registries = new WeakMap<EditorSession, ReturnType<typeof subjectCommands>>();
  const command = () => {
    const session = controller.session;
    let registry = registries.get(session);
    if (!registry) { registry = subjectCommands(session); registries.set(session, registry); }
    return registry.removeBackground;
  };
  controller.features.removeBackground = {
    enabled: () => command().enabled(),
    run: () => { if (!controller.profile.aiModels.includes(lastModel)) lastModel = 'fast'; void beginRemoval(controller, lastModel); },
  };
  controller.panels.push(() => <RemoveBackgroundPanel controller={controller} />);
  controller.keyHandlers.push((event) => {
    const session = controller.session;
    const phase = subjectRemovalState(session).phase;
    if (phase === 'idle') return false;
    if (event.key === 'Escape') { void removeBackground(session, { action: 'cancel' }); return true; }
    if (event.key === 'Enter' && phase === 'ready') { void removeBackground(session, { action: 'apply' }); return true; }
    return false;
  });
}
