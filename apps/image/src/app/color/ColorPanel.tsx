/**
 * The Colour panel (PRODUCT-PLAN 6.4 "Farbe-Panel", 6.1 swatches and recent colours): a side-panel tab next to Layers
 * and History. Foreground/background chips, HSB or RGB sliders, hex, Lab and naive CMYK readouts, the screen
 * eyedropper, the last 12 used colours and the swatch groups of the document and of the app-wide library.
 *
 * Colour edits are live and make no undo step (the palette is app state). Swatch edits in the document scope are
 * document state and undoable; library edits are app state.
 */

import { useEffect, useRef, useState, useSyncExternalStore, type DragEvent, type ReactNode } from 'react';
import editor from '../../ui/editor.module.css';
import styles from './color.module.css';
import type { EditorController } from '../../ui/controller';
import { useSession, useWorkspace } from '../../ui/hooks';
import { Icon } from '../../ui/icons';
import { MenuPopup } from '../../ui/TopBar';
import type { MenuEntry } from '../../ui/menus';
import type { RGB } from '../../core/model/types';
import {
  hsbKeepingHue, hsbToRgb, parseColorText, rgbToCmykNaive, rgbToHex, rgbToHsb, rgbToLab, type HSB,
} from '../../core/color/convert';
import {
  addGroup, addSwatch, appendGroups, canEditDocumentSwatches, deleteGroup, deleteSwatch, documentSwatches, editDocumentSwatches,
  newSwatch, renameGroup, renameSwatch, type SwatchGroup,
} from '../../core/color/swatches';
import { parseSwatchFile, refineCmyk, writeAse } from '../../io/swatchFiles';
import { colorState, type ColorAppState, type SwatchScope } from './state';
import { pickScreenColor, screenPickMethod } from './screenEyedropper';

export const SWATCH_MIME = 'application/x-fernwork-color';

const css = (c: RGB) => `rgb(${Math.round(c.red * 255)},${Math.round(c.green * 255)},${Math.round(c.blue * 255)})`;

export function useColorState(controller: EditorController): ColorAppState {
  const store = colorState(controller);
  return useSyncExternalStore(store.subscribe, store.getState);
}

/**
 * Tool shortcuts must not fire while a slider has focus: EditorRoot listens natively and only skips text fields. Only
 * range inputs are contained — React's own handlers sit above the panel, so text fields must keep bubbling.
 */
function useContainKeys(): (element: HTMLElement | null) => void {
  const cleanup = useRef<(() => void) | null>(null);
  return (element) => {
    cleanup.current?.();
    cleanup.current = null;
    if (!element) return;
    const stop = (event: KeyboardEvent) => { if ((event.target as HTMLInputElement).type === 'range') event.stopPropagation(); };
    element.addEventListener('keydown', stop);
    cleanup.current = () => element.removeEventListener('keydown', stop);
  };
}

function startColorDrag(event: DragEvent, color: RGB): void {
  event.dataTransfer.setData(SWATCH_MIME, JSON.stringify({ red: color.red, green: color.green, blue: color.blue }));
  event.dataTransfer.setData('text/plain', `#${rgbToHex(color)}`);
  event.dataTransfer.effectAllowed = 'copy';
}

