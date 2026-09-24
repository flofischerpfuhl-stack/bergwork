import styles from './editor.module.css';
import type { EditorController } from './controller';
import { useSession } from './hooks';
import { useState } from 'react';

/**
 * History panel (PRODUCT-PLAN 6.1, P7): every recorded step in order, the current state highlighted, steps after it
 * dimmed. Clicking a step goes back or forward to the state after it; the first row is the state before any step.
 */
export function HistoryPanel({ controller }: { controller: EditorController }) {
  const session = useSession(controller.session);
  const t = controller.t;
  const history = session.history;
  const past = history.pastNames, future = history.futureNames;
  const current = past.length;
  const [saveWithProject, setSaveWithProject] = useState(controller.saveHistoryWithProject);
  const rows = [t('Opened state'), ...past.map((name) => t(name)), ...future.map((name) => t(name))];
  return (
    <div className={styles.historyPanel} data-testid="history-panel">
      <ol className={styles.historyList} aria-label={t('History')}>
        {rows.map((label, index) => (
          <li key={index}>
            <button type="button" data-testid="history-step" aria-current={index === current ? 'step' : undefined}
              className={`${styles.historyRow} ${index === current ? styles.historyCurrent : ''} ${index > current ? styles.historyFuture : ''}`}
              disabled={!session.canUseHistory || !session.document}
              onClick={() => session.jumpToHistory(index)}>
              {label}
            </button>
          </li>
        ))}
      </ol>
      {!history.enabled ? <p className={styles.panelNote}>{t('History is switched off for this project.')}</p> : null}
      <label className={styles.historyOption} title={t('Saved projects keep their undo steps, so undo continues after reopening. Recovery copies always keep them.')}>
        <input type="checkbox" checked={saveWithProject} data-testid="save-history"
          onChange={(event) => { controller.saveHistoryWithProject = event.target.checked; setSaveWithProject(event.target.checked); }} />
        {t('Save history with the project')}
      </label>
    </div>
  );
}
