import {
  DEFAULT_TEXT_STYLE, defaultTextParagraphs, defaultTextParagraphStyle,
  type LegacyTextRun, type TextLayer, type TextParagraph, type TextParagraphStyle, type TextRun, type TextRunStyle,
} from '../document';

export type TextStylePatch = Partial<Omit<TextRunStyle, 'schemaVersion'>>;
export type ParagraphStylePatch = Partial<Omit<TextParagraphStyle, 'schemaVersion'>>;

function clampIndex(text: string, value: number): number {
  if (!Number.isFinite(value)) throw new RangeError('Text range indices must be finite');
  return Math.max(0, Math.min(text.length, Math.trunc(value)));
}

export function assertTextRange(text: string, from: number, to: number): void {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > text.length) {
    throw new RangeError(`Invalid UTF-16 text range [${from}, ${to}) for length ${text.length}`);
  }
}

export function validTextStyle(style: TextRunStyle): boolean {
  return style.schemaVersion === 1 && !!style.fontFamily.trim()
    && ['normal', 'italic', 'oblique'].includes(style.fontStyle)
    && Number.isFinite(style.fontWeight) && style.fontWeight >= 1 && style.fontWeight <= 1000
    && Number.isFinite(style.fontSize) && style.fontSize > 0 && style.fontSize <= 12_000
    && [style.color.red, style.color.green, style.color.blue, style.color.alpha ?? 1]
      .every((value) => Number.isFinite(value) && value >= 0 && value <= 1)
    && Number.isFinite(style.tracking) && style.tracking >= -10_000 && style.tracking <= 10_000
    && ['metric', 'optical', 'none'].includes(style.kerning)
    && (style.leading === null || (Number.isFinite(style.leading) && style.leading > 0))
    && Number.isFinite(style.baselineShift)
    && Object.entries(style.axes).every(([axis, value]) => axis.length === 4 && Number.isFinite(value));
}

function validParagraphStyle(style: TextParagraphStyle): boolean {
  return style.schemaVersion === 1 && ['left', 'center', 'right', 'justify'].includes(style.alignment)
    && ['auto', 'ltr', 'rtl'].includes(style.direction)
    && [style.firstLineIndent, style.startIndent, style.endIndent, style.spaceBefore, style.spaceAfter]
      .every(Number.isFinite);
}

export function styleAt(layer: Pick<TextLayer, 'text' | 'runs'>, index: number): TextRunStyle {
  const position = clampIndex(layer.text, index);
  const hit = layer.runs.find((run) => run.from <= position && position < run.to)
    ?? (position === layer.text.length ? layer.runs.at(-1) : undefined);
  return hit?.style ?? DEFAULT_TEXT_STYLE;
}

function sameStyle(a: TextRunStyle, b: TextRunStyle): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

export function canonicalTextRuns(text: string, values: readonly (TextRun | LegacyTextRun)[],
  fallback: TextRunStyle = DEFAULT_TEXT_STYLE): TextRun[] {
  if (!text.length) return [];
  const converted = values.map((value): TextRun => 'style' in value ? value : ({ from: value.from, to: value.to,
    style: { ...fallback, fontFamily: value.fontFamily, fontSize: value.fontSize, color: { ...value.color, alpha: 1 } } }));
  const boundaries = new Set<number>([0, text.length]);
  for (const run of converted) {
    boundaries.add(clampIndex(text, run.from)); boundaries.add(clampIndex(text, run.to));
  }
  const sorted = [...boundaries].sort((a, b) => a - b);
  const result: TextRun[] = [];
  let prior = fallback;
  for (let i = 0; i + 1 < sorted.length; i++) {
    const from = sorted[i]!, to = sorted[i + 1]!;
    if (to <= from) continue;
    const covering = [...converted].reverse().find((run) => run.from <= from && run.to >= to);
    const style = covering?.style ?? prior;
    if (!validTextStyle(style)) throw new TypeError('Invalid text run style');
    const previous = result.at(-1);
    if (previous && previous.to === from && sameStyle(previous.style, style)) result[result.length - 1] = { ...previous, to };
    else result.push({ from, to, style });
    prior = style;
  }
  return result;
}

