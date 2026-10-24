// Redaction geometry in PDF user space (left/bottom/right/top, y up).
//
// PDFium's redaction removes every glyph whose box intersects a redaction
// rectangle, however slightly. A hand-drawn rectangle that grazes the
// descenders of the line above or the ascenders of the line below therefore
// deletes letters there. These helpers snap a drawn rectangle to the text
// lines it actually covers, keep it clear of every other glyph, preview the
// exact removal set and turn search matches into redaction rectangles.

const GENERATED = 1;
const ROTATED = 2;
const NO_BOX = 4;

// Distance kept between a snapped rectangle and any glyph it must not remove.
export const REDACTION_CLEARANCE = 0.25;
// Visual margin added around snapped text where neighbours leave room.
export const REDACTION_PADDING = 0.75;

export function glyphsFromTextGlyphResult(result) {
  const count = Math.max(0, Number(result?.count) || 0);
  const glyphs = new Array(count);
  for (let index = 0; index < count; index += 1) {
    const flags = Number(result.flags?.[index]) || 0;
    const code = Number(result.codes?.[index]) || 0;
    const left = Number(result.boxes?.[index * 4]);
    const bottom = Number(result.boxes?.[index * 4 + 1]);
    const right = Number(result.boxes?.[index * 4 + 2]);
    const top = Number(result.boxes?.[index * 4 + 3]);
    let char = '';
    try { char = code ? String.fromCodePoint(code) : ''; } catch { char = ''; }
    const looseBottom = Number(result.looseBoxes?.[index * 4 + 1]);
    const looseTop = Number(result.looseBoxes?.[index * 4 + 3]);
    glyphs[index] = {
      index,
      char,
      left, bottom, right, top,
      ...(Number.isFinite(looseBottom) && Number.isFinite(looseTop) && looseTop > looseBottom
        ? { lineBottom: looseBottom, lineTop: looseTop } : {}),
      originX: Number(result.origins?.[index * 2]),
      originY: Number(result.origins?.[index * 2 + 1]),
      size: Number(result.sizes?.[index]) || 0,
      generated: Boolean(flags & GENERATED),
      rotated: Boolean(flags & ROTATED),
      hasBox: !(flags & NO_BOX) && [left, bottom, right, top].every(Number.isFinite) && right > left && top > bottom,
    };
  }
  return glyphs;
}

function isInk(glyph) {
  return glyph.hasBox && !glyph.generated && !/^\s*$/u.test(glyph.char);
}

export function rectsOverlap(a, b, epsilon = 0) {
  return Math.min(a.right, b.right) - Math.max(a.left, b.left) > epsilon &&
    Math.min(a.top, b.top) - Math.max(a.bottom, b.bottom) > epsilon;
}

function union(boxes) {
  if (!boxes.length) return null;
  return {
    left: Math.min(...boxes.map(box => box.left)),
    bottom: Math.min(...boxes.map(box => box.bottom)),
    right: Math.max(...boxes.map(box => box.right)),
    top: Math.max(...boxes.map(box => box.top)),
  };
}

// The area a mark should cover for these glyphs: their ink horizontally and
// the full line height (font ascent to descent) vertically, so a line without
// ascenders or descenders is not covered by a thin sliver.
function coverBox(glyphs) {
  const ink = union(glyphs);
  if (!ink) return null;
  return {
    ...ink,
    bottom: Math.min(ink.bottom, ...glyphs.map(glyph => glyph.lineBottom ?? glyph.bottom)),
    top: Math.max(ink.top, ...glyphs.map(glyph => glyph.lineTop ?? glyph.top)),
  };
}

/** Glyphs PDFium removes for this rectangle (preview of the export). */
export function redactionRemovedGlyphs(glyphs, rect) {
  return glyphs.filter(glyph => isInk(glyph) && rectsOverlap(glyph, rect));
}

function baselineOf(glyph) {
  return Number.isFinite(glyph.originY) && glyph.originY !== 0 ? glyph.originY : glyph.bottom;
}

// Glyphs on one baseline form a line. Tolerance follows the font size so
// sub- and superscripts join their line while the next line does not.
export function groupGlyphLines(glyphs) {
  const sorted = [...glyphs].sort((a, b) => baselineOf(b) - baselineOf(a));
  const lines = [];
  for (const glyph of sorted) {
    const size = glyph.size || (glyph.top - glyph.bottom) || 1;
    const line = lines.find(item => Math.abs(item.baseline - baselineOf(glyph)) <= Math.max(0.75, Math.min(size, item.size) * 0.35));
    if (line) {
      line.glyphs.push(glyph);
      line.size = Math.max(line.size, size);
    } else {
      lines.push({ baseline: baselineOf(glyph), size, glyphs: [glyph] });
    }
  }
  return lines.map(line => ({ ...line, box: union(line.glyphs) }));
}