/** HSB kept locally so hue survives grays and black while the palette colour (RGB) is the truth. */
function useHsb(color: RGB): [HSB, (next: HSB) => void] {
  const [hsb, setHsb] = useState<HSB>(() => rgbToHsb(color));
  const key = rgbToHex(color);
  useEffect(() => {
    setHsb((current) => (rgbToHex(hsbToRgb(current)) === key ? current : hsbKeepingHue(color, current)));
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return [hsb, setHsb];
}

function SliderRow({ label, name, value, max, track, onChange, disabled, testId, suffix }: {
  label: string; name: string; value: number; max: number; track: string; onChange: (value: number) => void; disabled?: boolean; testId: string; suffix?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = Math.round(value);
  return (
    <div className={styles.sliderRow}>
      <span className={styles.sliderLabel} aria-hidden>{label}</span>
      <input type="range" className={styles.range} min={0} max={max} step={1} value={shown} aria-label={name} data-testid={testId}
        disabled={disabled} style={{ backgroundImage: track }} onChange={(event) => onChange(Number(event.target.value))} />
      <input className={styles.number} inputMode="numeric" aria-label={`${name}${suffix ? ` (${suffix})` : ''}`} disabled={disabled} data-testid={`${testId}-value`}
        value={draft ?? String(shown)}
        onFocus={(event) => event.target.select()}
        onChange={(event) => {
          setDraft(event.target.value);
          const number = Number(event.target.value.replace(',', '.'));
          if (event.target.value.trim() !== '' && Number.isFinite(number)) onChange(Math.min(max, Math.max(0, number)));
        }}
        onBlur={() => setDraft(null)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            onChange(Math.min(max, Math.max(0, shown + (event.shiftKey ? 10 : 1) * (event.key === 'ArrowUp' ? 1 : -1))));
            setDraft(null);
            event.preventDefault();
          } else if (event.key === 'Enter' || event.key === 'Escape') (event.target as HTMLInputElement).blur();
        }} />
    </div>
  );
}

/** HSB or RGB sliders for one colour; shared by the panel. */
export function ColorSliders({ controller, color, onChange, disabled }: { controller: EditorController; color: RGB; onChange: (color: RGB) => void; disabled?: boolean }) {
  const t = controller.t;
  const state = useColorState(controller);
  const [hsb, setHsb] = useHsb(color);
  const setFromHsb = (next: HSB) => { setHsb(next); onChange(hsbToRgb(next)); };
  const stops = (f: (x: number) => RGB, n = 6) => `linear-gradient(to right, ${Array.from({ length: n + 1 }, (_, i) => css(f(i / n))).join(', ')})`;
  const model = state.sliderModel;
  return (
    <>
      <div className={styles.sectionHeader}>
        <div className={editor.segmented} role="radiogroup" aria-label={t('Colour sliders')}>
          {(['hsb', 'rgb'] as const).map((m) => (
            <button key={m} type="button" role="radio" aria-checked={model === m} data-testid={`slider-model-${m}`}
              className={`${editor.segment} ${model === m ? editor.segmentOn : ''}`}
              onClick={() => colorState(controller).setState({ sliderModel: m })}>{m.toUpperCase()}</button>
          ))}
        </div>
      </div>
      {model === 'hsb' ? (
        <>
          <SliderRow label="H" name={t('Hue')} suffix="°" max={360} value={hsb.hue} disabled={disabled} testId="slider-h"
            track={stops((x) => hsbToRgb({ hue: x * 360, saturation: Math.max(0.35, hsb.saturation), brightness: Math.max(0.35, hsb.brightness) }), 12)}
            onChange={(v) => setFromHsb({ ...hsb, hue: v % 360 === 0 && v > 0 ? 359.999 : v })} />
          <SliderRow label="S" name={t('Saturation')} suffix="%" max={100} value={hsb.saturation * 100} disabled={disabled} testId="slider-s"
            track={stops((x) => hsbToRgb({ ...hsb, saturation: x }), 2)} onChange={(v) => setFromHsb({ ...hsb, saturation: v / 100 })} />
          <SliderRow label="B" name={t('Brightness')} suffix="%" max={100} value={hsb.brightness * 100} disabled={disabled} testId="slider-b"
            track={stops((x) => hsbToRgb({ ...hsb, brightness: x }), 2)} onChange={(v) => setFromHsb({ ...hsb, brightness: v / 100 })} />
        </>
      ) : (
        <>
          {(['red', 'green', 'blue'] as const).map((key) => (
            <SliderRow key={key} label={key[0]!.toUpperCase()} name={t(key === 'red' ? 'Red' : key === 'green' ? 'Green' : 'Blue')} max={255}
              value={color[key] * 255} disabled={disabled} testId={`slider-${key[0]}`}
              track={stops((x) => ({ ...color, [key]: x }), 1)}
              onChange={(v) => onChange({ ...color, [key]: v / 255 })} />
          ))}
        </>
      )}
    </>
  );
}

export function HexField({ controller, color, onChange, disabled, testId = 'color-panel-hex' }: {
  controller: EditorController; color: RGB; onChange: (color: RGB) => void; disabled?: boolean; testId?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const parsed = parseColorText(draft);
    setDraft(null);
    if (parsed) onChange(parsed);
  };
  return (
    <label className={styles.hexRow}>
      <span className={styles.readoutLabel}>{controller.t('Hex')}</span>
      <span className={styles.readoutLabel} aria-hidden>#</span>
      <input className={styles.hexInput} value={draft ?? rgbToHex(color)} aria-label={controller.t('Hex')} data-testid={testId} disabled={disabled}
        spellCheck={false} maxLength={7}
        onChange={(event) => setDraft(event.target.value)} onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') { commit(); (event.target as HTMLInputElement).blur(); }
          if (event.key === 'Escape') { setDraft(null); (event.target as HTMLInputElement).blur(); }
        }} />
    </label>
  );
}

