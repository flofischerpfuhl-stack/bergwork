const MAX_TEXT_UNITS = 1_000_000;
const MAX_RUNS = 100_000;
const MAX_RESOURCES = 256;
const BASE14_FACES = Object.freeze({
  'base14:Courier': ['Courier', '400', 'normal'], 'base14:Courier-Bold': ['Courier', '700', 'normal'],
  'base14:Courier-Oblique': ['Courier', '400', 'oblique'], 'base14:Courier-BoldOblique': ['Courier', '700', 'oblique'],
  'base14:Helvetica': ['Helvetica', '400', 'normal'], 'base14:Helvetica-Bold': ['Helvetica', '700', 'normal'],
  'base14:Helvetica-Oblique': ['Helvetica', '400', 'oblique'], 'base14:Helvetica-BoldOblique': ['Helvetica', '700', 'oblique'],
  'base14:Times-Roman': ['Times', '400', 'normal'], 'base14:Times-Bold': ['Times', '700', 'normal'],
  'base14:Times-Italic': ['Times', '400', 'italic'], 'base14:Times-BoldItalic': ['Times', '700', 'italic'],
  'base14:Symbol': ['Symbol', '400', 'normal'], 'base14:ZapfDingbats': ['ZapfDingbats', '400', 'normal'],
});

const freeze = value => Object.freeze(value);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const textValue = value => String(value ?? '').replace(/\r\n?/gu, '\n');
const finite = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;
const nativePositive = value => Number.isFinite(value) && value > 0 &&
  Number.isFinite(Math.fround(value)) && Math.fround(value) > 0;

function graphemeBoundaries(text) {
  const boundaries = new Set([0, text.length]);
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  for (const entry of segmenter.segment(text)) boundaries.add(entry.index);
  return boundaries;
}

function assertWellFormed(text) {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError('Rich text cannot contain an unpaired surrogate.');
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) throw new TypeError('Rich text cannot contain an unpaired surrogate.');
  }
}

function selectionOf(doc, selection) {
  const start = selection?.start;
  const end = selection?.end;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > doc.text.length) {
    throw new RangeError('Rich-text selection is outside the document.');
  }
  const boundaries = graphemeBoundaries(doc.text);
  if (!boundaries.has(start) || !boundaries.has(end)) throw new RangeError('Rich-text selection must use grapheme boundaries.');
  return { start, end };
}

function resourcesOf(value) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_RESOURCES) throw new TypeError('Font resources are required.');
  const ids = new Set();
  return freeze(value.map(resource => {
    const resourceId = String(resource?.resourceId || '');
    const kind = String(resource?.kind || '');
    const family = String(resource?.family || '');
    const weight = String(resource?.weight || '400');
    const style = String(resource?.style || 'normal');
    const canonicalBase14 = BASE14_FACES[resourceId];
    const validIdentity = kind === 'base14' ? canonicalBase14?.[0] === family && canonicalBase14?.[1] === weight && canonicalBase14?.[2] === style
      : kind === 'embedded' && /^[0-9a-f]{64}$/u.test(resourceId);
    if (!validIdentity || ids.has(resourceId) || !family || family.length > 256 ||
        !/^(?:[1-9]00)$/u.test(weight) || !['normal', 'italic', 'oblique'].includes(style)) {
      throw new TypeError('Font resource identity is invalid.');
    }
    ids.add(resourceId);
    return freeze({ resourceId, kind, family, weight, style });
  }));
}

function characterStyle(value, fallback, resources) {
  const decorationValue = value?.decoration;
  if (decorationValue != null && (
    typeof decorationValue !== 'object' || Array.isArray(decorationValue) ||
    Object.keys(decorationValue).some(key => !['underline', 'strike'].includes(key)) ||
    Object.values(decorationValue).some(item => typeof item !== 'boolean')
  )) throw new TypeError('Character decoration is invalid.');
  const fallbackDecoration = fallback?.decoration || {};
  const decoration = freeze({
    underline: decorationValue?.underline ?? fallbackDecoration.underline ?? false,
    strike: decorationValue?.strike ?? fallbackDecoration.strike ?? false,
  });
  const result = {
    resourceId: String(value?.resourceId ?? fallback?.resourceId ?? ''),
    family: String(value?.family ?? fallback?.family ?? ''),
    fontSize: Number(value?.fontSize ?? fallback?.fontSize),
    weight: String(value?.weight ?? fallback?.weight ?? '400'),
    style: String(value?.style ?? fallback?.style ?? 'normal'),
    color: String(value?.color ?? fallback?.color ?? '#000000ff').toLowerCase(),
    decoration,
  };
  const resource = resources.find(item => item.resourceId === result.resourceId);
  if (!resource || resource.family !== result.family || resource.weight !== result.weight || resource.style !== result.style) {
    throw new TypeError('Character style must reference an available exact font face.');
  }
  if (!nativePositive(result.fontSize) || !/^#[0-9a-f]{8}$/u.test(result.color)) {
    throw new TypeError('Character size or color is invalid.');
  }
  return freeze(result);
}

