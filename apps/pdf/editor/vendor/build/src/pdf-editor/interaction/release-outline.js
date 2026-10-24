// Honest fallback for a release whose native paint order was not proved. The
// source page remains untouched; only the intended destination is marked until
// the committed raster is actually visible.
export function discardFallbackOutlineOnPageChange(drag, targetPageId) {
  if (!drag?.compositionFallbackOutline || drag.compositionFallbackPageId === targetPageId) return false;
  drag.compositionFallbackOutline.destroy();
  drag.compositionFallbackOutline = null;
  drag.compositionFallbackOrigin = null;
  return true;
}

export function createReleaseOutline(surface, pageSize, rects) {
  if (!surface || !pageSize?.width || !Array.isArray(rects) || !rects.length) return null;
  const valid = rects.filter(rect => [rect?.x, rect?.y, rect?.w, rect?.h].every(Number.isFinite));
  if (!valid.length) return null;
  const root = document.createElement('div');
  root.className = 'oo-pdf-release-outline';
  root.dataset.previewKind = 'outline';
  const frames = valid.map(rect => {
    const frame = document.createElement('div');
    frame.className = 'oo-pdf-release-outline-frame';
    root.appendChild(frame);
    return { frame, rect };
  });
  let zoom = surface.clientWidth / Math.max(1, pageSize.width);
  let shiftX = 0, shiftY = 0, parked = false, destroyed = false;
  const layout = () => {
    if (destroyed) return false;
    root.style.visibility = parked ? 'hidden' : '';
    for (const { frame, rect } of frames) {
      frame.style.left = `${(rect.x + shiftX) * zoom}px`;
      frame.style.top = `${(rect.y + shiftY) * zoom}px`;
      frame.style.width = `${Math.max(1, rect.w * zoom)}px`;
      frame.style.height = `${Math.max(1, rect.h * zoom)}px`;
    }
    return true;
  };
  surface.appendChild(root);
  const observer = new ResizeObserver(() => {
    zoom = surface.clientWidth / Math.max(1, pageSize.width);
    layout();
  });
  observer.observe(surface);
  layout();
  return Object.freeze({
    element: root,
    previewKind: 'outline',
    update(dx, dy) {
      shiftX = Number(dx) || 0;
      shiftY = Number(dy) || 0;
      return layout();
    },
    addStale: () => true,
    snapshot: () => ({ shiftX, shiftY, parked }),
    park() { parked = true; layout(); },
    restore(state) {
      if (destroyed || !state) return false;
      shiftX = Number(state.shiftX) || 0;
      shiftY = Number(state.shiftY) || 0;
      parked = Boolean(state.parked);
      layout();
      return true;
    },
    layout,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      observer.disconnect();
      root.remove();
    },
  });
}
