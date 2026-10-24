// Find-in-PDF text index. A page's text items (PDF.js text content in content
// order) are joined into one folded search string. Every folded character
// remembers the item and the source character range it came from, so a hit is
// highlighted on the matched characters only, never on its whole line.

const COMBINING_MARK = /\p{M}/u;
const WHITESPACE = /\s/u;
const LETTER = /\p{L}/u;
const LOWERCASE_LETTER = /\p{Ll}/u;
const LINE_END_HYPHENS = new Set(['-', '\u00ad', '\u2010', '\u2011']);
const PUNCTUATION_FOLD = new Map([
  ['\u2018', "'"], ['\u2019', "'"], ['\u201a', "'"], ['\u201b', "'"], ['\u2032', "'"],
  ['\u201c', '"'], ['\u201d', '"'], ['\u201e', '"'], ['\u201f', '"'], ['\u00ab', '"'], ['\u00bb', '"'],
  ['\u2010', '-'], ['\u2011', '-'], ['\u2012', '-'], ['\u2013', '-'], ['\u2014', '-'], ['\u2212', '-'],
]);

const foldCache = new Map();

/**
 * Case-insensitive, Unicode-normalised form of one grapheme-like cluster
 * (base character plus combining marks). Composed and decomposed umlauts fold
 * to the same text, sharp s matches "ss", ligatures match their letters.
 */
function foldCluster(cluster) {
  let out = foldCache.get(cluster);
  if (out !== undefined) return out;
  out = '';
  if (cluster !== '\u00ad') {
    const folded = cluster.normalize('NFKC').toLowerCase().normalize('NFC')
      .replace(/\u00df/gu, 'ss').replace(/\u03c2/gu, '\u03c3');
    for (const char of folded) out += PUNCTUATION_FOLD.get(char) ?? char;
  }
  // Page text uses a small alphabet; the cache keeps indexing a long
  // document from normalising every character again.
  if (foldCache.size < 8192) foldCache.set(cluster, out);
  return out;
}

function isSearchWhitespace(char) {
  const code = char.charCodeAt(0);
  return code <= 0x20 || (code >= 0x7f && WHITESPACE.test(char));
}

/** Calls visit(cluster, start, end) per base character with its combining marks. */
function forEachCluster(text, visit) {
  let cluster = '';
  let start = 0;
  let offset = 0;
  for (const char of text) {
    if (cluster && char.charCodeAt(0) >= 0x300 && COMBINING_MARK.test(char)) {
      cluster += char;
    } else {
      if (cluster) visit(cluster, start, offset);
      cluster = char;
      start = offset;
    }
    offset += char.length;
  }
  if (cluster) visit(cluster, start, offset);
}

/** Folded query: same folding as the page text, whitespace collapsed. */
export function normalizeSearchQuery(query) {
  let out = '';
  forEachCluster(String(query || '').trim(), cluster => {
    if (isSearchWhitespace(cluster)) {
      if (!out.endsWith(' ')) out += ' ';
      return;
    }
    out += foldCluster(cluster);
  });
  return out.trim();
}

function axisFrame(item) {
  const angle = Number(item.angle) || 0;
  return { ux: Math.cos(angle), uy: Math.sin(angle), px: -Math.sin(angle), py: Math.cos(angle), angle };
}

function projectedExtent(item, frame) {
  const block = Math.max(0.01, Number(item.block) || 0);
  const inline = Math.max(0, Number(item.inline) || 0);
  const x = Number(item.qx) || 0;
  const y = Number(item.qy) || 0;
  const itemFrame = axisFrame(item);
  const corners = [
    [x, y],
    [x + itemFrame.ux * inline, y + itemFrame.uy * inline],
    [x + itemFrame.ux * inline + itemFrame.px * block, y + itemFrame.uy * inline + itemFrame.py * block],
    [x + itemFrame.px * block, y + itemFrame.py * block],
  ];
  const along = corners.map(([cx, cy]) => cx * frame.ux + cy * frame.uy);
  const across = corners.map(([cx, cy]) => cx * frame.px + cy * frame.py);
  return {
    minA: Math.min(...along),
    maxA: Math.max(...along),
    minP: Math.min(...across),
    maxP: Math.max(...across),
  };
}

/**
 * Relation between two consecutive items in content order: same visual line
 * (and whether a word gap separates them) or a new line.
 */
