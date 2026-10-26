// @ts-check
//
// Layout of an edited single-line PDF text run whose characters have explicit
// origins. PDF producers position glyphs with TJ offsets, Tc/Tw spacing and
// runs of spaces (PDFium's text page reports a run of spaces as one space that
// advances over the whole gap). Laying the edited string out from scratch
// collapses those gaps; this module keeps every unchanged character where it
// was. The worker writes the result into the PDF and the inline editor shows
// the same layout while typing, so both import exactly this code.
//
// Coordinates are one-dimensional along the run's baseline (`along`, page
// points from the first glyph's origin) plus the perpendicular offset
// (`across`). Widths are natural glyph advances in the same page points.

/** Gaps at least this wide (in em beyond the natural advance) act like tab stops. */
export const POSITIONED_RUN_WIDE_GAP_EM = 0.75;
/**
 * Two origins closer than this (in em) are the same position: 0.01 em is
 * 0.12 pt at 12 pt, far below a screen pixel, but it lets producer rounding
 * (TJ offsets of a few thousandths of an em) stay inside one text object.
 */
export const POSITIONED_RUN_TOLERANCE_EM = 0.01;
/** Absolute floor of the tolerance in page points (float32 origin noise). */
export const POSITIONED_RUN_TOLERANCE_PT = 0.004;
// A gap that absorbs a longer edit keeps at least this much room (em) after a
// non-space character, so a label never runs into its value.
const MIN_TAB_GAP_EM = 0.25;

const isSpace = character => /\s/u.test(character);

/** @param {number} fontSize */
export function positionedRunTolerance(fontSize) {
  return Math.max(POSITIONED_RUN_TOLERANCE_PT, POSITIONED_RUN_TOLERANCE_EM * Math.abs(Number(fontSize) || 0));
}

/**
 * Maps the characters of `sourceText` to native glyph origins. Whitespace the
 * text page did not report (a space PDFium inferred between two objects, or a
 * space the editor's text has but the content has not) gets the natural end of
 * the preceding glyph; native whitespace the text lacks is skipped. Returns
 * null when the non-space characters differ.
 *
 * @param {string} sourceText
 * @param {{ text: string, along: number, across: number }[]} glyphs
 * @param {(character: string, glyph: object | null) => number} widthOf natural advance in page
 *   points; `glyph` is the native glyph the character maps to (null when synthesized)
 * @returns {{ along: number[], across: number[], widths: number[] } | null}
 */
export function alignRunCharacters(sourceText, glyphs, widthOf) {
  const characters = Array.from(String(sourceText ?? ''));
  if (!characters.length || !Array.isArray(glyphs) || !glyphs.length) return null;
  const along = [];
  const across = [];
  const widths = [];
  let cursor = 0;
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    while (cursor < glyphs.length && isSpace(glyphs[cursor].text) && !isSpace(character)) cursor += 1;
    const glyph = glyphs[cursor];
    const matched = glyph && glyph.text === character ? glyph : null;
    const width = Number(widthOf(character, matched));
    if (!Number.isFinite(width)) return null;
    if (matched) {
      if (!Number.isFinite(glyph.along) || !Number.isFinite(glyph.across)) return null;
      along.push(Number(glyph.along));
      across.push(Number(glyph.across));
      widths.push(width);
      cursor += 1;
      continue;
    }
    if (!isSpace(character)) return null;
    // Synthesized whitespace: directly after the previous glyph.
    const previous = along.length - 1;
    along.push(previous >= 0 ? along[previous] + widths[previous] : Number(glyph?.along ?? 0));
    across.push(previous >= 0 ? across[previous] : Number(glyph?.across ?? 0));
    widths.push(width);
  }
  while (cursor < glyphs.length && isSpace(glyphs[cursor].text)) cursor += 1;
  if (cursor !== glyphs.length) return null;
  return { along, across, widths };
}

/**
 * The run's uniform character and word spacing (Tc, Tw) in page points, when
 * the origins show one. A single wide gap or scattered kerning is no uniform
 * spacing and yields 0: it must stay a positioned gap, not spread to new text.
 *
 * @param {string} text
 * @param {number[]} along
 * @param {number[]} widths
 * @param {number} fontSize visible font size in page points
 */
