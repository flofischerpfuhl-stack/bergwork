/**
 * Menus: context menus, dropdowns and menu-bar menus share one row (Builder §8a). Portalled, kept inside
 * the window, closed by any outside press. Checks sit at the row's end; submenus open on hover after
 * ~120 ms and survive the way across other rows inside the safe triangle; keyboard: ↑/↓, Home/End,
 * type-ahead, Enter/Space, → opens and ← closes a submenu, Esc closes one level.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronRight } from 'lucide-react';
import { useDismiss, usePopupPlacement, type AnchorRect } from './popup';

export type MenuEntry =
  | {
    readonly type?: 'item';
    readonly label: string;
    readonly icon?: ReactNode;
    readonly shortcut?: string;
    /** A plain on/off or single choice: a check mark at the row's end (no box); `undefined` = no check column. */
    readonly checked?: boolean;
    /** A parent of several on/off items of which only some are on. */
    readonly pale?: boolean;
    readonly disabled?: boolean;
    /** Why it is disabled, or the full text of a long label (product tooltip). */
    readonly tip?: string;
    readonly onSelect?: () => void;
    readonly submenu?: readonly MenuEntry[];
  }
  | { readonly type: 'divider' }
  | { readonly type: 'section'; readonly label: string };

type Item = Extract<MenuEntry, { label: string; type?: 'item' }>;
const isItem = (entry: MenuEntry): entry is Item => entry.type === undefined || entry.type === 'item';
const OPEN_DELAY = 120;
const TRIANGLE_GRACE = 400;

interface SurfaceProps {
  readonly entries: readonly MenuEntry[];
  readonly x: number;
  readonly y: number;
  readonly anchor?: AnchorRect;
  readonly side?: AnchorRect;
  readonly label?: string;
  readonly onClose: () => void;
  readonly onCloseAll: () => void;
  /** Focus the first item on open (keyboard), or the menu itself (pointer). */
  readonly focusFirst?: boolean;
  /** Receives this surface's element, so the parent can measure an open submenu for its safe triangle. */
  readonly surfaceRef?: React.MutableRefObject<HTMLDivElement | null>;
}

