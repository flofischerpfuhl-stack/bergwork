/**
 * Select › Color Range…: sample colours on the canvas (Shift-click adds), or pick a preset range; Fuzziness widens
 * the match and Localized Color Clusters keeps it near the last click. The preview (panel thumbnail and red canvas
 * tint) runs on a reduced copy in the worker; OK computes the full-size selection as one undo step.
 */

import { useEffect, useRef } from 'react';
import styles from '../../ui/editor.module.css';
import css from './objsel.module.css';
import type { EditorController } from '../../ui/controller';
import { useSession } from '../../ui/hooks';
import type { ToolContext, ToolHandler } from '../../ui/canvas/tools';
import type { EditorSession } from '../../core/session';
import type { Point } from '../../core/geometry';
import { Raster } from '../../core/raster';
import { applySelection } from '../../core/selectionCommands';
import type { ColourRangePreset, ColourRangeSettings, SampledColour } from '../../core/refine/colourRange';
import { refineEdgeWorker } from '../../workers/refineClient';
import { Check, FloatingPanel, SliderRow } from '../adjustmentsFeature';
import { DocumentOverlay } from './overlay';
import { panelTranslator } from './strings';

const PRESETS: readonly [ColourRangePreset, string][] = [
  ['sampled', 'Sampled Colors'], ['skinTones', 'Skin Tones'], ['midtones', 'Midtones'], ['highlights', 'Highlights'], ['shadows', 'Shadows'],
];
/** Long side of the preview copy. */
const PREVIEW_SIDE = 640;

export interface ColorRangeState {
  phase: 'preparing' | 'ready' | 'computing' | 'applying' | 'error';
  error: string | null;
  preset: ColourRangePreset;
  samples: SampledColour[];
  samplePoint: Point | null;
  fuzziness: number;
  localized: boolean;
  /** Localized range, percent of the long side. */
  range: number;
  invert: boolean;
  preview: boolean;
  width: number;
  height: number;
  rgba: Uint8Array | null;
  small: { rgba: Uint8Array; width: number; height: number; scale: number } | null;
  mask: Uint8Array | null;
  overlay: DocumentOverlay | null;
  generation: number;
  abort: AbortController | null;
  timer: ReturnType<typeof setTimeout> | null;
}

const states = new WeakMap<EditorSession, ColorRangeState>();
export function colorRangeState(session: EditorSession): ColorRangeState | null { return states.get(session) ?? null; }
export function colorRangeBlocksEditing(session: EditorSession): boolean {
  const state = states.get(session);
  return !!state && state.phase !== 'applying';
}

let remembered = { preset: 'sampled' as ColourRangePreset, fuzziness: 40, localized: false, range: 50, invert: false, preview: true };

function settingsFor(state: ColorRangeState, scale: number): ColourRangeSettings | null {
  if (state.preset === 'sampled' && !state.samples.length) return null;
  return {
    preset: state.preset, samples: state.samples, fuzziness: state.fuzziness, localized: state.localized,
    samplePoint: state.samplePoint ? { x: state.samplePoint.x * scale, y: state.samplePoint.y * scale } : null,
    range: Math.max(1, state.range / 100 * Math.max(state.width, state.height) * scale), invert: state.invert,
  };
}

function downscale(rgba: Uint8Array, width: number, height: number): ColorRangeState['small'] {
  const scale = Math.min(1, PREVIEW_SIDE / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
  if (w === width && h === height) return { rgba, width, height, scale: 1 };
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(height - 1, Math.floor((y + 0.5) / scale));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(width - 1, Math.floor((x + 0.5) / scale)), p = (sy * width + sx) * 4, o = (y * w + x) * 4;
      out[o] = rgba[p]!; out[o + 1] = rgba[p + 1]!; out[o + 2] = rgba[p + 2]!; out[o + 3] = rgba[p + 3]!;
    }
  }
  // The preview grid must match DocumentOverlay's for the same side, so the overlay reads the mask by index.
  return { rgba: out, width: w, height: h, scale: w / width };
}

export async function openColorRange(controller: EditorController): Promise<void> {
  const session = controller.session, document = session.document;
  if (!document || !session.services?.flatten || states.has(session)) return;
  const state: ColorRangeState = {
    phase: 'preparing', error: null, ...remembered, samples: [], samplePoint: null, width: document.width, height: document.height,
    rgba: null, small: null, mask: null, overlay: null, generation: 0, abort: null, timer: null,
  };
  states.set(session, state);
  session.notify('document');
  try {
    const image = await session.services.flatten({ ...document, selection: null });
    if (states.get(session) !== state) return;
    state.rgba = image.toPixels();
    state.small = downscale(state.rgba, state.width, state.height);
    state.phase = 'ready';
    void preview(controller, session, state);
  } catch (error) {
    if (states.get(session) !== state) return;
    state.phase = 'error';
    state.error = error instanceof Error ? error.message : String(error);
  }
  session.notify('ui');
}

