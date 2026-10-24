/** Buttons, chips, checks and fields after the Builder UI lab (§3 states, §8a chips, §8b fields). */
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { Menu, type MenuEntry } from './Menu';
import type { AnchorRect } from './popup';

/** Toggle state shown by the frame (§3): none = off, dashed = automatic, solid = on. */
export type ToggleState = 'off' | 'auto' | 'on';

/** An icon button: the icon never changes with the state; `label` is its name and its tooltip. */
export function IconButton(props: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly shortcut?: string;
  readonly state?: ToggleState;
  /** A selected tool (pressed): the darker control grey. */
  readonly pressed?: boolean;
  /** The tool has more modes (a dot under it). */
  readonly more?: boolean;
  readonly small?: boolean;
  readonly disabled?: boolean;
  readonly onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button type="button" className={`bw-icon-button${props.small ? ' is-small' : ''}`} aria-label={props.label}
      data-tip={props.shortcut ? `${props.label} (${props.shortcut})` : props.label}
      data-state={props.state && props.state !== 'off' ? props.state : undefined}
      aria-pressed={props.pressed ?? (props.state ? props.state !== 'off' : undefined)}
      data-more={props.more ? '' : undefined} disabled={props.disabled} onClick={props.onClick}>
      {props.icon}
    </button>
  );
}

export function Button(props: {
  readonly children: ReactNode;
  readonly variant?: 'default' | 'primary' | 'quiet';
  readonly disabled?: boolean;
  readonly type?: 'button' | 'submit';
  readonly onClick?: () => void;
}) {
  const variant = props.variant && props.variant !== 'default' ? ` is-${props.variant}` : '';
  return <button type={props.type ?? 'button'} className={`bw-button${variant}`} disabled={props.disabled} onClick={props.onClick}>{props.children}</button>;
}

/**
 * A status bar chip. Single-choice chips show their value; multi-choice chips show a count of what is on
 * (0 included, two digits wide) so they never change size; panel toggles show the frame when on.
 */
export function Chip(props: {
  readonly icon?: ReactNode;
  readonly label?: string;
  readonly value?: string;
  readonly count?: number;
  readonly tip?: string;
  readonly pressed?: boolean;
  readonly panel?: boolean;
  /** A readout, not a control (zoom level, image size). */
  readonly readout?: boolean;
  /** Fixed width for a value chip; a longer value ends in "…" with the full text in the tooltip. */
  readonly width?: number;
  readonly menu?: readonly MenuEntry[] | (() => readonly MenuEntry[]);
  readonly onClick?: () => void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState<AnchorRect | null>(null);
  const close = useCallback(() => setOpen(null), []);
  const className = `bw-chip${props.panel ? ' is-panel' : ''}${props.readout ? ' is-readout' : ''}`;
  const content = (
    <>
      {props.icon}
      {props.label ? <span>{props.label}</span> : null}
      {props.value !== undefined ? <span className="bw-chip-value bw-mono" data-tip-overflow>{props.value}</span> : null}
      {props.count !== undefined ? <span className="bw-chip-count">{props.count}</span> : null}
    </>
  );
  if (props.readout) return <span className={className} style={props.width ? { width: props.width } : undefined} data-tip={props.tip}>{content}</span>;
  return (
    <>
      <button ref={button} type="button" className={className} style={props.width ? { width: props.width } : undefined}
        aria-label={props.tip ?? props.label} data-tip={props.label && !props.panel ? undefined : props.tip ?? props.label}
        aria-pressed={props.pressed} aria-haspopup={props.menu ? 'menu' : undefined} aria-expanded={props.menu ? !!open : undefined}
        onClick={() => {
          if (!props.menu) { props.onClick?.(); return; }
          if (open) { close(); return; }
          const rect = button.current?.getBoundingClientRect();
          if (rect) setOpen({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
        }}>
        {content}
      </button>
      {open && props.menu ? <Menu entries={typeof props.menu === 'function' ? props.menu() : props.menu} anchor={open}
        {...(props.tip ? { label: props.tip } : {})} onClose={close} /> : null}
    </>
  );
}

/** A plain on/off: a check mark without a box; the space stays reserved when off (§3). */
export function CheckMark(props: { readonly checked: boolean; readonly label: string; readonly pale?: boolean; readonly onChange?: (checked: boolean) => void }) {
  return (
    <button type="button" role="checkbox" aria-checked={props.checked} aria-label={props.label} data-tip={props.label}
      className={`bw-check${props.pale ? ' is-pale' : ''}`} onClick={() => props.onChange?.(!props.checked)}>
      {props.checked ? <Check size={15} strokeWidth={2} /> : null}
    </button>
  );
}

/** More than two states: the framed glyph — empty, dashed + check, solid + check (§3, §4). */
export function StateGlyph(props: { readonly state: ToggleState; readonly label: string; readonly pale?: boolean; readonly onClick?: () => void }) {
  const glyph = (
    <span className={`bw-glyph${props.pale ? ' is-pale' : ''}`} data-state={props.state} aria-hidden>
      {props.state !== 'off' ? <Check size={12} strokeWidth={2.4} /> : null}
    </span>
  );
  if (!props.onClick) return glyph;
  return <button type="button" className="bw-check" aria-label={props.label} data-tip={props.label} onClick={props.onClick}>{glyph}</button>;
}

/** Two or three choices with short labels (§8c). */
export function Segmented<T extends string>(props: {
  readonly value: T;
  readonly options: readonly { readonly value: T; readonly label: string; readonly tip?: string }[];
  readonly label: string;
  readonly onChange: (value: T) => void;
}) {
  return (
    <div className="bw-segmented" role="radiogroup" aria-label={props.label}>
      {props.options.map((option) => (
        <button key={option.value} type="button" role="radio" aria-checked={option.value === props.value}
          data-tip={option.tip} onClick={() => props.onChange(option.value)}>{option.label}</button>
      ))}
    </div>
  );
}

export function Slider(props: {
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step?: number;
  readonly label: string;
  readonly onChange: (value: number) => void;
}) {
  const fill = ((props.value - props.min) / (props.max - props.min)) * 100;
  return (
    <input type="range" className="bw-slider" aria-label={props.label} min={props.min} max={props.max} step={props.step ?? 1}
      value={props.value} style={{ ['--bw-slider-fill' as string]: `${fill}%` }}
      onChange={(event) => props.onChange(Number(event.target.value))} />
  );
}

function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }

/**
 * A number field: monospace, tabular, right-aligned, with its unit. Typing commits on Enter or blur; ↑/↓
 * step it (Shift ×10); `scrubRef` hands out a pointer handler that changes it by dragging a label sideways.
 */
export function NumberField(props: {
  readonly value: number;
  readonly label: string;
  readonly unit?: string;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly decimals?: number;
  readonly disabled?: boolean;
  readonly onChange: (value: number) => void;
}) {
  const min = props.min ?? -Infinity, max = props.max ?? Infinity, step = props.step ?? 1, decimals = props.decimals ?? 0;
  const format = (value: number) => value.toFixed(decimals);
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const parsed = Number(draft.replace(',', '.'));
    if (Number.isFinite(parsed)) props.onChange(clamp(parsed, min, max));
    setDraft(null);
  };
  return (
    <label className={`bw-field is-number${props.disabled ? ' is-disabled' : ''}`}>
      <input aria-label={props.label} inputMode="decimal" disabled={props.disabled}
        value={draft ?? format(props.value)}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={(event) => event.target.select()}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') { commit(); (event.target as HTMLInputElement).blur(); }
          else if (event.key === 'Escape') { setDraft(null); (event.target as HTMLInputElement).blur(); event.stopPropagation(); }
          else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            const delta = (event.key === 'ArrowUp' ? 1 : -1) * step * (event.shiftKey ? 10 : 1);
            props.onChange(clamp(Number((props.value + delta).toFixed(decimals)), min, max));
            setDraft(null);
            event.preventDefault();
          }
        }} />
      {props.unit ? <span className="bw-field-unit">{props.unit}</span> : null}
    </label>
  );
}