/** Lab (D50) and naive CMYK readouts; display only. */
export function ColorReadouts({ controller, color }: { controller: EditorController; color: RGB }) {
  const t = controller.t;
  const lab = rgbToLab(color), cmyk = rgbToCmykNaive(color);
  const cell = (label: string, value: number, testId: string) => (
    <span className={styles.readoutValue} data-testid={testId} title={label}><span className={styles.readoutLabel}>{label}</span> {value}</span>
  );
  return (
    <>
      <div className={styles.readout} aria-label={t('Lab (D50)')}>
        <span className={styles.readoutLabel}>Lab</span>
        {cell('L', Math.round(lab.l), 'lab-l')}{cell('a', Math.round(lab.a), 'lab-a')}{cell('b', Math.round(lab.b), 'lab-b')}
      </div>
      <div className={styles.readout} aria-label="CMYK" title={t('CMYK shown with a naive, uncalibrated conversion (no press profile).')}>
        <span className={styles.readoutLabel}>CMYK</span>
        {cell('C', Math.round(cmyk.c * 100), 'cmyk-c')}{cell('M', Math.round(cmyk.m * 100), 'cmyk-m')}
        {cell('Y', Math.round(cmyk.y * 100), 'cmyk-y')}{cell('K', Math.round(cmyk.k * 100), 'cmyk-k')}
      </div>
      <p className={styles.note}>CMYK: {t('naive, uncalibrated')}</p>
    </>
  );
}

/** The screen eyedropper button; `onCanvas` is called when only the canvas can be sampled here. */
export function ScreenEyedropperButton({ controller, onColor, onCanvas, onWaiting, testId }: {
  controller: EditorController; onColor: (color: RGB) => void; onCanvas: () => void; onWaiting?: (waiting: boolean) => void; testId: string;
}) {
  const t = controller.t;
  const method = screenPickMethod(controller.capabilities);
  const label = method === 'canvas' ? t('Pick a color from the canvas') : t('Pick a color from the screen');
  return (
    <button type="button" className={styles.miniButton} aria-label={label} title={`${t('Eyedropper')} — ${label}`} data-testid={testId} data-method={method}
      onClick={() => {
        onWaiting?.(method === 'host');
        void pickScreenColor(controller.capabilities).then((result) => {
          onWaiting?.(false);
          if (result === 'canvas') onCanvas();
          else if (result) onColor(result);
        }, (error: unknown) => { onWaiting?.(false); controller.reportError('eyedropper-failed', error); });
      }}>
      <Icon name="eyedropper" size={15} />
    </button>
  );
}

export function RecentColors({ controller, onPick, testId = 'recent-colors' }: { controller: EditorController; onPick: (color: RGB, background: boolean) => void; testId?: string }) {
  const t = controller.t;
  const { recent } = useColorState(controller);
  if (!recent.length) return <span className={styles.empty} data-testid={`${testId}-empty`}>{t('No colors used yet')}</span>;
  return (
    <div className={styles.grid} role="list" aria-label={t('Recent Colors')} data-testid={testId}>
      {recent.map((color, index) => (
        <button key={`${rgbToHex(color)}-${index}`} type="button" role="listitem" className={styles.swatch} style={{ background: css(color) }}
          title={`#${rgbToHex(color)}`} aria-label={`#${rgbToHex(color)}`} data-testid="recent-color" data-hex={rgbToHex(color)} draggable
          onDragStart={(event) => startColorDrag(event, color)}
          onClick={(event) => onPick(color, event.altKey)} />
      ))}
    </div>
  );
}