export function estimateRunSpacing(text, along, widths, fontSize) {
  const characters = Array.from(String(text ?? ''));
  const tolerance = positionedRunTolerance(fontSize);
  const wide = POSITIONED_RUN_WIDE_GAP_EM * Math.abs(Number(fontSize) || 0);
  const letters = [];
  const spaces = [];
  for (let index = 0; index + 1 < characters.length; index += 1) {
    const residual = along[index + 1] - along[index] - widths[index];
    if (!Number.isFinite(residual)) continue;
    (characters[index] === ' ' ? spaces : letters).push(residual);
  }
  const uniform = values => {
    if (!values.length) return 0;
    const sorted = [...values].sort((left, right) => left - right);
    const median = sorted[Math.floor(sorted.length / 2)];
    const close = values.filter(value => Math.abs(value - median) <= tolerance).length;
    return Math.abs(median) > tolerance && close >= Math.max(2, Math.ceil(values.length * 0.6)) &&
      Math.abs(median) < wide ? median : 0;
  };
  const characterSpacing = uniform(letters);
  const wordResiduals = spaces.map(value => value - characterSpacing);
  // One word space shows Tw directly, unless it is a tab-like gap.
  const single = wordResiduals.length === 1 && Math.abs(wordResiduals[0]) > tolerance &&
    Math.abs(wordResiduals[0]) < wide ? wordResiduals[0] : 0;
  return { characterSpacing, wordSpacing: wordResiduals.length >= 2 ? uniform(wordResiduals) : single };
}

/**
 * The gap a word space makes in this run (median distance from the end of the
 * glyph before a space to the next glyph), for fonts whose space glyph has no
 * advance (old TeX subsets space words with TJ offsets). Wide tab-like gaps
 * are no word space. Null when the run has no measurable word space.
 *
 * @param {string} text
 * @param {number[]} along
 * @param {number[]} widths
 * @param {number} fontSize
 */
export function observedWordGap(text, along, widths, fontSize) {
  const characters = Array.from(String(text ?? ''));
  const wide = POSITIONED_RUN_WIDE_GAP_EM * Math.abs(Number(fontSize) || 0);
  const gaps = [];
  for (let index = 1; index + 1 < characters.length; index += 1) {
    if (!isSpace(characters[index]) || isSpace(characters[index - 1]) || isSpace(characters[index + 1])) continue;
    const gap = along[index + 1] - (along[index - 1] + widths[index - 1]);
    if (Number.isFinite(gap) && gap > 0 && gap < wide) gaps.push(gap);
  }
  if (!gaps.length) return null;
  gaps.sort((left, right) => left - right);
  const middle = Math.floor(gaps.length / 2);
  return gaps.length % 2 ? gaps[middle] : (gaps[middle - 1] + gaps[middle]) / 2;
}

/**
 * Lays out `replacementText` against a positioned source run. Characters are
 * matched to the source by alignRunEdit; every edited place (hunk) is handled
 * the same way:
 *
 * - Unchanged characters before the first edit keep their exact origins.
 * - Edited text starts where the first removed character (or, for an
 *   insertion, the character after the caret) started, and advances naturally
 *   with the run's font, size and uniform Tc/Tw.
 * - Unchanged characters after it keep their origins shifted by the width
 *   change, and the gap after the removed characters keeps its width. The
 *   first wide gap after an edit absorbs the shift like a tab stop, so a value
 *   column after a label stays in place.
 *
 * @param {{ text: string, along: number[], across: number[], widths: number[],
 *   fontSize: number, characterSpacing?: number, wordSpacing?: number }} source
 * @param {string} replacementText
 * @param {(character: string) => number} widthOf natural advance in page points
 * @returns {{ text: string, along: number[], across: number[], advances: number[] }}
 */
