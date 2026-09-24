/**
 * The Type tool's context bar (Photoshop's options bar): font family with search and installed fonts, style, size,
 * colour, alignment, and a Character/Paragraph popover. Values show the selection's style while editing and the
 * active text layer's otherwise; changes apply to the selection, the whole layer, or the tool settings (editor.ts).
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import styles from '../../ui/editor.module.css';
import css from './text.module.css';
import type { EditorController } from '../../ui/controller';
import { useSession } from '../../ui/hooks';
import { FloatingPanel } from '../panels';
import type { EditorSession } from '../../core/session';
import type { TextKerning, TextOpenTypeFeature, TextParagraphStyle, TextRunStyle } from '../../core/document';
import { BUNDLED_TEXT_FONTS, type MissingFont, type ParagraphStylePatch, type TextStylePatch } from '../../core/text';
import { BUNDLED_FAMILIES, type TextRuntime } from './runtime';
import type { TextEditor } from './editor';

export interface TextUiParts { readonly runtime: TextRuntime; readonly editor: TextEditor }

// MARK: Numbers

function formatValue(value: number, locale: string): string {
  return value.toLocaleString(locale, { maximumFractionDigits: 2, useGrouping: false });
}
function parseValue(text: string): number | null {
  const value = Number(text.trim().replace(',', '.'));
  return text.trim() !== '' && Number.isFinite(value) ? value : null;
}

/** A number that applies on Enter, on leaving the field or per ↑/↓ step (Shift ×10) — one undo step each. */
function ValueInput({ value, onCommit, label, locale, mixed = false, disabled, title, testId, step = 1, min = -Infinity, max = Infinity,
  placeholder, className }: {
  value: number | null; onCommit: (value: number) => void; label: string; locale: string; mixed?: boolean; disabled?: boolean;
  title?: string; testId?: string; step?: number; min?: number; max?: number; placeholder?: string; className?: string;
}) {
  const shown = mixed || value === null ? '' : formatValue(value, locale);
  const [text, setText] = useState(shown);
  const draft = useRef(shown);
  const skip = useRef(false);
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) { setText(shown); draft.current = shown; } }, [shown, focused]);
  const clamp = (number: number) => Math.min(max, Math.max(min, number));
  const commit = () => {
    const number = parseValue(draft.current);
    if (number !== null && (mixed || number !== value)) onCommit(clamp(number));
    else { setText(shown); draft.current = shown; }
  };
  return (
    <input className={`${css.number} ${className ?? ''}`} inputMode="decimal" value={text} disabled={disabled} aria-label={label} title={title ?? label}
      data-testid={testId} placeholder={placeholder ?? (mixed ? '–' : undefined)}
      onFocus={(event) => { setFocused(true); event.currentTarget.select(); }}
      onBlur={() => { setFocused(false); if (skip.current) skip.current = false; else commit(); }}
      onChange={(event) => { setText(event.target.value); draft.current = event.target.value; }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault();
          const next = clamp((parseValue(draft.current) ?? value ?? 0) + step * (event.shiftKey ? 10 : 1) * (event.key === 'ArrowUp' ? 1 : -1));
          const formatted = formatValue(next, locale);
          setText(formatted); draft.current = formatted;
          onCommit(next);
        } else if (event.key === 'Enter') {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === 'Escape') {
          skip.current = true; setText(shown); draft.current = shown;
          event.currentTarget.blur();
        }
      }} />
  );
}

// MARK: Faces

const WEIGHTS: readonly [number, string][] = [[100, 'Thin'], [200, 'ExtraLight'], [300, 'Light'], [400, 'Regular'], [500, 'Medium'],
  [600, 'SemiBold'], [700, 'Bold'], [800, 'ExtraBold'], [900, 'Black']];

