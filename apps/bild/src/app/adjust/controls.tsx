/**
 * Panels of the Phase-2 adjustment layers (PRODUCT-PLAN P5, 6.3): Basic, Color Lookup, Color (Black & White, Color
 * Balance, Selective Color), Photo Filter, Channel Mixer, Invert, Threshold, Posterize and Brightness/Contrast.
 * They follow the existing panels in adjustmentsFeature: the controls only see the adjustment value and a change
 * callback; the panel around them owns preview, OK/Cancel and the single undo step.
 */

import { useMemo, useState, type ReactNode } from 'react';
import styles from '../../ui/editor.module.css';
import local from './adjust.module.css';
import type { EditorController } from '../../ui/controller';
import type { EditorSession } from '../../core/session';
import type { CanvasDocument, LayerAdjustment } from '../../core/document';
import type {
  BasicSettings, BlackAndWhiteSettings, BrightnessContrastSettings, ChannelMixerChannel, ChannelMixerSettings, ColourBalanceTone,
  ColourSettings, LayerAdjustmentKind, LutInterpolation, PhotoFilterSettings, RGB, SelectiveColourRange, SelectiveColourValues,
} from '../../core/model/types';
import { defaultBasic, defaultBrightnessContrast, defaultChannelMixer, defaultColour, defaultPhotoFilter } from '../../core/adjustments';
import { installCubeLut, parseCubeLut } from '../../core/adjust';
import { Check, Histogram, Segmented, SliderRow } from '../adjustmentsFeature';
import { autoBlackAndWhite } from './auto';

// MARK: Kinds, names and menu order

/** English UI names (the model keeps its kind strings); German comes from the translator. */
const DISPLAY: Partial<Record<LayerAdjustmentKind, string>> = { 'Colour Lookup': 'Color Lookup', 'Colour': 'Color' };
export const adjustmentName = (kind: LayerAdjustmentKind): string => DISPLAY[kind] ?? kind;

/** Layer › New Adjustment Layer and the Layers panel button, in Photoshop's grouping with Basic (P5) first. */
export const ADJUSTMENT_MENU: readonly (LayerAdjustmentKind | 'separator')[] = [
  'Basic', 'separator',
  'Brightness/Contrast', 'Levels', 'Curves', 'Exposure', 'separator',
  'Hue/Saturation', 'Colour', 'Photo Filter', 'Channel Mixer', 'Colour Lookup', 'separator',
  'Invert', 'Posterize', 'Threshold', 'Gradient Map', 'separator',
  'Grain',
];

// MARK: Shared pieces

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));
const hex = (c: RGB) => `#${[c.red, c.green, c.blue].map((v) => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, '0')).join('')}`;

interface Props<T> { controller: EditorController; settings: T; onChange: (settings: T) => void }

/** A color well that opens the app's color picker, previewing live (GradientMapControls). */
function ColorWell({ controller, title, color, onChange, testId, label }: {
  controller: EditorController; title: string; color: RGB; onChange: (color: RGB) => void; testId?: string; label: string;
}) {
  const pick = () => {
    const before = color;
    controller.pickColor?.({ title, initial: color, preview: onChange, commit: onChange, cancel: () => onChange(before) });
  };
  return <button type="button" className={styles.colorWell} style={{ background: hex(color) }} onClick={pick} aria-label={label} title={label} data-testid={testId} />;
}

function Group({ title, children, onReset, resetLabel }: { title: string; children: ReactNode; onReset?: () => void; resetLabel?: string }) {
  return (
    <section className={local.group} aria-label={title}>
      <div className={local.groupHeader}>
        <h3 className={local.groupTitle}>{title}</h3>
        {onReset ? <button type="button" className={local.groupReset} onClick={onReset}>{resetLabel}</button> : null}
      </div>
      {children}
    </section>
  );
}

function Footer({ controller, onReset, children }: { controller: EditorController; onReset: () => void; children?: ReactNode }) {
  return (
    <div className={styles.panelRow}>
      {children}
      <span style={{ flex: 1 }} />
      <button type="button" className={styles.pill} onClick={onReset} data-testid="adjustment-reset">{controller.t('Reset')}</button>
    </div>
  );
}

// MARK: Basic (P5: Lightroom-style grouped sliders)

