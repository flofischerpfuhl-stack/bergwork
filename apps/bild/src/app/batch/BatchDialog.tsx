/**
 * File › Batch… (PRODUCT-PLAN 6.9 „Stapel-Export“, core task 14) in the Export As dialog's layout: the queue where
 * Export As shows its preview (files, or the current document's artboards or layers), and on the right — in the order
 * of Photoshop's Image Processor — the recipe, the target folder, the file-name pattern and the same file settings as
 * Export As (`ExportFileSettings`, one set of export options). Progress, per-item errors and the summary stay with the job, so a run can be cancelled and
 * continued later, and failed items retried.
 */

import { useEffect, useRef, useState, type DragEvent } from 'react';
import { useStore } from 'zustand';
import styles from '../../ui/editor.module.css';
import css from './batch.module.css';
import type { EditorController } from '../../ui/controller';
import { describeError } from '../../ui/errors';
import { Icon } from '../../ui/icons';
import { ExportFileSettings, type ExportSettings } from '../../ui/ExportDialog';
import { patternIsUnique, type BatchItemState } from '../../io/batch';
import { recipeLibrary } from './library';
import { fill, recipeSummary } from './describe';
import {
  addBatchFiles, batchJob, batchSettings, cancelBatch, chooseBatchFiles, chooseBatchFolder, chooseBatchRecipe, clearBatchQueue,
  hostWritesFolders, queueOf, refreshDocumentQueue, removeBatchItem, retryFailedItems, setBatchSource, startBatch, type BatchSourceKind,
} from './job';

const SOURCES: readonly { id: BatchSourceKind; label: string }[] = [
  { id: 'files', label: 'Files' }, { id: 'artboards', label: 'Artboards' }, { id: 'layers', label: 'Layers' },
];

function ItemRow({ controller, state, index, running }: { controller: EditorController; state: BatchItemState; index: number; running: boolean }) {
  const t = controller.t;
  const error = state.status === 'failed' ? describeError(state.error, t, 'batch') : null;
  const statusText = state.status === 'done' ? t('Exported') : state.status === 'failed' ? t('Failed')
    : state.status === 'running' ? t('Processing…') : t('Waiting');
  return (
    <li className={css.queueItem} data-testid="batch-item" data-status={state.status} data-name={state.item.name}>
      <span className={`${css.dot} ${state.status === 'running' ? css.dotRunning : state.status === 'done' ? css.dotDone : state.status === 'failed' ? css.dotFailed : ''}`} />
      <span className={css.queueName} title={state.item.name}>
        {index + 1}. {state.item.name}
        {state.outputs.length ? <span className={css.queueDetail} title={state.outputs.join(', ')}>→ {state.outputs.join(', ')}</span> : null}
        {error ? <span className={css.queueError} data-testid="batch-item-error" title={error.details ?? undefined}>{error.message}</span> : null}
      </span>
      <span className={`${css.queueStatus} ${state.status === 'failed' ? css.queueStatusFailed : state.status === 'done' ? css.queueStatusDone : ''}`}>{statusText}</span>
      <button type="button" className={css.remove} aria-label={t('Remove from queue')} title={t('Remove from queue')} disabled={running}
        data-testid="batch-remove" onClick={() => removeBatchItem(controller, state.item.id)}><Icon name="close" size={12} /></button>
    </li>
  );
}

