/** Popup placement and dismissal shared by menus, dropdowns and the tooltip (Builder popupPlacement.ts). */
import { useEffect, useLayoutEffect, useState, type RefObject } from 'react';

const MARGIN = 8;

export interface AnchorRect { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number }

/**
 * Where a popup goes, measured before paint so nothing flickers. A context menu opens at the pointer and
 * flips above or left of it at the window edges; a dropdown (`anchor`) stays at its field — below it,
 * above it at the bottom edge, right-aligned at the right edge. A submenu (`side`) opens beside its row
 * and flips to the other side when there is no room. It never leaves the window.
 */
export function usePopupPlacement(ref: RefObject<HTMLElement | null>, x: number, y: number,
  anchor?: AnchorRect, side?: AnchorRect): { left: number; top: number } {
  const [position, setPosition] = useState({ left: x, top: y });
  const key = [x, y, anchor?.left, anchor?.right, anchor?.top, anchor?.bottom, side?.left, side?.right, side?.top].join();
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const right = window.innerWidth - MARGIN, bottom = window.innerHeight - MARGIN;
    let left = x, top = y;
    if (side) {
      left = side.right + 2;
      top = side.top - 5;
      if (left + width > right) left = side.left - 2 - width;
    } else if (anchor) {
      left = anchor.left;
      top = anchor.bottom + 4;
      if (top + height > bottom) top = anchor.top - 4 - height;
      if (left + width > right) left = anchor.right - width;
    } else {
      if (top + height > bottom) top = y - height;
      if (left + width > right) left = x - width;
    }
    left = Math.max(MARGIN, Math.min(left, right - width));
    top = Math.max(MARGIN, Math.min(top, bottom - height));
    setPosition((prev) => (prev.left === left && prev.top === top ? prev : { left, top }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, key]);
  return position;
}

/**
 * Closes a popup on any outside press (capture phase, so a panel that stops propagation cannot keep it
 * open) and on Escape. A press on the button that opened it is left to that button, whose click toggles it.
 */
export function useDismiss(ref: RefObject<HTMLElement | null>, onClose: () => void, enabled = true, escape = true): void {
  useEffect(() => {
    if (!enabled) return;
    const press = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target || ref.current?.contains(target)) return;
      if (target.closest?.('[data-bw-popup]')) return;
      if (target.closest?.('[aria-haspopup][aria-expanded="true"]')) return;
      onClose();
    };
    const key = (event: KeyboardEvent) => {
      if (!escape || event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('pointerdown', press, true);
    window.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('pointerdown', press, true); window.removeEventListener('keydown', key, true); };
  }, [ref, onClose, enabled, escape]);
}