export function layoutPositionedRun(source, replacementText, widthOf) {
  const sourceCharacters = Array.from(String(source?.text ?? ''));
  const characters = Array.from(String(replacementText ?? ''));
  const count = sourceCharacters.length;
  const fontSize = Math.abs(Number(source?.fontSize) || 0);
  const tc = Number(source?.characterSpacing) || 0;
  const tw = Number(source?.wordSpacing) || 0;
  const A = source.along;
  const C = source.across;
  const sourceAdvance = index => source.widths[index] + tc + (sourceCharacters[index] === ' ' ? tw : 0);
  // A font without an advancing space glyph: a typed space takes the run's
  // own word gap (or a quarter em, the interword space of TeX text faces).
  const spaceWidth = Number(widthOf(' '));
  const wordGap = Number.isFinite(spaceWidth) && spaceWidth > positionedRunTolerance(fontSize)
    ? null
    : observedWordGap(source.text, A, source.widths, fontSize) ?? fontSize * 0.25;
  const advanceOf = character => (wordGap != null && isSpace(character)
    ? wordGap
    : Number(widthOf(character)) + tc + (character === ' ' ? tw : 0));
  const along = [];
  const across = [];
  const advances = [];
  const wideGap = POSITIONED_RUN_WIDE_GAP_EM * fontSize;
  let delta = 0;
  // After an edit changed the width, the first wide gap after it absorbs the
  // change like a tab stop. `hunkEnd` is where the edited source text ended
  // (original coordinates), so a gap is measured from the edit, not across it.
  let pendingAbsorb = false;
  let hunkEnd = null;
  let previousOutput = '';
  const operations = alignRunEdit(sourceCharacters, characters);
  for (let index = 0; index < operations.length;) {
    const operation = operations[index];
    if (operation.kind === 'keep') {
      const k = operation.source;
      if (pendingAbsorb && delta !== 0 && wideGap > 0 && k > 0) {
        const previousEnd = hunkEnd ?? A[k - 1] + sourceAdvance(k - 1);
        const gap = A[k] - previousEnd;
        if (gap >= wideGap) {
          const keep = previousOutput && isSpace(previousOutput) ? 0 : MIN_TAB_GAP_EM * fontSize;
          delta -= delta > 0 ? Math.max(0, Math.min(delta, gap - keep)) : delta;
          pendingAbsorb = false;
        }
      }
      hunkEnd = null;
      along.push(A[k] + delta);
      across.push(C[k]);
      advances.push(sourceAdvance(k));
      previousOutput = characters[operation.target];
      index += 1;
      continue;
    }
    // One hunk: consecutive removed and inserted characters between kept ones.
    const removed = [];
    const inserted = [];
    while (index < operations.length && operations[index].kind !== 'keep') {
      if (operations[index].kind === 'remove') removed.push(operations[index].source);
      else inserted.push(operations[index].target);
      index += 1;
    }
    const nextKept = operations[index]?.source;
    const lastAlong = along.length ? along[along.length - 1] + advances[advances.length - 1] : 0;
    const start = removed.length
      ? A[removed[0]] + delta
      : Number.isInteger(nextKept) ? A[nextKept] + delta
        : count > 0 && along.length ? lastAlong : 0;
    const hunkAcross = removed.length ? C[removed[0]]
      : Number.isInteger(nextKept) ? C[nextKept] : count > 0 ? C[count - 1] : 0;
    let x = start;
    for (const target of inserted) {
      const advance = advanceOf(characters[target]);
      along.push(x);
      across.push(hunkAcross);
      advances.push(advance);
      x += advance;
      previousOutput = characters[target];
    }
    const last = removed[removed.length - 1];
    // Original coordinate where the edited text ended: the next kept glyph
    // keeps its distance to it (its gap or kern), shifted by the new width.
    const removedEnd = removed.length ? A[last] + sourceAdvance(last) : start - delta;
    delta = x - removedEnd;
    hunkEnd = removedEnd;
    pendingAbsorb = true;
  }
  return { text: characters.join(''), along, across, advances };
}