function itemJoin(previous, item) {
  const frame = axisFrame(previous);
  if (Math.abs((Number(item.angle) || 0) - frame.angle) > 0.1) return { sameLine: false, space: true };
  const left = projectedExtent(previous, frame);
  const right = projectedExtent(item, frame);
  const size = Math.max(0.5, Number(previous.block) || 0, Number(item.block) || 0);
  const centreDelta = Math.abs((left.minP + left.maxP) / 2 - (right.minP + right.maxP) / 2);
  const gap = right.minA - left.maxA;
  if (centreDelta > size * 0.5 || gap < -size * 0.5) return { sameLine: false, space: true };
  return { sameLine: true, space: gap > size * 0.18 };
}

/**
 * Builds the searchable text of one page.
 * @param {Array<{str: string, qx: number, qy: number, angle?: number, inline: number, block: number}>} items
 *   text items in content order; qx/qy is the top-left corner of the item's
 *   quad, inline/block its advance and height, all in display units.
 */
export function buildPageSearchIndex(items = []) {
  const chars = [];
  const charItem = [];
  const charStart = [];
  const charEnd = [];
  const kept = [];
  const itemLine = [];
  let line = 0;
  let previous = null;
  let pendingSpace = false;
  const pushSpace = () => {
    if (!chars.length || chars[chars.length - 1] === ' ') return;
    chars.push(' ');
    charItem.push(-1);
    charStart.push(0);
    charEnd.push(0);
  };
  for (const item of items) {
    const str = String(item?.str ?? '');
    if (!str.trim()) {
      if (str.length) pendingSpace = true;
      if (item?.hasEOL) pendingSpace = true;
      continue;
    }
    if (!(Number(item.inline) > 0) || !(Number(item.block) > 0)) continue;
    let dropTrailingHyphenOf = -1;
    if (previous) {
      const join = itemJoin(previous.item, item);
      if (!join.sameLine) line += 1;
      const previousText = previous.item.str.replace(/\s+$/u, '');
      const lastChar = previousText.slice(-1);
      const beforeLast = previousText.slice(-2, -1);
      const firstChar = str.trimStart().charAt(0);
      if (!join.sameLine && LINE_END_HYPHENS.has(lastChar) && LETTER.test(beforeLast) &&
          LOWERCASE_LETTER.test(firstChar)) {
        // "Euchari-" + "stie" on the next line reads as one word.
        dropTrailingHyphenOf = previous.index;
      } else if (pendingSpace || join.space) {
        pushSpace();
      }
    }
    if (dropTrailingHyphenOf >= 0) {
      // Remove the hyphen (and any whitespace behind it) from the haystack.
      const pop = () => { chars.pop(); charItem.pop(); charStart.pop(); charEnd.pop(); };
      while (chars.length && chars[chars.length - 1] === ' ' && charItem[charItem.length - 1] < 0) pop();
      if (chars.length && chars[chars.length - 1] === '-' &&
          charItem[charItem.length - 1] === dropTrailingHyphenOf) pop();
    }
    pendingSpace = Boolean(item.hasEOL);
    const index = kept.length;
    kept.push(item);
    itemLine.push(line);
    forEachCluster(str, (cluster, start, end) => {
      if (isSearchWhitespace(cluster)) {
        pushSpace();
        return;
      }
      const folded = foldCluster(cluster);
      for (let unit = 0; unit < folded.length; unit += 1) {
        chars.push(folded[unit]);
        charItem.push(index);
        charStart.push(start);
        charEnd.push(end);
      }
    });
    previous = { item, index };
  }
  return {
    text: chars.join(''),
    charItem: Int32Array.from(charItem),
    charStart: Int32Array.from(charStart),
    charEnd: Int32Array.from(charEnd),
    items: kept,
    itemLine: Int32Array.from(itemLine),
  };
}

/**
 * Finds every non-overlapping occurrence of an already folded needle.
 * Each match lists, per text item, the source character range it covers.
 */
const RTL_RUN = /[\p{Script=Arabic}\p{Script=Hebrew}\p{M}]+(?: [\p{Script=Arabic}\p{Script=Hebrew}\p{M}]+)*/gu;

// Arabic/Hebrew typed by the user is in logical order. Some producers store
// right-to-left words in visual order, which PDFium and Poppler then read
// backwards; the mirrored query finds those too.
function needleVariants(needle) {
  const mirrored = needle.replace(RTL_RUN, run => [...run].reverse().join(''));
  return mirrored === needle ? [needle] : [needle, mirrored];
}

