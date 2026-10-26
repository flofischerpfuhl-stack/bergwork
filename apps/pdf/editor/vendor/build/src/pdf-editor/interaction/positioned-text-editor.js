// @ts-check
//
// Inline-editor geometry for a positioned PDF text run (TJ gaps, kerning,
// collapsed runs of spaces). The textarea keeps input, IME, undo and the
// clipboard; its own text is transparent and these glyph positions paint the
// draft exactly where a commit will put it (positioned-run-layout.js), with
// the caret and selection drawn at the same positions.

import { layoutPositionedRun, positionedRunCaretAlong, positionedRunCaretIndex, positionedRunTolerance,
  snapPositionedRun } from '../text/positioned-run-layout.js';

/**
 * @typedef {object} TextRunLayout  Worker `textRunLayout` result (PDF user space).
 * @property {string} text
 * @property {number[]} along
 * @property {number[]} across
 * @property {number[]} widths
 * @property {number} fontSize
 * @property {number} characterSpacing
 * @property {number} wordSpacing
 * @property {{ x: number, y: number }} origin
 * @property {{ x: number, y: number }} axis
 * @property {boolean} fitsOneObject
 * @property {Record<string, number>} sampleWidths
 */

// A plain textarea reproduces a run only when the preview face advances like
// the PDF font: per glyph within this share of an em, and over the whole line.
const TEXTAREA_GLYPH_TOLERANCE_EM = 0.02;
const TEXTAREA_LINE_TOLERANCE_EM = 0.05;

/**
 * True when the inline editor has to paint this run itself because a plain
 * text field cannot reproduce it: TJ gaps, kerning or collapsed spaces,
 * uniform Tc/Tw, or a preview face whose advances differ from the PDF font's.
 * Only unrotated left-to-right runs qualify (the overlay's geometry).
 *
 * @param {TextRunLayout | null | undefined} layout
 * @param {((character: string) => number) | null} [measure] preview-face advance
 *   in page points at the run's font size
 */
export function runNeedsPositionedEditor(layout, measure = null) {
  if (!layout) return false;
  const characters = Array.from(String(layout.text));
  if (!Array.isArray(layout.along) || layout.along.length !== characters.length) return false;
  if (!(Number(layout.axis?.x) > 0.9999 && Math.abs(Number(layout.axis?.y)) < 0.0001)) return false;
  if (layout.fitsOneObject === false) return true;
  const fontSize = Math.abs(Number(layout.fontSize) || 0);
  const tolerance = positionedRunTolerance(fontSize);
  if (Math.abs(Number(layout.characterSpacing) || 0) > tolerance || Math.abs(Number(layout.wordSpacing) || 0) > tolerance) {
    return true;
  }
  if (typeof measure !== 'function') return false;
  let drift = 0;
  for (let index = 0; index < characters.length; index += 1) {
    const browser = Number(measure(characters[index]));
    if (!Number.isFinite(browser)) return true;
    const difference = browser - Number(layout.widths[index]);
    if (Math.abs(difference) > TEXTAREA_GLYPH_TOLERANCE_EM * fontSize) return true;
    drift += difference;
  }
  return Math.abs(drift) > TEXTAREA_LINE_TOLERANCE_EM * fontSize;
}

/**
 * Glyph boxes of `draft` in editor pixels.
 *
 * @param {TextRunLayout} layout
 * @param {string} draft
 * @param {{ zoom: number, boxX: number, boxY: number, viewBox: number[],
 *   measure?: (character: string) => number }} frame  boxX/boxY: the editor
 *   box's top-left in display points; viewBox: the page's [x0, y0, x1, y1].
 */
export function positionedEditorGlyphs(layout, draft, frame) {
  const zoom = Number(frame.zoom) || 1;
  const widthOf = character => {
    const known = layout.sampleWidths?.[character];
    if (Number.isFinite(known)) return Number(known);
    const measured = Number(frame.measure?.(character));
    return Number.isFinite(measured) ? measured : layout.fontSize * 0.5;
  };
  // The commit writes one text object per piece with the font's natural
  // advances (no Tc/Tw on new objects); paint exactly that.
  const positioned = snapPositionedRun(layoutPositionedRun(layout, draft, widthOf), widthOf, layout.fontSize);
  const viewBox = frame.viewBox;
  // Unrotated page and baseline: display x = PDF x - x0, display y = y1 - PDF y.
  const originX = Number(layout.origin.x) - Number(viewBox[0]);
  const baselineY = Number(viewBox[3]) - Number(layout.origin.y);
  const characters = Array.from(positioned.text);
  let offset = 0;
  const glyphs = characters.map((character, index) => {
    const glyph = {
      character,
      offset,
      x: (originX + positioned.along[index] - frame.boxX) * zoom,
      y: (baselineY - positioned.across[index] - frame.boxY) * zoom,
      advance: positioned.advances[index] * zoom,
    };
    offset += character.length;
    return glyph;
  });
  const toPx = along => (originX + along - frame.boxX) * zoom;
  return {
    glyphs,
    baseline: (baselineY - frame.boxY) * zoom,
    fontSize: layout.fontSize * zoom,
    /** Caret x (editor px) before the code unit offset `utf16`. */
    caretX(utf16) {
      return toPx(positionedRunCaretAlong(positioned.along, positioned.advances, codePointIndex(characters, utf16)));
    },
    /** Code unit offset of the caret slot nearest to editor x `px`. */
    offsetAt(px) {
      const along = px / zoom + frame.boxX - originX;
      return utf16Offset(characters, positionedRunCaretIndex(positioned.along, positioned.advances, along));
    },
    extent: glyphs.length ? Math.max(...glyphs.map(glyph => glyph.x + glyph.advance)) : 0,
  };
}

/**
 * @param {string[]} characters
 * @param {number} utf16
 */
function codePointIndex(characters, utf16) {
  let offset = 0;
  for (let index = 0; index < characters.length; index += 1) {
    if (offset >= utf16) return index;
    offset += characters[index].length;
  }
  return characters.length;
}

/**
 * @param {string[]} characters
 * @param {number} index
 */
function utf16Offset(characters, index) {
  let offset = 0;
  for (let cursor = 0; cursor < Math.min(index, characters.length); cursor += 1) offset += characters[cursor].length;
  return offset;
}

/**
 * The word around code unit `offset` (double-click selection), as a
 * [start, end) code unit range.
 *
 * @param {string} text
 * @param {number} offset
 */
export function wordRangeAt(text, offset) {
  const value = String(text ?? '');
  const isWord = character => /[\p{L}\p{N}_]/u.test(character);
  let start = Math.max(0, Math.min(offset, value.length));
  let end = start;
  if (start < value.length && !isWord(value[start]) && (start === 0 || !isWord(value[start - 1]))) {
    return [start, Math.min(value.length, start + 1)];
  }
  while (start > 0 && isWord(value[start - 1])) start -= 1;
  while (end < value.length && isWord(value[end])) end += 1;
  return [start, end];
}
