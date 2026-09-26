/**
 * Context bars of the Shape, Pen and Path/Direct Selection tools (Photoshop's options bar, PRODUCT-PLAN A5): fill and
 * stroke paints, stroke width and options, the primitive's own parameters and the path operation. With a shape layer
 * selected every change applies to it live (a scrub or a colour pick is one undo step) and is remembered for the next
 * shape.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import styles from '../../ui/editor.module.css';
import css from './vector.module.css';
import type { EditorController } from '../../ui/controller';
import { useSession } from '../../ui/hooks';
import { Icon } from '../../ui/icons';
import { useAnchoredPopover } from '../../ui/popovers';
import type { EditorSession } from '../../core/session';
import type { FillParameters, Layer, RGB } from '../../core/model';
import { changeLayer, liveEdit, withShapeParameters } from './edits';
import {
  MARKERS, PATH_OPERATIONS, SHAPE_KINDS, pathTarget, shapeRecord, solid, strokeOf, strokeOptionsOf, strokePaintOf, vectorState,
  type Marker, type PathOperation, type ShapeKind, type StrokeOptions, type VectorToolState,
} from './state';
import type { VectorBooleanOperation } from '../../core/vector';

type VectorLayer = Extract<Layer, { kind: 'vector' }>;

export interface VectorBarCommands {
  combine(operation: VectorBooleanOperation): void;
  canCombine(): boolean;
  merge(): void;
  canMerge(): boolean;
}

// MARK: Model

function activeShape(session: EditorSession): VectorLayer | null {
  const target = pathTarget(session);
  return target && !target.mask && target.layer.kind === 'vector' ? target.layer : null;
}

/** Shows a newly selected shape layer's primitive and parameters in the bar. */
function syncFromLayer(state: VectorToolState, layer: VectorLayer | null): void {
  if (!layer || layer.id === state.syncedLayerId) return;
  state.syncedLayerId = layer.id;
  const shape = layer.sourceShape;
  if (shape) {
    state.kind = shape.kind;
    if (shape.kind === 'Rectangle') {
      const radii = shape.cornerRadii ?? [shape.cornerRadius, shape.cornerRadius, shape.cornerRadius, shape.cornerRadius];
      state.radii = [...radii] as [number, number, number, number];
      state.radiiLinked = radii.every((value) => value === radii[0]);
    } else if (shape.kind === 'Polygon') { state.sides = shape.sides ?? state.sides; state.polygonRadius = shape.cornerRadius; }
    else if (shape.kind === 'Star') { state.points = shape.sides ?? state.points; state.innerRatio = shape.innerRatio ?? state.innerRatio; state.starRadius = shape.cornerRadius; }
  } else if (layer.paths.length === 1 && !layer.paths[0]!.closed && layer.paths[0]!.points.length === 2) state.kind = 'Line';
  // Photoshop: the options bar shows the selected shape's fill and stroke, and new shapes use them.
  state.fill = layer.style.fill;
  state.strokePaint = strokePaintOf(layer.style.stroke);
  if (layer.style.stroke) state.stroke = strokeOptionsOf(layer.style.stroke, state.stroke);
}

interface StyleModel {
  readonly state: VectorToolState;
  readonly layer: VectorLayer | null;
  readonly fill: FillParameters | null;
  readonly strokePaint: FillParameters | null;
  readonly stroke: StrokeOptions;
  setFill(fill: FillParameters | null, live?: boolean): void;
  setStrokePaint(paint: FillParameters | null, live?: boolean): void;
  setStroke(patch: Partial<StrokeOptions>, live?: boolean): void;
  endLive(): void;
}

function styleModel(session: EditorSession, withLayer = true): StyleModel {
  const state = vectorState(session), layer = withLayer ? activeShape(session) : null;
  const fill = layer ? layer.style.fill : state.fill;
  const strokePaint = layer ? strokePaintOf(layer.style.stroke) : state.strokePaint;
  const stroke = layer?.style.stroke ? strokeOptionsOf(layer.style.stroke, state.stroke) : state.stroke;
  const apply = (name: string, style: VectorLayer['style'], live: boolean) => {
    if (layer && !session.refuseLayerEdit(layer.id, 'appearance')) changeLayer(session, name, { ...layer, style: { ...style, schemaVersion: 1 as const }, raster: null }, live);
    session.notify('ui');
  };
  return {
    state, layer, fill, strokePaint, stroke,
    setFill: (next, live = false) => { state.fill = next; if (layer) apply('Set Fill', { ...layer.style, fill: next }, live); else session.notify('ui'); },
    setStrokePaint: (next, live = false) => {
      state.strokePaint = next;
      if (layer) apply('Set Stroke', { ...layer.style, stroke: strokeOf(next, stroke) }, live); else session.notify('ui');
    },
    setStroke: (patch, live = false) => {
      const next = { ...stroke, ...patch };
      state.stroke = next;
      if (layer?.style.stroke) apply('Set Stroke', { ...layer.style, stroke: strokeOf(strokePaint, next) }, live); else session.notify('ui');
    },
    endLive: () => liveEdit(session).end(),
  };
}