async function preview(controller: EditorController, session: EditorSession, state: ColorRangeState): Promise<void> {
  const small = state.small;
  if (!small) return;
  const settings = settingsFor(state, small.scale);
  const generation = ++state.generation;
  state.abort?.abort();
  if (!settings) { state.mask = null; state.overlay = null; controller.canvasView?.redraw(); session.notify('ui'); return; }
  const abort = state.abort = new AbortController();
  state.phase = 'computing';
  session.notify('ui');
  try {
    const mask = await refineEdgeWorker.colourRange(small.rgba.slice(), small.width, small.height, settings, abort.signal);
    if (states.get(session) !== state || state.generation !== generation) return;
    state.mask = mask;
    const overlay = state.overlay ?? new DocumentOverlay(state.width, state.height, PREVIEW_SIDE);
    overlay.update((out, o) => { const m = mask[o / 4]!; out[o] = 255; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = Math.round((255 - m) / 2); });
    state.overlay = overlay;
    state.phase = 'ready';
    controller.canvasView?.redraw();
    session.notify('ui');
  } catch (error) {
    if (states.get(session) !== state || state.generation !== generation || abort.signal.aborted) return;
    state.phase = 'error';
    state.error = error instanceof Error ? error.message : String(error);
    session.notify('ui');
  }
}

function change(controller: EditorController, session: EditorSession, next: Partial<ColorRangeState>, delay = 80): void {
  const state = states.get(session);
  if (!state || state.phase === 'applying') return;
  Object.assign(state, next);
  remembered = { preset: state.preset, fuzziness: state.fuzziness, localized: state.localized, range: state.range, invert: state.invert, preview: state.preview };
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => { state.timer = null; void preview(controller, session, state); }, delay);
  session.notify('ui');
}

function close(session: EditorSession): void {
  const state = states.get(session);
  if (!state) return;
  state.abort?.abort();
  if (state.timer) clearTimeout(state.timer);
  states.delete(session);
  session.notify('document');
}
export function cancelColorRange(session: EditorSession): void { close(session); }

export async function commitColorRange(controller: EditorController, session: EditorSession): Promise<boolean> {
  const state = states.get(session);
  if (!state || !state.rgba || state.phase === 'applying' || state.phase === 'preparing') return false;
  const settings = settingsFor(state, 1);
  if (!settings) return false;
  state.phase = 'applying';
  state.abort?.abort();
  if (state.timer) { clearTimeout(state.timer); state.timer = null; }
  session.notify('ui');
  let applied = false;
  try {
    const mask = await refineEdgeWorker.colourRange(state.rgba.slice(), state.width, state.height, settings);
    if (states.get(session) !== state) return false;
    close(session);
    applied = applySelection(session, { mask: Raster.fromPixels(state.width, state.height, 1, mask), x: 0, y: 0, antialiased: true }, 'New', 'Color Range');
  } catch (error) {
    controller.reportError('color-range-failed', error);
    close(session);
  }
  controller.canvasView?.redraw();
  return applied;
}

export function paintColorRange(context: CanvasRenderingContext2D, session: EditorSession): void {
  const state = states.get(session);
  if (state?.preview && state.overlay && state.mask && state.phase !== 'applying') state.overlay.draw(context, session);
}

/** Canvas clicks sample the flattened image: a click replaces the samples, Shift-click adds one. */
export class ColorRangeSampler implements ToolHandler {
  constructor(private readonly controller: EditorController) {}
  down(c: ToolContext): void {
    const session = c.session, state = states.get(session);
    if (!state?.rgba || state.phase === 'applying') return;
    const x = Math.floor(c.pixel.x), y = Math.floor(c.pixel.y);
    if (x < 0 || y < 0 || x >= state.width || y >= state.height) return;
    const p = (y * state.width + x) * 4, rgba = state.rgba;
    const colour: SampledColour = { red: rgba[p]!, green: rgba[p + 1]!, blue: rgba[p + 2]! };
    change(this.controller, session, { preset: 'sampled', samples: c.modifiers.shift ? [...state.samples, colour] : [colour], samplePoint: c.pixel }, 0);
  }
  move(): void {}
  up(): void {}
  cancel(): void {}
  hover(): string { return 'crosshair'; }
}

