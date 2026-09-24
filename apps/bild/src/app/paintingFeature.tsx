/**
 * Painting tools in the UI: Brush/Eraser and Clone Stamp (BrushStroke engine), Smear with Blur,
 * Smudge and Liquify (retouch engines), Gradient, Eyedropper with its sample ring, and the
 * Color Picker (the Shape tool lives in vectorFeature). Ported from BrushControls/GradientControls/ColorPickerSheet.swift,
 * EditorCanvas.swift (brush, gradient, shape and sampling gestures, brush cursor, sample ring) and
 * the key handling in NativeLayerList/EditorCanvas ([ ] size, Shift-[ ] hardness, 1–0 opacity).
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import styles from '../ui/editor.module.css';
import type { ColorPickRequest, EditorController } from '../ui/controller';
import { useSession } from '../ui/hooks';
import { NumberField } from '../ui/ContextBar';
import { FloatingPanel } from './panels';
import type { EditorSession, PaletteColor, Tool } from '../core/session';
import type { Point } from '../core/geometry';
import {
  beginBrushStroke, cancelBrushStroke, changeBrushHardness, changeBrushSize, cloneSamplePoint, currentCpuBrushPreview,
  extendBrushStroke, finishBrushStroke, getBrushSettings, getCloneSettings, isBrushStrokeActive, setBrushSettings,
  setCloneSettings, setCloneSource, waitForBrushStroke, brushOutlineRadius, type BrushSettings, type BrushMode,
} from '../core/brush';
import { beginRetouch, cancelRetouch, commitRetouch, currentRetouchPreview, updateRetouch, type RetouchMode } from '../core/retouch';
import {
  beginGradient, cancelGradient, commitGradient, defaultGradientSettings, endGradientDrag, handleGradientKey, pendingGradient,
  pendingGradientPreview, refreshGradient, updateGradient, type GradientSettings, type GradientShape, type GradientStyle,
} from '../core/gradient';
import type { ToolContext, ToolHandler } from '../ui/canvas/tools';
import type { BrushRange } from '../core/brush/settings';
import type { CanvasView } from '../ui/canvas/CanvasView';
import { sampleColor, type SampleSize } from '../core/color/sample';
import { colorState } from './color/state';

// MARK: Per-project tool state

interface PaintState {
  smear: { diameter: number; hardness: number; opacity: number };
  smearMode: RetouchMode;
  gradient: GradientSettings;
  showsSampleRing: boolean;
  sampling: { point: Point; original: PaletteColor; sampled: PaletteColor } | null;
}
const paintStates = new WeakMap<EditorSession, PaintState>();
export function paintState(session: EditorSession): PaintState {
  let state = paintStates.get(session);
  if (!state) {
    state = {
      smear: { diameter: 40, hardness: 0, opacity: 1 }, smearMode: 'liquify',
      gradient: defaultGradientSettings(session.foregroundColor, session.backgroundColor),
      showsSampleRing: true, sampling: null,
    };
    paintStates.set(session, state);
  }
  return state;
}

function gradientSettingsFor(session: EditorSession): GradientSettings {
  const state = paintState(session);
  const white = { red: 1, green: 1, blue: 1 }, black = { red: 0, green: 0, blue: 0 };
  const foreground = session.isMaskSelected ? (session.maskPaintWhite ? white : black) : session.foregroundColor;
  const background = session.isMaskSelected ? (session.maskPaintWhite ? black : white) : session.backgroundColor;
  return { ...state.gradient, foreground, background };
}

/** The canvas reads strokes and pending gradients through session.previewSources; this just redraws. */
function syncPreview(session: EditorSession): void {
  session.notify('document');
}

/** Registered once per session: the stroke, retouch or gradient in progress. */
const previewInstalled = new WeakSet<EditorSession>();
function ensurePreviewSources(session: EditorSession): void {
  if (previewInstalled.has(session)) return;
  previewInstalled.add(session);
  session.previewSources.push((s) => currentCpuBrushPreview(s) ?? currentRetouchPreview(s) ?? pendingGradientPreview(s));
}

// MARK: Brush and Clone Stamp

class BrushTool implements ToolHandler {
  private axisAnchor: Point | null = null;
  private horizontal: boolean | null = null;
  private last: Point | null = null;

  down(c: ToolContext): void {
    const session = c.session;
    ensurePreviewSources(session);
    if (session.tool === 'cloneStamp' && c.modifiers.option) { setCloneSource(session, c.pixel); session.notify('document'); return; }
    // Photoshop: the Eraser on a transparency-locked layer paints the background colour instead of clearing alpha.
    const erasesLocked = session.tool === 'brush' && !session.isMaskSelected && getBrushSettings(session).mode === 'erase'
      && !!session.activeLayerId && session.lockState(session.activeLayerId).transparency;
    const update = beginBrushStroke(session, c.pixel, erasesLocked
      ? { shift: c.modifiers.shift, mode: 'paint', background: true }
      : toningStroke(session) ? { shift: c.modifiers.shift, settings: { ...getBrushSettings(session), opacity: 1 } } : { shift: c.modifiers.shift });
    if (!update) return;
    this.axisAnchor = c.modifiers.shift ? c.pixel : null;
    this.horizontal = null;
    this.last = c.pixel;
    syncPreview(session);
  }
  move(c: ToolContext): void {
    const session = c.session;
    if (!isBrushStrokeActive(session)) return;
    let pixel = c.pixel;
    // Shift keeps the stroke on one axis from where it was pressed; the axis settles after 3 px.
    if (c.modifiers.shift) {
      const anchor = this.axisAnchor ?? this.last ?? pixel;
      if (!this.axisAnchor) { this.axisAnchor = anchor; this.horizontal = null; }
      if (this.horizontal === null && Math.hypot(pixel.x - anchor.x, pixel.y - anchor.y) >= 3) {
        this.horizontal = Math.abs(pixel.x - anchor.x) >= Math.abs(pixel.y - anchor.y);
      }
      pixel = this.horizontal === null ? anchor : this.horizontal ? { x: pixel.x, y: anchor.y } : { x: anchor.x, y: pixel.y };
    } else { this.axisAnchor = null; this.horizontal = null; }
    this.last = pixel;
    extendBrushStroke(session, pixel, c.pressure === null ? undefined : { pressure: c.pressure });
    syncPreview(session);
  }
  up(c: ToolContext): void {
    const session = c.session;
    if (!isBrushStrokeActive(session)) return;
    finishBrushStroke(session);
    syncPreview(session);
    void waitForBrushStroke(session).then(() => syncPreview(session));
  }
  cancel(session: EditorSession): void {
    if (cancelBrushStroke(session)) syncPreview(session);
  }
  hover(c: ToolContext): string {
    return c.session.tool === 'cloneStamp' && c.modifiers.option ? 'crosshair' : 'none';
  }
}

