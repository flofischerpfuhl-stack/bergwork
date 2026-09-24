/**
 * The Layers panel (UI/LayersPanel.swift, NativeLayerList.swift, LayerAppearanceControls.swift,
 * BlendModePicker.swift): count, blend and opacity for the active layer, the layer tree top-first
 * with folders, masks, clipping indentation, and the footer buttons.
 */

import { Fragment, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import styles from './editor.module.css';
import { HistoryPanel } from './HistoryPanel';
import type { EditorController } from './controller';
import { useSession, useUi, useWorkspace } from './hooks';
import { Icon, type IconName } from './icons';
import { CanvasThumbnail, fittedSize } from './Thumbnail';
import { MenuPopup } from './TopBar';
import { ADJUSTMENT_KINDS, BLEND_MODES, blendLabel, descendantIds, hierarchyEntries, maskTransform, type AdjustmentKind, type HierarchyEntry, type Layer } from '../core/document';
import type { ColorLabel, LayerLocks } from '../core/model/types';
import { filterLayers, type LayerSearchQuery } from '../core/layerSearch';

type LayerQuery = { -readonly [K in keyof LayerSearchQuery]: K extends 'kinds' ? Layer['kind'][] : K extends 'labels' ? ColorLabel[] : LayerSearchQuery[K] };
import type { EditorSession } from '../core/session';
import type { MenuEntry } from './menus';

const ADJUSTMENT_ICONS: Record<AdjustmentKind, IconName> = {
  'Hue/Saturation': 'adjustment', 'Levels': 'levels', 'Curves': 'curves', 'Exposure': 'exposure', 'Gradient Map': 'gradientMap', 'Grain': 'grain',
};

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const LOCKS: { key: keyof LayerLocks; icon: IconName; label: string }[] = [
  { key: 'transparency', icon: 'lockTransparency', label: 'Lock transparent pixels' },
  { key: 'pixels', icon: 'brush', label: 'Lock image pixels' },
  { key: 'position', icon: 'move', label: 'Lock position' },
  { key: 'all', icon: 'lock', label: 'Lock all' },
];

/** Colour labels in the order of Photoshop's layer context menu. */
export const COLOR_LABELS: { label: ColorLabel; name: string; color: string }[] = [
  { label: 'none', name: 'No Color', color: 'transparent' },
  { label: 'red', name: 'Red', color: '#c8554f' },
  { label: 'orange', name: 'Orange', color: '#d0853a' },
  { label: 'yellow', name: 'Yellow', color: '#c9b440' },
  { label: 'green', name: 'Green', color: '#5c9e55' },
  { label: 'blue', name: 'Blue', color: '#4f7fc8' },
  { label: 'violet', name: 'Violet', color: '#8d65c2' },
  { label: 'gray', name: 'Gray', color: '#8a8a8a' },
];
const labelColor = (label: ColorLabel) => COLOR_LABELS.find((c) => c.label === label)?.color ?? 'transparent';

/** Slider plus percent field; a slider drag is one undo step (LayerAppearanceControls). */
function PercentControl({ controller, label, testId, value, enabled, begin, finish, set }: {
  controller: EditorController; label: string; testId: string; value: number; enabled: boolean;
  begin: () => void; finish: () => void; set: (value: number) => void;
}) {
  const t = controller.t;
  const [percent, setPercent] = useState('100');
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setPercent(String(Math.round(value * 100))); }, [value, focused]);
  return (
    <div className={styles.appearanceRow}>
      <span>{t(label)}</span>
      <input className={styles.slider} type="range" min={0} max={100} step={1} value={Math.round(value * 100)} disabled={!enabled}
        aria-label={t(label)} data-testid={`${testId}-slider`}
        onPointerDown={begin} onPointerUp={finish}
        onKeyDown={(event) => event.stopPropagation()}
        onChange={(event) => set(Number(event.target.value) / 100)} />
      <label className={styles.field}>
        <input value={percent} disabled={!enabled} style={{ width: 44 }} aria-label={`${t(label)} %`} data-testid={`${testId}-field`}
          onFocus={() => setFocused(true)}
          onBlur={() => { setFocused(false); const v = Number(percent.replace(',', '.')); if (Number.isFinite(v)) set(Math.min(100, Math.max(0, v)) / 100); }}
          onChange={(event) => setPercent(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Enter' || event.key === 'Escape') (event.target as HTMLInputElement).blur();
            if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
              set(Math.min(100, Math.max(0, Math.round(value * 100) + (event.shiftKey ? 10 : 1) * (event.key === 'ArrowUp' ? 1 : -1))) / 100);
              event.preventDefault();
            }
          }} />
        <span>%</span>
      </label>
    </div>
  );
}

