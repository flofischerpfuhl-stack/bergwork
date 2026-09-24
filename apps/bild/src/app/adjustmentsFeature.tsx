/**
 * Image adjustments, filters and adjustment layers in the UI: the Image/Filter menu commands, the
 * non-modal panels (LevelsSheet, HueSaturationSheet, CurvesControls and FilterSheet.swift) and
 * canvas sampling for the Levels and Hue/Saturation eyedroppers. The engines and their edit state
 * machines live in core/adjust and core/filters.
 *
 * One panel serves both destructive edits of a layer's pixels and live adjustment-layer edits
 * (AdjustmentEditing.swift): the controls only see settings and a change callback.
 */

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import styles from '../ui/editor.module.css';
import type { EditorController } from '../ui/controller';
import { useSession } from '../ui/hooks';
import { NumberField } from '../ui/ContextBar';
import type { ToolContext, ToolHandler } from '../ui/canvas/tools';
import { editBlockers, type EditorSession } from '../core/session';
import { FloatingPanel } from './panels';
import { hierarchyEntries, type CanvasDocument, type LayerAdjustment } from '../core/document';
import { apply, invert, makeTransform, pixelToDocument, type Point } from '../core/geometry';
import { Raster } from '../core/raster';
import {
  COLOR_RANGES, COLORIZE_START, DEFAULT_BANDS, LEVELS_CHANNELS, defaultCurves, defaultHueSaturation, defaultLevels,
  defaultLevelRange, defaultRangeAdjustment, normalizeLevelRange, resolveAdjustment,
  type ColorRange, type CurvePoint, type CurvesSettings, type ExposureSettings, type GradientMapSettings, type GrainSettings,
  type HueSaturationSettings, type LevelRange, type LevelsSettings, type RGB,
} from '../core/adjustments';
import {
  adjustmentCommands, adjustmentLayerEditState, applyHueSaturationEdit, applyLevelsEdit, autoLevels, beginAdjustmentLayerEdit,
  beginHueTarget, cancelHueSaturationEdit, cancelLevelsEdit, curveValue, dragHueTarget, finishAdjustmentLayerEdit,
  fromHsl, adjustHueColor, histogramDisplayScale, hueSaturationEditState, levelsEditState, sampleHueRange, sampleLevels,
  setHueBandHandle, toHsl, updateAdjustmentLayerEdit, updateHueSaturationEdit, updateLevelsEdit,
  type HueSampleMode, type HueTargetDrag, type LevelsAuto, type LevelsSample,
} from '../core/adjust';
import { histogramPixelJob } from '../core/adjust/pixelWorkerClient';
import { applyFilterEdit, cancelFilterEdit, filterEditState, updateFilterEdit } from '../core/filters/editing';
import type { FilterKind, FilterSettings } from '../core/filters/settings';
import { adjustmentName, P2AdjustmentControls, settlePendingLuts } from './adjust/controls';
import { finishLiveFilterEdit, LIVE_FILTER_NAMES, liveFilterEditState, updateLiveFilterEdit } from './adjust/liveFilters';
import { installAdjustP2 } from './adjust/install';

// MARK: Edit state outside the engines (sampling modes, the adjustment-layer histogram)

interface PanelState {
  levelsSample: LevelsSample | null;
  hueSample: HueSampleMode | null;
  hueTargeting: boolean;
  /** Underlying-pixels histogram for an adjustment layer's Levels edit (the pixel edit carries its own). */
  layerHistogram: { layerId: string; bins: readonly Float64Array[] | null } | null;
}
const panelStates = new WeakMap<EditorSession, PanelState>();
function panelState(session: EditorSession): PanelState {
  let state = panelStates.get(session);
  if (!state) { state = { levelsSample: null, hueSample: null, hueTargeting: false, layerHistogram: null }; panelStates.set(session, state); }
  return state;
}
function resetPanelState(session: EditorSession): void { panelStates.delete(session); }

type Edit =
  | { kind: 'levels'; settings: LevelsSettings; histogram: readonly Float64Array[] | null; preview: boolean; committing: boolean; layer: boolean }
  | { kind: 'hue'; settings: HueSaturationSettings; preview: boolean; committing: boolean; layer: boolean }
  | { kind: 'filter'; filter: FilterKind; settings: FilterSettings; preview: boolean; committing: boolean; preparing: boolean; error: string | null }
  | { kind: 'curves' | 'exposure' | 'gradientMap' | 'grain'; value: LayerAdjustment; preview: boolean; layer: true }
  /** A Phase-2 adjustment layer (controls in adjust/controls.tsx). */
  | { kind: 'p2'; value: LayerAdjustment; preview: boolean; layer: true }
  /** A live filter on a layer: the destructive filter's panel, previewing through the layer's filter stack. */
  | { kind: 'liveFilter'; filter: FilterKind; settings: FilterSettings; preview: boolean };

/** The open edit, whichever engine owns it. */
function currentEdit(session: EditorSession): Edit | null {
  const layerEdit = adjustmentLayerEditState(session);
  if (layerEdit) {
    const value = resolveAdjustment(layerEdit.value);
    const preview = layerEdit.preview;
    switch (value.kind) {
      case 'Levels': return { kind: 'levels', settings: value.levels, histogram: panelState(session).layerHistogram?.bins ?? null, preview, committing: false, layer: true };
      case 'Hue/Saturation': return { kind: 'hue', settings: value.hsvSettings, preview, committing: false, layer: true };
      case 'Curves': return { kind: 'curves', value: layerEdit.value, preview, layer: true };
      case 'Exposure': return { kind: 'exposure', value: layerEdit.value, preview, layer: true };
      case 'Gradient Map': return { kind: 'gradientMap', value: layerEdit.value, preview, layer: true };
      case 'Grain': return { kind: 'grain', value: layerEdit.value, preview, layer: true };
      default: return { kind: 'p2', value: layerEdit.value, preview, layer: true };
    }
  }
  const live = liveFilterEditState(session);
  if (live) return { kind: 'liveFilter', filter: LIVE_FILTER_NAMES[live.kind], settings: live.settings, preview: live.preview };
  const levels = levelsEditState(session);
  if (levels) return { kind: 'levels', settings: levels.settings, histogram: levels.histogramReady ? levels.histogram : null, preview: levels.preview, committing: levels.committing, layer: false };
  const hue = hueSaturationEditState(session);
  if (hue) return { kind: 'hue', settings: hue.settings, preview: hue.preview, committing: hue.committing, layer: false };
  const filter = filterEditState(session);
  if (filter) return { kind: 'filter', filter: filter.kind, settings: filter.settings, preview: filter.preview, committing: filter.committing, preparing: filter.preparing, error: filter.previewError };
  return null;
}

