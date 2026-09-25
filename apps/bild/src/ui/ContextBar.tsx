/**
 * The tool header under the tabs (ContentView.swift): TransformInspector for Move, the navigation
 * header for Hand/Zoom, and tool-specific bars registered by other modules.
 */

import { useEffect, useState, type ReactNode } from 'react';
import styles from './editor.module.css';
import type { EditorController } from './controller';
import { useSession, useWorkspace } from './hooks';
import { Icon } from './icons';
import { LAYER_SAMPLINGS, scalePercent, scaledToPercent, type LayerTransform } from '../core/geometry';
import { makeTransform } from '../core/geometry';
import type { EditorSession } from '../core/session';

/** No trailing zeros on a whole number, two decimals otherwise (TransformValueField.formatted). */
export function formatted(value: number): string {
  return Math.abs(value - Math.round(value)) < 0.005 ? String(Math.round(value)) : value.toFixed(2);
}

/** A numeric field that applies while typing, steps with ↑/↓ (Shift ×10) and resyncs when not focused. */
export function NumberField({ label, value, onChange, suffix, width, disabled, testId }: {
  label: string; value: number; onChange: (value: number) => void; suffix?: string; width?: number; disabled?: boolean; testId?: string;
}) {
  const [text, setText] = useState(formatted(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setText(formatted(value)); }, [value, focused]);
  return (
    <label className={styles.field}>
      <span>{label}</span>
      <input inputMode="decimal" value={text} disabled={disabled} style={width ? { width } : undefined} data-testid={testId} aria-label={label}
        onFocus={() => setFocused(true)}
        onBlur={() => { setFocused(false); setText(formatted(value)); }}
        onChange={(event) => {
          setText(event.target.value);
          const number = Number(event.target.value.replace(',', '.'));
          if (event.target.value.trim() !== '' && Number.isFinite(number)) onChange(number);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            const step = (event.shiftKey ? 10 : 1) * (event.key === 'ArrowUp' ? 1 : -1);
            onChange(value + step);
            setText(formatted(value + step));
            event.preventDefault();
          } else if (event.key === 'Enter' || event.key === 'Escape') {
            (event.target as HTMLInputElement).blur();
          }
          event.stopPropagation();
        }} />
      {suffix ? <span>{suffix}</span> : null}
    </label>
  );
}

function TransformInspector({ controller, session }: { controller: EditorController; session: EditorSession }) {
  const t = controller.t;
  const layer = session.activeLayer;
  const value: LayerTransform = session.transformEdit?.draft ?? (layer ? session.editedTransform(layer) : makeTransform({ x: 0, y: 0 }, { width: 1, height: 1 }));
  const pixelSize = session.transformPixelSize ?? layer?.transform.size ?? value.size;
  const disabled = (!session.canTransform && !session.transformEdit) || !!session.transformEdit?.corners;
  const change = (update: (value: LayerTransform) => LayerTransform) => {
    if (!session.transformEdit) session.beginTransform();
    const draft = session.transformEdit?.draft;
    if (draft) session.previewTransform(update(draft));
  };
  const resize = (number: number, width: boolean) => change((v) => {
    if (number < 1) return v;
    if (width) return { ...v, size: { width: number, height: session.locksTransformRatio ? v.size.height * number / v.size.width : v.size.height } };
    return { ...v, size: { height: number, width: session.locksTransformRatio ? v.size.width * number / v.size.height : v.size.width } };
  });
  const canvas = controller.canvasView;
  return (
    <>
      <span className={styles.headerTitle}>{session.transformTargetsMask ? t('Transform Mask') : t('Transform')}</span>
      <label className={styles.check} title={t('Select layers by clicking the canvas. When off, hold ⌘ to select a layer.')}>
        <input type="checkbox" checked={session.transformAutoSelect} onChange={(e) => { session.transformAutoSelect = e.target.checked; session.notify('ui'); }} />
        {t('Auto Select')}
      </label>
      <label className={styles.check}>
        <input type="checkbox" checked={session.showsTransformControls} onChange={(e) => { session.showsTransformControls = e.target.checked; session.notify('document'); }} />
        {t('Show Controls')}
      </label>
      <NumberField label="X" value={value.origin.x} disabled={disabled} testId="transformX" onChange={(n) => change((v) => ({ ...v, origin: { ...v.origin, x: n } }))} />
      <NumberField label="Y" value={value.origin.y} disabled={disabled} testId="transformY" onChange={(n) => change((v) => ({ ...v, origin: { ...v.origin, y: n } }))} />
      <NumberField label="W" value={value.size.width} disabled={disabled} testId="transformW" onChange={(n) => resize(n, true)} />
      <NumberField label="H" value={value.size.height} disabled={disabled} testId="transformH" onChange={(n) => resize(n, false)} />
      <button type="button" className={`${styles.iconButton} ${session.locksTransformRatio ? styles.iconButtonOn : ''}`} aria-pressed={session.locksTransformRatio}
        title={t('Lock aspect ratio')} aria-label={t('Lock aspect ratio')} disabled={disabled}
        onClick={() => { session.locksTransformRatio = !session.locksTransformRatio; session.notify('ui'); }}><Icon name="link" size={15} /></button>
      <NumberField label={t('Scale')} suffix="%" value={scalePercent(value, pixelSize)} disabled={disabled} width={64}
        onChange={(n) => { if (n > 0) change((v) => scaledToPercent(v, n, pixelSize)); }} />
      <NumberField label="°" value={value.rotation} disabled={disabled} testId="transformAngle" onChange={(n) => change((v) => ({ ...v, rotation: n % 360 }))} />
      <select className={styles.select} value={value.sampling} disabled={disabled} aria-label={t('Sampling')}
        onChange={(e) => change((v) => ({ ...v, sampling: e.target.value as LayerTransform['sampling'] }))}>
        {LAYER_SAMPLINGS.map((s) => <option key={s} value={s}>{t(s)}</option>)}
      </select>
      <button type="button" className={styles.pill} disabled={disabled} onClick={() => change((v) => ({ ...v, flipX: !v.flipX }))}>{t('Flip H')}</button>
      <button type="button" className={styles.pill} disabled={disabled} onClick={() => change((v) => ({ ...v, flipY: !v.flipY }))}>{t('Flip V')}</button>
      <button type="button" className={`${styles.pill} ${canvas?.distortArmed || session.transformEdit?.corners ? styles.pillOn : ''}`}
        disabled={!session.canTransform && !session.transformEdit}
        title={t('Drag a handle to distort (⌘-drag a handle does the same)')}
        onClick={() => {
          if (!canvas) return;
          canvas.distortArmed = !canvas.distortArmed;
          if (canvas.distortArmed && !session.transformEdit) session.beginTransform();
          if (canvas.distortArmed) session.beginDistort();
          session.notify('ui');
        }}>{t('Distort')}</button>
      <span className={styles.spacer} />
      <button type="button" className={styles.pill} disabled={!session.transformEdit} onClick={() => { if (canvas) canvas.distortArmed = false; session.cancelTransform(); }}>{t('Cancel')}</button>
      <button type="button" className={`${styles.pill} ${styles.pillPrimary}`} disabled={!session.transformEdit} data-testid="applyTransform"
        onClick={() => { if (canvas) canvas.distortArmed = false; session.commitTransform(); }}>{t('Apply')}</button>
    </>
  );
}

