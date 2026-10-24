import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { icon } from '../../../../../assets/icons.js';

const SECTION_STORAGE_KEY = 'fernwork.pdf.properties.sections.v1';
const sectionState = new Map();
let sectionStateLoaded = false;

function loadSectionState() {
  if (sectionStateLoaded) return;
  sectionStateLoaded = true;
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(SECTION_STORAGE_KEY) || '{}');
    for (const [key, value] of Object.entries(saved || {})) sectionState.set(key, value === true);
  } catch {}
}

function saveSectionState() {
  try {
    globalThis.localStorage?.setItem(SECTION_STORAGE_KEY, JSON.stringify(Object.fromEntries(sectionState)));
  } catch {}
}

export function PropSection({ sectionKey, title, summary = '', children, className = '' }) {
  loadSectionState();
  const contentId = useId();
  const [open, setOpen] = useState(() => sectionState.get(sectionKey) === true);
  const toggle = () => {
    const next = !open;
    sectionState.set(sectionKey, next);
    saveSectionState();
    setOpen(next);
  };
  return <section className={`oo-pdf-prop-section ${open ? 'is-open' : ''} ${className}`} data-section-key={sectionKey}>
    <button type="button" className="oo-pdf-prop-section-toggle" aria-label={title} aria-expanded={open} aria-controls={contentId} onClick={toggle}>
      <span className="oo-pdf-prop-section-chevron" aria-hidden="true" dangerouslySetInnerHTML={{ __html: icon('chevron-right') }} />
      <span className="oo-pdf-prop-section-title">{title}</span>
      {!open && summary && <span className="oo-pdf-prop-section-summary">{summary}</span>}
    </button>
    <div id={contentId} className="oo-pdf-prop-section-body" hidden={!open}>{children}</div>
  </section>;
}

const loadedPreviewFaces = new Map();

function ensurePreviewFace(preview) {
  if (!preview?.url || typeof FontFace !== 'function' || !globalThis.document?.fonts) return Promise.resolve('');
  const key = `${preview.url}|${preview.weight || '400'}|${preview.style || 'normal'}`;
  if (loadedPreviewFaces.has(key)) return loadedPreviewFaces.get(key);
  const family = `FernworkPicker_${loadedPreviewFaces.size + 1}`;
  const promise = new FontFace(family, `url(${JSON.stringify(preview.url)})`, {
    weight: String(preview.weight || '400'),
    style: String(preview.style || 'normal'),
  }).load().then(face => {
    document.fonts.add(face);
    return family;
  }).catch(() => '');
  loadedPreviewFaces.set(key, promise);
  return promise;
}

function PreviewLabel({ option, eager = false }) {
  const host = useRef(null);
  const [family, setFamily] = useState(option?.fontFamily || '');
  useEffect(() => {
    setFamily(option?.fontFamily || '');
    if (!option?.preview) return undefined;
    let cancelled = false;
    let observer = null;
    const load = () => { void ensurePreviewFace(option.preview).then(value => { if (!cancelled && value) setFamily(value); }); };
    if (eager || typeof IntersectionObserver !== 'function') load();
    else {
      observer = new IntersectionObserver(entries => {
        if (!entries.some(entry => entry.isIntersecting)) return;
        observer.disconnect();
        load();
      }, { rootMargin: '48px' });
      if (host.current) observer.observe(host.current);
    }
    return () => { cancelled = true; observer?.disconnect(); };
  }, [eager, option?.fontFamily, option?.preview?.url, option?.preview?.weight, option?.preview?.style]);
  return <span ref={host} className="oo-pdf-select-option-label" style={family ? { fontFamily: family } : undefined}>{option?.label || ''}</span>;
}

function flatOptions(groups) {
  return groups.flatMap(group => group.options);
}

