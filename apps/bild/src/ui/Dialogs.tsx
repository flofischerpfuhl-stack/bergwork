/**
 * Sheets and alerts: New Canvas (UI/NewCanvasSheet.swift), the Export As dialog (./ExportDialog),
 * confirmations (NSAlert) and error alerts.
 */

import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import styles from './editor.module.css';
import type { EditorController } from './controller';
import { useUi } from './hooks';
import { validDimension } from '../core/document';

const importExportDialog = () => import('./ExportDialog');
const ExportDialog = lazy(() => importExportDialog().then((module) => ({ default: module.ExportDialog })));
const ProofSetupDialog = lazy(() => import('./ProofSetupDialog').then((module) => ({ default: module.ProofSetupDialog })));
if (typeof window !== 'undefined') {
  const preload = () => { void importExportDialog(); };
  if ('requestIdleCallback' in window) window.requestIdleCallback(preload, { timeout: 1_500 });
  else setTimeout(preload, 0);
}

export function NewCanvasSheet({ controller, welcome = false, onDone }: { controller: EditorController; welcome?: boolean; onDone?: () => void }) {
  const t = controller.t;
  const [width, setWidth] = useState('1920');
  const [height, setHeight] = useState('1080');
  const parsedWidth = validDimension(width), parsedHeight = validDimension(height);
  const dimensionsValid = parsedWidth !== null && parsedHeight !== null;
  const withinProfile = dimensionsValid && parsedWidth <= controller.limits.maxSide && parsedHeight <= controller.limits.maxSide
    && parsedWidth * parsedHeight <= controller.limits.maxPixels;
  const valid = dimensionsValid && withinProfile;
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // Suggest the clipboard image's size when one is available (NewCanvasSheet.clipboardDimensions).
    let cancelled = false;
    void controller.clipboardImageSize?.().then((size) => {
      if (!cancelled && size && validDimension(size.width) && validDimension(size.height)) { setWidth(String(size.width)); setHeight(String(size.height)); }
    });
    if (!welcome) first.current?.focus();
    return () => { cancelled = true; };
  }, [controller, welcome]);
  const create = () => {
    const w = validDimension(width), h = validDimension(height);
    if (w === null || h === null || !withinProfile) return;
    if (welcome) controller.session.createNewProject(w, h);
    else controller.newCanvasTab(w, h);
    onDone?.();
  };
  const card = (
    <form className={styles.sheetCard} onSubmit={(event) => { event.preventDefault(); create(); }} data-testid="new-canvas-sheet"
      onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Escape' && onDone) onDone(); }}>
      <div>
        <h2 className={styles.sheetTitle}>{t('New canvas')}</h2>
        <p className={styles.secondary} style={{ margin: '6px 0 0' }}>{t('A blank space for your next composition.')}</p>
      </div>
      <div className={styles.dimensionRow}>
        {[[t('Width'), width, setWidth, 'widthInput'], [t('Height'), height, setHeight, 'heightInput']].map(([label, value, set, id], index) => (
          <label key={id as string} className={styles.dimension}>
            {label as string}
            <span className={styles.dimensionInput}>
              <input ref={index === 0 ? first : undefined} inputMode="numeric" value={value as string} data-testid={id as string}
                onChange={(e) => (set as (v: string) => void)(e.target.value)} aria-label={label as string} />
              <span className={styles.secondary}>px</span>
            </span>
          </label>
        ))}
      </div>
      <div className={valid ? styles.secondary : styles.warning}>{valid ? t('Transparent canvas · sRGB')
        : dimensionsValid ? (controller.profile.id === 'lite'
          ? t('Lite supports canvases up to 100 megapixels. Fernwork Bildeditor Pro supports up to 300 megapixels.')
          : t('Pro supports canvases up to 300 megapixels.'))
          : t('Enter whole numbers from 1 to 30,000 pixels.')}</div>
      <div className={styles.buttonRow}>
        <button type="button" className={styles.pill} onClick={() => { onDone?.(); void controller.chooseAndOpen(); }}>{t('Open project')}</button>
        <button type="button" className={styles.pill} onClick={() => { onDone?.(); void controller.chooseAndImport(); }} data-testid="welcome-import">{t('Import image')}</button>
        <span className={styles.spacer} />
        {!welcome ? <button type="button" className={styles.pill} onClick={onDone}>{t('Cancel')}</button> : null}
        <button type="submit" className={`${styles.pill} ${styles.pillPrimary}`} disabled={!valid} data-testid="createCanvas">{t('Create canvas')}</button>
      </div>
    </form>
  );
  return welcome ? <div className={styles.welcome}>{card}</div> : card;
}