export function findSearchMatches(index, needle) {
  if (!index?.text || !needle) return [];
  const variants = needleVariants(needle);
  if (variants.length === 1) return findExactMatches(index, needle);
  const found = variants.flatMap(variant => findExactMatches(index, variant)).sort((a, b) => a.start - b.start);
  return found.filter((match, position) => !position || match.start >= found[position - 1].end);
}

function findExactMatches(index, needle) {
  const matches = [];
  let offset = index.text.indexOf(needle);
  while (offset >= 0) {
    const end = offset + needle.length;
    const byItem = new Map();
    for (let position = offset; position < end; position += 1) {
      const itemIndex = index.charItem[position];
      if (itemIndex < 0) continue;
      const range = byItem.get(itemIndex);
      if (range) {
        range.from = Math.min(range.from, index.charStart[position]);
        range.to = Math.max(range.to, index.charEnd[position]);
      } else {
        byItem.set(itemIndex, { itemIndex, from: index.charStart[position], to: index.charEnd[position] });
      }
    }
    if (byItem.size) {
      matches.push({
        start: offset,
        end,
        segments: [...byItem.values()].sort((a, b) => a.itemIndex - b.itemIndex),
        context: index.text.slice(Math.max(0, offset - 30), end + 30).trim(),
      });
    }
    offset = index.text.indexOf(needle, end);
  }
  return matches;
}

/**
 * Converts a match into highlight rectangles, one per visual line. A rect is
 * {x, y, w, h, angle}: (x, y) is its top-left corner and the box is rotated by
 * `angle` around that corner. `fractions(item, from, to)` returns where the
 * character range starts and ends as fractions [0..1] of the item advance.
 */
export function searchMatchRects(index, match, fractions) {
  const groups = new Map();
  for (const segment of match?.segments || []) {
    const item = index.items[segment.itemIndex];
    if (!item) continue;
    const length = String(item.str).length || 1;
    let [start, end] = typeof fractions === 'function'
      ? fractions(item, segment.from, segment.to)
      : [segment.from / length, segment.to / length];
    if (!Number.isFinite(start) || !Number.isFinite(end)) [start, end] = [segment.from / length, segment.to / length];
    start = Math.min(1, Math.max(0, start));
    end = Math.min(1, Math.max(start, end));
    const frame = axisFrame(item);
    const inline = Number(item.inline) || 0;
    const part = {
      ...item,
      qx: item.qx + frame.ux * inline * start,
      qy: item.qy + frame.uy * inline * start,
      inline: Math.max(0.5, inline * (end - start)),
    };
    const lineKey = index.itemLine[segment.itemIndex];
    const group = groups.get(lineKey) || { frame, parts: [] };
    group.parts.push(part);
    groups.set(lineKey, group);
  }
  const rects = [];
  for (const { frame, parts } of groups.values()) {
    let minA = Infinity;
    let maxA = -Infinity;
    let minP = Infinity;
    let maxP = -Infinity;
    for (const part of parts) {
      const extent = projectedExtent(part, frame);
      minA = Math.min(minA, extent.minA);
      maxA = Math.max(maxA, extent.maxA);
      minP = Math.min(minP, extent.minP);
      maxP = Math.max(maxP, extent.maxP);
    }
    rects.push({
      x: frame.ux * minA + frame.px * minP,
      y: frame.uy * minA + frame.py * minP,
      w: maxA - minA,
      h: maxP - minP,
      angle: frame.angle,
    });
  }
  return rects;
}

