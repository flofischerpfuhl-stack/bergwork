// berg:work: measuring on the page (Markup › Measure): distance, perimeter, area and scale calibration; and the
// comment markups drawn the same way (Markup › Comment): polyline, polygon, cloud, callout, stamp.
//
// The layer draws what is being measured, snaps to corners and line ends of the page's PDF paths (and of other
// measurements), constrains to 45° with Shift and shows the value at the pointer. In Edit PDF it makes the page's
// measurements selectable: drag a corner or the whole measurement, Delete removes it. The PDF itself is changed by
// the shell (see commitMeasureChange there): measurements are real PDF annotations with /Measure, so the layer only
// paints hit areas and handles over PDFium's rendering of their appearance.
//
// The shell publishes the document's measurements and its actions through `measureStore`, so this layer needs no
// props threaded through the page tree and re-renders only when measuring state changes.

import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { icon } from '../../../../../assets/icons.js';
import {
  constrainTo45, defaultScale, formatMeasure, formatNumber, MEASURE_LABELS, MEASURE_UNIT_IDS, MEASURE_UNITS,
  nearestPoint, pathVerticesFromObjects, PT_IN_METERS, scaleForPoint, viewportForPoint,
} from '../model/pdf-measure.js';
import { useCommentToolSettings } from './comment-tools.jsx';

export const MEASURE_TOOL_IDS = Object.freeze(['measure-distance', 'measure-perimeter', 'measure-area', 'measure-calibrate']);
export const MEASURE_TOOL_SET = new Set(MEASURE_TOOL_IDS);
export const MEASURE_TOOLBAR_TOOLS = Object.freeze([
  { id: 'measure-distance', label: 'Distance', icon: 'measure-distance' },
  { id: 'measure-perimeter', label: 'Perimeter', icon: 'measure-perimeter' },
  { id: 'measure-area', label: 'Area', icon: 'measure-area' },
  { id: 'measure-calibrate', label: 'Calibrate scale', icon: 'ruler' },
]);
const KIND_FOR_TOOL = { 'measure-distance': 'distance', 'measure-perimeter': 'perimeter', 'measure-area': 'area',
  'measure-calibrate': 'calibrate' };
const MEASURE_KIND_SET = new Set(['distance', 'perimeter', 'area']);
const TWO_POINT_KINDS = new Set(['distance', 'calibrate', 'callout']);
const CLOSED_KINDS = new Set(['area', 'polygon', 'cloud']);
const MARKUP_LABELS = { polyline: 'Polyline', polygon: 'Polygon', cloud: 'Cloud', stamp: 'Stamp', callout: 'Callout' };

/** What a click with `tool` draws: a measure kind, a markup kind (from the comment tool settings) or ''. */
function kindForTool(tool, comment) {
  if (KIND_FOR_TOOL[tool]) return KIND_FOR_TOOL[tool];
  if (tool === 'markup-shape') return comment.shapeKind || 'polygon';
  if (tool === 'textbox' && comment.textboxStyle === 'callout') return 'callout';
  if (tool === 'stamp') return 'stamp';
  return '';
}

const SETTINGS_KEY = 'bergwork.pdf.measure';
const DEFAULT_SETTINGS = Object.freeze({ color: '#e03131', width: 1, fontSize: 9, unit: 'm' });