// MARK: Smear (Blur, Smudge, Liquify)

class SmearTool implements ToolHandler {
  private active = false;
  down(c: ToolContext): void {
    const session = c.session, state = paintState(session);
    ensurePreviewSources(session);
    const dirty = beginRetouch(session, c.pixel, state.smearMode,
      { diameter: state.smear.diameter, hardness: state.smear.hardness, strength: state.smear.opacity });
    this.active = !!currentRetouchPreview(session) || dirty.length > 0;
    syncPreview(session);
  }
  move(c: ToolContext): void {
    if (!this.active) return;
    updateRetouch(c.session, [c.pixel]);
    syncPreview(c.session);
  }
  up(c: ToolContext): void {
    if (!this.active) return;
    this.active = false;
    commitRetouch(c.session);
    syncPreview(c.session);
  }
  cancel(session: EditorSession): void {
    this.active = false;
    if (cancelRetouch(session)) syncPreview(session);
  }
  hover(): string { return 'none'; }
}

// MARK: Gradient

class GradientTool implements ToolHandler {
  private handle: 'start' | 'end' | null = null;
  down(c: ToolContext): void {
    const session = c.session;
    ensurePreviewSources(session);
    const edit = pendingGradient(session);
    const document = session.document;
    if (edit && document && edit.hasLine) {
      const start = session.viewport.viewPoint(edit.start, document), end = session.viewport.viewPoint(edit.end, document);
      const radius = c.pointerType === 'touch' ? 22 : 10;
      if (Math.hypot(c.point.x - end.x, c.point.y - end.y) <= radius) { this.handle = 'end'; return; }
      if (Math.hypot(c.point.x - start.x, c.point.y - start.y) <= radius) { this.handle = 'start'; return; }
    }
    this.handle = beginGradient(session, c.pixel, gradientSettingsFor(session)) ? 'end' : null;
    syncPreview(session);
  }
  move(c: ToolContext): void {
    if (!this.handle) return;
    updateGradient(c.session, c.pixel, { endpoint: this.handle, shift: c.modifiers.shift, settings: gradientSettingsFor(c.session) });
    syncPreview(c.session);
  }
  up(c: ToolContext): void {
    if (!this.handle) return;
    this.handle = null;
    endGradientDrag(c.session);
    syncPreview(c.session);
  }
  cancel(session: EditorSession): void { this.handle = null; void session; }
  hover(c: ToolContext): string {
    const edit = pendingGradient(c.session), document = c.session.document;
    if (edit && document && edit.hasLine) {
      for (const p of [edit.start, edit.end]) {
        const v = c.session.viewport.viewPoint(p, document);
        if (Math.hypot(c.point.x - v.x, c.point.y - v.y) <= 10) return 'move';
      }
    }
    return 'crosshair';
  }
}

// MARK: Eyedropper

/**
 * ColorPalette.sampleCompositeColor, with Photoshop's eyedropper options: the visible composite (All Layers) or the
 * current layer, one pixel or the 3×3 / 5×5 average; null where transparent.
 */
export function sampleComposite(controller: EditorController, point: Point): PaletteColor | null {
  const session = controller.session, document = session.document, canvas = controller.canvas;
  if (!document) return null;
  return sampleColor(session, point, colorState(controller).getState().eyedropper,
    canvas ? (x, y, width, height) => canvas.readRegion(document, x, y, width, height) : null);
}

class EyedropperTool implements ToolHandler {
  private active = false;
  constructor(private readonly controller: EditorController) {}
  private sample(c: ToolContext): void {
    const session = c.session, state = paintState(session);
    const color = sampleComposite(this.controller, c.pixel);
    const picker = this.controller.colorPickerTarget;
    if (color) {
      if (picker) picker.set(color);
      // Photoshop: Alt-click with the Eyedropper tool sets the background colour.
      else if (session.canEditPalette && !session.isMaskSelected) session.setPaletteColor(color, session.tool === 'eyedropper' && c.modifiers.option);
    }
    state.sampling = state.sampling ? { ...state.sampling, point: c.point, sampled: picker?.get() ?? session.foregroundColor }
      : { point: c.point, original: picker?.get() ?? session.foregroundColor, sampled: picker?.get() ?? session.foregroundColor };
    session.notify('document');
  }
  down(c: ToolContext): void { this.active = true; paintState(c.session).sampling = null; this.sample(c); }
  move(c: ToolContext): void { if (this.active) this.sample(c); }
  up(c: ToolContext): void { this.active = false; paintState(c.session).sampling = null; c.session.notify('document'); }
  cancel(session: EditorSession): void { this.active = false; paintState(session).sampling = null; }
  hover(): string { return 'crosshair'; }
}

// MARK: Overlay painters

const isBrushLike = (tool: Tool) => tool === 'brush' || tool === 'cloneStamp' || tool === 'blur' || tool === 'spotHealing';
const css = (c: PaletteColor, alpha = 1) => `rgba(${Math.round(c.red * 255)},${Math.round(c.green * 255)},${Math.round(c.blue * 255)},${alpha})`;

