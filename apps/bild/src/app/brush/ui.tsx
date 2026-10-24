/**
 * Brush preset picker (popover from the brush context bar) and the Brush Settings panel (PRODUCT-PLAN 6.3), with
 * Photoshop's keys: , and . step through presets (Shift: first/last), F5 toggles Brush Settings. `[`/`]` and
 * Shift-`[`/`]` stay in paintingFeature.
 */

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import editor from '../../ui/editor.module.css';
import css from './brush.module.css';
import type { EditorController } from '../../ui/controller';
import type { EditorSession } from '../../core/session';
import { useSession } from '../../ui/hooks';
import { Icon } from '../../ui/icons';
import { MenuPopup } from '../../ui/TopBar';
import type { MenuEntry } from '../../ui/menus';
import { FloatingPanel } from '../panels';
import { Check } from '../adjustmentsFeature';
import { NumberField } from '../../ui/ContextBar';
import { useAnchoredPopover } from '../../ui/popovers';
import { getBrushSettings, isBrushStrokeActive, setBrushSettings } from '../../core/brush/commands';
import type { BrushSettings } from '../../core/brush/settings';
import { DEFAULT_BRUSH_DYNAMICS, type BrushDynamics, type BrushTip, type PenControl } from '../../core/brush/tip';
import {
  MAX_PRESET_NAME, presetFromSettings, presetsFromAbr, settingsMatchPreset, type BrushPreset,
} from '../../core/brush/presets';
import { parseAbr } from '../../io/abr';
import { uuid } from '../../core/ids';
import { brushState, choosePreset, presetScope, stepPreset, type BrushAppState, type PresetScope } from './state';
import { drawStrokePreview, drawTipThumbnail, presetLook, requestPreview, type PreviewImage } from './previews';

function useBrushState(controller: EditorController): BrushAppState {
  const store = brushState(controller);
  return useSyncExternalStore(store.subscribe, store.getState);
}

const ROUND: BrushTip = { kind: 'round', angle: 0, roundness: 1 };
const brushTools = (session: EditorSession) => session.tool === 'brush' || session.tool === 'cloneStamp';

function previewColour(controller: EditorController): [number, number, number] {
  return controller.theme === 'light' ? [34, 34, 34] : [232, 232, 232];
}

/** Draws a cached preview, computing it off the input path when it is new. */
function PreviewCanvas({ owner, previewKey, draw, width, height, className, testId }: {
  owner: object; previewKey: string; draw: () => PreviewImage; width: number; height: number; className?: string; testId?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [image, setImage] = useState<PreviewImage | null>(null);
  useEffect(() => {
    let live = true;
    const cached = requestPreview(owner, previewKey, draw, (ready) => { if (live) setImage(ready); });
    setImage(cached);
    return () => { live = false; };
  }, [owner, previewKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas || !image) return;
    canvas.width = image.width; canvas.height = image.height;
    canvas.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
  }, [image]);
  return <canvas ref={ref} className={className} width={width} height={height} data-testid={testId} data-ready={image ? 'true' : 'false'} />;
}

function TipThumbnail({ controller, tip, hardness, size, className }: { controller: EditorController; tip: BrushTip; hardness: number; size: number; className?: string }) {
  const rgb = previewColour(controller);
  return <PreviewCanvas owner={tip} previewKey={`tip:${size}:${hardness}:${rgb.join(',')}`} width={size} height={size} className={className}
    draw={() => drawTipThumbnail(tip, hardness, size, rgb)} />;
}

// MARK: File choice

async function chooseAbr(controller: EditorController): Promise<{ name: string; bytes: Uint8Array } | null> {
  const files = controller.capabilities.files;
  if (files?.readFile) {
    const reference = (await files.chooseFiles('brushes'))[0];
    if (!reference) return null;
    const blob = await files.readFile(reference);
    return { name: reference.name, bytes: new Uint8Array(await blob.arrayBuffer()) };
  }
  const file = await new Promise<File | null>((resolve) => {
    const input = globalThis.document.createElement('input');
    input.type = 'file';
    input.accept = '.abr,.ABR';
    input.style.display = 'none';
    input.addEventListener('change', () => { resolve(input.files?.[0] ?? null); input.remove(); });
    input.addEventListener('cancel', () => { resolve(null); input.remove(); });
    globalThis.document.body.append(input);
    input.click();
  });
  return file ? { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) } : null;
}