/** Escape: cancels a confirmation, closes any other dialog. */
export function dismissDialog(controller: EditorController): void {
  const dialog = controller.ui.getState().dialog;
  if (!dialog) return;
  if (dialog.kind === 'confirm') dialog.resolve(dialog.buttons.find((b) => b.role === 'cancel')?.value ?? 'cancel');
  else if (dialog.kind === 'custom' && controller.customDialogDismissers[dialog.name]) controller.customDialogDismissers[dialog.name]!();
  else controller.showDialog(null);
}

export function DialogHost({ controller }: { controller: EditorController }) {
  const dialog = useUi(controller, (s) => s.dialog);
  if (!dialog) return null;
  let content = null;
  const close = () => controller.showDialog(null);
  if (dialog.kind === 'newCanvas') content = <NewCanvasSheet controller={controller} onDone={close} />;
  else if (dialog.kind === 'export') content = (
    <Suspense fallback={<div className={styles.dialog} role="dialog"><p className={styles.dialogMessage}>{controller.t('Working…')}</p></div>}>
      <ExportDialog controller={controller} close={close} />
    </Suspense>
  );
  else if (dialog.kind === 'proofSetup') content = (
    <Suspense fallback={<div className={styles.dialog} role="dialog"><p className={styles.dialogMessage}>{controller.t('Working…')}</p></div>}>
      <ProofSetupDialog controller={controller} close={close} />
    </Suspense>
  );
  else if (dialog.kind === 'alert') {
    content = (
      <div className={styles.dialog} role="alertdialog" aria-modal aria-labelledby="cmp-alert-title">
        <h2 className={styles.dialogTitle} id="cmp-alert-title">{dialog.title}</h2>
        <p className={styles.dialogMessage}>{dialog.message}</p>
        <div className={styles.dialogButtons}><button type="button" autoFocus className={`${styles.pill} ${styles.pillPrimary}`} onClick={close}>{controller.t('OK')}</button></div>
      </div>
    );
  } else if (dialog.kind === 'confirm') {
    content = (
      <div className={styles.dialog} role="alertdialog" aria-modal aria-labelledby="cmp-confirm-title">
        <h2 className={styles.dialogTitle} id="cmp-confirm-title">{dialog.title}</h2>
        <p className={styles.dialogMessage}>{dialog.message}</p>
        <div className={styles.dialogButtons}>
          {dialog.buttons.map((button) => (
            <button key={button.value} type="button" autoFocus={button.role === 'default'}
              className={`${styles.pill} ${button.role === 'default' ? styles.pillPrimary : ''}`}
              style={button.role === 'destructive' ? { color: 'var(--cmp-danger)' } : undefined}
              onClick={() => dialog.resolve(button.value)}>{button.label}</button>
          ))}
        </div>
      </div>
    );
  } else if (dialog.kind === 'rename') {
    controller.renamingLayerId = dialog.layerId;
    queueMicrotask(() => { close(); controller.session.notify('ui'); });
    return null;
  } else {
    const custom = controller.dialogs[dialog.kind === 'custom' ? dialog.name : dialog.kind];
    content = custom ? custom(close) : null;
  }
  return (
    <div className={styles.dialogBackdrop} onKeyDown={(event) => {
      event.stopPropagation();
      if (event.key === 'Escape') dismissDialog(controller);
    }}>
      {content}
    </div>
  );
}
