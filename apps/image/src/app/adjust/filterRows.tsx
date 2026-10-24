/**
 * Live filters under their layer in the Layers panel (Photoshop's Smart Filters): a "Smart Filters" row whose eye
 * hides or shows the whole stack, and one row per filter with its own eye. Rows list the stack top-down in the order
 * Photoshop does (the filter applied last on top); dragging a row reorders the stack, double-clicking opens the
 * filter's panel, and the context menu applies (bakes) the stack into the pixels.
 */

import { useState, type PointerEvent as ReactPointerEvent } from 'react';
import styles from '../../ui/editor.module.css';
import local from './adjust.module.css';
import type { EditorController } from '../../ui/controller';
import type { EditorSession } from '../../core/session';
import type { HierarchyEntry } from '../../core/document';
import { Icon } from '../../ui/icons';
import { MenuPopup } from '../../ui/TopBar';
import type { MenuEntry } from '../../ui/menus';
import {
  applyLiveFiltersToPixels, beginLiveFilterEdit, clearLiveFilters, deleteLiveFilter, LIVE_FILTER_NAMES, moveLiveFilterTo,
  setAllLiveFiltersEnabled, setLiveFilterEnabled,
} from './liveFilters';

const collapsed = new WeakMap<EditorSession, Set<string>>();

/** Layer context-menu entries for a layer with live filters. */
export function liveFilterLayerItems(controller: EditorController, session: EditorSession, layerId: string): MenuEntry[] {
  const t = controller.t;
  const count = session.layer(layerId)?.filters.length ?? 0;
  if (!count) return [];
  return [
    'separator',
    { label: t('Apply Smart Filters'), enabled: session.canEditLayers, testId: 'context-apply-filters', run: () => void applyLiveFiltersToPixels(session, layerId) },
    { label: t('Clear Smart Filters'), enabled: session.canEditLayers, run: () => clearLiveFilters(session, layerId) },
  ];
}

interface Drag { from: number; startY: number; moved: boolean; slot: number | null }

