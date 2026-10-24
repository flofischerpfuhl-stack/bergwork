/**
 * Sheets and alerts: New Canvas (UI/NewCanvasSheet.swift), the Export As dialog (./ExportDialog),
 * confirmations (NSAlert) and error alerts.
 */

import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import styles from './editor.module.css';
import type { EditorController } from './controller';
import { useUi } from './hooks';
import { validDimension } from '../core/document';
import {
  backgroundColor, CANVAS_BACKGROUNDS, CANVAS_PRESET_GROUPS, CANVAS_PRESETS, CANVAS_UNITS, canvasPixels, canvasText, matchingPreset,
  type CanvasBackground, type CanvasUnit,
} from '../core/canvasPresets';
import { markUiRender } from './performance';

const importExportDialog = () => import('./ExportDialog');
const ExportDialog = lazy(() => importExportDialog().then((module) => ({ default: module.ExportDialog })));
const CommandPalette = lazy(() => import('./CommandPalette').then((module) => ({ default: module.CommandPalette })));
const ProofSetupDialog = lazy(() => import('./ProofSetupDialog').then((module) => ({ default: module.ProofSetupDialog })));
const AboutDialog = lazy(() => import('./LicensesView').then((module) => ({ default: module.AboutDialog })));
const LicensesView = lazy(() => import('./LicensesView').then((module) => ({ default: module.LicensesView })));
if (typeof window !== 'undefined') {
  const preload = () => { void importExportDialog(); };
  if ('requestIdleCallback' in window) window.requestIdleCallback(preload, { timeout: 1_500 });
  else setTimeout(preload, 0);
}

