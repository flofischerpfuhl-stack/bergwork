import React, { useEffect, useRef, useState } from 'react';
import { GeometryNumber } from './geometry-properties.jsx';
import { icon } from '../../../../../assets/icons.js';
const summaryIcon = icon('ruler');
import { displayPageGuides, EMPTY_GUIDES, GUIDE_UNITS, MAX_PAGE_GUIDES, rulerTicks, sourceGuideForDisplay } from '../model/layout-guides.js';

const guideId = () => `guide-${crypto.randomUUID()}`;
const dimensions = page => Math.abs(Number(page.rotation || 0) % 180) === 90
  ? { width: page.height, height: page.width } : { width: page.width, height: page.height };
const orientation = axis => axis === 'x' ? 'Vertical' : 'Horizontal';
const compact = value => String(Number(value.toFixed(2)));
const withGuide = (guides, next) => guides.some(guide => guide.id === next.id)
  ? guides.map(guide => guide.id === next.id ? next : guide) : [...guides, next];

/** Guide settings of the active page: the three placement toggles, ruler
 * units, adding guides and exact guide positions. The desktop editor shows it
 * as the "Guides & rulers" panel of the tools drawer; phones keep it in the
 * collapsible `PlacementOptions` of the "More document actions" menu. */
export function PlacementSettings({ docId, page, guides = EMPTY_GUIDES, snapEnabled, onSnapEnabledChange,
  rulersVisible, onRulersVisibleChange, guidesVisible, onGuidesVisibleChange, unit, onUnitChange, onChange, disabled,
  className = 'oo-pdf-placement-popover' }) {
  const displayed = page ? displayPageGuides(guides, page) : [];
  const size = page ? dimensions(page) : null;
  const factor = GUIDE_UNITS[unit] || 1;
  const replace = (id, axis, position) => {
    const source = sourceGuideForDisplay({ id, axis, position }, page);
    if (source) onChange(docId, page.id, withGuide(guides, source));
  };
  const add = axis => {
    replace(guideId(), axis, size[axis === 'x' ? 'width' : 'height'] / 2);
    onGuidesVisibleChange(true);
    onRulersVisibleChange(true);
  };
  return <div className={className} role="group" aria-label="Placement options">
    <label title="Snap moved and resized objects to page edges, centers and other objects. Hold Alt to move freely."><input type="checkbox" checked={snapEnabled} onChange={event => onSnapEnabledChange?.(event.target.checked)} />Snap to edges and centers</label>
    <label title="Show rulers around the page. Drag from a ruler to add a guide."><input type="checkbox" checked={rulersVisible} onChange={event => onRulersVisibleChange(event.target.checked)} />Show rulers</label>
    <label title="Show drawing guides. Guides are saved with the project and never exported."><input type="checkbox" checked={guidesVisible} onChange={event => onGuidesVisibleChange(event.target.checked)} />Show drawing guides</label>
    <label className="oo-pdf-placement-unit">Ruler units<select aria-label="Ruler units" value={unit} onChange={event => onUnitChange(event.target.value)}>
      <option value="pt">Points (pt)</option><option value="mm">Millimeters (mm)</option><option value="in">Inches (in)</option>
    </select></label>
    <div className="oo-pdf-guide-actions">
      <button type="button" className="oo-pdf-ghost-button" disabled={disabled || !page || guides.length >= MAX_PAGE_GUIDES} onClick={() => add('x')}>Add vertical guide</button>
      <button type="button" className="oo-pdf-ghost-button" disabled={disabled || !page || guides.length >= MAX_PAGE_GUIDES} onClick={() => add('y')}>Add horizontal guide</button>
    </div>
    {displayed.map((guide, index) => <div className="oo-pdf-guide-setting" key={guide.id} data-guide-setting={guide.id}>
      <GeometryNumber label={`${orientation(guide.axis)} guide ${index + 1} (${unit})`} value={guide.position / factor}
        min={0} max={size[guide.axis === 'x' ? 'width' : 'height'] / factor} step={unit === 'in' ? 0.1 : 1}
        draftKey={`${docId}:${page.id}:${guide.id}:${page.rotation}:${unit}`} disabled={disabled}
        onCommit={position => replace(guide.id, guide.axis, position * factor)} />
      <button type="button" className="oo-pdf-ghost-button" disabled={disabled} aria-label={`Delete ${orientation(guide.axis).toLowerCase()} guide ${index + 1}`}
        title="Delete guide" onClick={() => onChange(docId, page.id, guides.filter(item => item.id !== guide.id))}>Delete</button>
    </div>)}
    {guides.length >= MAX_PAGE_GUIDES && <p role="status">Maximum of {MAX_PAGE_GUIDES} guides on this page.</p>}
  </div>;
}