function Appearance({ controller, session }: { controller: EditorController; session: EditorSession }) {
  const t = controller.t;
  const layer = session.activeLayer;
  const enabled = session.canEditAppearance;
  const [popup, setPopup] = useState<{ x: number; y: number } | null>(null);
  const opacity = layer?.opacity ?? 1;
  const fill = layer?.fillOpacity ?? 1;
  // Locks work on every selected layer, folders included (Photoshop).
  const lockable = session.canEditLayers && session.selectedLayerIds.size > 0 && !!layer;
  const locks = layer ? session.lockState(layer.id) : null;
  const mode = layer ? session.displayedBlendMode(layer) : 'normal';
  const items: MenuEntry[] = BLEND_MODES.map((b) => ({ label: t(b.label), enabled: true, checked: b.mode === layer?.blendMode, run: () => session.setLayerBlendMode(b.mode) }));
  return (
    <div className={styles.appearance}>
      <div className={styles.appearanceRow}>
        <span>{t('Blend')}</span>
        <button type="button" className={styles.select} style={{ flex: 1, textAlign: 'left' }} disabled={!enabled} aria-haspopup="menu" aria-label={t('Blend mode')}
          data-testid="blend-mode" onClick={(event) => { const r = event.currentTarget.getBoundingClientRect(); setPopup({ x: r.left, y: r.bottom + 4 }); }}>
          {t(blendLabel(mode))}
        </button>
      </div>
      <PercentControl controller={controller} label="Opacity" testId="opacity" value={opacity} enabled={enabled}
        begin={() => session.beginOpacityEdit()} finish={() => session.finishOpacityEdit()} set={(v) => session.setLayerOpacity(v)} />
      <div className={styles.appearanceRow}>
        <span>{t('Lock')}</span>
        <span className={styles.lockButtons} role="group" aria-label={t('Lock')}>
          {LOCKS.map((lock) => {
            // Pressed shows the layer's own flag; a flag implied by Lock All or by a locked folder shows as unavailable.
            const on = !!layer?.locks[lock.key];
            const implied = !on && !!locks?.[lock.key];
            return (
              <button key={lock.key} type="button" className={`${styles.lockButton} ${on ? styles.lockButtonOn : ''}`} aria-pressed={on}
                disabled={!lockable || implied} title={t(lock.label)} aria-label={t(lock.label)} data-testid={`lock-${lock.key}`}
                onClick={() => session.setLayerLocks([...session.selectedLayerIds], { [lock.key]: !on })}>
                <Icon name={lock.icon} size={14} />
              </button>
            );
          })}
        </span>
      </div>
      <PercentControl controller={controller} label="Fill opacity" testId="fill" value={fill} enabled={enabled}
        begin={() => { if (layer) session.beginFillOpacityEdit([layer.id]); }} finish={() => session.finishFillOpacityEdit()}
        set={(v) => { if (layer) session.setFillOpacity([layer.id], v); }} />
      {popup ? (
        <BlendPopup controller={controller} session={session} anchor={popup} items={items} onClose={() => { setPopup(null); session.previewBlendMode(null); }} />
      ) : null}
    </div>
  );
}

/** Blend menu with Photoshop-style live preview of the highlighted mode (BlendModePicker.Coordinator). */
function BlendPopup({ controller, session, anchor, items, onClose }: {
  controller: EditorController; session: EditorSession; anchor: { x: number; y: number }; items: MenuEntry[]; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const buttons = [...element.querySelectorAll<HTMLButtonElement>('[role=menuitem]')];
    const enter = (index: number) => () => session.previewBlendMode(BLEND_MODES[index]!.mode);
    const handlers = buttons.map((b, i) => { const h = enter(i); b.addEventListener('pointerenter', h); b.addEventListener('focus', h); return [b, h] as const; });
    return () => { for (const [b, h] of handlers) { b.removeEventListener('pointerenter', h); b.removeEventListener('focus', h); } };
  });
  return <div ref={ref}><MenuPopup controller={controller} anchor={anchor} items={items} onClose={onClose} /></div>;
}

interface DragState {
  ids: string[]; startY: number; moved: boolean; target: { index: number; into: boolean } | null; copy: boolean;
  /** Set while Option-dragging a mask thumbnail: the layer whose mask is copied, and the row it would land on. */
  maskFrom?: string; maskTarget?: string | null;
}