// MARK: Small controls

const hex = (c: RGB) => `#${[c.red, c.green, c.blue].map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('')}`;
const rgba = (c: RGB, a = 1) => `rgba(${Math.round(c.red * 255)}, ${Math.round(c.green * 255)}, ${Math.round(c.blue * 255)}, ${a})`;

export function paintCss(paint: FillParameters | null): string {
  if (!paint) return '#fff';
  if (paint.kind === 'solid') return hex(paint.color);
  if (paint.kind === 'gradient') {
    const stops = [...paint.stops].sort((a, b) => a.offset - b.offset).map((s) => `${rgba(s.color, s.opacity)} ${Math.round(s.offset * 100)}%`);
    return `linear-gradient(${paint.angle + 90}deg, ${stops.join(', ')}), repeating-conic-gradient(#999 0 25%, #fff 0 50%) 0 0/8px 8px`;
  }
  return 'repeating-linear-gradient(45deg, #888 0 3px, #bbb 3px 6px)';
}

function format(value: number, locale: string): string {
  return value.toLocaleString(locale, { maximumFractionDigits: 2, useGrouping: false });
}

/**
 * A number with a scrubby label (drag left/right, one undo step) that commits on Enter, on leaving the field or per
 * ↑/↓ step (Shift ×10).
 */
function ValueField({ label, value, onChange, onEnd, locale, suffix, min = -Infinity, max = Infinity, step = 1, testId, hideLabel, disabled, narrow }: {
  label: string; value: number; onChange: (value: number, live: boolean) => void; onEnd: () => void; locale: string; suffix?: string;
  min?: number; max?: number; step?: number; testId?: string; hideLabel?: boolean; disabled?: boolean; narrow?: boolean;
}) {
  const shown = format(value, locale);
  const [text, setText] = useState(shown);
  const [focused, setFocused] = useState(false);
  const skip = useRef(false);
  useEffect(() => { if (!focused) setText(shown); }, [shown, focused]);
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  const commit = () => {
    const number = Number(text.trim().replace(',', '.'));
    if (text.trim() !== '' && Number.isFinite(number) && clamp(number) !== value) onChange(clamp(number), false);
    else setText(shown);
  };
  const scrub = (event: React.PointerEvent<HTMLSpanElement>) => {
    if (disabled || event.button !== 0) return;
    const element = event.currentTarget, start = event.clientX, from = value;
    element.setPointerCapture?.(event.pointerId);
    let moved = false;
    const move = (e: PointerEvent) => {
      const dx = e.clientX - start;
      if (!moved && Math.abs(dx) < 2) return;
      moved = true;
      const factor = e.shiftKey ? 10 : 1;
      onChange(clamp(Math.round((from + dx * step * factor) / step) * step), true);
    };
    const up = () => {
      element.removeEventListener('pointermove', move); element.removeEventListener('pointerup', up); element.removeEventListener('pointercancel', up);
      if (moved) onEnd();
    };
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', up);
    element.addEventListener('pointercancel', up);
    event.preventDefault();
  };
  return (
    <label className={css.field}>
      {hideLabel ? null : <span className={css.scrub} onPointerDown={scrub} title={label}>{label}</span>}
      <input className={`${css.number} ${narrow ? css.narrow : ''}`} inputMode="decimal" value={text} aria-label={label} title={label} data-testid={testId}
        disabled={disabled}
        onFocus={(event) => { setFocused(true); event.currentTarget.select(); }}
        onBlur={() => { setFocused(false); if (skip.current) skip.current = false; else commit(); }}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault();
            const next = clamp(value + step * (event.shiftKey ? 10 : 1) * (event.key === 'ArrowUp' ? 1 : -1));
            setText(format(next, locale));
            onChange(next, false);
          } else if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
          else if (event.key === 'Escape') { skip.current = true; setText(shown); event.currentTarget.blur(); }
        }} />
      {suffix ? <span className={css.unit}>{suffix}</span> : null}
    </label>
  );
}

