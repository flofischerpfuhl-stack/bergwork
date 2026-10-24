/**
 * One product tooltip for the whole app (Builder TooltipLayer.tsx). No hover shows the browser's own
 * tooltip: a `title` is taken over and shown here. After the first tooltip the next ones appear at once
 * while the pointer moves on (warm-up), as in Figma and macOS. Below its element, above when there is no
 * room. `data-tip-overflow` shows a label's full text only while it is cut off.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const FIRST_DELAY = 450;
const WARM_WINDOW = 800;
const GAP = 8;
const MARGIN = 8;

export function TooltipLayer() {
  const [tip, setTip] = useState<{ text: string; anchor: DOMRect } | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let target: HTMLElement | null = null;
    let shownUntil = 0;
    let open = false;
    const textOf = (el: HTMLElement) => {
      if (el.hasAttribute('data-tip-overflow')) return el.scrollWidth > el.clientWidth ? (el.textContent ?? '') : '';
      const title = el.getAttribute('title');
      if (title) { el.dataset['tip'] = title; el.removeAttribute('title'); }
      return el.dataset['tip'] ?? '';
    };
    const hide = () => {
      if (timer) clearTimeout(timer);
      timer = null; target = null;
      if (open) shownUntil = performance.now();
      open = false;
      setTip(null);
    };
    const over = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse') return;
      const selector = '[title], [data-tip], [data-tip-overflow]';
      let el = (event.target as Element | null)?.closest<HTMLElement>(selector) ?? null;
      while (el?.hasAttribute('data-tip-overflow') && !textOf(el)) el = el.parentElement?.closest<HTMLElement>(selector) ?? null;
      if (el === target) return;
      if (!el) { if (target) hide(); return; }
      const text = textOf(el);
      if (timer) clearTimeout(timer);
      target = el;
      if (!text) { setTip(null); return; }
      const show = () => {
        if (target !== el || !el.isConnected) return;
        open = true;
        setTip({ text: textOf(el) || text, anchor: el.getBoundingClientRect() });
      };
      if (open || performance.now() - shownUntil < WARM_WINDOW) show();
      else timer = setTimeout(show, FIRST_DELAY);
    };
    const leave = (event: PointerEvent) => { if (!event.relatedTarget) hide(); };
    document.addEventListener('pointerover', over, true);
    document.addEventListener('pointerout', leave, true);
    document.addEventListener('pointerdown', hide, true);
    document.addEventListener('keydown', hide, true);
    document.addEventListener('wheel', hide, { capture: true, passive: true });
    document.addEventListener('scroll', hide, true);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener('pointerover', over, true);
      document.removeEventListener('pointerout', leave, true);
      document.removeEventListener('pointerdown', hide, true);
      document.removeEventListener('keydown', hide, true);
      document.removeEventListener('wheel', hide, true);
      document.removeEventListener('scroll', hide, true);
    };
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!tip || !el) { setPosition(null); return; }
    const { width, height } = el.getBoundingClientRect();
    let top = tip.anchor.bottom + GAP;
    if (top + height > window.innerHeight - MARGIN) top = tip.anchor.top - GAP - height;
    const left = Math.max(MARGIN, Math.min(tip.anchor.left + tip.anchor.width / 2 - width / 2, window.innerWidth - MARGIN - width));
    setPosition({ left, top: Math.max(MARGIN, top) });
  }, [tip]);

  if (!tip) return null;
  return createPortal(
    <div ref={ref} className="bw-tooltip" role="tooltip" style={position ?? { left: -9999, top: -9999, visibility: 'hidden' }}>
      {tip.text}
    </div>,
    document.body,
  );
}
