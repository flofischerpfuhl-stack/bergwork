/**
 * Layer styles in the UI (PRODUCT-PLAN 6.7, Photoshop muscle memory): the Layer Style dialog with live canvas
 * preview, the Layer › Layer Style submenu, and the commands the Layers panel uses (fx badge, effect rows, fx button).
 * The engine (effect records, rendering, undoable session commands) lives in core/effects and EditorSession.
 *
 * The dialog is a movable panel that never dims the canvas, so every change previews at once. Everything done
 * between opening and OK is one undo step ("Layer Style"); Cancel puts the layer's effects and the global light
 * back as they were. While it is open the document is otherwise read-only, as with the adjustment panels.
 */

import { useEffect, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import styles from '../ui/editor.module.css';
import type { EditorController, LayerStyleCommands } from '../ui/controller';
import type { MenuEntry } from '../ui/menus';
import { useSession } from '../ui/hooks';
import { Icon } from '../ui/icons';
import { editBlockers, type EditorSession } from '../core/session';
import { BLEND_MODES, type CanvasDocument, type Layer } from '../core/document';
import { DEFAULT_GLOBAL_LIGHT_ANGLE } from '../core/effects/render';
import type { BlendIfChannel, BlendIfSettings, BlendMode, EffectFill, EffectGradient, GradientStop, LayerEffect, RGB } from '../core/model/types';
import { decodeImageFile } from '../io/imageImport';
import { FloatingPanel } from './panels';
import { Check, Segmented } from './adjustmentsFeature';

type EffectKind = LayerEffect['kind'];
type EffectOf<K extends EffectKind> = Extract<LayerEffect, { kind: K }>;

/** Photoshop's Layer Style list order (the top of the stack first). */
const KINDS: readonly EffectKind[] = ['bevelEmboss', 'stroke', 'innerShadow', 'innerGlow', 'satin',
  'colorOverlay', 'gradientOverlay', 'patternOverlay', 'outerGlow', 'dropShadow'];
const LABELS: Record<EffectKind, string> = {
  bevelEmboss: 'Bevel & Emboss', stroke: 'Stroke', innerShadow: 'Inner Shadow', innerGlow: 'Inner Glow', satin: 'Satin',
  colorOverlay: 'Color Overlay', gradientOverlay: 'Gradient Overlay', patternOverlay: 'Pattern Overlay',
  outerGlow: 'Outer Glow', dropShadow: 'Drop Shadow',
};
/** Stacking from the bottom: new effects are inserted where Photoshop draws them. */
const RANK: Record<EffectKind, number> = { dropShadow: 0, outerGlow: 1, colorOverlay: 2, gradientOverlay: 3,
  patternOverlay: 4, satin: 5, innerGlow: 6, innerShadow: 7, stroke: 8, bevelEmboss: 9 };

const BLACK: RGB = { red: 0, green: 0, blue: 0 };
const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));

const PATTERNS = {
  checker: { id: 'fernwork-pattern-checker', width: 8, height: 8, pixel: (x: number, y: number) => ((x >> 2) + (y >> 2)) % 2 ? 176 : 232 },
  dots: { id: 'fernwork-pattern-dots', width: 8, height: 8, pixel: (x: number, y: number) => ((x - 3.5) ** 2 + (y - 3.5) ** 2 < 5 ? 90 : 225) },
  diagonal: { id: 'fernwork-pattern-diagonal', width: 8, height: 8, pixel: (x: number, y: number) => ((x + y) % 8 < 2 ? 100 : 235) },
} as const;
type PatternPreset = keyof typeof PATTERNS;

function ensureProceduralPattern(session: EditorSession, preset: PatternPreset) {
  const spec = PATTERNS[preset], document = session.document;
  if (!document) return { resourceId: spec.id, patternWidth: spec.width, patternHeight: spec.height };
  if (!document.resources?.some((resource) => resource.id === spec.id)) {
    const bytes = new Uint8Array(spec.width * spec.height * 4);
    for (let y = 0; y < spec.height; y++) for (let x = 0; x < spec.width; x++) {
      const index = (y * spec.width + x) * 4, value = spec.pixel(x, y);
      bytes[index] = value; bytes[index + 1] = value; bytes[index + 2] = value; bytes[index + 3] = 255;
    }
    session.replaceDocument({ ...document, resources: [...(document.resources ?? []),
      { id: spec.id, role: 'pattern', mime: 'application/x-fernwork-rgba8', bytes }] });
  }
  return { resourceId: spec.id, patternWidth: spec.width, patternHeight: spec.height };
}

/** Photoshop's defaults for a newly enabled effect. */
function defaultEffect(kind: EffectKind, session: EditorSession): LayerEffect {
  switch (kind) {
    case 'dropShadow': return { kind, schemaVersion: 1, enabled: true, blendMode: 'multiply', color: BLACK, opacity: 0.35, angle: 120,
      useGlobalLight: true, distance: 5, spread: 0, size: 5, blur: 5, contour: 'linear', noise: 0, knockout: true };
    case 'stroke': return { kind, schemaVersion: 1, enabled: true, width: 3, position: 'outside', blendMode: 'normal', opacity: 1, color: BLACK };
    case 'outerGlow': return { kind, schemaVersion: 1, enabled: true, blendMode: 'screen', opacity: 0.35,
      color: { red: 1, green: 1, blue: 190 / 255 }, spread: 0, size: 5, contour: 'linear', noise: 0 };
    case 'colorOverlay': return { kind, schemaVersion: 1, enabled: true, blendMode: 'normal', opacity: 1, color: { red: 1, green: 0, blue: 0 } };
    case 'gradientOverlay': return { kind, schemaVersion: 1, enabled: true, blendMode: 'normal', opacity: 1, angle: 90, scale: 100,
      gradient: paletteGradient(session) };
    case 'innerShadow': return { kind, schemaVersion: 1, enabled: true, blendMode: 'multiply', color: BLACK, opacity: 0.35,
      angle: 120, useGlobalLight: true, distance: 5, choke: 0, size: 5, contour: 'linear' };
    case 'innerGlow': return { kind, schemaVersion: 1, enabled: true, blendMode: 'screen', color: { red: 1, green: 1, blue: 190 / 255 },
      opacity: 0.35, source: 'edge', choke: 0, size: 5, contour: 'linear' };
    case 'bevelEmboss': return { kind, schemaVersion: 1, enabled: true, style: 'innerBevel', technique: 'smooth', depth: 100,
      direction: 'up', size: 5, soften: 0, angle: 120, altitude: 30, useGlobalLight: true,
      highlightMode: 'screen', highlightColor: { red: 1, green: 1, blue: 1 }, highlightOpacity: 0.75,
      shadowMode: 'multiply', shadowColor: BLACK, shadowOpacity: 0.75, glossContour: 'linear' };
    case 'satin': return { kind, schemaVersion: 1, enabled: true, blendMode: 'multiply', color: BLACK, opacity: 0.5,
      angle: 19, distance: 11, size: 14, invert: true, contour: 'linear' };
    case 'patternOverlay': return { kind, schemaVersion: 1, enabled: true, blendMode: 'normal', opacity: 1,
      ...ensureProceduralPattern(session, 'checker'), scale: 100, angle: 0, linkWithLayer: true };
  }
}