export function NewCanvasSheet({ controller, welcome = false, onDone }: { controller: EditorController; welcome?: boolean; onDone?: () => void }) {
  markUiRender('NewCanvasSheet');
  const t = controller.t;
  const [width, setWidth] = useState('1920');
  const [height, setHeight] = useState('1080');
  const [unit, setUnit] = useState<CanvasUnit>('px');
  const [resolution, setResolution] = useState(72);
  const [background, setBackground] = useState<CanvasBackground>('transparent');
  const maxSide = controller.limits.maxSide;
  const parsedWidth = canvasPixels(width, unit, resolution, maxSide), parsedHeight = canvasPixels(height, unit, resolution, maxSide);
  const dimensionsValid = parsedWidth !== null && parsedHeight !== null;
  const withinProfile = dimensionsValid && parsedWidth * parsedHeight <= controller.limits.maxPixels;
  const valid = dimensionsValid && withinProfile;
  const preset = matchingPreset(parsedWidth, parsedHeight, resolution);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // Suggest the clipboard image's size when one is available (NewCanvasSheet.clipboardDimensions).
    let cancelled = false;
    void controller.clipboardImageSize?.().then((size) => {
      if (!cancelled && size && validDimension(size.width) && validDimension(size.height)) { setUnit('px'); setWidth(String(size.width)); setHeight(String(size.height)); }
    });
    if (!welcome) first.current?.focus();
    return () => { cancelled = true; };
  }, [controller, welcome]);
  /** Shows the sizes in another unit or at another resolution: the same pixels written differently, except that in a
   * print unit the pixels follow the resolution (NewCanvasSheet.switchUnit). */
  const fill = (w: number, h: number, nextUnit = unit, nextResolution = resolution) => {
    setWidth(canvasText(w, nextUnit, nextResolution)); setHeight(canvasText(h, nextUnit, nextResolution));
  };
  const changeUnit = (next: CanvasUnit) => {
    if (parsedWidth !== null && parsedHeight !== null) fill(parsedWidth, parsedHeight, next);
    setUnit(next);
  };
  const choosePreset = (id: string) => {
    const chosen = CANVAS_PRESETS.find((item) => item.id === id); if (!chosen) return;
    const nextResolution = chosen.resolution ?? resolution;
    setResolution(nextResolution); fill(chosen.width, chosen.height, unit, nextResolution);
  };
  const create = () => {
    if (parsedWidth === null || parsedHeight === null || !withinProfile) return;
    const options = { resolution, background: backgroundColor(background) };
    if (welcome) controller.session.createNewProject(parsedWidth, parsedHeight, undefined, options);
    else controller.newCanvasTab(parsedWidth, parsedHeight, options);
    onDone?.();
  };
  const summary = [t(BACKGROUND_LABELS[background]), unit !== 'px' && dimensionsValid ? `${parsedWidth} × ${parsedHeight} px` : null, 'sRGB']
    .filter(Boolean).join(' · ');
  const card = (
    <form className={styles.sheetCard} onSubmit={(event) => { event.preventDefault(); create(); }} data-testid="new-canvas-sheet"
      onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Escape' && onDone) onDone(); }}
      onPaste={(event) => {
        // A pasted image becomes the canvas (Compositor 1.5); pasted text still goes into the fields.
        event.stopPropagation();
        if (controller.openPastedImage(event.nativeEvent)) { event.preventDefault(); onDone?.(); }
      }}>
      <div className={styles.sheetHeader}>
        <div>
          <h2 className={styles.sheetTitle}>{t('New canvas')}</h2>
          <p className={styles.secondary} style={{ margin: '6px 0 0' }}>{t('A blank space for your next composition.')}</p>
        </div>
        <select className={styles.select} value={preset?.id ?? ''} aria-label={t('Preset sizes')} title={t('Preset sizes for screens and common formats')}
          data-testid="canvasPreset" onChange={(event) => choosePreset(event.target.value)}>
          <option value="">{t('Custom')}</option>
          {CANVAS_PRESET_GROUPS.map((group) => (
            <optgroup key={group.name} label={t(group.name)}>
              {group.presets.map((item) => <option key={item.id} value={item.id}>{`${t(item.name)} · ${item.width} × ${item.height}`}</option>)}
            </optgroup>
          ))}
        </select>
      </div>
      <div className={styles.dimensionRow}>
        {[[t('Width'), width, setWidth, 'widthInput'], [t('Height'), height, setHeight, 'heightInput']].map(([label, value, set, id], index) => (
          <label key={id as string} className={styles.dimension}>
            {label as string}
            <span className={styles.dimensionInput}>
              <input ref={index === 0 ? first : undefined} inputMode={unit === 'px' ? 'numeric' : 'decimal'} value={value as string} data-testid={id as string}
                onChange={(e) => (set as (v: string) => void)(e.target.value)} aria-label={label as string} />
              <span className={styles.secondary}>{unit}</span>
            </span>
          </label>
        ))}
      </div>
      <div className={styles.buttonRow}>
        <select className={styles.select} value={background} aria-label={t('Background')} data-testid="canvasBackground"
          title={t('Start see-through, or with a white or black Background layer.')} onChange={(event) => setBackground(event.target.value as CanvasBackground)}>
          {CANVAS_BACKGROUNDS.map((item) => <option key={item} value={item}>{t(BACKGROUND_LABELS[item])}</option>)}
        </select>
        <select className={styles.select} value={unit} aria-label={t('Units')} data-testid="canvasUnit"
          title={t('Units: pixels, inches, centimeters or millimeters.')} onChange={(event) => changeUnit(event.target.value as CanvasUnit)}>
          {CANVAS_UNITS.map((item) => <option key={item} value={item}>{t(UNIT_LABELS[item])}</option>)}
        </select>
        <select className={styles.select} value={resolution} aria-label={t('Resolution')} data-testid="canvasResolution"
          title={unit === 'px' ? t('Stored with the file for printing; the pixels stay as typed.') : t('In print units the pixels follow the resolution.')}
          onChange={(event) => setResolution(Number(event.target.value))}>
          {[72, 150, 300].map((item) => <option key={item} value={item}>{`${item} ppi`}</option>)}
        </select>
      </div>
      <div className={valid ? styles.secondary : styles.warning} data-testid="canvasSummary">{valid ? summary
        : dimensionsValid ? (controller.profile.id === 'lite'
          ? t('Lite supports canvases up to 100 megapixels. berg:work Image Pro supports up to 300 megapixels.')
          : t('Pro supports canvases up to 300 megapixels.'))
          : unit === 'px' ? t('Enter whole numbers from 1 to 30,000 pixels.') : t('Enter a size up to 30,000 pixels at this resolution.')}</div>
      <div className={styles.buttonRow}>
        <button type="button" className={styles.pill} onClick={() => { onDone?.(); void controller.chooseAndOpen(); }}>{t('Open project')}</button>
        <button type="button" className={styles.pill} onClick={() => { onDone?.(); void controller.chooseAndImport(); }} data-testid="welcome-import">{t('Import image')}</button>
        <span className={styles.spacer} />
        {!welcome ? <button type="button" className={styles.pill} onClick={onDone}>{t('Cancel')}</button> : null}
        <button type="submit" className={`${styles.pill} ${styles.pillPrimary}`} disabled={!valid} data-testid="createCanvas">{t('Create canvas')}</button>
      </div>
      {controller.sample ? (
        // The host's sample image (the web app): beside the paste hint, so the row above keeps its actions on one line.
        <div className={styles.buttonRow}>
          <p className={styles.secondary} style={{ margin: 0, fontSize: 12, flex: '1 1 180px' }}>{t('Paste an image here to open it as a canvas.')}</p>
          <button type="button" className={styles.pill} onClick={() => { onDone?.(); void controller.openSample(); }} data-testid="welcome-sample">{t('Try a sample image')}</button>
        </div>
      ) : <p className={styles.secondary} style={{ margin: 0, fontSize: 12 }}>{t('Paste an image here to open it as a canvas.')}</p>}
    </form>
  );
  return welcome ? <div className={styles.welcome}>{card}</div> : card;
}