// MARK: Picker

type Message = { text: string; error?: boolean } | null;

function BrushPresetPicker({ controller, session, anchor, close }: {
  controller: EditorController; session: EditorSession; anchor: React.RefObject<HTMLElement | null>; close: () => void;
}) {
  const t = controller.t;
  const state = useBrushState(controller);
  const panel = useRef<HTMLDivElement>(null);
  const placement = useAnchoredPopover(true, anchor, 372);
  const [query, setQuery] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuEntry[] } | null>(null);
  const [message, setMessage] = useState<Message>(null);
  const scope = state.scope;
  const { presets, editable, update } = presetScope(controller, scope);
  const settings = getBrushSettings(session);
  const selected = presets.find((preset) => settingsMatchPreset(settings, preset)) ?? null;
  const needle = query.trim().toLocaleLowerCase();
  const visible = needle ? presets.filter((preset) => t(preset.name).toLocaleLowerCase().includes(needle)
    || preset.name.toLocaleLowerCase().includes(needle)) : presets;

  useEffect(() => {
    const down = (event: PointerEvent) => {
      const target = event.target as Element;
      if (panel.current?.contains(target) || anchor.current?.contains(target) || target.closest?.('[data-menu-popup]')) return;
      close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || menu || renaming) return;
      event.stopPropagation(); close();
    };
    globalThis.addEventListener('pointerdown', down, true);
    globalThis.addEventListener('keydown', key, true);
    return () => { globalThis.removeEventListener('pointerdown', down, true); globalThis.removeEventListener('keydown', key, true); };
  }, [close, anchor, menu, renaming]);
  useEffect(() => { setMessage(null); setRenaming(null); }, [scope]);

  const pick = (preset: BrushPreset) => { choosePreset(controller, session, preset); };
  const addCurrent = () => {
    const count = presets.length + 1;
    const created = presetFromSettings(getBrushSettings(session), `${t('Brush Preset')} ${count}`);
    if (update('New Brush Preset', (list) => [...list, created])) {
      brushState(controller).setState({ activeId: created.id });
      setRenaming({ id: created.id, value: created.name });
    }
  };
  const remove = (id: string) => update('Delete Brush Preset', (list) => list.filter((preset) => preset.id !== id));
  const commitRename = () => {
    if (!renaming) return;
    const value = renaming.value.trim().slice(0, MAX_PRESET_NAME);
    if (value) update('Rename Brush Preset', (list) => list.map((preset) => (preset.id === renaming.id ? { ...preset, name: value } : preset)));
    setRenaming(null);
  };
  const copyTo = (preset: BrushPreset) => {
    const other = presetScope(controller, scope === 'library' ? 'document' : 'library');
    other.update(scope === 'library' ? 'Copy Brush Preset to Document' : 'Copy Brush Preset', (list) => [...list, { ...preset, id: uuid() }]);
  };
  const importFile = async () => {
    try {
      const file = await chooseAbr(controller);
      if (!file) return;
      const result = parseAbr(file.bytes);
      const imported = presetsFromAbr(result, file.name.replace(/\.abr$/i, '') || t('Brush'));
      if (!imported.length) throw new Error('empty');
      update('Import Brushes', (list) => [...list, ...imported]);
      choosePreset(controller, session, imported[0]!);
      const notes = [t('Imported {count} brushes.').replace('{count}', String(imported.length))];
      if (result.skipped) notes.push(t('{skipped} brushes could not be read.').replace('{skipped}', String(result.skipped)));
      setMessage({ text: notes.join(' ') });
    } catch {
      setMessage({ text: t('This file is not a usable .abr brush file.'), error: true });
    }
  };
  const itemsFor = (preset: BrushPreset | null): MenuEntry[] => [
    { label: t('Import Brushes…'), enabled: editable, run: () => void importFile(), testId: 'brush-presets-import' },
    { label: t('New Brush Preset'), enabled: editable, run: addCurrent },
    'separator',
    { label: t('Rename Brush Preset…'), enabled: editable && !!preset, run: () => preset && setRenaming({ id: preset.id, value: t(preset.name) }), testId: 'brush-preset-rename' },
    { label: t(scope === 'library' ? 'Copy to Document' : 'Copy to Library'), enabled: !!preset && presetScope(controller, scope === 'library' ? 'document' : 'library').editable,
      run: () => preset && copyTo(preset), testId: 'brush-preset-copy' },
    { label: t('Delete Brush Preset'), enabled: editable && !!preset, run: () => preset && remove(preset.id), testId: 'brush-preset-delete-item' },
  ];

  let body: ReactNode;
  if (scope === 'document' && !session.document) body = <span className={css.empty}>{t('Open a document to keep brush presets with it.')}</span>;
  else if (!presets.length) body = <span className={css.empty}>{t('No brush presets yet')}</span>;
  else if (!visible.length) body = <span className={css.empty}>{t('No matching brushes')}</span>;
  else body = visible.map((preset) => {
    const name = t(preset.name);
    return (
      <div key={preset.id} role="option" tabIndex={0} aria-selected={preset === selected} aria-label={name} title={`${name} · ${preset.diameter} px`}
        className={`${css.tile} ${preset === selected ? css.tileOn : ''}`} data-testid="brush-preset" data-name={preset.name}
        onClick={() => pick(preset)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); pick(preset); } }}
        onDoubleClick={() => editable && setRenaming({ id: preset.id, value: name })}
        onContextMenu={(event) => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, items: itemsFor(preset).slice(3) }); }}>
        <div className={css.tileArt}>
          <TipThumbnail controller={controller} tip={preset.tip} hardness={preset.hardness} size={30} className={css.tileTip} />
          <PreviewCanvas owner={preset} previewKey={`stroke:${previewColour(controller).join(',')}`} width={140} height={68}
            className={css.tileStroke} testId="brush-preset-stroke" draw={() => drawStrokePreview(presetLook(preset), 140, 68, previewColour(controller))} />
        </div>
        {renaming?.id === preset.id ? (
          <input autoFocus className={css.renameInput} value={renaming.value} aria-label={t('Name')} maxLength={MAX_PRESET_NAME} data-testid="brush-preset-name-input"
            onClick={(event) => event.stopPropagation()} onChange={(event) => setRenaming({ ...renaming, value: event.target.value })}
            onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Enter') commitRename(); if (event.key === 'Escape') setRenaming(null); }}
            onBlur={commitRename} />
        ) : <span className={css.tileName}><span>{name}</span><span className={css.tileSize}>{preset.diameter}</span></span>}
      </div>
    );
  });

  if (!placement) return null;
  return createPortal(
    <div ref={panel} className={css.popover} style={placement.style} role="dialog" aria-label={t('Brush Presets')} data-testid="brush-presets"
      onKeyDown={(event) => event.stopPropagation()}>
      <div className={css.popoverHeader}>
        <p className={css.popoverTitle}>{t('Brush Presets')}</p>
        <div className={editor.segmented} role="radiogroup" aria-label={t('Brush Presets')}>
          {(['library', 'document'] as const).map((value: PresetScope) => (
            <button key={value} type="button" role="radio" aria-checked={scope === value} data-testid={`brush-presets-scope-${value}`}
              className={`${editor.segment} ${scope === value ? editor.segmentOn : ''}`} style={{ padding: '0 8px' }}
              onClick={() => brushState(controller).setState({ scope: value })}>{t(value === 'library' ? 'Library' : 'Document')}</button>
          ))}
        </div>
      </div>
      <label className={css.search}>
        <Icon name="search" size={13} />
        <input value={query} placeholder={t('Search brushes')} aria-label={t('Search brushes')} data-testid="brush-presets-search"
          onChange={(event) => setQuery(event.target.value)} />
      </label>
      <div className={css.grid} role="listbox" aria-label={t('Brush Presets')}>{body}</div>
      {message ? <p className={`${css.status} ${message.error ? css.statusError : ''}`} role="status" data-testid="brush-presets-message">{message.text}</p> : null}
      <div className={css.footer}>
        <button type="button" className={editor.footerButton} aria-label={t('New Brush Preset')} title={t('New Brush Preset')} disabled={!editable}
          data-testid="brush-preset-new" onClick={addCurrent}><Icon name="plusSquare" size={16} /></button>
        <button type="button" className={editor.footerButton} aria-label={t('Import Brushes…')} title={t('Import Brushes…')} disabled={!editable}
          data-testid="brush-presets-import-button" onClick={() => void importFile()}><Icon name="folder" size={16} /></button>
        <button type="button" className={editor.footerButton} aria-label={t('Brush preset options')} title={t('Brush preset options')} aria-haspopup="menu"
          data-testid="brush-presets-menu" onClick={(event) => { const r = event.currentTarget.getBoundingClientRect(); setMenu({ x: r.left, y: r.top - 170, items: itemsFor(selected) }); }}>
          <Icon name="more" size={16} />
        </button>
        <span className={editor.spacer} />
        <button type="button" className={editor.footerButton} aria-label={t('Delete Brush Preset')} title={t('Delete Brush Preset')}
          disabled={!editable || !selected} data-testid="brush-preset-delete" onClick={() => selected && remove(selected.id)}><Icon name="trash" size={16} /></button>
      </div>
      {menu ? <MenuPopup controller={controller} anchor={{ x: menu.x, y: menu.y }} items={menu.items} onClose={() => setMenu(null)} /> : null}
    </div>, placement.target
  );
}