type BasicKey = keyof BasicSettings;
const BASIC_GROUPS: { title: string; keys: { key: BasicKey; label: string }[] }[] = [
  { title: 'Light', keys: [{ key: 'exposure', label: 'Exposure' }, { key: 'contrast', label: 'Contrast' }, { key: 'highlights', label: 'Highlights' },
    { key: 'shadows', label: 'Shadows' }, { key: 'whites', label: 'Whites' }, { key: 'blacks', label: 'Blacks' }] },
  { title: 'Presence', keys: [{ key: 'texture', label: 'Texture' }, { key: 'clarity', label: 'Clarity' }, { key: 'dehaze', label: 'Dehaze' },
    { key: 'vibrance', label: 'Vibrance' }, { key: 'saturation', label: 'Saturation' }] },
  { title: 'Color', keys: [{ key: 'temperature', label: 'Temperature' }, { key: 'tint', label: 'Tint' }] },
];

export function BasicControls({ controller, settings, onChange }: Props<BasicSettings>) {
  const t = controller.t;
  const neutral = defaultBasic();
  const hint = t('Double-click the name to reset');
  return (
    <>
      {BASIC_GROUPS.map((group) => (
        <Group key={group.title} title={t(group.title)} resetLabel={t('Reset')}
          onReset={group.keys.some(({ key }) => settings[key] !== neutral[key])
            ? () => onChange({ ...settings, ...Object.fromEntries(group.keys.map(({ key }) => [key, neutral[key]])) }) : undefined}>
          {group.keys.map(({ key, label }) => (
            <SliderRow key={key} label={t(label)} value={settings[key]} min={key === 'exposure' ? -5 : -100} max={key === 'exposure' ? 5 : 100}
              decimals={key === 'exposure' ? 2 : 0} testId={`basic-${key}`} labelWidth={104} title={hint}
              trackClass={key === 'temperature' ? local.temperatureTrack : key === 'tint' ? local.tintTrack : undefined}
              onReset={() => onChange({ ...settings, [key]: neutral[key] })}
              onChange={(value) => onChange({ ...settings, [key]: value })} />
          ))}
        </Group>
      ))}
      <Footer controller={controller} onReset={() => onChange(defaultBasic())} />
    </>
  );
}

// MARK: Color Lookup (.cube)

const lutNames = new Map<string, string>();
const lutInfoCache = new WeakMap<Uint8Array, { title: string; size: number } | null>();
/** LUTs loaded while the panel is open; the ones not kept when it closes are removed from the document again. */
const pendingLuts = new WeakMap<EditorSession, Set<string>>();

function lutInfo(document: CanvasDocument | null, resourceId: string): { name: string; size: number } | null {
  const resource = document?.resources?.find((r) => r.id === resourceId && r.role === 'lut');
  if (!resource) return null;
  let info = lutInfoCache.get(resource.bytes);
  if (info === undefined) {
    try { const lut = parseCubeLut(resource.bytes); info = { title: lut.title, size: lut.size3D || lut.size1D }; } catch { info = null; }
    lutInfoCache.set(resource.bytes, info);
  }
  return info ? { name: info.title || lutNames.get(resourceId) || '', size: info.size } : null;
}

/** Called before an adjustment-layer edit ends: drops LUT resources loaded meanwhile that the layer does not use. */
export function settlePendingLuts(session: EditorSession, keep: string | null): void {
  const pending = pendingLuts.get(session);
  pendingLuts.delete(session);
  const document = session.document;
  if (!pending?.size || !document?.resources) return;
  const drop = [...pending].filter((id) => id !== keep);
  if (drop.length) session.replaceDocument({ ...document, resources: document.resources.filter((r) => !drop.includes(r.id)) });
}

/** The host's LUT picker when it has one; otherwise the browser's file chooser (the pattern of the host's own pickers). */
function chooseCubeFile(controller: EditorController): Promise<File | null> {
  const host = controller.host as { chooseLut?: () => Promise<File | null> };
  if (host.chooseLut) return host.chooseLut();
  return new Promise((resolve) => {
    const input = globalThis.document.createElement('input');
    input.type = 'file';
    input.accept = '.cube,.CUBE';
    input.style.display = 'none';
    input.addEventListener('change', () => { resolve(input.files?.[0] ?? null); input.remove(); });
    input.addEventListener('cancel', () => { resolve(null); input.remove(); });
    globalThis.document.body.append(input);
    input.click();
  });
}

