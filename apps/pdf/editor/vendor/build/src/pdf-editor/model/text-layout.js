// @ts-check

const validationErrors = new WeakSet();
function layoutValidationError(message, ErrorType = TypeError) {
  const error = new ErrorType(message);
  validationErrors.add(error);
  return error;
}
export function isTextLayoutValidationError(error) { return validationErrors.has(error); }

/** Every horizontal alignment a text block accepts; the editor's controls may offer only these. */
export const TEXT_BLOCK_ALIGNMENTS = Object.freeze(['left', 'center', 'right', 'justify']);
/** Every vertical alignment and overflow policy a text block accepts. */
export const TEXT_BLOCK_VERTICAL_ALIGNMENTS = Object.freeze(['top', 'middle', 'bottom']);
export const TEXT_BLOCK_OVERFLOW_POLICIES = Object.freeze(['visible', 'clip', 'shrink']);

function graphemes(text) {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)]
      .map(item => item.segment);
  }
  return Array.from(text);
}

function breakToken(token, sourceStart, maxWidth, measure) {
  const parts = [];
  let current = rangedText('', sourceStart, sourceStart);
  for (const grapheme of graphemeEntries(token, sourceStart)) {
    const candidate = current.text + grapheme.text;
    if (current.text && measure(candidate, current.start, grapheme.end) > maxWidth) {
      parts.push(current);
      current = rangedText(grapheme.text, grapheme.start, grapheme.end);
    } else {
      current = rangedText(candidate, current.start, grapheme.end);
    }
  }
  if (current.text) parts.push(current);
  return parts;
}

function wrapParagraph(paragraph, sourceStart, maxWidth, measure) {
  if (!paragraph) return [rangedText('', sourceStart, sourceStart)];
  const words = [...paragraph.matchAll(/\s+|\S+\s*/gu)].map(match =>
    rangedText(match[0], sourceStart + match.index, sourceStart + match.index + match[0].length));
  if (!words.length) words.push(rangedText(paragraph, sourceStart, sourceStart + paragraph.length));
  const lines = [];
  let line = rangedText('', sourceStart, sourceStart);
  for (const word of words) {
    const candidate = line.text + word.text;
    const measuredCandidate = candidate.trimEnd();
    if (measure(measuredCandidate, line.text ? line.start : word.start,
      (line.text ? line.start : word.start) + measuredCandidate.length) <= maxWidth) {
      line = rangedText(candidate, line.text ? line.start : word.start, word.end);
      continue;
    }
    if (line.text) lines.push(trimRangedEnd(line));
    const trimmedWord = word.text.trimEnd();
    if (measure(trimmedWord, word.start, word.start + trimmedWord.length) <= maxWidth) {
      line = word;
      continue;
    }
    const pieces = breakToken(trimmedWord, word.start, maxWidth, measure);
    lines.push(...pieces.slice(0, -1));
    line = pieces.at(-1) || rangedText('', word.start, word.start);
    const trailingWhitespace = word.text.slice(trimmedWord.length);
    if (trailingWhitespace) line = rangedText(`${line.text}${trailingWhitespace}`, line.start, word.end);
  }
  lines.push(trimRangedEnd(line));
  return lines;
}

/**
 * Deterministic text-block layout in editor/PDF points.
 */