function LayerRow({ controller, session, entry, rows, drag, onDragStart, onContext, context = false, effectsOpen = false, onToggleEffects }: {
  controller: EditorController; session: EditorSession; entry: HierarchyEntry; rows: HierarchyEntry[]; drag: DragState | null;
  onDragStart: ((event: ReactPointerEvent, id: string) => void) | null; onContext: (id: string, x: number, y: number) => void;
  /** Shown only as the folder of a search match, not as a match itself. */
  context?: boolean;
  /** Whether the layer's effects are listed below it (the fx disclosure). */
  effectsOpen?: boolean; onToggleEffects?: (id: string) => void;
}) {
  const t = controller.t;
  const layer = entry.layer;
  const document = session.document!;
  const canvasSize = { width: document.width, height: document.height };
  const selected = session.selectedLayerIds.has(layer.id);
  const active = session.activeLayerId === layer.id && session.selectedLayerIds.size === 1;
  const enabled = session.canEditLayers;
  const framed = !layer.adjustment && layer.kind !== 'group';
  const [renaming, setRenaming] = useState(false);
  const renameRequested = controller.renamingLayerId === layer.id;
  useEffect(() => { if (renameRequested) { setRenaming(true); controller.renamingLayerId = null; } }, [renameRequested, controller]);
  const index = rows.findIndex((r) => r.layer.id === layer.id);
  const dropAbove = drag?.moved && !drag.maskFrom && drag.target && !drag.target.into && drag.target.index === index;
  const dropInto = drag?.moved && (drag.maskFrom ? drag.maskTarget === layer.id : drag.target?.into && drag.target.index === index);
  const source = layer.maskSourceId ? session.layer(layer.maskSourceId) : null;
  const meta = source ? `${t('Clipped to')} ${source.name}` : layer.adjustment ? t('Adjustment · Double-click to edit') : layer.kind === 'group' ? t('Folder')
    : `${Math.round(layer.transform.size.width).toLocaleString(controller.locale)} × ${Math.round(layer.transform.size.height).toLocaleString(controller.locale)} px`;
  const indent = Math.min(entry.depth, 8) * 24 + (layer.maskSourceId ? 24 : 0);

  const onRowPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || renaming) return;
    const target = event.target as HTMLElement;
    if (target.closest('button') && !target.closest('[data-thumb]')) return;
    // Option-drag from a mask thumbnail carries a copy of the mask to another row (NativeLayerList.dragMaskCopy).
    if (event.altKey && target.closest('[data-mask-thumb]')) {
      if (enabled && event.pointerType === 'mouse') onDragStart?.(event, layer.id);
      return;
    }
    // Option-click on the bottom quarter of a row makes or releases a clipping mask.
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.altKey && !(isMac ? event.metaKey : event.ctrlKey) && event.clientY >= rect.bottom - rect.height / 4) {
      session.toggleClippingMask(layer.id);
      return;
    }
    const additive = isMac ? event.metaKey : event.ctrlKey;
    if (event.shiftKey && session.activeLayerId) {
      const from = rows.findIndex((r) => r.layer.id === session.activeLayerId);
      const [a, b] = from < index ? [from, index] : [index, from];
      session.selectLayers(rows.slice(a, b + 1).map((r) => r.layer.id), session.activeLayerId);
    } else if (additive) {
      const next = new Set(session.selectedLayerIds);
      if (next.has(layer.id)) next.delete(layer.id); else next.add(layer.id);
      session.selectLayers(next, next.has(layer.id) ? layer.id : [...next][0] ?? null);
    } else if (!(selected && session.selectedLayerIds.size > 1)) {
      if (session.isMaskSelected && session.activeLayerId === layer.id && !target.closest('[data-thumb]')) session.selectLayerTarget(layer.id, false);
      else session.selectLayer(layer.id);
    }
    if (enabled && event.pointerType === 'mouse') onDragStart?.(event, layer.id);
  };
  const locks = session.lockState(layer.id);
  const lockedAll = locks.all, lockedSome = locks.transparency || locks.pixels || locks.position;

  return (
    <div className={`${styles.layerRow} ${selected ? styles.layerRowSelected : ''} ${entry.visible ? '' : styles.layerRowDim} ${dropAbove ? styles.layerRowDropAbove : ''} ${dropInto ? styles.layerRowDropInto : ''} ${context ? styles.layerRowContext : ''}`}
      role="treeitem" aria-selected={selected} aria-level={entry.depth + 1} aria-expanded={layer.kind === 'group' ? !session.collapsedGroupIds.has(layer.id) : undefined}
      data-layer-id={layer.id} data-testid="layer-row"
      onPointerDown={onRowPointerDown}
      onDoubleClick={(event) => {
        if ((event.target as HTMLElement).closest('button:not([data-thumb])')) return;
        if (!session.canEditLayers) return;
        if (layer.adjustment && controller.features.editAdjustment) { session.selectLayer(layer.id); controller.features.editAdjustment.run(); return; }
        // Photoshop: a double-click on the name renames, elsewhere on the row it opens Layer Style.
        const commands = controller.layerStyles;
        if (commands?.styleable(layer.id) && !(event.target as HTMLElement).closest('[data-layer-name], input')) { commands.open(layer.id); return; }
        session.selectLayer(layer.id);
        setRenaming(true);
      }}
      onContextMenu={(event) => { event.preventDefault(); onContext(layer.id, event.clientX, event.clientY); }}>
      <button type="button" className={styles.eye} disabled={!enabled} data-label={layer.colorLabel}
        style={layer.colorLabel !== 'none' ? { background: labelColor(layer.colorLabel) } : undefined} aria-label={`${t(layer.visible ? 'Hide' : 'Show')} ${layer.name}`}
        data-testid="layer-eye" data-eye={layer.id}
        onPointerDown={(event) => {
          event.stopPropagation();
          const visible = session.beginVisibilitySwipe(layer.id);
          if (visible === null) return;
          // Eye swipe: dragging over other eyes gives them the same state, one undo step.
          const move = (e: PointerEvent) => {
            const eye = (document_elementFromPoint(e.clientX, e.clientY)?.closest('[data-eye]') as HTMLElement | null)?.dataset.eye;
            if (eye) session.setVisibilityInSwipe(eye, visible);
          };
          const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); session.endVisibilitySwipe(); };
          window.addEventListener('pointermove', move);
          window.addEventListener('pointerup', up);
        }}>
        <Icon name={layer.visible ? 'eye' : 'eyeSlash'} size={16} />
      </button>
      <span style={{ width: indent, flex: 'none' }} />
      <button type="button" className={styles.disclosure} style={{ visibility: layer.kind === 'group' ? 'visible' : 'hidden' }} disabled={!enabled}
        aria-label={t('Expand or collapse folder')} onClick={() => session.toggleGroupExpansion(layer.id)}>
        <Icon name={session.collapsedGroupIds.has(layer.id) ? 'chevronRight' : 'chevronDown'} size={12} />
      </button>
      <div className={styles.thumbSlot}>
        {framed ? (
          <button type="button" data-thumb className={`${styles.thumb} ${active && !session.isMaskSelected ? styles.thumbTarget : ''}`}
            style={fittedSize(canvasSize, 36)} aria-label={`${t('Select image')}: ${layer.name}`} title={t('Select image pixels')}
            onClick={(event) => {
              if ((isMac ? event.metaKey : event.ctrlKey) && controller.features.loadLayerSelectionAt) { controller.loadSelection?.(layer.id, false, event); return; }
              session.selectLayerTarget(layer.id, false);
            }}>
            <CanvasThumbnail raster={session.displayedRaster(layer)} transform={session.displayedTransform(layer)} canvasSize={canvasSize} box={36} />
          </button>
        ) : (
          <span className={`${styles.iconThumb} ${active && !session.isMaskSelected ? styles.thumbTarget : ''}`}>
            <Icon name={layer.kind === 'group' ? 'folder' : ADJUSTMENT_ICONS[layer.adjustment!.kind] ?? 'adjustment'} size={24} />
          </span>
        )}
      </div>
      {layer.mask ? (
        <>
          {framed ? (
            <button type="button" className={styles.linkButton} disabled={!enabled} aria-label={layer.mask.linked ? `Unlink mask: ${layer.name}` : `Link mask: ${layer.name}`}
              title={layer.mask.linked ? 'Unlink layer and mask to move or transform them separately' : 'Link layer and mask so they move together'}
              onClick={() => session.toggleMaskLink(layer.id)}>
              {layer.mask.linked ? <Icon name="link" size={11} /> : null}
            </button>
          ) : <span style={{ width: 5 }} />}
          <div className={styles.maskSlot}>
            <button type="button" data-thumb className={`${styles.thumb} ${active && session.isMaskSelected ? styles.thumbTarget : ''}`}
              style={fittedSize(canvasSize, 30)} aria-label={`Select mask: ${layer.name}`} data-testid="mask-thumb" data-mask-thumb
              title="Select layer mask; Shift-click to enable/disable; Option-drag onto another layer to copy it"
              onClick={(event) => {
                if ((isMac ? event.metaKey : event.ctrlKey) && controller.loadSelection) { controller.loadSelection(layer.id, true, event); return; }
                session.selectLayerTarget(layer.id, true);
                if (event.shiftKey) session.toggleLayerMask();
              }}>
              <CanvasThumbnail raster={session.displayedMaskRaster(layer)} transform={maskTransform(layer)} canvasSize={canvasSize} box={30} mask />
            </button>
            {!layer.mask.enabled ? <span className={styles.maskDisabled}>╱</span> : null}
          </div>
        </>
      ) : null}
      <div className={styles.layerText}>
        {renaming ? (
          <input className={styles.renameInput} defaultValue={layer.name} autoFocus aria-label={t('Layer name')}
            onFocus={(event) => event.currentTarget.select()}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Enter') { session.renameLayer(layer.id, event.currentTarget.value); setRenaming(false); }
              if (event.key === 'Escape') setRenaming(false);
            }}
            onBlur={(event) => { session.renameLayer(layer.id, event.currentTarget.value); setRenaming(false); }} />
        ) : (
          <span className={styles.layerName} data-layer-name>{(layer.maskSourceId ? '↳ ' : '') + layer.name}</span>
        )}
        <span className={styles.layerMeta} title={source ? `Clipping mask based on ${source.name}. Option-click the bottom of its row to release.` : undefined}>{meta}</span>
      </div>
      {layer.effects.length ? (
        <button type="button" className={styles.fxBadge} aria-expanded={effectsOpen} data-testid="fx-badge"
          aria-label={`${t(effectsOpen ? 'Hide layer effects' : 'Show layer effects')}: ${layer.name}`} title={t('Layer effects')}
          onClick={() => onToggleEffects?.(layer.id)}>
          <span className={styles.fxGlyph}>fx</span>
          <Icon name={effectsOpen ? 'chevronDown' : 'chevronRight'} size={10} />
        </button>
      ) : null}
      {lockedAll || lockedSome ? (
        <span className={`${styles.layerLock} ${lockedAll ? '' : styles.layerLockPartial}`} data-testid="layer-lock"
          title={t(lockedAll ? 'Locked' : 'Partially locked')}><Icon name="lock" size={12} /></span>
      ) : null}
      <button type="button" className={styles.layerMore} aria-label={`${t('More')}: ${layer.name}`}
        onClick={(event) => { const r = event.currentTarget.getBoundingClientRect(); onContext(layer.id, r.left, r.bottom); }}>
        <Icon name="more" size={16} />
      </button>
    </div>
  );
}

