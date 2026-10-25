// @ts-check
// berg:work-only module (not in Fernwork): "Edit as paragraph". A paragraph in a source PDF is usually one text
// object per line. This plans turning the detected paragraph (a semantic text block, see text/block-detection.js)
// into one reflowing text frame: the first line becomes the frame with the whole paragraph's text, the other lines
// are deleted, in one transaction. The plan is pure data; pdf-tools-shell.jsx (editTextAsParagraph) commits it.

// TeX engines set word gaps by position and embed fonts without a space glyph. The pinned worker lays a frame's spaces
// out with the space glyph's width, so such a paragraph would lose every word gap: it stays as lines.
const TEX_PRODUCER = /\b(?:pdf|xe|lua|luahb)?tex\b|dvipdfm|dvips|\bTeX\b|LaTeX/iu;

/** True when the document's creator or producer names a TeX engine or driver. */
export function texProducedDocument(metadata = {}) {
  return TEX_PRODUCER.test(`${metadata?.creator || ''} ${metadata?.producer || ''}`);
}

const LINE_JOIN_WORDS = new Set(['und', 'oder', 'bis', 'sowie', 'and', 'or', 'to', 'nor']);

function finite(...values) {
  for (const value of values) {
    const number = Number(value);
    if (value !== null && value !== '' && Number.isFinite(number)) return number;
  }
  return NaN;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return NaN;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Joins the lines of a paragraph into running text. A line ending in a soft hyphen, or in a hyphen between two
 * lower-case word parts, was hyphenated by the layout and is joined without the hyphen ("exam-" + "ple"); a hyphen
 * before "und"/"and"/... is a suspended compound ("Ein- und Ausgang") and stays; so does one before a capital.
 * @param {string[]} lines
 */
export function joinParagraphLines(lines) {
  let text = '';
  for (const raw of lines) {
    // Spacing inside a line stays as typed (Word's two spaces after a full stop keep the line widths).
    const line = String(raw ?? '').replace(/[\r\n]+/gu, ' ').trim();
    if (!line) continue;
    if (!text) { text = line; continue; }
    if (/­$/u.test(text)) { text = `${text.slice(0, -1)}${line}`; continue; }
    const nextWord = /^\p{Ll}[\p{L}\p{M}]*/u.exec(line)?.[0] || '';
    if (/\p{L}{2}[-‐]$/u.test(text) && nextWord && !LINE_JOIN_WORDS.has(nextWord)) {
      text = `${text.slice(0, -1)}${line}`;
      continue;
    }
    // A real hyphen before a capital ("Baden-" + "Württemberg") stays, without a space.
    text = /\p{L}[-‐]$/u.test(text) && /^\p{Lu}/u.test(line) ? `${text}${line}` : `${text} ${line}`;
  }
  return text;
}

function layerText(item) {
  return String(item.currentText ?? item.text ?? item.str ?? '');
}

function sourceRect(item) {
  return {
    x: finite(item.targetSourceX, item.sourceX, item.x),
    y: finite(item.targetSourceY, item.sourceY, item.y),
    w: finite(item.targetSourceW, item.sourceW, item.w),
    h: finite(item.targetSourceH, item.sourceH, item.h),
  };
}

function fontIdentity(item) {
  return [
    item.pdfFontName || item.sourceFontName || item.embeddedFontFamily || item.fontFamily || '',
    String(item.fontWeight || '400'),
    String(item.fontStyle || 'normal'),
  ].join('|');
}

function runIdentity(run) {
  const style = run?.style || {};
  return [style.pdfFontName || style.fontFamily || '', String(style.fontWeight || '400'), String(style.fontStyle || 'normal')]
    .join('|');
}

// A layer put together from several PDF.js items carries their character-weighted mean size: exact when they agree,
// a little off when a superscript or a smaller word is among them (11.8 for a 12 pt line with "240th").
function sameSize(size, reference) {
  return Math.abs(finite(size, 12) - finite(reference, 12)) <= finite(reference, 12) * 0.002;
}

function lineGeometry(layers) {
  const boxes = layers.map(layer => sourceRect(layer.item));
  const left = Math.min(...boxes.map(box => box.x));
  const right = Math.max(...boxes.map(box => box.x + box.w));
  return { left, center: (left + right) / 2, baseline: finite(layers[0].item.targetSourceBaselineY, layers[0].item.sourceBaselineY) };
}

// The detector reads the lines of a centred paragraph as indented differently and starts a new block at a shorter
// line. A centred paragraph takes the lines directly above and below it on its axis, at its pitch and in its font.
function extendCentredParagraph(lines, lineLayers, candidates, fontSize) {
  if (lines.length < 2) return;
  const tolerance = fontSize * 0.5;
  const geometry = lineLayers.map(lineGeometry);
  const centers = geometry.map(entry => entry.center);
  const lefts = geometry.map(entry => entry.left);
  if (Math.max(...centers) - Math.min(...centers) > tolerance || Math.max(...lefts) - Math.min(...lefts) <= 1) return;
  const center = median(centers);
  const pitch = (geometry.at(-1).baseline - geometry[0].baseline) / (geometry.length - 1);
  if (!(pitch > 0)) return;
  const taken = new Set(lines);
  const next = baseline => candidates.find(entry => !taken.has(entry.line) && (() => {
    const candidate = lineGeometry(entry.layers);
    return Math.abs(candidate.baseline - baseline) <= pitch * 0.1 && Math.abs(candidate.center - center) <= tolerance;
  })());
  for (let below = next(geometry.at(-1).baseline + pitch), baseline = geometry.at(-1).baseline + pitch; below;
    baseline += pitch, below = next(baseline)) {
    lines.push(below.line); lineLayers.push(below.layers); taken.add(below.line);
  }
  for (let above = next(geometry[0].baseline - pitch), baseline = geometry[0].baseline - pitch; above;
    baseline -= pitch, above = next(baseline)) {
    lines.unshift(above.line); lineLayers.unshift(above.layers); taken.add(above.line);
  }
}

/**
 * Plans "Edit as paragraph" for the text layer `sourceId` on page `pageId`. The paragraph is the run of lines of the
 * detected text block around the selected line that share its font: the detector does not split two paragraphs set
 * without space between them, and only text in one style can become one frame.
 * @param {{ pageId: string, sourceId: string, blocks: any[], layers: any[], nativeText?: (item: any) => string }} input
 *   blocks: the page's detected text blocks (scene `textBlocks`, item ids without the page prefix);
 *   layers: the page's text layers (`makeOriginalPdfObjectLayers(...).filter(type === 'text')`);
 *   texDocument: the document comes from TeX (texProducedDocument);
 *   nativeText: the PDF text object's own string for a layer item, if known. PDF.js collapses repeated spaces (Word's
 *   two after a full stop); the native string keeps them, so the joined lines keep their widths.
 * @returns {{ ok: true, first: any, others: any[], text: string, block: any, lineCount: number } |
 *   { ok: false, reason: string, message: string, lines?: any[] }}
 */
export function planParagraphMerge({ pageId, sourceId, blocks, layers, nativeText = null, texDocument = false }) {
  const refuse = (reason, message) => ({ ok: false, reason, message });
  const prefix = `${pageId}:txt:`;
  const itemId = String(sourceId || '').startsWith(prefix) ? String(sourceId).slice(prefix.length) : '';
  const block = itemId ? (blocks || []).find(candidate => candidate?.itemIds?.includes(itemId)) : null;
  const blockLines = Array.isArray(block?.lines) ? block.lines : [];
  if (blockLines.length < 2) return refuse('single-line', 'This text is a single line, not part of a paragraph.');
  if (block.writingMode && block.writingMode !== 'horizontal') {
    return refuse('vertical', 'Vertical text cannot be edited as a paragraph yet.');
  }
  if (block.direction === 'rtl') {
    return refuse('rtl', 'Right-to-left paragraphs cannot be edited as a paragraph yet.');
  }
  const layerBySource = new Map((layers || []).map(layer => [String(layer.item?.sourceId || layer.sourceId || ''), layer]));
  const blockLineLayers = blockLines.map(line => line.itemIds
    .map(id => layerBySource.get(`${prefix}${id}`))
    .filter(Boolean)
    .sort((left, right) => sourceRect(left.item).x - sourceRect(right.item).x));
  const selectedLine = blockLines.findIndex(line => line.itemIds.includes(itemId));
  const selected = layerBySource.get(String(sourceId)) || blockLineLayers[selectedLine]?.[0];
  if (!selected) return refuse('unbound', 'This line is not a separate text object, so it cannot be joined.');
  // The paragraph's font is the selected line's; a line set wholly in another font starts another paragraph (Word sets
  // consecutive paragraphs without space between them, so the detector keeps them in one block).
  const reference = (blockLines[selectedLine].runs || []).find(run => run.itemIds?.includes(itemId)) ||
    blockLines[selectedLine].runs?.[0];
  const referenceFont = reference ? runIdentity(reference) : '';
  const referenceSize = finite(reference?.style?.fontSize, selected.item.fontSize, 12);
  const lineInParagraph = index => blockLineLayers[index]?.length > 0 &&
    (!referenceFont || (blockLines[index].runs || []).some(run => runIdentity(run) === referenceFont));
  let from = selectedLine;
  let to = selectedLine;
  while (from > 0 && lineInParagraph(from - 1)) from -= 1;
  while (to < blockLines.length - 1 && lineInParagraph(to + 1)) to += 1;
  // Space between paragraphs (Word's "space after") can be too small for the detector to split at; a gap clearly
  // wider than the usual line pitch ends the paragraph.
  if (to - from >= 2) {
    const baselineAt = index => lineGeometry(blockLineLayers[index]).baseline;
    const gaps = [];
    for (let index = from; index < to; index += 1) gaps.push(baselineAt(index + 1) - baselineAt(index));
    const usual = median(gaps);
    const first = from;
    const breakAfter = index => gaps[index - first] > usual * 1.15;
    if (usual > 0) {
      while (from < selectedLine && [...Array(selectedLine - from).keys()].some(offset => breakAfter(from + offset))) from += 1;
      while (to > selectedLine && [...Array(to - selectedLine).keys()].some(offset => breakAfter(selectedLine + offset))) to -= 1;
    }
  }
  if (from === to) return refuse('single-line', 'This text is a single line, not part of a paragraph.');
  if (texDocument) {
    return refuse('tex-spacing', 'This PDF was typeset with TeX, whose fonts have no space character. Editing its paragraphs as one text box would lose the word spacing, so they stay as lines.');
  }
  const lines = blockLines.slice(from, to + 1);
  const lineLayers = blockLineLayers.slice(from, to + 1);
  const lineInStyle = line => (line.runs || []).length > 0 && line.runs.every(run =>
    (!referenceFont || runIdentity(run) === referenceFont) && sameSize(run.style?.fontSize, referenceSize));
  extendCentredParagraph(lines, lineLayers, (blocks || []).filter(candidate => candidate !== block &&
    (!candidate.writingMode || candidate.writingMode === 'horizontal')).flatMap(candidate => candidate.lines || [])
    .filter(lineInStyle)
    .map(line => ({ line, layers: line.itemIds.map(id => layerBySource.get(`${prefix}${id}`)).filter(Boolean)
      .sort((left, right) => sourceRect(left.item).x - sourceRect(right.item).x) }))
    .filter(entry => entry.layers.length), referenceSize);
  const all = lineLayers.flat();
  // One frame has one font: a bold word, a superscript or another size inside the paragraph would be lost.
  const mixed = lines.flatMap(line => (line.runs || []).filter(run =>
    (referenceFont && runIdentity(run) !== referenceFont) || !sameSize(run.style?.fontSize, referenceSize)))
    .concat(all.filter(layer => !sameSize(layer.item.fontSize, referenceSize) ||
      fontIdentity(layer.item) !== fontIdentity(selected.item)).map(layer => ({ text: layerText(layer.item) })));
  if (mixed.length) {
    return {
      ...refuse('mixed-style', 'This paragraph mixes fonts, sizes or superscripts. Joining it would lose that formatting, so it stays as lines.'),
      lines: mixed.map(run => ({ text: run.text, font: run.style ? `${runIdentity(run)}|${run.style.fontSize}` : '' })),
    };
  }
  if (new Set(all).size !== all.length) {
    return refuse('unbound', 'Some lines of this paragraph are not separate text objects, so it cannot be joined.');
  }
  if (all.some(layer => layer.deleted || layer.item.deleted)) {
    return refuse('deleted', 'A line of this paragraph was deleted. Undo that first.');
  }
  if (all.some(layer => layer.item.textFrame === true || layer.item.textBlock === true ||
      layer.item.nativeTypeName === 'form')) {
    return refuse('frame', 'Part of this paragraph is already a text box.');
  }
  // A line drawn as several PDF text objects has no one-to-one layer target; the commit binds it semantically, as
  // editing that line does. Text inside a Form XObject cannot be joined with page text.
  const unbound = all.filter(layer => layer.item.nested === true ||
    (Array.isArray(layer.item.formPath) && layer.item.formPath.length > 0));
  if (unbound.length) {
    return {
      ...refuse('unbound', 'This paragraph is not plain page text, so it cannot be joined.'),
      lines: unbound.map(layer => ({ sourceId: layer.item.sourceId, text: layerText(layer.item) })),
    };
  }
  if (all.some(layer => Math.abs(finite(layer.item.sourceAngle, 0)) > 0.01)) {
    return refuse('rotated', 'Rotated paragraphs cannot be edited as a paragraph yet.');
  }
  const lead = lineLayers[0][0];
  const fontSize = finite(lead.item.primitives?.fontSize, lead.item.fontSize, lead.item.sourceFontSize, 12);
  const baselines = lineLayers.map(entries => finite(entries[0].item.targetSourceBaselineY,
    entries[0].item.sourceBaselineY));
  if (!baselines.every(Number.isFinite) || baselines.some((value, index) => index && value <= baselines[index - 1])) {
    return refuse('geometry', 'The lines of this paragraph are not stacked one below the other.');
  }
  const pitch = (baselines.at(-1) - baselines[0]) / (baselines.length - 1);
  if (!(pitch > fontSize * 0.6) || pitch > fontSize * 3) {
    return refuse('geometry', 'The line spacing of this paragraph could not be read.');
  }
  const rects = lineLayers.map(entries => {
    const boxes = entries.map(layer => sourceRect(layer.item));
    const left = Math.min(...boxes.map(box => box.x));
    const right = Math.max(...boxes.map(box => box.x + box.w));
    return { left, right, center: (left + right) / 2 };
  });
  if (!rects.every(rect => Number.isFinite(rect.left) && Number.isFinite(rect.right) && rect.right > rect.left)) {
    return refuse('geometry', 'The geometry of this paragraph could not be read.');
  }
  const maxRight = Math.max(...rects.map(rect => rect.right));
  const tolerance = fontSize * 0.5;
  const spread = values => Math.max(...values) - Math.min(...values);
  // A first-line indent (or a hanging first line) does not decide the alignment: the other lines do.
  const bodyRects = rects.length > 2 ? rects.slice(1) : rects;
  const spreads = {
    left: spread(bodyRects.map(rect => rect.left)),
    center: spread(rects.map(rect => rect.center)),
    right: spread(rects.map(rect => rect.right)),
  };
  // A shared left edge means left-aligned or justified (a paragraph running on to the next page has no short last
  // line); otherwise the edge the lines share most closely.
  const best = Object.entries(spreads).reduce((winner, entry) => entry[1] < winner[1] - 0.5 ? entry : winner);
  const align = spreads.left <= tolerance || best[1] > tolerance ? 'left' : best[0];
  // Justified lines carry stretched word spaces; the frame takes its first line's spacing for every line, so it gets
  // natural spacing instead (the caller sets it). The pinned worker lays frames out left, centred or right only, so
  // justified text becomes left-aligned.
  const justified = align === 'left' && rects.length > 2 &&
    spread(rects.slice(0, -1).map(rect => rect.right)) <= Math.min(tolerance, 1.5);
  // A left-aligned frame starts where the body lines start; the first line's indent cannot be kept (the worker has no
  // first-line indent), so the frame is placed explicitly instead of on the first line's origin.
  const left = align === 'left' && rects.length > 1 ? Math.min(...rects.slice(1).map(rect => rect.left)) : rects[0].left;
  const firstLineIndent = rects[0].left - left;
  const minLeft = Math.min(left, ...rects.map(rect => rect.left));
  // A little room beyond the longest line, so measuring the same words again cannot push the last word of a line
  // onto the next; far less than a word, so no word moves up either.
  const slack = Math.max(0.5, fontSize * 0.15);
  const width = maxRight - (align === 'left' ? left : minLeft) + slack;
  const lineHeight = pitch / fontSize;
  const height = pitch * lines.length;
  const first = lead;

  const anyEdited = all.some(layer => layer.item.originalText != null &&
    layerText(layer.item) !== String(layer.item.originalText));
  const compact = value => String(value ?? '').replace(/\s+/gu, '');
  const unchangedText = item => {
    const text = layerText(item);
    const native = nativeText?.(item);
    return typeof native === 'string' && native.trim() && compact(native) === compact(text) ? native : text;
  };
  const lineTexts = lineLayers.map((entries, index) => anyEdited
    ? entries.map(layer => layerText(layer.item)).join(' ')
    : entries.length === 1
      ? unchangedText(entries[0].item)
      : String(lines[index].text ?? entries.map(layer => unchangedText(layer.item)).join(' ')));
  const text = joinParagraphLines(lineTexts);
  if (!text) return refuse('empty', 'This paragraph has no text.');

  return {
    ok: true,
    first,
    others: all.filter(layer => layer !== first),
    text,
    lineCount: lines.length,
    block: {
      id: block.id,
      align,
      justified,
      edges: Object.fromEntries(Object.entries(spreads).map(([edge, value]) => [edge, Math.round(value * 100) / 100])),
      width,
      height,
      lineHeight,
      fontSize,
      left: align === 'left' ? left : minLeft,
      // Set when the frame cannot sit on the first line's origin (an indented first line): its top-left corner, the
      // first baseline one font size below.
      ...(Math.abs(firstLineIndent) > 0.5 ? { placement: { x: left, y: baselines[0] - fontSize } } : {}),
      confidence: block.confidence || null,
    },
  };
}