function loadSettings() {
  try {
    const stored = JSON.parse(globalThis.localStorage?.getItem(SETTINGS_KEY) || 'null');
    return { ...DEFAULT_SETTINGS, ...(stored && typeof stored === 'object' ? stored : {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Store shared by the shell (writer) and the page layers / options bar (readers).

let state = {
  docId: '',
  items: [],
  viewports: {},
  activePageId: '',
  selectedId: '',
  pending: 0,
  ready: false,
  settings: loadSettings(),
  actions: {},
};
const listeners = new Set();

export const measureStore = {
  get: () => state,
  set(patch) {
    const next = typeof patch === 'function' ? patch(state) : patch;
    if (!next || Object.keys(next).every(key => Object.is(state[key], next[key]))) return;
    state = { ...state, ...next };
    for (const listener of [...listeners]) listener();
  },
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  setSettings(patch) {
    const settings = { ...state.settings, ...patch };
    try { globalThis.localStorage?.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* private mode */ }
    measureStore.set({ settings });
  },
};

export function useMeasureState() {
  return useSyncExternalStore(measureStore.subscribe, measureStore.get, measureStore.get);
}

// ---------------------------------------------------------------------------------------------------------------
// Page geometry: display space is the rotated page in pt with the origin top left (the shell's `pageCoords`),
// PDF space the page's user space (y up), offset by its crop box.

function pageDisplaySize(page) {
  const rotated = Math.abs(Number(page?.rotation || 0)) % 180 === 90;
  return rotated ? { width: Number(page.height), height: Number(page.width) } : { width: Number(page.width), height: Number(page.height) };
}

function viewBoxOf(page) {
  return Array.isArray(page?.viewBox) && page.viewBox.length === 4
    ? page.viewBox.map(Number) : [0, 0, Number(page?.width || 0), Number(page?.height || 0)];
}

const normalized = degrees => ((Number(degrees || 0) % 360) + 360) % 360;

export function pdfToDisplay(page, point) {
  const box = viewBoxOf(page);
  const sx = Number(point.x) - box[0];
  const sy = box[3] - Number(point.y);
  const width = Number(page.width), height = Number(page.height);
  switch (normalized(page.rotation)) {
    case 90: return { x: height - sy, y: sx };
    case 180: return { x: width - sx, y: height - sy };
    case 270: return { x: sy, y: width - sx };
    default: return { x: sx, y: sy };
  }
}

export function displayToPdf(page, point) {
  const box = viewBoxOf(page);
  const width = Number(page.width), height = Number(page.height);
  const { x, y } = point;
  let sx = x, sy = y;
  switch (normalized(page.rotation)) {
    case 90: sx = y; sy = height - x; break;
    case 180: sx = width - x; sy = height - y; break;
    case 270: sx = width - y; sy = x; break;
    default: break;
  }
  return { x: box[0] + sx, y: box[3] - sy };
}

// A coarse grid over snap points, so a pointer move looks at a few cells instead of every vertex of a plan.
function createSnapGrid(points, cell = 24) {
  const grid = new Map();
  for (const point of points) {
    const key = `${Math.floor(point.x / cell)}:${Math.floor(point.y / cell)}`;
    let bucket = grid.get(key);
    if (!bucket) grid.set(key, bucket = []);
    bucket.push(point);
  }
  return {
    nearest(point, threshold) {
      const reach = Math.ceil(threshold / cell);
      const cx = Math.floor(point.x / cell), cy = Math.floor(point.y / cell);
      const candidates = [];
      for (let dx = -reach; dx <= reach; dx += 1) {
        for (let dy = -reach; dy <= reach; dy += 1) {
          const bucket = grid.get(`${cx + dx}:${cy + dy}`);
          if (bucket) candidates.push(...bucket);
        }
      }
      return nearestPoint(point, candidates, threshold);
    },
  };
}

const Icon = ({ name }) => <span className="oo-pdf-icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: icon(name) }} />;

const isTypingTarget = target => Boolean(target?.closest?.('input, textarea, select, [contenteditable="true"]'));

function itemDisplayPoints(page, item) {
  const points = item.kind === 'stamp' ? rectCorners(item.rect) : (item.points || []);
  return points.map(point => pdfToDisplay(page, point));
}

function pathData(points, zoom, closed = false) {
  if (!points.length) return '';
  return points.map((point, index) => `${index ? 'L' : 'M'}${(point.x * zoom).toFixed(2)} ${(point.y * zoom).toFixed(2)}`)
    .join(' ') + (closed ? ' Z' : '');
}

// ---------------------------------------------------------------------------------------------------------------

/** The measuring layer of one page. Renders nothing unless a measure tool is active or the page has measurements. */
export function MeasureLayer({ page, zoom, tool, snapObjects = [], selectable = false }) {
  const measure = useMeasureState();
  const comment = useCommentToolSettings();
  const kind = kindForTool(tool, comment);
  const active = Boolean(kind) && measure.docId && measure.ready;
  const items = useMemo(() => [...measure.items, ...(measure.markups || [])].filter(item => item.pageId === page.id),
    [measure.items, measure.markups, page.id]);
  const viewports = measure.viewports[page.id] || [];
  const svgRef = useRef(null);
  const [draft, setDraft] = useState(null); // { kind, points: [pdf], hover: pdf | null, snapped: bool }
  const [ghost, setGhost] = useState(null); // committed but not yet back from the PDF
  const [calibration, setCalibration] = useState(null); // { points: [pdf, pdf] }
  const [calloutDraft, setCalloutDraft] = useState(null); // { points: [tip, anchor] } waiting for its text
  const [edit, setEdit] = useState(null); // { id, points } while dragging a measurement or one of its corners
  const [hoverPoint, setHoverPoint] = useState(null); // { point, snapped, clientX, clientY }
  const gestureRef = useRef(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const size = pageDisplaySize(page);
  const selected = items.find(item => item.id === measure.selectedId) || null;

  const snapGrid = useMemo(() => {
    if (!active && !selected) return null;
    const points = [...pathVerticesFromObjects(snapObjects), ...items.flatMap(item => item.points || [])];
    return createSnapGrid(points);
  }, [active, items, selected, snapObjects]);

  // Cancel a half-drawn measurement when the tool changes or the page leaves.
  useEffect(() => {
    setDraft(null);
    setCalibration(null);
    setCalloutDraft(null);
  }, [tool, page.id, kind]);

  const eventPoint = useCallback((event, anchor = null, { snap = true } = {}) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return { point: null, snapped: false };
    let display = { x: (event.clientX - rect.left) / zoom, y: (event.clientY - rect.top) / zoom };
    let point = displayToPdf(page, display);
    let snapped = false;
    if (anchor && event.shiftKey) {
      // The 45° grid is in display space, so it follows what the user sees on rotated pages too.
      display = constrainTo45(pdfToDisplay(page, anchor), display);
      point = displayToPdf(page, display);
    } else if (snap && !event.ctrlKey && !event.metaKey && snapGrid) { // berg:work: Ctrl/⌘ measures without snapping (Figma)
      const target = snapGrid.nearest(point, 8 / Math.max(0.05, zoom));
      if (target) {
        point = { x: target.x, y: target.y };
        snapped = true;
      }
    }
    return { point, snapped };
  }, [page, snapGrid, zoom]);

  const scaleAt = useCallback(point => scaleForPoint(viewports, point, defaultScale()), [viewports]);

  const finish = useCallback((points, finishedKind) => {
    setDraft(null);
    if (finishedKind === 'calibrate') {
      setCalibration({ points });
      return;
    }
    if (finishedKind === 'callout') {
      setCalloutDraft({ points });
      return;
    }
    const minimum = CLOSED_KINDS.has(finishedKind) ? 3 : finishedKind === 'stamp' ? 1 : 2;
    if (points.length < minimum) return;
    const run = MEASURE_KIND_SET.has(finishedKind)
      ? measure.actions.commit?.({ pageId: page.id, kind: finishedKind, points, scale: scaleAt(points[0]) })
      : finishedKind === 'stamp'
        ? measure.actions.commitStamp?.({ pageId: page.id, center: points[0] })
        : measure.actions.commitShape?.({ pageId: page.id, kind: finishedKind, points });
    if (finishedKind !== 'stamp') setGhost({ kind: finishedKind, points });
    Promise.resolve(run).catch(() => {}).finally(() => setGhost(null));
  }, [measure.actions, page.id, scaleAt]);

  // Keys while drawing: Enter finishes a perimeter or area, Backspace takes the last corner back, Escape cancels.
  // With a measurement selected: Delete removes it, Escape lets it go.
  useEffect(() => {
    if (!draft && !selected) return undefined;
    const key = event => {
      if (isTypingTarget(event.target)) return;
      const current = draftRef.current;
      if (current) {
        if (event.key === 'Escape') {
          setDraft(null);
        } else if (event.key === 'Enter' && !TWO_POINT_KINDS.has(current.kind)) {
          finish(current.points, current.kind);
        } else if (event.key === 'Backspace' || event.key === 'Delete') {
          if (current.points.length <= 1) setDraft(null);
          else setDraft({ ...current, points: current.points.slice(0, -1) });
        } else {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (selected && (event.key === 'Delete' || event.key === 'Backspace')) {
        event.preventDefault();
        event.stopPropagation();
        measure.actions.remove?.(selected);
      } else if (selected && event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        measureStore.set({ selectedId: '' });
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [Boolean(draft), finish, measure.actions, selected]);

  // A press anywhere outside the measurement UI lets the selected measurement go.
  useEffect(() => {
    if (!selected) return undefined;
    const down = event => {
      if (!event.target?.closest?.('[data-measure-ui]')) measureStore.set({ selectedId: '' });
    };
    window.addEventListener('pointerdown', down, true);
    return () => window.removeEventListener('pointerdown', down, true);
  }, [selected]);

  // --- drawing ------------------------------------------------------------------------------------------------
  const drawDown = event => {
    if (!active || calibration || calloutDraft || (event.button != null && event.button !== 0)) return;
    if (event.pointerType === 'touch' && !event.isPrimary) return;
    event.preventDefault();
    event.stopPropagation();
    measureStore.set({ selectedId: '' });
    const current = draftRef.current;
    const anchor = current?.points[current.points.length - 1] || null;
    const { point, snapped } = eventPoint(event, anchor);
    if (!point) return;
    try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* synthetic pointer */ }
    gestureRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
    const twoPoint = TWO_POINT_KINDS.has(kind);
    if (kind === 'stamp') {
      finish([point], 'stamp');
      return;
    }
    if (!current) {
      setDraft({ kind, points: [point], hover: point, snapped });
      return;
    }
    if (twoPoint) {
      finish([current.points[0], point], kind);
      return;
    }
    const last = current.points[current.points.length - 1];
    const lastDisplay = pdfToDisplay(page, last);
    const display = pdfToDisplay(page, point);
    const sameAsLast = Math.hypot(lastDisplay.x - display.x, lastDisplay.y - display.y) * zoom < 4;
    const firstDisplay = pdfToDisplay(page, current.points[0]);
    const onFirst = CLOSED_KINDS.has(kind) && current.points.length >= 3 &&
      Math.hypot(firstDisplay.x - display.x, firstDisplay.y - display.y) * zoom < 8;
    if (onFirst) {
      finish(current.points, kind);
      return;
    }
    if (sameAsLast) return; // the second click of a double click; dblclick finishes
    setDraft({ ...current, points: [...current.points, point], hover: point, snapped });
  };

  const drawMove = event => {
    if (!active || calibration || calloutDraft) return;
    const current = draftRef.current;
    const anchor = current?.points[current.points.length - 1] || null;
    const { point, snapped } = eventPoint(event, anchor);
    if (!point) return;
    if (current) setDraft({ ...current, hover: point, snapped });
    setHoverPoint({ point, snapped, clientX: event.clientX, clientY: event.clientY });
  };

  const drawUp = event => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    if (!active || !gesture || gesture.id !== event.pointerId) return;
    const current = draftRef.current;
    if (!current || current.points.length !== 1 || !TWO_POINT_KINDS.has(current.kind)) return;
    // Press, drag, release draws a distance in one gesture; a click without drag waits for the second click.
    if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 5) return;
    const { point } = eventPoint(event, current.points[0]);
    if (point) finish([current.points[0], point], current.kind);
  };

  const drawDoubleClick = event => {
    const current = draftRef.current;
    if (!active || !current || TWO_POINT_KINDS.has(current.kind)) return;
    event.preventDefault();
    event.stopPropagation();
    finish(current.points, current.kind);
  };

  // --- editing existing measurements (Edit PDF) ---------------------------------------------------------------
  const editDown = (event, item, vertexIndex = -1) => {
    if (event.button != null && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    measure.actions.select?.(item);
    measureStore.set({ selectedId: item.id });
    try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* synthetic pointer */ }
    gestureRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY, item, vertexIndex,
      start: displayToPdf(page, {
        x: (event.clientX - svgRef.current.getBoundingClientRect().left) / zoom,
        y: (event.clientY - svgRef.current.getBoundingClientRect().top) / zoom,
      }),
      moved: false };
  };
  const editMove = event => {
    const gesture = gestureRef.current;
    if (!gesture?.item || gesture.id !== event.pointerId) return;
    if (!gesture.moved && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 3) return;
    gesture.moved = true;
    const original = gesture.item.kind === 'stamp' ? rectCorners(gesture.item.rect) : gesture.item.points;
    if (gesture.vertexIndex >= 0) {
      const neighbour = original[gesture.vertexIndex - 1] || original[gesture.vertexIndex + 1] || null;
      const { point } = eventPoint(event, neighbour);
      if (!point) return;
      setEdit({ id: gesture.item.id, points: original.map((value, index) => (index === gesture.vertexIndex ? point : value)) });
    } else {
      const { point } = eventPoint(event, null, { snap: false });
      if (!point) return;
      const dx = point.x - gesture.start.x, dy = point.y - gesture.start.y;
      setEdit({ id: gesture.item.id, points: original.map(value => ({ x: value.x + dx, y: value.y + dy })), dx, dy });
    }
    setHoverPoint({ clientX: event.clientX, clientY: event.clientY });
  };
  const editUp = event => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    if (!gesture?.item || gesture.id !== event.pointerId) return;
    const changed = edit && edit.id === gesture.item.id ? edit.points : null;
    if (!gesture.moved || !changed) {
      setEdit(null);
      return;
    }
    // A whole measurement is rewritten (its caption follows); markups move as they are, a corner edit redraws them.
    const run = MEASURE_KIND_SET.has(gesture.item.kind)
      ? measure.actions.update?.(gesture.item, changed)
      : gesture.vertexIndex < 0
        ? measure.actions.translate?.(gesture.item, edit.dx, edit.dy)
        : measure.actions.updateShape?.(gesture.item, changed);
    Promise.resolve(run).catch(() => {}).finally(() => setEdit(null));
  };

  if (!active && !(selectable && items.length) && !ghost) return null;

  const width = size.width * zoom;
  const height = size.height * zoom;
  const draftPoints = draft ? [...draft.points, ...(draft.hover ? [draft.hover] : [])] : [];
  const draftDisplay = draftPoints.map(point => pdfToDisplay(page, point));
  const readoutPoints = edit ? edit.points : draftPoints;
  const readoutKind = edit ? (items.find(item => item.id === edit.id)?.kind || '') : draft?.kind || '';
  let readout = '';
  if (!MEASURE_KIND_SET.has(readoutKind) && readoutKind !== 'calibrate' && kind !== 'calibrate' && !MEASURE_KIND_SET.has(kind)) {
    readout = edit ? ''
      : kind === 'stamp' ? 'Click to place the stamp'
        : draft && CLOSED_KINDS.has(draft.kind) ? 'Click the corners; Enter finishes'
          : draft?.kind === 'polyline' ? 'Click the points; Enter finishes'
            : draft?.kind === 'callout' ? 'Click where the text goes' : kind === 'callout' ? 'Click what the callout points at' : '';
  } else if (readoutKind && readoutPoints.length >= 2) {
    if (readoutKind === 'calibrate') {
      const pt = Math.hypot(readoutPoints[1].x - readoutPoints[0].x, readoutPoints[1].y - readoutPoints[0].y);
      readout = `${formatNumber(pt * PT_IN_METERS * 1000, 1)} mm on the page`;
    } else {
      const scale = edit ? items.find(item => item.id === edit.id)?.scale || scaleAt(readoutPoints[0]) : scaleAt(readoutPoints[0]);
      readout = formatMeasure(readoutKind, readoutPoints, scale);
      if (readoutKind === 'area' && readoutPoints.length < 3) readout = 'Click the next corner';
      if (scale.source === 'default' && !edit) readout += ' (1:1, not calibrated)';
    }
  } else if (draft?.kind === 'area' || draft?.kind === 'perimeter') {
    readout = 'Click the next corner';
  }
  const snapMarker = (draft?.snapped && draft.hover) || hoverPoint?.snapped
    ? pdfToDisplay(page, draft?.hover || hoverPoint.point) : null;
  const svgRect = svgRef.current?.getBoundingClientRect();

  return (
    <>
      <svg
        ref={svgRef}
        className={`oo-pdf-measure-layer ${active ? 'is-drawing' : ''}`}
        data-measure-ui=""
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        style={{ width, height }}
        onPointerDown={active ? drawDown : undefined}
        onPointerMove={active ? drawMove : editMove}
        onPointerUp={active ? drawUp : editUp}
        onPointerCancel={() => { gestureRef.current = null; setEdit(null); }}
        onPointerLeave={() => setHoverPoint(null)}
        onDoubleClick={active ? drawDoubleClick : undefined}
        aria-label={active ? `${MEASURE_LABELS[kind] || MARKUP_LABELS[kind] || 'Calibrate scale'}: click on the page` : 'Measurements and markups'}
      >
        {active && <rect className="oo-pdf-measure-capture" x="0" y="0" width={width} height={height} />}
        {items.map(item => {
          const points = edit?.id === item.id ? edit.points.map(point => pdfToDisplay(page, point)) : itemDisplayPoints(page, item);
          const isSelected = selected?.id === item.id;
          const interactive = selectable && !active;
          const closed = CLOSED_KINDS.has(item.kind);
          if (item.kind === 'stamp') {
            return (
              <g key={item.id} className={`oo-pdf-measure-item is-stamp ${isSelected ? 'is-selected' : ''}`} data-measure-id={item.id}>
                {interactive && <path className="oo-pdf-measure-hit is-area" d={pathData(points, zoom, true)} onPointerDown={event => editDown(event, item)} />}
                {(isSelected || edit?.id === item.id) && <path className="oo-pdf-measure-outline" d={pathData(points, zoom, true)} />}
              </g>
            );
          }
          return (
            <g key={item.id} className={`oo-pdf-measure-item ${isSelected ? 'is-selected' : ''}`} data-measure-id={item.id}>
              {interactive && (
                <path className="oo-pdf-measure-hit" d={pathData(points, zoom, closed)}
                  onPointerDown={event => editDown(event, item)} />
              )}
              {(isSelected || edit?.id === item.id) && (
                <path className="oo-pdf-measure-outline" d={pathData(points, zoom, closed)} />
              )}
              {interactive && isSelected && points.map((point, index) => (
                <circle key={index} className="oo-pdf-measure-handle" cx={point.x * zoom} cy={point.y * zoom} r="5"
                  onPointerDown={event => editDown(event, item, index)} />
              ))}
            </g>
          );
        })}
        {ghost && (
          <path className="oo-pdf-measure-draft is-pending" style={{ stroke: measure.settings.color }}
            d={pathData(ghost.points.map(point => pdfToDisplay(page, point)), zoom, CLOSED_KINDS.has(ghost.kind))} />
        )}
        {(calibration || calloutDraft) && (
          <path className="oo-pdf-measure-draft is-calibration"
            d={pathData((calibration || calloutDraft).points.map(point => pdfToDisplay(page, point)), zoom)} />
        )}
        {draft && draftDisplay.length >= 1 && (
          <>
            {(draft.kind === 'area' || draft.kind === 'polygon') && draftDisplay.length >= 3 && (
              <path className="oo-pdf-measure-fill" style={{ fill: measure.settings.color }} d={pathData(draftDisplay, zoom, true)} />
            )}
            <path className={`oo-pdf-measure-draft ${draft.kind === 'calibrate' ? 'is-calibration' : ''}`}
              style={draft.kind === 'calibrate' ? undefined : { stroke: MEASURE_KIND_SET.has(draft.kind) ? measure.settings.color : comment.shapeColor }}
              d={pathData(draftDisplay, zoom, CLOSED_KINDS.has(draft.kind) && draftDisplay.length >= 3)} />
            {draftDisplay.slice(0, draft.points.length).map((point, index) => (
              <circle key={index} className="oo-pdf-measure-vertex" cx={point.x * zoom} cy={point.y * zoom} r="3" />
            ))}
          </>
        )}
        {snapMarker && (
          <rect className="oo-pdf-measure-snap" x={snapMarker.x * zoom - 5} y={snapMarker.y * zoom - 5} width="10" height="10" />
        )}
      </svg>
      {readout && hoverPoint?.clientX != null && createPortal(
        <div className="oo-pdf-gesture-readout oo-pdf-measure-readout" role="status" aria-live="off"
          style={{ left: Math.min(hoverPoint.clientX + 16, window.innerWidth - 200), top: Math.min(hoverPoint.clientY + 18, window.innerHeight - 36) }}>
          {readout}
        </div>,
        document.body,
      )}
      {selected && !edit && svgRect && createPortal(
        <MeasureChip item={selected} page={page} zoom={zoom} svgRect={svgRect} onRemove={() => measure.actions.remove?.(selected)} />,
        document.body,
      )}
      {calloutDraft && svgRect && createPortal(
        <CalloutTextDialog
          anchor={(() => {
            const b = pdfToDisplay(page, calloutDraft.points[1]);
            return { x: svgRect.left + b.x * zoom, y: svgRect.top + b.y * zoom };
          })()}
          onCancel={() => setCalloutDraft(null)}
          onApply={async value => {
            await measure.actions.commitCallout?.({ pageId: page.id, tip: calloutDraft.points[0], anchor: calloutDraft.points[1], value });
            setCalloutDraft(null);
          }}
        />,
        document.body,
      )}
      {calibration && svgRect && createPortal(
        <CalibrationDialog
          points={calibration.points}
          anchor={(() => {
            const a = pdfToDisplay(page, calibration.points[0]);
            const b = pdfToDisplay(page, calibration.points[1]);
            return { x: svgRect.left + (a.x + b.x) / 2 * zoom, y: svgRect.top + Math.max(a.y, b.y) * zoom };
          })()}
          defaultUnit={measure.settings.unit}
          onCancel={() => setCalibration(null)}
          onApply={async (length, unit) => {
            measureStore.setSettings({ unit });
            await measure.actions.calibrate?.({ pageId: page.id, points: calibration.points, length, unit });
            setCalibration(null);
          }}
        />,
        document.body,
      )}
    </>
  );
}

function rectCorners(rect) {
  if (!rect) return [];
  return [{ x: rect[0], y: rect[1] }, { x: rect[2], y: rect[1] }, { x: rect[2], y: rect[3] }, { x: rect[0], y: rect[3] }];
}

function CalloutTextDialog({ anchor, onApply, onCancel }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  const submit = async event => {
    event?.preventDefault();
    if (!value.trim()) { setError('Type the callout text.'); return; }
    setBusy(true);
    try { await onApply(value); } catch (applyError) { setError(applyError?.message || 'The callout could not be added.'); setBusy(false); }
  };
  return (
    <form className="oo-pdf-measure-calibrate oo-pdf-callout-dialog" data-measure-ui="" role="dialog" aria-label="Callout text"
      style={{ left: Math.max(8, Math.min(anchor.x - 20, window.innerWidth - 316)), top: Math.min(anchor.y + 14, window.innerHeight - 170) }}
      onSubmit={submit}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.stopPropagation(); onCancel(); }
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) submit(event);
      }}>
      <strong>Callout</strong>
      <textarea ref={inputRef} rows="3" aria-label="Callout text" value={value} placeholder="Text"
        onChange={event => { setValue(event.target.value); setError(''); }} />
      <div className="oo-pdf-measure-calibrate-row">
        <button type="submit" className="oo-pdf-primary-button" disabled={busy} title="Ctrl+Enter">Add</button>
        <button type="button" className="oo-pdf-ghost-button" onClick={onCancel}>Cancel</button>
      </div>
      {error && <span className="oo-pdf-measure-error" role="alert">{error}</span>}
    </form>
  );
}

function MeasureChip({ item, page, zoom, svgRect, onRemove }) {
  const points = itemDisplayPoints(page, item);
  const top = Math.min(...points.map(point => point.y)) * zoom + svgRect.top;
  const left = Math.min(...points.map(point => point.x)) * zoom + svgRect.left;
  if (!MEASURE_KIND_SET.has(item.kind)) {
    return (
      <div className="oo-pdf-measure-chip" data-measure-ui="" role="toolbar" aria-label={MARKUP_LABELS[item.kind] || 'Markup'}
        style={{ left: Math.max(8, Math.min(left, window.innerWidth - 260)), top: Math.max(8, top - 44) }}>
        <strong>{MARKUP_LABELS[item.kind] || 'Markup'}</strong>
        {item.author && <span className="oo-pdf-measure-chip-kind">{item.author}</span>}
        <button type="button" className="oo-pdf-icon-button" aria-label="Delete" title="Delete (Del)" onClick={onRemove}>
          <Icon name="trash-2" />
        </button>
      </div>
    );
  }
  const value = `${formatNumber(item.value, item.scale?.precision ?? 2)} ${item.unitLabel}`;
  return (
    <div className="oo-pdf-measure-chip" data-measure-ui="" role="toolbar" aria-label={`${MEASURE_LABELS[item.kind]} measurement`}
      style={{ left: Math.max(8, Math.min(left, window.innerWidth - 260)), top: Math.max(8, top - 44) }}>
      <span className="oo-pdf-measure-chip-kind">{MEASURE_LABELS[item.kind]}</span>
      <strong>{value}</strong>
      {item.kind === 'area' && Number.isFinite(item.perimeter) && (
        <span>· {formatNumber(item.perimeter, item.scale?.precision ?? 2)} {item.scale?.unitLabel}</span>
      )}
      {item.scale?.label && <span className="oo-pdf-measure-chip-scale">{item.scale.label}</span>}
      <button type="button" className="oo-pdf-icon-button" aria-label="Delete measurement" title="Delete measurement (Del)" onClick={onRemove}>
        <Icon name="trash-2" />
      </button>
    </div>
  );
}

function CalibrationDialog({ points, anchor, defaultUnit = 'm', onApply, onCancel }) {
  const [value, setValue] = useState('');
  const [unit, setUnit] = useState(MEASURE_UNITS[defaultUnit] ? defaultUnit : 'm');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  const pt = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
  const submit = async event => {
    event?.preventDefault();
    const length = Number(String(value).replace(',', '.'));
    if (!(length > 0)) {
      setError('Enter the real length of the line.');
      return;
    }
    setBusy(true);
    try {
      await onApply(length, unit);
    } catch (applyError) {
      setError(applyError?.message || 'The scale could not be set.');
      setBusy(false);
    }
  };
  return (
    <form className="oo-pdf-measure-calibrate" data-measure-ui="" role="dialog" aria-label="Calibrate scale"
      style={{ left: Math.max(8, Math.min(anchor.x - 150, window.innerWidth - 316)), top: Math.min(anchor.y + 14, window.innerHeight - 150) }}
      onSubmit={submit}
      onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onCancel(); } }}>
      <strong>Calibrate scale</strong>
      <div className="oo-pdf-measure-calibrate-row">
        <input ref={inputRef} type="text" inputMode="decimal" aria-label="Real length" value={value} placeholder="Real length"
          title={`The line is ${formatNumber(pt * PT_IN_METERS * 1000, 1)} mm on the page. How long is it in reality?`}
          onChange={event => { setValue(event.target.value); setError(''); }} />
        <select aria-label="Unit" value={unit} onChange={event => setUnit(event.target.value)}>
          {MEASURE_UNIT_IDS.map(id => <option key={id} value={id}>{MEASURE_UNITS[id].label}</option>)}
        </select>
        <button type="submit" className="oo-pdf-primary-button" disabled={busy}>Set scale</button>
        <button type="button" className="oo-pdf-ghost-button" onClick={onCancel}>Cancel</button>
      </div>
      {error && <span className="oo-pdf-measure-error" role="alert">{error}</span>}
    </form>
  );
}