const BACKGROUND_LABELS: Record<CanvasBackground, string> = { transparent: 'Transparent canvas', white: 'White canvas', black: 'Black canvas' };
const UNIT_LABELS: Record<CanvasUnit, string> = { px: 'Pixels', in: 'Inches', cm: 'Centimeters', mm: 'Millimeters' };

/** Escape: cancels a confirmation, closes any other dialog. */
export function dismissDialog(controller: EditorController): void {
  const dialog = controller.ui.getState().dialog;
  if (!dialog) return;
  if (dialog.kind === 'confirm') dialog.resolve(dialog.buttons.find((b) => b.role === 'cancel')?.value ?? 'cancel');
  else if (dialog.kind === 'custom' && controller.customDialogDismissers[dialog.name]) controller.customDialogDismissers[dialog.name]!();
  else controller.showDialog(null);
}

export function DialogHost({ controller }: { controller: EditorController }) {
  markUiRender('DialogHost');
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
  else if (dialog.kind === 'commandPalette') content = (
    <Suspense fallback={null}><CommandPalette controller={controller} close={close} /></Suspense>
  );
  else if (dialog.kind === 'proofSetup') content = (
    <Suspense fallback={<div className={styles.dialog} role="dialog"><p className={styles.dialogMessage}>{controller.t('Working…')}</p></div>}>
      <ProofSetupDialog controller={controller} close={close} />
    </Suspense>
  );
  else if (dialog.kind === 'about' || dialog.kind === 'licenses') content = (
    <Suspense fallback={<div className={styles.dialog} role="dialog"><p className={styles.dialogMessage}>{controller.t('Loading licences…')}</p></div>}>
      {dialog.kind === 'about' ? <AboutDialog controller={controller} close={close} /> : <LicensesView controller={controller} close={close} />}
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