function hasPixelEdit(session: EditorSession): boolean {
  return !!(levelsEditState(session) || hueSaturationEditState(session) || filterEditState(session));
}

/** The composite below an adjustment layer (AdjustmentEditing.beginAdjustmentEditing): it and everything above are hidden. */
function underneathDocument(document: CanvasDocument, id: string): CanvasDocument {
  const entries = hierarchyEntries(document.layers);
  const cut = entries.findIndex((e) => e.layer.id === id);
  const below = new Set(entries.slice(0, cut < 0 ? entries.length : cut).map((e) => e.layer.id));
  return { ...document, selection: null, layers: document.layers.map((l) => (l.kind === 'group' || below.has(l.id) ? l : { ...l, visible: false })) };
}

/** Longest side of the image a layer-edit histogram is measured on; the shape is what matters. */
const HISTOGRAM_SIDE = 1024;

function measureLayerHistogram(controller: EditorController, session: EditorSession, id: string): void {
  const state = panelState(session);
  if (state.layerHistogram?.layerId === id) return;
  state.layerHistogram = { layerId: id, bins: null };
  const document = session.document, gpu = controller.canvas?.gpu;
  if (!document || !gpu) return;
  const scale = Math.min(1, HISTOGRAM_SIDE / Math.max(document.width, document.height));
  const width = Math.max(1, Math.round(document.width * scale)), height = Math.max(1, Math.round(document.height * scale));
  const view = { a: 1 / scale, b: 0, c: 0, d: 1 / scale, tx: 0, ty: 0 };
  let pixels: Uint8Array;
  try { pixels = gpu.readView(underneathDocument(document, id), width, height, view, scale); } catch { return; } finally { controller.canvas?.redraw(); }
  const raster = Raster.fromPixels(width, height, 4, pixels);
  void histogramPixelJob(raster, makeTransform({ x: 0, y: 0 }, { width, height }), null).promise.then((bins) => {
    if (panelState(session).layerHistogram?.layerId !== id) return;
    panelState(session).layerHistogram = { layerId: id, bins };
    session.notify('ui');
  }).catch(() => {});
}

// MARK: Changes

function changeLevels(session: EditorSession, settings: LevelsSettings, preview?: boolean): void {
  const layerEdit = adjustmentLayerEditState(session);
  if (layerEdit?.value.kind === 'Levels') {
    updateAdjustmentLayerEdit(session, { ...layerEdit.value, parameters: settings }, preview ?? layerEdit.preview); return;
  }
  const state = levelsEditState(session);
  if (state) { state.settings = settings; session.notify('ui'); void updateLevelsEdit(session, settings, preview ?? state.preview); }
}

function changeHue(session: EditorSession, settings: HueSaturationSettings, preview?: boolean): void {
  const layerEdit = adjustmentLayerEditState(session);
  if (layerEdit) {
    const master = settings.adjustments.Master ?? defaultRangeAdjustment();
    if (layerEdit.value.kind !== 'Hue/Saturation') return;
    updateAdjustmentLayerEdit(session, { ...layerEdit.value, parameters: { settings, hue: master.hue, saturation: master.saturation,
      lightness: master.lightness, colorize: settings.colorize } }, preview ?? layerEdit.preview);
    return;
  }
  const state = hueSaturationEditState(session);
  if (state) { state.settings = settings; session.notify('ui'); void updateHueSaturationEdit(session, settings, preview ?? state.preview); }
}

function changeFilter(session: EditorSession, settings: FilterSettings, preview?: boolean): void {
  const state = filterEditState(session);
  if (state) { state.settings = settings; session.notify('ui'); void updateFilterEdit(session, settings, preview ?? state.preview); }
}

function changeLayerValue(session: EditorSession, change: (value: LayerAdjustment) => LayerAdjustment, preview?: boolean): void {
  const layerEdit = adjustmentLayerEditState(session);
  if (layerEdit) updateAdjustmentLayerEdit(session, change(layerEdit.value), preview ?? layerEdit.preview);
}

function setPreview(session: EditorSession, edit: Edit, preview: boolean): void {
  if (edit.kind === 'levels') changeLevels(session, edit.settings, preview);
  else if (edit.kind === 'hue') changeHue(session, edit.settings, preview);
  else if (edit.kind === 'filter') changeFilter(session, edit.settings, preview);
  else if (edit.kind === 'liveFilter') updateLiveFilterEdit(session, edit.settings, preview);
  else changeLayerValue(session, (v) => v, preview);
}

async function commit(controller: EditorController, session: EditorSession): Promise<void> {
  const layerEdit = adjustmentLayerEditState(session);
  if (layerEdit) { settlePendingLuts(session, layerEdit.value.kind === 'Colour Lookup' ? layerEdit.value.parameters.resourceId : null); finishAdjustmentLayerEdit(session, true); }
  else if (liveFilterEditState(session)) finishLiveFilterEdit(session, true);
  else if (levelsEditState(session)) await applyLevelsEdit(session);
  else if (hueSaturationEditState(session)) await applyHueSaturationEdit(session);
  else if (filterEditState(session)) {
    const applied = await applyFilterEdit(session);
    // A failed apply keeps the panel open with its error; nothing else to do.
    if (!applied && filterEditState(session)) return;
  }
  resetPanelState(session);
  session.notify('document');
  controller.canvasView?.redraw();
}

function cancel(session: EditorSession): void {
  if (adjustmentLayerEditState(session)) { settlePendingLuts(session, null); finishAdjustmentLayerEdit(session, false); }
  else if (liveFilterEditState(session)) finishLiveFilterEdit(session, false);
  else if (levelsEditState(session)) cancelLevelsEdit(session);
  else if (hueSaturationEditState(session)) cancelHueSaturationEdit(session);
  else if (filterEditState(session)) cancelFilterEdit(session);
  resetPanelState(session);
  session.notify('document');
}

// MARK: Canvas sampling (Levels eyedroppers, Hue/Saturation eyedroppers and targeted adjustment)