function inTriangle(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }): boolean {
  const sign = (p1: typeof p, p2: typeof p, p3: typeof p) => (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
  const d1 = sign(p, a, b), d2 = sign(p, b, c), d3 = sign(p, c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

function MenuSurface(props: SurfaceProps) {
  const { entries, onClose, onCloseAll } = props;
  const ref = useRef<HTMLDivElement>(null);
  const position = usePopupPlacement(ref, props.x, props.y, props.anchor, props.side);
  const [active, setActive] = useState(-1);
  const [sub, setSub] = useState<{ index: number; rect: AnchorRect; keyboard: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const exit = useRef<{ x: number; y: number } | null>(null);
  const subRef = useRef<HTMLDivElement | null>(null);

  const { surfaceRef } = props;
  useLayoutEffect(() => {
    if (!surfaceRef) return;
    surfaceRef.current = ref.current;
    return () => { surfaceRef.current = null; };
  }, [surfaceRef]);
  useLayoutEffect(() => {
    ref.current?.focus({ preventScroll: true });
    if (props.focusFirst) setActive(entries.findIndex((entry) => isItem(entry) && !entry.disabled));
  }, [entries, props.focusFirst]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const enabled = entries.map((entry) => isItem(entry) && !entry.disabled);
  const step = (from: number, delta: number) => {
    for (let i = 1; i <= entries.length; i++) {
      const next = (from + delta * i + entries.length * 2) % entries.length;
      if (enabled[next]) return next;
    }
    return from;
  };
  const openSub = (index: number, keyboard: boolean) => {
    const row = ref.current?.querySelector<HTMLElement>(`[data-index="${index}"]`);
    const rect = row?.getBoundingClientRect();
    if (rect) setSub({ index, rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }, keyboard });
  };
  const choose = (index: number) => {
    const entry = entries[index];
    if (!entry || !isItem(entry) || entry.disabled) return;
    if (entry.submenu) { openSub(index, true); return; }
    onCloseAll();
    entry.onSelect?.();
  };

  const hover = (index: number, event: React.PointerEvent) => {
    if (event.pointerType !== 'mouse') return;
    setActive(index);
    if (timer.current) clearTimeout(timer.current);
    const entry = entries[index];
    const hasSub = !!entry && isItem(entry) && !!entry.submenu && !entry.disabled;
    if (sub && sub.index !== index) {
      // On the way to the open submenu across other rows: keep it while inside the safe triangle.
      const panel = subRef.current?.getBoundingClientRect();
      const from = exit.current, p = { x: event.clientX, y: event.clientY };
      if (panel && from) {
        const near = panel.left > from.x ? panel.left : panel.right;
        if (inTriangle(p, from, { x: near, y: panel.top }, { x: near, y: panel.bottom })) {
          timer.current = setTimeout(() => { setSub(null); if (hasSub) openSub(index, false); }, TRIANGLE_GRACE);
          return;
        }
      }
      setSub(null);
    }
    if (hasSub && sub?.index !== index) timer.current = setTimeout(() => openSub(index, false), OPEN_DELAY);
  };

  const key = (event: React.KeyboardEvent) => {
    if (sub?.keyboard && event.target !== ref.current) return;
    const entry = entries[active];
    switch (event.key) {
      case 'ArrowDown': setActive(step(active, 1)); break;
      case 'ArrowUp': setActive(step(active < 0 ? 0 : active, -1)); break;
      case 'Home': setActive(step(-1, 1)); break;
      case 'End': setActive(step(0, -1)); break;
      case 'Enter': case ' ': if (active >= 0) choose(active); break;
      case 'ArrowRight': if (entry && isItem(entry) && entry.submenu) openSub(active, true); else return; break;
      case 'ArrowLeft': if (props.side) onClose(); else return; break;
      case 'Escape': event.stopPropagation(); onClose(); break;
      default: {
        if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;
        const letter = event.key.toLowerCase();
        const order = entries.map((_, i) => (active + 1 + i) % entries.length);
        const found = order.find((i) => { const e = entries[i]; return !!e && isItem(e) && !e.disabled && e.label.toLowerCase().startsWith(letter); });
        if (found !== undefined) setActive(found);
      }
    }
    event.preventDefault();
  };

  const hasChecks = entries.some((entry) => isItem(entry) && entry.checked !== undefined);
  const subEntry = sub ? entries[sub.index] : undefined;
  return createPortal(
    <>
      <div ref={ref} className="bw-menu" role="menu" aria-label={props.label} tabIndex={-1} data-bw-popup
        style={position} onKeyDown={key}
        onPointerLeave={(event) => { exit.current = { x: event.clientX, y: event.clientY }; }}
        onPointerMove={(event) => { exit.current = { x: event.clientX, y: event.clientY }; }}>
        {entries.map((entry, index) => {
          if (entry.type === 'divider') return <div key={index} className="bw-menu-divider" role="separator" />;
          if (entry.type === 'section') return <div key={index} className="bw-menu-section">{entry.label}</div>;
          const role = entry.checked === undefined ? 'menuitem' : 'menuitemcheckbox';
          return (
            <button key={index} type="button" role={role} data-index={index} tabIndex={-1}
              className={`bw-menu-item${index === active ? ' is-active' : ''}`}
              disabled={entry.disabled} aria-checked={entry.checked === undefined ? undefined : entry.checked}
              aria-haspopup={entry.submenu ? 'menu' : undefined} aria-expanded={entry.submenu ? sub?.index === index : undefined}
              data-tip={entry.tip}
              onPointerEnter={(event) => hover(index, event)}
              onClick={() => choose(index)}>
              {entry.icon}
              <span className="bw-menu-label">{entry.label}</span>
              {entry.shortcut ? <kbd className="bw-menu-shortcut">{entry.shortcut}</kbd> : null}
              {hasChecks ? <span className={`bw-menu-check${entry.pale ? ' is-pale' : ''}`} aria-hidden>
                {entry.checked ? <Check size={15} strokeWidth={2} /> : null}</span> : null}
              {entry.submenu ? <ChevronRight className="bw-menu-more" aria-hidden /> : null}
            </button>
          );
        })}
      </div>
      {sub && subEntry && isItem(subEntry) && subEntry.submenu ? (
        <MenuSurface key={sub.index} surfaceRef={subRef} entries={subEntry.submenu} x={sub.rect.right} y={sub.rect.top}
          side={sub.rect} label={subEntry.label} focusFirst={sub.keyboard} onCloseAll={onCloseAll}
          onClose={() => { setSub(null); ref.current?.focus({ preventScroll: true }); }} />
      ) : null}
    </>,
    document.body,
  );
}

/** A menu at a point (context menu) or at an element (`anchor`: dropdown, menu bar). */
export function Menu(props: {
  readonly entries: readonly MenuEntry[];
  readonly x?: number;
  readonly y?: number;
  readonly anchor?: AnchorRect;
  readonly label?: string;
  readonly focusFirst?: boolean;
  readonly onClose: () => void;
}) {
  const holder = useRef<HTMLDivElement | null>(null);
  const { onClose } = props;
  // Outside presses close the whole chain (every surface is marked data-bw-popup); Escape is handled by
  // the focused surface, so it closes one level at a time.
  useDismiss(holder, onClose, true, false);
  return <MenuSurface entries={props.entries} x={props.x ?? props.anchor?.left ?? 0} y={props.y ?? props.anchor?.bottom ?? 0}
    {...(props.anchor ? { anchor: props.anchor } : {})} {...(props.label ? { label: props.label } : {})}
    focusFirst={props.focusFirst ?? false} onClose={onClose} onCloseAll={onClose} />;
}

/** A button that opens a menu below itself; the button toggles it, ↓ opens it on the first item. */
export function MenuButton(props: {
  readonly entries: readonly MenuEntry[] | (() => readonly MenuEntry[]);
  readonly className?: string;
  readonly label: string;
  readonly tip?: string;
  readonly children: ReactNode;
  readonly disabled?: boolean;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState<{ rect: AnchorRect; keyboard: boolean } | null>(null);
  const close = useCallback(() => setOpen(null), []);
  const show = (keyboard: boolean) => {
    const rect = button.current?.getBoundingClientRect();
    if (rect) setOpen({ rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }, keyboard });
  };
  return (
    <>
      <button ref={button} type="button" className={props.className} aria-label={props.label} data-tip={props.tip}
        aria-haspopup="menu" aria-expanded={!!open} disabled={props.disabled}
        onClick={(event) => (open ? close() : show(event.detail === 0))}
        onKeyDown={(event) => { if (event.key === 'ArrowDown' && !open) { show(true); event.preventDefault(); } }}>
        {props.children}
      </button>
      {open ? <Menu entries={typeof props.entries === 'function' ? props.entries() : props.entries} anchor={open.rect}
        label={props.label} focusFirst={open.keyboard} onClose={() => { close(); button.current?.focus({ preventScroll: true }); }} /> : null}
    </>
  );
}