/** The layer's effects under its row, each with an eye (Photoshop's expanded fx list); double-click opens Layer Style on it. */
function EffectRows({ controller, session, entry }: { controller: EditorController; session: EditorSession; entry: HierarchyEntry }) {
  const t = controller.t;
  const layer = entry.layer;
  const commands = controller.layerStyles;
  const order = commands?.kinds ?? [];
  const indices = [...layer.effects.keys()].sort((a, b) => order.indexOf(layer.effects[a]!.kind) - order.indexOf(layer.effects[b]!.kind) || a - b);
  const indent = Math.min(entry.depth, 8) * 24 + (layer.maskSourceId ? 24 : 0) + 16 + 36 + 6;
  return (
    <div role="group" aria-label={`${t('Layer effects')}: ${layer.name}`} data-testid="effect-rows">
      {indices.map((index) => {
        const effect = layer.effects[index]!;
        const name = commands?.label(effect.kind) ?? effect.kind;
        return (
          <div key={index} className={`${styles.effectRow} ${effect.enabled ? '' : styles.effectRowOff} ${entry.visible ? '' : styles.layerRowDim}`}
            role="treeitem" aria-level={entry.depth + 2} data-testid="effect-row" data-effect-kind={effect.kind}
            onDoubleClick={(event) => {
              if ((event.target as HTMLElement).closest('button')) return;
              commands?.open(layer.id, index);
            }}>
            <button type="button" className={styles.eye} disabled={!session.canEditLayers} data-testid="effect-eye" aria-pressed={effect.enabled}
              aria-label={`${t(effect.enabled ? 'Hide' : 'Show')} ${name}`}
              onClick={() => session.setLayerEffectEnabled(layer.id, index, !effect.enabled)}>
              <Icon name={effect.enabled ? 'eye' : 'eyeSlash'} size={14} />
            </button>
            <span style={{ width: indent, flex: 'none' }} />
            <span className={styles.effectName}>{name}</span>
          </div>
        );
      })}
    </div>
  );
}