/** Foreground to background, as Photoshop's default gradient. */
function paletteGradient(session: EditorSession): EffectGradient {
  const rgb = (c: RGB): RGB => ({ red: c.red, green: c.green, blue: c.blue });
  return { stops: [{ offset: 0, color: rgb(session.foregroundColor), opacity: 1 }, { offset: 1, color: rgb(session.backgroundColor), opacity: 1 }] };
}

function styleable(layer: Layer | null): layer is Layer {
  return !!layer && layer.kind !== 'group' && !layer.adjustment;
}

/** Index of the nth effect of a kind, or -1. */
function indexOf(effects: readonly LayerEffect[], kind: EffectKind, ordinal: number): number {
  let seen = 0;
  for (let i = 0; i < effects.length; i++) if (effects[i]!.kind === kind && seen++ === ordinal) return i;
  return -1;
}
function ordinalOf(effects: readonly LayerEffect[], index: number): number {
  const kind = effects[index]?.kind;
  return effects.slice(0, index).filter((e) => e.kind === kind).length;
}
/** After the last effect drawn at or below this kind. */
function insertionIndex(effects: readonly LayerEffect[], kind: EffectKind): number {
  for (let i = effects.length - 1; i >= 0; i--) if (RANK[effects[i]!.kind] <= RANK[kind]) return i + 1;
  return 0;
}

// MARK: The open edit

interface StyleEdit {
  readonly layerId: string;
  readonly before: readonly LayerEffect[];
  readonly beforeBlendIf: BlendIfSettings | null;
  readonly beforeAngle: number;
  readonly beforeResources: CanvasDocument['resources'];
  /** Effects of each kind the layer had when the dialog opened; later ones of that kind were added in the dialog. */
  readonly beforeCounts: Readonly<Record<EffectKind, number>>;
  selected: { kind: EffectKind | 'blendingOptions'; ordinal: number };
}
const edits = new WeakMap<EditorSession, StyleEdit>();
/** Set while the dialog itself calls the session, which the edit blocker otherwise refuses. */
let applying = false;
function own<T>(body: () => T): T {
  applying = true;
  try { return body(); } finally { applying = false; }
}
const blocksEditing = (session: EditorSession) => !applying && edits.has(session);

function currentEffect(session: EditorSession, edit: StyleEdit): { effect: LayerEffect; index: number } | null {
  if (edit.selected.kind === 'blendingOptions') return null;
  const effects = session.layer(edit.layerId)?.effects ?? [];
  const index = indexOf(effects, edit.selected.kind, edit.selected.ordinal);
  return index < 0 ? null : { effect: effects[index]!, index };
}

function addEffect(session: EditorSession, edit: StyleEdit, kind: EffectKind): void {
  const effects = session.layer(edit.layerId)?.effects ?? [];
  const at = insertionIndex(effects, kind);
  if (own(() => session.addLayerEffect(edit.layerId, defaultEffect(kind, session), at))) {
    edit.selected = { kind, ordinal: ordinalOf(session.layer(edit.layerId)!.effects, at) };
  }
}

function openStyle(controller: EditorController, layerId: string, target?: EffectKind | number | 'blendingOptions'): void {
  const session = controller.session;
  const layer = session.layer(layerId);
  if (!styleable(layer) || !session.document) return;
  let edit = edits.get(session);
  if (edit && edit.layerId !== layerId) { finishStyle(controller, true); edit = undefined; }
  if (!edit) {
    // Lock All refuses the edit; the lock notice says why.
    if (!session.canEditLayers || session.refuseLayerEdit(layerId, 'appearance')) return;
    session.selectLayer(layerId);
    const counts = Object.fromEntries(KINDS.map((k) => [k, layer.effects.filter((e) => e.kind === k).length])) as Record<EffectKind, number>;
    const first = [...layer.effects.keys()].sort((a, b) => KINDS.indexOf(layer.effects[a]!.kind) - KINDS.indexOf(layer.effects[b]!.kind))[0];
    edit = {
      layerId, before: layer.effects, beforeBlendIf: layer.blendIf ?? null,
      beforeAngle: session.document.globalLightAngle ?? DEFAULT_GLOBAL_LIGHT_ANGLE, beforeCounts: counts,
      beforeResources: session.document.resources,
      selected: first === undefined ? { kind: 'dropShadow', ordinal: 0 }
        : { kind: layer.effects[first]!.kind, ordinal: ordinalOf(layer.effects, first) },
    };
    session.beginEdit('Layer Style');
    edits.set(session, edit);
  }
  const effects = session.layer(layerId)!.effects;
  if (target === 'blendingOptions') edit.selected = { kind: target, ordinal: 0 };
  else if (typeof target === 'number') {
    if (effects[target]) edit.selected = { kind: effects[target].kind, ordinal: ordinalOf(effects, target) };
  } else if (target) {
    // Choosing an effect from a menu turns it on, as in Photoshop.
    const index = indexOf(effects, target, 0);
    if (index < 0) addEffect(session, edit, target);
    else {
      edit.selected = { kind: target, ordinal: 0 };
      if (!effects[index]!.enabled) own(() => session.setLayerEffectEnabled(layerId, index, true));
    }
  }
  session.notify('ui');
}

/** OK keeps everything as one undo step; Cancel restores the effects and the global light from before. */
function finishStyle(controller: EditorController, commit: boolean): void {
  const session = controller.session;
  const edit = edits.get(session);
  if (!edit) return;
  controller.closeColorPicker?.();
  own(() => {
    const layer = session.layer(edit.layerId);
    if (commit && layer) {
      // Effects looked at in the dialog but left switched off are not kept.
      const seen: Partial<Record<EffectKind, number>> = {};
      const drop = layer.effects.map((effect, index) => {
        const ordinal = seen[effect.kind] = (seen[effect.kind] ?? -1) + 1;
        return ordinal >= edit.beforeCounts[effect.kind] && !effect.enabled ? index : -1;
      }).filter((index) => index >= 0).reverse();
      for (const index of drop) session.removeLayerEffect(edit.layerId, index);
      const document = session.document;
      if (document?.resources) {
        const used = new Set<string>();
        for (const candidate of document.layers) {
          for (const effect of candidate.effects) if (effect.kind === 'patternOverlay') used.add(effect.resourceId);
          if (candidate.kind === 'fill' && candidate.fill.kind === 'pattern') used.add(candidate.fill.assetId);
          if (candidate.kind === 'vector') {
            if (candidate.style.fill?.kind === 'pattern') used.add(candidate.style.fill.assetId);
            if (candidate.style.stroke?.paint?.kind === 'pattern') used.add(candidate.style.stroke.paint.assetId);
          }
        }
        const prior = new Set(edit.beforeResources?.map((resource) => resource.id) ?? []);
        const resources = document.resources.filter((resource) => resource.role !== 'pattern' || prior.has(resource.id) || used.has(resource.id));
        if (resources.length !== document.resources.length) session.replaceDocument({ ...document, resources });
      }
    } else if (layer) {
      if (edit.before.length) session.pasteLayerStyle(edit.layerId, edit.before);
      else session.clearLayerStyle(edit.layerId);
      session.setGlobalLightAngle(edit.beforeAngle);
      if (session.document) session.replaceDocument({ ...session.document, resources: edit.beforeResources,
        layers: session.document.layers.map((candidate) => candidate.id === edit.layerId
          ? { ...candidate, blendIf: edit.beforeBlendIf } : candidate) });
    }
  });
  edits.delete(session);
  session.endEdit();
  session.notify('ui');
}