function paintCursors(view: CanvasView) {
  return (context: CanvasRenderingContext2D, session: EditorSession): void => {
    const document = session.document;
    if (!document) return;
    const ppp = session.viewport.pointsPerPixel;
    // Brush outline and hardness ring at the pointer (BrushCursorOverlay).
    const point = view.hoverPoint;
    if (point && isBrushLike(session.tool)) {
      const settings = session.tool === 'blur' ? paintState(session).smear : getBrushSettings(session);
      const radius = Math.max(1, brushOutlineRadius(settings.diameter, ppp));
      context.lineWidth = 1;
      for (const [color, r] of [['rgba(0,0,0,0.7)', radius + 0.5], ['rgba(255,255,255,0.9)', radius - 0.5]] as const) {
        context.strokeStyle = color;
        context.beginPath();
        context.arc(point.x, point.y, Math.max(0.5, r), 0, Math.PI * 2);
        context.stroke();
      }
      if (settings.hardness < 1 && radius > 6) {
        context.setLineDash([2, 3]);
        context.strokeStyle = 'rgba(255,255,255,0.6)';
        context.beginPath();
        context.arc(point.x, point.y, radius * Math.max(0.05, settings.hardness), 0, Math.PI * 2);
        context.stroke();
        context.setLineDash([]);
      }
      if (radius < 4) {
        context.strokeStyle = 'rgba(255,255,255,0.9)';
        context.beginPath();
        context.moveTo(point.x - 6, point.y); context.lineTo(point.x + 6, point.y);
        context.moveTo(point.x, point.y - 6); context.lineTo(point.x, point.y + 6);
        context.stroke();
      }
    }
    // Clone source marker.
    if (session.tool === 'cloneStamp' && point) {
      const source = cloneSamplePoint(session, session.viewport.documentPoint(point, document));
      if (source) {
        const v = session.viewport.viewPoint(source, document);
        context.strokeStyle = '#fff';
        context.beginPath();
        context.moveTo(v.x - 7, v.y); context.lineTo(v.x + 7, v.y); context.moveTo(v.x, v.y - 7); context.lineTo(v.x, v.y + 7);
        context.stroke();
      }
    }
    // Pending gradient line with its end colours.
    const edit = pendingGradient(session);
    if (edit?.hasLine && session.tool === 'gradient') {
      const a = session.viewport.viewPoint(edit.start, document), b = session.viewport.viewPoint(edit.end, document);
      const settings = gradientSettingsFor(session);
      if (settings.shape === 'Radial') {
        const r = Math.hypot(b.x - a.x, b.y - a.y);
        context.setLineDash([4, 4]);
        context.strokeStyle = 'rgba(0,0,0,0.5)'; context.lineWidth = 2;
        context.beginPath(); context.arc(a.x, a.y, r, 0, Math.PI * 2); context.stroke();
        context.strokeStyle = 'rgba(255,255,255,0.8)'; context.lineWidth = 1;
        context.beginPath(); context.arc(a.x, a.y, r, 0, Math.PI * 2); context.stroke();
        context.setLineDash([]);
      }
      context.strokeStyle = 'rgba(0,0,0,0.7)'; context.lineWidth = 3;
      context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.stroke();
      context.strokeStyle = '#fff'; context.lineWidth = 1;
      context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.stroke();
      const ends: [Point, string][] = [[a, css(settings.reversed ? settings.background : settings.foreground)],
        [b, settings.style === 'Foreground to Transparent' ? 'rgba(0,0,0,0)' : css(settings.reversed ? settings.foreground : settings.background)]];
      for (const [p, color] of ends) {
        context.fillStyle = '#fff'; context.strokeStyle = '#000';
        context.beginPath(); context.arc(p.x, p.y, 6, 0, Math.PI * 2); context.fill(); context.stroke();
        context.fillStyle = 'rgb(191,191,191)'; context.beginPath(); context.arc(p.x, p.y, 3.5, 0, Math.PI * 2); context.fill();
        context.fillStyle = color; context.beginPath(); context.arc(p.x, p.y, 3.5, 0, Math.PI * 2); context.fill();
      }
    }
    // Sample ring while the eyedropper samples (SampleRingOverlay): new colour on top, original below.
    const sampling = paintState(session).sampling;
    if (sampling && paintState(session).showsSampleRing) {
      const { x, y } = sampling.point;
      const r = 58 - 15 - 12 + 12;
      context.lineWidth = 24;
      context.strokeStyle = 'rgb(115,115,115)';
      context.beginPath(); context.arc(x, y, r, 0, Math.PI * 2); context.stroke();
      context.lineWidth = 16;
      for (const [color, from, to] of [[sampling.sampled, Math.PI, Math.PI * 2], [sampling.original, 0, Math.PI]] as const) {
        context.strokeStyle = css(color);
        context.beginPath(); context.arc(x, y, r, from, to); context.stroke();
      }
    }
  };
}

// MARK: Headers

function Swatch({ color, onClick, label }: { color: PaletteColor; onClick: () => void; label: string }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick}
      style={{ width: 34, height: 18, borderRadius: 4, border: '1px solid #000', boxShadow: 'inset 0 0 0 1px #fff', background: css(color), flex: 'none', padding: 0 }} />
  );
}

function PercentField({ label, value, min = 0, onChange, testId }: { label: string; value: number; min?: number; onChange: (v: number) => void; testId?: string }) {
  return (
    <>
      <span className={styles.secondary} style={{ flex: 'none' }}>{label}</span>
      <input className={styles.slider} style={{ width: 100, flex: 'none' }} type="range" min={min} max={1} step={0.01} value={value}
        aria-label={label} data-testid={testId ? `${testId}-slider` : undefined} onChange={(e) => onChange(Number(e.target.value))} onKeyDown={(e) => e.stopPropagation()} />
      <NumberField label="" suffix="%" width={42} value={Math.round(value * 100)} testId={testId} onChange={(v) => onChange(Math.min(1, Math.max(min, v / 100)))} />
    </>
  );
}

/** Brush modes (PRODUCT-PLAN 6.3: Dodge/Burn/Sponge are modes of the one Brush tool, not three tools). */
const BRUSH_MODES: readonly { mode: BrushMode; label: string }[] = [
  { mode: 'paint', label: 'Paint' }, { mode: 'erase', label: 'Erase' }, { mode: 'dodge', label: 'Dodge' }, { mode: 'burn', label: 'Burn' }, { mode: 'sponge', label: 'Sponge' },
];
const BRUSH_TITLES: Record<BrushMode, string> = { paint: 'Brush', erase: 'Eraser', dodge: 'Dodge', burn: 'Burn', sponge: 'Sponge' };
const toning = (mode: BrushMode) => mode === 'dodge' || mode === 'burn' || mode === 'sponge';
/** A toning stroke's strength is its Exposure or Flow alone; the paint opacity does not apply to it. */
const toningStroke = (session: EditorSession) => session.tool === 'brush' && !session.isMaskSelected && toning(getBrushSettings(session).mode);