function document_elementFromPoint(x: number, y: number): Element | null { return globalThis.document.elementFromPoint(x, y); }

export function LayersPanel({ controller, inSheet = false }: { controller: EditorController; inSheet?: boolean }) {
  useWorkspace(controller);
  const session = useSession(controller.session);
  const t = controller.t;
  const document = session.document;
  const [query, setQuery] = useState<LayerQuery>({});
  const [filterMenu, setFilterMenu] = useState<{ x: number; y: number } | null>(null);
  const filtering = !!document && isActive(query);
  const found = filtering ? filterLayers(document, query) : null;
  // While filtering, folders open so matches inside collapsed folders show; their folders stay as context rows.
  const rows = found ? hierarchyEntries(document!.layers, true).filter((r) => found.matchingIds.has(r.layer.id) || found.ancestorIds.has(r.layer.id))
    : session.layerRows;
  const listRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [adjustMenu, setAdjustMenu] = useState<{ x: number; y: number } | null>(null);
  const [fxMenu, setFxMenu] = useState<{ x: number; y: number } | null>(null);
  const [effectsOpen, setEffectsOpen] = useState<ReadonlySet<string>>(new Set());
  const toggleEffects = (id: string) => setEffectsOpen((open) => { const next = new Set(open); if (!next.delete(id)) next.add(id); return next; });
  const layerStyles = controller.layerStyles;
  const width = controller.ui.getState().layersWidth;
  const [panelWidth, setPanelWidth] = useState(width);

  const startDrag = (event: ReactPointerEvent, id: string) => {
    if (event.altKey && (event.target as HTMLElement).closest('[data-mask-thumb]')) { startMaskDrag(event, id); return; }
    const ids = session.selectedLayerIds.has(id) ? rows.map((r) => r.layer.id).filter((x) => session.selectedLayerIds.has(x)) : [id];
    const carried = new Set(ids.flatMap((x) => [...descendantIds(document!.layers, x)]));
    const state: DragState = { ids: ids.filter((x) => !carried.has(x)), startY: event.clientY, moved: false, target: null, copy: event.altKey };
    const list = listRef.current!;
    // Near the list's top or bottom edge the list scrolls while dragging (NativeLayerList autoscroll).
    let lastY = event.clientY;
    const scroller = setInterval(() => {
      if (!state.moved) return;
      const rect = list.getBoundingClientRect(), edge = 28;
      const speed = lastY < rect.top + edge ? -Math.min(20, rect.top + edge - lastY) : lastY > rect.bottom - edge ? Math.min(20, lastY - (rect.bottom - edge)) : 0;
      if (speed) list.scrollTop += speed;
    }, 16);
    const move = (e: PointerEvent) => {
      lastY = e.clientY;
      if (!state.moved && Math.abs(e.clientY - state.startY) < 4) return;
      state.moved = true;
      state.copy = e.altKey;
      const elements = [...list.querySelectorAll<HTMLElement>('[data-layer-id]')];
      let target: DragState['target'] = { index: elements.length, into: false };
      for (let i = 0; i < elements.length; i++) {
        const r = elements[i]!.getBoundingClientRect();
        if (e.clientY < r.top + r.height / 2) {
          const row = rows[i]!;
          const into = row.layer.kind === 'group' && e.clientY > r.top + r.height * 0.25;
          target = { index: i, into };
          break;
        }
        if (rows[i]!.layer.kind === 'group' && e.clientY < r.bottom - r.height * 0.25) { target = { index: i, into: true }; break; }
      }
      state.target = target;
      setDrag({ ...state });
    };
    const up = (e: PointerEvent) => {
      clearInterval(scroller);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDrag(null);
      // Dropped on another project's tab (or the New button): copy the layer there (ProjectWorkspace.copyLayer).
      const element = globalThis.document.elementFromPoint(e.clientX, e.clientY);
      const tab = (element?.closest('[data-tab-id]') as HTMLElement | null)?.dataset.tabId;
      const newTab = element?.closest('[data-new-tab]');
      if (state.moved && (tab || newTab) && state.ids[0]) {
        if (tab !== controller.workspace.selectedId) void controller.workspace.copyLayer(state.ids[0], tab ?? null);
        return;
      }
      if (!state.moved || !state.target) return;
      const { index, into } = state.target;
      let parent: string | null, above: string | null = null, atBottom = false;
      if (into) parent = rows[index]!.layer.id;
      else if (index >= rows.length) { parent = null; atBottom = true; }
      else {
        // Dropping above a row (list is top-first) places the layer above that row's layer.
        const target = rows[index]!.layer;
        parent = target.parentId;
        above = target.id;
      }
      if (state.ids.includes(above ?? '') || (parent && state.ids.includes(parent))) return;
      const order = into ? [...state.ids].reverse() : state.ids;
      session.beginEdit(state.copy ? (state.ids.length > 1 ? 'Duplicate Layers' : 'Duplicate Layer') : (state.ids.length > 1 ? 'Move Layers' : 'Move Layer'));
      let placed = false;
      for (const id of order) {
        placed = (state.copy ? session.duplicateLayer(id, parent, above, atBottom) : session.placeLayer(id, parent, above, atBottom)) || placed;
      }
      if (placed && !state.copy) session.selectLayers(state.ids, state.ids[0] ?? null);
      session.endEdit();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /** Option-drag of a mask thumbnail: a copy of the mask lands on the row under the pointer (EditorSession.copyMask). */
  const startMaskDrag = (event: ReactPointerEvent, source: string) => {
    const state: DragState = { ids: [], startY: event.clientY, moved: false, target: null, copy: true, maskFrom: source, maskTarget: null };
    const startX = event.clientX;
    const move = (e: PointerEvent) => {
      if (!state.moved && (e.clientX - startX) ** 2 + (e.clientY - state.startY) ** 2 < 9) return;
      state.moved = true;
      const row = (globalThis.document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-layer-id]') as HTMLElement | null)?.dataset.layerId ?? null;
      state.maskTarget = row && session.canCopyMask(source, row) ? row : null;
      setDrag({ ...state });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDrag(null);
      if (state.moved && state.maskTarget) session.copyMask(source, state.maskTarget);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const menuItems = (id: string): MenuEntry[] => {
    const layer = session.layer(id);
    if (!layer) return [];
    const select = () => session.selectLayerTarget(id, false);
    return [
      { label: t('Rename…'), enabled: session.canEditLayers, run: () => { session.selectLayer(id); controller.renamingLayerId = id; session.notify('ui'); } },
      { label: t('Hide/Show Layer'), enabled: session.canEditLayers, run: () => session.toggleLayerVisibility(id) },
      { label: t('Color Label'), enabled: session.canEditLayers, submenu: COLOR_LABELS.map((c) => ({
        label: t(c.name), enabled: true, checked: layer.colorLabel === c.label,
        run: () => session.setColorLabel(session.selectedLayerIds.has(id) ? [...session.selectedLayerIds] : [id], c.label),
      })) },
      'separator',
      { label: t('Add White Mask'), enabled: session.canEditLayers && !layer.mask, run: () => { select(); controller.addMask(true); } },
      { label: t('Add Black Mask'), enabled: session.canEditLayers && !layer.mask, run: () => { select(); controller.addMask(false); } },
      { label: t('Enable/Disable Mask'), enabled: session.canEditLayers && !!layer.mask, run: () => { select(); session.toggleLayerMask(); } },
      { label: t('Delete Mask'), enabled: session.canEditLayers && !!layer.mask, run: () => { select(); session.deleteLayerMask(); } },
      'separator',
      { label: t('Layer Style'), enabled: !!controller.layerStyles?.styleable(id), testId: 'context-layer-style', submenu: controller.layerStyles?.menu(id) ?? [] },
      'separator',
      { label: layer.maskSourceId ? t('Release Clipping Mask') : t('Create Clipping Mask'), enabled: session.canToggleClippingMask(id), run: () => session.toggleClippingMask(id) },
      { label: t('Move Layer Up'), enabled: session.canEditLayers, run: () => { session.selectLayer(id); session.moveActiveLayer(1); } },
      { label: t('Move Layer Down'), enabled: session.canEditLayers, run: () => { session.selectLayer(id); session.moveActiveLayer(-1); } },
      { label: t('Duplicate Layer'), enabled: session.canEditLayers && layer.kind !== 'group', run: () => { session.selectLayer(id); session.duplicateActiveLayer(); } },
      { label: t('Move Out of Folder'), enabled: session.canEditLayers && !!layer.parentId, run: () => { session.selectLayer(id); session.moveActiveLayerOutOfGroup(); } },
      'separator',
      { label: t('Delete Layer / Folder'), enabled: session.canEditLayers, run: () => {
        if (session.selectedLayerIds.size > 1 && session.selectedLayerIds.has(id)) void session.deleteSelectedLayers();
        else void session.deleteLayer(id);
      } },
    ];
  };

  const side = useUi(controller, (state) => state.sidePanel);
  const deleteLabel = session.isMaskSelected ? t('Delete layer mask') : session.selectedLayerIds.size > 1 ? t('Delete selected layers') : t('Delete selected layer');
  const adjustmentsAvailable = !!controller.features.adjustmentLayers;
  return (
    <aside className={styles.layers} style={inSheet ? undefined : { width: panelWidth }} aria-label={t('Layers')} data-testid="layers-panel">
      {!inSheet ? (
        <div className={styles.resizeEdge} title={t('Drag to resize the panel')}
          onPointerDown={(event) => {
            const start = event.clientX, startWidth = panelWidth;
            (event.target as HTMLElement).setPointerCapture(event.pointerId);
            const move = (e: PointerEvent) => setPanelWidth(Math.min(352, Math.max(202, Math.round(startWidth - (e.clientX - start)))));
            const up = (e: PointerEvent) => {
              window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
              const next = Math.min(352, Math.max(202, Math.round(startWidth - (e.clientX - start))));
              controller.ui.setState({ layersWidth: next });
              try { localStorage.setItem('compositor.layersPanelWidth', String(next)); } catch { /* ignore */ }
            };
            window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
          }} />
      ) : null}
      <div className={styles.layersHeader} role="tablist" aria-label={t('Panels')}>
        <span className={styles.panelTabs}>
          <button type="button" role="tab" aria-selected={side === 'layers'} data-testid="tab-layers"
            className={`${styles.panelTab} ${side === 'layers' ? styles.panelTabOn : ''}`} onClick={() => controller.ui.setState({ sidePanel: 'layers' })}>
            {t('Layers')}
          </button>
          <button type="button" role="tab" aria-selected={side === 'history'} data-testid="tab-history"
            className={`${styles.panelTab} ${side === 'history' ? styles.panelTabOn : ''}`} onClick={() => controller.ui.setState({ sidePanel: 'history' })}>
            {t('History')}
          </button>
        </span>
        <span className={styles.layerCount} data-testid="layerCount">{document?.layers.length ?? 0}</span>
      </div>
      {side === 'history' ? <HistoryPanel controller={controller} /> : (<>
      <Appearance controller={controller} session={session} />
      {document ? (
        <div className={styles.layerFilter}>
          <Icon name="search" size={13} />
          <input type="search" value={query.text ?? ''} placeholder={t('Search layers')} aria-label={t('Search layers')} data-testid="layer-search"
            onChange={(event) => setQuery({ ...query, text: event.target.value })}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Escape') { setQuery({ ...query, text: '' }); (event.target as HTMLInputElement).blur(); }
            }} />
          <button type="button" className={`${styles.footerButton} ${filtering && hasFilter(query) ? styles.lockButtonOn : ''}`}
            aria-label={t('Filter layers')} title={t('Filter layers')} data-testid="layer-filter" aria-haspopup="menu"
            onClick={(event) => { const r = event.currentTarget.getBoundingClientRect(); setFilterMenu({ x: r.left, y: r.bottom + 4 }); }}>
            <Icon name="filter" size={14} />
          </button>
        </div>
      ) : null}
      {document && (rows.length || filtering) ? (
        <div className={styles.layerList} ref={listRef} role="tree" aria-label={t('Layers')} aria-multiselectable data-testid="layers-list">
          {rows.map((entry) => {
            const open = effectsOpen.has(entry.layer.id) && entry.layer.effects.length > 0;
            return (
              <Fragment key={entry.layer.id}>
                <LayerRow controller={controller} session={session} entry={entry} rows={rows} drag={drag}
                  onDragStart={found ? null : startDrag} onContext={(id, x, y) => setMenu({ id, x, y })}
                  context={!!found && !found.matchingIds.has(entry.layer.id)} effectsOpen={open} onToggleEffects={toggleEffects} />
                {open ? <EffectRows controller={controller} session={session} entry={entry} /> : null}
              </Fragment>
            );
          })}
          {found && !found.matchingIds.size ? <div className={styles.panelNote} data-testid="layer-search-empty">{t('No matching layers')}</div> : null}
          {drag?.moved && drag.target?.index === rows.length ? <div style={{ height: 2, background: 'var(--cmp-accent)' }} /> : null}
        </div>
      ) : (
        <div className={styles.emptyLayers}>
          <Icon name="layers" size={25} />
          <strong>{t('No layers yet')}</strong>
          <span>{document ? t('Import an image or add a blank layer.') : t('Create a canvas or import an image.')}</span>
        </div>
      )}
      <div className={styles.layersFooter}>
        <button type="button" className={styles.footerButton} aria-label={t('New blank layer')} title={t('New blank layer')} disabled={!session.canEditLayers}
          data-testid="addBlankLayer" onClick={() => session.addBlankLayer()}><Icon name="plusSquare" size={17} /></button>
        <button type="button" className={styles.footerButton} aria-label={t('New folder')} title={t('Group Selected Layers')} disabled={!session.canEditLayers}
          onClick={() => session.groupSelectedLayers()}><Icon name="folderPlus" size={17} /></button>
        <button type="button" className={styles.footerButton} aria-label={t('Add layer mask')} title={t('Add layer mask')}
          disabled={!session.canEditMask || !!session.activeLayer?.mask} data-testid="addMask" onClick={() => controller.addMask(true)}><Icon name="mask" size={17} /></button>
        <button type="button" className={styles.footerButton} aria-label={t('New adjustment layer')}
          title={adjustmentsAvailable ? t('New adjustment layer') : `${t('New adjustment layer')} — ${t('Not yet available in the browser port')}`}
          disabled={!session.canEditLayers || !adjustmentsAvailable}
          onClick={(event) => { const r = event.currentTarget.getBoundingClientRect(); setAdjustMenu({ x: r.left, y: r.top - 8 - 6 * 26 }); }}>
          <Icon name="adjustment" size={17} />
        </button>
        {layerStyles ? (
          <button type="button" className={styles.footerButton} aria-label={t('Add a layer style')} title={t('Add a layer style')} aria-haspopup="menu"
            disabled={!session.canEditLayers || !session.activeLayer || !layerStyles.styleable(session.activeLayer.id)} data-testid="fx-button"
            onClick={(event) => { const r = event.currentTarget.getBoundingClientRect(); setFxMenu({ x: r.left, y: r.top - 8 - 9 * 26 }); }}>
            <span className={styles.fxButtonGlyph} aria-hidden>fx</span>
          </button>
        ) : null}
        <span className={styles.spacer} />
        <button type="button" className={styles.footerButton} aria-label={deleteLabel} title={deleteLabel} data-testid="deleteLayer"
          disabled={!session.canEditLayers || !session.activeLayer} onClick={() => void session.deleteLayerOrMask()}><Icon name="trash" size={17} /></button>
      </div>
      </>)}
      {filterMenu ? <MenuPopup controller={controller} anchor={filterMenu} items={filterItems(t, query, setQuery)} onClose={() => setFilterMenu(null)} /> : null}
      {menu ? <MenuPopup controller={controller} anchor={menu} items={menuItems(menu.id)} onClose={() => setMenu(null)} /> : null}
      {fxMenu && layerStyles && session.activeLayer ? (
        <MenuPopup controller={controller} anchor={fxMenu} onClose={() => setFxMenu(null)} items={layerStyles.menu(session.activeLayer.id)} />
      ) : null}
      {adjustMenu ? (
        <MenuPopup controller={controller} anchor={adjustMenu} onClose={() => setAdjustMenu(null)}
          items={ADJUSTMENT_KINDS.map((kind) => ({ label: t(kind), enabled: true, run: () => session.addAdjustment(kind) }))} />
      ) : null}
    </aside>
  );
}

const KIND_FILTERS: { kind: Layer['kind']; name: string }[] = [
  { kind: 'pixel', name: 'Pixel Layers' }, { kind: 'adjustment', name: 'Adjustment Layers' }, { kind: 'vector', name: 'Shape Layers' },
  { kind: 'text', name: 'Text Layers' }, { kind: 'group', name: 'Folders' }, { kind: 'embedded', name: 'Embedded Content' },
];

function hasFilter(query: LayerQuery): boolean {
  return !!query.kinds?.length || !!query.labels?.length || query.visible !== undefined || query.locked !== undefined;
}
function isActive(query: LayerQuery): boolean { return !!query.text?.trim() || hasFilter(query); }

function toggled<T>(list: readonly T[] | undefined, value: T): T[] | undefined {
  const next = list?.includes(value) ? list.filter((x) => x !== value) : [...(list ?? []), value];
  return next.length ? next : undefined;
}

/** Photoshop's layer filter as one menu: kinds and colours combine (any of), visibility and locks narrow further. */
function filterItems(t: (text: string) => string, query: LayerQuery, set: (query: LayerQuery) => void): MenuEntry[] {
  return [
    ...KIND_FILTERS.map((k) => ({ label: t(k.name), enabled: true, checked: !!query.kinds?.includes(k.kind), run: () => set({ ...query, kinds: toggled(query.kinds, k.kind) }) })),
    'separator' as const,
    ...COLOR_LABELS.filter((c) => c.label !== 'none').map((c) => ({ label: t(c.name), enabled: true, checked: !!query.labels?.includes(c.label),
      run: () => set({ ...query, labels: toggled(query.labels, c.label) }) })),
    'separator' as const,
    { label: t('Visible Layers'), enabled: true, checked: query.visible === true, run: () => set({ ...query, visible: query.visible ? undefined : true }) },
    { label: t('Locked Layers'), enabled: true, checked: query.locked === true, run: () => set({ ...query, locked: query.locked ? undefined : true }) },
    'separator' as const,
    { label: t('Clear Filter'), enabled: isActive(query), run: () => set({}) },
  ];
}

export type { Layer };