/** `PlacementSettings` behind a "Guides" summary (phone menu). */
export function PlacementOptions(props) {
  const { snapEnabled, rulersVisible, guidesVisible } = props;
  const host = useRef(null);
  useEffect(() => {
    // Close when the user goes back to the page; toolbar and panel clicks
    // (export, layers) keep the popover open like a docked options panel.
    const close = event => {
      const node = host.current;
      if (!node?.open || node.contains(event.target)) return;
      if (!event.target?.closest?.('.oo-pdf-viewport')) return;
      node.open = false;
    };
    const key = event => { if (event.key === 'Escape' && host.current?.open) { host.current.open = false; } };
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointerdown', close, true); window.removeEventListener('keydown', key); };
  }, []);
  const activeCount = (snapEnabled ? 1 : 0) + (rulersVisible ? 1 : 0) + (guidesVisible ? 1 : 0);
  return <details ref={host} className={`oo-pdf-placement-options ${activeCount ? 'is-active' : ''}`}>
    <summary aria-label="Positioning: snapping, rulers and guides" title="Snapping, rulers and guides">
      <span className="oo-pdf-icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: summaryIcon }} />
      <span className="oo-pdf-placement-summary-label">Positioning</span>
      {activeCount > 0 && <span className="oo-pdf-placement-count" aria-hidden="true">{activeCount}</span>}
    </summary>
    <PlacementSettings {...props} />
  </details>;
}

/** View-only compositor. Only completed gestures update the page's guide list;
 * neither drafts nor guide edits reach the PDF engine. Handles live outside
 * the page artwork so a guide cannot steal a text/image editing gesture. */
