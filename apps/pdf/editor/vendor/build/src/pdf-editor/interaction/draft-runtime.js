// @ts-check
import { moveSnapRuntime } from './move-snap-runtime.js';

/**
 * Imperative interaction draft compositor. Pointer-move frames update only
 * the selected overlay element; no command, worker request, or document-store
 * write is allowed from this runtime.
 */
export class InteractionDraftRuntime {
  #active = new Map();
  #unsettled = new Map();
  #samples = [];
  #nextOwner = 0;

  begin(pointerId, element, { positionalRects = null, logicalRect = null } = {}) {
    const elements = (Array.isArray(element) ? element : [element]).filter(Boolean);
    if (!elements.length) return;
    const owner = `draft-${++this.#nextOwner}`;
    // A multi-selection usually lives in one page surface. Resolve that
    // ancestor and its zoom once while still allowing linked pages to keep
    // their own captured scale for rollback.
    const firstSurface = elements[0].closest?.('.oo-pdf-page-surface') || null;
    const surfaces = firstSurface ? [firstSurface] : [];
    const zoomBySurface = new Map();
    const capturedZoom = item => {
      let surface = item === elements[0] ? firstSurface
        : surfaces.find(candidate => candidate.contains?.(item));
      if (!surface) {
        surface = item.closest?.('.oo-pdf-page-surface') || null;
        if (surface && !surfaces.includes(surface)) surfaces.push(surface);
      }
      if (!surface) return null;
      if (!zoomBySurface.has(surface)) zoomBySurface.set(surface, Number(surface.pdfPageZoom) || null);
      return zoomBySurface.get(surface);
    };
    const draft = {
      elements,
      owner,
      positionalRects: positionalRects instanceof Map ? positionalRects : new Map(),
      original: elements.map(item => ({
        left: item.style.left,
        top: item.style.top,
        width: item.style.width,
        height: item.style.height,
        transform: item.style.transform,
        transformOrigin: item.style.transformOrigin,
        draftWidth: item.dataset.pdfDraftWidth,
        draftHeight: item.dataset.pdfDraftHeight,
        draftOwner: item.dataset.pdfDraftOwner,
        zoom: capturedZoom(item),
        logicalRect: positionalRects?.get(item) || (item === elements[0] ? logicalRect : null),
      })),
      clientRects: elements.map(item => item.getBoundingClientRect()),
      startedAt: performance.now(),
      frames: 0,
      mode: null,
    };
    this.#active.set(pointerId, draft);
    this.#unsettled.set(owner, draft);
    for (const item of elements) {
      item.dataset.interactionDraft = 'active';
      item.dataset.pdfDraftOwner = owner;
    }
  }