export function BatchDialog({ controller, close }: { controller: EditorController; close: () => void }) {
  const t = controller.t, locale = controller.locale;
  const store = batchJob(controller);
  const job = useStore(store);
  const { recipes } = useStore(recipeLibrary(controller));
  const [dropping, setDropping] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => { refreshDocumentQueue(controller); root.current?.focus({ preventScroll: true }); }, [controller]);

  const settings = job.settings ?? batchSettings(controller);
  const setSettings = (update: Partial<ExportSettings>) => store.setState({ settings: { ...batchSettings(controller), ...update } });
  const queue = queueOf(job);
  const running = !!job.running;
  const done = queue.filter((s) => s.status === 'done').length, failed = queue.filter((s) => s.status === 'failed').length;
  const waiting = queue.length - done - failed;
  const processed = done + failed;
  const recipe = recipes.find((r) => r.id === job.recipeId) ?? null;
  const writesFolders = hostWritesFolders(controller);
  const document = controller.session.document;
  const started = processed > 0;
  const needsFolder = writesFolders && !job.folder;
  const canRun = !running && queue.length > 0 && !needsFolder && settings.sizes.every((row) => row.mode === 'scale' || /^\d+$/.test(row.value.trim()));
  const runLabel = !running && started && waiting > 0 ? t('Continue') : t('Run');

  const drop = (event: DragEvent) => {
    event.preventDefault();
    setDropping(false);
    if (running || job.source !== 'files') return;
    const files = [...event.dataTransfer.files];
    if (files.length) addBatchFiles(controller, files);
  };
  const emptyText = job.source === 'files' ? t('Drop images, PSD files or .fwimg projects here, or add them with Add Files….')
    : !document ? t('Open a document to export its artboards or layers.')
      : job.source === 'artboards' ? t('This document has no artboards.') : t('This document has no layers to export.');
  const status = running ? (job.cancelling ? t('Cancelling…') : t('Processing…'))
    : needsFolder && queue.length ? t('Choose a target folder.')
      : started ? fill(t('{done} exported · {failed} failed · {pending} waiting'), { done, failed, pending: waiting }) : '';

  return (
    <div ref={root} tabIndex={-1} className={`${styles.dialog} ${styles.exportDialog}`} role="dialog" aria-modal aria-labelledby="cmp-batch-title" data-testid="batch-dialog">
      <h2 className={styles.dialogTitle} id="cmp-batch-title">{t('Batch')}</h2>
      <div className={styles.exportBody}>
        <div className={css.queuePane}>
          <div className={css.queueHeader}>
            <h3 className={css.queueTitle}>{t('Queue')}</h3>
            <div className={styles.segmented} role="radiogroup" aria-label={t('Source')}>
              {SOURCES.map((source) => (
                <button key={source.id} type="button" role="radio" aria-checked={job.source === source.id} disabled={running}
                  data-testid={`batch-source-${source.id}`} className={`${styles.segment} ${job.source === source.id ? styles.segmentOn : ''}`}
                  onClick={() => setBatchSource(controller, source.id)}>{t(source.label)}</button>
              ))}
            </div>
          </div>
          <ul className={`${css.queue} ${dropping ? css.queueDrop : ''}`} aria-label={t('Queue')} data-testid="batch-queue"
            onDragOver={(event) => { if (job.source === 'files' && !running) { event.preventDefault(); setDropping(true); } }}
            onDragLeave={() => setDropping(false)} onDrop={drop}>
            {queue.length ? queue.map((state, index) => <ItemRow key={state.item.id} controller={controller} state={state} index={index} running={running} />)
              : <li className={css.queueEmpty}>{emptyText}</li>}
          </ul>
          <div className={styles.buttonRow}>
            {job.source === 'files' ? (
              <button type="button" className={styles.pill} disabled={running} data-testid="batch-add-files" onClick={() => void chooseBatchFiles(controller)}>{t('Add Files…')}</button>
            ) : null}
            <button type="button" className={styles.pill} disabled={running || !queue.length} data-testid="batch-clear" onClick={() => clearBatchQueue(controller)}>{t('Clear Queue')}</button>
          </div>
          <div className={css.progress} data-testid="batch-progress" aria-label={t('Progress')}>
            <div className={css.progressLine}>
              <span>{t('Progress')}</span>
              <span data-testid="batch-count">{fill(t('{done} of {total}'), { done: processed.toLocaleString(locale), total: queue.length.toLocaleString(locale) })}</span>
            </div>
            <div className={css.progressTrack} role="progressbar" aria-valuemin={0} aria-valuemax={queue.length} aria-valuenow={processed}>
              <div className={css.progressBar} style={{ width: `${queue.length ? (processed / queue.length) * 100 : 0}%` }} />
            </div>
          </div>
        </div>

        <div className={styles.exportSettings}>
          <section className={styles.exportSection} aria-label={t('Recipe')}>
            <h3 className={styles.exportSectionTitle}>{t('Recipe')}</h3>
            <select className={`${styles.select} ${styles.exportSelect}`} value={job.recipeId ?? ''} disabled={running} aria-label={t('Recipe')} data-testid="batch-recipe"
              onChange={(e) => chooseBatchRecipe(controller, e.target.value || null)}>
              <option value="">{t('No recipe')}</option>
              {recipes.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
            {recipe ? <p className={css.hint}>{recipeSummary(controller, recipe)}</p> : null}
          </section>

          <section className={styles.exportSection} aria-label={t('Target Folder')}>
            <h3 className={styles.exportSectionTitle}>{t('Target Folder')}</h3>
            {writesFolders ? (
              <div className={styles.exportRow}>
                <span className={`${css.folderName} ${job.folder ? '' : css.folderNone}`} data-testid="batch-folder">{job.folder?.name ?? '—'}</span>
                <button type="button" className={styles.pill} disabled={running} data-testid="batch-choose-folder" onClick={() => chooseBatchFolder(controller)}>{t('Choose Folder…')}</button>
              </div>
            ) : <p className={css.hint} data-testid="batch-zip-note">{t('This browser saves the files as one ZIP archive.')}</p>}
          </section>

          <section className={styles.exportSection} aria-label={t('File Names')}>
            <h3 className={styles.exportSectionTitle}>{t('File Names')}</h3>
            <input className={`${styles.exportText} ${styles.exportSelect}`} value={job.pattern} disabled={running} aria-label={t('File Names')} data-testid="batch-pattern"
              spellCheck={false} onKeyDown={(event) => event.stopPropagation()} onChange={(e) => store.setState({ pattern: e.target.value })} />
            <p className={css.hint}>{t('{name} = file name · {index} = number · {w} × {h} = pixel size')}</p>
            {!patternIsUnique(job.pattern) ? <p className={`${css.hint} ${styles.warning}`}>{t('Add {name} or {index} so that every file gets its own name.')}</p> : null}
          </section>

          <ExportFileSettings controller={controller} settings={settings} setSettings={setSettings} rowResult={() => undefined} resolution={null} />
        </div>
      </div>
      <div className={styles.dialogButtons}>
        <span className={styles.exportStatus} role="status" data-testid="batch-summary">{status}</span>
        {running ? (
          <button type="button" className={styles.pill} disabled={job.cancelling} data-testid="batch-cancel" onClick={() => cancelBatch(controller)}>{t('Cancel')}</button>
        ) : (
          <button type="button" className={styles.pill} data-testid="batch-close" onClick={close}>{started ? t('Close') : t('Cancel')}</button>
        )}
        {!running && failed > 0 && waiting === 0 ? (
          <button type="button" className={styles.pill} data-testid="batch-retry" onClick={() => retryFailedItems(controller)}>{t('Retry Failed')}</button>
        ) : null}
        <button type="button" className={`${styles.pill} ${styles.pillPrimary}`} disabled={!canRun} data-testid="batch-run"
          onClick={() => startBatch(controller)}>{runLabel}</button>
      </div>
    </div>
  );
}
