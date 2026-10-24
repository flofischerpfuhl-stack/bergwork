/**
 * The tool header under the tabs (ContentView.swift): TransformInspector for Move, the navigation
 * header for Hand/Zoom, and tool-specific bars registered by other modules.
 */

import { isValidElement, useEffect, useState, type ReactNode } from 'react';
import styles from './editor.module.css';
import type { EditorController } from './controller';
import { useSessionSelector, useUi, useWorkspaceSelector } from './hooks';
import { Icon } from './icons';
import { LAYER_SAMPLINGS, scalePercent, scaledToPercent, type LayerTransform } from '../core/geometry';
import { makeTransform } from '../core/geometry';
import type { EditorSession } from '../core/session';
import { markUiRender } from './performance';
import { shortcutLabel } from './menus';

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
  markUiRender('TransformInspector');
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
      <span className={styles.headerTitle}>{session.transformTargetsMask ? t('Transform Mask') : session.perspectiveConstrained ? t('Perspective') : t('Transform')}</span>
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
  markUiRender('NavigationHeader');
  const t = controller.t;
  useSessionSelector(session, (current) => `${current.tool}|${current.document ? 1 : 0}|${current.viewport.zoom}`, Object.is, true);
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
  markUiRender('ContextBar');
  useUi(controller, () => controller.contextBars[controller.session.tool]);
  useUi(controller, () => controller.statusHints[controller.session.tool]);
  useWorkspaceSelector(controller, (workspace) => workspace.selectedId);
  const session = controller.session;
  useSessionSelector(session, (current) => {
    // Some feature wrappers choose their header from module-owned state (Quick Mask is the current example).
    // The matching status hint is a cheap scalar snapshot and changes at the same state boundary.
    const registeredHint = controller.statusHints[current.tool]?.(current) ?? '';
    if (current.tool === 'shape' || current.tool === 'pen' || current.tool === 'directSelect') {
      const node = controller.contextBars[current.tool]?.(current);
      const type = isValidElement(node) ? node.type : null;
      return `${current.tool}|${registeredHint}|${typeof type === 'string' ? type : type ? (type as { name?: string }).name ?? 'component' : ''}`;
    }
    if (current.tool === 'text') return `${current.tool}|${registeredHint}`;
    if (current.tool !== 'move') return `${current.tool}|${registeredHint}`;
    const layer = current.activeLayer;
    const transform = current.transformEdit?.draft ?? (layer ? current.editedTransform(layer) : null);
    const size = current.transformPixelSize ?? layer?.transform.size ?? null;
    return JSON.stringify([
      current.tool, current.activeLayerId, current.isMaskSelected, current.transformTargetsMask,
      current.perspectiveConstrained, current.canTransform, current.transformAutoSelect,
      current.showsTransformControls, current.locksTransformRatio, current.transformEdit?.corners ?? null,
      transform, size,
    ]);
  });
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
  markUiRender('StatusBar');
  useUi(controller, () => controller.statusHints[controller.session.tool]);
  useWorkspaceSelector(controller, (workspace) => workspace.selectedId);
  const session = controller.session;
  useSessionSelector(session, (current) => JSON.stringify([
    current.tool, current.document?.width ?? 0, current.document?.height ?? 0,
    current.viewport.zoom, current.isImporting, current.isProjectBusy,
    controller.statusHints[current.tool]?.(current) ?? statusHint(current, controller.t),
  ]), Object.is, true);
  const t = controller.t;
  const document = session.document;
  const zoom = session.viewport.zoom * 100;
  const hint = controller.statusHints[session.tool]?.(session) ?? statusHint(session, t);
  const activity = session.isImporting ? t('Importing images…') : session.isProjectBusy ? t('Working…') : '';
  const busy = activity || hint;
  // The status bar is a row of islands (Builder status bar): zoom, the document's facts, the tool hint.
  return (
    <div className={styles.status} role="status" data-testid="status-bar">
      <span className={`${styles.statusIsland} ${styles.zoomGroup}`}>
        <button type="button" className={styles.iconButton} disabled={!document} aria-label={t('Zoom out')}
          title={`${t('Zoom Out')} (${shortcutLabel('mod+-')})`} onClick={() => session.zoomTo(session.viewport.zoom / 1.25)}><Icon name="zoomOut" size={16} /></button>
        <span className={styles.statusZoom} data-testid="zoomStatus">{document ? `${zoom >= 10 ? Math.round(zoom * 10) / 10 : Math.round(zoom * 100) / 100}%` : '–'}</span>
        <button type="button" className={styles.iconButton} disabled={!document} aria-label={t('Zoom in')}
          title={`${t('Zoom In')} (${shortcutLabel('mod+=')})`} onClick={() => session.zoomTo(session.viewport.zoom * 1.25)}><Icon name="zoomIn" size={16} /></button>
        <button type="button" className={`${styles.iconButton} ${styles.statusTabletOptional}`} disabled={!document} onClick={() => session.fit()}
          title={`${t('Fit Canvas')} (${shortcutLabel('mod+0')})`} data-testid="fit">{t('Fit')}</button>
        <button type="button" className={`${styles.iconButton} ${styles.statusTabletOptional}`} disabled={!document} onClick={() => session.zoomTo(1)}
          title={`${t('Actual Pixels')} (${shortcutLabel('mod+1')})`}>100%</button>
      </span>
      <span className={`${styles.statusIsland} ${styles.statusFacts}`} data-testid={document ? 'status-facts' : undefined}>
        {document ? (
          <>
            <span data-testid="canvasDimensions">{document.width.toLocaleString(controller.locale)} × {document.height.toLocaleString(controller.locale)} px</span>
            <span>sRGB · Transparent</span>
          </>
        ) : <span>{t('Ready when you are')}</span>}
      </span>
      {busy ? (
        <span className={`${styles.statusIsland} ${styles.statusHint} ${activity ? '' : styles.statusTabletOptional}`} title={busy}>{busy}</span>
      ) : null}
    </div>
  );
}