/** Weight and slant from a font's style name ("SemiBold Italic", "Heavy", "Light Oblique"). */
export function parseFace(name: string): { weight: number; italic: boolean } {
  const value = name.toLowerCase().replace(/[\s_-]/g, '');
  const italic = /italic|oblique/.test(value);
  const weight = /thin|hairline/.test(value) ? 100 : /(extra|ultra)light/.test(value) ? 200 : /light/.test(value) ? 300
    : /(semi|demi)bold/.test(value) ? 600 : /(extra|ultra)bold/.test(value) ? 800 : /black|heavy/.test(value) ? 900
      : /bold/.test(value) ? 700 : /medium/.test(value) ? 500 : 400;
  return { weight, italic };
}
function faceName(weight: number, italic: boolean): string {
  const base = WEIGHTS.find(([value]) => value === weight)?.[1] ?? String(weight);
  return italic ? (weight === 400 ? 'Italic' : `${base} Italic`) : base;
}
function faceKey(weight: number, italic: boolean): string { return `${weight}|${italic ? 'italic' : 'normal'}`; }

function facesFor(runtime: TextRuntime, family: string, current: TextRunStyle): { key: string; label: string; weight: number; italic: boolean }[] {
  const faces = new Map<string, { key: string; label: string; weight: number; italic: boolean }>();
  const add = (weight: number, italic: boolean, label = faceName(weight, italic)) => {
    const key = faceKey(weight, italic);
    if (!faces.has(key)) faces.set(key, { key, label, weight, italic });
  };
  const system = runtime.systemFonts?.filter((font) => font.family.toLocaleLowerCase() === family.toLocaleLowerCase()) ?? [];
  if (system.length) for (const font of system) { const face = parseFace(font.style); add(face.weight, face.italic, font.style); }
  else for (const [weight] of WEIGHTS) add(weight, false); // bundled fonts are variable (wght 100–900)
  add(current.fontWeight, current.fontStyle !== 'normal');
  return [...faces.values()].sort((a, b) => a.weight - b.weight || Number(a.italic) - Number(b.italic));
}

// MARK: Popover helpers

function usePopover(open: boolean, close: () => void, anchor: React.RefObject<HTMLElement | null>, panel: React.RefObject<HTMLElement | null>,
  width: number, editor: TextEditor) {
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    if (!open) return;
    editor.popovers.add(close);
    return () => { editor.popovers.delete(close); };
  }, [open, close, editor]);
  useLayoutEffect(() => {
    if (!open || !anchor.current) { setPosition(null); return; }
    const rect = anchor.current.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(rect.left, globalThis.innerWidth - width - 8)), top: rect.bottom + 6 });
  }, [open, anchor, width]);
  useEffect(() => {
    if (!open) return;
    const down = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panel.current?.contains(target) || anchor.current?.contains(target)) return;
      // The colour picker opened from here is not "outside".
      if ((target as Element).closest?.('[data-testid="color-picker"]')) return;
      close();
    };
    globalThis.addEventListener('pointerdown', down, true);
    return () => globalThis.removeEventListener('pointerdown', down, true);
  }, [open, close, anchor, panel]);
  return position;
}

// MARK: Font family

let previewsRegistered = false;
/** Bundled families as CSS fonts too, so the list previews them in their own design (the engine never uses these). */
function registerPreviews(): void {
  if (previewsRegistered || typeof FontFace === 'undefined') return;
  previewsRegistered = true;
  for (const font of BUNDLED_TEXT_FONTS) {
    try {
      const face = new FontFace(font.family, `url(${font.url})`, { weight: '100 900' });
      globalThis.document.fonts.add(face);
      void face.load().catch(() => undefined);
    } catch { /* previews are optional */ }
  }
}
const cssFamily = (family: string) => `"${family.replace(/"/g, '')}", var(--cmp-font)`;

