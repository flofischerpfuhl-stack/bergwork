import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react';

export interface AnchoredPopoverPlacement {
  readonly target: HTMLElement;
  readonly style: CSSProperties;
}

const sameStyle = (a: CSSProperties, b: CSSProperties) => a.left === b.left && a.top === b.top
  && a.maxWidth === b.maxWidth && a.maxHeight === b.maxHeight;

/**
 * Places a fixed popover below its anchor, but within this editor instance rather than the browser window.
 * The caller portals into `target`: options bars scroll and use a fade mask, which would otherwise clip their
 * fixed descendants and let the full-bleed canvas intercept their pointer input.
 */
export function useAnchoredPopover(open: boolean, anchor: RefObject<HTMLElement | null>, preferredWidth: number): AnchoredPopoverPlacement | null {
  const [placement, setPlacement] = useState<AnchoredPopoverPlacement | null>(null);
  useLayoutEffect(() => {
    const anchorElement = open ? anchor.current : null;
    const target = anchorElement?.closest<HTMLElement>('.fw-image-editor') ?? null;
    if (!anchorElement || !target) { setPlacement(null); return; }
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const anchorRect = anchorElement.getBoundingClientRect();
        const editorRect = target.getBoundingClientRect();
        const margin = 8, gap = 6;
        const maxWidth = Math.max(0, editorRect.width - margin * 2);
        const width = Math.min(preferredWidth, maxWidth);
        const left = Math.max(editorRect.left + margin, Math.min(anchorRect.left, editorRect.right - width - margin));
        const top = Math.max(editorRect.top + margin, Math.min(anchorRect.bottom + gap, editorRect.bottom - margin));
        const style: CSSProperties = { left, top, maxWidth, maxHeight: Math.max(0, editorRect.bottom - top - margin) };
        setPlacement((current) => current?.target === target && sameStyle(current.style, style) ? current : { target, style });
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(target);
    observer.observe(anchorElement);
    globalThis.addEventListener('resize', update);
    globalThis.addEventListener('scroll', update, true);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      globalThis.removeEventListener('resize', update);
      globalThis.removeEventListener('scroll', update, true);
    };
  }, [open, anchor, preferredWidth]);
  return open ? placement : null;
}
