function firstFinite(...values) {
  return values.find(value => Number.isFinite(value));
}

// A queued drag may have captured an optimistic predecessor. Translate the
// freshly inspected native matrix from the placement last confirmed by the
// kernel, rather than from either that optimistic frame or an older ACK.
export function directMoveBaseline(confirmedState, previous = {}, nextEdit = {}) {
  const confirmed = confirmedState?.exists === true ? confirmedState.value : null;
  const acknowledged = previous.liveCommitted || {};
  return {
    ...nextEdit,
    targetSourceX: firstFinite(confirmed?.targetSourceX, confirmed?.liveCommitted?.x,
      confirmed?.sourceX, acknowledged.x, nextEdit.sourceX),
    targetSourceY: firstFinite(confirmed?.targetSourceY, confirmed?.liveCommitted?.y,
      confirmed?.sourceY, acknowledged.y, nextEdit.sourceY),
    targetSourceW: firstFinite(confirmed?.targetSourceW, confirmed?.liveCommitted?.w,
      confirmed?.sourceW, acknowledged.w, nextEdit.sourceW),
    targetSourceH: firstFinite(confirmed?.targetSourceH, confirmed?.liveCommitted?.h,
      confirmed?.sourceH, acknowledged.h, nextEdit.sourceH),
  };
}

export function assertNativeDirectMoveBaseline(beforeBounds, nativeBounds, tolerance = 0.5) {
  const sides = ['left', 'bottom', 'right', 'top'];
  const valid = sides.every(side => Number.isFinite(beforeBounds?.[side]) &&
    Number.isFinite(nativeBounds?.[side]) &&
    Math.abs(beforeBounds[side] - nativeBounds[side]) <= tolerance);
  if (valid) return;
  const error = new Error('The native object moved since this drag baseline was confirmed.');
  error.code = 'stale-placement-baseline';
  error.details = { beforeBounds, nativeBounds, tolerance };
  throw error;
}
