export function dragOriginPageId(drag) {
  return drag?.pageId || drag?.item?.pageId || drag?.edit?.pageId ||
    drag?.compositionTarget?.edit?.pageId || drag?.ann?.pageId || '';
}

export function dragTextSourceId(drag) {
  return drag?.compositionTarget?.sourceId || drag?.item?.sourceId || drag?.edit?.sourceId || '';
}

export function dragCrossesPage(drag, next = drag?.latest) {
  const origin = dragOriginPageId(drag);
  return Boolean(origin && next?.pageId && next.pageId !== origin);
}

export function hasLivePdfCompositionRuntime(drag, surface) {
  return Boolean(surface?.pdfReleaseRuntime?.engine || drag?.releaseRuntime?.engine);
}

export function textDragPaintOwner({ edit, liveCommitted, previewBacked }) {
  if (!edit) return 'canvas';
  if (previewBacked) return 'preview';
  return liveCommitted ? 'canvas' : 'dom';
}

export function canPublishDragDismissal(activeDrag, dismissedDrag, restoredDrag, registeredDrag) {
  if (activeDrag && activeDrag !== dismissedDrag) return false;
  return !registeredDrag || registeredDrag === dismissedDrag || registeredDrag === restoredDrag;
}