/** Straight RGB 0…1 under a document point: the original layer for pixel edits, the underlying composite for adjustment layers. */
function sampleAt(controller: EditorController, session: EditorSession, point: Point): [number, number, number] | null {
  const document = session.document;
  if (!document) return null;
  const layerEdit = adjustmentLayerEditState(session);
  if (layerEdit) {
    if (!controller.canvas || point.x < 0 || point.y < 0 || point.x >= document.width || point.y >= document.height) return null;
    const pixel = controller.canvas.readRegion(underneathDocument(document, layerEdit.layerId), Math.floor(point.x), Math.floor(point.y), 1, 1);
    return pixel[3] ? [pixel[0]! / 255, pixel[1]! / 255, pixel[2]! / 255] : null;
  }
  const state = levelsEditState(session) ?? hueSaturationEditState(session);
  if (!state) return null;
  const raster = state.originalRaster;
  const local = apply(invert(pixelToDocument(state.originalTransform, raster.width, raster.height)), point);
  const x = Math.floor(local.x), y = Math.floor(local.y);
  if (x < 0 || y < 0 || x >= raster.width || y >= raster.height) return null;
  const pixel = raster.readRegion(x, y, 1, 1);
  return pixel[3] ? [pixel[0]! / 255, pixel[1]! / 255, pixel[2]! / 255] : null;
}

class SamplingTool implements ToolHandler {
  private target: { drag: HueTargetDrag; start: Point; settings: HueSaturationSettings } | null = null;
  constructor(private readonly controller: EditorController) {}
  down(c: ToolContext): void {
    const session = c.session, state = panelState(session), edit = currentEdit(session);
    const rgb = sampleAt(this.controller, session, c.pixel);
    if (!rgb || !edit) return;
    if (edit.kind === 'levels' && state.levelsSample) changeLevels(session, sampleLevels(edit.settings, rgb, state.levelsSample));
    else if (edit.kind === 'hue' && state.hueSample) changeHue(session, sampleHueRange(edit.settings, toHsl(...rgb)[0], state.hueSample));
    else if (edit.kind === 'hue' && state.hueTargeting) {
      const begun = beginHueTarget(edit.settings, toHsl(...rgb)[0]);
      if (begun) { this.target = { drag: begun.drag, start: c.point, settings: begun.settings }; changeHue(session, begun.settings); }
    }
  }
  move(c: ToolContext): void {
    if (!this.target) return;
    // Right is more; ⌘ drags the hue instead of the saturation (HueSaturationEdit targeted drag).
    const delta = c.point.x - this.target.start.x;
    changeHue(c.session, dragHueTarget(this.target.settings, this.target.drag, delta, c.modifiers.command));
  }
  up(): void { this.target = null; }
  cancel(): void { this.target = null; }
  hover(): string { return 'crosshair'; }
}

function samplingActive(session: EditorSession): boolean {
  const state = panelStates.get(session);
  const edit = state ? currentEdit(session) : null;
  return !!edit && !!state && ((edit.kind === 'levels' && !!state.levelsSample) || (edit.kind === 'hue' && (!!state.hueSample || state.hueTargeting)));
}

// MARK: Shared controls

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));

/** A slider plus an exact field (FilterSheet.control). Logarithmic sliders give small values most of the travel. */
export function SliderRow({ label, value, min, max, decimals = 0, logarithmic = false, suffix, onChange, testId, onReset, title, labelWidth, trackClass }: {
  label: string; value: number; min: number; max: number; decimals?: number; logarithmic?: boolean; suffix?: string;
  onChange: (value: number) => void; testId?: string;
  /** Double-clicking the label resets the value (Lightroom, Photoshop Camera Raw). */
  onReset?: () => void; title?: string; labelWidth?: number; trackClass?: string;
}) {
  const step = 10 ** decimals;
  const toSlider = (v: number) => (logarithmic ? Math.log(v) : v);
  const fromSlider = (v: number) => Math.round((logarithmic ? Math.exp(v) : v) * step) / step;
  return (
    <div className={styles.panelRow}>
      <span className={styles.panelLabel} title={title} style={labelWidth ? { width: labelWidth } : undefined}
        onDoubleClick={onReset ? (event) => { event.preventDefault(); onReset(); } : undefined} data-testid={testId && onReset ? `${testId}-label` : undefined}>{label}</span>
      {/* A track class wraps the slider, e.g. to draw a colour ramp under it (white balance). */}
      <span className={trackClass} style={trackClass ? undefined : { display: 'contents' }}>
        <input type="range" className={styles.slider} aria-label={label} data-testid={testId ? `${testId}-slider` : undefined}
          min={toSlider(min)} max={toSlider(max)} step={logarithmic ? 'any' : 1 / step} value={toSlider(clamp(value, min, max))}
          onChange={(event) => onChange(clamp(fromSlider(Number(event.target.value)), min, max))} />
      </span>
      <NumberField label="" value={value} suffix={suffix} width={56} testId={testId}
        onChange={(v) => onChange(clamp(Math.round(v * step) / step, min, max))} />
    </div>
  );
}

export function Check({ label, checked, onChange, testId }: { label: string; checked: boolean; onChange: (value: boolean) => void; testId?: string }) {
  return (
    <label className={styles.check}>
      <input type="checkbox" checked={checked} data-testid={testId} onChange={(event) => onChange(event.target.checked)} />{label}
    </label>
  );
}

export function Segmented<T extends string>({ label, options, value, onChange, labelOf }: {
  label: string; options: readonly T[]; value: T; onChange: (value: T) => void; labelOf?: (value: T) => string;
}) {
  return (
    <div className={styles.segmented} role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button key={option} type="button" role="radio" aria-checked={value === option}
          className={`${styles.segment} ${value === option ? styles.segmentOn : ''}`} onClick={() => onChange(option)}>
          {labelOf ? labelOf(option) : option}
        </button>
      ))}
    </div>
  );
}

/** Pointer capture on a track; reports the fraction 0…1 along it while dragging. */
function useTrackDrag(onFraction: (fraction: number, start: boolean, y: number) => void) {
  return (event: ReactPointerEvent<Element>) => {
    const element = event.currentTarget as HTMLElement;
    const rect = element.getBoundingClientRect();
    const report = (e: { clientX: number; clientY: number }, start: boolean) =>
      onFraction(clamp((e.clientX - rect.left) / rect.width, 0, 1), start, clamp((e.clientY - rect.top) / rect.height, 0, 1));
    element.setPointerCapture?.(event.pointerId);
    report(event, true);
    const move = (e: PointerEvent) => report(e, false);
    const up = () => { element.removeEventListener('pointermove', move); element.removeEventListener('pointerup', up); element.removeEventListener('pointercancel', up); };
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', up);
    element.addEventListener('pointercancel', up);
    event.preventDefault();
  };
}

const channelIndex = (channel: string) => Math.max(0, LEVELS_CHANNELS.indexOf(channel as never));
const CHANNEL_COLORS = ['#9a9a9a', '#e05050', '#4cc060', '#4a86e8'];