// MARK: Controls

const hex = (c: RGB) => `#${[c.red, c.green, c.blue].map((v) => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, '0')).join('')}`;
const parseHex = (value: string): RGB => ({
  red: parseInt(value.slice(1, 3), 16) / 255, green: parseInt(value.slice(3, 5), 16) / 255, blue: parseInt(value.slice(5, 7), 16) / 255,
});
const shown = (value: number) => (Math.abs(value - Math.round(value)) < 0.005 ? String(Math.round(value)) : value.toFixed(1));

/** A numeric field that applies while typing and steps with ↑/↓ (Shift ×10); Enter and Escape reach the dialog. */
function UnitField({ label, value, suffix, onChange, testId, width = 48 }: {
  label: string; value: number; suffix: string; onChange: (value: number) => void; testId?: string; width?: number;
}) {
  const [text, setText] = useState(shown(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setText(shown(value)); }, [value, focused]);
  return (
    <label className={styles.field}>
      <input inputMode="decimal" value={text} style={{ width }} aria-label={`${label} (${suffix})`} data-testid={testId}
        onFocus={(event) => { setFocused(true); event.currentTarget.select(); }}
        onBlur={() => { setFocused(false); setText(shown(value)); }}
        onChange={(event) => {
          setText(event.target.value);
          const number = Number(event.target.value.replace(',', '.'));
          if (event.target.value.trim() !== '' && Number.isFinite(number)) onChange(number);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            const next = value + (event.shiftKey ? 10 : 1) * (event.key === 'ArrowUp' ? 1 : -1);
            onChange(next);
            setText(shown(next));
            event.preventDefault();
          }
        }} />
      <span className={styles.styleUnit}>{suffix}</span>
    </label>
  );
}

/** Label, slider and exact field (FilterSheet.control); typing may go beyond the slider's range up to `max`. */
function RangeRow({ label, value, min, max, sliderMax = max, suffix, onChange, testId }: {
  label: string; value: number; min: number; max: number; sliderMax?: number; suffix: string; onChange: (value: number) => void; testId: string;
}) {
  return (
    <div className={styles.panelRow}>
      <span className={styles.panelLabel}>{label}</span>
      <input type="range" className={styles.slider} aria-label={label} data-testid={`${testId}-slider`} min={min} max={sliderMax} step={1}
        value={clamp(Math.round(value), min, sliderMax)} onChange={(event) => onChange(Number(event.target.value))} />
      <UnitField label={label} value={value} suffix={suffix} testId={testId} onChange={(v) => onChange(clamp(Math.round(v), min, max))} />
    </div>
  );
}

/** Colour swatch that opens the app's color picker (with its canvas eyedropper), previewing live. */
function ColorWell({ controller, title, color, onChange, testId }: {
  controller: EditorController; title: string; color: RGB; onChange: (color: RGB) => void; testId: string;
}) {
  const t = controller.t;
  if (!controller.pickColor) {
    return <input type="color" className={styles.colorWell} value={hex(color)} aria-label={`${title} · ${t('Color')}`} data-testid={testId}
      onChange={(event) => onChange(parseHex(event.target.value))} />;
  }
  return (
    <button type="button" className={styles.colorWell} style={{ background: hex(color) }} aria-label={`${title} · ${t('Color')}`} title={t('Set color')}
      data-testid={testId} onClick={() => {
        const before = color;
        controller.pickColor?.({ title: `${title} · ${t('Color')}`, initial: color, preview: onChange, commit: onChange, cancel: () => onChange(before) });
      }} />
  );
}

function BlendRow({ controller, mode, onChange, children }: {
  controller: EditorController; mode: BlendMode; onChange: (mode: BlendMode) => void; children?: ReactNode;
}) {
  const t = controller.t;
  return (
    <div className={styles.panelRow}>
      <span className={styles.panelLabel}>{t('Blend Mode')}</span>
      <select className={`${styles.select} ${styles.styleSelect}`} value={mode} aria-label={t('Blend Mode')} data-testid="style-blend"
        onChange={(event) => onChange(event.target.value as BlendMode)}>
        {BLEND_MODES.map((b) => <option key={b.mode} value={b.mode}>{t(b.label)}</option>)}
      </select>
      {children}
    </div>
  );
}

const normalizedAngle = (angle: number) => { const a = ((Math.round(angle) % 360) + 360) % 360; return a > 180 ? a - 360 : a; };

/** A small dial like Photoshop's: drag to point the light; Shift snaps to 15°. */
function AngleDial({ label, value, onChange }: { label: string; value: number; onChange: (angle: number) => void }) {
  const radians = value * Math.PI / 180;
  const drag = (event: ReactPointerEvent<SVGSVGElement>) => {
    const element = event.currentTarget;
    const rect = element.getBoundingClientRect();
    const report = (e: { clientX: number; clientY: number; shiftKey: boolean }) => {
      const angle = Math.atan2(-(e.clientY - (rect.top + rect.height / 2)), e.clientX - (rect.left + rect.width / 2)) * 180 / Math.PI;
      onChange(normalizedAngle(e.shiftKey ? Math.round(angle / 15) * 15 : angle));
    };
    element.setPointerCapture?.(event.pointerId);
    report(event);
    const move = (e: PointerEvent) => report(e);
    const up = () => { element.removeEventListener('pointermove', move); element.removeEventListener('pointerup', up); element.removeEventListener('pointercancel', up); };
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', up);
    element.addEventListener('pointercancel', up);
    event.preventDefault();
  };
  return (
    <svg className={styles.angleDial} viewBox="0 0 28 28" role="slider" aria-label={label} aria-valuenow={normalizedAngle(value)}
      aria-valuemin={-180} aria-valuemax={180} tabIndex={0} data-testid="style-angle-dial" onPointerDown={drag}
      onKeyDown={(event) => {
        const step = event.key === 'ArrowUp' || event.key === 'ArrowRight' ? 1 : event.key === 'ArrowDown' || event.key === 'ArrowLeft' ? -1 : 0;
        if (step) { onChange(normalizedAngle(value + step * (event.shiftKey ? 15 : 1))); event.preventDefault(); }
      }}>
      <circle cx="14" cy="14" r="12.5" />
      <line x1="14" y1="14" x2={14 + Math.cos(radians) * 11} y2={14 - Math.sin(radians) * 11} />
      <circle cx="14" cy="14" r="1.6" className={styles.angleDialHub} />
    </svg>
  );
}