function FontPicker({ controller, ui, session, family, missing, mixed, disabled }: {
  controller: EditorController; ui: TextUiParts; session: EditorSession; family: string; missing: boolean; mixed: boolean; disabled: boolean;
}) {
  const t = controller.t;
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = useMemo(() => () => { setOpen(false); ui.editor.refocusLater(); }, [ui]);
  const position = usePopover(open, close, button, panel, 280, ui.editor);
  return (
    <>
      <button ref={button} type="button" className={css.fontButton} disabled={disabled} data-testid="font-family" aria-haspopup="listbox"
        aria-expanded={open} aria-label={`${t('Font Family')}: ${mixed ? '–' : family}`} title={t('Font Family')} onClick={() => setOpen(!open)}>
        <span className={css.fontName} style={{ fontFamily: mixed ? undefined : cssFamily(family) }}>{mixed ? '–' : family}</span>
        {missing && !mixed ? <span className={css.missingMark} title={t('Missing font')}>⚠</span> : null}
      </button>
      {open && position ? (
        <div ref={panel} className={`${css.popover} ${css.fontPopover}`} style={position} data-testid="font-list"
          onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Escape') close(); }}>
          <FontList controller={controller} ui={ui} session={session} family={family}
            pick={(value) => { setOpen(false); void ui.editor.applyStyle(session, { fontFamily: value }); }} />
        </div>
      ) : null}
    </>
  );
}