function Segmented<T extends string>({ value, options, onChange, label, fill }: {
  value: T; options: readonly { value: T; label: string; content?: ReactNode; testId?: string }[]; onChange: (value: T) => void; label: string; fill?: boolean;
}) {
  return (
    <div className={`${styles.segmented} ${fill ? css.segmentedFill : ''}`} role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button key={option.value} type="button" role="radio" aria-checked={value === option.value} aria-label={option.content ? option.label : undefined}
          title={option.label} data-testid={option.testId}
          className={`${styles.segment} ${value === option.value ? styles.segmentOn : ''} ${option.content ? css.kind : ''}`}
          onClick={() => onChange(option.value)}>{option.content ?? option.label}</button>
      ))}
    </div>
  );
}

/** A popover under its button; closes on Escape and on presses outside it (the colour picker is not outside). */
function usePopover(open: boolean, close: () => void, anchor: React.RefObject<HTMLElement | null>, panel: React.RefObject<HTMLElement | null>, width = 330) {
  const placement = useAnchoredPopover(open, anchor, width);
  useEffect(() => {
    if (!open) return;
    const down = (event: PointerEvent) => {
      const target = event.target as Element;
      if (panel.current?.contains(target) || anchor.current?.contains(target) || target.closest?.('[data-testid="color-picker"]')) return;
      close();
    };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } };
    globalThis.addEventListener('pointerdown', down, true);
    globalThis.addEventListener('keydown', key, true);
    return () => { globalThis.removeEventListener('pointerdown', down, true); globalThis.removeEventListener('keydown', key, true); };
  }, [open, close, anchor, panel]);
  return placement;
}

/** A colour well that opens the app's colour picker, previewing live (one undo step when committed). */
function ColorWell({ controller, session, title, color, onChange, testId }: {
  controller: EditorController; session: EditorSession; title: string; color: RGB; onChange: (color: RGB, live: boolean) => void; testId?: string;
}) {
  if (!controller.pickColor) {
    return <input type="color" className={css.well} value={hex(color)} aria-label={title} data-testid={testId}
      onChange={(event) => { const v = event.target.value; onChange({ red: parseInt(v.slice(1, 3), 16) / 255, green: parseInt(v.slice(3, 5), 16) / 255, blue: parseInt(v.slice(5, 7), 16) / 255 }, false); }} />;
  }
  return (
    <button type="button" className={css.well} style={{ background: hex(color) }} aria-label={title} title={title} data-testid={testId}
      onClick={() => controller.pickColor?.({
        title, initial: color,
        preview: (c) => onChange(c, true),
        commit: (c) => { onChange(c, true); liveEdit(session).end(); },
        cancel: () => { liveEdit(session).cancel(); onChange(color, false); },
      })} />
  );
}

// MARK: Fill / stroke paint

function PaintControl({ controller, session, label, paint, onChange, testId, allowNone = true }: {
  controller: EditorController; session: EditorSession; label: string; paint: FillParameters | null;
  onChange: (paint: FillParameters | null, live?: boolean) => void; testId: string; allowNone?: boolean;
}) {
  const t = controller.t;
  const name = label.replace(/:$/, '');
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const close = () => setOpen(false);
  const placement = usePopover(open, close, button, panel);
  const kind = !paint ? 'none' : paint.kind === 'gradient' ? 'gradient' : 'solid';
  const fg = session.foregroundColor, bg = session.backgroundColor;
  const base: RGB = paint?.kind === 'solid' ? paint.color : paint?.kind === 'gradient' ? [...paint.stops].sort((a, b) => a.offset - b.offset)[0]!.color : fg;
  const choose = (next: 'none' | 'solid' | 'gradient') => {
    if (next === kind) return;
    if (next === 'none') onChange(null);
    else if (next === 'solid') onChange(solid(base));
    else onChange({ kind: 'gradient', schemaVersion: 1, angle: 0, stops: [
      { offset: 0, color: { ...base }, opacity: 1 }, { offset: 1, color: { ...(base === bg ? fg : bg) }, opacity: 1 }] });
  };
  const options = [
    ...(allowNone ? [{ value: 'none' as const, label: t('None'), testId: `${testId}-none` }] : []),
    { value: 'solid' as const, label: t('Color'), testId: `${testId}-solid` },
    { value: 'gradient' as const, label: t('Gradient'), testId: `${testId}-gradient` },
  ];
  return (
    <span className={css.group}>
      <span className={css.label}>{label}</span>
      <button ref={button} type="button" className={`${css.paintButton} ${paint ? '' : css.paintNone}`} style={{ background: paintCss(paint) }}
        aria-label={name} title={name} aria-expanded={open} data-testid={testId} onClick={() => setOpen(!open)} />
      {open && placement ? createPortal(
        <div ref={panel} className={css.popover} style={placement.style} role="dialog" aria-label={name} data-testid={`${testId}-popover`}>
          <p className={css.popoverTitle}>{name}</p>
          <Segmented label={name} value={kind} options={options} onChange={choose} fill />
          {paint?.kind === 'solid' ? (
            <div className={css.row}>
              <span className={css.rowLabel}>{t('Color')}</span>
              <ColorWell controller={controller} session={session} title={`${name} · ${t('Color')}`} color={paint.color} testId={`${testId}-color`}
                onChange={(color, live) => onChange(solid(color), live)} />
              <span className={css.swatchRow}>
                {[[fg, t('Foreground color')], [bg, t('Background color')]].map(([color, name]) => (
                  <button key={name as string} type="button" className={css.miniSwatch} style={{ background: hex(color as RGB) }} title={name as string}
                    aria-label={name as string} onClick={() => onChange(solid(color as RGB))} />
                ))}
              </span>
            </div>
          ) : null}
          {paint?.kind === 'gradient' ? <GradientControls controller={controller} session={session} label={name} paint={paint} onChange={onChange} testId={testId} /> : null}
        </div>, placement.target
      ) : null}
    </span>
  );
}

