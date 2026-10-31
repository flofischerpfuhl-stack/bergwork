import { createMoveSnapIndex, resolveMoveSnap } from './move-snapping.js';
import { constrainMoveDelta } from './drag-constraints.js';
import { snapGuideDistance, snapDistanceLabel, placeSnapDistanceLabel } from './move-snap-distance.js';

// berg:work: a horizontal or vertical line has a zero-size side and still snaps.
const finiteRect = rect => rect && [rect.x, rect.y, rect.w, rect.h].every(Number.isFinite) && rect.w >= 0 && rect.h >= 0;
const union = rects => {
  let x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity;
  for (const rect of rects) {
    x = Math.min(x, rect.x); y = Math.min(y, rect.y);
    right = Math.max(right, rect.x + rect.w); bottom = Math.max(bottom, rect.y + rect.h);
  }
  return { x, y, w: right - x, h: bottom - y };
};

/** Gesture-only display-space index and guide compositor. Never writes PDF,
 * semantic state, history, React state, text layout or font properties. */
export class MoveSnapRuntime {
  #contexts = new WeakMap();
  #active = new Map();
  // berg:work: the key that moves without snapping; berg:work sets Ctrl/⌘ (Figma), Fernwork keeps Alt.
  freeMoveKey = event => event.altKey === true;

  register(surface, readContext) {
    if (!surface) return () => {};
    this.#contexts.set(surface, readContext);
    return () => {
      if (this.#contexts.get(surface) !== readContext) return;
      this.#contexts.delete(surface);
      for (const [id, draft] of this.#active) if (draft.surface === surface) this.end(id);
    };
  }

  // berg:work: `rect` snaps that one display-space rect (the end of a line) instead of the selection's own.
  begin(pointerId, element, { rect: pointRect = null } = {}) {
    this.end(pointerId);
    const surface = element?.closest?.('.oo-pdf-page-surface');
    const readContext = surface && this.#contexts.get(surface);
    const state = readContext?.();
    if (!state?.enabled || !finiteRect(state.pageRect)) return false;
    const selectedIds = new Set(state.selectedIds || []);
    if (!selectedIds.size) return false;
    const items = state.items();
    const selected = items.filter(item => selectedIds.has(item.id));
    if (selected.length !== selectedIds.size || selected.some(item => item.hidden || item.locked || !finiteRect(item.rect))) return false;
    const rect = pointRect || union(selected.map(item => item.rect));
    const index = createMoveSnapIndex(state.pageRect, items, [...selectedIds], state.manualGuides);
    // Snapshot only this selection's controls once. During move, translate the
    // snapshot with the same resolved delta as the preview; never remeasure
    // handles or labels after writing pointer-frame styles.
    const paper = surface.getBoundingClientRect();
    const viewport = surface.closest?.('.oo-pdf-viewport')?.getBoundingClientRect() || paper;
    const initialZoom = (paper.right - paper.left) / state.pageRect.w;
    const controls = Array.from(element.querySelectorAll?.('.oo-pdf-rotate-handle, .oo-pdf-resize') || [])
      .slice(0, 16).map(control => control.getBoundingClientRect()).filter(box => box.width > 0 && box.height > 0)
      .map(box => ({ x: box.left - paper.left, y: box.top - paper.top, w: box.width, h: box.height }));
    this.#active.set(pointerId, { surface, readContext, rect, index, controls, initialZoom, viewport,
      guides: new Map(), distances: new Map() });
    return true;
  }

  resolve(pointerId, rawDx, rawDy, event, zoom) {
    const draft = this.#active.get(pointerId);
    if (!draft) return constrainMoveDelta(rawDx, rawDy, event.shiftKey);
    const state = draft.readContext();
    const paper = draft.surface.getBoundingClientRect();
    const inside = event.clientX >= paper.left && event.clientX <= paper.right &&
      event.clientY >= paper.top && event.clientY <= paper.bottom;
    const result = resolveMoveSnap(draft.index, draft.rect, rawDx, rawDy, {
      zoom, enabled: state.enabled && inside, altKey: this.freeMoveKey(event), shiftKey: event.shiftKey,
      spacing: true, // berg:work: equal-spacing snaps and markers
    });
    const visiblePage = {
      x: Math.max(0, draft.viewport.left - paper.left),
      y: Math.max(0, draft.viewport.top - paper.top),
      w: Math.max(0, Math.min(paper.right, draft.viewport.right) - Math.max(paper.left, draft.viewport.left)),
      h: Math.max(0, Math.min(paper.bottom, draft.viewport.bottom) - Math.max(paper.top, draft.viewport.top)),
    };
    this.#draw(draft, result, zoom, visiblePage);
    return result;
  }