export function ColourLookupControls({ controller, session, settings, onChange }: Props<{ resourceId: string; interpolation: LutInterpolation }> & { session: EditorSession }) {
  const t = controller.t;
  const [error, setError] = useState<string | null>(null);
  const info = lutInfo(session.document, settings.resourceId);
  const load = async () => {
    const file = await chooseCubeFile(controller);
    if (!file) return;
    const document = session.document;
    if (!document) return;
    try {
      const installed = installCubeLut(document, new Uint8Array(await file.arrayBuffer()));
      lutNames.set(installed.resourceId, file.name.replace(/\.cube$/i, ''));
      let pending = pendingLuts.get(session);
      if (!pending) { pending = new Set(); pendingLuts.set(session, pending); }
      pending.add(installed.resourceId);
      session.replaceDocument({ ...session.document!, resources: installed.document.resources });
      setError(null);
      onChange({ ...settings, resourceId: installed.resourceId });
    } catch (e) {
      setError(`${t('This file is not a usable .cube LUT.')} ${e instanceof Error ? e.message : ''}`.trim());
    }
  };
  return (
    <>
      <div className={local.lutBox}>
        <span className={local.lutName} data-testid="lut-name" title={info?.name || undefined}>
          {info ? info.name || t('Untitled LUT') : t('No LUT loaded')}
        </span>
        {info ? <span className={styles.panelCaption}>{`${info.size}³`}</span> : null}
        <button type="button" className={styles.pill} onClick={() => void load()} data-testid="lut-load">{t(info ? 'Replace…' : 'Load .cube File…')}</button>
      </div>
      {error ? <p className={styles.panelError} data-testid="lut-error">{error}</p> : null}
      <div className={styles.panelRow}>
        <span className={styles.panelLabel}>{t('Interpolation')}</span>
        <Segmented label={t('Interpolation')} options={['tetrahedral', 'trilinear'] as const} value={settings.interpolation}
          labelOf={(v) => t(v === 'tetrahedral' ? 'Tetrahedral' : 'Trilinear')} onChange={(interpolation) => onChange({ ...settings, interpolation })} />
      </div>
      <p className={styles.panelNote}>{t('3D and 1D .cube files (Adobe/Resolve) up to 65 points are supported. The file is stored in the project.')}</p>
    </>
  );
}

// MARK: Color (Black & White, Color Balance, Selective Color)

type ColourTab = 'bw' | 'balance' | 'selective';
const BW_KEYS: { key: keyof Pick<BlackAndWhiteSettings, 'reds' | 'yellows' | 'greens' | 'cyans' | 'blues' | 'magentas'>; label: string }[] = [
  { key: 'reds', label: 'Reds' }, { key: 'yellows', label: 'Yellows' }, { key: 'greens', label: 'Greens' },
  { key: 'cyans', label: 'Cyans' }, { key: 'blues', label: 'Blues' }, { key: 'magentas', label: 'Magentas' },
];
const TONES = ['shadows', 'midtones', 'highlights'] as const;
const SELECTIVE_RANGES: readonly SelectiveColourRange[] = ['Reds', 'Yellows', 'Greens', 'Cyans', 'Blues', 'Magentas', 'Whites', 'Neutrals', 'Blacks'];
const ZERO_SELECTIVE: SelectiveColourValues = { cyan: 0, magenta: 0, yellow: 0, black: 0 };
const panelTabs = new WeakMap<EditorSession, { tab: ColourTab; tone: typeof TONES[number]; range: SelectiveColourRange }>();