function GradientControls({ controller, session, label, paint, onChange, testId }: {
  controller: EditorController; session: EditorSession; label: string; paint: Extract<FillParameters, { kind: 'gradient' }>;
  onChange: (paint: FillParameters | null, live?: boolean) => void; testId: string;
}) {
  const t = controller.t;
  const set = (patch: Partial<typeof paint>, live = false) => onChange({ ...paint, ...patch }, live);
  const setStop = (index: number, patch: Partial<typeof paint.stops[number]>, live = false) =>
    set({ stops: paint.stops.map((stop, i) => (i === index ? { ...stop, ...patch } : stop)) }, live);
  return (
    <>
      <div className={css.row}>
        <span className={css.rowLabel}>{t('Gradient')}</span>
        <span className={css.ramp} style={{ background: paintCss({ ...paint, angle: 0 }) }} />
      </div>
      <div className={css.stops}>
        {paint.stops.map((stop, index) => (
          <div key={index} className={css.stop} data-testid={`${testId}-stop`}>
            <span className={css.rowLabel}>{index === 0 ? t('Color Stop') : ''}</span>
            <ColorWell controller={controller} session={session} title={`${label} · ${t('Color Stop')} ${index + 1}`} color={stop.color}
              onChange={(color, live) => setStop(index, { color }, live)} />
            <ValueField label={`${t('Location')} ${index + 1}`} hideLabel value={Math.round(stop.offset * 1000) / 10} suffix="%" min={0} max={100}
              locale={controller.locale} narrow onEnd={() => liveEdit(session).end()} onChange={(v, live) => setStop(index, { offset: v / 100 }, live)} />
            {paint.stops.length > 2 ? (
              <button type="button" className={css.stopRemove} aria-label={`${t('Delete Color Stop')} ${index + 1}`} title={t('Delete Color Stop')}
                onClick={() => set({ stops: paint.stops.filter((_, i) => i !== index) })}><Icon name="close" size={10} /></button>
            ) : null}
          </div>
        ))}
      </div>
      <div className={css.row}>
        <span className={css.rowLabel}>{t('Angle')}</span>
        <ValueField label={t('Angle')} hideLabel value={paint.angle} suffix="°" min={-360} max={360} locale={controller.locale} testId={`${testId}-angle`}
          onEnd={() => liveEdit(session).end()} onChange={(v, live) => set({ angle: v }, live)} />
        <span className={styles.spacer} />
        <button type="button" className={styles.pill} onClick={() => set({ stops: paint.stops.map((stop) => ({ ...stop, offset: 1 - stop.offset })) })}>{t('Reverse')}</button>
        <button type="button" className={css.iconButton} aria-label={t('Add Color Stop')} title={t('Add Color Stop')}
          onClick={() => {
            const sorted = [...paint.stops].sort((a, b) => a.offset - b.offset);
            let at = 0;
            for (let i = 1; i < sorted.length - 1; i++) if (sorted[i + 1]!.offset - sorted[i]!.offset > sorted[at + 1]!.offset - sorted[at]!.offset) at = i;
            const a = sorted[at]!, b = sorted[at + 1] ?? a, mix = (x: number, y: number) => (x + y) / 2;
            set({ stops: [...paint.stops, { offset: mix(a.offset, b.offset), opacity: mix(a.opacity, b.opacity),
              color: { red: mix(a.color.red, b.color.red), green: mix(a.color.green, b.color.green), blue: mix(a.color.blue, b.color.blue) } }] });
          }}><Icon name="plus" size={12} /></button>
      </div>
    </>
  );
}