/**
 * Edit script from `source` to `target` characters: keep, remove and insert
 * operations in reading order, from a longest common subsequence. Several
 * edited places in one line each keep the characters around them. Very long
 * lines fall back to one hunk between the common prefix and suffix.
 *
 * @param {string[]} source
 * @param {string[]} target
 * @returns {{ kind: 'keep' | 'remove' | 'insert', source?: number, target?: number }[]}
 */
export function alignRunEdit(source, target) {
  let prefix = 0;
  while (prefix < source.length && prefix < target.length && source[prefix] === target[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < source.length - prefix && suffix < target.length - prefix &&
    source[source.length - 1 - suffix] === target[target.length - 1 - suffix]) suffix += 1;
  const n = source.length - prefix - suffix;
  const m = target.length - prefix - suffix;
  const operations = [];
  for (let index = 0; index < prefix; index += 1) operations.push({ kind: 'keep', source: index, target: index });
  if (n > 0 && m > 0 && n * m <= 250_000) {
    // LCS lengths of the middle suffixes.
    const width = m + 1;
    const table = new Uint16Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        table[i * width + j] = source[prefix + i] === target[prefix + j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && source[prefix + i] === target[prefix + j] &&
          table[i * width + j] === table[(i + 1) * width + j + 1] + 1) {
        operations.push({ kind: 'keep', source: prefix + i, target: prefix + j });
        i += 1;
        j += 1;
      } else if (i < n && (j >= m || table[(i + 1) * width + j] >= table[i * width + j + 1])) {
        operations.push({ kind: 'remove', source: prefix + i });
        i += 1;
      } else {
        operations.push({ kind: 'insert', target: prefix + j });
        j += 1;
      }
    }
  } else {
    for (let i = 0; i < n; i += 1) operations.push({ kind: 'remove', source: prefix + i });
    for (let j = 0; j < m; j += 1) operations.push({ kind: 'insert', target: prefix + j });
  }
  for (let index = 0; index < suffix; index += 1) {
    operations.push({ kind: 'keep', source: source.length - suffix + index, target: target.length - suffix + index });
  }
  return dissolveIncidentalMatches(operations);
}

// A retyped stretch shares a letter or a space with the old text by chance; an
// isolated match like that is no anchor worth keeping (its old kern would cut
// the new text into pieces). Like diff-match-patch's semantic cleanup, an
// equality between two edits that is shorter than 3 characters, or no longer
// than both neighbouring edits, becomes part of the edit.
function dissolveIncidentalMatches(operations) {
  let current = operations;
  for (let pass = 0; pass < 8; pass += 1) {
    const blocks = [];
    for (const operation of current) {
      const kind = operation.kind === 'keep' ? 'keep' : 'edit';
      if (blocks.at(-1)?.kind !== kind) blocks.push({ kind, operations: [] });
      blocks.at(-1).operations.push(operation);
    }
    const size = block => block ? Math.max(
      block.operations.filter(operation => operation.kind === 'remove').length,
      block.operations.filter(operation => operation.kind === 'insert').length,
    ) : 0;
    let changed = false;
    for (let index = 1; index + 1 < blocks.length; index += 1) {
      const block = blocks[index];
      if (block.kind !== 'keep') continue;
      const length = block.operations.length;
      if (length >= 3 && (length > size(blocks[index - 1]) || length > size(blocks[index + 1]))) continue;
      block.kind = 'edit';
      block.operations = [
        ...block.operations.map(operation => ({ kind: 'remove', source: operation.source })),
        ...block.operations.map(operation => ({ kind: 'insert', target: operation.target })),
      ];
      changed = true;
    }
    if (!changed) return current;
    // Inside one merged edit, removals come before insertions.
    current = [];
    let pending = [];
    const flush = () => {
      current.push(...pending.filter(operation => operation.kind === 'remove'),
        ...pending.filter(operation => operation.kind === 'insert'));
      pending = [];
    };
    for (const block of blocks) {
      if (block.kind === 'keep') {
        flush();
        current.push(...block.operations);
      } else {
        pending.push(...block.operations);
      }
    }
    flush();
  }
  return current;
}

/**
 * True when the run's origins differ from a natural layout from its first glyph
 * with the given uniform spacing.
 *
 * @param {string} text
 * @param {number[]} along
 * @param {number[]} across
 * @param {(character: string, index: number) => number} advanceOf
 * @param {number} fontSize
 */
