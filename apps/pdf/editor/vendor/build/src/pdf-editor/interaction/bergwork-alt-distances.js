// berg:work: holding Alt with a selection shows its distances (Figma): to the object under the pointer, or to the
// page edges when the pointer is over the page itself. Values are in PDF points at the current zoom. Pure DOM
// overlay, nothing is changed in the document.

const LAYER_CLASS = 'oo-pdf-alt-distances';

function rectOf(element) {
  const box = element?.getBoundingClientRect?.();
  return box && box.width > 0 && box.height > 0 ? box : null;
}

/** Distance segments between a selection rect `a` and a target rect `b` (client px). */
export function distanceSegments(a, b) {
  const inside = b.left <= a.left && b.right >= a.right && b.top <= a.top && b.bottom >= a.bottom;
  const midY = (Math.max(a.top, b.top) + Math.min(a.bottom, b.bottom)) / 2;
  const midX = (Math.max(a.left, b.left) + Math.min(a.right, b.right)) / 2;
  const segments = [];
  const ay = (a.top + a.bottom) / 2;
  const ax = (a.left + a.right) / 2;
  if (inside) {
    segments.push({ x1: b.left, y1: ay, x2: a.left, y2: ay }, { x1: a.right, y1: ay, x2: b.right, y2: ay },
      { x1: ax, y1: b.top, x2: ax, y2: a.top }, { x1: ax, y1: a.bottom, x2: ax, y2: b.bottom });
    return segments.filter(s => Math.hypot(s.x2 - s.x1, s.y2 - s.y1) >= 1);
  }
  const overlapsY = a.bottom > b.top && a.top < b.bottom;
  const overlapsX = a.right > b.left && a.left < b.right;
  const y = overlapsY ? midY : ay;
  const x = overlapsX ? midX : ax;
  if (b.left >= a.right) segments.push({ x1: a.right, y1: y, x2: b.left, y2: y });
  else if (b.right <= a.left) segments.push({ x1: b.right, y1: y, x2: a.left, y2: y });
  if (b.top >= a.bottom) segments.push({ x1: x, y1: a.bottom, x2: x, y2: b.top });
  else if (b.bottom <= a.top) segments.push({ x1: x, y1: b.bottom, x2: x, y2: a.top });
  return segments;
}

function formatPoints(px, zoom) {
  const value = px / Math.max(0.0001, zoom);
  return `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10} pt`;
}

/**
 * Installs the Alt overlay on `viewport`. `getSelectionElement()` returns the element framing the selection (or
 * null), `getZoom()` the CSS pixels per PDF point. Returns the cleanup function.
 */
export function installAltDistances({ viewport, getSelectionElement, getZoom }) {
  let layer = null;
  let last = null;
  const clear = () => { layer?.remove(); layer = null; };
  const draw = (selection, target) => {
    clear();
    const segments = distanceSegments(selection, target);
    if (!segments.length) return;
    layer = document.createElement('div');
    layer.className = LAYER_CLASS;
    layer.setAttribute('aria-hidden', 'true');
    const outline = document.createElement('span');
    outline.className = 'oo-pdf-alt-distances-target';
    Object.assign(outline.style, { left: `${target.left}px`, top: `${target.top}px`, width: `${target.width}px`, height: `${target.height}px` });
    layer.append(outline);
    for (const segment of segments) {
      const horizontal = Math.abs(segment.y2 - segment.y1) < 0.5;
      const line = document.createElement('span');
      line.className = `oo-pdf-alt-distances-line ${horizontal ? 'is-horizontal' : 'is-vertical'}`;
      Object.assign(line.style, {
        left: `${Math.min(segment.x1, segment.x2)}px`, top: `${Math.min(segment.y1, segment.y2)}px`,
        width: `${Math.max(1, Math.abs(segment.x2 - segment.x1))}px`, height: `${Math.max(1, Math.abs(segment.y2 - segment.y1))}px`,
      });
      const label = document.createElement('span');
      label.className = 'oo-pdf-alt-distances-label';
      label.textContent = formatPoints(horizontal ? Math.abs(segment.x2 - segment.x1) : Math.abs(segment.y2 - segment.y1), getZoom());
      Object.assign(label.style, { left: `${(segment.x1 + segment.x2) / 2}px`, top: `${(segment.y1 + segment.y2) / 2}px` });
      layer.append(line, label);
    }
    document.body.append(layer);
  };
  const update = event => {
    if (event) last = { x: event.clientX, y: event.clientY, alt: event.altKey && !event.buttons };
    if (!last?.alt) { clear(); return; }
    const frame = getSelectionElement();
    const selection = rectOf(frame);
    if (!selection) { clear(); return; }
    const under = document.elementsFromPoint(last.x, last.y);
    if (!under.some(node => viewport.contains(node))) { clear(); return; }
    const object = under.map(node => node.closest?.('[data-selection-key]')).find(node => node && node !== frame && !frame.contains(node));
    const sheet = under.map(node => node.closest?.('.oo-pdf-sheet')).find(Boolean);
    const target = rectOf(object) || rectOf(sheet);
    if (!target) { clear(); return; }
    draw(selection, target);
  };
  const key = event => {
    if (event.key !== 'Alt') return;
    if (last) last.alt = event.type === 'keydown';
    // Alt alone would focus the browser menu bar on Windows/Linux; the overlay owns it over the document.
    if (event.type === 'keydown' && last && viewport.matches(':hover')) event.preventDefault();
    update();
  };
  const leave = () => clear();
  window.addEventListener('pointermove', update, true);
  window.addEventListener('keydown', key, true);
  window.addEventListener('keyup', key, true);
  window.addEventListener('blur', leave);
  viewport.addEventListener('scroll', leave, { passive: true });
  return () => {
    window.removeEventListener('pointermove', update, true);
    window.removeEventListener('keydown', key, true);
    window.removeEventListener('keyup', key, true);
    window.removeEventListener('blur', leave);
    viewport.removeEventListener('scroll', leave);
    clear();
  };
}