// MARK: Stroke options

const DASH_PRESETS = ['solid', 'dashed', 'dotted'] as const;
function dashPreset(stroke: StrokeOptions): typeof DASH_PRESETS[number] | 'custom' {
  if (!stroke.dash.length) return 'solid';
  const [dash, gap] = stroke.dash;
  if (stroke.dash.length === 2 && dash === 0 && stroke.cap === 'round' && Math.abs(gap! - stroke.width * 2) < 1e-6) return 'dotted';
  if (stroke.dash.length === 2 && Math.abs(dash! - stroke.width * 4) < 1e-6 && Math.abs(gap! - stroke.width * 2) < 1e-6) return 'dashed';
  return 'custom';
}

function StrokeOptionsControl({ controller, session, model }: { controller: EditorController; session: EditorSession; model: StyleModel }) {
  const t = controller.t;
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const placement = usePopover(open, () => setOpen(false), button, panel, 420);
  const stroke = model.stroke, preset = dashPreset(stroke);
  const end = () => liveEdit(session).end();
  const sample = stroke.dash.length ? stroke.dash.map((v) => Math.max(0.5, v / Math.max(1, stroke.width) * 2)).join(' ') : undefined;
  return (
    <>
      <button ref={button} type="button" className={css.strokeButton} aria-label={t('Stroke Options')} title={t('Stroke Options')} aria-expanded={open}
        data-testid="vector-stroke-options" onClick={() => setOpen(!open)}>
        <svg className={css.strokeSample} viewBox="0 0 34 10" aria-hidden>
          <line x1="2" y1="5" x2="32" y2="5" stroke="currentColor" strokeWidth="2" strokeDasharray={sample} strokeLinecap={stroke.cap === 'square' ? 'square' : stroke.cap} />
        </svg>
      </button>
      {open && placement ? createPortal(
        <div ref={panel} className={css.popover} style={{ ...placement.style, width: 420 }} role="dialog" aria-label={t('Stroke Options')} data-testid="vector-stroke-popover">
          <p className={css.popoverTitle}>{t('Stroke Options')}</p>
          <div className={css.row}>
            <span className={css.rowLabel}>{t('Alignment')}</span>
            <Segmented label={t('Alignment')} value={stroke.alignment} fill onChange={(alignment) => model.setStroke({ alignment })} options={[
              { value: 'inside', label: t('Inside'), testId: 'stroke-align-inside' }, { value: 'center', label: t('Center'), testId: 'stroke-align-center' },
              { value: 'outside', label: t('Outside'), testId: 'stroke-align-outside' }]} />
          </div>
          <div className={css.row}>
            <span className={css.rowLabel}>{t('Caps')}</span>
            <Segmented label={t('Caps')} value={stroke.cap} fill onChange={(cap) => model.setStroke({ cap })} options={[
              { value: 'butt', label: t('Butt'), testId: 'stroke-cap-butt' }, { value: 'round', label: t('Round'), testId: 'stroke-cap-round' },
              { value: 'square', label: t('Projecting'), testId: 'stroke-cap-square' }]} />
          </div>
          <div className={css.row}>
            <span className={css.rowLabel}>{t('Corners')}</span>
            <Segmented label={t('Corners')} value={stroke.join} fill onChange={(join) => model.setStroke({ join })} options={[
              { value: 'miter', label: t('Miter'), testId: 'stroke-join-miter' }, { value: 'round', label: t('Round'), testId: 'stroke-join-round' },
              { value: 'bevel', label: t('Bevel'), testId: 'stroke-join-bevel' }]} />
          </div>
          <div className={css.row}>
            <span className={css.rowLabel}>{t('Dashed Line')}</span>
            <Segmented label={t('Dashed Line')} value={preset === 'custom' ? 'dashed' : preset} fill
              onChange={(value) => model.setStroke(value === 'solid' ? { dash: [] } : value === 'dotted' ? { dash: [0, stroke.width * 2], cap: 'round' }
                : { dash: [stroke.width * 4, stroke.width * 2] })}
              options={[{ value: 'solid', label: t('Solid'), testId: 'stroke-dash-solid' }, { value: 'dashed', label: t('Dashed'), testId: 'stroke-dash-dashed' },
                { value: 'dotted', label: t('Dotted'), testId: 'stroke-dash-dotted' }]} />
          </div>
          <div className={css.row}>
            <span className={css.rowLabel} />
            <ValueField label={t('Dash')} value={stroke.dash[0] ?? 0} suffix="px" min={0} max={10_000} locale={controller.locale} testId="stroke-dash"
              onEnd={end} onChange={(v, live) => model.setStroke({ dash: [v, stroke.dash[1] ?? Math.max(1, v)] }, live)} />
            <ValueField label={t('Gap')} value={stroke.dash[1] ?? 0} suffix="px" min={0} max={10_000} locale={controller.locale} testId="stroke-gap"
              onEnd={end} onChange={(v, live) => model.setStroke({ dash: [stroke.dash[0] ?? Math.max(1, v), v] }, live)} />
          </div>
        </div>, placement.target
      ) : null}
    </>
  );
}

