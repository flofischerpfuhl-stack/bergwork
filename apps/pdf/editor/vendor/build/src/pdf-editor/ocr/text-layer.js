// Placement of the invisible OCR text layer. Words are emitted in Tesseract's
// reading order (block, paragraph, line) and every word of a line sits on the
// line's baseline with one common text height. Placing each word by its own
// bounding box put "g"/"p" words lower and "im" smaller than their
// neighbours, so text extractors split lines and interleaved columns.

const finite = (...values) => values.every(Number.isFinite);
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const MIN_SYMBOL_CONFIDENCE = 60;

function validBox(bbox) {
  return bbox && finite(bbox.x0, bbox.y0, bbox.x1, bbox.y1) && bbox.x1 > bbox.x0 && bbox.y1 > bbox.y0;
}

// Lines in reading order; `group` is the Tesseract paragraph a line belongs to
// (null when the output carries no paragraph structure).
function recognizedLines(data) {
  if (Array.isArray(data?.blocks) && data.blocks.length) {
    return data.blocks.flatMap(block => (block?.paragraphs || []).flatMap(paragraph => (
      (paragraph?.lines || []).map(line => ({ line, group: paragraph }))
    )));
  }
  // Flattened output: consecutive words that share a line object.
  const lines = [];
  for (const word of data?.words || []) {
    const last = lines[lines.length - 1];
    if (last && word?.line && last.line.source === word.line) last.line.words.push(word);
    else {
      lines.push({
        line: { source: word?.line || null, baseline: word?.line?.baseline || word?.baseline, words: [word] },
        group: word?.paragraph || null,
      });
    }
  }
  return lines;
}

// Lines of one paragraph whose own ascent is within this ratio of the
// paragraph's median share that median as their text height.
const PARAGRAPH_ASCENT_TOLERANCE = 0.25;

const median = values => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
};

/**
 * @param {object} data Tesseract.js recognize() data (blocks and/or words)
 * @returns {Array<{ text: string, origin: [number, number], baseline: [number, number], ascent: [number, number] }>}
 *   image-space points: left end and right end of the word on the baseline,
 *   and the point one line ascent above the left end.
 */
export function ocrTextLayerWords(data) {
  const placed = [];
  for (const { line, group } of recognizedLines(data)) {
    const recognized = (line?.words || [])
      .map(word => ({ text: String(word?.text || '').trim(), bbox: word?.bbox, confidence: Number(word?.confidence) }))
      .filter(word => word.text && validBox(word.bbox));
    if (!recognized.length) continue;
    const top = Math.min(...recognized.map(word => word.bbox.y0));
    const bottom = Math.max(...recognized.map(word => word.bbox.y1));
    const height = bottom - top;
    const base = line.baseline;
    const usable = base && base.has_baseline !== false && finite(base.x0, base.y0, base.x1, base.y1) &&
      base.x1 > base.x0 && Math.abs(base.y1 - base.y0) <= (base.x1 - base.x0) &&
      // A baseline far outside the recognised glyphs is not trusted.
      Math.min(base.y0, base.y1) > top && Math.max(base.y0, base.y1) < bottom + height;
    const baselineAt = x => (usable
      ? base.y0 + (base.y1 - base.y0) * (x - base.x0) / (base.x1 - base.x0)
      : null);
    // The median word top above the baseline is the line's ascender/cap
    // height; accents, quotes and brackets on single words do not inflate it.
    const lettered = recognized.filter(word => LETTER_OR_DIGIT.test(word.text));
    const ascent = median((lettered.length ? lettered : recognized)
      .map(word => (baselineAt(word.bbox.x0) ?? word.bbox.y1) - word.bbox.y0)
      .filter(value => value > 0));
    if (!(ascent > 0)) continue;
    placed.push({ group, recognized, baselineAt, ascent });
  }
  // One paragraph is set in one size. A line's median word top still depends
  // on its word mix (capitals and ascenders or mostly x-height words), and
  // lines of the same paragraph written a few percent apart in size made text
  // extractors split the paragraph into separate blocks and interleave the
  // columns of a page.
  const paragraphAscents = new Map();
  for (const item of placed) {
    if (!item.group) continue;
    if (!paragraphAscents.has(item.group)) paragraphAscents.set(item.group, []);
    paragraphAscents.get(item.group).push(item.ascent);
  }
  const out = [];
  for (const { group, recognized, baselineAt, ascent: lineAscent } of placed) {
    const paragraphAscent = group ? median(paragraphAscents.get(group)) : 0;
    const ascent = paragraphAscent > 0 &&
      Math.abs(lineAscent - paragraphAscent) <= paragraphAscent * PARAGRAPH_ASCENT_TOLERANCE
      ? paragraphAscent
      : lineAscent;
    // Marks without a letter or digit that are unsure or speck-sized are dust
    // and rules, not text: a "_" speck in the gutter made text extractors
    // join the two columns of a page.
    const words = recognized.filter(word => LETTER_OR_DIGIT.test(word.text) || (
      !(word.confidence < MIN_SYMBOL_CONFIDENCE) &&
      Math.max(word.bbox.x1 - word.bbox.x0, word.bbox.y1 - word.bbox.y0) >= ascent * 0.5));
    for (const word of words) {
      // Each word is written level, on the line baseline under its centre,
      // so a slightly skewed scan still gives horizontal text lines.
      const y = baselineAt((word.bbox.x0 + word.bbox.x1) / 2) ?? word.bbox.y1;
      out.push({
        text: word.text,
        origin: [word.bbox.x0, y],
        baseline: [word.bbox.x1, y],
        ascent: [word.bbox.x0, y - ascent],
      });
    }
  }
  return out;
}
