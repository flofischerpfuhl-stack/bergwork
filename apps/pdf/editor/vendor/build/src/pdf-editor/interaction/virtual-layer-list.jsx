import React, { Fragment, cloneElement, useLayoutEffect, useMemo, useRef, useState } from 'react';

// Default row pitch: 44px collapsed touch target plus 6px spacing. Callers
// with compact rows pass their exact row height.
const DEFAULT_ROW_HEIGHT = 50;
const OVERSCAN = 6;

export function VirtualLayerList({
  items,
  selectedKey,
  expandedKey,
  focusRequest = null,
  onNavigate,
  renderItem,
  children,
  listRole = 'list',
  itemRole = 'listitem',
  rowHeight = DEFAULT_ROW_HEIGHT,
}) {
  const ROW_HEIGHT = rowHeight;
  const listRef = useRef(null);
  const [viewport, setViewport] = useState({ top: 0, height: 600 });
  const [expandedSize, setExpandedSize] = useState({ key: '', extra: 0 });
  const [focusedKey, setFocusedKey] = useState('');
  const focusAfterScroll = useRef('');
  const lastRevealedSelection = useRef('');
  const virtual = items.length > 80;
  const expandedIndex = items.findIndex(item => item.layer.key === expandedKey);
  const extra = expandedIndex < 0 ? 0 : expandedSize.key === expandedKey ? expandedSize.extra : 600;
  const topAt = index => index * ROW_HEIGHT + (expandedIndex >= 0 && expandedIndex < index ? extra : 0);
  const indexAt = coordinate => {
    if (expandedIndex < 0 || coordinate < expandedIndex * ROW_HEIGHT) return Math.floor(coordinate / ROW_HEIGHT);
    if (coordinate < (expandedIndex + 1) * ROW_HEIGHT + extra) return expandedIndex;
    return Math.floor((coordinate - extra) / ROW_HEIGHT);
  };
  const start = Math.max(0, indexAt(viewport.top) - OVERSCAN);
  const end = Math.min(items.length, indexAt(viewport.top + viewport.height) + OVERSCAN + 1);
  const visibleIndices = useMemo(() => {
    if (!virtual) return items.map((_, index) => index);
    const indices = new Set(Array.from({ length: Math.max(0, end - start) }, (_, offset) => start + offset));
    // Keep an open property editor and keyboard focus mounted while scrolling;
    // otherwise an unsubmitted field could disappear with the recycled row.
    if (expandedIndex >= 0) indices.add(expandedIndex);
    const focusedIndex = items.findIndex(item => item.layer.key === focusedKey);
    if (focusedIndex >= 0) indices.add(focusedIndex);
    return [...indices].sort((a, b) => a - b);
  }, [items, virtual, start, end, expandedIndex, focusedKey]);
  const treePositions = useMemo(() => {
    if (itemRole !== 'treeitem') return new Map();
    const siblings = new Map();
    for (const entry of items) {
      const parent = entry.layer?.hierarchy?.parentStableId || '__root__';
      const group = siblings.get(parent) || [];
      group.push(entry.layer.key);
      siblings.set(parent, group);
    }
    const positions = new Map();
    for (const group of siblings.values()) {
      group.forEach((key, index) => positions.set(key, { size: group.length, position: index + 1 }));
    }
    return positions;
  }, [items, itemRole]);

  useLayoutEffect(() => {
    if (!focusRequest?.key) return;
    const index = items.findIndex(item => item.layer.key === focusRequest.key);
    const list = listRef.current;
    if (index < 0 || !list) return;
    focusAfterScroll.current = focusRequest.key;
    setFocusedKey(focusRequest.key);
    const top = topAt(index);
    if (top < list.scrollTop || top + ROW_HEIGHT > list.scrollTop + list.clientHeight) list.scrollTop = top;
    setViewport(current => ({ ...current, top: list.scrollTop }));
  }, [focusRequest]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const update = () => setViewport(current => {
      const next = { top: list.scrollTop, height: list.clientHeight || 600 };
      return current.top === next.top && current.height === next.height ? current : next;
    });
    const observer = new ResizeObserver(update);
    observer.observe(list);
    update();
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || !selectedKey) return;
    const index = items.findIndex(item => item.layer.key === selectedKey);
    if (index < 0) return;
    const revealKey = `${selectedKey}:${expandedKey}:${index}`;
    if (lastRevealedSelection.current === revealKey) return;
    lastRevealedSelection.current = revealKey;
    const top = topAt(index);
    const bottom = top + ROW_HEIGHT;
    if (expandedKey === selectedKey || top < list.scrollTop || bottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = top;
      setViewport(current => ({ ...current, top: list.scrollTop }));
    }
    // Reveal the chosen properties at the top, including when a progressive
    // index moves the row. Unchanged selection leaves manual scrolling alone.
  }, [selectedKey, expandedKey, items]);

  useLayoutEffect(() => {
    const node = listRef.current?.querySelector('.oo-pdf-layer-item.is-expanded');
    if (!node || !expandedKey) return;
    const measure = () => {
      const next = Math.max(0, node.getBoundingClientRect().height - (ROW_HEIGHT - (ROW_HEIGHT === DEFAULT_ROW_HEIGHT ? 6 : 0)));
      setExpandedSize(current => current.key === expandedKey && Math.abs(current.extra - next) < 0.5
        ? current : { key: expandedKey, extra: next });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    measure();
    return () => observer.disconnect();
  }, [expandedKey, items, virtual]);

  useLayoutEffect(() => {
    if (!focusAfterScroll.current) return;
    const node = [...(listRef.current?.querySelectorAll('.oo-pdf-layer-item') || [])]
      .find(item => item.dataset.layerKey === focusAfterScroll.current);
    if (node) {
      node.querySelector('.oo-pdf-layer-row')?.focus({ preventScroll: true });
      focusAfterScroll.current = '';
    }
  });

  let previousEnd = 0;
  return (
    <div ref={listRef} className={`oo-pdf-layer-list${virtual ? ' is-windowed' : ''}`}
      role={listRole} aria-label="PDF layers" data-layer-count={items.length}
      onScroll={event => {
        const top = event.currentTarget.scrollTop;
        setViewport(current => ({ ...current, top }));
      }}
      onFocusCapture={event => {
        const key = event.target.closest?.('.oo-pdf-layer-item')?.dataset.layerKey;
        if (key) setFocusedKey(key);
      }}
      onKeyDown={event => {
        if (!event.target.matches?.('.oo-pdf-layer-row')) return;
        const moves = { ArrowUp: -1, ArrowDown: 1, PageUp: -10, PageDown: 10 };
        if (!(event.key in moves) && event.key !== 'Home' && event.key !== 'End') return;
        event.preventDefault();
        event.stopPropagation();
        const key = event.target.closest('.oo-pdf-layer-item').dataset.layerKey;
        const current = items.findIndex(item => item.layer.key === key);
        const next = Math.max(0, Math.min(items.length - 1,
          event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : current + moves[event.key]));
        const nextKey = items[next]?.layer.key;
        if (!nextKey) return;
        onNavigate?.(items[next].layer);
        focusAfterScroll.current = nextKey;
        setFocusedKey(nextKey);
        const list = listRef.current;
        const top = topAt(next);
        if (top < list.scrollTop || top + ROW_HEIGHT > list.scrollTop + list.clientHeight) list.scrollTop = top;
        setViewport(state => ({ ...state, top: list.scrollTop }));
      }}>
      {children}
      {visibleIndices.map(index => {
        const entry = items[index];
        const treePosition = treePositions.get(entry.layer.key);
        const top = topAt(index);
        const gap = virtual ? Math.max(0, top - previousEnd) : 0;
        previousEnd = topAt(index + 1);
        return <Fragment key={entry.layer.key}>
          {gap > 0 && <div aria-hidden="true" style={{ height: gap }} />}
          {cloneElement(renderItem(entry), {
            role: itemRole,
            'aria-setsize': treePosition?.size || items.length,
            'aria-posinset': treePosition?.position || index + 1,
          })}
        </Fragment>;
      })}
      {virtual && previousEnd < topAt(items.length) && <div aria-hidden="true" style={{ height: topAt(items.length) - previousEnd }} />}
    </div>
  );
}