  #draw(draft, result, zoom, visiblePage) {
    const visibleAxes = new Set(result.guides.map(guide => guide.axis));
    const visibleDistances = new Set();
    for (const [axis, node] of draft.guides) if (!visibleAxes.has(axis)) node.remove();
    // berg:work: equal-spacing markers: every equal gap as a pink measure with its length.
    for (const entry of result.spacing || []) {
      entry.gaps.forEach((gap, index) => {
        const key = `spacing:${entry.axis}:${index}`;
        const horizontal = entry.axis === 'x';
        let measure = draft.distances.get(key);
        if (!measure) {
          measure = draft.surface.ownerDocument.createElement('div');
          measure.className = 'oo-pdf-snap-distance is-spacing';
          measure.dataset.pdfSnapDistance = horizontal ? 'y' : 'x';
          measure.setAttribute('aria-hidden', 'true');
          const label = draft.surface.ownerDocument.createElement('span');
          label.className = 'oo-pdf-snap-distance-label';
          measure.append(label);
          draft.distances.set(key, measure);
        }
        measure.dataset.distancePt = String(gap.length);
        measure.firstChild.textContent = gap.length * zoom >= 32 ? snapDistanceLabel(gap.length) : '';
        measure.firstChild.style.display = measure.firstChild.textContent ? '' : 'none';
        Object.assign(measure.firstChild.style, horizontal
          ? { left: `${gap.length * zoom / 2}px`, top: '0px' }
          : { left: '0px', top: `${gap.length * zoom / 2}px` });
        Object.assign(measure.style, {
          left: `${(horizontal ? gap.start : gap.position) * zoom}px`,
          top: `${(horizontal ? gap.position : gap.start) * zoom}px`,
          width: horizontal ? `${gap.length * zoom}px` : '1px',
          height: horizontal ? '1px' : `${gap.length * zoom}px`,
        });
        if (measure.parentNode !== draft.surface) draft.surface.append(measure);
        visibleDistances.add(key);
      });
    }
    if (!result.guides.length) {
      for (const [key, node] of draft.distances) if (!visibleDistances.has(key)) node.remove();
      return;
    }
    const moving = { ...draft.rect, x: draft.rect.x + result.dx, y: draft.rect.y + result.dy };
    const ratio = Number.isFinite(draft.initialZoom) && draft.initialZoom > 0 ? zoom / draft.initialZoom : 1;
    const obstacles = draft.controls.map(rect => ({
      x: rect.x * ratio + result.dx * zoom, y: rect.y * ratio + result.dy * zoom,
      w: rect.w * ratio, h: rect.h * ratio,
    }));
    for (const guide of result.guides) {
      const vertical = guide.axis === 'x';
      const start = vertical ? Math.min(moving.y, guide.targetRect.y) : Math.min(moving.x, guide.targetRect.x);
      const end = vertical ? Math.max(moving.y + moving.h, guide.targetRect.y + guide.targetRect.h)
        : Math.max(moving.x + moving.w, guide.targetRect.x + guide.targetRect.w);
      let node = draft.guides.get(guide.axis);
      if (!node) {
        node = draft.surface.ownerDocument.createElement('div');
        node.className = 'oo-pdf-snap-guide';
        node.dataset.pdfSnapGuide = guide.axis;
        node.setAttribute('aria-hidden', 'true');
        draft.guides.set(guide.axis, node);
      }
      node.dataset.snapTarget = guide.targetId;
      Object.assign(node.style, {
        left: `${(vertical ? guide.position : start) * zoom}px`,
        top: `${(vertical ? start : guide.position) * zoom}px`,
        width: vertical ? '1px' : `${Math.max(1, (end - start) * zoom)}px`,
        height: vertical ? `${Math.max(1, (end - start) * zoom)}px` : '1px',
      });
      if (node.parentNode !== draft.surface) draft.surface.append(node);
      const distance = snapGuideDistance(guide, moving);
      // Keep labels out of gaps that are too small to read. Zoom affects only
      // legibility, never the physical distance or the snapping calculation.
      if (!distance || distance.length * zoom < 32) continue;
      const page = draft.readContext().pageRect;
      if (page.w * zoom < 76 || page.h * zoom < 26) continue;
      const labelPosition = placeSnapDistanceLabel({
        x: (vertical ? distance.position : (distance.start + distance.end) / 2) * zoom,
        y: (vertical ? (distance.start + distance.end) / 2 : distance.position) * zoom,
      }, visiblePage, obstacles);
      if (!labelPosition) continue;
      obstacles.push(labelPosition.rect);
      visibleDistances.add(guide.axis);
      let measure = draft.distances.get(guide.axis);
      if (!measure) {
        measure = draft.surface.ownerDocument.createElement('div');
        measure.className = 'oo-pdf-snap-distance';
        measure.dataset.pdfSnapDistance = guide.axis;
        measure.setAttribute('aria-hidden', 'true');
        const label = draft.surface.ownerDocument.createElement('span');
        label.className = 'oo-pdf-snap-distance-label';
        measure.append(label);
        draft.distances.set(guide.axis, measure);
      }
      measure.dataset.distancePt = String(distance.length);
      measure.firstChild.textContent = snapDistanceLabel(distance.length);
      const left = (vertical ? distance.position : distance.start) * zoom;
      const top = (vertical ? distance.start : distance.position) * zoom;
      // Page-edge guides must not put half the label outside the sheet. The
      // fixed label budget avoids layout reads in pointermove, including zoom.
      Object.assign(measure.firstChild.style, {
        left: `${labelPosition.x - left}px`,
        top: `${labelPosition.y - top}px`,
      });
      Object.assign(measure.style, {
        left: `${left}px`,
        top: `${top}px`,
        width: vertical ? '1px' : `${distance.length * zoom}px`,
        height: vertical ? `${distance.length * zoom}px` : '1px',
      });
      if (measure.parentNode !== draft.surface) draft.surface.append(measure);
    }
    for (const [axis, node] of draft.distances) if (!visibleDistances.has(axis)) node.remove();
  }

  end(pointerId) {
    const draft = this.#active.get(pointerId);
    if (!draft) return false;
    for (const guide of draft.guides.values()) guide.remove();
    for (const distance of draft.distances.values()) distance.remove();
    this.#active.delete(pointerId);
    return true;
  }
}

export const moveSnapRuntime = new MoveSnapRuntime();
