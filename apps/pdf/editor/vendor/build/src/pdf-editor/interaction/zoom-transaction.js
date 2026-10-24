/**
 * Resolve the one transform used while a zoom gesture is still in flight.
 * The anchor is expressed in client coordinates before the scale changes;
 * the returned translation keeps it at the requested client coordinate.
 */
export function zoomInteractionTransform({
  baseLeft,
  baseTop,
  currentScale,
  translateX,
  translateY,
  anchorClientX,
  anchorClientY,
  nextScale,
  targetClientX,
  targetClientY,
}) {
  const safeCurrentScale = Math.max(0.0001, Number(currentScale) || 1);
  const safeNextScale = Math.max(0.0001, Number(nextScale) || 1);
  const localX = (Number(anchorClientX) - Number(baseLeft) - Number(translateX || 0)) / safeCurrentScale;
  const localY = (Number(anchorClientY) - Number(baseTop) - Number(translateY || 0)) / safeCurrentScale;
  return {
    scale: safeNextScale,
    translateX: Number(targetClientX) - Number(baseLeft) - localX * safeNextScale,
    translateY: Number(targetClientY) - Number(baseTop) - localY * safeNextScale,
  };
}

/**
 * A scroll can move the viewport to another page while the compositor draft
 * is still active. Rebase the draft geometry and settle anchor so the later
 * React geometry commit preserves that new view instead of restoring the
 * page that was under the pointer when zoom started.
 */
export function rebaseZoomInteractionAfterScroll(interaction, {
  stackRect,
  sheetRect,
  pageAnchor,
  x,
  y,
}) {
  if (!interaction || !stackRect || !sheetRect || !pageAnchor) return false;
  const scale = Math.max(0.0001, Number(interaction.scale) || 1);
  interaction.baseLeft = stackRect.left - Number(interaction.translateX || 0);
  interaction.baseTop = stackRect.top - Number(interaction.translateY || 0);
  interaction.pageIndex = pageAnchor.pageIndex;
  interaction.pageOffsetX = (sheetRect.left - stackRect.left) / scale;
  interaction.pageOffsetY = (sheetRect.top - stackRect.top) / scale;
  interaction.anchor = { ...pageAnchor, x, y };
  return true;
}

export function recordZoomAnchorScroll(interaction, viewport) {
  if (!interaction || !viewport) return false;
  interaction.observedScrollLeft = viewport.scrollLeft;
  interaction.observedScrollTop = viewport.scrollTop;
  return true;
}

// Browser scroll events are delivered after the task that changes scrollTop.
// A zoom settle or React commit may run first, so consume that scroll once
// before copying the anchor that the layout effect will restore.
export function syncZoomAnchorToViewportScroll(interaction, viewport, rebase) {
  if (!interaction || !viewport ||
      interaction.observedScrollLeft === viewport.scrollLeft &&
      interaction.observedScrollTop === viewport.scrollTop) return false;
  if (rebase(interaction) === false) return false;
  recordZoomAnchorScroll(interaction, viewport);
  return true;
}

export function syncZoomAnchorBeforeCommit(previousZoom, nextZoom, interaction, viewport, rebase) {
  if (previousZoom === nextZoom || !interaction) return false;
  return syncZoomAnchorToViewportScroll(interaction, viewport, rebase);
}

export function clearZoomInteractionTransform(interaction) {
  const stack = interaction?.stack;
  if (!stack) return;
  stack.style.transform = interaction.previousTransform || '';
  stack.style.transformOrigin = interaction.previousTransformOrigin || '';
  stack.style.willChange = interaction.previousWillChange || '';
  stack.removeAttribute('data-zoom-interaction');
}