function AngleRow({ controller, value, onChange, children }: {
  controller: EditorController; value: number; onChange: (angle: number) => void; children?: ReactNode;
}) {
  const t = controller.t;
  return (
    <div className={styles.panelRow}>
      <span className={styles.panelLabel}>{t('Angle')}</span>
      <AngleDial label={t('Angle')} value={value} onChange={onChange} />
      <UnitField label={t('Angle')} value={normalizedAngle(value)} suffix="°" testId="style-angle" onChange={(v) => onChange(normalizedAngle(v))} />
      {children}
    </div>
  );
}

/** Minimal gradient editor: a ramp, the colour stops with their locations, Reverse. */
function GradientEditor({ controller, title, gradient, onChange }: {
  controller: EditorController; title: string; gradient: EffectGradient; onChange: (change: (gradient: EffectGradient) => EffectGradient) => void;
}) {
  const t = controller.t;
  const sorted = [...gradient.stops].sort((a, b) => a.offset - b.offset);
  const css = (s: GradientStop) => `rgba(${Math.round(s.color.red * 255)}, ${Math.round(s.color.green * 255)}, ${Math.round(s.color.blue * 255)}, ${s.opacity}) ${Math.round(s.offset * 1000) / 10}%`;
  const ramp = `linear-gradient(to ${gradient.reverse ? 'left' : 'right'}, ${sorted.map(css).join(', ')})`;
  const setStop = (index: number, patch: Partial<GradientStop>) => onChange((g) => ({ ...g, stops: g.stops.map((s, i) => (i === index ? { ...s, ...patch } : s)) }));
  return (
    <>
      <div className={styles.panelRow}>
        <span className={styles.panelLabel}>{t('Gradient')}</span>
        <div className={`${styles.gradientRamp} ${styles.styleRamp}`} style={{ background: `${ramp}, repeating-conic-gradient(#8a8a8a 0 25%, #c4c4c4 0 50%) 0 0 / 10px 10px` }} data-testid="style-gradient-ramp" />
      </div>
      <div className={styles.panelRow}>
        <span className={styles.panelLabel} />
        <div className={styles.gradientStops}>
          {gradient.stops.map((stop, index) => (
            <span key={index} className={styles.gradientStop} data-testid="style-gradient-stop">
              <ColorWell controller={controller} title={`${title} · ${t('Color Stop')} ${index + 1}`} color={stop.color} testId={`style-stop-color-${index}`}
                onChange={(color) => setStop(index, { color })} />
              <UnitField label={`${t('Location')} ${index + 1}`} value={stop.offset * 100} suffix="%" width={40} testId={`style-stop-location-${index}`}
                onChange={(v) => setStop(index, { offset: clamp(v, 0, 100) / 100 })} />
              {gradient.stops.length > 2 ? (
                <button type="button" className={styles.styleStopRemove} aria-label={`${t('Delete Color Stop')} ${index + 1}`} title={t('Delete Color Stop')}
                  onClick={() => onChange((g) => ({ ...g, stops: g.stops.filter((_s, i) => i !== index) }))}><Icon name="close" size={10} /></button>
              ) : null}
            </span>
          ))}
          <button type="button" className={styles.styleStopAdd} aria-label={t('Add Color Stop')} title={t('Add Color Stop')} data-testid="style-stop-add"
            onClick={() => onChange((g) => {
              // Between the two stops furthest apart, in their mixed colour.
              const s = [...g.stops].sort((a, b) => a.offset - b.offset);
              let at = 0;
              for (let i = 1; i < s.length - 1; i++) if (s[i + 1]!.offset - s[i]!.offset > s[at + 1]!.offset - s[at]!.offset) at = i;
              const a = s[at]!, b = s[at + 1]!;
              const mix = (x: number, y: number) => (x + y) / 2;
              return { ...g, stops: [...g.stops, { offset: mix(a.offset, b.offset), opacity: mix(a.opacity, b.opacity),
                color: { red: mix(a.color.red, b.color.red), green: mix(a.color.green, b.color.green), blue: mix(a.color.blue, b.color.blue) } }] };
            })}><Icon name="plus" size={12} /></button>
        </div>
      </div>
      <div className={styles.panelRow}>
        <span className={styles.panelLabel} />
        <Check label={t('Reverse')} checked={!!gradient.reverse} testId="style-reverse" onChange={(reverse) => onChange((g) => ({ ...g, reverse }))} />
      </div>
    </>
  );
}

// MARK: Effect parameters

