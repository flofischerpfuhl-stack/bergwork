export function constrainMoveDelta(dx, dy, constrainAxis = false) {
  const nextX = Number(dx) || 0;
  const nextY = Number(dy) || 0;
  if (!constrainAxis) return { dx: nextX, dy: nextY };
  return Math.abs(nextX) >= Math.abs(nextY)
    ? { dx: nextX, dy: 0 }
    : { dx: 0, dy: nextY };
}
