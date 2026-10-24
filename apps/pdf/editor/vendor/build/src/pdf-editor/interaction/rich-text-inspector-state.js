const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export function graphemeSelection(text, start, end = start) {
  const boundaries = [0];
  for (const entry of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
    if (!boundaries.includes(entry.index)) boundaries.push(entry.index);
  }
  if (boundaries.at(-1) !== text.length) boundaries.push(text.length);
  const floor = value => [...boundaries].reverse().find(boundary => boundary <= value) ?? 0;
  const ceil = value => boundaries.find(boundary => boundary >= value) ?? text.length;
  return start === end
    ? { start: floor(start), end: floor(start) }
    : { start: floor(start), end: ceil(end) };
}

export function textareaReplacement(previousText, nextText, selection) {
  let start = Number(selection?.start);
  let end = Number(selection?.end);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > previousText.length) {
    throw new RangeError('Textarea selection is outside the rich-text document.');
  }
  let suffixLength = previousText.length - end;
  const preservesSelectionOutside = () => nextText.slice(0, start) === previousText.slice(0, start) &&
    (!suffixLength || nextText.slice(-suffixLength) === previousText.slice(end));
  if (!preservesSelectionOutside()) {
    const inputType = String(selection?.inputType || '');
    if (!inputType.startsWith('delete') && inputType !== 'historyUndo' && inputType !== 'historyRedo') {
      throw new Error('Textarea input did not preserve text outside its selected range.');
    }
    let prefix = 0;
    while (prefix < previousText.length && prefix < nextText.length && previousText[prefix] === nextText[prefix]) prefix += 1;
    let suffix = 0;
    while (suffix < previousText.length - prefix && suffix < nextText.length - prefix &&
      previousText[previousText.length - 1 - suffix] === nextText[nextText.length - 1 - suffix]) suffix += 1;
    const actual = graphemeSelection(previousText, prefix, previousText.length - suffix);
    start = actual.start;
    end = actual.end;
    suffixLength = previousText.length - end;
    if (!preservesSelectionOutside()) throw new Error('Textarea deletion is not grapheme-aligned.');
  }
  return {
    selection: { start, end },
    replacement: nextText.slice(start, nextText.length - suffixLength),
  };
}

export function selectedCharacterState(document, selection, typingStyle) {
  const styles = selection.start === selection.end
    ? [typingStyle]
    : document.runs.filter(run => run.start < selection.end && run.end > selection.start).map(run => run.style);
  const value = key => styles.length && styles.every(style => style?.[key] === styles[0]?.[key])
    ? styles[0]?.[key]
    : null;
  const decorationValue = key => styles.length && styles.every(style =>
    Boolean(style?.decoration?.[key]) === Boolean(styles[0]?.decoration?.[key]))
    ? Boolean(styles[0]?.decoration?.[key])
    : null;
  return {
    resourceId: value('resourceId'), family: value('family'), fontSize: value('fontSize'),
    weight: value('weight'), style: value('style'), color: value('color'),
    decoration: { underline: decorationValue('underline'), strike: decorationValue('strike') },
    mixed: styles.length > 1 && !styles.every(style => same(style, styles[0])),
  };
}

export function matchingFontFace(resources, current, patch) {
  const family = patch.family ?? current.family;
  const weight = patch.weight ?? current.weight;
  const style = patch.style ?? current.style;
  const exact = resources.find(resource => resource.family === family && resource.weight === weight && resource.style === style);
  if (exact || !['italic', 'oblique'].includes(style)) return exact || null;
  const alternate = style === 'italic' ? 'oblique' : 'italic';
  return resources.find(resource => resource.family === family && resource.weight === weight && resource.style === alternate) || null;
}