/** Range and Exposure for Dodge/Burn, Saturate/Desaturate, Flow and Vibrance for Sponge (Photoshop's option bars). */
function ToningControls({ controller, brush, update }: { controller: EditorController; brush: BrushSettings; update: (patch: Partial<BrushSettings>) => void }) {
  const t = controller.t;
  if (brush.mode === 'dodge' || brush.mode === 'burn') return (
    <>
      <span className={styles.secondary} style={{ flex: 'none' }}>{t('Range')}</span>
      <select className={styles.select} value={brush.range ?? 'midtones'} aria-label={t('Range')} data-testid="brush-range"
        onChange={(e) => update({ range: e.target.value as BrushRange })}>
        <option value="shadows">{t('Shadows')}</option>
        <option value="midtones">{t('Midtones')}</option>
        <option value="highlights">{t('Highlights')}</option>
      </select>
      <PercentField label={t('Exposure')} min={0.01} value={brush.exposure ?? 0.5} testId="brush-exposure" onChange={(exposure) => update({ exposure })} />
    </>
  );
  if (brush.mode === 'sponge') return (
    <>
      <select className={styles.select} value={brush.spongeMode ?? 'saturate'} aria-label={t('Mode')} data-testid="brush-sponge-mode"
        onChange={(e) => update({ spongeMode: e.target.value as 'saturate' | 'desaturate' })}>
        <option value="saturate">{t('Saturate')}</option>
        <option value="desaturate">{t('Desaturate')}</option>
      </select>
      <PercentField label={t('Flow')} min={0.01} value={brush.flow ?? 0.5} testId="brush-flow" onChange={(flow) => update({ flow })} />
      <label className={styles.check} title={t('Vibrance')}>
        <input type="checkbox" checked={!!brush.vibrance} data-testid="brush-vibrance" onChange={(e) => update({ vibrance: e.target.checked })} />{t('Vibrance')}
      </label>
    </>
  );
  return null;
}

function BrushBar({ controller, session }: { controller: EditorController; session: EditorSession }) {
  useSession(session);
  const t = controller.t;
  const tool = session.tool;
  const state = paintState(session);
  const smear = tool === 'blur';
  const settings: { diameter: number; hardness: number; opacity: number } = smear ? state.smear : getBrushSettings(session);
  const update = (patch: Partial<BrushSettings>) => {
    if (smear) { state.smear = { ...state.smear, ...patch }; session.notify('ui'); return; }
    setBrushSettings(session, { ...getBrushSettings(session), ...patch });
  };
  const brush = getBrushSettings(session);
  const clone = getCloneSettings(session);
  const title = tool === 'spotHealing' ? t('Spot Healing') : tool === 'cloneStamp' ? t('Clone Stamp') : smear ? t('Smear') : t(BRUSH_TITLES[brush.mode]);
  const toningMode = tool === 'brush' && !session.isMaskSelected && toning(brush.mode);
  const seg = <T extends string>(values: readonly T[], value: T, set: (v: T) => void, label: string) => (
    <div className={styles.segmented} role="radiogroup" aria-label={t(label)}>
      {values.map((v) => <button key={v} type="button" role="radio" aria-checked={v === value} className={`${styles.segment} ${v === value ? styles.segmentOn : ''}`} onClick={() => set(v)}>{t(v)}</button>)}
    </div>
  );
  return (
    <>
      <span className={styles.headerTitle}>{title}</span>
      {tool === 'brush' ? seg(BRUSH_MODES.map((m) => m.label), BRUSH_MODES.find((m) => m.mode === brush.mode)?.label ?? 'Paint',
        (v) => update({ mode: BRUSH_MODES.find((m) => m.label === v)?.mode ?? 'paint' }), 'Brush mode') : null}
      {smear ? seg(['Liquify', 'Blur', 'Smudge'] as const, (state.smearMode[0]!.toUpperCase() + state.smearMode.slice(1)) as 'Liquify' | 'Blur' | 'Smudge',
        (v) => { state.smearMode = v.toLowerCase() as RetouchMode; session.notify('ui'); }, 'Mode') : null}
      {controller.spotHealingControls && tool === 'spotHealing' ? controller.spotHealingControls(session) : null}
      {tool === 'cloneStamp' ? (
        <>
          <label className={styles.check} title={t('Keep the source moving with the brush between strokes; off starts every stroke at the source point')}>
            <input type="checkbox" checked={clone.aligned} onChange={(e) => setCloneSettings(session, { ...clone, aligned: e.target.checked })} />{t('Aligned')}
          </label>
          {seg(['This Layer', 'All Layers'] as const, clone.sampleAllLayers ? 'All Layers' : 'This Layer', (v) => setCloneSettings(session, { ...clone, sampleAllLayers: v === 'All Layers' }), 'Sample')}
        </>
      ) : null}
      <NumberField label={t('Size')} suffix="px" width={48} value={settings.diameter} onChange={(v) => update({ diameter: Math.min(2000, Math.max(1, Math.round(v))) })} />
      <PercentField label={t('Hardness')} value={settings.hardness} onChange={(v) => update({ hardness: v })} />
      {/* Toning modes have no opacity (Photoshop): their strength is Exposure or Flow. */}
      {toningMode ? null : <PercentField label={smear ? t('Strength') : t('Opacity')} min={0.01} value={settings.opacity} onChange={(v) => update({ opacity: v })} />}
      {toningMode ? <ToningControls controller={controller} brush={brush} update={update} /> : null}
      {session.isMaskSelected ? (
        <select className={styles.select} value={session.maskPaintWhite ? 'white' : 'black'} aria-label="Paint"
          onChange={(e) => { session.maskPaintWhite = e.target.value === 'white'; session.notify('ui'); }}>
          <option value="black">{t('Black · Hide')}</option>
          <option value="white">{t('White · Reveal')}</option>
        </select>
      ) : tool !== 'cloneStamp' && !smear && !toningMode ? (
        <>
          <span className={styles.secondary}>{t('Color')}</span>
          <Swatch color={session.foregroundColor} label={t('Foreground color')} onClick={() => controller.openColorPicker?.(false)} />
        </>
      ) : null}
      <span className={styles.spacer} />
      {tool === 'cloneStamp' && !cloneSamplePoint(session, { x: 0, y: 0 }) ? <span className={styles.secondary}>{t('Option-click to set the source')}</span> : null}
      {tool === 'cloneStamp' ? (
        <button type="button" className={`${styles.pill} ${controller.cloneSourceArmed ? styles.pillOn : ''}`}
          title={t('Touch: tap to arm, then tap the canvas to set the source')}
          onClick={() => { controller.cloneSourceArmed = !controller.cloneSourceArmed; session.notify('ui'); }}>{t('Set Source')}</button>
      ) : null}
      {session.isMaskSelected ? <span className={styles.secondary}>{t('Mask')}</span> : null}
    </>
  );
}

