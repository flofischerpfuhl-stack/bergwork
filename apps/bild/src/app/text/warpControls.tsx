/**
 * Warp Text and text-on-path controls of the Type tool's context bar (PRODUCT-PLAN 6.6, Phase 3). Photoshop's options
 * bar has a "Create warped text" button that opens the Warp Text dialog (style, horizontal/vertical, bend and the two
 * distortions, previewed live, OK or Cancel); text on a path shows its own settings here (start and end of the text
 * range, flip, baseline offset). Built from the bar's own controls (editor.module.css, text.module.css).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import styles from '../../ui/editor.module.css';
import css from './text.module.css';
import type { EditorController } from '../../ui/controller';
import type { EditorSession } from '../../core/session';
import type { TextLayer, TextWarp, TextWarpStyle } from '../../core/document';
import { defaultTextWarp, TEXT_WARP_LABELS, TEXT_WARP_STYLES } from '../../core/text';
import { SliderRow } from '../adjustmentsFeature';
import type { TextEditor } from './editor';
import { usePopover, ValueInput, type TextUiParts } from './controls';

/** Photoshop's "Create warped text" icon: a T over an arc. */
function WarpIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" aria-hidden>
      <path d="M5 3.5h10M10 3.5v8" />
      <path d="M2.5 16.5c4.5-4 10.5-4 15 0" />
    </svg>
  );
}

function WarpPanel({ controller, editor, layer, close }: {
  controller: EditorController; editor: TextEditor; layer: TextLayer; close: (commit: boolean) => void;
}) {
  const t = controller.t;
  const current = layer.textWarp ?? null;
  const [warp, setWarp] = useState<TextWarp | null>(current);
  const apply = (next: TextWarp | null) => { setWarp(next); editor.previewWarp(next); };
  const style = warp?.style ?? 'none';
  const patch = (value: Partial<TextWarp>) => { if (warp) apply({ ...warp, ...value }); };
  return (
    <>
      <div className={styles.panelHeader} style={{ cursor: 'default' }}>
        <h2 className={styles.dialogTitle}>{t('Warp Text')}</h2>
      </div>
      <div className={styles.panelRow}>
        <span className={styles.panelLabel} style={{ width: 140 }}>{t('Style')}</span>
        <select className={styles.select} value={style} aria-label={t('Style')} data-testid="warp-style"
          onChange={(event) => {
            const value = event.target.value as TextWarpStyle | 'none';
            apply(value === 'none' ? null : warp ? { ...warp, style: value } : defaultTextWarp(value));
          }}>
          <option value="none">{t('None')}</option>
          {TEXT_WARP_STYLES.map((value) => <option key={value} value={value}>{t(TEXT_WARP_LABELS[value])}</option>)}
        </select>
      </div>
      <div className={styles.panelRow}>
        <span className={styles.panelLabel} style={{ width: 140 }}>{t('Orientation')}</span>
        <div className={styles.segmented} role="radiogroup" aria-label={t('Orientation')}>
          {(['horizontal', 'vertical'] as const).map((value) => (
            <button key={value} type="button" role="radio" aria-checked={(warp?.orientation ?? 'horizontal') === value} disabled={!warp}
              data-testid={`warp-orientation-${value}`} className={`${styles.segment} ${(warp?.orientation ?? 'horizontal') === value ? styles.segmentOn : ''}`}
              onClick={() => patch({ orientation: value })}>
              {t(value === 'horizontal' ? 'Horizontal' : 'Vertical')}
            </button>
          ))}
        </div>
      </div>
      <fieldset className={styles.panelBody} disabled={!warp} style={warp ? undefined : { opacity: 0.45 }}>
        <SliderRow label={t('Bend')} value={warp?.bend ?? 0} min={-100} max={100} suffix="%" labelWidth={140} testId="warp-bend"
          onReset={() => patch({ bend: 0 })} onChange={(bend) => patch({ bend })} />
        <SliderRow label={t('Horizontal Distortion')} value={warp?.horizontalDistortion ?? 0} min={-100} max={100} suffix="%" labelWidth={140}
          testId="warp-horizontal" onReset={() => patch({ horizontalDistortion: 0 })} onChange={(horizontalDistortion) => patch({ horizontalDistortion })} />
        <SliderRow label={t('Vertical Distortion')} value={warp?.verticalDistortion ?? 0} min={-100} max={100} suffix="%" labelWidth={140}
          testId="warp-vertical" onReset={() => patch({ verticalDistortion: 0 })} onChange={(verticalDistortion) => patch({ verticalDistortion })} />
      </fieldset>
      <div className={styles.dialogButtons}>
        <button type="button" className={styles.pill} data-testid="warp-cancel" onClick={() => close(false)}>{t('Cancel')}</button>
        <button type="button" className={`${styles.pill} ${styles.pillPrimary}`} data-testid="warp-ok" onClick={() => close(true)}>{t('OK')}</button>
      </div>
    </>
  );
}