function FontList({ controller, ui, session, family, pick }: {
  controller: EditorController; ui: TextUiParts; session: EditorSession; family: string; pick: (family: string) => void;
}) {
  const t = controller.t;
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  useEffect(registerPreviews, []);
  const runtime = ui.runtime;
  const document = session.document;
  const used = [...new Set(document?.layers.flatMap((layer) => (layer.kind === 'text' ? layer.runs.map((run) => run.style.fontFamily) : [])) ?? [])].sort();
  const system = [...new Set(runtime.systemFonts?.map((font) => font.family) ?? [])].sort((a, b) => a.localeCompare(b));
  const matches = (value: string) => value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const groups: { title: string; families: string[] }[] = [
    { title: t('In This Document'), families: used.filter(matches) },
    { title: t('Bundled Fonts'), families: BUNDLED_FAMILIES.filter(matches) },
    { title: t('Installed Fonts'), families: system.filter(matches) },
  ].filter((group) => group.families.length);
  const flat = groups.flatMap((group) => group.families);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  let index = -1;
  const known = (value: string) => runtime.available(value) || system.includes(value);
  return (
    <>
      <input className={css.search} autoFocus placeholder={t('Search fonts')} aria-label={t('Search fonts')} value={query} data-testid="font-search"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') { event.preventDefault(); setActive(Math.min(flat.length - 1, active + 1)); }
          else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(Math.max(0, active - 1)); }
          else if (event.key === 'Enter' && flat[active]) { event.preventDefault(); pick(flat[active]!); }
        }} />
      <div ref={listRef} className={css.fontList} role="listbox" aria-label={t('Font Family')}>
        {groups.map((group) => (
          <div key={group.title} role="group" aria-label={group.title}>
            <div className={css.fontGroup}>{group.title}</div>
            {group.families.map((value) => {
              index++;
              const current = index;
              const missing = !known(value);
              return (
                <button key={`${group.title}-${value}`} type="button" role="option" aria-selected={value === family} data-index={current}
                  className={`${css.fontRow} ${current === active ? css.fontRowActive : ''} ${value === family ? css.fontRowCurrent : ''}`}
                  style={{ fontFamily: missing ? undefined : cssFamily(value) }} onMouseEnter={() => setActive(current)} onClick={() => pick(value)}>
                  <span>{value}</span>
                  {missing ? <span className={css.fontRowNote}>⚠ {t('Missing')}</span> : null}
                </button>
              );
            })}
          </div>
        ))}
        {!flat.length ? <p className={styles.panelNote} style={{ padding: 8 }}>{t('No fonts match.')}</p> : null}
      </div>
      {runtime.canListSystemFonts ? (
        <div className={css.fontFooter}>
          {runtime.systemFonts === null ? (
            <button type="button" className={styles.pill} disabled={loading} data-testid="show-installed-fonts"
              onClick={() => { setLoading(true); void runtime.loadSystemFonts(session).finally(() => setLoading(false)); }}>
              {loading ? t('Asking for installed fonts…') : t('Show Installed Fonts…')}
            </button>
          ) : !runtime.systemFonts.length ? (
            <p className={styles.panelNote}>{t('This browser doesn’t share its installed fonts. The bundled fonts are always available.')}</p>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

// MARK: Icons

function AlignIcon({ value }: { value: TextParagraphStyle['alignment'] }) {
  const lines: Record<TextParagraphStyle['alignment'], [number, number][]> = {
    left: [[3, 17], [3, 13], [3, 17], [3, 11]], center: [[3, 17], [5, 15], [3, 17], [6, 14]],
    right: [[3, 17], [7, 17], [3, 17], [9, 17]], justify: [[3, 17], [3, 17], [3, 17], [3, 12]],
  };
  return (
    <svg width={16} height={16} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" aria-hidden>
      {lines[value].map(([from, to], row) => <line key={row} x1={from} x2={to} y1={4 + row * 4} y2={4 + row * 4} />)}
    </svg>
  );
}

const ALIGNMENTS: readonly [TextParagraphStyle['alignment'], string][] = [['left', 'Left Align Text'], ['center', 'Center Text'],
  ['right', 'Right Align Text'], ['justify', 'Justify']];

function AlignmentButtons({ controller, value, disabled, onChange }: {
  controller: EditorController; value: TextParagraphStyle['alignment']; disabled: boolean; onChange: (value: TextParagraphStyle['alignment']) => void;
}) {
  const t = controller.t;
  return (
    <div className={styles.segmented} role="radiogroup" aria-label={t('Alignment')}>
      {ALIGNMENTS.map(([option, label]) => (
        <button key={option} type="button" role="radio" aria-checked={value === option} aria-label={t(label)} title={t(label)} disabled={disabled}
          data-testid={`text-align-${option}`} className={`${styles.segment} ${css.alignButton} ${value === option ? styles.segmentOn : ''}`}
          onClick={() => onChange(option)}>
          <AlignIcon value={option} />
        </button>
      ))}
    </div>
  );
}

// MARK: Character / Paragraph popover

const FEATURES: readonly [TextOpenTypeFeature, string][] = [['liga', 'Ligatures'], ['dlig', 'Discretionary Ligatures'],
  ['tnum', 'Tabular Figures'], ['lnum', 'Lining Figures'], ['onum', 'Oldstyle Figures'], ['smcp', 'Small Caps']];

function Cell({ label, children, wide = false, title }: { label: string; children: ReactNode; wide?: boolean; title?: string }) {
  return <label className={`${css.cell} ${wide ? css.cellWide : ''}`} title={title}><span>{label}</span>{children}</label>;
}

function TypePanel({ controller, ui, session, style, paragraph, mixed, disabled, close }: {
  controller: EditorController; ui: TextUiParts; session: EditorSession; style: TextRunStyle; paragraph: TextParagraphStyle;
  mixed: ReadonlySet<keyof TextRunStyle>; disabled: boolean; close: () => void;
}) {
  const t = controller.t, locale = controller.locale;
  const [tab, setTab] = useState<'character' | 'paragraph'>('character');
  const setStyle = (patch: TextStylePatch) => void ui.editor.applyStyle(session, patch);
  const setParagraph = (patch: ParagraphStylePatch) => void ui.editor.applyParagraph(session, patch);
  const featureOn = (feature: TextOpenTypeFeature) => (feature === 'liga' ? style.features.liga !== false : style.features[feature] === true);
  const toggle = (feature: TextOpenTypeFeature, on: boolean) => {
    const features = { ...style.features, [feature]: on };
    if (on && feature === 'lnum') features.onum = false;
    if (on && feature === 'onum') features.lnum = false;
    setStyle({ features });
  };
  const pt = t('pt');
  const number = (label: string, value: number | null, commit: (value: number) => void, options: { min?: number; max?: number; testId?: string;
    disabledTitle?: string; unit?: string; placeholder?: string; mixed?: boolean } = {}) => (
    <Cell label={label} title={options.disabledTitle}>
      <ValueInput label={label} value={value} locale={locale} onCommit={commit} min={options.min} max={options.max} testId={options.testId}
        disabled={disabled || !!options.disabledTitle} title={options.disabledTitle} placeholder={options.placeholder} mixed={options.mixed} />
      <span className={css.unit}>{options.unit ?? pt}</span>
    </Cell>
  );
  return (
    <>
      <div className={styles.panelHeader} style={{ cursor: 'default' }}>
        <div className={styles.segmented} role="tablist" aria-label={t('Character & Paragraph')}>
          {(['character', 'paragraph'] as const).map((value) => (
            <button key={value} type="button" role="tab" aria-selected={tab === value} data-testid={`text-tab-${value}`}
              className={`${styles.segment} ${tab === value ? styles.segmentOn : ''}`} onClick={() => setTab(value)}>
              {t(value === 'character' ? 'Character' : 'Paragraph')}
            </button>
          ))}
        </div>
        <button type="button" className={styles.iconButton} aria-label={t('Close')} onClick={close}>×</button>
      </div>
      {tab === 'character' ? (
        <>
          <div className={css.grid}>
            {number(t('Font Size'), style.fontSize, (value) => setStyle({ fontSize: value }), { min: 0.5, max: 12_000, mixed: mixed.has('fontSize') })}
            <Cell label={t('Leading')}>
              <ValueInput label={t('Leading')} value={style.leading} locale={locale} min={0.5} max={12_000} testId="text-leading" disabled={disabled}
                placeholder={t('Auto')} mixed={mixed.has('leading')} onCommit={(value) => setStyle({ leading: value })} />
              <span className={css.unit}>{pt}</span>
            </Cell>
            <Cell label={t('Kerning')}>
              <select className={styles.select} value={mixed.has('kerning') ? '' : style.kerning} disabled={disabled} aria-label={t('Kerning')}
                data-testid="text-kerning" onChange={(event) => setStyle({ kerning: event.target.value as TextKerning })}>
                {mixed.has('kerning') ? <option value="" disabled>–</option> : null}
                <option value="metric">{t('Metrics')}</option>
                <option value="optical">{t('Optical')}</option>
                <option value="none">0</option>
              </select>
            </Cell>
            {number(t('Tracking'), style.tracking, (value) => setStyle({ tracking: Math.round(value) }), { min: -1000, max: 10_000, unit: '‰',
              testId: 'text-tracking', mixed: mixed.has('tracking') })}
            <label className={`${styles.check} ${css.cellWide}`}>
              <input type="checkbox" checked={style.leading === null} disabled={disabled} data-testid="text-leading-auto"
                onChange={(event) => setStyle({ leading: event.target.checked ? null : Math.round(style.fontSize * 1.2 * 100) / 100 })} />
              {t('Automatic leading')}
            </label>
            {number(t('Baseline Shift'), style.baselineShift, (value) => setStyle({ baselineShift: value }), {
              testId: 'text-baseline', disabledTitle: t('Baseline shift is kept with the text but not drawn yet: the text engine cannot render it.') })}
          </div>
          <h3 className={css.sectionTitle}>OpenType</h3>
          <div className={css.features}>
            {FEATURES.map(([feature, label]) => (
              <label key={feature} className={styles.check}>
                <input type="checkbox" checked={featureOn(feature)} disabled={disabled} data-testid={`text-feature-${feature}`}
                  onChange={(event) => toggle(feature, event.target.checked)} />
                {t(label)}
              </label>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className={css.start}>
            <AlignmentButtons controller={controller} value={paragraph.alignment} disabled={disabled} onChange={(alignment) => setParagraph({ alignment })} />
          </div>
          <div className={css.grid}>
            {number(t('Left Indent'), paragraph.startIndent, (value) => setParagraph({ startIndent: value }), { testId: 'text-indent-left' })}
            {number(t('Right Indent'), paragraph.endIndent, (value) => setParagraph({ endIndent: value }), { testId: 'text-indent-right' })}
            {number(t('First Line Indent'), paragraph.firstLineIndent, (value) => setParagraph({ firstLineIndent: value }), { testId: 'text-indent-first' })}
            <span />
            {number(t('Space Before'), paragraph.spaceBefore, (value) => setParagraph({ spaceBefore: Math.max(0, value) }), { min: 0, testId: 'text-space-before' })}
            {number(t('Space After'), paragraph.spaceAfter, (value) => setParagraph({ spaceAfter: Math.max(0, value) }), { min: 0, testId: 'text-space-after' })}
            <Cell label={t('Direction')} wide>
              <select className={styles.select} value={paragraph.direction} disabled={disabled} aria-label={t('Direction')} data-testid="text-direction"
                onChange={(event) => setParagraph({ direction: event.target.value as TextParagraphStyle['direction'] })}>
                <option value="auto">{t('Automatic')}</option>
                <option value="ltr">{t('Left to Right')}</option>
                <option value="rtl">{t('Right to Left')}</option>
              </select>
            </Cell>
          </div>
        </>
      )}
    </>
  );
}

// MARK: Context bar

export function TextControls({ controller, ui }: { controller: EditorController; ui: TextUiParts }) {
  const session = useSession(controller.session);
  const t = controller.t;
  const { target, style, paragraph, mixed } = ui.editor.controlsState(session);
  const editing = ui.editor.editing?.session === session;
  const disabled = !session.document || (target === 'layer' && !session.canEditLayers);
  const [panelOpen, setPanelOpen] = useState(false);
  const panelButton = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const closePanel = useMemo(() => () => { setPanelOpen(false); ui.editor.refocusLater(); }, [ui]);
  const position = usePopover(panelOpen, closePanel, panelButton, panel, 460, ui.editor);
  const faces = facesFor(ui.runtime, style.fontFamily, style);
  const face = faceKey(style.fontWeight, style.fontStyle !== 'normal');
  const color = style.color;
  const missing = !ui.runtime.available(style.fontFamily) && !ui.runtime.systemFonts?.some((font) => font.family === style.fontFamily)
    && ui.runtime.isReady;
  return (
    <>
      <span className={styles.headerTitle} data-testid="text-bar" data-engine={ui.runtime.isReady ? 'ready' : 'loading'} data-target={target}>
        {t('Text')}
      </span>
      <FontPicker controller={controller} ui={ui} session={session} family={style.fontFamily} missing={missing} mixed={mixed.has('fontFamily')}
        disabled={disabled} />
      <select className={styles.select} value={mixed.has('fontWeight') || mixed.has('fontStyle') ? '' : face} disabled={disabled}
        aria-label={t('Font Style')} title={t('Font Style')} data-testid="font-style"
        onChange={(event) => {
          const chosen = faces.find((value) => value.key === event.target.value);
          if (chosen) void ui.editor.applyStyle(session, { fontWeight: chosen.weight, fontStyle: chosen.italic ? 'italic' : 'normal',
            axes: { ...style.axes, wght: chosen.weight } });
        }}>
        {mixed.has('fontWeight') || mixed.has('fontStyle') ? <option value="" disabled>–</option> : null}
        {faces.map((value) => <option key={value.key} value={value.key}>{value.label}</option>)}
      </select>
      <label className={styles.field} title={t('Font Size')}>
        <ValueInput label={t('Font Size')} value={style.fontSize} locale={controller.locale} min={0.5} max={12_000} disabled={disabled}
          mixed={mixed.has('fontSize')} testId="font-size" className={css.sizeField} onCommit={(value) => void ui.editor.applyStyle(session, { fontSize: value })} />
        <span>{t('pt')}</span>
      </label>
      <AlignmentButtons controller={controller} value={paragraph.alignment} disabled={disabled}
        onChange={(alignment) => void ui.editor.applyParagraph(session, { alignment })} />
      <button type="button" className={css.swatch} disabled={disabled || !controller.pickColor} data-testid="text-color"
        aria-label={t('Text Color')} title={t('Text Color')}
        style={{ background: mixed.has('color') ? 'linear-gradient(135deg, #fff 50%, #000 50%)'
          : `rgb(${Math.round(color.red * 255)},${Math.round(color.green * 255)},${Math.round(color.blue * 255)})` }}
        onClick={() => controller.pickColor?.({
          title: t('Text Color'), initial: { red: color.red, green: color.green, blue: color.blue },
          commit: (value) => void ui.editor.applyStyle(session, { color: { ...value, alpha: color.alpha ?? 1 } }),
        })} />
      <button ref={panelButton} type="button" className={`${styles.pill} ${panelOpen ? styles.pillOn : ''}`} disabled={!session.document}
        aria-expanded={panelOpen} data-testid="text-panel-toggle" onClick={() => setPanelOpen(!panelOpen)}>
        {t('Character & Paragraph')}
      </button>
      {!ui.runtime.isReady && !ui.runtime.failure ? <span className={styles.secondary}>{t('Loading fonts…')}</span> : null}
      <span className={styles.spacer} />
      {editing ? (
        <>
          <button type="button" className={styles.pill} data-testid="text-cancel" onClick={() => ui.editor.cancel()}>{t('Cancel')}</button>
          <button type="button" className={`${styles.pill} ${styles.pillPrimary}`} data-testid="text-commit" onClick={() => ui.editor.commit()}>
            {t('Commit')}
          </button>
        </>
      ) : null}
      {panelOpen && position ? (
        <div ref={panel} className={`${css.popover} ${css.panelPopover}`} style={position} role="dialog" aria-label={t('Character & Paragraph')}
          data-testid="text-panel" onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Escape') closePanel(); }}>
          <TypePanel controller={controller} ui={ui} session={session} style={style} paragraph={paragraph} mixed={mixed}
            disabled={disabled} close={closePanel} />
        </div>
      ) : null}
    </>
  );
}

// MARK: Missing fonts (P11)

function MissingRow({ controller, ui, session, font }: { controller: EditorController; ui: TextUiParts; session: EditorSession; font: MissingFont }) {
  const t = controller.t;
  const system = [...new Set(ui.runtime.systemFonts?.map((value) => value.family) ?? [])].sort((a, b) => a.localeCompare(b));
  const options = [...new Set([...BUNDLED_FAMILIES, ...ui.runtime.registry?.availableFamilies ?? [], ...system])];
  const [replacement, setReplacement] = useState(options[0] ?? 'Noto Sans');
  const count = font.layerIds.length;
  return (
    <li className={css.missingRow} data-testid="missing-font" data-family={font.family}>
      <span className={css.missingText}>
        <span className={css.missingName}>{font.family}</span>
        <span className={css.missingMeta}>
          {count.toLocaleString(controller.locale)} {t(count === 1 ? 'text layer' : 'text layers')} · {t('shown as')} {font.substitute}
        </span>
      </span>
      <select className={`${styles.select} ${css.replacement}`} value={replacement} aria-label={`${t('Replace with')}: ${font.family}`} data-testid="replacement-font"
        onChange={(event) => setReplacement(event.target.value)}>
        {options.map((value) => <option key={value} value={value}>{value}</option>)}
      </select>
      <button type="button" className={styles.pill} data-testid="replace-font" disabled={!session.canEditLayers}
        onClick={() => void ui.editor.replaceFont(session, font.family, replacement)}>{t('Replace')}</button>
    </li>
  );
}

export function MissingFontsPanel({ controller, ui }: { controller: EditorController; ui: TextUiParts }) {
  const session = useSession(controller.session);
  const t = controller.t;
  if (!ui.runtime.noticeShown(session)) return null;
  const missing = ui.runtime.missingFonts(session);
  return (
    <FloatingPanel name="missingFonts" title={t('Missing Fonts')} onClose={() => ui.runtime.dismissNotice(session)} closeLabel={t('Keep')}
      testId="missing-fonts">
      <p className={styles.panelNote}>
        {t('This document uses fonts that aren’t available here. Their text is drawn with a substitute until you replace them; imported text keeps its saved preview until you edit it.')}
      </p>
      <ul className={css.missingList}>
        {missing.map((font) => <MissingRow key={font.family} controller={controller} ui={ui} session={session} font={font} />)}
      </ul>
      <div className={styles.dialogButtons}>
        {ui.runtime.canListSystemFonts ? (
          <button type="button" className={styles.pill} data-testid="missing-fonts-installed" onClick={() => void ui.runtime.loadSystemFonts(session)}>
            {t('Look in Installed Fonts')}
          </button>
        ) : null}
        <button type="button" className={`${styles.pill} ${styles.pillPrimary}`} data-testid="missing-fonts-keep" onClick={() => ui.runtime.dismissNotice(session)}>
          {t('Keep')}
        </button>
      </div>
    </FloatingPanel>
  );
}
