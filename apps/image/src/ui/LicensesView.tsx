import { useEffect, useMemo, useState } from 'react';
import type { EditorController } from './controller';
import styles from './LicensesView.module.css';

type Category = 'bundled' | 'optional-download' | 'opt-in-host' | 'tauri-runtime';

interface LicenseEntry {
  id: string;
  name: string;
  version: string;
  license: string;
  category: Category;
  homepage: string;
  textId: string;
}

interface LicenseDocument { version: number; entries: LicenseEntry[] }

const licenseTexts = import.meta.glob('../../LICENSES/*.txt', { query: '?raw', import: 'default' }) as Record<string, () => Promise<string>>;
// berg:work's LICENSE at the repository root covers this app.
const ownLicense = () => import('../../../../LICENSE?raw').then((module) => module.default);
const categoryOrder: Category[] = ['bundled', 'optional-download', 'opt-in-host', 'tauri-runtime'];

function categoryLabel(category: Category, t: EditorController['t']): string {
  return t(category === 'bundled' ? 'Bundled' : category === 'optional-download' ? 'Optional downloads'
    : category === 'opt-in-host' ? 'Opt-in host components (not bundled)' : 'Tauri desktop runtime');
}

export function AboutDialog({ controller, close }: { controller: EditorController; close(): void }) {
  const t = controller.t;
  return <section className={`${styles.dialog} ${styles.about}`} role="dialog" aria-modal aria-labelledby="cmp-about-title" data-testid="about-dialog">
    <h2 className={styles.title} id="cmp-about-title">{t('berg:work Image')}</h2>
    <p className={styles.summary}>{t('Works offline. No account, no telemetry.')}</p>
    <p className={styles.summary}>{t('Parts of this editor are based on Compositor by Wonder Assembly LLC (MIT License).')}</p>
    <div className={styles.actions}>
      <button type="button" className={styles.button} data-testid="about-licenses" onClick={() => controller.showLicenses()}>{t('Licences…')}</button>
      <button type="button" autoFocus className={`${styles.button} ${styles.primary}`} onClick={close}>{t('OK')}</button>
    </div>
  </section>;
}

export function LicensesView({ controller, close }: { controller: EditorController; close(): void }) {
  const t = controller.t;
  const [document, setDocument] = useState<LicenseDocument | null>(null);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState<{ title: string; text: string } | null>(null);
  useEffect(() => {
    let live = true;
    fetch('/licenses.json').then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json() as Promise<LicenseDocument>;
    }).then((value) => { if (live) setDocument(value); }).catch(() => { if (live) setError(true); });
    return () => { live = false; };
  }, []);
  const entries = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return document?.entries.filter((entry) => !needle || `${entry.name} ${entry.version} ${entry.license}`.toLocaleLowerCase().includes(needle)) ?? [];
  }, [document, query]);
  const showText = async (title: string, textId?: string) => {
    try {
      const loader = textId ? licenseTexts[`../../LICENSES/${textId}.txt`] : ownLicense;
      if (!loader) throw new Error('Missing licence text');
      setShown({ title, text: await loader() });
    } catch { setShown({ title, text: t('The licence text could not be loaded.') }); }
  };
  return <section className={styles.dialog} role="dialog" aria-modal aria-labelledby="cmp-licenses-title" data-testid="licenses-dialog">
    <h2 className={styles.title} id="cmp-licenses-title">{t('Licences')}</h2>
    {shown ? <div className={styles.textView}>
      <div className={styles.textHeader}><button type="button" className={styles.button} onClick={() => setShown(null)}>{t('Back')}</button><h3>{shown.title}</h3></div>
      <pre className={styles.text} data-testid="license-text">{shown.text}</pre>
    </div> : <>
      <div className={styles.toolbar}><input className={styles.search} type="search" value={query} data-testid="license-search"
        aria-label={t('Search licences')} placeholder={t('Search licences')} onChange={(event) => setQuery(event.target.value)} /></div>
      <div className={styles.content}>
        <section className={styles.own}>
          <h3>{t('berg:work Image')}</h3>
          <p>{t('Business Source License 1.1 with a free tier for personal use, education, and organizations with three or fewer people. Each release changes to AGPL-3.0-or-later after four years.')}</p>
          <button type="button" className={styles.licenseButton} data-testid="own-license-text" onClick={() => void showText(t('Business Source License 1.1'))}>{t('View full licence text')}</button>
        </section>
        {!document && !error ? <div className={styles.status}>{t('Loading licences…')}</div> : null}
        {error ? <div className={styles.status}>{t('The licence inventory could not be loaded.')}</div> : null}
        {document && !entries.length ? <div className={styles.empty}>{t('No licences match your search.')}</div> : null}
        {categoryOrder.map((category) => {
          const group = entries.filter((entry) => entry.category === category);
          return group.length ? <section className={styles.group} key={category} data-testid={`license-group-${category}`}>
            <h3>{categoryLabel(category, t)} ({group.length})</h3>
            <table className={styles.table}><thead><tr><th>{t('Component')}</th><th>{t('Version')}</th><th>{t('Licence')}</th></tr></thead>
              <tbody>{group.map((entry) => <tr key={entry.id}>
                <td><a href={entry.homepage} target="_blank" rel="noreferrer">{entry.name}</a></td><td>{entry.version}</td>
                <td><button type="button" className={styles.licenseButton} onClick={() => void showText(`${entry.name} — ${entry.license}`, entry.textId)}>{entry.license}</button></td>
              </tr>)}</tbody></table>
          </section> : null;
        })}
      </div>
    </>}
    <div className={styles.actions}><button type="button" className={`${styles.button} ${styles.primary}`} onClick={close}>{t('Done')}</button></div>
  </section>;
}