function paragraphsWithInheritedStyles(text: string, oldText: string, old: readonly TextParagraph[], editFrom: number,
  removed: number, inserted: number): TextParagraph[] {
  const base = defaultTextParagraphs(text);
  const oldAt = (newIndex: number): TextParagraphStyle => {
    const oldIndex = newIndex <= editFrom ? newIndex : Math.max(editFrom, newIndex - inserted + removed);
    return old.find((paragraph) => paragraph.from <= oldIndex && oldIndex < paragraph.to)?.style
      ?? old.find((paragraph) => paragraph.from === oldText.length)?.style
      ?? old.at(-1)?.style ?? defaultTextParagraphStyle();
  };
  return base.map((paragraph) => ({ ...paragraph, style: oldAt(paragraph.from) }));
}

export function replaceTextRange(layer: TextLayer, from: number, to: number, replacement: string): TextLayer {
  assertTextRange(layer.text, from, to);
  const text = layer.text.slice(0, from) + replacement + layer.text.slice(to);
  const shift = replacement.length - (to - from), insertionStyle = styleAt(layer, from);
  const runs: TextRun[] = [];
  for (const run of layer.runs) {
    if (run.from < from) runs.push({ from: run.from, to: Math.min(run.to, from), style: run.style });
    if (run.to > to) runs.push({ from: Math.max(from + replacement.length, run.from + shift), to: run.to + shift, style: run.style });
  }
  if (replacement.length) runs.push({ from, to: from + replacement.length, style: insertionStyle });
  const paragraphs = paragraphsWithInheritedStyles(text, layer.text, layer.paragraphs, from, to - from, replacement.length);
  return { ...layer, text, runs: canonicalTextRuns(text, runs, insertionStyle), paragraphs,
    alignment: paragraphs[0]?.style.alignment ?? layer.alignment, raster: null, renderedTransform: null };
}

export function applyTextStyle(layer: TextLayer, from: number, to: number, patch: TextStylePatch): TextLayer {
  assertTextRange(layer.text, from, to);
  if (from === to) return layer;
  const runs: TextRun[] = [];
  for (const run of canonicalTextRuns(layer.text, layer.runs)) {
    if (run.to <= from || run.from >= to) { runs.push(run); continue; }
    if (run.from < from) runs.push({ from: run.from, to: from, style: run.style });
    const middleFrom = Math.max(run.from, from), middleTo = Math.min(run.to, to);
    runs.push({ from: middleFrom, to: middleTo, style: { ...run.style, ...patch, schemaVersion: 1 } });
    if (run.to > to) runs.push({ from: to, to: run.to, style: run.style });
  }
  return { ...layer, runs: canonicalTextRuns(layer.text, runs), raster: null, renderedTransform: null };
}

export function applyParagraphStyle(layer: TextLayer, from: number, to: number,
  patch: ParagraphStylePatch): TextLayer {
  assertTextRange(layer.text, from, to);
  const paragraphs = layer.paragraphs.map((paragraph) => {
    const selected = from === to ? paragraph.from <= from && from <= paragraph.to : paragraph.to > from && paragraph.from < to;
    if (!selected) return paragraph;
    const style = { ...paragraph.style, ...patch, schemaVersion: 1 as const };
    if (!validParagraphStyle(style)) throw new TypeError('Invalid paragraph style');
    return { ...paragraph, style };
  });
  return { ...layer, paragraphs, alignment: paragraphs[0]?.style.alignment ?? layer.alignment, raster: null, renderedTransform: null };
}

export function convertTextBox(layer: TextLayer, box: TextLayer['box']): TextLayer {
  if (box && (!(box.width > 0) || !(box.height > 0) || !Number.isFinite(box.width) || !Number.isFinite(box.height))) {
    throw new RangeError('Area text box dimensions must be positive finite numbers');
  }
  return { ...layer, box, raster: null, renderedTransform: null };
}