function EffectControls({ controller, session, effect, change }: {
  controller: EditorController; session: EditorSession; effect: LayerEffect;
  change: (patch: (effect: LayerEffect) => Partial<LayerEffect>) => void;
}) {
  const t = controller.t;
  const title = t(LABELS[effect.kind]);
  const opacity = (value: number) => (
    <RangeRow label={t('Opacity')} value={Math.round(value * 100)} min={0} max={100} suffix="%" testId="style-opacity"
      onChange={(v) => change(() => ({ opacity: v / 100 }))} />
  );
  const colorWell = (color: RGB) => (
    <ColorWell controller={controller} title={title} color={color} testId="style-color" onChange={(c) => change(() => ({ color: c }))} />
  );
  switch (effect.kind) {
    case 'dropShadow': {
      const global = !!effect.useGlobalLight;
      const angle = global ? session.document?.globalLightAngle ?? DEFAULT_GLOBAL_LIGHT_ANGLE : effect.angle;
      const size = effect.size ?? effect.blur;
      return (
        <>
          <BlendRow controller={controller} mode={effect.blendMode ?? 'multiply'} onChange={(blendMode) => change(() => ({ blendMode }))}>{colorWell(effect.color)}</BlendRow>
          {opacity(effect.opacity)}
          <AngleRow controller={controller} value={angle} onChange={(value) => {
            // With Global Light the angle is the document's, shared by every layer that uses it (Photoshop).
            if (global) own(() => session.setGlobalLightAngle(value)); else change(() => ({ angle: value }));
          }}>
            <Check label={t('Use Global Light')} checked={global} testId="style-global-light"
              onChange={(useGlobalLight) => change((e) => ({ useGlobalLight, ...(useGlobalLight ? {} : { angle: session.document?.globalLightAngle ?? (e as EffectOf<'dropShadow'>).angle }) }))} />
          </AngleRow>
          <RangeRow label={t('Distance')} value={effect.distance} min={0} max={10_000} sliderMax={250} suffix="px" testId="style-distance"
            onChange={(distance) => change(() => ({ distance }))} />
          <RangeRow label={t('Spread')} value={effect.spread ?? 0} min={0} max={100} suffix="%" testId="style-spread" onChange={(spread) => change(() => ({ spread }))} />
          <RangeRow label={t('Size')} value={size} min={0} max={250} suffix="px" testId="style-size" onChange={(v) => change(() => ({ size: v, blur: v }))} />
          <div className={styles.panelRow}>
            <span className={styles.panelLabel} />
            <Check label={t('Layer Knocks Out Drop Shadow')} checked={effect.knockout ?? true} testId="style-knockout" onChange={(knockout) => change(() => ({ knockout }))} />
          </div>
        </>
      );
    }
    case 'stroke': {
      const fill: EffectFill = effect.fill ?? { kind: 'color', color: effect.color ?? BLACK };
      const strokeColor = fill.kind === 'color' ? fill.color : effect.color ?? BLACK;
      return (
        <>
          <RangeRow label={t('Size')} value={effect.width} min={1} max={250} suffix="px" testId="style-width" onChange={(width) => change(() => ({ width }))} />
          <div className={styles.panelRow}>
            <span className={styles.panelLabel}>{t('Position')}</span>
            <Segmented label={t('Position')} options={['outside', 'inside', 'center'] as const} value={effect.position}
              labelOf={(p) => t(p === 'outside' ? 'Outside' : p === 'inside' ? 'Inside' : 'Center')} onChange={(position) => change(() => ({ position }))} />
          </div>
          <BlendRow controller={controller} mode={effect.blendMode ?? 'normal'} onChange={(blendMode) => change(() => ({ blendMode }))} />
          {opacity(effect.opacity ?? 1)}
          <div className={styles.panelRow}>
            <span className={styles.panelLabel}>{t('Fill Type')}</span>
            <Segmented label={t('Fill Type')} options={['color', 'gradient'] as const} value={fill.kind}
              labelOf={(k) => t(k === 'color' ? 'Color' : 'Gradient')}
              onChange={(kind) => change((e) => {
                const stroke = e as EffectOf<'stroke'>;
                const current = stroke.fill ?? { kind: 'color' as const, color: stroke.color ?? BLACK };
                if (current.kind === kind) return {};
                return kind === 'color' ? { fill: { kind: 'color', color: stroke.color ?? BLACK } }
                  : { fill: { kind: 'gradient', gradient: paletteGradient(session), angle: 90, scale: 100 } };
              })} />
            {fill.kind === 'color' ? (
              <ColorWell controller={controller} title={title} color={strokeColor} testId="style-color"
                onChange={(color) => change((e) => ((e as EffectOf<'stroke'>).fill ? { color, fill: { kind: 'color', color } } : { color }))} />
            ) : null}
          </div>
          {fill.kind === 'gradient' ? (
            <>
              <GradientEditor controller={controller} title={title} gradient={fill.gradient} onChange={(update) => change((e) => {
                const f = (e as EffectOf<'stroke'>).fill;
                return f?.kind === 'gradient' ? { fill: { ...f, gradient: update(f.gradient) } } : {};
              })} />
              <AngleRow controller={controller} value={fill.angle} onChange={(angle) => change((e) => {
                const f = (e as EffectOf<'stroke'>).fill;
                return f?.kind === 'gradient' ? { fill: { ...f, angle } } : {};
              })} />
              <RangeRow label={t('Scale')} value={fill.scale} min={10} max={1000} sliderMax={150} suffix="%" testId="style-scale" onChange={(scale) => change((e) => {
                const f = (e as EffectOf<'stroke'>).fill;
                return f?.kind === 'gradient' ? { fill: { ...f, scale } } : {};
              })} />
            </>
          ) : null}
        </>
      );
    }
    case 'innerShadow': {
      const global = effect.useGlobalLight;
      const angle = global ? session.document?.globalLightAngle ?? DEFAULT_GLOBAL_LIGHT_ANGLE : effect.angle;
      return (
        <>
          <BlendRow controller={controller} mode={effect.blendMode} onChange={(blendMode) => change(() => ({ blendMode }))}>{colorWell(effect.color)}</BlendRow>
          {opacity(effect.opacity)}
          <AngleRow controller={controller} value={angle} onChange={(value) => {
            if (global) own(() => session.setGlobalLightAngle(value)); else change(() => ({ angle: value }));
          }}>
            <Check label={t('Use Global Light')} checked={global} testId="style-global-light"
              onChange={(useGlobalLight) => change((e) => ({ useGlobalLight, ...(useGlobalLight ? {}
                : { angle: session.document?.globalLightAngle ?? (e as EffectOf<'innerShadow'>).angle }) }))} />
          </AngleRow>
          <RangeRow label={t('Distance')} value={effect.distance} min={0} max={10_000} sliderMax={250} suffix="px" testId="style-distance"
            onChange={(distance) => change(() => ({ distance }))} />
          <RangeRow label={t('Choke')} value={effect.choke} min={0} max={100} suffix="%" testId="style-choke"
            onChange={(choke) => change(() => ({ choke }))} />
          <RangeRow label={t('Size')} value={effect.size} min={0} max={250} suffix="px" testId="style-size"
            onChange={(size) => change(() => ({ size }))} />
        </>
      );
    }
    case 'innerGlow':
      return (
        <>
          <BlendRow controller={controller} mode={effect.blendMode} onChange={(blendMode) => change(() => ({ blendMode }))}>{colorWell(effect.color)}</BlendRow>
          {opacity(effect.opacity)}
          <div className={styles.panelRow}>
            <span className={styles.panelLabel}>{t('Source')}</span>
            <Segmented label={t('Source')} options={['center', 'edge'] as const} value={effect.source}
              labelOf={(source) => t(source === 'center' ? 'Center' : 'Edge')} onChange={(source) => change(() => ({ source }))} />
          </div>
          <RangeRow label={t('Choke')} value={effect.choke} min={0} max={100} suffix="%" testId="style-choke"
            onChange={(choke) => change(() => ({ choke }))} />
          <RangeRow label={t('Size')} value={effect.size} min={0} max={250} suffix="px" testId="style-size"
            onChange={(size) => change(() => ({ size }))} />
        </>
      );
    case 'bevelEmboss': {
      const global = effect.useGlobalLight;
      const angle = global ? session.document?.globalLightAngle ?? DEFAULT_GLOBAL_LIGHT_ANGLE : effect.angle;
      return (
        <>
          <div className={styles.panelRow}><span className={styles.panelLabel}>{t('Style')}</span>
            <select className={`${styles.select} ${styles.styleSelect}`} value={effect.style} data-testid="style-bevel-style"
              onChange={(event) => change(() => ({ style: event.target.value as EffectOf<'bevelEmboss'>['style'] }))}>
              <option value="innerBevel">{t('Inner Bevel')}</option><option value="outerBevel">{t('Outer Bevel')}</option>
              <option value="emboss">{t('Emboss')}</option><option value="pillowEmboss">{t('Pillow Emboss')}</option>
            </select>
          </div>
          <div className={styles.panelRow}><span className={styles.panelLabel}>{t('Technique')}</span>
            <select className={`${styles.select} ${styles.styleSelect}`} value={effect.technique} data-testid="style-bevel-technique"
              onChange={(event) => change(() => ({ technique: event.target.value as EffectOf<'bevelEmboss'>['technique'] }))}>
              <option value="smooth">{t('Smooth Technique')}</option><option value="chiselHard">{t('Chisel Hard')}</option>
              <option value="chiselSoft">{t('Chisel Soft')}</option>
            </select>
          </div>
          <RangeRow label={t('Depth')} value={effect.depth} min={1} max={1000} sliderMax={250} suffix="%" testId="style-depth"
            onChange={(depth) => change(() => ({ depth }))} />
          <div className={styles.panelRow}><span className={styles.panelLabel}>{t('Bevel Direction')}</span>
            <Segmented label={t('Bevel Direction')} options={['up', 'down'] as const} value={effect.direction}
              labelOf={(direction) => t(direction === 'up' ? 'Up' : 'Down')} onChange={(direction) => change(() => ({ direction }))} />
          </div>
          <RangeRow label={t('Size')} value={effect.size} min={0} max={250} suffix="px" testId="style-size"
            onChange={(size) => change(() => ({ size }))} />
          <RangeRow label={t('Soften')} value={effect.soften} min={0} max={16} suffix="px" testId="style-soften"
            onChange={(soften) => change(() => ({ soften }))} />
          <AngleRow controller={controller} value={angle} onChange={(value) => {
            if (global) own(() => session.setGlobalLightAngle(value)); else change(() => ({ angle: value }));
          }}>
            <Check label={t('Use Global Light')} checked={global} testId="style-global-light"
              onChange={(useGlobalLight) => change((e) => ({ useGlobalLight, ...(useGlobalLight ? {}
                : { angle: session.document?.globalLightAngle ?? (e as EffectOf<'bevelEmboss'>).angle }) }))} />
          </AngleRow>
          <RangeRow label={t('Altitude')} value={effect.altitude} min={0} max={90} suffix="°" testId="style-altitude"
            onChange={(altitude) => change(() => ({ altitude }))} />
          <div className={styles.panelRow}><span className={styles.panelLabel}>{t('Highlight Mode')}</span>
            <select className={`${styles.select} ${styles.styleSelect}`} value={effect.highlightMode} data-testid="style-highlight-mode"
              onChange={(event) => change(() => ({ highlightMode: event.target.value as BlendMode }))}>
              {BLEND_MODES.map((mode) => <option key={mode.mode} value={mode.mode}>{t(mode.label)}</option>)}
            </select><ColorWell controller={controller} title={t('Highlight Mode')} color={effect.highlightColor} testId="style-highlight-color"
              onChange={(highlightColor) => change(() => ({ highlightColor }))} />
          </div>
          <RangeRow label={t('Highlight Opacity')} value={effect.highlightOpacity * 100} min={0} max={100} suffix="%" testId="style-highlight-opacity"
            onChange={(value) => change(() => ({ highlightOpacity: value / 100 }))} />
          <div className={styles.panelRow}><span className={styles.panelLabel}>{t('Shadow Mode')}</span>
            <select className={`${styles.select} ${styles.styleSelect}`} value={effect.shadowMode} data-testid="style-shadow-mode"
              onChange={(event) => change(() => ({ shadowMode: event.target.value as BlendMode }))}>
              {BLEND_MODES.map((mode) => <option key={mode.mode} value={mode.mode}>{t(mode.label)}</option>)}
            </select><ColorWell controller={controller} title={t('Shadow Mode')} color={effect.shadowColor} testId="style-shadow-color"
              onChange={(shadowColor) => change(() => ({ shadowColor }))} />
          </div>
          <RangeRow label={t('Shadow Opacity')} value={effect.shadowOpacity * 100} min={0} max={100} suffix="%" testId="style-shadow-opacity"
            onChange={(value) => change(() => ({ shadowOpacity: value / 100 }))} />
        </>
      );
    }
    case 'satin':
      return (
        <>
          <BlendRow controller={controller} mode={effect.blendMode} onChange={(blendMode) => change(() => ({ blendMode }))}>{colorWell(effect.color)}</BlendRow>
          {opacity(effect.opacity)}
          <AngleRow controller={controller} value={effect.angle} onChange={(angle) => change(() => ({ angle }))} />
          <RangeRow label={t('Distance')} value={effect.distance} min={0} max={250} suffix="px" testId="style-distance"
            onChange={(distance) => change(() => ({ distance }))} />
          <RangeRow label={t('Size')} value={effect.size} min={0} max={250} suffix="px" testId="style-size"
            onChange={(size) => change(() => ({ size }))} />
          <div className={styles.panelRow}><span className={styles.panelLabel} />
            <Check label={t('Invert')} checked={effect.invert} testId="style-invert" onChange={(invert) => change(() => ({ invert }))} />
          </div>
        </>
      );
    case 'patternOverlay': {
      const selectPreset = (preset: PatternPreset) => change(() => ({ ...ensureProceduralPattern(session, preset) }));
      const importPattern = async (file: File) => {
        try {
          const raster = await decodeImageFile(new Uint8Array(await file.arrayBuffer()), 16_777_216);
          const source = raster.toPixels(), bytes = new Uint8Array(raster.width * raster.height * 4);
          for (let i = 0; i < bytes.length; i++) bytes[i] = Math.round(source[i]! * 255 / raster.maximum);
          const resourceId = `pattern-${globalThis.crypto.randomUUID()}`, document = session.document;
          if (!document || !edits.has(session)) return;
          own(() => {
            session.replaceDocument({ ...document, resources: [...(document.resources ?? []),
              { id: resourceId, role: 'pattern', mime: 'application/x-fernwork-rgba8', bytes }] });
            change(() => ({ resourceId, patternWidth: raster.width, patternHeight: raster.height }));
          });
        } catch (error) { controller.reportError('pattern-import-failed', error, t('Import couldn’t finish')); }
      };
      const preset = (Object.keys(PATTERNS) as PatternPreset[]).find((key) => PATTERNS[key].id === effect.resourceId) ?? '';
      return (
        <>
          <BlendRow controller={controller} mode={effect.blendMode} onChange={(blendMode) => change(() => ({ blendMode }))} />
          {opacity(effect.opacity)}
          <div className={styles.panelRow}><span className={styles.panelLabel}>{t('Pattern')}</span>
            <select className={`${styles.select} ${styles.styleSelect}`} value={preset} data-testid="style-pattern-preset"
              onChange={(event) => selectPreset(event.target.value as PatternPreset)}>
              {!preset ? <option value="">{t('Imported')}</option> : null}
              <option value="checker">{t('Checker')}</option><option value="dots">{t('Dots')}</option>
              <option value="diagonal">{t('Diagonal')}</option>
            </select>
            <label className={styles.pill}>{t('From Image…')}<input type="file" accept="image/*" hidden data-testid="style-pattern-file"
              onChange={(event) => { const file = event.target.files?.[0]; if (file) void importPattern(file); }} /></label>
          </div>
          <RangeRow label={t('Scale')} value={effect.scale} min={1} max={1000} sliderMax={250} suffix="%" testId="style-scale"
            onChange={(scale) => change(() => ({ scale }))} />
          <AngleRow controller={controller} value={effect.angle} onChange={(angle) => change(() => ({ angle }))} />
          <div className={styles.panelRow}><span className={styles.panelLabel} />
            <Check label={t('Link with Layer')} checked={effect.linkWithLayer} testId="style-pattern-link"
              onChange={(linkWithLayer) => change(() => ({ linkWithLayer }))} />
          </div>
        </>
      );
    }
    case 'outerGlow':
      return (
        <>
          <BlendRow controller={controller} mode={effect.blendMode} onChange={(blendMode) => change(() => ({ blendMode }))}>{colorWell(effect.color)}</BlendRow>
          {opacity(effect.opacity)}
          <RangeRow label={t('Spread')} value={effect.spread} min={0} max={100} suffix="%" testId="style-spread" onChange={(spread) => change(() => ({ spread }))} />
          <RangeRow label={t('Size')} value={effect.size} min={0} max={250} suffix="px" testId="style-size" onChange={(size) => change(() => ({ size }))} />
        </>
      );
    case 'colorOverlay':
      return (
        <>
          <BlendRow controller={controller} mode={effect.blendMode ?? 'normal'} onChange={(blendMode) => change(() => ({ blendMode }))}>{colorWell(effect.color)}</BlendRow>
          {opacity(effect.opacity)}
        </>
      );
    case 'gradientOverlay':
      return (
        <>
          <BlendRow controller={controller} mode={effect.blendMode} onChange={(blendMode) => change(() => ({ blendMode }))} />
          {opacity(effect.opacity)}
          <GradientEditor controller={controller} title={title} gradient={effect.gradient}
            onChange={(update) => change((e) => ({ gradient: update((e as EffectOf<'gradientOverlay'>).gradient) }))} />
          <AngleRow controller={controller} value={effect.angle} onChange={(angle) => change(() => ({ angle }))} />
          <RangeRow label={t('Scale')} value={effect.scale} min={10} max={1000} sliderMax={150} suffix="%" testId="style-scale" onChange={(scale) => change(() => ({ scale }))} />
        </>
      );
  }
}

