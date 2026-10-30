// One native B/S/U stack is clipped to the vacated, current and superseded
// positions. The bitmaps are prepared outside the pointer loop; movement only
// updates the sprite transform and three clip rectangles.
let nextClipId = 0;

export function createDragCompositionOverlay(surface, pageSize, preview) {
  if (!surface || preview?.previewKind !== 'raster' || !preview.bounds || !preview.spriteBounds ||
      !preview.sourceBounds ||
      !preview.belowBitmap || !preview.spriteBitmap || !preview.upperBitmap) return null;
  const root = document.createElement('div');
  root.className = 'oo-pdf-drag-composition';
  root.dataset.previewKind = 'native-composition';
  root.dataset.targetKind = preview.targetKind || '';
  const crop = preview.bounds, sprite = preview.spriteBounds;
  const stack = document.createElement('div');
  stack.className = 'oo-pdf-drag-composition-stack';
  const clipId = `oo-pdf-drag-clip-${++nextClipId}`;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.classList.add('oo-pdf-drag-composition-clip-defs');
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  const clip = document.createElementNS('http://www.w3.org/2000/svg', 'clipPath');
  clip.setAttribute('id', clipId);
  clip.setAttribute('clipPathUnits', 'userSpaceOnUse');
  const clipRects = Array.from({ length: 3 }, () => {
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    clip.appendChild(rect);
    return rect;
  });
  defs.appendChild(clip);
  svg.appendChild(defs);
  stack.style.clipPath = `url(#${clipId})`;
  const canvases = [
    ['below', preview.belowBitmap], ['sprite', preview.spriteBitmap], ['upper', preview.upperBitmap],
  ].map(([kind, bitmap]) => {
    const canvas = document.createElement('canvas');
    canvas.className = `oo-pdf-drag-composition-layer is-${kind}`;
    canvas.width = kind === 'sprite' ? preview.spriteWidth : preview.width;
    canvas.height = kind === 'sprite' ? preview.spriteHeight : preview.height;
    const context = canvas.getContext('2d', { alpha: kind !== 'below' });
    if (!context) return null;
    context.drawImage(bitmap, 0, 0);
    stack.appendChild(canvas);
    return canvas;
  });
  if (canvases.some(canvas => !canvas)) return null;
  // Transparent geometry probes preserve existing performance measurements.
  const frames = ['source', 'destination'].map(kind => {
    const frame = document.createElement('div');
    frame.className = `oo-pdf-drag-composition-window is-${kind}`;
    root.appendChild(frame);
    return frame;
  });
  root.append(svg, stack);
  const extra = 3 / Math.max(0.5, Number(preview.scale || 1));
  const sourceBounds = { x: preview.sourceBounds.x - extra, y: preview.sourceBounds.y - extra,
    width: preview.sourceBounds.width + 2 * extra,
    height: preview.sourceBounds.height + 2 * extra };
  let dx = 0, dy = 0, staleUnion = null, parked = false, disposed = false, offPage = false;
  // clientWidth rounds, which leaves the last pixel column of an A4 page uncovered.
  const surfaceZoom = () => (parseFloat(surface.style.width) || surface.clientWidth) /
    Math.max(1, pageSize.width);
  let zoom = surfaceZoom();
  const inCrop = rect => rect.x >= crop.x - 0.5 && rect.y >= crop.y - 0.5 &&
    rect.x + rect.width <= crop.x + crop.width + 0.5 &&
    rect.y + rect.height <= crop.y + crop.height + 0.5;
  // The page clips everything it paints, so a rectangle only needs prepared
  // pixels for its part on the page.
  const preparedOnPage = rect => {
    const x = Math.max(0, rect.x), y = Math.max(0, rect.y);
    const width = Math.min(pageSize.width, rect.x + rect.width) - x;
    const height = Math.min(pageSize.height, rect.y + rect.height) - y;
    return width > 0 && height > 0 && inCrop({ x, y, width, height });
  };
  const intersectCrop = rect => {
    const x = Math.max(crop.x, rect.x), y = Math.max(crop.y, rect.y);
    const right = Math.min(crop.x + crop.width, rect.x + rect.width);
    const bottom = Math.min(crop.y + crop.height, rect.y + rect.height);
    return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
  };
  // This stack is its own compositor layer and loses the surface's subpixel
  // offset, so on a fractional surface it ends a column before the page canvas.
  // Only a source hanging over the page has ink there. Such a drag keeps the
  // surface's clip, so the extra pixel never paints past the page.
  const source = preview.sourceBounds;
  const cover = source.x < 0 || source.y < 0 || source.x + source.width > pageSize.width ||
    source.y + source.height > pageSize.height ? 1 : 0;
  const setClip = (rectNode, rect, grow = 0) => {
    const clipped = rect ? intersectCrop(rect) : { x: 0, y: 0, width: 0, height: 0 };
    rectNode.setAttribute('x', String((clipped.x - crop.x) * zoom));
    rectNode.setAttribute('y', String((clipped.y - crop.y) * zoom));
    rectNode.setAttribute('width', String(clipped.width * zoom + (clipped.width > 0 ? grow : 0)));
    rectNode.setAttribute('height', String(clipped.height * zoom + (clipped.height > 0 ? grow : 0)));
  };
  const setFrame = (frame, rect) => {
    frame.style.left = `${(rect.x - crop.x) * zoom}px`;
    frame.style.top = `${(rect.y - crop.y) * zoom}px`;
    frame.style.width = `${rect.width * zoom}px`;
    frame.style.height = `${rect.height * zoom}px`;
  };
  const layout = () => {
    if (disposed) return false;
    const dest = { ...sourceBounds, x: sourceBounds.x + dx, y: sourceBounds.y + dy };
    const destinationPrepared = !offPage && preparedOnPage(dest);
    root.style.left = `${crop.x * zoom}px`;
    root.style.top = `${crop.y * zoom}px`;
    root.style.width = `${crop.width * zoom}px`;
    root.style.height = `${crop.height * zoom}px`;
    stack.style.width = root.style.width;
    stack.style.height = root.style.height;
    canvases[0].style.width = canvases[2].style.width = `${crop.width * zoom + cover}px`;
    canvases[0].style.height = canvases[2].style.height = `${crop.height * zoom + cover}px`;
    canvases[1].style.left = `${(sprite.x - crop.x) * zoom}px`;
    canvases[1].style.top = `${(sprite.y - crop.y) * zoom}px`;
    canvases[1].style.width = `${sprite.width * zoom}px`;
    canvases[1].style.height = `${sprite.height * zoom}px`;
    canvases[1].style.transform = `translate(${dx * zoom}px, ${dy * zoom}px)`;
    setClip(clipRects[0], sourceBounds, cover);
    setClip(clipRects[1], parked ? null : dest);
    setClip(clipRects[2], staleUnion);
    setFrame(frames[0], sourceBounds);
    setFrame(frames[1], dest);
    frames[1].style.display = destinationPrepared && !parked ? '' : 'none';
    // A parked predecessor still supplies its below/upper source and stale
    // cleanup, but cannot paint a second destination beside its successor.
    canvases[1].style.visibility = parked ? 'hidden' : '';
    return destinationPrepared;
  };
  surface.appendChild(root);
  const observer = new ResizeObserver(() => {
    zoom = surfaceZoom();
    layout();
  });
  observer.observe(surface);
  layout();
  return Object.freeze({
    element: root,
    preview,
    hasRasterSourceCleanup: true,
    update(nextDx, nextDy, destinationOffPage = false) {
      dx = Number(nextDx) || 0;
      dy = Number(nextDy) || 0;
      offPage = destinationOffPage === true;
      return layout();
    },
    addStale(staleDx, staleDy) {
      if (disposed) return false;
      const rect = { ...sourceBounds, x: sourceBounds.x + (Number(staleDx) || 0),
        y: sourceBounds.y + (Number(staleDy) || 0) };
      const x = Math.min(staleUnion?.x ?? rect.x, rect.x);
      const y = Math.min(staleUnion?.y ?? rect.y, rect.y);
      const right = Math.max((staleUnion?.x ?? rect.x) + (staleUnion?.width ?? rect.width), rect.x + rect.width);
      const bottom = Math.max((staleUnion?.y ?? rect.y) + (staleUnion?.height ?? rect.height), rect.y + rect.height);
      const nextUnion = { x, y, width: right - x, height: bottom - y };
      if (!preparedOnPage(nextUnion)) return false;
      staleUnion = nextUnion;
      layout();
      return true;
    },
    snapshot() {
      return { dx, dy, staleUnion: staleUnion ? { ...staleUnion } : null, parked, offPage };
    },
    park() { parked = true; layout(); },
    restore(state) {
      if (disposed || !state) return false;
      dx = Number(state.dx) || 0;
      dy = Number(state.dy) || 0;
      staleUnion = state.staleUnion ? { ...state.staleUnion } : null;
      parked = Boolean(state.parked);
      offPage = state.offPage === true;
      layout();
      return true;
    },
    layout,
    destroy() {
      if (disposed) return;
      disposed = true;
      observer.disconnect();
      root.remove();
      for (const canvas of canvases) {
        canvas.width = 0;
        canvas.height = 0;
      }
    },
  });
}
