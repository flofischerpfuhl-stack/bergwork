import React, { useEffect, useId, useRef, useState } from 'react';
import { icon } from '../../../../../assets/icons.js';

// Building blocks of the floating top bar and canvas toolbar: a button that
// opens a small popover (dropdown in the top bar, "dropup" in the bottom
// toolbar), the open-document menu, the zoom control and the page field.

export function ChromeIcon({ name }) {
  return <span className="oo-pdf-icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: icon(name) }} />;
}

/** Closes on Escape and on a press outside `ref` (and outside `ignore`). */
function useDismiss(open, onClose, refs) {
  useEffect(() => {
    if (!open) return undefined;
    const outside = event => {
      if (refs.some(ref => ref.current?.contains(event.target))) return;
      onClose();
    };
    const key = event => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
      (refs[0].current?.querySelector('[aria-haspopup]') || refs[0].current?.querySelector('button'))?.focus();
    };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [open, onClose, refs]);
}

/**
 * A toolbar button with a popover. `open`/`onOpenChange` are controlled by
 * the toolbar so only one popover is open at a time. With `primary` it is a
 * split button: the main part runs `primary.onClick`, a chevron opens the popover.
 */
export function ChromePopoverButton({
  id, label, title, iconName, text, active = false, on = false, open, onOpenChange, disabled = false,
  placement = 'up', className = '', panelLabel, children, showChevron = false, primary = null,
}) {
  const host = useRef(null);
  const panelId = useId();
  const close = React.useCallback(() => onOpenChange(false), [onOpenChange]);
  const refs = React.useMemo(() => [host], []);
  useDismiss(open, close, refs);
  const chevron = <span className="oo-pdf-chrome-chevron" aria-hidden="true" dangerouslySetInnerHTML={{ __html: icon(placement === 'up' ? 'chevron-up' : 'chevron-down') }} />;
  // Compact split (phones): one button; it runs the main action and, once active, opens the popover.
  const compact = Boolean(primary?.compact);
  const split = Boolean(primary) && !compact;
  return (
    <div ref={host} className={`oo-pdf-chrome-popover-host ${split ? 'is-split' : ''} ${className}`} data-chrome-popover={id}>
      {split && (
        <button
          type="button"
          className={`oo-pdf-chrome-button oo-pdf-split-main ${text ? 'has-text' : ''} ${active ? 'is-active' : ''} ${primary.className || ''}`}
          aria-label={primary.label}
          title={primary.title || primary.label}
          aria-pressed={primary.pressed === false ? undefined : active}
          aria-busy={primary.busy || undefined}
          disabled={disabled}
          onClick={primary.onClick}
        >
          {iconName && <ChromeIcon name={iconName} />}
          {text && <span className="oo-pdf-chrome-button-text">{text}</span>}
        </button>
      )}
      <button
        type="button"
        className={split
          ? `oo-pdf-chrome-button oo-pdf-split-toggle ${active ? 'is-active' : ''} ${open ? 'is-open' : ''} ${primary.className || ''}`
          : `oo-pdf-chrome-button ${compact ? 'oo-pdf-split-main' : ''} ${text ? 'has-text' : ''} ${active ? 'is-active' : ''} ${on && !active ? 'is-on' : ''} ${open ? 'is-open' : ''}`}
        aria-label={compact ? primary.label : label}
        title={compact ? primary.title || primary.label : title || label}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-pressed={split ? undefined : active || on}
        disabled={disabled}
        onClick={() => (compact && !active ? primary.onClick() : onOpenChange(!open))}
      >
        {split ? chevron : <>
          {iconName && <ChromeIcon name={iconName} />}
          {text && <span className="oo-pdf-chrome-button-text">{text}</span>}
          {showChevron && chevron}
        </>}
      </button>
      {open && (
        <div id={panelId} className={`oo-pdf-chrome-popover is-${placement}`} role="group" aria-label={panelLabel || label}>
          {children}
        </div>
      )}
    </div>
  );
}

