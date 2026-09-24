/**
 * Recently used foreground colours (PRODUCT-PLAN 6.1): the last 12 colours that went into the document — brush
 * strokes, fills, new shapes and paths, text colour, swatches dropped on layers. The engine only announces a use;
 * the UI keeps the list (app state, persisted across sessions).
 */

import type { RGB } from '../model/types';
import { rgbToHex } from './convert';

export const RECENT_COLOR_LIMIT = 12;

/** The list with `color` first; an 8-bit-equal entry moves to the front instead of appearing twice. */
export function pushRecentColor(list: readonly RGB[], color: RGB, limit = RECENT_COLOR_LIMIT): readonly RGB[] {
  const key = rgbToHex(color);
  if (list.length && rgbToHex(list[0]!) === key) return list;
  const plain = { red: color.red, green: color.green, blue: color.blue };
  return [plain, ...list.filter((entry) => rgbToHex(entry) !== key)].slice(0, Math.max(0, limit));
}

export function validRecentColors(value: unknown): value is RGB[] {
  return Array.isArray(value) && value.length <= RECENT_COLOR_LIMIT && value.every((c) => !!c && typeof c === 'object'
    && [c.red, c.green, c.blue].every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1));
}

export type ColorUseListener = (source: object, color: RGB) => void;
const listeners = new Set<ColorUseListener>();

/** Called by the engine when a colour is applied to the document; `source` is the session. */
export function noteColorUsed(source: object, color: RGB): void {
  for (const listener of [...listeners]) listener(source, color);
}

export function onColorUsed(listener: ColorUseListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
