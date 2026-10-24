export function displayGeometryNumber(value) {
  const numeric = Number(value || 0);
  const rounded = Number(numeric.toFixed(3));
  // Keep the usual compact three-decimal representation, but never turn a
  // real, positive PDF dimension into zero merely by displaying it.
  return String(rounded === 0 && numeric !== 0 ? numeric : rounded);
}

export function existingDimensionMinimum(value, standardMinimum) {
  const displayedBaseline = Number(displayGeometryNumber(value));
  return Number.isFinite(displayedBaseline) && displayedBaseline > 0
    ? Math.min(standardMinimum, displayedBaseline)
    : standardMinimum;
}