function paragraphStyle(value, fallback = {}) {
  const hasList = value != null && Object.prototype.hasOwnProperty.call(value, 'list');
  const listValue = hasList ? value.list : fallback.list ?? null;
  const list = listValue == null ? null : freeze({
    type: String(listValue.type || ''), level: Number(listValue.level),
  });
  const result = {
    alignment: String(value?.alignment ?? fallback.alignment ?? 'start'),
    lineHeight: Number(value?.lineHeight ?? fallback.lineHeight ?? 1.2),
    spaceBefore: Number(value?.spaceBefore ?? fallback.spaceBefore ?? 0),
    spaceAfter: Number(value?.spaceAfter ?? fallback.spaceAfter ?? 0),
    indentStart: Number(value?.indentStart ?? fallback.indentStart ?? 0),
    indentEnd: Number(value?.indentEnd ?? fallback.indentEnd ?? 0),
    firstLineIndent: Number(value?.firstLineIndent ?? fallback.firstLineIndent ?? 0),
    list,
  };
  if (!['start', 'center', 'end', 'justify'].includes(result.alignment) || !finite(result.lineHeight, 0.1, 20) ||
      ![result.spaceBefore, result.spaceAfter, result.indentStart, result.indentEnd].every(item => finite(item, 0, 100000)) ||
      !finite(result.firstLineIndent, -100000, 100000) ||
      (list && (!['ordered', 'unordered'].includes(list.type) || !Number.isSafeInteger(list.level) || list.level < 0 || list.level > 8))) {
    throw new TypeError('Paragraph style is invalid.');
  }
  return freeze(result);
}

function paragraphBounds(text) {
  const result = [];
  let start = 0;
  for (let index = 0; index <= text.length; index += 1) {
    if (index === text.length || text[index] === '\n') {
      result.push({ start, end: index });
      start = index + 1;
    }
  }
  return result;
}

function canonicalRuns(text, input, defaultStyle, resources) {
  if (!text.length) return freeze([]);
  if (input != null && !Array.isArray(input)) throw new TypeError('Character runs must be an array.');
  const source = input || [];
  if (source.length > MAX_RUNS) throw new RangeError('Too many character runs.');
  const boundaries = graphemeBoundaries(text);
  const resolved = [];
  let cursor = 0;
  for (const run of source) {
    if (!Number.isSafeInteger(run?.start) || !Number.isSafeInteger(run?.end) || run.start < cursor || run.end <= run.start ||
        run.end > text.length || !boundaries.has(run.start) || !boundaries.has(run.end)) throw new RangeError('Character runs are invalid.');
    if (run.start > cursor) resolved.push({ start: cursor, end: run.start, style: defaultStyle });
    resolved.push({ start: run.start, end: run.end, style: characterStyle(run.style, defaultStyle, resources) });
    cursor = run.end;
  }
  if (cursor < text.length) resolved.push({ start: cursor, end: text.length, style: defaultStyle });
  const merged = [];
  for (const run of resolved) {
    const previous = merged.at(-1);
    if (previous && previous.end === run.start && same(previous.style, run.style)) previous.end = run.end;
    else merged.push({ ...run });
  }
  return freeze(merged.map(run => freeze(run)));
}

function canonicalParagraphs(text, input, defaultStyle) {
  const bounds = paragraphBounds(text);
  if (input != null && !Array.isArray(input)) throw new TypeError('Paragraph records must be an array.');
  if (Array.isArray(input) && input.length > MAX_RUNS) throw new RangeError('Too many paragraph records.');
  if (Array.isArray(input) && input.length > bounds.length) throw new RangeError('Paragraph records exceed the document.');
  return freeze(bounds.map((bound, index) => {
    const candidate = input?.[index];
    if (candidate && (candidate.start !== bound.start || candidate.end !== bound.end)) throw new RangeError('Paragraph bounds are invalid.');
    return freeze({ ...bound, style: paragraphStyle(candidate?.style, defaultStyle) });
  }));
}

function assemble({ text, fontResources, defaultCharacterStyle, defaultParagraphStyle, runs, paragraphs }) {
  const document = {
    text,
    fontResources,
    defaultCharacterStyle,
    defaultParagraphStyle,
    runs: canonicalRuns(text, runs, defaultCharacterStyle, fontResources),
    paragraphs: canonicalParagraphs(text, paragraphs, defaultParagraphStyle),
  };
  return freeze(document);
}

/** Canonicalizes CRLF and lone CR to one LF before validating any supplied
 * run/paragraph offsets. All public selections address this canonical UTF-16
 * text, never the pre-normalized input string. */