function NavigationHeader({ controller, session }: { controller: EditorController; session: EditorSession }) {
  const t = controller.t;
  useSession(session, true);
  return (
    <>
      <span className={styles.headerTitle}>{session.tool === 'hand' ? t('Pan') : t('Zoom')}</span>
      {session.tool === 'zoom' ? (
        <NumberField label="" suffix="%" width={72} value={Number((session.viewport.zoom * 100).toFixed(2))} disabled={!session.document}
          onChange={(n) => { if (n > 0) session.zoomTo(Math.min(3200, Math.max(0.1, n)) / 100); }} />
      ) : null}
    </>
  );
}

export function ContextBar({ controller }: { controller: EditorController }) {
  useWorkspace(controller);
  const session = useSession(controller.session);
  const t = controller.t;
  let content: ReactNode;
  const registered = controller.contextBars[session.tool];
  if (registered) content = registered(session);
  else if (session.tool === 'move') content = <TransformInspector controller={controller} session={session} />;
  else if (session.tool === 'hand' || session.tool === 'zoom') content = <NavigationHeader controller={controller} session={session} />;
  else if (session.tool === 'idle') content = <span className={styles.headerTitle}>{t('Select a tool')}</span>;
  else content = <span className={styles.headerTitle}>{t('Tool options')}</span>;
  return <div className={styles.header} role="toolbar" aria-label={controller.t('Tool options')} data-testid="context-bar">{content}</div>;
}

export function statusHint(session: EditorSession, t: (s: string) => string): string {
  switch (session.tool) {
    case 'move': return t('Drag to move · Handles to resize · Circle to rotate · 1–0 layer opacity · Space to pan');
    case 'hand': return t('Drag to pan · Pinch to zoom');
    case 'zoom': return t('Click to zoom in · Option-click to zoom out · Drag right or left to zoom smoothly · Space to pan');
    case 'idle': return t('No tool selected · Press a tool\'s key to pick one · Space to pan');
    default: return '';
  }
}

export function StatusBar({ controller }: { controller: EditorController }) {
  useWorkspace(controller);
  const session = useSession(controller.session, true);
  const t = controller.t;
  const document = session.document;
  const zoom = session.viewport.zoom * 100;
  const hint = controller.statusHints[session.tool]?.(session) ?? statusHint(session, t);
  return (
    <div className={styles.status} role="status">
      {document ? (
        <>
          <span style={{ width: 62 }} data-testid="zoomStatus">{zoom >= 10 ? Math.round(zoom * 10) / 10 : Math.round(zoom * 100) / 100}%</span>
          <span data-testid="canvasDimensions">{document.width.toLocaleString(controller.locale)} × {document.height.toLocaleString(controller.locale)} px</span>
          <span>sRGB · Transparent</span>
        </>
      ) : <span>{t('Ready when you are')}</span>}
      <span className={styles.statusHint}>
        {session.isImporting ? t('Importing images…') : session.isProjectBusy ? t('Working…') : hint}
      </span>
    </div>
  );
}
