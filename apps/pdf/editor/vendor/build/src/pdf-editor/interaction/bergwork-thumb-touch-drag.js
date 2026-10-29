// berg:work: reorder pages in the Pages panel by touch or pen. HTML5 drag and drop (the mouse path) does not
// start from a finger, so a press of LONG_PRESS_MS on a thumbnail lifts the page; moving then shows the insertion
// line and lifting the finger drops it. Moving earlier than that scrolls the grid as before. The grid element keeps
// the pointer capture, so the drag survives the virtual grid unmounting the thumbnail while it auto-scrolls.
import { useEffect, useRef, useState } from 'react';
import { pageDropGap } from './bergwork-page-selection.js';

export const LONG_PRESS_MS = 350;
const MOVE_TOLERANCE = 8;
const EDGE = 48;

function visibleThumbRects(scroller) {
  return [...scroller.querySelectorAll('.oo-pdf-thumb[data-page-index]')].map(node => {
    const rect = node.getBoundingClientRect();
    return { index: Number(node.dataset.pageIndex), left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
  });
}

// `selectedPageIds`: dragging one of them moves them all (as the mouse path does).
export function useThumbTouchDrag({ scrollerRef, doc, structureBusy, onMovePagesTo, selectedPageIds = [] }) {
  const pressRef = useRef(null);
  const suppressClickUntilRef = useRef(0);
  const [drag, setDrag] = useState(null);
  const latest = useRef({});
  latest.current = { doc, onMovePagesTo, selectedPageIds, structureBusy };

  const locate = (press) => {
    const scroller = scrollerRef.current;
    const pageCount = latest.current.doc?.pages?.length || 0;
    if (!scroller || !pageCount) return null;
    return pageDropGap(visibleThumbRects(scroller), press.x, press.y, pageCount);
  };
  const publish = (press) => {
    const spot = locate(press);
    press.spot = spot;
    setDrag({ pageId: press.pageId, movingIds: press.movingIds, gap: spot?.gap ?? -1, index: spot?.index ?? -1,
      side: spot?.side || '', x: press.x, y: press.y });
  };
  const finish = () => {
    const press = pressRef.current;
    if (!press) return;
    window.clearTimeout(press.timer);
    if (press.frame) cancelAnimationFrame(press.frame);
    pressRef.current = null;
    setDrag(null);
  };

  // A lifted page keeps the finger's moves: the grid must not scroll natively then.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return undefined;
    const onTouchMove = (event) => { if (pressRef.current?.active) event.preventDefault(); };
    scroller.addEventListener('touchmove', onTouchMove, { passive: false });
    return () => scroller.removeEventListener('touchmove', onTouchMove);
  }, [scrollerRef]);
  useEffect(() => () => finish(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const autoScroll = (press) => {
    // On phones the panel around the grid scrolls, not the grid itself.
    let scroller = scrollerRef.current;
    while (scroller && scroller.scrollHeight <= scroller.clientHeight + 1) scroller = scroller.parentElement;
    if (!scroller || pressRef.current !== press) return;
    const rect = scroller.getBoundingClientRect();
    const step = press.y < rect.top + EDGE ? -Math.ceil((rect.top + EDGE - press.y) / 4)
      : press.y > rect.bottom - EDGE ? Math.ceil((press.y - rect.bottom + EDGE) / 4) : 0;
    if (step) {
      const before = scroller.scrollTop;
      scroller.scrollTop += step;
      if (scroller.scrollTop !== before) publish(press);
    }
    press.frame = requestAnimationFrame(() => autoScroll(press));
  };

  const handlers = {
    onPointerDown: (event) => {
      if (event.pointerType === 'mouse' || event.button !== 0 || latest.current.structureBusy) return;
      const thumb = event.target.closest?.('.oo-pdf-thumb[data-page-index]');
      const index = Number(thumb?.dataset.pageIndex);
      const pageId = latest.current.doc?.pages?.[index]?.id;
      if (!thumb || !pageId || !latest.current.onMovePagesTo) return;
      finish();
      const selected = latest.current.selectedPageIds;
      const press = {
        pointerId: event.pointerId, pageId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY,
        movingIds: selected.length > 1 && selected.includes(pageId) ? [...selected] : [pageId],
        active: false, timer: 0, frame: 0, spot: null,
      };
      press.timer = window.setTimeout(() => {
        if (pressRef.current !== press) return;
        press.active = true;
        try { scrollerRef.current?.setPointerCapture(press.pointerId); } catch {}
        try { navigator.vibrate?.(12); } catch {}
        publish(press);
        press.frame = requestAnimationFrame(() => autoScroll(press));
      }, LONG_PRESS_MS);
      pressRef.current = press;
    },
    onPointerMove: (event) => {
      const press = pressRef.current;
      if (!press || press.pointerId !== event.pointerId) return;
      press.x = event.clientX;
      press.y = event.clientY;
      if (!press.active) {
        // Moved before the long press: this is a scroll or a swipe, not a drag.
        if (Math.hypot(press.x - press.startX, press.y - press.startY) > MOVE_TOLERANCE) finish();
        return;
      }
      event.preventDefault();
      publish(press);
    },
    onPointerUp: (event) => {
      const press = pressRef.current;
      if (!press || press.pointerId !== event.pointerId) return;
      if (press.active) {
        suppressClickUntilRef.current = performance.now() + 500;
        press.x = event.clientX;
        press.y = event.clientY;
        const spot = locate(press) || press.spot;
        finish();
        if (spot) latest.current.onMovePagesTo?.(press.pageId, spot.gap);
        return;
      }
      finish();
    },
    onPointerCancel: (event) => {
      if (pressRef.current?.pointerId === event.pointerId) finish();
    },
    // The click after a drop, the long-press menu and a native drag of the same press stay out.
    onClickCapture: (event) => {
      if (performance.now() < suppressClickUntilRef.current) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    onContextMenu: (event) => {
      if (pressRef.current || performance.now() < suppressClickUntilRef.current) event.preventDefault();
    },
    onDragStartCapture: (event) => {
      if (pressRef.current) event.preventDefault();
    },
  };
  return { drag, handlers };
}