  updateRect(pointerId, rect, scale = 1) {
    const draft = this.#active.get(pointerId);
    if (!draft) return false;
    const startedAt = performance.now();
    const element = draft.elements[0];
    draft.mode = 'rect';
    element.style.left = `${Number(rect.x || 0) * scale}px`;
    element.style.top = `${Number(rect.y || 0) * scale}px`;
    element.style.width = `${Math.max(8, Number(rect.w || 0) * scale)}px`;
    element.style.height = `${Math.max(8, Number(rect.h || 0) * scale)}px`;
    // CSS may clamp the hit box to 8px. Keep the actual page-space geometry
    // for a successor pointerdown before React has published this draft.
    element.dataset.pdfDraftWidth = String(Number(rect.w || 0));
    element.dataset.pdfDraftHeight = String(Number(rect.h || 0));
    draft.frames += 1;
    this.#samples.push(performance.now() - startedAt);
    if (this.#samples.length > 1024) this.#samples.splice(0, this.#samples.length - 1024);
    return true;
  }

  updateTranslation(pointerId, dx, dy, layoutZoom = 1) {
    const draft = this.#active.get(pointerId);
    if (!draft) return false;
    const startedAt = performance.now();
    draft.mode = 'translation';
    // Compose the screen-space translate with the element's own transform so a
    // rotated (or quad-projected) object keeps its orientation while dragging.
    // The translate is leftmost, so it applies last, in screen space; dropping
    // the original here made rotated images snap upright ("verdreht") mid-drag.
    draft.elements.forEach((element, index) => {
      const original = draft.original[index].transform;
      const pageRect = draft.positionalRects.get(element);
      if (pageRect) {
        const scale = Math.max(0.001, Number(layoutZoom) || 1);
        element.style.left = `${Number(pageRect.x || 0) * scale + Number(dx || 0)}px`;
        element.style.top = `${Number(pageRect.y || 0) * scale + Number(dy || 0)}px`;
        // Retain any original rotation or affine projection. The optimistic
        // React update will write the same left/top, so no 2*d release jump.
        element.style.transform = original;
        return;
      }
      element.style.transform = `translate(${Number(dx || 0)}px, ${Number(dy || 0)}px)${
        original && original !== 'none' ? ` ${original}` : ''}`;
    });
    draft.frames += 1;
    this.#samples.push(performance.now() - startedAt);
    if (this.#samples.length > 1024) this.#samples.splice(0, this.#samples.length - 1024);
    return true;
  }

  updateRotation(pointerId, degrees) {
    const draft = this.#active.get(pointerId);
    if (!draft) return false;
    const startedAt = performance.now();
    draft.mode = 'rotation';
    draft.elements.forEach((element, index) => {
      const original = draft.original[index].transform;
      element.style.transform = `${original && original !== 'none' ? `${original} ` : ''}rotate(${Number(degrees || 0)}deg)`;
      element.style.transformOrigin = 'center center';
    });
    draft.frames += 1;
    this.#samples.push(performance.now() - startedAt);
    if (this.#samples.length > 1024) this.#samples.splice(0, this.#samples.length - 1024);
    return true;
  }

  updateGroupTransform(pointerId, transform, center) {
    const draft = this.#active.get(pointerId);
    if (!draft) return false;
    const startedAt = performance.now();
    draft.mode = 'group-transform';
    draft.elements.forEach((element, index) => {
      const original = draft.original[index].transform;
      const rect = draft.clientRects[index];
      element.style.transformOrigin = `${center.x - rect.left}px ${center.y - rect.top}px`;
      element.style.transform = `${original && original !== 'none' ? `${original} ` : ''}${transform}`;
    });
    draft.frames += 1;
    this.#samples.push(performance.now() - startedAt);
    return true;
  }

  end(pointerId, { commit = true } = {}) {
    moveSnapRuntime.end(pointerId);
    const draft = this.#active.get(pointerId);
    if (!draft) return null;
    this.#active.delete(pointerId);
    for (const element of draft.elements) {
      if (element.dataset.pdfDraftOwner === draft.owner) delete element.dataset.interactionDraft;
    }
    let restored = false;
    let settled = false;
    const rebaseSuccessors = accepted => {
      for (const successor of this.#unsettled.values()) {
        if (successor === draft) continue;
        successor.elements.forEach((element, index) => {
          const original = successor.original[index];
          if (original.draftOwner !== draft.owner) return;
          const predecessorIndex = draft.elements.indexOf(element);
          if (predecessorIndex < 0) return;
          if (accepted) {
            // B began from A's optimistic position. A's success makes that
            // position canonical, while A's metadata token must not return
            // if B later rejects.
            original.draftOwner = undefined;
            original.draftWidth = undefined;
            original.draftHeight = undefined;
            original.transform = draft.original[predecessorIndex].transform;
            original.transformOrigin = draft.original[predecessorIndex].transformOrigin;
          } else {
            // A failed while B was active or awaiting its own reply. B keeps
            // its visible P2 draft, but its eventual rollback must reach P0.
            Object.assign(original, draft.original[predecessorIndex]);
            // A cannot repaint this node while B owns its token. If A had
            // written a rect, B inherits responsibility for restoring all
            // four rect properties after its own cancellation.
            original.rejectedPredecessorRect = draft.mode === 'rect';
          }
        });
      }
    };
      const restore = () => {
      if (restored || settled) return;
      restored = true;
      settled = true;
      rebaseSuccessors(false);
      this.#unsettled.delete(draft.owner);
      draft.elements.forEach((element, index) => {
        if (element.dataset.pdfDraftOwner !== draft.owner) return;
        const original = draft.original[index];
        const currentZoom = Number(element.closest?.('.oo-pdf-page-surface')?.pdfPageZoom);
        const changedZoom = Number.isFinite(currentZoom) && currentZoom > 0 &&
          Number.isFinite(original.zoom) && original.zoom > 0 &&
          Math.abs(currentZoom - original.zoom) > 0.0001;
        const ratio = changedZoom ? currentZoom / original.zoom : 1;
        const logical = original.logicalRect;
        const scaled = (property, logicalProperty, minimum = -Infinity) => {
          if (!changedZoom) return original[property];
          const pageValue = Number(logical?.[logicalProperty]);
          if (Number.isFinite(pageValue)) return `${Math.max(minimum, pageValue * currentZoom)}px`;
          const oldPixels = Number.parseFloat(original[property]);
          return Number.isFinite(oldPixels) && /^-?\d+(?:\.\d+)?px$/u.test(String(original[property]))
            ? `${Math.max(minimum, oldPixels * ratio)}px` : original[property];
        };
        if (draft.mode === 'rect' || original.rejectedPredecessorRect) {
          element.style.left = scaled('left', 'x');
          element.style.top = scaled('top', 'y');
          element.style.width = scaled('width', 'w', 8);
          element.style.height = scaled('height', 'h', 8);
        } else if (draft.mode === 'translation' && draft.positionalRects.has(element)) {
          element.style.left = scaled('left', 'x');
          element.style.top = scaled('top', 'y');
        }
        if (draft.mode === 'translation' || draft.mode === 'rotation' ||
            draft.mode === 'group-transform' || draft.mode === 'rect') {
          element.style.transform = original.transform;
          element.style.transformOrigin = original.transformOrigin;
        }
        if (original.draftWidth === undefined) delete element.dataset.pdfDraftWidth;
        else element.dataset.pdfDraftWidth = original.draftWidth;
        if (original.draftHeight === undefined) delete element.dataset.pdfDraftHeight;
        else element.dataset.pdfDraftHeight = original.draftHeight;
        if (original.draftOwner === undefined) delete element.dataset.pdfDraftOwner;
        else element.dataset.pdfDraftOwner = original.draftOwner;
      });
    };
    const accept = () => {
      if (settled) return;
      settled = true;
      rebaseSuccessors(true);
      this.#unsettled.delete(draft.owner);
      const owned = new Set();
      for (const element of draft.elements) {
        if (element.dataset.pdfDraftOwner !== draft.owner) continue;
        owned.add(element);
        delete element.dataset.pdfDraftWidth;
        delete element.dataset.pdfDraftHeight;
        delete element.dataset.pdfDraftOwner;
      }
      if (!['translation', 'rotation', 'group-transform'].includes(draft.mode)) return;
      // Multi-selection previews use a transient translate on several nodes;
      // canonical state is expressed through each node's left/top geometry.
      draft.elements.forEach((element, index) => {
        if (!owned.has(element)) return;
        if (draft.positionalRects.has(element)) return;
        element.style.transform = draft.original[index].transform;
      });
    };
    // React does not know about the imperative writes performed during the
    // gesture. On a successful commit the draft already equals the canonical
    // target, so restoring here would put the DOM behind React's virtual tree
    // and React would have no changed style property left to reconcile. A
    // cancellation or rejected transaction explicitly rolls the draft back.
    if (!commit) restore();
    return Object.freeze({
      frames: draft.frames,
      elapsedMs: performance.now() - draft.startedAt,
      accept,
      restore,
    });
  }

  hasActiveSelectionKey(key) {
    if (!key) return false;
    for (const draft of this.#active.values()) {
      if (draft.elements.some(element => element?.dataset?.selectionKey === key)) return true;
    }
    return false;
  }

  hasUnsettledDrafts() {
    return this.#unsettled.size > 0;
  }

  metrics() {
    const sorted = [...this.#samples].sort((a, b) => a - b);
    const percentile = value => sorted.length
      ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * value))]
      : 0;
    return Object.freeze({
      activeDrafts: this.#active.size,
      samples: sorted.length,
      p95Ms: percentile(0.95),
      p99Ms: percentile(0.99),
    });
  }
}

export const interactionDraftRuntime = new InteractionDraftRuntime();