/** Drag a label sideways to change a number (Photoshop's scrubby labels); one pixel is one step. */
export function useScrub(value: number, onChange: (value: number) => void, options: { step?: number; min?: number; max?: number } = {}) {
  return (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const start = event.clientX, from = value, step = options.step ?? 1;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) => {
      const next = from + Math.round((e.clientX - start) / (e.shiftKey ? 0.2 : 1)) * step;
      onChange(clamp(next, options.min ?? -Infinity, options.max ?? Infinity));
    };
    const up = () => { target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', up); };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  };
}

export function TextField(props: { readonly value: string; readonly label: string; readonly placeholder?: string; readonly onChange: (value: string) => void }) {
  return (
    <label className="bw-field">
      <input aria-label={props.label} value={props.value} placeholder={props.placeholder} onChange={(event) => props.onChange(event.target.value)} />
    </label>
  );
}

/** A dropdown for fixed choices (§8b); the menu stays at its field and marks the choice at the row's end. */
export function Select<T extends string>(props: {
  readonly value: T;
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly label: string;
  readonly disabled?: boolean;
  readonly onChange: (value: T) => void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState<AnchorRect | null>(null);
  const close = useCallback(() => { setOpen(null); button.current?.focus({ preventScroll: true }); }, []);
  const current = props.options.find((option) => option.value === props.value);
  const show = () => {
    const rect = button.current?.getBoundingClientRect();
    if (rect) setOpen({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
  };
  return (
    <>
      <button ref={button} type="button" className="bw-select" aria-label={props.label} aria-haspopup="listbox"
        aria-expanded={!!open} disabled={props.disabled} onClick={() => (open ? close() : show())}
        onKeyDown={(event) => { if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !open) { show(); event.preventDefault(); } }}>
        <span data-tip-overflow>{current?.label ?? ''}</span>
        <ChevronDown size={14} strokeWidth={1.8} />
      </button>
      {open ? <Menu anchor={open} label={props.label} focusFirst onClose={close}
        entries={props.options.map((option) => ({ label: option.label, checked: option.value === props.value, onSelect: () => props.onChange(option.value) }))} /> : null}
    </>
  );
}