export function runDeviatesFromNatural(text, along, across, advanceOf, fontSize) {
  return segmentPositionedRun(text, along, across, advanceOf, fontSize).length > 1;
}

/**
 * Splits a laid-out run into pieces that a single PDF text object can draw:
 * within one piece every glyph starts where the previous glyph's natural
 * advance ends. A whitespace-only piece joins the piece before it (its glyphs
 * are invisible), so text extraction keeps the space.
 *
 * @param {string} text
 * @param {number[]} along
 * @param {number[]} across
 * @param {(character: string, index: number) => number} advanceOf natural advance of the written object
 * @param {number} fontSize
 * @returns {{ start: number, end: number, text: string, along: number, across: number }[]}
 */
export function segmentPositionedRun(text, along, across, advanceOf, fontSize) {
  const characters = Array.from(String(text ?? ''));
  if (!characters.length) return [];
  const tolerance = positionedRunTolerance(fontSize);
  const breaks = [0];
  // Within a piece the object advances naturally from the piece's first
  // origin, so the accumulated drift (not the step) must stay in tolerance.
  let expected = along[0] + Number(advanceOf(characters[0], 0));
  for (let index = 1; index < characters.length; index += 1) {
    if (Math.abs(along[index] - expected) > tolerance || Math.abs(across[index] - across[breaks[breaks.length - 1]]) > tolerance) {
      breaks.push(index);
      expected = along[index];
    }
    expected += Number(advanceOf(characters[index], index));
  }
  const pieces = breaks.map((start, index) => ({ start, end: breaks[index + 1] ?? characters.length }));
  const merged = [];
  for (const piece of pieces) {
    const pieceText = characters.slice(piece.start, piece.end).join('');
    const last = merged[merged.length - 1];
    if (last && !pieceText.trim()) {
      last.end = piece.end;
      continue;
    }
    merged.push({ ...piece });
  }
  return merged.map(piece => ({
    start: piece.start,
    end: piece.end,
    text: characters.slice(piece.start, piece.end).join(''),
    along: along[piece.start],
    across: across[piece.start],
  }));
}

/**
 * Where the pieces of segmentPositionedRun actually put every character: each
 * piece's first glyph at its origin, the rest at natural advances. The editor
 * paints these positions, so its preview is the written result to the point.
 *
 * @param {{ text: string, along: number[], across: number[], advances: number[] }} layout
 * @param {(character: string, index: number) => number} advanceOf natural advance of the written object
 * @param {number} fontSize
 */
export function snapPositionedRun(layout, advanceOf, fontSize) {
  const characters = Array.from(String(layout.text ?? ''));
  const along = [...layout.along];
  const across = [...layout.across];
  for (const piece of segmentPositionedRun(layout.text, layout.along, layout.across, advanceOf, fontSize)) {
    let x = piece.along;
    for (let index = piece.start; index < piece.end; index += 1) {
      along[index] = x;
      across[index] = piece.across;
      x += Number(advanceOf(characters[index], index));
    }
  }
  return { ...layout, along, across };
}

/**
 * Index of the caret slot nearest to `x` (page points along the run). Slot i
 * sits before character i; the last slot after the final character.
 *
 * @param {number[]} along
 * @param {number[]} advances
 * @param {number} x
 */
export function positionedRunCaretIndex(along, advances, x) {
  const count = along.length;
  if (!count) return 0;
  for (let index = 0; index < count; index += 1) {
    const middle = along[index] + Math.max(0, advances[index]) / 2;
    if (x < middle) return index;
  }
  return count;
}

/**
 * Along-position of caret slot `index` (see positionedRunCaretIndex).
 *
 * @param {number[]} along
 * @param {number[]} advances
 * @param {number} index
 */
export function positionedRunCaretAlong(along, advances, index) {
  if (!along.length) return 0;
  if (index <= 0) return along[0];
  if (index >= along.length) return along[along.length - 1] + advances[advances.length - 1];
  return along[index];
}
