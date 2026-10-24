/** Side panels, property sections and rows, list rows (Builder §8b, §9, §11). */
import { useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

export interface PanelTab { readonly id: string; readonly icon: ReactNode; readonly label: string }

/**
 * A floating side panel with a vertical tab rail and no title row: the rail says what is shown (§9).
 * `railEnd` holds the panel's own controls at the rail's foot (pin, detach).
 */
export function SidePanel(props: {
  readonly side: 'start' | 'end';
  readonly tabs: readonly PanelTab[];
  readonly active: string;
  readonly onTab: (id: string) => void;
  readonly toolbar?: ReactNode;
  readonly railEnd?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <aside className={`bw-panel bw-island is-${props.side}`}>
      <div className="bw-panel-rail" role="tablist" aria-orientation="vertical">
        {props.tabs.map((tab) => (
          <button key={tab.id} type="button" role="tab" className="bw-icon-button" aria-label={tab.label} data-tip={tab.label}
            aria-selected={tab.id === props.active} aria-pressed={tab.id === props.active} onClick={() => props.onTab(tab.id)}>
            {tab.icon}
          </button>
        ))}
        {props.railEnd ? <div className="bw-panel-rail-end">{props.railEnd}</div> : null}
      </div>
      <div className="bw-panel-body" role="tabpanel">
        {props.toolbar ? <div className="bw-panel-toolbar">{props.toolbar}</div> : null}
        <div className="bw-panel-content bw-scroll">{props.children}</div>
      </div>
    </aside>
  );
}

const OPEN_KEY = 'bergwork.sections';
function remembered(id: string): boolean {
  try { return (JSON.parse(globalThis.localStorage?.getItem(OPEN_KEY) ?? '{}') as Record<string, boolean>)[id] ?? true; }
  catch { return true; }
}
function remember(id: string, open: boolean): void {
  try {
    const all = JSON.parse(globalThis.localStorage?.getItem(OPEN_KEY) ?? '{}') as Record<string, boolean>;
    all[id] = open;
    globalThis.localStorage?.setItem(OPEN_KEY, JSON.stringify(all));
  } catch { /* storage blocked */ }
}

/** A collapsible group (Revit); open by default, the choice remembered per group. Closed means closed. */
export function Section(props: { readonly id: string; readonly title: string; readonly children: ReactNode }) {
  const [open, setOpen] = useState(() => remembered(props.id));
  return (
    <section className="bw-section" data-open={open}>
      <button type="button" className="bw-section-head" aria-expanded={open}
        onClick={() => { setOpen(!open); remember(props.id, !open); }}>
        <ChevronDown size={14} strokeWidth={1.8} />
        {props.title}
      </button>
      {open ? <div className="bw-section-body">{props.children}</div> : null}
    </section>
  );
}

/** Label | control on one line; every value starts at one x. `onLabelPointerDown` makes the label a scrubber. */
export function PropertyRow(props: {
  readonly label: string;
  readonly children: ReactNode;
  readonly onLabelPointerDown?: (event: React.PointerEvent<HTMLElement>) => void;
}) {
  return (
    <div className="bw-row">
      <span className={`bw-row-label${props.onLabelPointerDown ? ' bw-scrub' : ''}`} data-tip-overflow
        onPointerDown={props.onLabelPointerDown}>{props.label}</span>
      <div className="bw-row-control">{props.children}</div>
    </div>
  );
}

/** A list row (layers): thumbnail, name, quiet meta, and a state column at the end. */
export function ListRow(props: {
  readonly name: string;
  readonly meta?: string;
  readonly thumb?: ReactNode;
  readonly selected?: boolean;
  readonly child?: boolean;
  readonly end?: ReactNode;
  readonly onSelect?: (event: React.MouseEvent) => void;
}) {
  return (
    <div className={`bw-list-row${props.child ? ' is-child' : ''}`} role="option" aria-selected={!!props.selected} tabIndex={-1}
      onClick={props.onSelect}>
      {props.thumb !== undefined ? <span className="bw-list-thumb">{props.thumb}</span> : null}
      <span className="bw-list-name" data-tip-overflow>{props.name}</span>
      {props.meta ? <span className="bw-list-meta">{props.meta}</span> : null}
      {props.end}
    </div>
  );
}