export function LiveFilterRows({ controller, session, entry }: { controller: EditorController; session: EditorSession; entry: HierarchyEntry }) {
  const t = controller.t;
  const layer = entry.layer;
  const [, refresh] = useState(0);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; index: number | null } | null>(null);
  const filters = layer.filters;
  if (!filters.length) return null;
  let closed = collapsed.get(session);
  const open = !closed?.has(layer.id);
  const enabled = session.canEditLayers;
  const anyOn = filters.some((f) => f.enabled);
  const indent = Math.min(entry.depth, 8) * 24 + (layer.maskSourceId ? 24 : 0) + 16 + 36 + 6;
  const n = filters.length;
  // Display rows top-down: the last filter in the stack (applied last) first.
  const order = [...filters.keys()].reverse();
  const name = (index: number) => t(LIVE_FILTER_NAMES[filters[index]!.kind]);
  const edit = (index: number) => { session.selectLayer(layer.id); beginLiveFilterEdit(session, layer.id, index); };

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>, index: number) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button') || !enabled) return;
    const group = event.currentTarget.parentElement!;
    const state: Drag = { from: index, startY: event.clientY, moved: false, slot: null };
    const move = (e: PointerEvent) => {
      if (!state.moved && Math.abs(e.clientY - state.startY) < 4) return;
      state.moved = true;
      const rows = [...group.querySelectorAll<HTMLElement>('[data-filter-index]')];
      let slot = rows.length;
      for (let i = 0; i < rows.length; i++) { const r = rows[i]!.getBoundingClientRect(); if (e.clientY < r.top + r.height / 2) { slot = i; break; } }
      state.slot = slot;
      setDrag({ ...state });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      setDrag(null);
      if (!state.moved || state.slot === null) return;
      const fromDisplay = n - 1 - state.from;
      const toDisplay = state.slot > fromDisplay ? state.slot - 1 : state.slot;
      moveLiveFilterTo(session, layer.id, state.from, n - 1 - toDisplay);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const menuItems = (index: number | null): MenuEntry[] => {
    const filter = index === null ? null : filters[index];
    return [
      ...(filter && index !== null ? [
        { label: `${t('Edit Smart Filter')}…`, enabled, run: () => edit(index) },
        { label: t(filter.enabled ? 'Hide Smart Filter' : 'Show Smart Filter'), enabled, run: () => setLiveFilterEnabled(session, layer.id, index, !filter.enabled) },
        { label: t('Delete Smart Filter'), enabled, run: () => deleteLiveFilter(session, layer.id, index) },
      ] as MenuEntry[] : [
        { label: t(anyOn ? 'Hide Smart Filters' : 'Show Smart Filters'), enabled, run: () => setAllLiveFiltersEnabled(session, layer.id, !anyOn) },
      ] as MenuEntry[]),
      ...liveFilterLayerItems(controller, session, layer.id),
    ];
  };

  const dropSlot = drag?.moved ? drag.slot : null;
  return (
    <div role="group" aria-label={`${t('Smart Filters')}: ${layer.name}`} data-testid="filter-rows" data-layer-filters={layer.id}>
      <div className={`${local.filterRow} ${local.filterHeader} ${entry.visible ? '' : styles.layerRowDim}`} role="treeitem" aria-level={entry.depth + 2}
        aria-expanded={open} data-testid="filter-header"
        onContextMenu={(event) => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, index: null }); }}>
        <button type="button" className={`${styles.eye} ${local.filterEye}`} disabled={!enabled} aria-pressed={anyOn} data-testid="filter-header-eye"
          aria-label={`${t(anyOn ? 'Hide Smart Filters' : 'Show Smart Filters')}: ${layer.name}`}
          onClick={() => setAllLiveFiltersEnabled(session, layer.id, !anyOn)}>
          <Icon name={anyOn ? 'eye' : 'eyeSlash'} size={14} />
        </button>
        <span style={{ width: indent - 16, flex: 'none' }} />
        <button type="button" className={local.filterDisclosure} aria-label={t(open ? 'Hide smart filters list' : 'Show smart filters list')}
          onClick={() => { if (!closed) { closed = new Set(); collapsed.set(session, closed); } if (!closed.delete(layer.id)) closed.add(layer.id); refresh((x) => x + 1); }}>
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={10} />
        </button>
        <span className={local.filterIcon}><Icon name="sliders" size={13} /></span>
        <span className={local.filterName}>{t('Smart Filters')}</span>
      </div>
      {open ? order.map((index, display) => {
        const filter = filters[index]!;
        const above = dropSlot === display && drag!.from !== index;
        const below = dropSlot === n && display === n - 1 && drag!.from !== index;
        return (
          <div key={`${index}-${filter.kind}`} className={`${local.filterRow} ${filter.enabled ? '' : local.filterRowOff} ${entry.visible ? '' : styles.layerRowDim}
            ${drag?.moved && drag.from === index ? local.filterRowDragging : ''} ${above ? local.filterDropAbove : ''} ${below ? local.filterDropBelow : ''}`}
            role="treeitem" aria-level={entry.depth + 3} data-testid="filter-row" data-filter-index={index} data-filter-kind={filter.kind}
            title={`${name(index)} · ${t('Double-click to edit · Drag to reorder')}`}
            onPointerDown={(event) => startDrag(event, index)}
            onDoubleClick={(event) => { if (!(event.target as HTMLElement).closest('button')) edit(index); }}
            onContextMenu={(event) => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, index }); }}>
            <button type="button" className={`${styles.eye} ${local.filterEye}`} disabled={!enabled} aria-pressed={filter.enabled} data-testid="filter-eye"
              aria-label={`${t(filter.enabled ? 'Hide' : 'Show')} ${name(index)}`}
              onClick={() => setLiveFilterEnabled(session, layer.id, index, !filter.enabled)}>
              <Icon name={filter.enabled ? 'eye' : 'eyeSlash'} size={14} />
            </button>
            <span style={{ width: indent + 22, flex: 'none' }} />
            <span className={local.filterName}>{name(index)}</span>
          </div>
        );
      }) : null}
      {menu ? <MenuPopup controller={controller} anchor={menu} items={menuItems(menu.index)} onClose={() => setMenu(null)} /> : null}
    </div>
  );
}