// MARK: Levels (LevelsSheet.swift)

export function Histogram({ bins, color, label, hint }: { bins: ArrayLike<number> | null; color: string; label: string; hint: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const width = canvas.width = canvas.clientWidth * devicePixelRatio;
    const height = canvas.height = canvas.clientHeight * devicePixelRatio;
    context.clearRect(0, 0, width, height);
    if (!bins) return;
    const peak = histogramDisplayScale(Array.from(bins));
    if (!(peak > 0)) return;
    context.fillStyle = color;
    for (let i = 0; i < 256; i++) {
      const h = height * clamp(bins[i]! / peak, 0, 1);
      context.fillRect(i * width / 256, height - h, width / 256 + 0.5, h);
    }
  }, [bins, color]);
  return <canvas ref={ref} className={styles.histogram} role="img" aria-label={label}
    title={hint} />;
}

function LevelsHandles({ positions, names, colors, onDrag }: {
  positions: number[]; names: string[]; colors: string[]; onDrag: (index: number, value: number) => void;
}) {
  const active = useRef(0);
  const down = useTrackDrag((fraction, start) => {
    const value = fraction * 255;
    if (start) {
      let best = 0;
      positions.forEach((p, i) => { if (Math.abs(p - value) < Math.abs(positions[best]! - value)) best = i; });
      active.current = best;
    }
    onDrag(active.current, value);
  });
  return (
    <div className={styles.levelsHandles} onPointerDown={down}>
      {positions.map((position, index) => (
        <span key={index} className={styles.levelsHandle} aria-label={names[index]} role="slider" aria-valuenow={Math.round(position)}
          style={{ left: `${position / 255 * 100}%`, borderBottomColor: colors[index] }} />
      ))}
    </div>
  );
}

function LevelsControls({ controller, session, edit }: { controller: EditorController; session: EditorSession; edit: Extract<Edit, { kind: 'levels' }> }) {
  const t = controller.t;
  const settings = edit.settings;
  const index = channelIndex(settings.channel);
  const current = settings.ranges[index] ?? defaultLevelRange();
  const state = panelState(session);
  const update = (range: Partial<LevelRange>) => {
    const ranges = settings.ranges.slice();
    ranges[index] = normalizeLevelRange({ ...current, ...range });
    changeLevels(session, { ...settings, ranges });
  };
  const gammaPosition = current.black + (current.white - current.black) * 0.5 ** current.gamma;
  const sampleModes: LevelsSample[] = ['Black', 'Gray', 'White'];
  const autoModes: LevelsAuto[] = ['Contrast', 'Color', 'Color + neutral midtones'];
  return (
    <>
      <Segmented label={t('Channel')} options={LEVELS_CHANNELS} value={settings.channel} labelOf={t}
        onChange={(channel) => changeLevels(session, { ...settings, channel })} />
      <div className={styles.histogramBox}>
        <Histogram bins={edit.histogram?.[index] ?? null} color={CHANNEL_COLORS[index]!} label={`${t('Histogram')} ${t(settings.channel)}`}
          hint={t('Linear histogram with automatic vertical scaling. Tall spikes may extend beyond the graph; all tones from 0 to 255 remain included.')} />
        {!edit.histogram ? <span className={styles.histogramLoading}>{t('Loading histogram…')}</span> : null}
        <LevelsHandles positions={[current.black, gammaPosition, current.white]} names={[t('Input black'), t('Gamma'), t('Input white')]}
          colors={['#000', '#888', '#fff']}
          onDrag={(i, x) => {
            if (i === 0) update({ black: Math.min(current.white - 1, Math.round(x)) });
            else if (i === 2) update({ white: Math.max(current.black + 1, Math.round(x)) });
            else {
              const fraction = clamp((x - current.black) / (current.white - current.black), 0.001, 0.999);
              update({ gamma: Math.log(fraction) / Math.log(0.5) });
            }
          }} />
      </div>
      <div className={styles.panelFields}>
        <NumberField label={t('Input black')} value={current.black} width={52} testId="levelsInputblack" onChange={(black) => update({ black })} />
        <NumberField label={t('Gamma')} value={Math.round(current.gamma * 100) / 100} width={52} testId="levelsGamma" onChange={(gamma) => update({ gamma })} />
        <NumberField label={t('Input white')} value={current.white} width={52} testId="levelsInputwhite" onChange={(white) => update({ white })} />
      </div>
      <div className={styles.histogramBox}>
        <div className={styles.outputRamp} />
        <LevelsHandles positions={[current.outputBlack, current.outputWhite]} names={[t('Output black'), t('Output white')]} colors={['#000', '#fff']}
          onDrag={(i, x) => update(i === 0 ? { outputBlack: Math.round(x) } : { outputWhite: Math.round(x) })} />
      </div>
      <div className={styles.panelFields}>
        <NumberField label={t('Output black')} value={current.outputBlack} width={52} testId="levelsOutputblack" onChange={(outputBlack) => update({ outputBlack })} />
        <NumberField label={t('Output white')} value={current.outputWhite} width={52} testId="levelsOutputwhite" onChange={(outputWhite) => update({ outputWhite })} />
      </div>
      <div className={styles.panelRow}>
        <span className={styles.panelCaption}>{t('Sample')}</span>
        {sampleModes.map((mode) => (
          <button key={mode} type="button" className={`${styles.pill} ${state.levelsSample === mode ? styles.pillPrimary : ''}`} aria-pressed={state.levelsSample === mode}
            onClick={() => { state.levelsSample = state.levelsSample === mode ? null : mode; session.notify('ui'); }}>{t(mode)}</button>
        ))}
      </div>
      {state.levelsSample ? <p className={styles.panelNote}>{t(edit.layer ? 'Click the image to set the tone from the pixels underneath.' : 'Click the original layer to set the tone.')} · {t(state.levelsSample)}</p> : null}
      <div className={styles.panelRow}>
        <span className={styles.panelCaption}>{t('Auto')}</span>
        {autoModes.map((mode) => (
          <button key={mode} type="button" className={styles.pill} disabled={!edit.histogram}
            onClick={() => edit.histogram && changeLevels(session, { ...autoLevels(mode, edit.histogram), channel: settings.channel })}>{t(mode)}</button>
        ))}
      </div>
      <div className={styles.panelRow}>
        <button type="button" className={styles.pill} onClick={() => { state.levelsSample = null; changeLevels(session, defaultLevels()); }}>{t('Reset')}</button>
      </div>
      <p className={styles.panelNote}>{t(edit.layer ? 'Underlying pixels · alpha-weighted histogram' : session.selection ? 'Original pixels · selection and alpha-weighted histogram' : 'Original pixels · alpha-weighted histogram')}</p>
    </>
  );
}