export function ColourControls({ controller, session, settings, onChange, sample }: Props<ColourSettings> & {
  session: EditorSession; sample: () => Uint8Array | null;
}) {
  const t = controller.t;
  const [, refresh] = useState(0);
  let view = panelTabs.get(session);
  if (!view) { view = { tab: 'bw', tone: 'midtones', range: 'Reds' }; panelTabs.set(session, view); }
  const setView = (patch: Partial<NonNullable<typeof view>>) => { panelTabs.set(session, { ...view!, ...patch }); refresh((n) => n + 1); };
  const bw = settings.blackAndWhite, balance = settings.colourBalance, selective = settings.selectiveColour;
  const setBw = (patch: Partial<BlackAndWhiteSettings>) => onChange({ ...settings, blackAndWhite: { ...bw, enabled: true, ...patch } });
  const tone: ColourBalanceTone = balance[view.tone];
  const setTone = (patch: Partial<ColourBalanceTone>) => onChange({ ...settings, colourBalance: { ...balance, enabled: true, [view!.tone]: { ...tone, ...patch } } });
  const range = selective.ranges[view.range] ?? ZERO_SELECTIVE;
  const setRange = (patch: Partial<SelectiveColourValues>) => {
    const next = { ...range, ...patch };
    const ranges = { ...selective.ranges };
    if (next.cyan || next.magenta || next.yellow || next.black) ranges[view!.range] = next; else delete ranges[view!.range];
    onChange({ ...settings, selectiveColour: { ...selective, ranges } });
  };
  const tabs: { id: ColourTab; label: string; on: boolean }[] = [
    { id: 'bw', label: 'Black & White', on: bw.enabled },
    { id: 'balance', label: 'Color Balance', on: balance.enabled },
    { id: 'selective', label: 'Selective Color', on: Object.keys(selective.ranges).length > 0 },
  ];
  const hint = t('Double-click the name to reset');
  const defaults = defaultColour();
  let body: ReactNode;
  if (view.tab === 'bw') body = (
    <>
      <div className={styles.panelRow}>
        <Check label={t('Convert to black & white')} checked={bw.enabled} testId="colour-bw-enabled"
          onChange={(enabled) => onChange({ ...settings, blackAndWhite: { ...bw, enabled } })} />
        <span style={{ flex: 1 }} />
        <button type="button" className={styles.pill} data-testid="colour-bw-auto" title={t('Mix the gray from the colors under this layer')}
          onClick={() => { const pixels = sample(); if (pixels) onChange({ ...settings, blackAndWhite: autoBlackAndWhite(pixels, bw) }); }}>{t('Auto')}</button>
      </div>
      {BW_KEYS.map(({ key, label }) => (
        <SliderRow key={key} label={t(label)} value={bw[key]} min={-200} max={300} suffix="%" testId={`colour-bw-${key}`} title={hint}
          onReset={() => setBw({ [key]: defaults.blackAndWhite[key] })} onChange={(value) => setBw({ [key]: value })} />
      ))}
      <div className={styles.panelRow}>
        <Check label={t('Tinted')} checked={bw.tint} testId="colour-bw-tint" onChange={(tint) => setBw({ tint })} />
        <ColorWell controller={controller} title={`${t('Black & White')} · ${t('Tint color')}`} color={bw.tintColor} label={t('Tint color')}
          testId="colour-bw-tint-color" onChange={(tintColor) => setBw({ tint: true, tintColor })} />
      </div>
    </>
  );
  else if (view.tab === 'balance') body = (
    <>
      <Check label={t('Apply color balance')} checked={balance.enabled} testId="colour-balance-enabled"
        onChange={(enabled) => onChange({ ...settings, colourBalance: { ...balance, enabled } })} />
      <div className={styles.panelRow}>
        <span className={styles.panelLabel} style={{ width: 112 }}>{t('Tone')}</span>
        <Segmented label={t('Tone')} options={TONES} value={view.tone} onChange={(value) => setView({ tone: value })}
          labelOf={(v) => t(v === 'shadows' ? 'Shadows' : v === 'midtones' ? 'Midtones' : 'Highlights')} />
      </div>
      {([['cyanRed', 'Cyan', 'Red'], ['magentaGreen', 'Magenta', 'Green'], ['yellowBlue', 'Yellow', 'Blue']] as const).map(([key, from, to]) => (
        <SliderRow key={key} label={`${t(from)} – ${t(to)}`} value={tone[key]} min={-100} max={100} testId={`colour-balance-${key}`} labelWidth={112} title={hint}
          onReset={() => setTone({ [key]: 0 })} onChange={(value) => setTone({ [key]: value })} />
      ))}
      <Check label={t('Preserve Luminosity')} checked={balance.preserveLuminosity} testId="colour-balance-luminosity"
        onChange={(preserveLuminosity) => onChange({ ...settings, colourBalance: { ...balance, preserveLuminosity } })} />
    </>
  );
  else body = (
    <>
      <div className={styles.panelRow}>
        <span className={styles.panelLabel}>{t('Colors')}</span>
        <select className={styles.select} value={view.range} aria-label={t('Colors')} data-testid="colour-selective-range"
          onChange={(event) => setView({ range: event.target.value as SelectiveColourRange })}>
          {SELECTIVE_RANGES.map((r) => <option key={r} value={r}>{`${t(r)}${selective.ranges[r] ? ' •' : ''}`}</option>)}
        </select>
      </div>
      {([['cyan', 'Cyan'], ['magenta', 'Magenta'], ['yellow', 'Yellow'], ['black', 'Black']] as const).map(([key, label]) => (
        <SliderRow key={key} label={t(label)} value={range[key]} min={-100} max={100} suffix="%" testId={`colour-selective-${key}`} title={hint}
          onReset={() => setRange({ [key]: 0 })} onChange={(value) => setRange({ [key]: value })} />
      ))}
      <div className={styles.panelRow}>
        <span className={styles.panelLabel}>{t('Method')}</span>
        <Segmented label={t('Method')} options={['relative', 'absolute'] as const} value={selective.mode}
          labelOf={(v) => t(v === 'relative' ? 'Relative' : 'Absolute')} onChange={(mode) => onChange({ ...settings, selectiveColour: { ...selective, mode } })} />
      </div>
    </>
  );
  return (
    <>
      <div className={local.tabs} role="tablist" aria-label={t('Color')}>
        {tabs.map((tab) => (
          <button key={tab.id} type="button" role="tab" aria-selected={view!.tab === tab.id} data-testid={`colour-tab-${tab.id}`}
            className={`${local.tab} ${view!.tab === tab.id ? local.tabOn : ''}`} onClick={() => setView({ tab: tab.id })}>
            <span className={`${local.tabDot} ${tab.on ? local.tabDotOn : ''}`} aria-hidden />
            {t(tab.label)}
          </button>
        ))}
      </div>
      {body}
      <Footer controller={controller} onReset={() => onChange(view!.tab === 'bw' ? { ...settings, blackAndWhite: defaults.blackAndWhite }
        : view!.tab === 'balance' ? { ...settings, colourBalance: defaults.colourBalance } : { ...settings, selectiveColour: defaults.selectiveColour })} />
    </>
  );
}