export function layoutTextBlock({
  text,
  width,
  height,
  fontSize,
  minFontSize = 4,
  lineHeight = 1.2,
  align = 'left',
  verticalAlign = 'top',
  overflow = 'visible',
  maxLines = Infinity,
  measureText = (value, size) => graphemes(value).length * size * 0.52,
  measureLineFontSize = null,
}) {
  // These values reach PDFium's float32 geometry APIs. Infinity, underflow
  // and overflow must be rejected before native page/glyph creation.
  const nativePositive = value => Number.isFinite(value) && value > 0 &&
    Number.isFinite(Math.fround(value)) && Math.fround(value) > 0;
  if (!nativePositive(width) || !nativePositive(height)) {
    throw layoutValidationError('Text block dimensions must be finite positive PDF coordinates.');
  }
  if (!nativePositive(fontSize) || !nativePositive(minFontSize) || (overflow === 'shrink' && minFontSize > fontSize)) {
    throw layoutValidationError('Text block font sizes are invalid.');
  }
  if (!nativePositive(lineHeight)) throw layoutValidationError('Text block line height must be finite and positive.');
  if (maxLines !== Infinity && (!Number.isSafeInteger(maxLines) || maxLines < 1)) {
    throw layoutValidationError('Text block line limit must be a positive integer.');
  }
  if (!TEXT_BLOCK_ALIGNMENTS.includes(align)) throw layoutValidationError('Invalid horizontal alignment.');
  if (!TEXT_BLOCK_VERTICAL_ALIGNMENTS.includes(verticalAlign)) throw layoutValidationError('Invalid vertical alignment.');
  if (!TEXT_BLOCK_OVERFLOW_POLICIES.includes(overflow)) throw layoutValidationError('Invalid overflow policy.');

  const canonicalText = String(text ?? '').replace(/\r\n?/g, '\n');
  const sourceParagraphs = [];
  let paragraphStart = 0;
  for (let index = 0; index <= canonicalText.length; index += 1) {
    if (index === canonicalText.length || canonicalText[index] === '\n') {
      sourceParagraphs.push(rangedText(canonicalText.slice(paragraphStart, index), paragraphStart, index));
      paragraphStart = index + 1;
    }
  }
  const measureAtSize = size => {
    // Repeated token prefixes and final lines request identical metrics. Each
    // native shaping call is expensive; reuse its exact validated result, not
    // additive glyph guesses or binary search over non-monotonic contextual
    // widths. Bound retained strings so distinct long input cannot grow a
    // quadratic cache. Each font-size trial owns its own metrics.
    const metrics = new Map();
    const rangeAwareMetrics = measureText.length >= 3;
    const measure = (value, sourceStart = 0, sourceEnd = sourceStart + value.length) => {
      const key = rangeAwareMetrics ? `${sourceStart}:${sourceEnd}:${value}` : value;
      if (metrics.has(key)) {
        const cached = metrics.get(key);
        metrics.delete(key);
        metrics.set(key, cached);
        return cached;
      }
      const result = measureText(value, size, sourceStart, sourceEnd);
      if (!Number.isFinite(result) || result < 0) throw layoutValidationError('Text font metrics must be finite and nonnegative.', RangeError);
      metrics.set(key, result);
      if (metrics.size > 64) metrics.delete(metrics.keys().next().value);
      return result;
    };
    const lines = sourceParagraphs.flatMap(paragraph => {
      const wrapped = wrapParagraph(paragraph.text, paragraph.start, width, measure);
      return wrapped.map((line, index) => ({ ...line, endsParagraph: index === wrapped.length - 1 }));
    });
    // Validate every final line, even when height overflow already determines
    // the fit result. Positioning must reuse these validated metric values.
    const widths = lines.map(line => measure(line.text, line.start, line.end));
    const lineFontSizes = lines.map(line => {
      const result = measureLineFontSize ? measureLineFontSize(line.text, size, line.start, line.end) : size;
      if (!nativePositive(result)) throw layoutValidationError('Text line font metrics must be finite and positive.', RangeError);
      return result;
    });
    const lineAdvances = lineFontSizes.map(value => value * lineHeight);
    let occupied = 0;
    let capacity = 0;
    for (const advance of lineAdvances) {
      if (capacity >= maxLines || occupied + advance > height) break;
      occupied += advance;
      capacity += 1;
    }
    capacity = Math.max(1, capacity);
    const blockHeight = lineAdvances.reduce((sum, value) => sum + value, 0);
    return { lines, widths, lineFontSizes, lineAdvances, blockHeight, capacity, fontSize: size,
      overflowed: lines.length > capacity || blockHeight > height || widths.some(lineWidth => lineWidth > width) };
  };
  let measured = measureAtSize(fontSize);
  if (measured.overflowed && overflow === 'shrink' && fontSize > minFontSize) {
    // Explicit AutoFit retains the existing half-point decrement contract, but
    // finds its first fitting step in logarithmic work. A pasted large size
    // must not trigger billions of iterations (or an Infinity/nonprogress loop).
    const roundedStart = Math.round(fontSize * 100) / 100;
    let high = Math.max(1, Math.ceil((roundedStart - minFontSize) * 2));
    if (!Number.isSafeInteger(high)) throw layoutValidationError('Text AutoFit size exceeds safe numeric precision.', RangeError);
    const sizeAtStep = step => Math.max(minFontSize, Math.round((roundedStart - step * 0.5) * 100) / 100);
    let low = 1;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      const candidate = measureAtSize(sizeAtStep(middle));
      if (candidate.overflowed) low = middle + 1;
      else high = middle;
    }
    measured = measureAtSize(sizeAtStep(low));
  }
  const { lines, overflowed, fontSize: usedFontSize } = measured;
  const visibleLineCount = Math.min(lines.length, measured.capacity);

  const blockHeight = measured.blockHeight;
  if (!nativePositive(blockHeight)) {
    throw layoutValidationError('Text line geometry exceeds finite PDF coordinates.', RangeError);
  }
  const top = verticalAlign === 'middle'
    ? Math.max(0, (height - blockHeight) / 2)
    : verticalAlign === 'bottom'
      ? Math.max(0, height - blockHeight)
      : 0;
  let lineTop = top;
  const positioned = lines.map((line, index) => {
    const measuredWidth = measured.widths[index];
    if (measuredWidth !== 0 && !nativePositive(measuredWidth)) {
      throw layoutValidationError('Text glyph width exceeds finite PDF coordinates.', RangeError);
    }
    const lineWidth = Math.min(width, measuredWidth);
    // Justified: every line but a paragraph's last fills the frame through its word spaces. A line without a space,
    // or wider than the frame, keeps its natural width at the left edge.
    const spaces = align === 'justify' && !line.endsParagraph ? line.text.split(' ').length - 1 : 0;
    const wordSpacing = spaces > 0 && measuredWidth < width ? (width - measuredWidth) / spaces : 0;
    const x = align === 'center'
      ? (width - lineWidth) / 2
      : align === 'right'
        ? width - lineWidth
        : 0;
    const baselineY = lineTop + measured.lineFontSizes[index];
    lineTop += measured.lineAdvances[index];
    if (!Number.isFinite(Math.fround(x)) || !nativePositive(baselineY)) {
      throw layoutValidationError('Text position exceeds finite PDF coordinates.', RangeError);
    }
    return Object.freeze({
      text: line.text,
      sourceStart: line.start,
      sourceEnd: line.end,
      x,
      baselineY,
      width: wordSpacing > 0 ? width : lineWidth,
      ...(wordSpacing > 0 ? { wordSpacing } : {}),
    });
  });
  return Object.freeze({
    lines: Object.freeze(positioned),
    visibleLines: Object.freeze(positioned.slice(0, visibleLineCount)),
    fontSize: usedFontSize,
    lineHeight,
    blockHeight,
    overflowed,
    visibleLineCount,
  });
}

function graphemeEntries(text, sourceStart) {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    const entries = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)];
    return entries.map((item, index) => ({ text: item.segment, start: sourceStart + item.index,
      end: sourceStart + (entries[index + 1]?.index ?? text.length) }));
  }
  let offset = 0;
  return Array.from(text, character => {
    const entry = { text: character, start: sourceStart + offset, end: sourceStart + offset + character.length };
    offset += character.length;
    return entry;
  });
}

const rangedText = (text, start, end) => ({ text, start, end });
function trimRangedEnd(value) {
  const text = value.text.trimEnd();
  return rangedText(text, value.start, value.start + text.length);
}