// ---------------------------------------------------------------------------------------------------------------

/** Options of the measure tools, in the tool options bar: page scale, ratio, colour, CSV export. */
export function MeasureOptionsBar({ tool, onToolChange }) {
  const measure = useMeasureState();
  const viewports = measure.viewports[measure.activePageId] || [];
  const pageItems = measure.items.filter(item => item.pageId === measure.activePageId);
  const pageScale = viewports.length ? (viewportForPoint(viewports, {
    x: (viewports[0].bbox[0] + viewports[0].bbox[2]) / 2, y: (viewports[0].bbox[1] + viewports[0].bbox[3]) / 2,
  }) || viewports[0]).scale : null;
  const [ratio, setRatio] = useState('');
  const [unit, setUnit] = useState(MEASURE_UNITS[measure.settings.unit] ? measure.settings.unit : 'm');
  useEffect(() => {
    setRatio(pageScale?.ratio ? String(Number(pageScale.ratio.toPrecision(6))) : '');
    if (pageScale?.unit && MEASURE_UNITS[pageScale.unit]) setUnit(pageScale.unit);
  }, [measure.activePageId, pageScale?.factor]);
  const active = MEASURE_TOOLBAR_TOOLS.find(item => item.id === tool);
  const source = !pageScale ? '(measures 1:1 in mm)' : viewports.some(viewport => viewport.own) ? 'set in berg:work' : 'from the PDF';
  const applyRatio = event => {
    event.preventDefault();
    const value = Number(String(ratio).replace(',', '.').replace(/^1\s*:\s*/u, ''));
    if (!(value > 0)) return;
    measureStore.setSettings({ unit });
    measure.actions.setRatio?.({ pageId: measure.activePageId, ratio: value, unit });
  };
  const unsupported = viewports.find(viewport => viewport.unsupported);
  return (
    <div className={`oo-pdf-contextbar tool-${tool} oo-pdf-measure-options`} role="toolbar" aria-label={`${active?.label || 'Measure'} options`}>
      <span className="oo-pdf-context-title"><Icon name={active?.icon || 'ruler'} /><strong>{active?.label || 'Measure'}</strong></span>
      <span className="oo-pdf-measure-scale" title={unsupported ? `This page also has a ${unsupported.unsupported} viewport, which berg:work cannot measure with.` : undefined}>
        Scale <strong>{pageScale?.label || 'not set'}</strong> <span className="oo-pdf-context-value">{source}</span>
      </span>
      {tool !== 'measure-calibrate' && (
        <button type="button" onClick={() => onToolChange?.('measure-calibrate')} title="Click two points and enter their real distance">
          <Icon name="ruler" /><span>Calibrate</span>
        </button>
      )}
      <form className="oo-pdf-measure-ratio" onSubmit={applyRatio}>
        <label>1 : <input type="text" inputMode="decimal" aria-label="Scale ratio" value={ratio} placeholder="500"
          onChange={event => setRatio(event.target.value)} /></label>
        <select aria-label="Unit" value={unit} onChange={event => setUnit(event.target.value)}>
          {MEASURE_UNIT_IDS.map(id => <option key={id} value={id}>{MEASURE_UNITS[id].label}</option>)}
        </select>
        <button type="submit" disabled={!(Number(String(ratio).replace(',', '.')) > 0)}>Set</button>
      </form>
      <label>Color <input type="color" value={measure.settings.color} onChange={event => measureStore.setSettings({ color: event.target.value })} /></label>
      <span className="oo-pdf-context-value">{measure.items.length} measurement{measure.items.length === 1 ? '' : 's'}{pageItems.length !== measure.items.length ? ` (${pageItems.length} on this page)` : ''}</span>
      <button type="button" disabled={!measure.items.length} onClick={() => measure.actions.exportCsv?.()} title="All measurements of the document as a CSV table">
        <Icon name="download" /><span>CSV</span>
      </button>
    </div>
  );
}