/** The context-bar button: the current tip and size; opens the picker. Next to it, the Brush Settings toggle. */
export function BrushPresetControls({ controller, session }: { controller: EditorController; session: EditorSession }) {
  const t = controller.t;
  useSession(session);
  const state = useBrushState(controller);
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  if (!brushTools(session)) return null;
  const settings = getBrushSettings(session);
  const tip = settings.tip ?? ROUND;
  return (
    <>
      <button ref={button} type="button" className={`${css.presetButton} ${open ? css.presetButtonOpen : ''}`} aria-label={t('Brush Presets')}
        title={t('Brush Presets')} aria-expanded={open} aria-haspopup="dialog" data-testid="brush-preset-button" onClick={() => setOpen(!open)}>
        <TipThumbnail controller={controller} tip={tip} hardness={settings.hardness} size={20} />
        <span className={css.presetButtonSize}>{settings.diameter}</span>
        <Icon name="chevronDown" size={10} />
      </button>
      <button type="button" className={`${editor.iconButton} ${state.settingsOpen ? editor.iconButtonOn : ''}`} aria-label={t('Brush Settings (F5)')}
        title={t('Brush Settings (F5)')} aria-pressed={state.settingsOpen} data-testid="brush-settings-button"
        onClick={() => brushState(controller).setState({ settingsOpen: !state.settingsOpen })}><Icon name="sliders" size={16} /></button>
      {open ? <BrushPresetPicker controller={controller} session={session} anchor={button} close={() => setOpen(false)} /> : null}
    </>
  );
}

