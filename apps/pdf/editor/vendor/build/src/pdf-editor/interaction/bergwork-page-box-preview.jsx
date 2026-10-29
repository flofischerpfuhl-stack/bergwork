// berg:work: the page preview of the Crop & resize panel. Shows the current page; for cropping, the kept area as a
// rectangle with the rest dimmed: drag an edge or corner to move it, or drag on the page to draw a new one. For
// resizing, the new page outline around the (scaled) content. The shell paints the page (`paint`).
import React, { useEffect, useRef, useState } from 'react';

const HANDLE_PX = 9;
const MAX_W = 260;
const MAX_H = 300;

function fitSize(width, height, maxWidth = MAX_W, maxHeight = MAX_H) {
  const scale = Math.min(maxWidth / Math.max(1, width), maxHeight / Math.max(1, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scale };
}

/**
 * pageSize: the page as seen, in points. margins: { top, right, bottom, left } in points (crop mode).
 * resize: { width, height, scaleContent } in points as seen, or null. paint(canvas, cssWidth) draws the page.
 */
export function PageBoxPreview({ pageSize, margins, onMargins, resize = null, paint, paintKey = '',
  label = 'Crop area: drag an edge, or drag on the page to draw a new area' }) {
  const canvasRef = useRef(null);
  const frameRef = useRef(null);
  const dragRef = useRef(null);
  const [painted, setPainted] = useState(false);
  const outer = resize
    ? fitSize(Math.max(pageSize.width, resize.width), Math.max(pageSize.height, resize.height))
    : fitSize(pageSize.width, pageSize.height);
  // Page px per point.
  const k = outer.scale;
  const page = { width: Math.round(pageSize.width * k), height: Math.round(pageSize.height * k) };

  useEffect(() => {
    let cancelled = false;
    setPainted(false);
    Promise.resolve(paint?.(canvasRef.current, page.width)).then(ok => { if (!cancelled) setPainted(ok !== false); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [paintKey, page.width, Boolean(resize)]); // eslint-disable-line react-hooks/exhaustive-deps

  if (resize) {
    // The new page (outline) with the content placed as the resize will place it.
    const target = { width: resize.width * k, height: resize.height * k };
    const contentScale = resize.scaleContent === false ? 1
      : Math.min(resize.width / Math.max(1, pageSize.width), resize.height / Math.max(1, pageSize.height));
    const content = { width: page.width * contentScale, height: page.height * contentScale };
    const box = { width: Math.max(target.width, content.width), height: Math.max(target.height, content.height) };
    return (
      <figure className="oo-pdf-pagebox-preview" aria-label="Preview of the new page size">
        <div className="oo-pdf-pagebox-stage" style={{ width: box.width, height: box.height }}>
          <div className="oo-pdf-pagebox-content" style={{
            width: content.width, height: content.height,
            left: (box.width - content.width) / 2, top: (box.height - content.height) / 2,
          }}>
            <canvas ref={canvasRef} aria-hidden="true" style={{ width: '100%', height: '100%', opacity: painted ? 1 : 0 }} />
          </div>
          <div className="oo-pdf-pagebox-target" style={{
            width: target.width, height: target.height,
            left: (box.width - target.width) / 2, top: (box.height - target.height) / 2,
          }} />
        </div>
      </figure>
    );
  }

  const rect = {
    left: (margins.left || 0) * k,
    top: (margins.top || 0) * k,
    right: page.width - (margins.right || 0) * k,
    bottom: page.height - (margins.bottom || 0) * k,
  };
  const toMargins = next => {
    const clampX = value => Math.max(0, Math.min(page.width, value));
    const clampY = value => Math.max(0, Math.min(page.height, value));
    const left = clampX(Math.min(next.left, next.right));
    const right = clampX(Math.max(next.left, next.right));
    const top = clampY(Math.min(next.top, next.bottom));
    const bottom = clampY(Math.max(next.top, next.bottom));
    onMargins?.({ top: top / k, left: left / k, right: (page.width - right) / k, bottom: (page.height - bottom) / k });
  };
  const pointAt = event => {
    const box = frameRef.current.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };
  const onPointerDown = event => {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    const p = pointAt(event);
    const near = (a, b) => Math.abs(a - b) <= HANDLE_PX;
    const inside = p.x > rect.left - HANDLE_PX && p.x < rect.right + HANDLE_PX && p.y > rect.top - HANDLE_PX && p.y < rect.bottom + HANDLE_PX;
    const edges = inside ? {
      left: near(p.x, rect.left), right: near(p.x, rect.right), top: near(p.y, rect.top), bottom: near(p.y, rect.bottom),
    } : {};
    const grabbing = Object.values(edges).some(Boolean);
    dragRef.current = grabbing ? { edges, start: rect } : { draw: p };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };
  const onPointerMove = event => {
    const drag = dragRef.current;
    if (!drag) return;
    const p = pointAt(event);
    if (drag.draw) {
      if (Math.abs(p.x - drag.draw.x) < 3 && Math.abs(p.y - drag.draw.y) < 3) return;
      toMargins({ left: drag.draw.x, right: p.x, top: drag.draw.y, bottom: p.y });
      return;
    }
    const next = { ...drag.start };
    if (drag.edges.left) next.left = p.x;
    if (drag.edges.right) next.right = p.x;
    if (drag.edges.top) next.top = p.y;
    if (drag.edges.bottom) next.bottom = p.y;
    toMargins(next);
  };
  const onPointerUp = () => { dragRef.current = null; };
  const cursorAt = event => {
    if (dragRef.current) return;
    const p = pointAt(event);
    const near = (a, b) => Math.abs(a - b) <= HANDLE_PX;
    const within = p.x > rect.left - HANDLE_PX && p.x < rect.right + HANDLE_PX && p.y > rect.top - HANDLE_PX && p.y < rect.bottom + HANDLE_PX;
    const h = within && (near(p.x, rect.left) || near(p.x, rect.right));
    const v = within && (near(p.y, rect.top) || near(p.y, rect.bottom));
    const diagonal = (near(p.x, rect.left) && near(p.y, rect.top)) || (near(p.x, rect.right) && near(p.y, rect.bottom));
    event.currentTarget.style.cursor = h && v ? (diagonal ? 'nwse-resize' : 'nesw-resize') : h ? 'ew-resize' : v ? 'ns-resize' : 'crosshair';
  };
  return (
    <figure className="oo-pdf-pagebox-preview" aria-label={label}>
      <div ref={frameRef} className="oo-pdf-pagebox-stage is-crop" style={{ width: page.width, height: page.height }}
        onPointerDown={onPointerDown} onPointerMove={event => { cursorAt(event); onPointerMove(event); }}
        onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
        <canvas ref={canvasRef} aria-hidden="true" style={{ width: page.width, height: page.height, opacity: painted ? 1 : 0 }} />
        <div className="oo-pdf-pagebox-keep" style={{
          left: rect.left, top: rect.top, width: Math.max(0, rect.right - rect.left), height: Math.max(0, rect.bottom - rect.top),
        }}>
          <i className="is-n" /><i className="is-e" /><i className="is-s" /><i className="is-w" />
        </div>
      </div>
    </figure>
  );
}

/** A number field in a unit (`factor` points per unit) for a value kept in points; typing is not reformatted. */
export function UnitNumberInput({ value, factor = 1, onValue, ...rest }) {
  const format = points => String(Math.round((Number(points) / factor) * 10) / 10);
  const [text, setText] = useState(format(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(format(value));
  }, [value, factor]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <input inputMode="decimal" {...rest} value={text}
      onFocus={() => { focused.current = true; }}
      onBlur={() => { focused.current = false; setText(format(value)); }}
      onChange={(event) => {
        const next = event.target.value.replace(',', '.').replace(/[^\d.]/gu, '');
        setText(next);
        const number = Number(next);
        if (Number.isFinite(number)) onValue?.(Math.max(0, number) * factor);
      }} />
  );
}