// MARK: Hue/Saturation (HueSaturationSheet.swift)

function Spectrum({ settings, after }: { settings: HueSaturationSettings; after: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current, context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const width = canvas.width = canvas.clientWidth * devicePixelRatio, height = canvas.height = canvas.clientHeight * devicePixelRatio;
    const slices = 72;
    for (let slice = 0; slice < slices; slice++) {
      const [r, g, b] = fromHsl(slice / slices * 360, 1, 0.5);
      const [ar, ag, ab] = after ? adjustHueColor(r, g, b, settings) : [r, g, b];
      context.fillStyle = `rgb(${Math.round(ar * 255)},${Math.round(ag * 255)},${Math.round(ab * 255)})`;
      context.fillRect(slice * width / slices, 0, width / slices + 0.5, height);
    }
  }, [settings, after]);
  return <canvas ref={ref} className={styles.spectrum} aria-hidden />;
}

function SpectrumEditor({ controller, settings, onChange }: { controller: EditorController; settings: HueSaturationSettings; onChange: (s: HueSaturationSettings) => void }) {
  const range = settings.range as Exclude<ColorRange, 'Master'>;
  const band = settings.bands[range] ?? DEFAULT_BANDS[range];
  const handles = [band.falloffStart, band.rangeStart, band.rangeEnd, band.falloffEnd];
  const active = useRef(0);
  const down = useTrackDrag((fraction, start) => {
    const degrees = fraction * 360;
    if (start) {
      const distances = handles.map((h) => { const gap = Math.abs(h - degrees) % 360; return Math.min(gap, 360 - gap); });
      active.current = distances.indexOf(Math.min(...distances));
    }
    onChange({ ...settings, bands: { ...settings.bands, [range]: setHueBandHandle(band, active.current, degrees) } });
  });
  return (
    <div className={styles.spectrumEditor}>
      <Spectrum settings={settings} after={false} />
      <div className={styles.bandHandles} onPointerDown={down} aria-label={controller.t('Hue range')}>
        {handles.map((h, i) => <span key={i} className={i === 1 || i === 2 ? styles.bandInner : styles.bandOuter} style={{ left: `${h / 360 * 100}%` }} />)}
      </div>
      <Spectrum settings={settings} after />
      <span className={styles.panelNote} style={{ wordSpacing: '0.8em' }}>{handles.map((h) => `${Math.round(h)}°`).join(' ')}</span>
    </div>
  );
}

function HueControls({ controller, session, edit }: { controller: EditorController; session: EditorSession; edit: Extract<Edit, { kind: 'hue' }> }) {
  const t = controller.t;
  const settings = edit.settings;
  const state = panelState(session);
  const range = settings.colorize ? 'Master' : settings.range;
  const values = settings.adjustments[range] ?? defaultRangeAdjustment();
  const showsSpectrum = settings.range !== 'Master' && !settings.colorize;
  const set = (s: HueSaturationSettings) => changeHue(session, s);
  const setValue = (key: 'hue' | 'saturation' | 'lightness', value: number) =>
    set({ ...settings, adjustments: { ...settings.adjustments, [range]: { ...values, [key]: value } } });
  const sampleModes: HueSampleMode[] = ['Sample', 'Add', 'Remove'];
  return (
    <>
      <div className={styles.panelRow}>
        <select className={styles.select} aria-label={t('Range')} value={settings.range} disabled={settings.colorize} data-testid="hueRange"
          onChange={(event) => set({ ...settings, range: event.target.value as ColorRange })}>
          {COLOR_RANGES.map((r) => <option key={r} value={r}>{t(r)}</option>)}
        </select>
        <span style={{ flex: 1 }} />
        {showsSpectrum ? sampleModes.map((mode) => (
          <button key={mode} type="button" className={`${styles.pill} ${state.hueSample === mode ? styles.pillPrimary : ''}`} aria-pressed={state.hueSample === mode}
            title={t(mode === 'Sample' ? 'Set the range from a color in the image' : mode === 'Add' ? 'Add a color to the range' : 'Remove a color from the range')}
            onClick={() => { state.hueTargeting = false; state.hueSample = state.hueSample === mode ? null : mode; session.notify('ui'); }}>{t(mode)}</button>
        )) : null}
        {!settings.colorize ? (
          <button type="button" className={`${styles.pill} ${state.hueTargeting ? styles.pillPrimary : ''}`} aria-pressed={state.hueTargeting}
            title={t("Targeted adjustment: drag on the image to change that color's saturation, or its hue with Command held")}
            onClick={() => { state.hueSample = null; state.hueTargeting = !state.hueTargeting; session.notify('ui'); }}>{t('Targeted')}</button>
        ) : null}
      </div>
      <SliderRow label={t('Hue')} value={values.hue} min={settings.colorize ? 0 : -180} max={settings.colorize ? 360 : 180} suffix="°" testId="hueHue" onChange={(v) => setValue('hue', v)} />
      <SliderRow label={t('Saturation')} value={values.saturation} min={settings.colorize ? 0 : -100} max={100} testId="hueSaturation" onChange={(v) => setValue('saturation', v)} />
      <SliderRow label={t('Lightness')} value={values.lightness} min={-100} max={100} testId="hueLightness" onChange={(v) => setValue('lightness', v)} />
      {showsSpectrum ? (
        <>
          <SpectrumEditor controller={controller} settings={settings} onChange={set} />
          <Check label={t('Apply outside this range instead')} checked={settings.invertRange} onChange={(invertRange) => set({ ...settings, invertRange })} />
        </>
      ) : null}
      <div className={styles.panelRow}>
        <Check label={t('Colorize')} checked={settings.colorize} testId="hueColorize"
          onChange={(colorize) => { state.hueSample = null; state.hueTargeting = false; set(colorize ? COLORIZE_START : defaultHueSaturation()); }} />
        <button type="button" className={styles.pill} onClick={() => set(settings.colorize ? COLORIZE_START : defaultHueSaturation())}>{t('Reset')}</button>
      </div>
      {state.hueSample || state.hueTargeting ? (
        <p className={styles.panelNote}>{t(state.hueTargeting ? 'Drag right or left on the image: saturation, or hue with ⌘ held.' : 'Click a color in the image.')}</p>
      ) : null}
    </>
  );
}

// MARK: Curves (CurvesControls.swift)