// MARK: Panel

export function ColorPanel({ controller }: { controller: EditorController }) {
  useWorkspace(controller);
  const session = useSession(controller.session);
  const t = controller.t;
  const state = useColorState(controller);
  const store = colorState(controller);
  const containKeys = useContainKeys();
  const [waiting, setWaiting] = useState(false);
  const background = state.target === 'background';
  const color = session.paletteColor(background);
  const fg = session.paletteColor(false), bg = session.paletteColor(true);
  const disabled = !session.canEditPalette || session.isMaskSelected;
  const apply = (next: RGB) => session.setPaletteColor(next, background);
  const setTarget = (target: 'foreground' | 'background') => {
    // Photoshop: clicking the chip that is already selected opens the Color Picker.
    if (state.target === target) controller.openColorPicker?.(target === 'background');
    else store.setState({ target });
  };
  const pick = (next: RGB, toBackground: boolean) => { if (session.canEditPalette) session.setPaletteColor(next, toBackground); };
  return (
    <div className={styles.panel} ref={containKeys} data-testid="color-panel">
      <section className={styles.section} aria-label={t('Color')}>
        <div className={styles.chipsRow}>
          <div className={styles.chips}>
            <button type="button" className={`${styles.chip} ${styles.chipBack} ${background ? styles.chipTarget : ''}`} style={{ background: css(bg) }}
              aria-label={t('Background color')} aria-pressed={background} title={t('Background color')} data-testid="color-panel-bg"
              data-hex={rgbToHex(bg)} onClick={() => setTarget('background')} />
            <button type="button" className={`${styles.chip} ${styles.chipFront} ${!background ? styles.chipTarget : ''}`} style={{ background: css(fg) }}
              aria-label={t('Foreground color')} aria-pressed={!background} title={t('Foreground color')} data-testid="color-panel-fg"
              data-hex={rgbToHex(fg)} onClick={() => setTarget('foreground')} />
          </div>
          <button type="button" className={styles.miniButton} aria-label={t('Swap colors')} title={`${t('Swap colors')} (X)`}
            onClick={() => session.swapPaletteColors()}><Icon name="swap" size={12} /></button>
          <button type="button" className={styles.miniButton} aria-label={t('Default colors')} title={`${t('Default colors')} (D)`}
            onClick={() => session.resetPaletteColors()}><Icon name="reset" size={11} /></button>
          <span className={editor.spacer} />
          <ScreenEyedropperButton controller={controller} testId="color-panel-eyedropper" onWaiting={setWaiting}
            onColor={(c) => apply(c)} onCanvas={() => store.setState({ canvasPickArmed: true })} />
        </div>
        {waiting ? <p className={styles.status} role="status">{t('Click anywhere on the screen to sample · Right-click or Escape cancels')}</p> : null}
        {state.canvasPickArmed ? <p className={styles.status} role="status" data-testid="canvas-pick-armed">{t('Click the canvas to sample')}</p> : null}
        <ColorSliders controller={controller} color={color} onChange={apply} disabled={disabled} />
        <HexField controller={controller} color={color} onChange={apply} disabled={disabled} />
        <ColorReadouts controller={controller} color={color} />
        {session.isMaskSelected ? <p className={styles.note}>{t('Masks use black and white only.')}</p> : null}
      </section>
      <section className={styles.section} aria-label={t('Recent Colors')}>
        <div className={styles.sectionHeader}><span className={styles.sectionTitle}>{t('Recent Colors')}</span></div>
        <RecentColors controller={controller} onPick={pick} />
      </section>
      <SwatchesSection controller={controller} onPick={pick} />
    </div>
  );
}

// MARK: Swatches

type Renaming = { kind: 'swatch' | 'group'; id: string; value: string };

function chooseSwatchFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = globalThis.document.createElement('input');
    input.type = 'file';
    input.accept = '.aco,.ase,.ACO,.ASE';
    input.style.display = 'none';
    input.addEventListener('change', () => { resolve(input.files?.[0] ?? null); input.remove(); });
    input.addEventListener('cancel', () => { resolve(null); input.remove(); });
    globalThis.document.body.append(input);
    input.click();
  });
}