// MARK: Photo Filter

/** Photoshop's photo filter presets (their published approximate colors). */
const PHOTO_FILTERS: { name: string; color: string }[] = [
  { name: 'Warming Filter (85)', color: '#ec8a00' }, { name: 'Warming Filter (LBA)', color: '#fa9600' }, { name: 'Warming Filter (81)', color: '#ebb113' },
  { name: 'Cooling Filter (80)', color: '#006dff' }, { name: 'Cooling Filter (LBB)', color: '#005dff' }, { name: 'Cooling Filter (82)', color: '#00b5ff' },
  { name: 'Red', color: '#ea1a1a' }, { name: 'Orange', color: '#f38417' }, { name: 'Yellow', color: '#f9e31c' }, { name: 'Green', color: '#19c919' },
  { name: 'Cyan', color: '#1dcbea' }, { name: 'Blue', color: '#1d35ea' }, { name: 'Violet', color: '#9b1dea' }, { name: 'Magenta', color: '#e318e3' },
  { name: 'Sepia', color: '#ac7a33' },
];
const rgbOf = (value: string): RGB => ({ red: parseInt(value.slice(1, 3), 16) / 255, green: parseInt(value.slice(3, 5), 16) / 255, blue: parseInt(value.slice(5, 7), 16) / 255 });

