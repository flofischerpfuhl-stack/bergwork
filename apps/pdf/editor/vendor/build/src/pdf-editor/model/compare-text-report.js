// Text part of Compare: diff each page against the page at the same index and
// report the changes grouped under a page header. A change is one hunk of
// adjacent removed/added words (whitespace between them included), so a
// watermark "COMPARE QA" reads as one line instead of one line per word.

const MAX_REPORT_LINES = 400;

const tidy = value => String(value || '').replace(/\s+/g, ' ').trim();

function diffParts(diff, left, right, granularity) {
  if (granularity === 'line') return diff.diffLines(left, right);
  if (granularity === 'char') return diff.diffChars(left, right);
  return diff.diffWords(left, right);
}

/** Groups diff parts into hunks of adjacent changes. */
export function diffHunks(parts = []) {
  const hunks = [];
  let current = null;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part.added || part.removed) {
      current ||= { removed: '', added: '' };
      if (part.added) current.added += part.value;
      else current.removed += part.value;
      continue;
    }
    // Unchanged whitespace between two changes belongs to the hunk.
    const next = parts[index + 1];
    if (current && !part.value.trim() && (next?.added || next?.removed)) {
      if (current.added) current.added += part.value;
      if (current.removed) current.removed += part.value;
      continue;
    }
    if (current) hunks.push(current);
    current = null;
  }
  if (current) hunks.push(current);
  return hunks
    .map(hunk => ({ removed: tidy(hunk.removed), added: tidy(hunk.added) }))
    .filter(hunk => hunk.removed || hunk.added);
}

/**
 * @param {{ diffWords: Function, diffLines: Function, diffChars: Function }} diff jsdiff module
 * @param {string[]} leftPages text of each left page
 * @param {string[]} rightPages text of each right page
 * @param {'word'|'line'|'char'} granularity
 * @returns {{ added: number, removed: number, pages: Array<{ pageNumber: number, label: string, hunks: Array<{removed: string, added: string}> }>, text: string }}
 */
export function buildPageTextDiffReport(diff, leftPages = [], rightPages = [], granularity = 'word') {
  let added = 0;
  let removed = 0;
  const pages = [];
  const count = Math.max(leftPages.length, rightPages.length);
  for (let index = 0; index < count; index += 1) {
    const left = String(leftPages[index] ?? '');
    const right = String(rightPages[index] ?? '');
    if (tidy(left) === tidy(right)) continue;
    const parts = diffParts(diff, left, right, granularity);
    for (const part of parts) {
      if (part.added) added += part.value.length;
      else if (part.removed) removed += part.value.length;
    }
    const hunks = diffHunks(parts);
    if (!hunks.length) continue;
    const label = index >= leftPages.length
      ? `Page ${index + 1} (only in the right PDF)`
      : index >= rightPages.length
        ? `Page ${index + 1} (only in the left PDF)`
        : `Page ${index + 1}`;
    pages.push({ pageNumber: index + 1, label, hunks });
  }
  const lines = [];
  for (const page of pages) {
    if (lines.length) lines.push('');
    lines.push(page.label);
    for (const hunk of page.hunks) {
      if (hunk.removed) lines.push(`- ${hunk.removed}`);
      if (hunk.added) lines.push(`+ ${hunk.added}`);
    }
  }
  const text = lines.length > MAX_REPORT_LINES
    ? `${lines.slice(0, MAX_REPORT_LINES).join('\n')}\n… ${lines.length - MAX_REPORT_LINES} more lines`
    : lines.join('\n');
  return { added, removed, pages, text };
}