function GradientBar({ controller, session }: { controller: EditorController; session: EditorSession }) {
  useSession(session);
  const t = controller.t;
  const state = paintState(session);
  const settings = gradientSettingsFor(session);
  const set = (patch: Partial<GradientSettings>) => {
    state.gradient = { ...state.gradient, ...patch };
    refreshGradient(session, gradientSettingsFor(session));
    syncPreview(session);
  };
  const edit = pendingGradient(session);
  const colors = [settings.reversed ? settings.background : settings.foreground,
    settings.style === 'Foreground to Transparent' ? null : settings.reversed ? settings.foreground : settings.background];
  return (
    <>
      <span className={styles.headerTitle}>{t('Gradient')}</span>
      <div className={styles.segmented} role="radiogroup" aria-label={t('Shape')}>
        {(['Linear', 'Radial'] as GradientShape[]).map((v) => <button key={v} type="button" role="radio" aria-checked={settings.shape === v}
          className={`${styles.segment} ${settings.shape === v ? styles.segmentOn : ''}`} onClick={() => set({ shape: v })}>{t(v)}</button>)}
      </div>
      <span aria-hidden style={{ width: 56, height: 18, borderRadius: 3, border: '1px solid rgba(0,0,0,.5)', flex: 'none',
        background: `linear-gradient(to right, ${css(colors[0]!)}, ${colors[1] ? css(colors[1]) : css(colors[0]!, 0)}), repeating-conic-gradient(#999 0 25%, #fff 0 50%) 0 0/8px 8px` }} />
      <select className={styles.select} value={settings.style} aria-label={t('Colors')} onChange={(e) => set({ style: e.target.value as GradientStyle })}>
        {(['Foreground to Background', 'Foreground to Transparent'] as GradientStyle[]).map((v) => <option key={v} value={v}>{t(v)}</option>)}
      </select>
      <label className={styles.check}><input type="checkbox" checked={settings.reversed} onChange={(e) => set({ reversed: e.target.checked })} />{t('Reverse')}</label>
      <PercentField label={t('Opacity')} min={0.01} value={settings.opacity} onChange={(v) => set({ opacity: v })} />
      <span className={styles.spacer} />
      {session.isMaskSelected ? <span className={styles.secondary}>{t('Mask')}</span> : null}
      {edit ? (
        <>
          <button type="button" className={styles.pill} onClick={() => { cancelGradient(session); syncPreview(session); }}>{t('Cancel')}</button>
          <button type="button" className={`${styles.pill} ${styles.pillPrimary}`} onClick={() => { commitGradient(session); syncPreview(session); }}>{t('Apply')}</button>
        </>
      ) : null}
    </>
  );
}

function EyedropperBar({ controller, session }: { controller: EditorController; session: EditorSession }) {
  useSession(session);
  const state = paintState(session);
  const t = controller.t;
  const store = colorState(controller);
  const options = useSyncExternalStore(store.subscribe, () => store.getState().eyedropper);
  const sizes: [SampleSize, string][] = [[1, 'Point Sample'], [3, '3 by 3 Average'], [5, '5 by 5 Average']];
  return (
    <>
      <span className={styles.headerTitle}>{t('Eyedropper')}</span>
      <span className={styles.secondary} style={{ flex: 'none' }}>{t('Sample Size')}</span>
      <select className={styles.select} value={options.size} aria-label={t('Sample Size')} data-testid="eyedropper-size"
        onChange={(e) => store.setState({ eyedropper: { ...options, size: Number(e.target.value) as SampleSize } })}>
        {sizes.map(([size, label]) => <option key={size} value={size}>{t(label)}</option>)}
      </select>
      <div className={styles.segmented} role="radiogroup" aria-label={t('Sample')}>
        {[false, true].map((all) => (
          <button key={String(all)} type="button" role="radio" aria-checked={options.allLayers === all} data-testid={`eyedropper-${all ? 'all' : 'current'}`}
            className={`${styles.segment} ${options.allLayers === all ? styles.segmentOn : ''}`}
            onClick={() => store.setState({ eyedropper: { ...options, allLayers: all } })}>{t(all ? 'All Layers' : 'Current Layer')}</button>
        ))}
      </div>
      <label className={styles.check}><input type="checkbox" checked={state.showsSampleRing}
        onChange={(e) => { state.showsSampleRing = e.target.checked; session.notify('ui'); }} />{controller.t('Sample Ring')}</label>
    </>
  );
}

// MARK: Color Picker (ColorPickerSheet.swift)