// Pads `rect` by up to REDACTION_PADDING and then shrinks it until it keeps
// REDACTION_CLEARANCE from every glyph outside `selected`. Returns the rect and
// how many selected glyphs it no longer reaches (only possible when lines
// physically overlap; the preview shows those glyphs as kept).
export function clearRedactionRect(glyphs, rect, selected, { padding = REDACTION_PADDING } = {}) {
  const selectedSet = new Set(selected);
  let result = {
    left: rect.left - padding, bottom: rect.bottom - padding,
    right: rect.right + padding, top: rect.top + padding,
  };
  const others = glyphs.filter(glyph => isInk(glyph) && !selectedSet.has(glyph));
  for (let pass = 0; pass < 32; pass += 1) {
    const blocker = others.find(glyph => rectsOverlap(glyph, {
      left: result.left - REDACTION_CLEARANCE, bottom: result.bottom - REDACTION_CLEARANCE,
      right: result.right + REDACTION_CLEARANCE, top: result.top + REDACTION_CLEARANCE,
    }));
    if (!blocker) break;
    const centerX = (result.left + result.right) / 2;
    const centerY = (result.bottom + result.top) / 2;
    const glyphX = (blocker.left + blocker.right) / 2;
    const glyphY = (blocker.bottom + blocker.top) / 2;
    // Resolve along the axis where the blocker sits outside the core text.
    const verticalGap = glyphY > centerY ? blocker.bottom - rect.top : rect.bottom - blocker.top;
    const horizontalGap = glyphX > centerX ? blocker.left - rect.right : rect.left - blocker.right;
    if (verticalGap >= horizontalGap) {
      if (glyphY > centerY) result.top = Math.min(result.top, blocker.bottom - REDACTION_CLEARANCE * 2);
      else result.bottom = Math.max(result.bottom, blocker.top + REDACTION_CLEARANCE * 2);
    } else if (glyphX > centerX) {
      result.right = Math.min(result.right, blocker.left - REDACTION_CLEARANCE * 2);
    } else {
      result.left = Math.max(result.left, blocker.right + REDACTION_CLEARANCE * 2);
    }
    if (result.right <= result.left || result.top <= result.bottom) return { rect: null, missed: selected.length };
  }
  const missed = selected.filter(glyph => !rectsOverlap(glyph, result)).length;
  return { rect: result, missed };
}

/**
 * Snap a drawn redaction rectangle to the text it covers. A line counts when
 * the drawn rectangle covers at least `minLineOverlap` of its height; its
 * glyphs count when their centre lies inside the drawn horizontal range.
 * Returns null when the rectangle covers no text line (keep it as drawn).
 */
export function snapRedactionRect(glyphs, drawn, { minLineOverlap = 0.5 } = {}) {
  const ink = glyphs.filter(glyph => isInk(glyph) && !glyph.rotated);
  const inRange = ink.filter(glyph => {
    const center = (glyph.left + glyph.right) / 2;
    return center >= drawn.left && center <= drawn.right;
  });
  const covered = [];
  let lineCount = 0;
  for (const line of groupGlyphLines(inRange)) {
    const height = line.box.top - line.box.bottom;
    const overlap = Math.min(line.box.top, drawn.top) - Math.max(line.box.bottom, drawn.bottom);
    if (height > 0 && overlap / height >= minLineOverlap) {
      covered.push(...line.glyphs);
      lineCount += 1;
    }
  }
  if (!covered.length) return null;
  const cleared = clearRedactionRect(glyphs, coverBox(covered), covered);
  if (!cleared.rect) return null;
  return { rect: cleared.rect, lineCount, glyphCount: covered.length, missed: cleared.missed };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * Find `query` in the page text and return one redaction rectangle per line
 * of every match. Whitespace in the query matches any whitespace or line
 * break; case-insensitive matching folds Unicode case (ß/ẞ, umlauts).
 */
export function findGlyphTextMatches(glyphs, query, { caseSensitive = false, wholeWord = false, contextChars = 32 } = {}) {
  const needle = String(query || '').trim();
  if (!needle) return [];
  let text = '';
  const owners = [];
  for (const glyph of glyphs) {
    const value = glyph.char || ' ';
    text += value;
    for (let unit = 0; unit < value.length; unit += 1) owners.push(glyph);
  }
  const body = needle.split(/\s+/u).map(escapeRegExp).join('\\s+');
  const pattern = wholeWord ? `(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])` : body;
  const expression = new RegExp(pattern, caseSensitive ? 'gu' : 'giu');
  const matches = [];
  for (const match of text.matchAll(expression)) {
    const start = match.index;
    const end = start + match[0].length;
    const matched = [...new Set(owners.slice(start, end))].filter(isInk);
    if (!matched.length) continue;
    const rects = [];
    let missed = 0;
    for (const line of groupGlyphLines(matched)) {
      const cleared = clearRedactionRect(glyphs, coverBox(line.glyphs), line.glyphs);
      if (cleared.rect) rects.push(cleared.rect);
      missed += cleared.rect ? cleared.missed : line.glyphs.length;
    }
    if (!rects.length) continue;
    const before = text.slice(Math.max(0, start - contextChars), start).replace(/\s+/gu, ' ');
    const after = text.slice(end, end + contextChars).replace(/\s+/gu, ' ');
    matches.push({ text: match[0].replace(/\s+/gu, ' '), start, end, rects, missed, before, after });
  }
  return matches;
}

/** Case/whole-word aware occurrence test for bookmark, metadata and comment text. */
export function textContainsQuery(value, query, { caseSensitive = false, wholeWord = false } = {}) {
  return replaceQueryInText(value, query, '', { caseSensitive, wholeWord }).count > 0;
}

export function replaceQueryInText(value, query, replacement, { caseSensitive = false, wholeWord = false } = {}) {
  const needle = String(query || '').trim();
  const source = String(value ?? '');
  if (!needle || !source) return { text: source, count: 0 };
  const body = needle.split(/\s+/u).map(escapeRegExp).join('\\s+');
  const pattern = wholeWord ? `(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])` : body;
  let count = 0;
  const text = source.replace(new RegExp(pattern, caseSensitive ? 'gu' : 'giu'), () => {
    count += 1;
    return replacement;
  });
  return { text, count };
}