export function createRichTextDocument(input = {}) {
  const text = textValue(input.text);
  assertWellFormed(text);
  if (text.length > MAX_TEXT_UNITS) throw new RangeError('Rich-text document is too large.');
  if (!text.length && Array.isArray(input.runs) && input.runs.length) throw new RangeError('Empty documents cannot contain character runs.');
  const fontResources = resourcesOf(input.fontResources);
  const defaultCharacterStyle = characterStyle(input.defaultCharacterStyle, null, fontResources);
  const defaultParagraphStyle = paragraphStyle(input.defaultParagraphStyle);
  return assemble({ text, fontResources, defaultCharacterStyle, defaultParagraphStyle,
    runs: input.runs, paragraphs: input.paragraphs });
}

/** Strict metadata verifiers accept the previous v1 shape only when decoration
 * is absent everywhere. Any document that mentions decoration must already be
 * fully canonical, so malformed or partially normalized claims still fail. */
export function richTextDocumentInputMatchesCanonical(input, canonical) {
  if (same(input, canonical)) return true;
  if (!input || Object.prototype.hasOwnProperty.call(input.defaultCharacterStyle || {}, 'decoration') ||
      (input.runs || []).some(run => Object.prototype.hasOwnProperty.call(run?.style || {}, 'decoration'))) return false;
  const legacy = {
    ...canonical,
    defaultCharacterStyle: { ...canonical.defaultCharacterStyle },
    runs: canonical.runs.map(run => ({ ...run, style:{ ...run.style } })),
  };
  delete legacy.defaultCharacterStyle.decoration;
  for (const run of legacy.runs) delete run.style.decoration;
  return same(input, legacy);
}

function styleAt(doc, offset) {
  if (!doc.text.length) return doc.defaultCharacterStyle;
  const probe = offset === doc.text.length ? offset - 1 : offset;
  return doc.runs.find(run => run.start <= probe && probe < run.end)?.style || doc.defaultCharacterStyle;
}

export function applyCharacterFormatting(doc, selection, patch = {}) {
  const { start, end } = selectionOf(doc, selection);
  if (start === end) return doc;
  const runs = [];
  for (const run of doc.runs) {
    if (run.end <= start || run.start >= end) { runs.push(run); continue; }
    if (run.start < start) runs.push({ start: run.start, end: start, style: run.style });
    runs.push({ start: Math.max(run.start, start), end: Math.min(run.end, end),
      style: characterStyle(patch, run.style, doc.fontResources) });
    if (run.end > end) runs.push({ start: end, end: run.end, style: run.style });
  }
  const result = assemble({ ...doc, runs });
  return same(result.runs, doc.runs) ? doc : result;
}

export function characterColorWithRgb(color, rgb) {
  const source = String(color || '').toLowerCase();
  const replacement = String(rgb || '').toLowerCase();
  if (!/^#[0-9a-f]{8}$/u.test(source) || !/^#[0-9a-f]{6}$/u.test(replacement)) {
    throw new TypeError('RGB formatting requires canonical RGB and RGBA colors.');
  }
  return `${replacement}${source.slice(7, 9)}`;
}

/** Replaces only RGB on each selected character run. Alpha is an independent
 * character attribute and is therefore taken from each intersected run rather
 * than from the caret or the first selected run. */
export function applyCharacterRgbFormatting(doc, selection, rgb) {
  const { start, end } = selectionOf(doc, selection);
  // Validate RGB even for a collapsed selection; callers can then use the same
  // contract for ephemeral typing style without accepting malformed colors.
  characterColorWithRgb(doc.defaultCharacterStyle.color, rgb);
  if (start === end) return doc;
  let result = doc;
  for (const run of doc.runs) {
    const overlapStart = Math.max(start, run.start);
    const overlapEnd = Math.min(end, run.end);
    if (overlapStart >= overlapEnd) continue;
    result = applyCharacterFormatting(result, { start: overlapStart, end: overlapEnd }, {
      color: characterColorWithRgb(run.style.color, rgb),
    });
  }
  return result;
}

/** Returns validated ephemeral caret attributes. It never mutates or embeds UI
 * typing state in the undoable rich-text document snapshot. */
export function resolveTypingStyle(doc, selection, patch = {}) {
  const { start, end } = selectionOf(doc, selection);
  const basis = start === end ? styleAt(doc, start) : styleAt(doc, Math.max(start, end - 1));
  return characterStyle(patch, basis, doc.fontResources);
}

/** `selection` addresses the existing canonical document. Only after that
 * range is validated is replacement CRLF/CR normalized to LF. */