function CurvesControls({ controller, settings, onChange }: { controller: EditorController; settings: CurvesSettings; onChange: (s: CurvesSettings) => void }) {
  const t = controller.t;
  const index = channelIndex(settings.channel);
  const points = settings.channels[index] ?? [];
  const [selected, setSelected] = useState<number | null>(null);
  const dragging = useRef<number | null>(null);
  // A drag outlives the render it started in: it reads and writes the latest settings, not its closure's.
  const latest = useRef(settings);
  latest.current = settings;
  useEffect(() => { setSelected(null); dragging.current = null; }, [settings.channel]);
  const setPoints = (next: readonly CurvePoint[]) => {
    const channels = latest.current.channels.slice();
    channels[index] = next;
    latest.current = { ...latest.current, channels };
    onChange(latest.current);
  };
  const down = useTrackDrag((fx, start, fy) => {
    const x = fx * 255, y = 255 - fy * 255;
    let p = (latest.current.channels[index] ?? []).slice();
    if (start) {
      dragging.current = null;
      let best = -1, distance = Infinity;
      p.forEach((q, i) => { const d = Math.hypot(q.x - x, q.y - y); if (d < distance) { distance = d; best = i; } });
      if (best >= 0 && distance < 14) dragging.current = best;
      else if (p.length < 32 && x > 1 && x < 254 && p.every((q) => Math.abs(q.x - x) > 1)) {
        p.push({ x, y });
        p.sort((a, b) => a.x - b.x);
        dragging.current = p.findIndex((q) => q.x === x);
      }
    }
    const i = dragging.current;
    if (i === null || !p[i]) return;
    setSelected(i);
    const nx = i > 0 && i < p.length - 1 ? clamp(x, p[i - 1]!.x + 1, p[i + 1]!.x - 1) : p[i]!.x;
    p = p.map((q, k) => (k === i ? { x: nx, y: clamp(y, 0, 255) } : q));
    setPoints(p);
  });
  const path = Array.from({ length: 256 }, (_, x) => `${x === 0 ? 'M' : 'L'}${x},${255 - curveValue(x, settings, index)}`).join(' ');
  const point = selected !== null ? points[selected] : undefined;
  return (
    <>
      <Segmented label={t('Channel')} options={LEVELS_CHANNELS} value={settings.channel} labelOf={t} onChange={(channel) => onChange({ ...settings, channel })} />
      <svg className={styles.curves} viewBox="0 0 255 255" preserveAspectRatio="none" onPointerDown={down} data-testid="curves-graph" role="img" aria-label={t('Curve')}>
        {[1, 2, 3].map((i) => <g key={i}><line x1={i * 63.75} y1={0} x2={i * 63.75} y2={255} /><line x1={0} y1={i * 63.75} x2={255} y2={i * 63.75} /></g>)}
        <path d={path} className={styles.curveLine} style={{ stroke: index ? CHANNEL_COLORS[index] : undefined }} />
        {points.map((q, i) => <circle key={i} cx={q.x} cy={255 - q.y} r={4} className={i === selected ? styles.curvePointOn : styles.curvePoint} />)}
      </svg>
      <p className={styles.panelNote}>{t('Click to add a point. Drag to adjust.')}</p>
      <div className={styles.panelRow}>
        {point ? <span className={styles.panelCaption}>{t('Input')} {Math.round(point.x)} · {t('Output')} {Math.round(point.y)}</span> : null}
        <span style={{ flex: 1 }} />
        <button type="button" className={styles.pill} disabled={selected === null || selected === 0 || selected === points.length - 1}
          onClick={() => { if (selected !== null) { setPoints(points.filter((_, i) => i !== selected)); setSelected(null); } }}>{t('Remove point')}</button>
        <button type="button" className={styles.pill}
          onClick={() => { setPoints(defaultCurves().channels[0]!); setSelected(null); }}>{t('Reset curve')}</button>
      </div>
    </>
  );
}

// MARK: Exposure, Gradient Map, Grain and the pixel filters (FilterSheet.swift)

function ExposureControls({ controller, settings, onChange }: { controller: EditorController; settings: ExposureSettings; onChange: (s: ExposureSettings) => void }) {
  const t = controller.t;
  return (
    <>
      <SliderRow label={t('Exposure')} value={settings.exposure} min={-20} max={20} decimals={2} testId="exposureExposure" onChange={(exposure) => onChange({ ...settings, exposure })} />
      <SliderRow label={t('Offset')} value={settings.offset} min={-0.5} max={0.5} decimals={4} onChange={(offset) => onChange({ ...settings, offset })} />
      <SliderRow label={t('Gamma')} value={settings.gamma} min={0.01} max={9.99} decimals={2} logarithmic onChange={(gamma) => onChange({ ...settings, gamma })} />
    </>
  );
}

const hex = (c: RGB) => `#${[c.red, c.green, c.blue].map((v) => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, '0')).join('')}`;

function GradientMapControls({ controller, settings, onChange }: { controller: EditorController; settings: GradientMapSettings; onChange: (s: GradientMapSettings) => void }) {
  const t = controller.t;
  const dark = settings.reversed ? settings.highlights : settings.shadows, light = settings.reversed ? settings.shadows : settings.highlights;
  return (
    <>
      <div className={styles.gradientRamp} style={{ background: `linear-gradient(to right, ${hex(dark)}, ${hex(light)})` }} />
      <div className={styles.panelRow}>
        {(['shadows', 'highlights'] as const).map((end) => {
          const label = t(end === 'shadows' ? 'Shadows' : 'Highlights');
          // The ends open the app's own color picker, previewing live (ImageAdjustmentTests.gradientMapColorsUseTheAppColorPicker).
          const pick = () => {
            const before = settings;
            controller.pickColor?.({
              title: `${t('Gradient Map')} · ${label}`, initial: settings[end],
              preview: (color) => onChange({ ...before, [end]: color }),
              commit: (color) => onChange({ ...before, [end]: color }),
              cancel: () => onChange(before),
            });
          };
          return (
            <span key={end} className={styles.check}>
              <button type="button" className={styles.colorWell} style={{ background: hex(settings[end]) }} onClick={pick}
                aria-label={t(end === 'shadows' ? 'Shadows color' : 'Highlights color')} data-testid={`gradient-${end}`} />
              {label}
            </span>
          );
        })}
        <Check label={t('Reverse')} checked={settings.reversed} onChange={(reversed) => onChange({ ...settings, reversed })} />
      </div>
    </>
  );
}