const blendIfRange = () => ({ black0: 0, black1: 0, white0: 255, white1: 255 });
function defaultBlendIf(): BlendIfSettings {
  const side = () => ({ gray: blendIfRange(), red: blendIfRange(), green: blendIfRange(), blue: blendIfRange() });
  return { source: side(), destination: side() };
}

function BlendIfControls({ controller, session, layer }: {
  controller: EditorController; session: EditorSession; layer: Layer;
}) {
  const t = controller.t;
  const [channel, setChannel] = useState<BlendIfChannel>('gray');
  const value = layer.blendIf ?? defaultBlendIf();
  const update = (side: 'source' | 'destination', key: keyof ReturnType<typeof blendIfRange>, sample: number) => own(() => {
    const document = session.document;
    if (!document) return;
    const current = session.layer(layer.id)?.blendIf ?? defaultBlendIf(), range = current[side][channel];
    const next = { ...range, [key]: sample };
    // Split handles may meet but never cross; moving one carries only the directly adjacent half.
    if (key === 'black0') next.black1 = Math.max(next.black0, next.black1);
    else if (key === 'black1') { next.black0 = Math.min(next.black0, next.black1); next.white0 = Math.max(next.black1, next.white0); }
    else if (key === 'white0') { next.black1 = Math.min(next.black1, next.white0); next.white1 = Math.max(next.white0, next.white1); }
    else next.white0 = Math.min(next.white0, next.white1);
    const blendIf = { ...current, [side]: { ...current[side], [channel]: next } };
    session.replaceDocument({ ...document, layers: document.layers.map((candidate) =>
      candidate.id === layer.id ? { ...candidate, blendIf } : candidate) });
  });
  const rows = (side: 'source' | 'destination', label: string) => {
    const range = value[side][channel];
    return <div className={styles.blendIfGroup}>
      <strong>{label}</strong>
      <RangeRow label={`${t('Black')} 1`} value={range.black0} min={0} max={255} suffix="" testId={`blend-if-${side}-black0`} onChange={(v) => update(side, 'black0', v)} />
      <RangeRow label={`${t('Black')} 2`} value={range.black1} min={0} max={255} suffix="" testId={`blend-if-${side}-black1`} onChange={(v) => update(side, 'black1', v)} />
      <RangeRow label={`${t('White')} 1`} value={range.white0} min={0} max={255} suffix="" testId={`blend-if-${side}-white0`} onChange={(v) => update(side, 'white0', v)} />
      <RangeRow label={`${t('White')} 2`} value={range.white1} min={0} max={255} suffix="" testId={`blend-if-${side}-white1`} onChange={(v) => update(side, 'white1', v)} />
    </div>;
  };
  return <>
    <div className={styles.panelRow}>
      <span className={styles.panelLabel}>{t('Blend If')}</span>
      <select className={`${styles.select} ${styles.styleSelect}`} value={channel} aria-label={t('Blend If')}
        data-testid="blend-if-channel" onChange={(event) => setChannel(event.target.value as BlendIfChannel)}>
        {(['gray', 'red', 'green', 'blue'] as const).map((item) => <option key={item} value={item}>{t(item === 'gray' ? 'Gray' : item[0]!.toUpperCase() + item.slice(1))}</option>)}
      </select>
    </div>
    {rows('source', t('This Layer'))}
    {rows('destination', t('Underlying Layer'))}
  </>;
}