/** Axis-aligned bounds of rotated highlight rects (for scrolling/tests). */
export function searchRectBounds(rects = []) {
  const xs = [];
  const ys = [];
  for (const rect of rects) {
    const frame = axisFrame(rect);
    for (const [a, p] of [[0, 0], [rect.w, 0], [rect.w, rect.h], [0, rect.h]]) {
      xs.push(rect.x + frame.ux * a + frame.px * p);
      ys.push(rect.y + frame.uy * a + frame.py * p);
    }
  }
  if (!xs.length) return null;
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/**
 * Turns PDFium text-page output (reading-order code points, generated-char
 * flags and one display-space box per character) into line items for
 * buildPageSearchIndex. Each item keeps its characters' exact start/end
 * offsets along the line, so highlights need no font measuring.
 */
export function pdfiumPageSearchItems({ codes = [], flags = [], boxes = [] } = {}) {
  const items = [];
  let run = [];
  const flush = hasEOL => {
    const boxed = run.filter(char => char.box);
    if (!boxed.length) {
      run = [];
      return;
    }
    const centre = char => [(char.box[0] + char.box[2]) / 2, (char.box[1] + char.box[3]) / 2];
    const [x0, y0] = centre(boxed[0]);
    const [x1, y1] = centre(boxed[boxed.length - 1]);
    const dx = x1 - x0;
    const dy = y1 - y0;
    const angle = boxed.length < 2 || Math.abs(dx) >= Math.abs(dy)
      ? (dx < 0 ? Math.PI : 0)
      : (dy < 0 ? -Math.PI / 2 : Math.PI / 2);
    const frame = axisFrame({ angle });
    const project = box => {
      const along = [box[0] * frame.ux + box[1] * frame.uy, box[2] * frame.ux + box[3] * frame.uy];
      const across = [box[0] * frame.px + box[1] * frame.py, box[2] * frame.px + box[3] * frame.py];
      return [Math.min(...along), Math.max(...along), Math.min(...across), Math.max(...across)];
    };
    let minA = Infinity;
    let maxA = -Infinity;
    let minP = Infinity;
    let maxP = -Infinity;
    for (const char of boxed) {
      char.extent = project(char.box);
      minA = Math.min(minA, char.extent[0]);
      maxA = Math.max(maxA, char.extent[1]);
      minP = Math.min(minP, char.extent[2]);
      maxP = Math.max(maxP, char.extent[3]);
    }
    let str = '';
    const starts = [];
    const ends = [];
    let cursor = 0;
    for (const char of run) {
      const start = char.extent ? char.extent[0] - minA : cursor;
      const end = char.extent ? char.extent[1] - minA : cursor;
      cursor = end;
      for (let unit = 0; unit < char.text.length; unit += 1) {
        starts.push(start);
        ends.push(end);
      }
      str += char.text;
    }
    items.push({
      str,
      hasEOL,
      qx: frame.ux * minA + frame.px * minP,
      qy: frame.uy * minA + frame.py * minP,
      angle,
      inline: Math.max(0.5, maxA - minA),
      block: Math.max(0.5, maxP - minP),
      charStarts: Float32Array.from(starts),
      charEnds: Float32Array.from(ends),
    });
    run = [];
  };
  // PDFium joins a hyphenated line with the next one without a line break;
  // split runs where the glyphs themselves move to another line.
  let axis = null;
  let last = null;
  const continuesLine = box => {
    if (!last) return true;
    const size = Math.max(0.5, last[3] - last[1], box[3] - box[1]);
    const width = Math.max(0.5, last[2] - last[0], box[2] - box[0]);
    const dx = (box[0] + box[2]) / 2 - (last[0] + last[2]) / 2;
    const dy = (box[1] + box[3]) / 2 - (last[1] + last[3]) / 2;
    const horizontal = Math.abs(dy) <= size * 0.6 && dx > -size;
    const vertical = Math.abs(dx) <= width * 0.6 && Math.abs(dy) < size * 1.6;
    if (axis === 'horizontal') return horizontal;
    if (axis === 'vertical') return vertical;
    axis = horizontal ? 'horizontal' : vertical ? 'vertical' : null;
    return Boolean(axis);
  };
  for (let index = 0; index < codes.length; index += 1) {
    const code = Number(codes[index]) || 0;
    const generated = Boolean(Number(flags[index]) & 1);
    if (code === 13 || code === 10) {
      if (run.length) flush(true);
      axis = null;
      last = null;
      continue;
    }
    if (!code || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) continue;
    // PDFium reports a line-end hyphen as U+0002.
    const text = code === 2 ? '-' : String.fromCodePoint(code);
    const raw = generated ? null : [boxes[index * 4], boxes[index * 4 + 1], boxes[index * 4 + 2], boxes[index * 4 + 3]];
    const box = raw && raw.every(Number.isFinite) && raw[2] >= raw[0] && raw[3] >= raw[1] ? raw : null;
    if (box && !continuesLine(box)) {
      flush(true);
      axis = null;
    }
    if (box) last = box;
    run.push({ text, box });
  }
  if (run.length) flush(false);
  return items;
}

/** Exact fractions for items built by pdfiumPageSearchItems. */
export function boxedTextFractions(item, from, to) {
  if (!item?.charStarts || !item.charEnds || !(item.inline > 0)) return null;
  let start = Infinity;
  let end = -Infinity;
  for (let index = Math.max(0, from); index < Math.min(to, item.charStarts.length); index += 1) {
    start = Math.min(start, item.charStarts[index]);
    end = Math.max(end, item.charEnds[index]);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return [start / item.inline, end / item.inline];
}