function toHsb(c: PaletteColor): { hue: number; saturation: number; brightness: number } {
  const max = Math.max(c.red, c.green, c.blue), min = Math.min(c.red, c.green, c.blue), d = max - min;
  let hue = 0;
  if (d > 0) {
    if (max === c.red) hue = ((c.green - c.blue) / d) % 6;
    else if (max === c.green) hue = (c.blue - c.red) / d + 2;
    else hue = (c.red - c.green) / d + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  return { hue, saturation: max > 0 ? d / max : 0, brightness: max };
}
function fromHsb(h: { hue: number; saturation: number; brightness: number }): PaletteColor {
  const c = h.brightness * h.saturation, x = c * (1 - Math.abs(((h.hue / 60) % 2) - 1)), m = h.brightness - c;
  const [r, g, b] = h.hue < 60 ? [c, x, 0] : h.hue < 120 ? [x, c, 0] : h.hue < 180 ? [0, c, x] : h.hue < 240 ? [0, x, c] : h.hue < 300 ? [x, 0, c] : [c, 0, x];
  return { red: r + m, green: g + m, blue: b + m };
}
const hex = (c: PaletteColor) => [c.red, c.green, c.blue].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('').toUpperCase();

/** 3- or 6-digit hex, with or without # (ColorPickerTests.hexParsesFullShorthandAndRejectsInvalid). */
export function parseHex(text: string): PaletteColor | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text.trim());
  if (!m) return null;
  const digits = m[1]!.length === 3 ? m[1]!.split('').map((d) => d + d).join('') : m[1]!;
  return { red: parseInt(digits.slice(0, 2), 16) / 255, green: parseInt(digits.slice(2, 4), 16) / 255, blue: parseInt(digits.slice(4, 6), 16) / 255 };
}

/** RGB → HSB that keeps the previous hue for grays and hue/saturation for black (graysAndBlackKeepPreviousHueAndSaturation). */
export function hsbKeeping(color: PaletteColor, previous: { hue: number; saturation: number; brightness: number }) {
  const next = toHsb(color);
  if (next.brightness === 0) return { hue: previous.hue, saturation: previous.saturation, brightness: 0 };
  if (next.saturation === 0) return { ...next, hue: previous.hue };
  return next;
}

/** The open picker, per controller; the panel renders while one is set. */
const pickRequests = new WeakMap<EditorController, { request: ColorPickRequest; listeners: Set<() => void> }>();
function pickerStore(controller: EditorController) {
  let store = pickRequests.get(controller);
  if (!store) { store = { request: null as unknown as ColorPickRequest, listeners: new Set() }; pickRequests.set(controller, store); }
  return store;
}
function setPickRequest(controller: EditorController, request: ColorPickRequest | null): void {
  const store = pickerStore(controller);
  store.request = request as ColorPickRequest;
  for (const listener of store.listeners) listener();
}

function ColorPickerPanel({ controller }: { controller: EditorController }) {
  const store = pickerStore(controller);
  const request = useSyncExternalStore((l) => { store.listeners.add(l); return () => store.listeners.delete(l); }, () => store.request);
  return request ? <ColorPicker key={request.title + JSON.stringify(request.initial)} controller={controller} request={request} /> : null;
}

function ColorPicker({ controller, request }: { controller: EditorController; request: ColorPickRequest }) {
  const t = controller.t;
  const original = request.initial;
  const [hsb, setHsb] = useState(() => toHsb(original));
  const [hexDraft, setHexDraft] = useState(hex(original));
  const color = fromHsb(hsb);
  const hsbRef = useRef(hsb);
  hsbRef.current = hsb;
  useEffect(() => { setHexDraft(hex(color)); request.preview?.(color); }, [hsb.hue, hsb.saturation, hsb.brightness]); // eslint-disable-line react-hooks/exhaustive-deps
  // While open, clicks on the canvas sample the composite into the picker (ColorPickerSheet: "Click the canvas to sample").
  useEffect(() => {
    controller.colorPickerTarget = { get: () => fromHsb(hsbRef.current), set: (c) => setHsb((h) => hsbKeeping(c, h)) };
    return () => { controller.colorPickerTarget = null; };
  }, [controller]);
  const finish = (commit: boolean) => {
    setPickRequest(controller, null);
    if (commit) request.commit(fromHsb(hsbRef.current)); else request.cancel?.();
  };
  const drag = (element: HTMLElement, event: React.PointerEvent, apply: (x: number, y: number) => void) => {
    const rect = element.getBoundingClientRect();
    const handle = (e: PointerEvent | React.PointerEvent) => apply(Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)), Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)));
    handle(event);
    element.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) => handle(e);
    const up = () => { element.removeEventListener('pointermove', move); element.removeEventListener('pointerup', up); };
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', up);
  };
  const pure = fromHsb({ hue: hsb.hue, saturation: 1, brightness: 1 });
  const channel = (label: string, key: keyof PaletteColor) => (
    <NumberField label={label} width={52} value={Math.round(color[key] * 255)}
      onChange={(v) => setHsb((h) => hsbKeeping({ ...color, [key]: Math.min(255, Math.max(0, Math.round(v))) / 255 }, h))} />
  );
  return (
    <FloatingPanel name="colorPicker" title={request.title} onClose={() => finish(false)} closeLabel={t('Cancel')} testId="color-picker" secondary
      className={controller.colorPickerExtras ? styles.floatingPanelWide : undefined}>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}
        onKeyDown={(event) => { if (event.key === 'Escape') finish(false); else if (event.key === 'Enter' && !(event.target as Element).closest('input')) finish(true); }}>
        <div role="slider" aria-label="Saturation and brightness" aria-valuetext={`${Math.round(hsb.saturation * 100)}%, ${Math.round(hsb.brightness * 100)}%`} tabIndex={0}
          style={{ position: 'relative', width: 220, maxWidth: '100%', height: 220, flex: 'none', touchAction: 'none', border: '1px solid rgba(0,0,0,.6)',
            background: `linear-gradient(to bottom, transparent, #000), linear-gradient(to right, #fff, ${css(pure)})` }}
          onPointerDown={(e) => drag(e.currentTarget, e, (x, y) => setHsb((h) => ({ ...h, saturation: x, brightness: 1 - y })))}>
          <span style={{ position: 'absolute', left: `calc(${hsb.saturation * 100}% - 6px)`, top: `calc(${(1 - hsb.brightness) * 100}% - 6px)`, width: 12, height: 12,
            borderRadius: '50%', border: '1.5px solid #fff', boxShadow: '0 0 0 0.75px #000', pointerEvents: 'none' }} />
        </div>
        <div role="slider" aria-label="Hue" aria-valuenow={Math.round(hsb.hue)} aria-valuemin={0} aria-valuemax={360} tabIndex={0}
          style={{ position: 'relative', width: 30, height: 220, flex: 'none', touchAction: 'none' }}
          onPointerDown={(e) => drag(e.currentTarget, e, (_x, y) => setHsb((h) => ({ ...h, hue: (1 - y) * 360 })))}>
          <span style={{ position: 'absolute', left: 6, width: 18, top: 0, bottom: 0, border: '1px solid rgba(0,0,0,.6)',
            background: 'linear-gradient(to bottom, #f00, #f0f, #00f, #0ff, #0f0, #ff0, #f00)' }} />
          <span style={{ position: 'absolute', left: 0, right: 0, top: `calc(${(1 - hsb.hue / 360) * 100}% - 1px)`, height: 2, background: 'var(--cmp-text)' }} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 120 }}>
          <div aria-label="New and current color" style={{ width: 64, height: 56, borderRadius: 5, overflow: 'hidden', border: '1px solid rgba(0,0,0,.6)' }}>
            <div style={{ height: '50%', background: css(color) }} />
            <div style={{ height: '50%', background: css(original) }} />
          </div>
          {channel('R', 'red')}
          {channel('G', 'green')}
          {channel('B', 'blue')}
          <label className={styles.field}><span>#</span>
            <input value={hexDraft} aria-label="Hex color" data-testid="color-hex" style={{ width: 76, fontFamily: 'ui-monospace, monospace' }}
              onChange={(e) => setHexDraft(e.target.value)}
              onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              onBlur={() => {
                const parsed = parseHex(hexDraft);
                if (parsed) setHsb((h) => hsbKeeping(parsed, h)); else setHexDraft(hex(color));
              }} />
          </label>
        </div>
        {controller.colorPickerExtras?.(color, (c) => setHsb((h) => hsbKeeping(c, h)))}
      </div>
      <span className={styles.panelNote}>{t('Click the canvas to sample')}</span>
      <div className={styles.dialogButtons}>
        <button type="button" className={styles.pill} onClick={() => finish(false)} data-testid="color-cancel">{t('Cancel')}</button>
        <button type="button" className={`${styles.pill} ${styles.pillPrimary}`} onClick={() => finish(true)} data-testid="color-ok">{t('OK')}</button>
      </div>
    </FloatingPanel>
  );
}