/** The bar's "Create warped text" button and its Warp Text popover. */
export function WarpButton({ controller, ui, session, disabled }: {
  controller: EditorController; ui: TextUiParts; session: EditorSession; disabled: boolean;
}) {
  const t = controller.t;
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const layer = ui.editor.targetLayer(session);
  const onPath = !!layer?.textPath;
  const close = useMemo(() => (commit = true) => { setOpen(false); ui.editor.endWarp(commit); }, [ui]);
  const closeCommit = useMemo(() => () => close(true), [close]);
  const position = usePopover(open, closeCommit, button, panel, 340, ui.editor);
  // A popover that goes away with its tab or tool still ends its session (committing what it shows).
  useEffect(() => () => { if (ui.editor.warpOpen) ui.editor.endWarp(true); }, [ui]);
  const title = onPath ? t('Text on a path can’t be warped') : t('Warp Text');
  return (
    <>
      <button ref={button} type="button" className={`${styles.iconButton} ${open || layer?.textWarp ? styles.iconButtonOn : ''}`}
        disabled={disabled || !layer || onPath} aria-label={t('Warp Text')} title={title} aria-expanded={open} data-testid="text-warp"
        onClick={() => {
          if (open) { close(true); return; }
          if (ui.editor.beginWarp(session)) setOpen(true);
        }}>
        <WarpIcon />
      </button>
      {open && position && layer ? (
        <div ref={panel} className={`${css.popover} ${css.warpPopover}`} style={position} role="dialog" aria-label={t('Warp Text')}
          data-testid="warp-panel" onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Escape') close(false);
            else if (event.key === 'Enter' && (event.target as HTMLElement).tagName !== 'BUTTON') close(true);
          }}>
          <WarpPanel controller={controller} editor={ui.editor} layer={layer} close={close} />
        </div>
      ) : null}
    </>
  );
}

/** Settings of text on a path: where it starts and ends on the path, flip, baseline offset. */
export function PathTextButton({ controller, ui, session, disabled }: {
  controller: EditorController; ui: TextUiParts; session: EditorSession; disabled: boolean;
}) {
  const t = controller.t, locale = controller.locale;
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = useMemo(() => () => { setOpen(false); ui.editor.refocusLater(); }, [ui]);
  const position = usePopover(open, close, button, panel, 320, ui.editor);
  const layer = ui.editor.targetLayer(session);
  const settings = layer?.textPath;
  if (!settings) return null;
  const set = (patch: Parameters<TextEditor['setPathOptions']>[1]) => ui.editor.setPathOptions(session, patch);
  const percent = (value: number) => Math.round(value * 1000) / 10;
  return (
    <>
      <button ref={button} type="button" className={`${styles.pill} ${open ? styles.pillOn : ''}`} disabled={disabled} aria-expanded={open}
        data-testid="path-text-toggle" title={t('Text on Path')} onClick={() => setOpen(!open)}>
        {t('Path Text')}
      </button>
      {open && position ? (
        <div ref={panel} className={`${css.popover} ${css.pathPopover}`} style={position} role="dialog" aria-label={t('Text on Path')}
          data-testid="path-text-panel" onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Escape') close(); }}>
          <div className={styles.panelHeader} style={{ cursor: 'default' }}>
            <h2 className={styles.dialogTitle}>{t('Text on Path')}</h2>
            <button type="button" className={styles.iconButton} aria-label={t('Close')} onClick={close}>×</button>
          </div>
          <div className={css.grid}>
            <label className={css.cell}><span>{t('Start')}</span>
              <ValueInput label={t('Start')} value={percent(settings.start)} locale={locale} min={0} max={100} step={1} testId="path-start"
                disabled={disabled} onCommit={(value) => set({ start: value / 100 })} />
              <span className={css.unit}>%</span>
            </label>
            <label className={css.cell}><span>{t('End')}</span>
              <ValueInput label={t('End')} value={percent(settings.end)} locale={locale} min={0} max={100} step={1} testId="path-end"
                disabled={disabled} onCommit={(value) => set({ end: value / 100 })} />
              <span className={css.unit}>%</span>
            </label>
            <label className={`${css.cell} ${css.cellWide}`}><span>{t('Baseline Shift')}</span>
              <ValueInput label={t('Baseline Shift')} value={settings.baselineOffset} locale={locale} min={-1000} max={1000} testId="path-baseline"
                disabled={disabled} onCommit={(value) => set({ baselineOffset: value })} />
              <span className={css.unit}>{t('pt')}</span>
            </label>
            <label className={`${styles.check} ${css.cellWide}`}>
              <input type="checkbox" checked={settings.flipped} disabled={disabled} data-testid="path-flip"
                onChange={(event) => set({ flipped: event.target.checked })} />
              {t('Flip')}
            </label>
          </div>
          <p className={styles.panelNote}>{t('Drag the start and end markers along the path with the Type tool.')}</p>
        </div>
      ) : null}
    </>
  );
}
