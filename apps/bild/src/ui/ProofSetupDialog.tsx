import { useEffect, useState } from 'react';
import styles from './editor.module.css';
import type { EditorController } from './controller';
import {
  bundledCmykProfile, userCmykProfile, type BundledCmykProfileId, type CmykProfile,
  type CmykRenderingIntent,
} from '../core/color/cmyk';

export function ProofSetupDialog({ controller, close }: { controller: EditorController; close: () => void }) {
  const session = controller.session, current = session.proofProfile;
  const [choice, setChoice] = useState<BundledCmykProfileId | 'user'>(current?.id ?? 'fogra39-approx');
  const [custom, setCustom] = useState<CmykProfile | null>(current?.id === 'user' ? current : null);
  const [intent, setIntent] = useState<CmykRenderingIntent>(session.proofOptions.intent);
  const [bpc, setBpc] = useState(session.proofOptions.blackPointCompensation);
  const [paper, setPaper] = useState(session.proofOptions.simulatePaperWhite);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [names, setNames] = useState<Record<BundledCmykProfileId, string> | null>(null);
  useEffect(() => {
    let active = true;
    void Promise.all([bundledCmykProfile('swop-approx'), bundledCmykProfile('fogra39-approx')]).then(([swop, fogra]) => {
      if (active) setNames({ 'swop-approx': swop.name, 'fogra39-approx': fogra.name });
    });
    return () => { active = false; };
  }, []);
  const chooseFile = async (file: File | undefined) => {
    if (!file) return;
    try { const profile = userCmykProfile(file.name, new Uint8Array(await file.arrayBuffer())); setCustom(profile); setChoice('user'); setError(null); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  };
  const apply = async () => {
    setBusy(true); setError(null);
    try {
      const profile = choice === 'user' ? custom : await bundledCmykProfile(choice);
      if (!profile) throw new Error('Choose an ICC output profile.');
      await controller.setProofSetup(profile, { intent, blackPointCompensation: bpc, simulatePaperWhite: paper });
      close();
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); setBusy(false); }
  };
  return (
    <div className={`${styles.dialog} ${styles.dialogWide}`} role="dialog" aria-modal aria-labelledby="proof-title" data-testid="proof-setup-dialog">
      <h2 className={styles.dialogTitle} id="proof-title">{controller.t('Proof Setup')}</h2>
      <label className={styles.exportRow}><span className={`${styles.exportLabel} ${styles.exportLabelFixed}`}>{controller.t('Profile')}</span>
        <select className={styles.select} value={choice} data-testid="proof-profile" onChange={(event) => setChoice(event.target.value as typeof choice)}>
          <option value="fogra39-approx">{names?.['fogra39-approx'] ?? 'Generic FOGRA39-like (approximation)'}</option>
          <option value="swop-approx">{names?.['swop-approx'] ?? 'Generic SWOP-like (approximation)'}</option>
          {custom ? <option value="user">{custom.name}</option> : null}
        </select>
      </label>
      <label className={styles.exportRow}><span className={`${styles.exportLabel} ${styles.exportLabelFixed}`}>{controller.t('ICC file')}</span>
        <input type="file" accept=".icc,.icm,application/vnd.iccprofile" data-testid="proof-icc-file"
          onChange={(event) => { void chooseFile(event.target.files?.[0]); }} />
      </label>
      <label className={styles.exportRow}><span className={`${styles.exportLabel} ${styles.exportLabelFixed}`}>{controller.t('Intent')}</span>
        <select className={styles.select} value={intent} data-testid="proof-intent" onChange={(event) => setIntent(event.target.value as CmykRenderingIntent)}>
          <option value="perceptual">{controller.t('Perceptual')}</option>
          <option value="relative-colorimetric">{controller.t('Relative Colorimetric')}</option>
        </select>
      </label>
      <label className={styles.check}><input type="checkbox" checked={bpc} data-testid="proof-bpc" onChange={(event) => setBpc(event.target.checked)} />
        {controller.t('Black Point Compensation')}</label>
      <label className={styles.check}><input type="checkbox" checked={paper} data-testid="proof-paper-white" onChange={(event) => setPaper(event.target.checked)} />
        {controller.t('Simulate Paper White')}</label>
      <p className={styles.secondary}>{controller.t('Soft-proofing changes only the display. The working document remains RGB.')}</p>
      {error ? <p className={styles.warning}>{error}</p> : null}
      <div className={styles.dialogButtons}>
        <button type="button" className={styles.pill} onClick={close}>{controller.t('Cancel')}</button>
        <button type="button" className={`${styles.pill} ${styles.pillPrimary}`} disabled={busy || (choice === 'user' && !custom)}
          data-testid="proof-apply" onClick={() => { void apply(); }}>{busy ? controller.t('Preparing…') : controller.t('OK')}</button>
      </div>
    </div>
  );
}