function StyleControls({ controller, session, model, line = false }: { controller: EditorController; session: EditorSession; model: StyleModel; line?: boolean }) {
  const t = controller.t;
  return (
    <>
      {line ? null : <PaintControl controller={controller} session={session} label={t('Fill:')} paint={model.fill} testId="vector-fill"
        onChange={(paint, live) => model.setFill(paint, live)} />}
      <PaintControl controller={controller} session={session} label={t('Stroke:')} paint={line ? model.strokePaint ?? model.fill : model.strokePaint}
        testId="vector-stroke" allowNone={!line} onChange={(paint, live) => model.setStrokePaint(paint, live)} />
      <ValueField label={t('Stroke Width')} hideLabel value={model.stroke.width} suffix="px" min={0} max={1000} step={1} locale={controller.locale}
        testId="vector-stroke-width" onEnd={model.endLive} onChange={(width, live) => model.setStroke({ width }, live)} />
      <StrokeOptionsControl controller={controller} session={session} model={model} />
    </>
  );
}

// MARK: Markers

function MarkerControls({ controller, session, model: shown }: { controller: EditorController; session: EditorSession; model: StyleModel }) {
  const t = controller.t;
  // Arrowheads change the selected shape only when it has an open path; otherwise they set up the next line.
  const model = hasOpenPath(shown.layer) ? shown : styleModel(session, false);
  const names: Record<Marker, string> = { none: t('None'), arrow: t('Arrow'), openArrow: t('Open Arrow'), circle: t('Circle'), square: t('Square') };
  const select = (which: 'startMarker' | 'endMarker', label: string) => (
    <select className={`${styles.select} ${css.select}`} aria-label={label} title={label} value={model.stroke[which]} data-testid={`vector-${which}`}
      onChange={(event) => model.setStroke({ [which]: event.target.value as Marker })}>
      {MARKERS.map((marker) => <option key={marker} value={marker}>{names[marker]}</option>)}
    </select>
  );
  return (
    <span className={css.group} role="group" aria-label={t('Arrowheads')}>
      <span className={css.label}>{t('Arrowheads')}</span>
      {select('startMarker', t('Start'))}
      {select('endMarker', t('End'))}
      <ValueField label={t('Size')} value={Math.round(model.stroke.markerSize * 100)} suffix="%" min={50} max={2000} step={10} locale={controller.locale}
        testId="vector-marker-size" onEnd={model.endLive} onChange={(v, live) => model.setStroke({ markerSize: v / 100 }, live)} />
    </span>
  );
}

// MARK: Shape kinds and parameters

const KIND_ICONS: Record<ShapeKind, ReactNode> = {
  Rectangle: <rect x="3" y="4.5" width="14" height="11" rx="1.2" />,
  Ellipse: <ellipse cx="10" cy="10" rx="7.5" ry="6" />,
  Polygon: <path d="M10 2.8 16.6 7.5 14.1 15.6H5.9L3.4 7.5z" />,
  Star: <path d="M10 2.5l2.2 4.8 5.2.6-3.9 3.5 1.1 5.2L10 14l-4.6 2.6 1.1-5.2-3.9-3.5 5.2-.6z" />,
  Line: <path d="M3.5 16.5 16.5 3.5" />,
};