/** Row in a popover: a toggle (aria-pressed) or an action button. */
export function ChromeMenuItem({ label, iconName, pressed, onClick, disabled = false, title, className = '' }) {
  return (
    <button
      type="button"
      className={`oo-pdf-chrome-menu-item ${pressed ? 'is-active' : ''} ${className}`}
      aria-label={label}
      title={title || label}
      aria-pressed={pressed === undefined ? undefined : Boolean(pressed)}
      disabled={disabled}
      onClick={onClick}
    >
      {iconName && <ChromeIcon name={iconName} />}
      <span>{label}</span>
      {pressed !== undefined && <span className="oo-pdf-chrome-check" aria-hidden="true" dangerouslySetInnerHTML={{ __html: pressed ? icon('check') : '' }} />}
    </button>
  );
}

/**
 * The open documents as a dropdown: the active one is the title, the others
 * are listed below it. Rows keep the former tab classes (`oo-pdf-doc-tab`)
 * and stay in the DOM while collapsed, so the document count stays readable.
 */
export function DocumentMenu({ docs, activeDocId, onSelect, onClose, onOpenAnother, isUnsaved, open, onOpenChange, disabled = false }) {
  const host = useRef(null);
  const close = React.useCallback(() => onOpenChange(false), [onOpenChange]);
  const refs = React.useMemo(() => [host], []);
  useDismiss(open, close, refs);
  const active = docs.find(doc => doc.id === activeDocId) || null;
  return (
    <div ref={host} className={`oo-pdf-doc-menu ${open ? 'is-open' : ''}`}>
      <button
        type="button"
        className="oo-pdf-doc-menu-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={active ? `Open documents: ${active.name}` : 'Open documents'}
        title={active?.name || 'No PDF open'}
        disabled={disabled || (!docs.length && !onOpenAnother)}
        onClick={() => onOpenChange(!open)}
      >
        <span className="oo-pdf-doc-menu-icon"><ChromeIcon name="file-text" /></span>
        <span className="oo-pdf-doc-menu-title">{active?.name || 'No PDF open'}</span>
        {/* Its own class: `.oo-pdf-unsaved` marks one row per unsaved document. */}
        {active && isUnsaved(active) && <span className="oo-pdf-doc-menu-unsaved" aria-hidden="true" title="Changes not yet saved">●</span>}
        {docs.length > 1 && <span className="oo-pdf-doc-menu-count" aria-hidden="true">{docs.length}</span>}
        <ChromeIcon name={open ? 'chevron-up' : 'chevron-down'} />
      </button>
      <div className="oo-pdf-doc-tabs oo-pdf-doc-menu-list" role="listbox" aria-label="Open PDFs" hidden={!open}>
        {docs.map(doc => (
          <div key={doc.id} role="option" aria-selected={doc.id === activeDocId} className={`oo-pdf-doc-tab ${doc.id === activeDocId ? 'is-active' : ''}`}>
            <button className="oo-pdf-doc-select" type="button" aria-pressed={doc.id === activeDocId} onClick={() => { onSelect(doc.id); onOpenChange(false); }}>
              <span>{doc.name}</span>
              {isUnsaved(doc) && <span className="oo-pdf-unsaved" aria-label="Unsaved changes" title="Changes not yet saved">●</span>}
            </button>
            <button className="oo-pdf-doc-close" type="button" aria-label={`Close ${doc.name}`} title={`Close ${doc.name}`} onClick={() => onClose(doc.id)}>
              <ChromeIcon name="x" />
            </button>
          </div>
        ))}
        {onOpenAnother && (
          <button type="button" className="oo-pdf-chrome-menu-item oo-pdf-doc-menu-open" onClick={() => { onOpenChange(false); onOpenAnother(); }}>
            <ChromeIcon name="folder-open" />
            <span>{docs.length ? 'Open another PDF…' : 'Open PDF…'}</span>
          </button>
        )}
      </div>
    </div>
  );
}

