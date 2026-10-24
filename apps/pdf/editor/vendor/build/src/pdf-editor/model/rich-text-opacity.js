import { createRichTextDocument } from './rich-text-document.js';

function normalizedColor(color) {
  const value = String(color || '').toLowerCase();
  if (/^#[0-9a-f]{6}$/u.test(value)) return `${value}ff`;
  if (/^#[0-9a-f]{8}$/u.test(value)) return value;
  throw new Error('Rich text opacity requires canonical RGB character colors.');
}

function opacityFromColor(color) {
  return Number.parseInt(normalizedColor(color).slice(7, 9), 16) / 255;
}

export function textColorWithOpacity(color, opacity) {
  if (typeof opacity !== 'number' || !Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
    throw new Error('Text opacity must be a finite number from 0 to 1.');
  }
  const alpha = Math.round(opacity * 255).toString(16).padStart(2, '0');
  return `${normalizedColor(color).slice(0, 7)}${alpha}`;
}

export function richTextOpacityState(document) {
  const canonical = createRichTextDocument(document);
  // Runs cover every painted character in a canonical non-empty document.
  // The default style is future-input state and must not manufacture a mixed
  // visual state when it is currently unpainted.
  const colors = canonical.runs.length
    ? canonical.runs.map(run => run.style.color)
    : [canonical.defaultCharacterStyle.color];
  const values = colors.map(opacityFromColor);
  const first = values[0];
  return Object.freeze({
    mixed: values.some(value => value !== first),
    value: first,
  });
}

export function richTextDocumentWithOpacity(document, opacity) {
  if (typeof opacity !== 'number' || !Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
    throw new Error('Rich text opacity must be a finite number from 0 to 1.');
  }
  const canonical = createRichTextDocument(document);
  const style = source => ({ ...source, color: textColorWithOpacity(source.color, opacity) });
  return Object.freeze({ version: 1, ...createRichTextDocument({
    ...canonical,
    defaultCharacterStyle: style(canonical.defaultCharacterStyle),
    runs: canonical.runs.map(run => ({ ...run, style: style(run.style) })),
  }) });
}