function ShapeParameters({ controller, session, state, layer }: { controller: EditorController; session: EditorSession; state: VectorToolState; layer: VectorLayer | null }) {
  const t = controller.t, locale = controller.locale;
  const live = layer?.sourceShape?.kind === state.kind ? layer : null;
  const update = (change: () => void, isLive: boolean) => {
    change();
    if (live && !session.refuseLayerEdit(live.id, 'pixels')) {
      const shape = shapeRecord(state, state.kind, { red: live.sourceShape!.red, green: live.sourceShape!.green, blue: live.sourceShape!.blue });
      changeLayer(session, 'Change Shape', withShapeParameters(live, shape), isLive);
    }
    session.notify('ui');
  };
  const end = () => liveEdit(session).end();
  switch (state.kind) {
    case 'Rectangle': {
      const corners = [t('Top Left'), t('Top Right'), t('Bottom Right'), t('Bottom Left')];
      return (
        <span className={css.group}>
          {state.radiiLinked ? (
            <ValueField label={t('Radius')} value={state.radii[0]} suffix="px" min={0} max={5000} locale={locale} testId="vector-radius" onEnd={end}
              onChange={(v, isLive) => update(() => { state.radii = [v, v, v, v]; }, isLive)} />
          ) : (
            <>
              <span className={css.label}>{t('Radius')}</span>
              {state.radii.map((value, index) => (
                <ValueField key={index} label={`${t('Radius')} ${corners[index]}`} hideLabel narrow value={value} min={0} max={5000} locale={locale}
                  testId={`vector-radius-${index}`} onEnd={end}
                  onChange={(v, isLive) => update(() => { const radii = [...state.radii] as typeof state.radii; radii[index] = v; state.radii = radii; }, isLive)} />
              ))}
              <span className={css.unit}>px</span>
            </>
          )}
          <button type="button" className={`${css.iconButton} ${state.radiiLinked ? css.iconButtonOn : ''}`} aria-pressed={state.radiiLinked}
            aria-label={t('Link corner radii')} title={t('Link corner radii')} data-testid="vector-radius-link"
            onClick={() => update(() => { state.radiiLinked = !state.radiiLinked; if (state.radiiLinked) state.radii = [state.radii[0], state.radii[0], state.radii[0], state.radii[0]]; }, false)}>
            <Icon name="link" size={14} />
          </button>
        </span>
      );
    }
    case 'Polygon':
      return (
        <span className={css.group}>
          <ValueField label={t('Sides')} value={state.sides} min={3} max={100} locale={locale} testId="vector-sides" onEnd={end}
            onChange={(v, isLive) => update(() => { state.sides = Math.round(v); }, isLive)} />
          <ValueField label={t('Corner Radius')} value={state.polygonRadius} suffix="px" min={0} max={5000} locale={locale} testId="vector-corner-radius" onEnd={end}
            onChange={(v, isLive) => update(() => { state.polygonRadius = v; }, isLive)} />
        </span>
      );
    case 'Star':
      return (
        <span className={css.group}>
          <ValueField label={t('Points')} value={state.points} min={3} max={100} locale={locale} testId="vector-points" onEnd={end}
            onChange={(v, isLive) => update(() => { state.points = Math.round(v); }, isLive)} />
          <ValueField label={t('Star Ratio')} value={Math.round(state.innerRatio * 100)} suffix="%" min={1} max={99} locale={locale} testId="vector-star-ratio" onEnd={end}
            onChange={(v, isLive) => update(() => { state.innerRatio = v / 100; }, isLive)} />
          <ValueField label={t('Corner Radius')} value={state.starRadius} suffix="px" min={0} max={5000} locale={locale} testId="vector-corner-radius" onEnd={end}
            onChange={(v, isLive) => update(() => { state.starRadius = v; }, isLive)} />
        </span>
      );
    default: return null;
  }
}

function OperationSelect({ controller, state, session }: { controller: EditorController; state: VectorToolState; session: EditorSession }) {
  const t = controller.t;
  const names: Record<PathOperation, string> = { new: t('New Layer'), unite: t('Combine Shapes'), subtract: t('Subtract Front Shape'),
    intersect: t('Intersect Shape Areas'), exclude: t('Exclude Overlapping Shapes') };
  return (
    <select className={`${styles.select} ${css.select}`} aria-label={t('Path Operations')} title={t('Path Operations')} value={state.operation}
      data-testid="vector-operation" onChange={(event) => { state.operation = event.target.value as PathOperation; session.notify('ui'); }}>
      {PATH_OPERATIONS.map((operation) => <option key={operation} value={operation}>{names[operation]}</option>)}
    </select>
  );
}

function hasOpenPath(layer: VectorLayer | null): boolean { return !!layer?.paths.some((path) => !path.closed); }