// MARK: The dialog

function LayerStylePanel({ controller }: { controller: EditorController }) {
  const session = useSession(controller.session);
  const t = controller.t;
  const edit = edits.get(session);
  const layer = edit ? session.layer(edit.layerId) : null;
  // The layer vanished under the dialog (a restored project): nothing is left to edit.
  useEffect(() => { if (edit && !layer) finishStyle(controller, false); }, [controller, edit, layer]);
  if (!edit || !layer) return null;
  const effects = layer.effects;
  const current = currentEffect(session, edit);
  const change = (patch: (effect: LayerEffect) => Partial<LayerEffect>) => {
    const live = edits.get(session);
    if (!live) return;
    const found = currentEffect(session, live);
    if (found) own(() => session.setLayerEffectParameters(live.layerId, found.index, patch(found.effect)));
  };
  // One row per effect, Photoshop's order; a kind the layer lacks shows once, unchecked.
  const rows = KINDS.flatMap((kind) => {
    const count = effects.filter((e) => e.kind === kind).length;
    return count ? Array.from({ length: count }, (_v, ordinal) => ({ kind, ordinal, count })) : [{ kind, ordinal: 0, count: 0 }];
  });
  const select = (kind: EffectKind, ordinal: number, present: boolean) => {
    if (!present) addEffect(session, edit, kind);
    else edit.selected = { kind, ordinal };
    session.notify('ui');
  };
  return (
    <FloatingPanel name="layerStyle" title={`${t('Layer Style')} · ${layer.name}`} onClose={() => finishStyle(controller, false)} closeLabel={t('Cancel')}
      testId="layer-style-dialog" className={styles.stylePanel}>
      <div className={styles.styleLayout}
        onKeyDownCapture={(event) => {
          // Return is OK and Escape is Cancel from anywhere in the dialog, fields included (Photoshop).
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finishStyle(controller, false); }
          else if (event.key === 'Enter' && !(event.target as Element).closest('button, select, textarea')) {
            event.preventDefault(); event.stopPropagation(); finishStyle(controller, true);
          }
        }}>
        <div className={styles.styleList} role="listbox" aria-label={t('Effects')}>
          <span className={styles.styleListTitle}>{t('Effects')}</span>
          <div className={`${styles.styleItem} ${edit.selected.kind === 'blendingOptions' ? styles.styleItemOn : ''}`}
            role="option" aria-selected={edit.selected.kind === 'blendingOptions'}>
            <button type="button" className={styles.styleItemName} data-testid="style-blending-options"
              onClick={() => { edit.selected = { kind: 'blendingOptions', ordinal: 0 }; session.notify('ui'); }}>
              {t('Blending Options')}
            </button>
          </div>
          {rows.map(({ kind, ordinal, count }) => {
            const index = indexOf(effects, kind, ordinal);
            const effect = index >= 0 ? effects[index]! : null;
            const on = edit.selected.kind === kind && edit.selected.ordinal === ordinal;
            const name = t(LABELS[kind]) + (count > 1 ? ` ${ordinal + 1}` : '');
            const suffix = ordinal ? `-${ordinal + 1}` : '';
            return (
              <div key={`${kind}-${ordinal}`} className={`${styles.styleItem} ${on ? styles.styleItemOn : ''}`} role="option" aria-selected={on}>
                <input type="checkbox" checked={!!effect?.enabled} aria-label={name} data-testid={`style-enable-${kind}${suffix}`}
                  onChange={(event) => {
                    if (effect) own(() => session.setLayerEffectEnabled(layer.id, index, event.target.checked));
                    else select(kind, ordinal, false);
                  }} />
                <button type="button" className={styles.styleItemName} data-testid={`style-effect-${kind}${suffix}`}
                  onClick={() => select(kind, ordinal, !!effect)}>{name}</button>
              </div>
            );
          })}
          <span className={styles.spacer} />
          <button type="button" className={`${styles.pill} ${styles.styleDelete}`} disabled={!current} data-testid="style-delete"
            onClick={() => { if (current) own(() => session.removeLayerEffect(layer.id, current.index)); }}>
            <Icon name="trash" size={13} />{t('Delete Effect')}
          </button>
        </div>
        <div className={styles.styleBody} data-testid="style-body" data-kind={current?.effect.kind ?? ''}>
          <h3 className={styles.styleHeading}>{edit.selected.kind === 'blendingOptions' ? t('Blending Options') : t(LABELS[edit.selected.kind])}</h3>
          {edit.selected.kind === 'blendingOptions' ? <BlendIfControls controller={controller} session={session} layer={layer} />
            : current ? <EffectControls controller={controller} session={session} effect={current.effect} change={change} />
              : <p className={styles.panelNote}>{t('Choose an effect on the left to add it to the layer.')}</p>}
        </div>
      </div>
      <div className={styles.dialogButtons}>
        <button type="button" className={styles.pill} onClick={() => finishStyle(controller, false)} data-testid="style-cancel">{t('Cancel')}</button>
        <button type="button" className={`${styles.pill} ${styles.pillPrimary}`} onClick={() => finishStyle(controller, true)} data-testid="style-ok">{t('OK')}</button>
      </div>
    </FloatingPanel>
  );
}

