/**
 * Sheets and alerts: New Canvas (UI/NewCanvasSheet.swift), JPEG export with an encoded preview
 * (UI/JPEGExportSheet.swift), confirmations (NSAlert) and error alerts.
 */

import { useEffect, useRef, useState } from 'react';
import styles from './editor.module.css';
import type { EditorController } from './controller';
import { useUi } from './hooks';
import { validDimension } from '../core/document';

export function NewCanvasSheet({ controller, welcome = false, onDone }: { controller: EditorController; welcome?: boolean; onDone?: () => void }) {
  const t = controller.t;
  const [width, setWidth] = useState('1920');
  const [height, setHeight] = useState('1080');
  const valid = validDimension(width) !== null && validDimension(height) !== null;
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
    if (w === null || h === null) return;
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
      <div className={valid ? styles.secondary : styles.warning}>{valid ? t('Transparent canvas · sRGB') : t('Enter whole numbers from 1 to 30,000 pixels.')}</div>
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

function JpegDialog({ controller }: { controller: EditorController }) {
  const t = controller.t;
  const [quality, setQuality] = useState(controller.jpegOptions.quality);
  const [matte, setMatte] = useState('#ffffff');
  const [preview, setPreview] = useState<{ url: string; size: number; key: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = `${quality}|${matte}`;
  const document = controller.session.document;
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      const rgb = [1, 3, 5].map((i) => parseInt(matte.slice(i, i + 2), 16) / 255);
      void controller.exportBlob('jpeg', { quality, red: rgb[0]!, green: rgb[1]!, blue: rgb[2]! }).then((blob) => {
        if (cancelled) return;
        setPreview((old) => { if (old) URL.revokeObjectURL(old.url); return { url: URL.createObjectURL(blob), size: blob.size, key }; });
        blobRef.current = blob;
      }, (e: Error) => { if (!cancelled) setError(e.message); });
    }, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [key, controller, quality, matte]);
  const blobRef = useRef<Blob | null>(null);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);
  const ready = preview?.key === key && !error;
  return (
    <div className={`${styles.dialog} ${styles.dialogWide}`} role="dialog" aria-modal aria-label={t('Export JPEG…')}>
      <h2 className={styles.dialogTitle}>{t('Export JPEG…').replace('…', '')}</h2>
      <div className={styles.preview}>{preview ? <img src={preview.url} alt="JPEG preview" /> : null}</div>
      <label className={styles.appearanceRow}>
        <span>{t('Quality')}</span>
        <input className={styles.slider} type="range" min={0} max={1} step={0.01} value={quality} onChange={(e) => setQuality(Number(e.target.value))} />
        <span style={{ width: 45, textAlign: 'right' }}>{Math.round(quality * 100)}%</span>
      </label>
      <label className={styles.appearanceRow}>
        <span>{t('Background for transparency')}</span>
        <input type="color" value={matte} onChange={(e) => setMatte(e.target.value)} />
      </label>
      <span className={styles.secondary}>{document ? `${document.width} × ${document.height} px · sRGB` : ''}</span>
      <div className={styles.dialogButtons}>
        <span className={styles.secondary} style={{ marginRight: 'auto' }}>{error ?? (ready && preview ? `${(preview.size / 1024).toFixed(0)} KB · encoded preview` : '…')}</span>
        <button type="button" className={styles.pill} onClick={() => controller.showDialog(null)}>{t('Cancel')}</button>
        <button type="button" className={`${styles.pill} ${styles.pillPrimary}`} disabled={!ready}
          onClick={() => {
            const rgb = [1, 3, 5].map((i) => parseInt(matte.slice(i, i + 2), 16) / 255);
            controller.jpegOptions = { quality, red: rgb[0]!, green: rgb[1]!, blue: rgb[2]! };
            controller.showDialog(null);
            void controller.exportTo('jpeg');
          }}>{t('Export')}…</button>
      </div>
    </div>
  );
}

export function DialogHost({ controller }: { controller: EditorController }) {
  const dialog = useUi(controller, (s) => s.dialog);
  if (!dialog) return null;
  let content = null;
  const close = () => controller.showDialog(null);
  if (dialog.kind === 'newCanvas') content = <NewCanvasSheet controller={controller} onDone={close} />;
  else if (dialog.kind === 'jpeg') content = <JpegDialog controller={controller} />;
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
      if (event.key === 'Escape') {
        if (dialog.kind === 'confirm') dialog.resolve(dialog.buttons.find((b) => b.role === 'cancel')?.value ?? 'cancel');
        else close();
      }
    }}>
      {content}
    </div>
  );
}