// MARK: Brush Settings panel

const pct = (value: number) => Math.round(value * 100);

/** SliderRow's layout (label, slider, exact field) with a fixed field column, so every track in the panel lines up. */
function SettingRow({ label, value, min, max, suffix, onChange, testId, logarithmic = false, disabled = false, lead }: {
  label: string; value: number; min: number; max: number; suffix?: string; onChange: (value: number) => void; testId: string;
  logarithmic?: boolean; disabled?: boolean; lead?: ReactNode;
}) {
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const toSlider = (v: number) => (logarithmic ? Math.log(v) : v);
  return (
    <div className={editor.panelRow}>
      {lead ?? <span className={`${editor.panelLabel} ${css.label}`}>{label}</span>}
      <input type="range" className={editor.slider} aria-label={label} data-testid={`${testId}-slider`} disabled={disabled}
        min={toSlider(min)} max={toSlider(max)} step={logarithmic ? 'any' : 1} value={toSlider(clamp(value))}
        onChange={(event) => { const v = Number(event.target.value); onChange(clamp(Math.round(logarithmic ? Math.exp(v) : v))); }} />
      <span className={css.field}>
        <NumberField label="" value={value} suffix={suffix} width={48} testId={testId} disabled={disabled} onChange={(v) => onChange(clamp(Math.round(v)))} />
      </span>
    </div>
  );
}