/** Zoom level; the − and + buttons appear above it when it is pressed. */
export function ZoomControl({ zoom, onZoomIn, onZoomOut, onFitWidth, open, onOpenChange, disabled = false, wheelMode = 'scroll', onWheelModeChange }) {
  const host = useRef(null);
  const close = React.useCallback(() => onOpenChange(false), [onOpenChange]);
  const refs = React.useMemo(() => [host], []);
  useDismiss(open, close, refs);
  return (
    <div ref={host} className="oo-pdf-chrome-popover-host oo-pdf-zoom-host">
      <button
        type="button"
        className={`oo-pdf-chrome-button oo-pdf-zoom-level oo-pdf-zoom-control ${open ? 'is-open' : ''}`}
        aria-label={`${Math.round(zoom * 100)}%`}
        title="Zoom: steps, fit width and the mouse wheel"
        aria-haspopup="true"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => onOpenChange(!open)}
      >
        {Math.round(zoom * 100)}%
      </button>
      {open && (
        <div className="oo-pdf-chrome-popover is-up oo-pdf-zoom-popover" role="group" aria-label="Zoom">
          <div className="oo-pdf-zoom-steps">
            <button type="button" className="oo-pdf-chrome-button" aria-label="Zoom out" title="Zoom out" onClick={onZoomOut}>−</button>
            <button type="button" className="oo-pdf-chrome-button has-text" aria-label="Fit width" title="Fit width" onClick={onFitWidth}>Fit</button>
            <button type="button" className="oo-pdf-chrome-button" aria-label="Zoom in" title="Zoom in" onClick={onZoomIn}>+</button>
          </div>
          {onWheelModeChange && (
            <div className="oo-pdf-wheel-mode" role="radiogroup" aria-label="Mouse wheel">
              <span>Mouse wheel</span>
              <div className="oo-pdf-segmented">
                <button type="button" role="radio" aria-checked={wheelMode === 'scroll'} className={wheelMode === 'scroll' ? 'is-active' : ''}
                  title="The wheel scrolls; Ctrl/⌘+wheel zooms" onClick={() => onWheelModeChange('scroll')}>Scroll</button>
                <button type="button" role="radio" aria-checked={wheelMode === 'zoom'} className={wheelMode === 'zoom' ? 'is-active' : ''}
                  title="The wheel zooms at the pointer (CAD style); Shift+wheel scrolls sideways, middle button drags" onClick={() => onWheelModeChange('zoom')}>Zoom</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Current page as an editable number; Enter (or leaving the field) jumps. */
export function PageJump({ pageIndex, pageCount, onGoToPage, disabled = false }) {
  const [draft, setDraft] = useState(null);
  const input = useRef(null);
  const shown = draft ?? (pageCount ? String(pageIndex + 1) : '-');
  const commit = () => {
    if (draft == null) return;
    const value = Number.parseInt(draft, 10);
    setDraft(null);
    if (Number.isFinite(value) && pageCount) onGoToPage(Math.min(pageCount, Math.max(1, value)) - 1);
  };
  return (
    <span className="oo-pdf-page-jump oo-pdf-page-pill">
      <input
        ref={input}
        type="text"
        inputMode="numeric"
        aria-label="Page number"
        title="Go to page"
        value={shown}
        disabled={disabled || !pageCount}
        size={Math.max(1, String(pageCount || 1).length)}
        onFocus={event => event.target.select()}
        onChange={event => setDraft(event.target.value.replace(/[^0-9]/g, ''))}
        onKeyDown={event => {
          if (event.key === 'Enter') { event.preventDefault(); commit(); input.current?.blur(); }
          if (event.key === 'Escape') { event.preventDefault(); setDraft(null); input.current?.blur(); }
        }}
        onBlur={commit}
      />
      <span aria-hidden="true">/</span>
      <span aria-hidden="true">{pageCount || '-'}</span>
      {/* The whole position as text ("3 / 12"), for assistive technology and text lookups. */}
      <span className="sr-only">{pageCount ? `${pageIndex + 1} / ${pageCount}` : '- / -'}</span>
    </span>
  );
}
