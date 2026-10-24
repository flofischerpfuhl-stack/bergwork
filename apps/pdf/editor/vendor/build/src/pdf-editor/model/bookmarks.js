function boundedDepth(value, maximum) {
  return Math.max(0, Math.min(maximum, Math.trunc(Number(value) || 0)));
}

export function normalizeBookmarks(bookmarks = [], pages = []) {
  const pageIds = new Set((pages || []).map(page => page?.id).filter(Boolean));
  const seen = new Set();
  const normalized = [];
  for (const [index, item] of (bookmarks || []).entries()) {
    if (!item?.id || seen.has(item.id) || !pageIds.has(item.pageId)) continue;
    seen.add(item.id);
    normalized.push({
      id: String(item.id),
      title: String(item.title || '').trim() || `Bookmark ${index + 1}`,
      pageId: String(item.pageId),
      depth: boundedDepth(item.depth, normalized.length ? normalized.at(-1).depth + 1 : 0),
    });
  }
  return normalized;
}

export function bookmarkWithTitle(bookmarks, id, title) {
  const nextTitle = String(title || '').trim();
  if (!nextTitle) return bookmarks;
  return bookmarks.map(item => item.id === id ? { ...item, title: nextTitle } : item);
}

export function bookmarksWithout(bookmarks, id) {
  const index = bookmarks.findIndex(item => item.id === id);
  if (index < 0) return bookmarks;
  const removedDepth = bookmarks[index].depth || 0;
  let subtreeEnd = index + 1;
  while (subtreeEnd < bookmarks.length && (bookmarks[subtreeEnd].depth || 0) > removedDepth) subtreeEnd += 1;
  return bookmarks
    .filter(item => item.id !== id)
    .map((item, itemIndex) => itemIndex >= index && itemIndex < subtreeEnd - 1 && (item.depth || 0) > removedDepth
      ? { ...item, depth: Math.max(removedDepth, (item.depth || 0) - 1) }
      : item);
}

export function moveBookmark(bookmarks, id, direction) {
  const index = bookmarks.findIndex(item => item.id === id);
  if (index < 0) return bookmarks;
  const depth = bookmarks[index].depth || 0;
  let end = index + 1;
  while (end < bookmarks.length && (bookmarks[end].depth || 0) > depth) end += 1;
  if (direction < 0) {
    let previous = index - 1;
    while (previous >= 0 && (bookmarks[previous].depth || 0) > depth) previous -= 1;
    if (previous < 0 || (bookmarks[previous].depth || 0) !== depth) return bookmarks;
    return [
      ...bookmarks.slice(0, previous),
      ...bookmarks.slice(index, end),
      ...bookmarks.slice(previous, index),
      ...bookmarks.slice(end),
    ];
  }
  let next = end;
  while (next < bookmarks.length && (bookmarks[next].depth || 0) > depth) next += 1;
  if (next >= bookmarks.length || (bookmarks[next].depth || 0) !== depth) return bookmarks;
  let nextEnd = next + 1;
  while (nextEnd < bookmarks.length && (bookmarks[nextEnd].depth || 0) > depth) nextEnd += 1;
  return [
    ...bookmarks.slice(0, index),
    ...bookmarks.slice(next, nextEnd),
    ...bookmarks.slice(index, end),
    ...bookmarks.slice(nextEnd),
  ];
}

export function changeBookmarkDepth(bookmarks, id, delta) {
  const index = bookmarks.findIndex(item => item.id === id);
  if (index < 0) return bookmarks;
  const current = bookmarks[index].depth || 0;
  const maximum = index ? (bookmarks[index - 1].depth || 0) + 1 : 0;
  const depth = boundedDepth(current + Math.sign(delta || 0), maximum);
  if (depth === current) return bookmarks;
  const shift = depth - current;
  let end = index + 1;
  while (end < bookmarks.length && (bookmarks[end].depth || 0) > current) end += 1;
  return bookmarks.map((item, itemIndex) => itemIndex >= index && itemIndex < end
    ? { ...item, depth: Math.max(0, (item.depth || 0) + shift) }
    : item);
}