/** Groups of the chosen scope and how to change them (document: undo step; library: app state). */
export function useSwatchScope(controller: EditorController, scope: SwatchScope): {
  groups: readonly SwatchGroup[]; editable: boolean; update: (stepName: string, change: (groups: readonly SwatchGroup[]) => readonly SwatchGroup[]) => boolean;
} {
  const session = controller.session;
  const state = colorState(controller).getState();
  if (scope === 'document') {
    return { groups: documentSwatches(session), editable: canEditDocumentSwatches(session),
      update: (stepName, change) => editDocumentSwatches(session, stepName, change) };
  }
  return { groups: state.library, editable: true, update: (_stepName, change) => {
    const next = change(colorState(controller).getState().library);
    colorState(controller).setState({ library: next });
    return true;
  } };
}

function SwatchesSection({ controller, onPick }: { controller: EditorController; onPick: (color: RGB, background: boolean) => void }) {
  const session = useSession(controller.session);
  const t = controller.t;
  const state = useColorState(controller);
  const scope = state.scope;
  const { groups, editable, update } = useSwatchScope(controller, scope);
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const [selectedSwatch, setSelectedSwatch] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<Renaming | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuEntry[] } | null>(null);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const group = groups.find((g) => g.id === selectedGroup) ?? groups[0] ?? null;
  const swatch = groups.flatMap((g) => g.swatches).find((s) => s.id === selectedSwatch) ?? null;

  useEffect(() => { setSelectedSwatch(null); setRenaming(null); setMessage(null); }, [scope]);

  const addCurrent = () => {
    const fg = session.paletteColor(false);
    const count = groups.reduce((sum, g) => sum + g.swatches.length, 0);
    const created = newSwatch(fg, `${t('Swatch')} ${count + 1}`);
    if (update('New Swatch', (list) => addSwatch(list, group?.id ?? null, created, t('Swatches')).groups)) setSelectedSwatch(created.id);
  };
  const addNewGroup = () => {
    let id = '';
    if (update('New Swatch Group', (list) => { const result = addGroup(list, `${t('Group')} ${list.length + 1}`); id = result.id; return result.groups; })) {
      setSelectedGroup(id);
      setRenaming({ kind: 'group', id, value: `${t('Group')} ${groups.length + 1}` });
    }
  };
  const removeSwatch = (id: string) => { update('Delete Swatch', (list) => deleteSwatch(list, id)); if (selectedSwatch === id) setSelectedSwatch(null); };
  const commitRename = () => {
    if (!renaming) return;
    const value = renaming.value.trim();
    if (value) update(renaming.kind === 'swatch' ? 'Rename Swatch' : 'Rename Swatch Group',
      (list) => (renaming.kind === 'swatch' ? renameSwatch(list, renaming.id, value) : renameGroup(list, renaming.id, value)));
    setRenaming(null);
  };
  const importFile = async () => {
    const file = await chooseSwatchFile();
    if (!file) return;
    try {
      const base = file.name.replace(/\.(aco|ase)$/i, '') || t('Swatches');
      const parsed = await refineCmyk(parseSwatchFile(new Uint8Array(await file.arrayBuffer()), base));
      const count = parsed.groups.reduce((sum, g) => sum + g.swatches.length, 0);
      if (!count) throw new Error('empty');
      update('Import Swatches', (list) => appendGroups(list, parsed.groups));
      const notes = [t('Imported {count} swatches.').replace('{count}', String(count))];
      if (parsed.skipped) notes.push(t('{skipped} book colours without colour values were skipped.').replace('{skipped}', String(parsed.skipped)));
      if (parsed.approximated) notes.push(t('CMYK swatches were converted with the generic, uncalibrated CMYK profile.'));
      setMessage({ text: notes.join(' ') });
    } catch {
      setMessage({ text: t('This file is not a usable .aco or .ase swatch file.'), error: true });
    }
  };
  const exportFile = () => {
    const bytes = writeAse(groups);
    const name = scope === 'document' ? (session.projectName ?? controller.workspace.current.title ?? t('Swatches')) : t('Swatches');
    void controller.host.saveFile(new Blob([bytes as BlobPart], { type: 'application/octet-stream' }), `${name}.ase`)
      .catch((error: unknown) => controller.reportError('save-failed', error));
  };
  const moreItems = (): MenuEntry[] => [
    { label: t('Import Swatches…'), enabled: editable, run: () => void importFile(), testId: 'swatches-import' },
    { label: t('Export Swatches (.ase)…'), enabled: groups.some((g) => g.swatches.length > 0), run: exportFile, testId: 'swatches-export' },
    'separator',
    { label: t('Rename Group…'), enabled: editable && !!group, run: () => group && setRenaming({ kind: 'group', id: group.id, value: group.name }) },
    { label: t('Delete Group'), enabled: editable && !!group, run: () => group && update('Delete Swatch Group', (list) => deleteGroup(list, group.id)) },
  ];
  const swatchItems = (id: string, name: string): MenuEntry[] => [
    { label: t('Rename Swatch…'), enabled: editable, run: () => setRenaming({ kind: 'swatch', id, value: name }) },
    { label: t('Delete Swatch'), enabled: editable, run: () => removeSwatch(id) },
  ];

  let body: ReactNode;
  if (scope === 'document' && !session.document) body = <span className={styles.empty}>{t('Open a document to keep swatches with it.')}</span>;
  else if (!groups.length) body = <span className={styles.empty} data-testid="swatches-empty">{t('No swatches yet')}</span>;
  else body = groups.map((g) => (
    <div key={g.id} className={styles.group} data-testid="swatch-group" data-name={g.name}>
      <button type="button" className={`${styles.groupHeader} ${group?.id === g.id ? styles.groupSelected : ''}`} data-testid="swatch-group-header"
        onClick={() => setSelectedGroup(g.id)} onDoubleClick={() => editable && setRenaming({ kind: 'group', id: g.id, value: g.name })}
        onContextMenu={(event) => { event.preventDefault(); setSelectedGroup(g.id); setMenu({ x: event.clientX, y: event.clientY, items: moreItems().slice(3) }); }}>
        <Icon name="folder" size={12} /><span>{g.name}</span><span className={styles.groupCount}>{g.swatches.length}</span>
      </button>
      <div className={styles.grid} role="list" aria-label={g.name}>
        {g.swatches.map((s) => (
          <button key={s.id} type="button" role="listitem" className={`${styles.swatch} ${selectedSwatch === s.id ? styles.swatchSelected : ''}`}
            style={{ background: css(s.color) }} title={`${s.name} · #${rgbToHex(s.color)}`} aria-label={s.name} data-testid="swatch"
            data-hex={rgbToHex(s.color)} draggable
            onDragStart={(event) => startColorDrag(event, s.color)}
            onClick={(event) => { setSelectedGroup(g.id); setSelectedSwatch(s.id); onPick(s.color, event.altKey); }}
            onDoubleClick={() => editable && setRenaming({ kind: 'swatch', id: s.id, value: s.name })}
            onContextMenu={(event) => { event.preventDefault(); setSelectedSwatch(s.id); setMenu({ x: event.clientX, y: event.clientY, items: swatchItems(s.id, s.name) }); }} />
        ))}
      </div>
    </div>
  ));

  return (
    <section className={styles.section} aria-label={t('Swatches')} style={{ flex: 1, borderBottom: 0 }} data-testid="swatches">
      <div className={styles.sectionHeader}>
        <span className={styles.sectionTitle}>{t('Swatches')}</span>
        <div className={editor.segmented} role="radiogroup" aria-label={t('Swatches')}>
          {(['document', 'library'] as const).map((s) => (
            <button key={s} type="button" role="radio" aria-checked={scope === s} data-testid={`swatch-scope-${s}`}
              className={`${editor.segment} ${scope === s ? editor.segmentOn : ''}`} style={{ padding: '0 8px' }}
              onClick={() => colorState(controller).setState({ scope: s })}>{t(s === 'document' ? 'Document' : 'Library')}</button>
          ))}
        </div>
      </div>
      {renaming ? (
        <div className={styles.renameRow}>
          <input autoFocus value={renaming.value} aria-label={t('Name')} data-testid="swatch-rename" maxLength={256}
            onChange={(event) => setRenaming({ ...renaming, value: event.target.value })}
            onKeyDown={(event) => { if (event.key === 'Enter') commitRename(); if (event.key === 'Escape') setRenaming(null); }}
            onBlur={commitRename} />
        </div>
      ) : null}
      {body}
      {message ? <p className={styles.status} role="status" data-testid="swatches-message" style={message.error ? { color: 'var(--cmp-danger)' } : undefined}>{message.text}</p> : null}
      <p className={styles.note}>{t('Click: foreground · Alt-click: background · Drag onto a shape or text layer to fill it')}</p>
      <div className={styles.footer}>
        <button type="button" className={editor.footerButton} aria-label={t('New Swatch')} title={t('New Swatch')} disabled={!editable}
          data-testid="swatch-add" onClick={addCurrent}><Icon name="plusSquare" size={16} /></button>
        <button type="button" className={editor.footerButton} aria-label={t('New Group')} title={t('New Group')} disabled={!editable}
          data-testid="swatch-group-add" onClick={addNewGroup}><Icon name="folderPlus" size={16} /></button>
        <button type="button" className={editor.footerButton} aria-label={t('Swatch options')} title={t('Swatch options')} aria-haspopup="menu"
          data-testid="swatch-menu" onClick={(event) => { const r = event.currentTarget.getBoundingClientRect(); setMenu({ x: r.left, y: r.top - 150, items: moreItems() }); }}>
          <Icon name="more" size={16} />
        </button>
        <span className={editor.spacer} />
        <button type="button" className={editor.footerButton} aria-label={t('Delete Swatch')} title={t('Delete Swatch')}
          disabled={!editable || !swatch} data-testid="swatch-delete" onClick={() => swatch && removeSwatch(swatch.id)}><Icon name="trash" size={16} /></button>
      </div>
      {menu ? <MenuPopup controller={controller} anchor={{ x: menu.x, y: menu.y }} items={menu.items} onClose={() => setMenu(null)} /> : null}
    </section>
  );
}

