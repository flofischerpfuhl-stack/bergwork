import { useState } from 'react';
import type { EditorController } from '../ui/controller';
import type { RawDecodeOptions, RawWhiteBalance } from '../io/dng';
import styles from '../ui/editor.module.css';

const DEFAULTS: Required<RawDecodeOptions> = {
  exposure: 0, whiteBalance: 'as-shot', temperature: 6500, tint: 0, highlightRecovery: true,
};

function NumberField({ label, value, min, max, step, onChange, testId }: {
  label: string; value: number; min: number; max: number; step: number; onChange(value: number): void; testId: string;
}) {
  return <label className={styles.panelRow}><span className={styles.panelLabel}>{label}</span>
    <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    <input className={styles.rawNumber} type="number" min={min} max={max} step={step} value={value} data-testid={testId}
      onKeyDown={(event) => event.stopPropagation()} onChange={(event) => onChange(Math.max(min, Math.min(max, Number(event.target.value))))} />
  </label>;
}

function RawImportDialog({ controller, files, finish }: {
  controller: EditorController; files: readonly File[]; finish(value: RawDecodeOptions | null): void;
}) {
  const t = controller.t, [settings, set] = useState(DEFAULTS);
  const patch = (value: Partial<typeof DEFAULTS>) => set((current) => ({ ...current, ...value }));
  return <form className={styles.dialog} data-testid="raw-import-dialog" onSubmit={(event) => { event.preventDefault(); finish(settings); }}>
    <h2 className={styles.dialogTitle}>{t('Develop camera RAW')}</h2>
    <p className={styles.dialogMessage}>{files.length === 1 ? files[0]!.name : t('Apply these settings to the selected RAW files.')}</p>
    <NumberField label={t('Exposure')} value={settings.exposure} min={-5} max={5} step={0.1} testId="raw-exposure"
      onChange={(exposure) => patch({ exposure })} />
    <label className={styles.panelRow}><span className={styles.panelLabel}>{t('White balance')}</span>
      <select value={settings.whiteBalance} data-testid="raw-white-balance"
        onChange={(event) => patch({ whiteBalance: event.target.value as RawWhiteBalance })}>
        <option value="as-shot">{t('As shot')}</option><option value="auto">{t('Auto')}</option><option value="custom">{t('Custom')}</option>
      </select>
    </label>
    {settings.whiteBalance === 'custom' ? <>
      <NumberField label={t('Temperature')} value={settings.temperature} min={2000} max={12000} step={50} testId="raw-temperature"
        onChange={(temperature) => patch({ temperature })} />
      <NumberField label={t('Tint')} value={settings.tint} min={-150} max={150} step={1} testId="raw-tint"
        onChange={(tint) => patch({ tint })} />
    </> : null}
    <label className={styles.historyOption} style={{ padding: 0, border: 0 }}><input type="checkbox" checked={settings.highlightRecovery}
      data-testid="raw-highlight-recovery" onChange={(event) => patch({ highlightRecovery: event.target.checked })} /> {t('Recover highlights')}</label>
    <p className={styles.panelNote}>{t('The result is imported as a 16-bit pixel layer. RAW settings cannot be edited after import.')}</p>
    <div className={styles.dialogButtons}><button type="button" className={styles.pill} onClick={() => finish(null)}>{t('Cancel')}</button>
      <button type="submit" className={`${styles.pill} ${styles.pillPrimary}`} data-testid="raw-import-apply">{t('Import')}</button></div>
  </form>;
}

function RawPreferences({ controller, close }: { controller: EditorController; close(): void }) {
  const codec = controller.capabilities.codecs!, [enabled, setEnabled] = useState(codec.systemRawEnabled?.() ?? false), t = controller.t;
  return <div className={styles.dialog} data-testid="preferences-dialog">
    <h2 className={styles.dialogTitle}>{t('Preferences')}</h2>
    <label className={styles.historyOption} style={{ padding: 0, border: 0 }}><input type="checkbox" checked={enabled}
      data-testid="use-system-libraw" onChange={(event) => { setEnabled(event.target.checked); codec.setSystemRawEnabled?.(event.target.checked); }} />
      {t('Use system LibRaw (LGPL)')}</label>
    <p className={styles.dialogMessage}>{t('Off by default. berg:work Image does not bundle LibRaw; when enabled, the app loads a compatible library installed by your operating system.')}</p>
    <div className={styles.dialogButtons}><button type="button" className={styles.pill} data-testid="preferences-licenses"
      onClick={() => controller.showLicenses()}>{t('Licences…')}</button>
      <button type="button" className={`${styles.pill} ${styles.pillPrimary}`} onClick={close}>{t('Done')}</button></div>
  </div>;
}

export function installRaw(controller: EditorController): void {
  let request: { files: readonly File[]; resolve(value: RawDecodeOptions | null): void } | null = null;
  controller.dialogs.rawImport = () => request
    ? <RawImportDialog controller={controller} files={request.files} finish={(value) => { const done = request; request = null; controller.showDialog(null); done?.resolve(value); }} /> : null;
  controller.requestRawImportOptions = (files) => new Promise((resolve) => { request = { files, resolve }; controller.showDialog({ kind: 'custom', name: 'rawImport' }); });
  controller.customDialogDismissers.rawImport = () => { const done = request; request = null; controller.showDialog(null); done?.resolve(null); };
  if (controller.capabilities.codecs?.rawBackend === 'system-libraw') {
    controller.dialogs.preferences = (close) => <RawPreferences controller={controller} close={close} />;
  }
}
