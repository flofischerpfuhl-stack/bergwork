/** Side panels, property sections and rows, list rows (Builder §8b, §9, §11). */
import { useState, type HTMLAttributes, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

export interface PanelTab {
  readonly id: string;
  readonly icon: ReactNode;
  readonly label: string;
  /** A small count on the tab, e.g. the number of layers. */
  readonly badge?: ReactNode;
  readonly testId?: string;
}

/**
 * A floating side panel with a vertical tab rail and no title row: the rail says what is shown (§9).
 * `railEnd` holds the panel's own controls at the rail's foot (pin, close). `embedded` fills a container the host
 * positions itself (an editor's own panel slot, a phone sheet) instead of floating over the stage; `scroll={false}`
 * leaves scrolling to the content (a list that virtualises its rows).
 */
export function SidePanel(props: {
  readonly side: 'start' | 'end';
  readonly tabs: readonly PanelTab[];
  readonly active: string;
  readonly onTab: (id: string) => void;
  readonly toolbar?: ReactNode;
  readonly railEnd?: ReactNode;
  readonly embedded?: boolean;
  readonly scroll?: boolean;
  readonly label?: string;
  readonly className?: string;
  readonly testId?: string;
  readonly children: ReactNode;
}) {
  const classes = ['bw-panel', props.embedded ? 'is-embedded' : 'bw-island', `is-${props.side}`, props.className].filter(Boolean).join(' ');
  return (
    <aside className={classes} aria-label={props.label} data-testid={props.testId}>
      <div className="bw-panel-rail" role="tablist" aria-orientation="vertical">
        {props.tabs.map((tab) => (
          <button key={tab.id} type="button" role="tab" className="bw-icon-button bw-panel-tab" aria-label={tab.label} data-tip={tab.label}
            aria-selected={tab.id === props.active} aria-pressed={tab.id === props.active} data-testid={tab.testId}
            onClick={() => props.onTab(tab.id)}>
            {tab.icon}
            <span className="bw-sr-only">{tab.label}</span>
            {tab.badge !== undefined ? <span className="bw-panel-badge">{tab.badge}</span> : null}
          </button>
        ))}
        {props.railEnd ? <div className="bw-panel-rail-end">{props.railEnd}</div> : null}
      </div>
      <div className="bw-panel-body" role="tabpanel">
        {props.toolbar ? <div className="bw-panel-toolbar">{props.toolbar}</div> : null}
        {props.scroll === false ? props.children : <div className="bw-panel-content bw-scroll">{props.children}</div>}
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

/**
 * A list row (layers): optional lead (disclosure), thumbnail, name with quiet meta, and a state column at the end.
 * File-manager selection renders a contiguous selection as one block (§5). Everything else a row needs (pointer and
 * keyboard handlers, tree roles, data attributes) passes through `rowProps`.
 */
export function ListRow(props: {
  readonly name: ReactNode;
  readonly meta?: ReactNode;
  readonly lead?: ReactNode;
  readonly thumb?: ReactNode;
  /** Thumbnails that bring their own frame (buttons with canvas previews) instead of the checker box. */
  readonly bareThumb?: boolean;
  readonly selected?: boolean;
  /** Hidden, or shown only as the context of a search match. */
  readonly dim?: boolean;
  readonly child?: boolean;
  /** Indentation in pixels for nested rows. */
  readonly indent?: number;
  readonly end?: ReactNode;
  readonly className?: string;
  readonly rowProps?: HTMLAttributes<HTMLDivElement> & Record<`data-${string}`, string | number | boolean | undefined>;
  readonly onSelect?: (event: React.MouseEvent) => void;
}) {
  const classes = ['bw-list-row', props.child ? 'is-child' : '', props.dim ? 'is-dim' : '', props.className].filter(Boolean).join(' ');
  return (
    <div className={classes} role="option" aria-selected={!!props.selected} tabIndex={-1} onClick={props.onSelect} {...props.rowProps}>
      {props.indent ? <span className="bw-list-indent" style={{ width: props.indent }} /> : null}
      {props.lead}
      {props.thumb !== undefined ? <span className={props.bareThumb ? 'bw-list-thumb is-bare' : 'bw-list-thumb'}>{props.thumb}</span> : null}
      <span className="bw-list-text">
        <span className="bw-list-name" data-tip-overflow>{props.name}</span>
        {props.meta ? <span className="bw-list-meta">{props.meta}</span> : null}
      </span>
      {props.end}
    </div>
  );
}