// MARK: Inside the colour picker

/** Readouts, the screen eyedropper, recent colours and swatches inside the app's colour picker. */
export function PickerExtras({ controller, color, set }: { controller: EditorController; color: RGB; set: (color: RGB) => void }) {
  const t = controller.t;
  const state = useColorState(controller);
  useSession(controller.session);
  const [waiting, setWaiting] = useState(false);
  const [canvasHint, setCanvasHint] = useState(false);
  const { groups } = useSwatchScope(controller, state.scope);
  const hsb = rgbToHsb(color);
  const swatches = groups.flatMap((g) => g.swatches).slice(0, 96);
  return (
    <div className={styles.pickerExtras} data-testid="picker-extras">
      <div className={styles.pickerRow}>
        <ScreenEyedropperButton controller={controller} testId="picker-eyedropper" onWaiting={setWaiting} onColor={set} onCanvas={() => setCanvasHint(true)} />
        <span className={styles.readoutValue}><span className={styles.readoutLabel}>H</span> {Math.round(hsb.hue)}°&nbsp;
          <span className={styles.readoutLabel}>S</span> {Math.round(hsb.saturation * 100)}%&nbsp;
          <span className={styles.readoutLabel}>B</span> {Math.round(hsb.brightness * 100)}%</span>
      </div>
      {waiting ? <p className={styles.status} role="status">{t('Click anywhere on the screen to sample · Right-click or Escape cancels')}</p> : null}
      {canvasHint ? <p className={styles.status} role="status">{t('Click the canvas to sample')}</p> : null}
      <ColorReadouts controller={controller} color={color} />
      <span className={styles.sectionTitle}>{t('Recent Colors')}</span>
      <RecentColors controller={controller} onPick={(c) => set(c)} testId="picker-recent-colors" />
      <span className={styles.sectionTitle}>{t('Swatches')} · {t(state.scope === 'document' ? 'Document' : 'Library')}</span>
      {swatches.length ? (
        <div className={styles.grid} role="list" aria-label={t('Swatches')}>
          {swatches.map((s) => (
            <button key={s.id} type="button" role="listitem" className={styles.swatch} style={{ background: css(s.color) }} title={s.name} aria-label={s.name}
              data-testid="picker-swatch" onClick={() => set(s.color)} />
          ))}
        </div>
      ) : <span className={styles.empty}>{t('No swatches yet')}</span>}
    </div>
  );
}