export function PhotoFilterControls({ controller, settings, onChange }: Props<PhotoFilterSettings>) {
  const t = controller.t;
  const current = hex(settings.color);
  const preset = PHOTO_FILTERS.find((p) => p.color === current)?.name ?? '';
  return (
    <>
      <div className={styles.panelRow}>
        <span className={styles.panelLabel}>{t('Filter')}</span>
        <select className={styles.select} value={preset} aria-label={t('Filter')} data-testid="photo-filter-preset" style={{ flex: 1, minWidth: 0 }}
          onChange={(event) => { const p = PHOTO_FILTERS.find((x) => x.name === event.target.value); if (p) onChange({ ...settings, color: rgbOf(p.color) }); }}>
          {preset ? null : <option value="">{t('Custom')}</option>}
          {PHOTO_FILTERS.map((p) => <option key={p.name} value={p.name}>{t(p.name)}</option>)}
        </select>
        <ColorWell controller={controller} title={`${t('Photo Filter')} · ${t('Color')}`} color={settings.color} label={t('Filter color')}
          testId="photo-filter-color" onChange={(color) => onChange({ ...settings, color })} />
      </div>
      <SliderRow label={t('Density')} value={settings.density} min={0} max={100} suffix="%" testId="photo-filter-density" title={t('Double-click the name to reset')}
        onReset={() => onChange({ ...settings, density: defaultPhotoFilter().density })} onChange={(density) => onChange({ ...settings, density })} />
      <Footer controller={controller} onReset={() => onChange(defaultPhotoFilter())}>
        <Check label={t('Preserve Luminosity')} checked={settings.preserveLuminosity} testId="photo-filter-luminosity"
          onChange={(preserveLuminosity) => onChange({ ...settings, preserveLuminosity })} />
      </Footer>
    </>
  );
}

// MARK: Channel Mixer

type MixerOutput = 'red' | 'green' | 'blue' | 'gray';
const mixerOutputs = new WeakMap<EditorSession, MixerOutput>();

export function ChannelMixerControls({ controller, session, settings, onChange }: Props<ChannelMixerSettings> & { session: EditorSession }) {
  const t = controller.t;
  const [, refresh] = useState(0);
  const chosen = mixerOutputs.get(session) ?? 'red';
  const output: MixerOutput = settings.monochrome ? 'gray' : chosen === 'gray' ? 'red' : chosen;
  const channel = settings[output];
  const set = (patch: Partial<ChannelMixerChannel>) => onChange({ ...settings, [output]: { ...channel, ...patch } });
  const total = channel.red + channel.green + channel.blue;
  const defaults = defaultChannelMixer();
  const hint = t('Double-click the name to reset');
  return (
    <>
      <div className={styles.panelRow}>
        <span className={styles.panelLabel}>{t('Output Channel')}</span>
        <select className={styles.select} value={output} disabled={settings.monochrome} aria-label={t('Output Channel')} data-testid="mixer-output"
          onChange={(event) => { mixerOutputs.set(session, event.target.value as MixerOutput); refresh((n) => n + 1); }}>
          {settings.monochrome ? <option value="gray">{t('Gray')}</option> : null}
          <option value="red">{t('Red')}</option><option value="green">{t('Green')}</option><option value="blue">{t('Blue')}</option>
        </select>
        <span style={{ flex: 1 }} />
        <Check label={t('Monochrome')} checked={settings.monochrome} testId="mixer-monochrome" onChange={(monochrome) => onChange({ ...settings, monochrome })} />
      </div>
      {(['red', 'green', 'blue'] as const).map((key) => (
        <SliderRow key={key} label={t(key === 'red' ? 'Red' : key === 'green' ? 'Green' : 'Blue')} value={channel[key]} min={-200} max={200} suffix="%"
          testId={`mixer-${key}`} title={hint} onReset={() => set({ [key]: defaults[output][key] })} onChange={(value) => set({ [key]: value })} />
      ))}
      <div className={styles.panelRow}>
        <span className={styles.panelLabel}>{t('Total')}</span>
        <span className={`${local.total} ${total > 100 ? local.totalWarning : ''}`} data-testid="mixer-total"
          title={total > 100 ? t('Above 100 % the channel can clip') : undefined}>{`${total > 100 ? '⚠ ' : ''}${total} %`}</span>
      </div>
      <SliderRow label={t('Constant')} value={channel.constant} min={-200} max={200} suffix="%" testId="mixer-constant" title={hint}
        onReset={() => set({ constant: 0 })} onChange={(constant) => set({ constant })} />
      <Footer controller={controller} onReset={() => onChange(defaults)} />
    </>
  );
}

// MARK: Invert, Threshold, Posterize, Brightness/Contrast

