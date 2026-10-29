// berg:work: several pages selected in the Pages panel, and the page moves that act on them.
// Pure helpers; the shell keeps the selected page IDs and runs the moves as page-topology steps.

// The pages the page actions act on: the selected ones when the current page is among them and there are at
// least two, otherwise the current page alone. Scrolling to another page therefore ends a multi-selection.
export function effectivePageSelection(pageIds, activeIndex, selectedIds) {
  const count = pageIds?.length || 0;
  if (!count) return [];
  const active = Math.max(0, Math.min(count - 1, Number(activeIndex) || 0));
  const chosen = new Set(selectedIds || []);
  if (chosen.size < 2 || !chosen.has(pageIds[active])) return [active];
  const indices = [];
  pageIds.forEach((id, index) => { if (chosen.has(id)) indices.push(index); });
  return indices.length > 1 ? indices : [active];
}

// A click on a thumbnail. Plain: that page alone. Shift: the range from the anchor (the last plainly or
// Ctrl-clicked page). Ctrl/⌘: add or remove that page. `go` is the page to show afterwards.
export function pageSelectionAfterClick({ pageIds, activeIndex, selectedIds, anchorId, index, shift = false, toggle = false }) {
  const id = pageIds[index];
  if (!id) return null;
  const current = effectivePageSelection(pageIds, activeIndex, selectedIds).map(i => pageIds[i]);
  if (shift) {
    const anchorIndex = pageIds.indexOf(anchorId);
    const from = anchorIndex >= 0 ? anchorIndex : Math.max(0, Math.min(pageIds.length - 1, activeIndex));
    const low = Math.min(from, index);
    const high = Math.max(from, index);
    return { ids: pageIds.slice(low, high + 1), anchorId: pageIds[from], go: index };
  }
  if (toggle) {
    if (current.includes(id)) {
      const rest = current.filter(item => item !== id);
      if (!rest.length) return { ids: [id], anchorId: id, go: index };
      const restIndices = rest.map(item => pageIds.indexOf(item));
      // The current page left the selection: show the nearest selected page instead.
      const go = pageIds[activeIndex] === id
        ? restIndices.reduce((best, candidate) => Math.abs(candidate - index) < Math.abs(best - index) ? candidate : best)
        : activeIndex;
      return { ids: rest, anchorId: anchorId && rest.includes(anchorId) ? anchorId : rest[0], go };
    }
    return { ids: [...current, id], anchorId: id, go: index };
  }
  return { ids: [id], anchorId: id, go: index };
}

// "Pages 2–4, 7" for labels, "2-4, 7" for the page-range field (its parser takes both dashes).
export function pageRangeText(indices, dash = '–') {
  const sorted = [...new Set(indices)].filter(Number.isSafeInteger).sort((a, b) => a - b);
  const runs = [];
  for (const index of sorted) {
    const last = runs.at(-1);
    if (last && index === last[1] + 1) last[1] = index;
    else runs.push([index, index]);
  }
  return runs.map(([from, to]) => from === to ? `${from + 1}` : `${from + 1}${dash}${to + 1}`).join(', ');
}

// Moves that bring `movingIds` (kept in document order) together in front of the gap `gap` (0 … page count,
// counted in the current order). Each step moves one page so that it lands directly before `beforeId`
// (or at the end when beforeId is null); steps run in the given order. Pages already in place are skipped.
export function pageBlockMoves(pageIds, movingIds, gap) {
  const moving = new Set(movingIds);
  const block = pageIds.filter(id => moving.has(id));
  if (!block.length) return [];
  const clampedGap = Math.max(0, Math.min(pageIds.length, Number(gap) || 0));
  // The first page after the gap that stays where it is; the block ends up right before it.
  let anchor = null;
  for (let index = clampedGap; index < pageIds.length; index += 1) {
    if (!moving.has(pageIds[index])) { anchor = pageIds[index]; break; }
  }
  const order = [...pageIds];
  const steps = [];
  let head = anchor;
  for (let k = block.length - 1; k >= 0; k -= 1) {
    const id = block[k];
    const from = order.indexOf(id);
    order.splice(from, 1);
    const to = head == null ? order.length : order.indexOf(head);
    order.splice(to, 0, id);
    if (to !== from) steps.push({ id, beforeId: head });
    head = id;
  }
  return steps;
}

// The destination index of a step for PAGE_MOVE (the index after the page is taken out).
export function pageMoveDestination(pageIds, step) {
  const rest = pageIds.filter(id => id !== step.id);
  if (step.beforeId == null) return rest.length;
  const index = rest.indexOf(step.beforeId);
  return index < 0 ? -1 : index;
}

// The final order after the moves, for checks and for the selection afterwards.
export function applyPageMoves(pageIds, steps) {
  let order = [...pageIds];
  for (const step of steps) {
    const destination = pageMoveDestination(order, step);
    if (destination < 0) continue;
    order = order.filter(id => id !== step.id);
    order.splice(destination, 0, step.id);
  }
  return order;
}

// Move up / Move down for a multi-selection: every selected page one place up or down, as one block per run
// of neighbouring pages. Returns null when a selected page is already at that end.
export function pageNeighbourMoves(pageIds, indices, dir) {
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  if (!sorted.length) return null;
  if (dir < 0 && sorted[0] <= 0) return null;
  if (dir > 0 && sorted.at(-1) >= pageIds.length - 1) return null;
  const runs = [];
  for (const index of sorted) {
    const last = runs.at(-1);
    if (last && index === last[1] + 1) last[1] = index;
    else runs.push([index, index]);
  }
  // The neighbour of each run jumps over it: one move per run.
  return runs.map(([from, to]) => dir < 0
    ? { id: pageIds[from - 1], beforeId: pageIds[to + 1] ?? null }
    : { id: pageIds[to + 1], beforeId: pageIds[from] });
}

// Where a dragged page would land: the gap before or after the thumbnail nearest to the point.
// `rects` are { index, left, top, right, bottom } of the visible thumbnails in client coordinates.
export function pageDropGap(rects, x, y, pageCount) {
  let best = null;
  let bestDistance = Infinity;
  for (const rect of rects) {
    const dx = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0;
    const dy = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
    const distance = dx * dx + dy * dy * 4;
    if (distance < bestDistance) { bestDistance = distance; best = rect; }
  }
  if (!best) return null;
  const after = x > (best.left + best.right) / 2;
  const gap = Math.max(0, Math.min(pageCount, best.index + (after ? 1 : 0)));
  return { gap, index: best.index, side: after ? 'after' : 'before' };
}