function GrainControls({ controller, settings, onChange }: { controller: EditorController; settings: GrainSettings; onChange: (s: GrainSettings) => void }) {
  const t = controller.t;
  return (
    <>
      <SliderRow label={t('Amount')} value={settings.amount} min={0} max={100} testId="grainAmount" onChange={(amount) => onChange({ ...settings, amount })} />
      <SliderRow label={t('Size')} value={settings.size} min={0.5} max={20} decimals={1} logarithmic suffix="px" onChange={(size) => onChange({ ...settings, size })} />
      <SliderRow label={t('Roughness')} value={settings.roughness} min={0} max={100} onChange={(roughness) => onChange({ ...settings, roughness })} />
    </>
  );
}

/** The panel of a pixel filter; the same controls edit a destructive filter and a live filter on a layer. */
function FilterControls({ controller, filter, settings: s, onChange }: {
  controller: EditorController; filter: FilterKind; settings: FilterSettings; onChange: (settings: FilterSettings) => void;
}) {
  const t = controller.t;
  const set = (change: Partial<FilterSettings>) => onChange({ ...s, ...change });
  switch (filter) {
    case 'Curves': return <CurvesControls controller={controller} settings={s.curves} onChange={(curves) => set({ curves })} />;
    case 'Exposure': return <ExposureControls controller={controller} settings={s.exposure} onChange={(exposure) => set({ exposure })} />;
    case 'Gradient Map': return <GradientMapControls controller={controller} settings={s.gradientMap} onChange={(gradientMap) => set({ gradientMap })} />;
    case 'Grain': return <GrainControls controller={controller} settings={s.grain} onChange={(grain) => set({ grain })} />;
    case 'Gaussian Blur': return <SliderRow label={t('Radius')} value={s.radius} min={0.1} max={250} decimals={1} logarithmic suffix="px" testId="blurRadius" onChange={(radius) => set({ radius })} />;
    case 'Motion Blur': return (
      <>
        <SliderRow label={t('Angle')} value={s.angle} min={-90} max={90} suffix="°" onChange={(angle) => set({ angle })} />
        <SliderRow label={t('Distance')} value={s.distance} min={1} max={2000} logarithmic suffix="px" onChange={(distance) => set({ distance })} />
      </>
    );
    case 'Add Noise': return (
      <>
        <SliderRow label={t('Amount')} value={s.amount} min={0.1} max={400} decimals={1} logarithmic suffix="%" onChange={(amount) => set({ amount })} />
        <Segmented label={t('Distribution')} options={['uniform', 'gaussian'] as const} value={s.gaussian ? 'gaussian' : 'uniform'}
          labelOf={(v) => t(v === 'gaussian' ? 'Gaussian' : 'Uniform')} onChange={(v) => set({ gaussian: v === 'gaussian' })} />
        <Check label={t('Monochromatic')} checked={s.monochromatic} onChange={(monochromatic) => set({ monochromatic })} />
      </>
    );
    case 'Lens Correction': return (
      <>
        <SliderRow label={t('Remove Distortion')} value={s.distortion} min={-100} max={100} onChange={(distortion) => set({ distortion })} />
        <p className={styles.panelNote}>{t('Positive straightens lines that bow outward (barrel); negative, lines that bow inward (pincushion).')}</p>
      </>
    );
    case 'Unsharp Mask': return (
      <>
        <SliderRow label={t('Amount')} value={s.amount} min={1} max={400} suffix="%" testId="sharpenAmount" onChange={(amount) => set({ amount })} />
        <SliderRow label={t('Radius')} value={s.radius} min={0.1} max={250} decimals={1} logarithmic suffix="px" testId="sharpenRadius" onChange={(radius) => set({ radius })} />
        <SliderRow label={t('Threshold')} value={s.threshold} min={0} max={255} testId="sharpenThreshold" onChange={(threshold) => set({ threshold })} />
      </>
    );
    case 'Smart Sharpen': return (
      <>
        <SliderRow label={t('Amount')} value={s.amount} min={1} max={400} suffix="%" testId="sharpenAmount" onChange={(amount) => set({ amount })} />
        <SliderRow label={t('Radius')} value={s.radius} min={0.1} max={64} decimals={1} logarithmic suffix="px" testId="sharpenRadius" onChange={(radius) => set({ radius })} />
        <SliderRow label={t('Reduce Noise')} value={s.reduceNoise} min={0} max={100} suffix="%" testId="sharpenReduceNoise" onChange={(reduceNoise) => set({ reduceNoise })} />
        <SliderRow label={t('Threshold')} value={s.threshold} min={0} max={255} testId="sharpenThreshold" onChange={(threshold) => set({ threshold })} />
      </>
    );
    case 'High Pass': return (
      <SliderRow label={t('Radius')} value={s.radius} min={0.1} max={250} decimals={1} logarithmic suffix="px" testId="highPassRadius" onChange={(radius) => set({ radius })} />
    );
    case 'Denoise': return (
      <>
        <SliderRow label={t('Luminance')} value={s.luminance} min={0} max={100} suffix="%" testId="denoiseLuminance" onChange={(luminance) => set({ luminance })} />
        <SliderRow label={t('Color Noise')} value={s.colour} min={0} max={100} suffix="%" testId="denoiseColour" onChange={(colour) => set({ colour })} />
      </>
    );
  }
}

// MARK: The panel

export { FloatingPanel };

const TITLES: Record<string, string> = { levels: 'Levels', hue: 'Hue/Saturation', curves: 'Curves', exposure: 'Exposure', gradientMap: 'Gradient Map', grain: 'Grain' };

/** Straight RGBA of the composite under an adjustment layer, at most 256 px on the long side (Black & White Auto). */
function sampleUnderneath(controller: EditorController, session: EditorSession, id: string): Uint8Array | null {
  const document = session.document, gpu = controller.canvas?.gpu;
  if (!document || !gpu) return null;
  const scale = Math.min(1, 256 / Math.max(document.width, document.height));
  const width = Math.max(1, Math.round(document.width * scale)), height = Math.max(1, Math.round(document.height * scale));
  try { return gpu.readView(underneathDocument(document, id), width, height, { a: 1 / scale, b: 0, c: 0, d: 1 / scale, tx: 0, ty: 0 }, scale); }
  catch { return null; } finally { controller.canvas?.redraw(); }
}