export function ThresholdControls({ controller, level, histogram, onChange }: {
  controller: EditorController; level: number; histogram: readonly Float64Array[] | null; onChange: (level: number) => void;
}) {
  const t = controller.t;
  return (
    <>
      <div className={styles.histogramBox}>
        <Histogram bins={histogram?.[0] ?? null} color="#9a9a9a" label={t('Histogram')} hint={t('Histogram of the pixels under this layer')} />
        {!histogram ? <span className={styles.histogramLoading}>{t('Loading histogram…')}</span> : null}
        <span className={local.thresholdMarker} style={{ left: `${level / 255 * 100}%` }} aria-hidden />
      </div>
      <SliderRow label={t('Threshold Level')} value={level} min={1} max={255} testId="threshold-level" labelWidth={104} title={t('Double-click the name to reset')}
        onReset={() => onChange(128)} onChange={(value) => onChange(Math.round(value))} />
    </>
  );
}

export function BrightnessContrastControls({ controller, settings, onChange }: Props<BrightnessContrastSettings>) {
  const t = controller.t;
  const hint = t('Double-click the name to reset');
  return (
    <>
      <SliderRow label={t('Brightness')} value={settings.brightness} min={-150} max={150} testId="bc-brightness" title={hint}
        onReset={() => onChange({ ...settings, brightness: 0 })} onChange={(brightness) => onChange({ ...settings, brightness })} />
      <SliderRow label={t('Contrast')} value={settings.contrast} min={settings.legacy ? -100 : -50} max={100} testId="bc-contrast" title={hint}
        onReset={() => onChange({ ...settings, contrast: 0 })} onChange={(contrast) => onChange({ ...settings, contrast })} />
      <Footer controller={controller} onReset={() => onChange(defaultBrightnessContrast())}>
        <Check label={t('Use Legacy')} checked={settings.legacy} testId="bc-legacy"
          onChange={(legacy) => onChange({ ...settings, legacy, contrast: legacy ? settings.contrast : Math.max(-50, settings.contrast) })} />
      </Footer>
    </>
  );
}

/** The body of a Phase-2 adjustment layer's panel. */
export function P2AdjustmentControls({ controller, session, value, onChange, histogram, sample }: {
  controller: EditorController; session: EditorSession; value: LayerAdjustment; onChange: (value: LayerAdjustment) => void;
  histogram: readonly Float64Array[] | null; sample: () => Uint8Array | null;
}) {
  const t = controller.t;
  const set = useMemo(() => <K extends LayerAdjustment['kind']>(kind: K) =>
    (parameters: Extract<LayerAdjustment, { kind: K }>['parameters']) => onChange({ kind, schemaVersion: 1, parameters } as LayerAdjustment), [onChange]);
  switch (value.kind) {
    case 'Basic': return <BasicControls controller={controller} settings={value.parameters} onChange={set('Basic')} />;
    case 'Colour Lookup': return <ColourLookupControls controller={controller} session={session} settings={value.parameters} onChange={set('Colour Lookup')} />;
    case 'Colour': return <ColourControls controller={controller} session={session} settings={value.parameters} onChange={set('Colour')} sample={sample} />;
    case 'Photo Filter': return <PhotoFilterControls controller={controller} settings={value.parameters} onChange={set('Photo Filter')} />;
    case 'Channel Mixer': return <ChannelMixerControls controller={controller} session={session} settings={value.parameters} onChange={set('Channel Mixer')} />;
    case 'Threshold': return <ThresholdControls controller={controller} level={value.parameters.level} histogram={histogram}
      onChange={(level) => onChange({ ...value, parameters: { level } })} />;
    case 'Posterize': return (
      <SliderRow label={t('Levels')} value={value.parameters.levels} min={2} max={255} testId="posterize-levels" title={t('Double-click the name to reset')}
        onReset={() => onChange({ ...value, parameters: { levels: 4 } })} onChange={(levels) => onChange({ ...value, parameters: { levels: Math.round(levels) } })} />
    );
    case 'Brightness/Contrast': return <BrightnessContrastControls controller={controller} settings={value.parameters} onChange={set('Brightness/Contrast')} />;
    case 'Invert': return <p className={styles.panelNote}>{t('Invert has no settings: it turns every color into its opposite. Use the layer’s opacity or mask to limit it.')}</p>;
    default: return null;
  }
}
