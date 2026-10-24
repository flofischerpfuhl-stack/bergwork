// A hold may settle while a newer, still unarmed pointer gesture is current.
// Clear only the release which set this token; a newer release owns its own token.
export function settlePendingRelease(ownerRef, drag, restoredHold = null) {
  if (!drag || ownerRef.current !== drag) return false;
  ownerRef.current = restoredHold?.drag || null;
  return true;
}

export function pendingReleaseAppearance(ownerRef) {
  const drag = ownerRef.current;
  return { draft: drag?.latest || null, previewVisible: Boolean(drag?.previewShown) };
}