function Thumbnail({ state, label }: { state: ColorRangeState; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const small = state.small, mask = state.mask;
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !small) return;
    canvas.width = small.width; canvas.height = small.height;
    const context = canvas.getContext('2d');
    if (!context) return;
    const image = context.createImageData(small.width, small.height);
    for (let i = 0; i < small.width * small.height; i++) {
      const m = mask ? mask[i]! : 0;
      image.data[i * 4] = m; image.data[i * 4 + 1] = m; image.data[i * 4 + 2] = m; image.data[i * 4 + 3] = 255;
    }
    context.putImageData(image, 0, 0);
  }, [small, mask]);
  return <canvas ref={ref} className={css.thumbnail} role="img" aria-label={label} data-testid="color-range-thumbnail" />;
}

const hex = (c: SampledColour) => `#${[c.red, c.green, c.blue].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

export function ColorRangePanel({ controller }: { controller: EditorController }) {
  const session = useSession(controller.session);
  const state = states.get(session);
  if (!state) return null;
  const t = panelTranslator(controller);
  const busy = state.phase === 'applying';
  const set = (next: Partial<ColorRangeState>) => change(controller, session, next);
  const labelWidth = 112;
  return (
    <FloatingPanel name="colorRange" title={t('Color Range')} onClose={() => cancelColorRange(session)} closeLabel={t('Cancel')} testId="color-range-panel">
      <fieldset className={styles.panelBody} disabled={busy} onKeyDown={(event) => {
        if (event.key === 'Escape') { cancelColorRange(session); event.preventDefault(); }
        else if (event.key === 'Enter' && !(event.target as Element).closest('input, select, textarea')) { void commitColorRange(controller, session); event.preventDefault(); }
      }}>
        <div className={styles.panelRow}>
          <span className={styles.panelLabel} style={{ width: labelWidth }}>{t('Select')}</span>
          <select className={styles.select} value={state.preset} aria-label={t('Select')} data-testid="color-range-preset"
            onChange={(event) => set({ preset: event.target.value as ColourRangePreset })}>
            {PRESETS.map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
          </select>
        </div>
        {state.preset === 'sampled' ? (
          <div className={styles.panelRow}>
            <span className={styles.panelLabel} style={{ width: labelWidth }}>{t('Samples')}</span>
            <span className={css.samples} data-testid="color-range-samples">
              {state.samples.map((sample, index) => <span key={index} className={css.sample} style={{ background: hex(sample) }} title={hex(sample)} />)}
            </span>
            {state.samples.length ? <button type="button" className={styles.pill} onClick={() => set({ samples: [], samplePoint: null })}>{t('Clear samples')}</button> : null}
          </div>
        ) : null}
        {state.preset === 'sampled' ? <p className={styles.panelNote}>{t('Click the canvas to sample a color · Shift-click adds a color')}</p> : null}
        <SliderRow label={t('Fuzziness')} value={state.fuzziness} min={0} max={200} labelWidth={labelWidth} testId="color-range-fuzziness" onChange={(fuzziness) => set({ fuzziness })} />
        {state.preset === 'sampled' ? (
          <>
            <Check label={t('Localized Color Clusters')} checked={state.localized} testId="color-range-localized" onChange={(localized) => set({ localized })} />
            {state.localized ? <SliderRow label={t('Range')} value={state.range} min={1} max={100} suffix="%" labelWidth={labelWidth} testId="color-range-range" onChange={(range) => set({ range })} /> : null}
          </>
        ) : null}
        <Thumbnail state={state} label={t('Preview')} />
        <div className={styles.panelRow}>
          <Check label={t('Invert')} checked={state.invert} testId="color-range-invert" onChange={(invert) => set({ invert })} />
          <Check label={t('Preview')} checked={state.preview} testId="color-range-preview" onChange={(value) => { state.preview = value; remembered.preview = value; session.notify('ui'); controller.canvasView?.redraw(); }} />
        </div>
        {state.error ? <p className={styles.panelError}>{state.error}</p> : null}
      </fieldset>
      <div className={styles.dialogButtons}>
        <button type="button" className={styles.pill} disabled={busy} onClick={() => cancelColorRange(session)} data-testid="color-range-cancel">{t('Cancel')}</button>
        {state.phase === 'computing' || state.phase === 'preparing' || busy ? <span className={styles.panelNote} role="status">{t(busy ? 'Applying…' : 'Working…')}</span> : null}
        <button type="button" className={`${styles.pill} ${styles.pillPrimary}`} data-testid="color-range-ok"
          disabled={busy || state.phase === 'preparing' || state.phase === 'error' || !settingsFor(state, 1)}
          onClick={() => void commitColorRange(controller, session)}>{t('OK')}</button>
      </div>
    </FloatingPanel>
  );
}