export function InspectorSelect({
  label, value, groups = [], onChange, disabled = false, placeholder = 'Choose…', searchable = false,
  searchLabel = 'Search', emptyText = 'No options match', className = '', fontPreview = false,
  onUploadFile = null, uploadLabel = 'Upload font file…', uploadAccept = '.ttf,.otf,.ttc,font/ttf,font/otf',
  uploadDisabled = false, onOpenChange, dataValue = value,
}) {
  const controlId = useId();
  const listboxId = useId();
  const host = useRef(null);
  const panel = useRef(null);
  const searchRef = useRef(null);
  const uploadRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeValue, setActiveValue] = useState('');
  const [position, setPosition] = useState(null);
  const [uploadSequence, setUploadSequence] = useState(0);
  const options = useMemo(() => flatOptions(groups), [groups]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredGroups = useMemo(() => groups.map(group => ({
    ...group,
    options: group.options.filter(option => !normalizedQuery ||
      `${option.label || ''} ${option.tag || ''}`.toLocaleLowerCase().includes(normalizedQuery)),
  })).filter(group => group.options.length), [groups, normalizedQuery]);
  const visibleOptions = useMemo(() => flatOptions(filteredGroups), [filteredGroups]);
  const current = options.find(option => String(option.value) === String(value)) || null;
  const activeIndex = Math.max(0, visibleOptions.findIndex(option => String(option.value) === String(activeValue)));
  const close = useCallback((returnFocus = false) => {
    setOpen(false);
    setQuery('');
    onOpenChange?.(false);
    if (returnFocus) requestAnimationFrame(() => host.current?.querySelector('[role="combobox"]')?.focus());
  }, [onOpenChange]);
  const openPicker = useCallback((initialQuery = '') => {
    if (disabled) return;
    setQuery(initialQuery);
    setActiveValue(String(value || options.find(option => !option.disabled)?.value || ''));
    setOpen(true);
    onOpenChange?.(true);
  }, [disabled, onOpenChange, options, value]);
  const choose = option => {
    if (!option || option.disabled) return;
    close(false);
    onChange?.(option.value);
  };
  const moveActive = delta => {
    if (!visibleOptions.length) return;
    const next = Math.max(0, Math.min(visibleOptions.length - 1, activeIndex + delta));
    setActiveValue(String(visibleOptions[next].value));
    requestAnimationFrame(() => document.getElementById(`${controlId}-option-${next}`)?.scrollIntoView({ block: 'nearest' }));
  };
  const handleListKey = event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (event.key === 'ArrowDown') { event.preventDefault(); moveActive(1); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); moveActive(-1); return; }
    if (event.key === 'Home') { event.preventDefault(); setActiveValue(String(visibleOptions[0]?.value || '')); return; }
    if (event.key === 'End') { event.preventDefault(); setActiveValue(String(visibleOptions.at(-1)?.value || '')); return; }
    if (event.key === 'PageDown') { event.preventDefault(); moveActive(8); return; }
    if (event.key === 'PageUp') { event.preventDefault(); moveActive(-8); return; }
    if (event.key === 'Enter') {
      event.preventDefault();
      choose(visibleOptions[activeIndex]);
    }
  };
  useEffect(() => {
    if (!open) return undefined;
    const outside = event => {
      if (host.current?.contains(event.target) || panel.current?.contains(event.target)) return;
      close(false);
    };
    window.addEventListener('pointerdown', outside, true);
    return () => window.removeEventListener('pointerdown', outside, true);
  }, [close, open]);
  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const button = host.current?.querySelector('[role="combobox"]');
      if (!button) return;
      const anchor = button.getBoundingClientRect();
      const inspector = button.closest('.oo-pdf-inspector')?.getBoundingClientRect();
      const minLeft = Math.max(8, inspector?.left ?? 8);
      const maxRight = Math.min(window.innerWidth - 8, inspector?.right ?? window.innerWidth - 8);
      const width = Math.max(220, Math.min(anchor.width, maxRight - minLeft));
      const measuredHeight = Math.min(panel.current?.offsetHeight || 360, window.innerHeight - 16);
      const below = window.innerHeight - anchor.bottom - 8;
      const above = anchor.top - 8;
      const top = below >= Math.min(measuredHeight, 280) || below >= above
        ? Math.min(window.innerHeight - measuredHeight - 8, anchor.bottom + 4)
        : Math.max(8, anchor.top - measuredHeight - 4);
      const left = Math.max(minLeft, Math.min(anchor.left, maxRight - width));
      setPosition({ top, left, width, maxHeight: Math.max(180, Math.min(420, window.innerHeight - 16)) });
    };
    place();
    const frame = requestAnimationFrame(place);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, filteredGroups.length]);
  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => (searchable ? searchRef.current : panel.current)?.focus());
  }, [open, searchable]);
  useEffect(() => {
    if (!open || !visibleOptions.length) return;
    if (!visibleOptions.some(option => String(option.value) === String(activeValue))) {
      setActiveValue(String(visibleOptions[0].value));
    }
  }, [activeValue, open, visibleOptions]);
  const activeVisibleIndex = visibleOptions.findIndex(option => String(option.value) === String(activeValue));
  const popover = open ? <div className="oo-pdf-select-sheet-backdrop">
    <div ref={panel} id={listboxId} className={`oo-pdf-select-popover ${fontPreview ? 'is-font-picker' : ''}`}
      style={position || undefined} role="listbox" aria-label={label} tabIndex={searchable ? -1 : 0}
      aria-activedescendant={activeVisibleIndex >= 0 ? `${controlId}-option-${activeVisibleIndex}` : undefined}
      onKeyDown={handleListKey}>
      {searchable && <div className="oo-pdf-select-search-wrap">
        <span aria-hidden="true" dangerouslySetInnerHTML={{ __html: icon('search') }} />
        <input ref={searchRef} type="search" role="searchbox" aria-label={searchLabel} value={query}
          onChange={event => setQuery(event.target.value)} onKeyDown={handleListKey} />
      </div>}
      <div className="oo-pdf-select-options">
        {!visibleOptions.length && <div className="oo-pdf-select-empty" role="status">{emptyText}</div>}
        {filteredGroups.map(group => <div key={group.label || 'options'} className="oo-pdf-select-group" role="group" aria-label={group.label || undefined}>
          {group.label && <div className="oo-pdf-select-group-label">{group.label}</div>}
          {group.options.map(option => {
            const index = visibleOptions.indexOf(option);
            const selected = String(option.value) === String(value);
            const active = String(option.value) === String(activeValue);
            return <button key={`${group.label || 'options'}:${String(option.value)}`} id={`${controlId}-option-${index}`} type="button" role="option"
              aria-label={option.label}
              data-value={String(option.value)}
              aria-selected={selected} aria-disabled={option.disabled || undefined} disabled={option.disabled}
              className={`oo-pdf-select-option ${active ? 'is-active' : ''}`} title={option.disabledReason || option.title}
              onPointerMove={() => setActiveValue(String(option.value))} onClick={() => choose(option)}>
              {fontPreview ? <PreviewLabel option={option} /> : <span className="oo-pdf-select-option-label">{option.label}</span>}
              {option.tag && <span className="oo-pdf-select-option-tag">{option.tag}</span>}
              <span className="oo-pdf-select-check" aria-hidden="true" dangerouslySetInnerHTML={{ __html: selected ? icon('check') : '' }} />
            </button>;
          })}
        </div>)}
      </div>
      {onUploadFile && <div className="oo-pdf-select-upload" role="presentation">
        <button type="button" disabled={uploadDisabled} onClick={() => uploadRef.current?.click()}>
          <span aria-hidden="true" dangerouslySetInnerHTML={{ __html: icon('type') }} />
          <span>{uploadLabel}</span>
        </button>
      </div>}
    </div>
  </div> : null;
  return <div ref={host} className={`oo-pdf-select ${className}`}>
    <button type="button" role="combobox" aria-label={label} aria-haspopup="listbox" aria-expanded={open}
      data-value={dataValue == null ? '' : String(dataValue)}
      aria-controls={listboxId} aria-activedescendant={open && activeVisibleIndex >= 0 ? `${controlId}-option-${activeVisibleIndex}` : undefined}
      disabled={disabled} className="oo-pdf-select-trigger"
      onClick={() => open ? close(false) : openPicker()}
      onKeyDown={event => {
        if (event.key === 'Escape' && open) { event.preventDefault(); close(true); return; }
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          if (!open) openPicker();
          else handleListKey(event);
          return;
        }
        if (!open && searchable && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault(); openPicker(event.key);
        }
      }}>
      {fontPreview ? <PreviewLabel option={current || { label: placeholder }} eager /> : <span className="oo-pdf-select-value">{current?.label || placeholder}</span>}
      <span className="oo-pdf-select-chevron" aria-hidden="true" dangerouslySetInnerHTML={{ __html: icon('chevron-down') }} />
    </button>
    {onUploadFile && <input ref={uploadRef} hidden tabIndex={-1} type="file" aria-label="Upload font file" accept={uploadAccept}
      data-upload-sequence={uploadSequence}
      disabled={uploadDisabled} onChange={event => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        close(false);
        Promise.resolve(onUploadFile(file)).finally(() => setUploadSequence(current => current + 1));
      }} />}
    {popover && createPortal(popover, document.body)}
  </div>;
}

export function SimpleInspectorSelect({ label, value, options, onChange, disabled = false, className = '' }) {
  return <InspectorSelect label={label} value={value} groups={[{ label: '', options }]} onChange={onChange}
    disabled={disabled} className={className} />;
}