/** Canvas clicks while the picker is open: sample the composite, whatever the tool (ColorPickerSheet sampling). */
class PickerSampler implements ToolHandler {
  constructor(private readonly controller: EditorController) {}
  private sample(c: ToolContext): void {
    const color = sampleComposite(this.controller, c.pixel);
    if (color) this.controller.colorPickerTarget?.set(color);
  }
  down(c: ToolContext): void { this.sample(c); }
  move(c: ToolContext): void { this.sample(c); }
  up(): void {}
  cancel(): void {}
  hover(): string { return 'crosshair'; }
}

// MARK: Installation

export function installPainting(controller: EditorController): void {
  const previousIcon = controller.toolIcon;
  controller.toolIcon = (tool) => (tool === 'brush' && getBrushSettings(controller.session).mode === 'erase' ? 'eraser' : previousIcon?.(tool) ?? null);
  for (const tool of ['brush', 'cloneStamp', 'blur', 'gradient', 'eyedropper'] as const) controller.availableTools.add(tool);
  controller.canvasSetups.push((view) => {
    const brush = new BrushTool();
    view.tools.brush = brush;
    view.tools.cloneStamp = {
      down: (c) => {
        if (controller.cloneSourceArmed) { setCloneSource(c.session, c.pixel); controller.cloneSourceArmed = false; c.session.notify('ui'); return; }
        brush.down(c);
      },
      move: (c) => brush.move(c), up: (c) => brush.up(c), cancel: (s) => brush.cancel(s), hover: (c) => brush.hover(c),
    };
    view.tools.blur = new SmearTool();
    view.tools.gradient = new GradientTool();
    view.tools.eyedropper = new EyedropperTool(controller);
    view.painters.push(paintCursors(view));
  });
  for (const tool of ['brush', 'cloneStamp', 'blur'] as const) controller.contextBars[tool] = (session) => <BrushBar controller={controller} session={session} />;
  controller.contextBars.gradient = (session) => <GradientBar controller={controller} session={session} />;
  controller.contextBars.eyedropper = (session) => <EyedropperBar controller={controller} session={session} />;
  const t = controller.t;
  const brushHints: Record<BrushMode, string> = { paint: 'Drag to paint', erase: 'Drag to erase', dodge: 'Drag to dodge', burn: 'Drag to burn', sponge: 'Drag to change saturation' };
  controller.statusHints.brush = (s) => {
    const mode = getBrushSettings(s).mode;
    const keys = !toningStroke(s) ? '[ ] size · Shift-[ ] hardness · 1–0 opacity · Escape cancel · Space to pan'
      : mode === 'sponge' ? '[ ] size · Shift-[ ] hardness · 1–0 flow · Escape cancel · Space to pan'
      : '[ ] size · Shift-[ ] hardness · 1–0 exposure · Escape cancel · Space to pan';
    return `${t(brushHints[mode])} · ${t(keys)}`;
  };
  controller.statusHints.blur = (s) => `${paintState(s).smearMode === 'blur' ? t('Drag to soften') : paintState(s).smearMode === 'smudge' ? t('Drag to smudge') : t('Drag to push pixels')} · ${t('[ ] size · Shift-[ ] hardness · 1–0 strength · Space to pan')}`;
  controller.statusHints.cloneStamp = () => t('Option-click to set the source · Drag to clone · [ ] size · Shift-[ ] hardness · 1–0 opacity · Space to pan');
  controller.statusHints.gradient = () => t('Drag to draw · Drag ends to adjust · Shift 45° · 1–0 opacity · Enter apply · Escape cancel');
  controller.statusHints.eyedropper = () => `${t('Click or drag to sample the canvas colour')} · ${t('Option-click sets the background colour')}`;

  controller.toolKeyHandlers.b = () => { controller.session.selectTool('brush'); setBrushSettings(controller.session, { ...getBrushSettings(controller.session), mode: 'paint' }); };
  controller.toolKeyHandlers.e = () => { controller.session.selectTool('brush'); setBrushSettings(controller.session, { ...getBrushSettings(controller.session), mode: 'erase' }); };
  controller.opacityKey = (digit) => {
    const session = controller.session;
    if (!isBrushLike(session.tool) && session.tool !== 'gradient') return false;
    const pending = paintState(session);
    // Two quick digits set an exact value (typeOpacityDigit).
    const now = performance.now() / 1000;
    let percent = digit === 0 ? 100 : digit * 10;
    if (controller.lastOpacityDigit && now - controller.lastOpacityDigit.time < 0.6) { percent = Math.max(1, controller.lastOpacityDigit.digit * 10 + digit); controller.lastOpacityDigit = null; }
    else controller.lastOpacityDigit = { digit, time: now };
    const value = percent / 100;
    if (session.tool === 'gradient') { pending.gradient = { ...pending.gradient, opacity: value }; refreshGradient(session, gradientSettingsFor(session)); syncPreview(session); }
    else if (session.tool === 'blur') { pending.smear = { ...pending.smear, opacity: value }; session.notify('ui'); }
    // Photoshop: the number keys set a toning tool's Exposure (Dodge/Burn) or Flow (Sponge).
    else if (toningStroke(session)) setBrushSettings(session, { ...getBrushSettings(session), ...(getBrushSettings(session).mode === 'sponge' ? { flow: value } : { exposure: value }) });
    else setBrushSettings(session, { ...getBrushSettings(session), opacity: value });
    return true;
  };
  controller.keyHandlers.push((event) => {
    const session = controller.session;
    if (event.metaKey || event.ctrlKey || event.altKey) return false;
    if (session.tool === 'gradient' && (event.key === 'Enter' || event.key === 'Escape')) {
      const handled = handleGradientKey(session, event.key);
      if (handled) syncPreview(session);
      return handled;
    }
    if (event.key === 'Escape' && (isBrushStrokeActive(session) || currentRetouchPreview(session))) {
      cancelBrushStroke(session); cancelRetouch(session); syncPreview(session); return true;
    }
    if (!isBrushLike(session.tool)) return false;
    const smear = session.tool === 'blur';
    const step = (increase: boolean, hardness: boolean) => {
      if (smear) {
        const s = paintState(session);
        if (hardness) { const q = s.smear.hardness * 4; s.smear = { ...s.smear, hardness: Math.min(4, Math.max(0, increase ? Math.floor(q + 0.001) + 1 : Math.ceil(q - 0.001) - 1)) / 4 }; }
        else { const d = s.smear.diameter; s.smear = { ...s.smear, diameter: Math.min(2000, Math.max(1, increase ? Math.max(d + 1, Math.round(d * 1.2)) : Math.min(d - 1, Math.round(d / 1.2)))) }; }
        session.notify('ui');
      } else if (hardness) changeBrushHardness(session, increase);
      else changeBrushSize(session, increase);
      controller.canvasView?.redraw();
    };
    if (event.code === 'BracketLeft' || event.code === 'BracketRight') { step(event.code === 'BracketRight', event.shiftKey); return true; }
    return false;
  });
  // Right-drag with a brush tool (EditorCanvas.rightMouseDown/Dragged): left/right resize the brush from its size at the
  // press, each point moved widening the radius by a point on screen; with Shift the full hardness range spans 200 points.
  controller.secondaryDrags.push((session) => {
    if (!isBrushLike(session.tool) || isBrushStrokeActive(session) || !session.document) return null;
    const smear = session.tool === 'blur';
    const start = smear ? { ...paintState(session).smear } : { ...getBrushSettings(session) };
    return {
      move: (dx, { shift }) => {
        const perPixel = Math.max(0.0001, session.viewport.pointsPerPixel);
        const diameter = shift ? start.diameter : Math.min(2000, Math.max(1, Math.round(start.diameter + 2 * dx / perPixel)));
        const hardness = shift ? Math.min(1, Math.max(0, start.hardness + dx / 200)) : start.hardness;
        if (smear) paintState(session).smear = { ...paintState(session).smear, diameter, hardness };
        else setBrushSettings(session, { ...getBrushSettings(session), diameter, hardness });
        session.notify('ui');
      },
      end: () => {},
    };
  });
  controller.openColorPicker = (background) => {
    const session = controller.session;
    if (!session.canEditPalette) return;
    if (session.isMaskSelected) {
      // A mask paints black or white only (ColorPaletteControls' mask popover).
      void controller.confirm(t(background ? 'Mask background' : 'Mask foreground'), '', [
        { label: t('Black · Hide'), value: 'black' }, { label: t('White · Reveal'), value: 'white' }, { label: t('Cancel'), value: 'cancel', role: 'cancel' },
      ]).then((choice) => {
        if (choice === 'black' || choice === 'white') session.setPaletteColor(choice === 'white' ? { red: 1, green: 1, blue: 1 } : { red: 0, green: 0, blue: 0 }, background);
      });
      return;
    }
    controller.pickColor?.({
      title: background ? t('Color Picker (Background Color)') : t('Color Picker (Foreground Color)'),
      initial: session.paletteColor(background),
      commit: (color) => session.setPaletteColor(color, background),
    });
  };
  controller.pickColor = (request) => { controller.colorPickerTarget = null; setPickRequest(controller, request); };
  controller.closeColorPicker = () => { if (pickerStore(controller).request) setPickRequest(controller, null); };
  controller.panels.push(() => <ColorPickerPanel controller={controller} />);
  const sampler = new PickerSampler(controller);
  controller.canvasInterceptors.push(() => (pickerStore(controller).request ? sampler : null));
  // Option held with Brush, Spot Healing or Gradient samples the color instead (EditorCanvas.palettePicking).
  const optionDropper = new EyedropperTool(controller);
  controller.canvasInterceptors.push((session, modifiers) =>
    modifiers.option && (session.tool === 'brush' || session.tool === 'spotHealing' || session.tool === 'gradient') && !isBrushStrokeActive(session)
      ? optionDropper : null);
}