// MARK: Bars

export function ShapeBar({ controller, session }: { controller: EditorController; session: EditorSession }) {
  useSession(session);
  const t = controller.t;
  const model = styleModel(session);
  syncFromLayer(model.state, model.layer);
  const state = model.state, line = state.kind === 'Line';
  return (
    <>
      <span className={styles.headerTitle}>{t('Shape')}</span>
      <Segmented label={t('Shape')} value={state.kind} onChange={(kind) => { state.kind = kind; state.shapeDraft = null; session.notify('ui'); }}
        options={SHAPE_KINDS.map((kind) => ({ value: kind, label: t(kind), testId: `vector-kind-${kind}`,
          content: <svg className={css.kindIcon} viewBox="0 0 20 20" aria-hidden>{KIND_ICONS[kind]}</svg> }))} />
      <StyleControls controller={controller} session={session} model={model} line={line} />
      {line ? <MarkerControls controller={controller} session={session} model={model} /> : <ShapeParameters controller={controller} session={session} state={state} layer={model.layer} />}
      <OperationSelect controller={controller} state={state} session={session} />
    </>
  );
}

export function PenBar({ controller, session }: { controller: EditorController; session: EditorSession }) {
  useSession(session);
  const t = controller.t;
  const model = styleModel(session);
  syncFromLayer(model.state, model.layer);
  return (
    <>
      <span className={styles.headerTitle}>{t('Pen')}</span>
      <StyleControls controller={controller} session={session} model={model} />
      {hasOpenPath(model.layer) ? <MarkerControls controller={controller} session={session} model={model} /> : null}
      <OperationSelect controller={controller} state={model.state} session={session} />
    </>
  );
}

const BOOLEAN_ICONS: Record<VectorBooleanOperation, ReactNode> = {
  unite: <path d="M2.5 2.5h8v4h4v8h-8v-4h-4z" fill="currentColor" />,
  subtract: <><path d="M2.5 2.5h8v4h-4v4h-4z" fill="currentColor" /><path d="M6.5 6.5h8v8h-8z" /></>,
  intersect: <><path d="M2.5 2.5h8v8h-8zM6.5 6.5h8v8h-8z" /><path d="M6.5 6.5h4v4h-4z" fill="currentColor" /></>,
  exclude: <path d="M2.5 2.5h8v4h-4v4h-4zM10.5 6.5h4v8h-8v-4h4z" fill="currentColor" />,
};

export function DirectSelectBar({ controller, session, commands }: { controller: EditorController; session: EditorSession; commands: VectorBarCommands }) {
  useSession(session);
  const t = controller.t;
  const model = styleModel(session);
  syncFromLayer(model.state, model.layer);
  const state = model.state;
  const names: Record<VectorBooleanOperation, string> = { unite: t('Unite Shapes'), subtract: t('Subtract Front Shape'),
    intersect: t('Intersect Shape Areas'), exclude: t('Exclude Overlapping Shapes') };
  return (
    <>
      <span className={styles.headerTitle}>{t(state.selectMode === 'path' ? 'Path Selection' : 'Direct Selection')}</span>
      <Segmented label={t('Selection')} value={state.selectMode} onChange={(mode) => { state.selectMode = mode; session.notify('ui'); }} options={[
        { value: 'direct', label: t('Direct Selection'), content: <Icon name="directSelect" size={15} />, testId: 'vector-mode-direct' },
        { value: 'path', label: t('Path Selection'), content: <Icon name="pathSelect" size={15} />, testId: 'vector-mode-path' }]} />
      {model.layer ? <StyleControls controller={controller} session={session} model={model} /> : null}
      {hasOpenPath(model.layer) ? <MarkerControls controller={controller} session={session} model={model} /> : null}
      <span className={css.group} role="group" aria-label={t('Combine Shapes')}>
        {(['unite', 'subtract', 'intersect', 'exclude'] as const).map((operation) => (
          <button key={operation} type="button" className={css.iconButton} aria-label={names[operation]} title={names[operation]}
            data-testid={`vector-combine-${operation}`} disabled={!commands.canCombine()} onClick={() => commands.combine(operation)}>
            <svg width="17" height="17" viewBox="0 0 17 17" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden>{BOOLEAN_ICONS[operation]}</svg>
          </button>
        ))}
        <button type="button" className={styles.pill} disabled={!commands.canMerge()} onClick={() => commands.merge()} data-testid="vector-merge">{t('Merge Shapes')}</button>
      </span>
    </>
  );
}