export function PagePlacementGuides({ docId, page, zoom, guides = EMPTY_GUIDES, rulersVisible, guidesVisible,
  unit = 'pt', onChange, disabled, cancelEvent }) {
  const host = useRef(null);
  const active = useRef(null);
  const [draft, setDraft] = useState(null);
  const size = dimensions(page);
  const displayed = displayPageGuides(guides, page);
  const factor = GUIDE_UNITS[unit] || 1;
  const cancel = () => {
    const drag = active.current;
    active.current = null;
    setDraft(null);
    if (drag) { try { drag.node.releasePointerCapture(drag.pointerId); } catch {} }
  };
  useEffect(() => {
    cancel();
    const onBlur = () => cancel();
    const onKey = event => {
      if (event.key !== 'Escape' || !active.current) return;
      event.preventDefault(); event.stopPropagation(); cancel();
    };
    window.addEventListener('blur', onBlur);
    window.addEventListener('keydown', onKey, true);
    if (cancelEvent) window.addEventListener(cancelEvent, onBlur);
    return () => {
      const drag = active.current;
      active.current = null;
      if (drag) { try { drag.node.releasePointerCapture(drag.pointerId); } catch {} }
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('keydown', onKey, true);
      if (cancelEvent) window.removeEventListener(cancelEvent, onBlur);
    };
  }, [docId, page.id, page.rotation, page.width, page.height, zoom, guides, rulersVisible, guidesVisible, disabled]);
  const point = (event, axis, clampPosition = true) => {
    const rect = host.current.getBoundingClientRect();
    const raw = axis === 'x' ? (event.clientX - rect.left) / zoom : (event.clientY - rect.top) / zoom;
    return clampPosition ? Math.max(0, Math.min(size[axis === 'x' ? 'width' : 'height'], raw)) : raw;
  };
  const start = (event, axis, guide = null) => {
    event.stopPropagation();
    if (event.button !== 0 || disabled || (!guide && guides.length >= MAX_PAGE_GUIDES)) return;
    event.preventDefault();
    cancel();
    const node = event.currentTarget;
    node.setPointerCapture(event.pointerId);
    const position = guide?.position ?? point(event, axis);
    active.current = { pointerId: event.pointerId, node, axis, id: guide?.id || guideId(), original: guide,
      startX: event.clientX, startY: event.clientY, moved: false, position,
      pointerOffset: guide ? point(event, axis, false) - guide.position : 0 };
    setDraft({ id: active.current.id, axis, position });
  };
  const move = event => {
    const drag = active.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) >= 3) drag.moved = true;
    drag.position = Math.max(0, Math.min(size[drag.axis === 'x' ? 'width' : 'height'],
      point(event, drag.axis, false) - drag.pointerOffset));
    setDraft({ id: drag.id, axis: drag.axis, position: drag.position });
  };
  const finish = event => {
    const drag = active.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    const raw = point(event, drag.axis, false) - drag.pointerOffset;
    const within = raw >= 0 && raw <= size[drag.axis === 'x' ? 'width' : 'height'];
    const source = sourceGuideForDisplay({ id: drag.id, axis: drag.axis,
      position: Math.max(0, Math.min(size[drag.axis === 'x' ? 'width' : 'height'], raw)) }, page);
    cancel();
    if (!drag.moved) return;
    if (within && source) onChange(docId, page.id, withGuide(guides, source));
    else if (drag.original) onChange(docId, page.id, guides.filter(guide => guide.id !== drag.id));
  };
  const key = (event, guide) => {
    if (disabled) return;
    if (['Delete', 'Backspace'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      onChange(docId, page.id, guides.filter(item => item.id !== guide.id));
      return;
    }
    const delta = guide.axis === 'x' ? { ArrowLeft: -1, ArrowRight: 1 } : { ArrowUp: -1, ArrowDown: 1 };
    if (!delta[event.key]) return;
    event.preventDefault(); event.stopPropagation();
    const position = Math.max(0, Math.min(size[guide.axis === 'x' ? 'width' : 'height'], guide.position + delta[event.key] * (event.shiftKey ? 10 : 1)));
    const source = sourceGuideForDisplay({ ...guide, position }, page);
    if (source) onChange(docId, page.id, guides.map(item => item.id === guide.id ? source : item));
  };
  const events = { onPointerMove: move, onPointerUp: finish, onPointerCancel: cancel,
    onLostPointerCapture: event => { if (active.current?.pointerId === event.pointerId) cancel(); } };
  const lines = [...(guidesVisible ? displayed : []).filter(guide => guide.id !== draft?.id), ...(draft ? [draft] : [])];
  return <div ref={host} className="oo-pdf-placement-overlay" style={{ width: size.width * zoom, height: size.height * zoom }}>
    {rulersVisible && ['x', 'y'].map(axis => <div key={axis} className={`oo-pdf-ruler axis-${axis}`}
      role="button" tabIndex={disabled ? -1 : 0} aria-disabled={disabled}
      aria-label={`${axis === 'x' ? 'Top' : 'Left'} ruler (${unit}); drag to add ${axis === 'x' ? 'horizontal' : 'vertical'} guide`}
      title={`Drag to add a ${axis === 'x' ? 'horizontal' : 'vertical'} guide; Enter adds one at the center`}
      onPointerDown={event => start(event, axis === 'x' ? 'y' : 'x')} {...events}
      onKeyDown={event => {
        if (!['Enter', ' '].includes(event.key) || disabled || guides.length >= MAX_PAGE_GUIDES) return;
        event.preventDefault(); event.stopPropagation();
        const guideAxis = axis === 'x' ? 'y' : 'x';
        const source = sourceGuideForDisplay({ id: guideId(), axis: guideAxis, position: size[guideAxis === 'x' ? 'width' : 'height'] / 2 }, page);
        if (source) onChange(docId, page.id, [...guides, source]);
      }}>
      <svg aria-hidden="true" width="100%" height="100%">
        {rulerTicks(size[axis === 'x' ? 'width' : 'height'], zoom, unit).map(tick => <g key={tick.position}>
          <line x1={axis === 'x' ? tick.position * zoom : tick.major ? 27 : 33} y1={axis === 'x' ? tick.major ? 27 : 33 : tick.position * zoom}
            x2={axis === 'x' ? tick.position * zoom : 44} y2={axis === 'x' ? 44 : tick.position * zoom} />
          {tick.major && <text x={axis === 'x' ? tick.position * zoom + 3 : 3} y={axis === 'x' ? 18 : tick.position * zoom + 12}>{tick.label}</text>}
        </g>)}
      </svg>
    </div>)}
    {lines.map(guide => <React.Fragment key={guide.id}>
      <div className={`oo-pdf-manual-guide axis-${guide.axis}`} data-pdf-manual-guide={guide.id} data-guide-position={guide.position}
        aria-hidden="true" style={guide.axis === 'x' ? { left: guide.position * zoom } : { top: guide.position * zoom }} />
      {(rulersVisible || draft?.id === guide.id) && <button type="button" className={`oo-pdf-guide-handle axis-${guide.axis}`}
        disabled={disabled} aria-label={`${orientation(guide.axis)} guide at ${compact(guide.position / factor)} ${unit}`}
        title="Drag to move; arrow keys adjust; Delete removes; Escape cancels a drag"
        style={guide.axis === 'x' ? { left: Math.max(0, Math.min(size.width * zoom - 44, guide.position * zoom - 22)) }
          : { top: Math.max(0, Math.min(size.height * zoom - 44, guide.position * zoom - 22)) }}
        onPointerDown={event => start(event, guide.axis, guide)} {...events} onKeyDown={event => key(event, guide)}>
        <span aria-hidden="true">{guide.axis === 'x' ? '▼' : '▶'}</span>
      </button>}
    </React.Fragment>)}
    {draft && <output className="oo-pdf-guide-feedback" aria-live="off">{orientation(draft.axis)}: {compact(draft.position / factor)} {unit}</output>}
  </div>;
}
