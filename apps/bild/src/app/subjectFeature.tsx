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
import { Check, FloatingPanel, Segmented, SliderRow } from './adjustmentsFeature';

const MODEL_URL = `${import.meta.env.BASE_URL}models/u2netp.onnx`;

const PHASE_TEXT: Partial<Record<SubjectRemovalPhase, string>> = {
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
        {session.selection ? <p className={styles.panelNote}>{t('Limited to the selection')}</p> : null}
      </fieldset>
      <div className={styles.dialogButtons}>
        <button type="button" className={styles.pill} onClick={close} disabled={state.phase === 'applying'} data-testid="remove-background-cancel">{t('Cancel')}</button>
        {working ? (
          <span className={styles.panelNote} role="status">
            {t(working)}{state.progress > 0 && state.progress < 1 ? ` ${Math.round(state.progress * 100)}%` : ''}
          </span>
        ) : null}
        <button type="button" className={`${styles.pill} ${styles.pillPrimary}`} disabled={state.phase !== 'ready' || !!pending.current} data-testid="remove-background-ok"
          onClick={() => void removeBackground(session, { action: 'apply' })}>{t('OK')}</button>
      </div>
    </FloatingPanel>
  );
}

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
    run: () => { void removeBackground(controller.session, { modelUrl: MODEL_URL }); },
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