function AdjustmentPanel({ controller }: { controller: EditorController }) {
  const session = useSession(controller.session);
  const t = controller.t;
  const layerEdit = adjustmentLayerEditState(session);
  // A new adjustment layer (or a double-click on one) asks for its panel through adjustmentEditingId.
  useEffect(() => {
    if (session.adjustmentEditingId && !adjustmentLayerEditState(session) && !hasPixelEdit(session)) beginAdjustmentLayerEdit(session, session.adjustmentEditingId);
    const edit = adjustmentLayerEditState(session);
    if (edit && (edit.value.kind === 'Levels' || edit.value.kind === 'Threshold')) measureLayerHistogram(controller, session, edit.layerId);
  });
  const edit = currentEdit(session);
  if (!edit) return null;
  const busy = (edit.kind === 'levels' || edit.kind === 'hue' || edit.kind === 'filter') && edit.committing;
  const title = edit.kind === 'filter' || edit.kind === 'liveFilter' ? t(edit.filter) : edit.kind === 'p2' ? t(adjustmentName(edit.value.kind)) : t(TITLES[edit.kind]!);
  let body: ReactNode = null;
  if (edit.kind === 'levels') body = <LevelsControls controller={controller} session={session} edit={edit} />;
  else if (edit.kind === 'hue') body = <HueControls controller={controller} session={session} edit={edit} />;
  else if (edit.kind === 'filter') body = <FilterControls controller={controller} filter={edit.filter} settings={edit.settings} onChange={(s) => changeFilter(session, s)} />;
  else if (edit.kind === 'liveFilter') body = <FilterControls controller={controller} filter={edit.filter} settings={edit.settings} onChange={(s) => updateLiveFilterEdit(session, s)} />;
  else if (edit.kind === 'p2') body = <P2AdjustmentControls controller={controller} session={session} value={edit.value}
    onChange={(value) => changeLayerValue(session, () => value)} histogram={panelState(session).layerHistogram?.bins ?? null}
    sample={() => (layerEdit ? sampleUnderneath(controller, session, layerEdit.layerId) : null)} />;
  else {
    const value = resolveAdjustment(edit.value);
    if (edit.kind === 'curves') body = <CurvesControls controller={controller} settings={value.curves} onChange={(curves) => changeLayerValue(session,
      (v) => v.kind === 'Curves' ? { ...v, parameters: curves } : v)} />;
    else if (edit.kind === 'exposure') body = <ExposureControls controller={controller} settings={value.exposureSettings} onChange={(settings) => changeLayerValue(session,
      (v) => v.kind === 'Exposure' ? { ...v, parameters: settings } : v)} />;
    else if (edit.kind === 'gradientMap') body = <GradientMapControls controller={controller} settings={value.gradientMapSettings} onChange={(settings) => changeLayerValue(session,
      (v) => v.kind === 'Gradient Map' ? { ...v, parameters: settings } : v)} />;
    else body = <GrainControls controller={controller} settings={value.grainSettings} onChange={(settings) => changeLayerValue(session,
      (v) => v.kind === 'Grain' ? { ...v, parameters: settings } : v)} />;
  }
  const onLayer = !!layerEdit;
  const panelTitle = onLayer ? `${title} · ${t('Adjustment Layer')}` : edit.kind === 'liveFilter' ? `${title} · ${t('Smart Filter')}` : title;
  return (
    <FloatingPanel name={title} title={panelTitle} onClose={() => cancel(session)} closeLabel={t('Cancel')}>
      <fieldset className={styles.panelBody} disabled={busy} onKeyDown={(event) => {
        // ⌥P toggles Preview (LevelsSheet); Escape cancels and Return confirms, as the panel's buttons do.
        if (event.altKey && event.code === 'KeyP') { setPreview(session, edit, !edit.preview); event.preventDefault(); }
        else if (event.key === 'Escape') { cancel(session); event.preventDefault(); }
        else if (event.key === 'Enter' && !(event.target as Element).closest('input, select, textarea')) { void commit(controller, session); event.preventDefault(); }
      }}>
        {body}
        <Check label={t('Preview')} checked={edit.preview} testId="adjustment-preview" onChange={(preview) => setPreview(session, edit, preview)} />
        {edit.kind === 'filter' && edit.error ? <p className={styles.panelError}>{edit.error}</p> : null}
        {!onLayer && edit.kind !== 'liveFilter' && session.selection ? <p className={styles.panelNote}>{t('Limited to the selection')}</p> : null}
      </fieldset>
      <div className={styles.dialogButtons}>
        <button type="button" className={styles.pill} disabled={busy} onClick={() => cancel(session)} data-testid="adjustment-cancel">{t('Cancel')}</button>
        {busy || (edit.kind === 'filter' && edit.preparing) ? <span className={styles.panelNote}>{t(busy ? 'Applying…' : 'Working…')}</span> : null}
        <button type="button" className={`${styles.pill} ${styles.pillPrimary}`} disabled={busy} data-testid="adjustment-ok"
          onClick={() => void commit(controller, session)}>{t('OK')}</button>
      </div>
    </FloatingPanel>
  );
}

// MARK: Installation

export function installAdjustments(controller: EditorController): void {
  const registries = new WeakMap<EditorSession, ReturnType<typeof adjustmentCommands>>();
  const commands = () => {
    const session = controller.session;
    let registry = registries.get(session);
    if (!registry) { registry = adjustmentCommands(session); registries.set(session, registry); }
    return registry;
  };
  const names = ['levels', 'curves', 'hueSaturation', 'exposure', 'gradientMap', 'grain', 'invert',
    'gaussianBlur', 'motionBlur', 'noise', 'lensCorrection', 'editAdjustment'] as const;
  for (const name of names) {
    controller.features[name] = {
      enabled: () => commands()[name].enabled(),
      run: () => { resetPanelState(controller.session); commands()[name].run(); controller.session.notify('ui'); },
    };
  }
  controller.features.adjustmentLayers = { enabled: () => commands().adjustmentLayers.enabled(), run: () => {} };
  // While a panel is open the document is otherwise read-only, as EditorSession.canEditLayers makes it upstream.
  if (!editBlockers.includes(hasPixelEdit)) editBlockers.push(hasPixelEdit);
  controller.panels.push(() => <AdjustmentPanel controller={controller} />);
  const sampler = new SamplingTool(controller);
  controller.canvasInterceptors.push((session) => (samplingActive(session) ? sampler : null));
  installAdjustP2(controller);
  controller.keyHandlers.push((event) => {
    const session = controller.session;
    if (!currentEdit(session)) return false;
    if (event.key === 'Escape') { cancel(session); return true; }
    if (event.key === 'Enter') { void commit(controller, session); return true; }
    if (event.altKey && event.code === 'KeyP') { const edit = currentEdit(session); if (edit) setPreview(session, edit, !edit.preview); return true; }
    return false;
  });
}