function ControlSelect({ label, value, onChange, testId, t, allowOff = true }: {
  label: string; value: PenControl; onChange: (value: PenControl) => void; testId: string; t: (text: string) => string; allowOff?: boolean;
}) {
  return (
    <div className={editor.panelRow}>
      <span className={`${editor.panelLabel} ${css.label}`}>{label}</span>
      <select className={editor.select} value={value} aria-label={label} data-testid={testId} onChange={(event) => onChange(event.target.value as PenControl)}>
        {allowOff ? <option value="off">{t('Off')}</option> : null}
        <option value="pressure">{t('Pen Pressure')}</option>
        <option value="tilt">{t('Pen Tilt')}</option>
      </select>
    </div>
  );
}

function BrushSettingsPanel({ controller }: { controller: EditorController }) {
  const t = controller.t;
  const state = useBrushState(controller);
  const session = useSession(controller.session);
  if (!state.settingsOpen || !brushTools(session)) return null;
  const settings = getBrushSettings(session);
  const tip = settings.tip ?? ROUND;
  const dynamics = settings.dynamics ?? DEFAULT_BRUSH_DYNAMICS;
  const editable = !isBrushStrokeActive(session);
  const set = (patch: Partial<BrushSettings>) => { if (editable) setBrushSettings(session, { ...getBrushSettings(session), ...patch }); };
  const setTip = (patch: Partial<{ angle: number; roundness: number }>) => set({ tip: { ...tip, ...patch } as BrushTip });
  const setDynamics = (patch: Partial<BrushDynamics>) => set({ dynamics: { ...dynamics, ...patch } });
  const rgb = previewColour(controller);
  return (
    <FloatingPanel name="brushSettings" title={t('Brush Settings')} onClose={() => brushState(controller).setState({ settingsOpen: false })}
      closeLabel={t('Close')} testId="brush-settings" className={css.settings}>
      <section className={css.section} aria-label={t('Brush Tip Shape')}>
        <p className={css.sectionTitle}>{t('Brush Tip Shape')}</p>
        <SettingRow label={t('Size')} value={settings.diameter} min={1} max={2000} logarithmic suffix="px" testId="brush-size"
          onChange={(diameter) => set({ diameter: Math.round(diameter) })} />
        {tip.kind === 'round' ? <SettingRow label={t('Hardness')} value={pct(settings.hardness)} min={0} max={100} suffix="%" testId="brush-hardness"
          onChange={(value) => set({ hardness: value / 100 })} /> : null}
        <SettingRow label={t('Angle')} value={tip.angle} min={-180} max={180} suffix="°" testId="brush-angle" onChange={(angle) => setTip({ angle })} />
        <SettingRow label={t('Roundness')} value={pct(tip.roundness)} min={1} max={100} suffix="%" testId="brush-roundness"
          onChange={(value) => setTip({ roundness: value / 100 })} />
        {/* Photoshop: the Spacing checkbox sits in the row; off paints a smooth stroke. */}
        <SettingRow label={t('Spacing')} value={pct(dynamics.spacing ?? 0.25)} min={1} max={1000} logarithmic suffix="%" testId="brush-spacing"
          disabled={dynamics.spacing === null} onChange={(value) => setDynamics({ spacing: value / 100 })}
          lead={<span className={`${editor.panelLabel} ${css.label}`} title={dynamics.spacing === null ? t('Smooth when off') : undefined}>
            <Check label={t('Spacing')} checked={dynamics.spacing !== null} testId="brush-spacing-enabled"
              onChange={(on) => setDynamics({ spacing: on ? 0.25 : null })} />
          </span>} />
        <SettingRow label={t('Flow')} value={pct(dynamics.flow)} min={1} max={100} suffix="%" testId="brush-flow-dynamics"
          onChange={(value) => setDynamics({ flow: value / 100 })} />
      </section>
      <section className={css.section} aria-label={t('Shape Dynamics')}>
        <p className={css.sectionTitle}>{t('Shape Dynamics')}</p>
        <SettingRow label={t('Size Jitter')} value={pct(dynamics.sizeJitter)} min={0} max={100} suffix="%" testId="brush-size-jitter"
          onChange={(value) => setDynamics({ sizeJitter: value / 100 })} />
        <ControlSelect label={t('Control')} value={dynamics.sizeControl} testId="brush-size-control" t={t} onChange={(sizeControl) => setDynamics({ sizeControl })} />
        {dynamics.sizeControl !== 'off' ? <SettingRow label={t('Minimum Diameter')} value={pct(dynamics.minimumDiameter)} min={0} max={100} suffix="%"
          testId="brush-minimum-diameter" onChange={(value) => setDynamics({ minimumDiameter: value / 100 })} /> : null}
        <SettingRow label={t('Angle Jitter')} value={pct(dynamics.angleJitter)} min={0} max={100} suffix="%" testId="brush-angle-jitter"
          onChange={(value) => setDynamics({ angleJitter: value / 100 })} />
      </section>
      <section className={css.section} aria-label={t('Scattering')}>
        <p className={css.sectionTitle}>{t('Scattering')}</p>
        <SettingRow label={t('Scatter')} value={pct(dynamics.scatter)} min={0} max={1000} suffix="%" testId="brush-scatter"
          onChange={(value) => setDynamics({ scatter: value / 100 })} />
        <div className={editor.panelRow}>
          <Check label={t('Both Axes')} checked={dynamics.scatterBothAxes} testId="brush-scatter-both" onChange={(scatterBothAxes) => setDynamics({ scatterBothAxes })} />
        </div>
        <SettingRow label={t('Count')} value={dynamics.count} min={1} max={16} testId="brush-count" onChange={(count) => setDynamics({ count: Math.round(count) })} />
      </section>
      <section className={css.section} aria-label={t('Transfer')}>
        <p className={css.sectionTitle}>{t('Transfer')}</p>
        <SettingRow label={t('Opacity Jitter')} value={pct(dynamics.opacityJitter)} min={0} max={100} suffix="%" testId="brush-opacity-jitter"
          onChange={(value) => setDynamics({ opacityJitter: value / 100 })} />
        <ControlSelect label={t('Control')} value={dynamics.opacityControl} testId="brush-opacity-control" t={t}
          onChange={(opacityControl) => setDynamics({ opacityControl })} />
      </section>
      <PreviewCanvas owner={settings} previewKey={`panel:${rgb.join(',')}`} width={660} height={112} className={css.preview} testId="brush-settings-preview"
        draw={() => drawStrokePreview(settings, 660, 112, rgb)} />
    </FloatingPanel>
  );
}

// MARK: Installation

export function installBrushPresets(controller: EditorController): void {
  controller.panels.push(() => <BrushSettingsPanel controller={controller} />);
  controller.keyHandlers.push((event) => {
    const session = controller.session;
    if (event.metaKey || event.ctrlKey || event.altKey || !brushTools(session)) return false;
    if (event.key === 'F5') {
      const store = brushState(controller);
      store.setState({ settingsOpen: !store.getState().settingsOpen });
      return true;
    }
    if ((event.code === 'Comma' || event.code === 'Period') && !isBrushStrokeActive(session)) {
      return stepPreset(controller, event.code === 'Period', event.shiftKey);
    }
    return false;
  });
}