export function replaceRichText(doc, selection, replacement, typingStyle = null) {
  const { start, end } = selectionOf(doc, selection);
  const inserted = textValue(replacement);
  assertWellFormed(inserted);
  const explicitTypingStyle = typingStyle != null
    ? resolveTypingStyle(doc, { start, end }, typingStyle)
    : null;
  if (inserted === doc.text.slice(start, end)) {
    return explicitTypingStyle && start !== end
      ? applyCharacterFormatting(doc, { start, end }, explicitTypingStyle)
      : doc;
  }
  const text = doc.text.slice(0, start) + inserted + doc.text.slice(end);
  assertWellFormed(text);
  if (text.length > MAX_TEXT_UNITS) throw new RangeError('Rich-text document is too large.');
  if (start === end && !inserted) return doc;
  const insertionStyle = explicitTypingStyle || resolveTypingStyle(doc, { start, end });
  const delta = inserted.length - (end - start);
  const intervals = [];
  for (const run of doc.runs) {
    if (run.start < start) intervals.push({ start: run.start, end: Math.min(run.end, start), style: run.style });
    if (run.end > end) intervals.push({ start: Math.max(run.start, end) + delta, end: run.end + delta, style: run.style });
  }
  if (inserted) intervals.push({ start, end: start + inserted.length, style: insertionStyle });
  intervals.sort((left, right) => left.start - right.start);
  const segments = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)];
  const runs = [];
  let intervalIndex = 0;
  for (let index = 0; index < segments.length; index += 1) {
    const segmentStart = segments[index].index;
    const segmentEnd = segments[index + 1]?.index ?? text.length;
    while (intervalIndex + 1 < intervals.length && intervals[intervalIndex].end <= segmentStart) intervalIndex += 1;
    const style = intervals[intervalIndex]?.style || insertionStyle;
    const previous = runs.at(-1);
    if (previous && same(previous.style, style)) previous.end = segmentEnd;
    else runs.push({ start: segmentStart, end: segmentEnd, style });
  }
  const oldParagraph = doc.paragraphs.find(item => item.start <= start && start <= item.end) || doc.paragraphs.at(-1);
  let paragraphIndex = 0;
  const paragraphs = paragraphBounds(text).map(bound => {
    const oldOffset = bound.start < start ? bound.start : bound.start >= start + inserted.length ? bound.start - delta : start;
    while (paragraphIndex + 1 < doc.paragraphs.length && doc.paragraphs[paragraphIndex].end < oldOffset) paragraphIndex += 1;
    const candidate = doc.paragraphs[paragraphIndex];
    const source = candidate?.start <= oldOffset && oldOffset <= candidate.end ? candidate : oldParagraph;
    return { ...bound, style: source.style };
  });
  return assemble({ ...doc, text, runs, paragraphs });
}

/** Reconcile a plain textarea edit without flattening unchanged character runs.
 * Rich editors should continue to pass their explicit edit range. Legacy
 * textareas expose only the resulting string, so preserve the maximal shared
 * prefix/suffix on boundaries valid in BOTH grapheme sequences. */
export function replaceRichTextPlainProjection(doc, value, explicitEdit = null) {
  const canonical = createRichTextDocument(doc);
  const text = textValue(value);
  assertWellFormed(text);
  if (text.length > MAX_TEXT_UNITS) throw new RangeError('Rich-text document is too large.');
  if (explicitEdit != null) {
    const result = replaceRichText(canonical, explicitEdit, explicitEdit.replacement);
    if (result.text !== text) throw new TypeError('Explicit edit does not match its plain-text projection.');
    return result;
  }
  if (canonical.text === text) return doc;
  const before = canonical.text;
  const beforeBoundaries = graphemeBoundaries(before);
  const afterBoundaries = graphemeBoundaries(text);
  let start = 0;
  while (start < before.length && start < text.length && before[start] === text[start]) start += 1;
  while (!beforeBoundaries.has(start) || !afterBoundaries.has(start)) start -= 1;
  let suffix = 0;
  while (before.length - suffix > start && text.length - suffix > start &&
      before[before.length - suffix - 1] === text[text.length - suffix - 1]) suffix += 1;
  while (!beforeBoundaries.has(before.length - suffix) || !afterBoundaries.has(text.length - suffix)) suffix -= 1;
  return replaceRichText(canonical, { start, end: before.length - suffix }, text.slice(start, text.length - suffix));
}

export function applyParagraphFormatting(doc, selection, patch = {}) {
  const { start, end } = selectionOf(doc, selection);
  const paragraphs = doc.paragraphs.map(paragraph => {
    const selected = start === end
      ? paragraph.start <= start && start <= paragraph.end
      : paragraph.start < end && paragraph.end >= start;
    return selected ? { ...paragraph, style: paragraphStyle(patch, paragraph.style) } : paragraph;
  });
  const result = assemble({ ...doc, paragraphs });
  return same(result.paragraphs, doc.paragraphs) ? doc : result;
}