// MARK: Commands and installation

/** Copy, Paste and Clear act on every selected layer when the target is one of them (Photoshop), as one undo step. */
function targets(session: EditorSession, layerId: string): string[] {
  const ids = session.selectedLayerIds.has(layerId) ? [...session.selectedLayerIds] : [layerId];
  return ids.filter((id) => styleable(session.layer(id)));
}

export function installLayerStyles(controller: EditorController): void {
  const t = controller.t;
  if (!editBlockers.includes(blocksEditing)) editBlockers.push(blocksEditing);
  const commands: LayerStyleCommands = {
    kinds: KINDS,
    label: (kind) => t(LABELS[kind]),
    styleable: (layerId) => styleable(controller.session.layer(layerId)),
    open: (layerId, target) => openStyle(controller, layerId, target),
    menu: (layerId) => {
      const session = controller.session;
      const layer = session.layer(layerId);
      const editing = edits.get(session)?.layerId === layerId;
      const can = styleable(layer) && (session.canEditLayers || editing);
      const many = (name: string, run: (ids: string[]) => void) => () => {
        const ids = targets(session, layerId);
        if (ids.length > 1) session.edit(name, () => run(ids)); else run(ids);
      };
      const entries: MenuEntry[] = KINDS.map((kind) => ({
        label: t(`${LABELS[kind]}…`), enabled: can, checked: !!layer?.effects.some((e) => e.kind === kind && e.enabled),
        testId: `menu-style-${kind}`, run: () => openStyle(controller, layerId, kind),
      }));
      return [
        { label: t('Blending Options…'), enabled: can, testId: 'menu-style-blending-options', run: () => openStyle(controller, layerId, 'blendingOptions') },
        'separator',
        ...entries,
        'separator',
        { label: t('Copy Layer Style'), enabled: styleable(layer) && layer.effects.length > 0, testId: 'menu-copy-style',
          run: () => { session.copyLayerStyle(layerId); session.notify('ui'); } },
        { label: t('Paste Layer Style'), enabled: can && !editing && !!session.copiedLayerStyle, testId: 'menu-paste-style',
          run: many('Paste Layer Style', (ids) => { for (const id of ids) session.pasteLayerStyle(id); }) },
        { label: t('Clear Layer Style'), enabled: can && !editing && targets(session, layerId).some((id) => session.layer(id)!.effects.length > 0), testId: 'menu-clear-style',
          run: many('Clear Layer Style', (ids) => { for (const id of ids) session.clearLayerStyle(id); }) },
      ];
    },
  };
  controller.layerStyles = commands;
  controller.panels.push(() => <LayerStylePanel controller={controller} />);
  // With the focus on the canvas, Return and Escape finish the dialog (the color picker, when open, answers first).
  controller.keyHandlers.push((event) => {
    if (!edits.has(controller.session) || controller.colorPickerTarget) return false;
    if (event.key === 'Escape') { finishStyle(controller, false); return true; }
    if (event.key === 'Enter') { finishStyle(controller, true); return true; }
    return false;
  });
}
