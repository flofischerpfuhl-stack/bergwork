/**
 * Search Commands (UI/CommandPalette.swift, Compositor 1.4.6): every menu command and every tool as one ranked list.
 * Entries are read afresh from the menu model each time the palette opens, so titles that follow state
 * ("Undo Brush Stroke") and enabled states are current.
 */

import type { Menu, MenuEntry } from './menus';
import { shortcutLabel } from './menus';

export interface PaletteEntry {
  /** Unique: the title, with its position added when an earlier entry has the same title. */
  readonly id: string;
  /** Full path as shown and searched: "Filter › Gaussian Blur…". */
  readonly title: string;
  readonly shortcut: string | null;
  /** False when the menu item is disabled right now: listed greyed, never run. */
  readonly enabled: boolean;
  /** A toggle that is on now, checked as its menu item is. */
  readonly on: boolean;
  readonly run: () => void;
}

/**
 * Launcher-style fuzzy match: the query's letters must appear in order. Ties are broken by how the text was found,
 * best first: whole at the start of a word, each typed word starting a word in order, whole inside a word, spaces
 * aside, and last scattered letters as an abbreviation ("gb" finds Gaussian Blur).
 */
export function paletteScore(query: string, text: string): number | null {
  const wanted = [...query.toLowerCase()].filter((c) => !/\s/.test(c));
  if (!wanted.length) return 0;
  const letters = [...text.toLowerCase()];
  let total = 0, from = 0, previous = -2;
  for (const character of wanted) {
    const found = letters.indexOf(character, from);
    if (found < 0) return null;
    const wordStart = found === 0 || !/[\p{L}\p{N}]/u.test(letters[found - 1]!);
    total += 1 + (wordStart ? 8 : 0) + (found === previous + 1 ? 5 : 0);
    previous = found; from = found + 1;
  }
  const title = letters.join(''), phrase = query.toLowerCase().trim(), words = phrase.split(/\s+/).filter(Boolean);
  const tier = wordsStartWords([phrase], title) ? 5
    : words.length > 1 && wordsStartWords(words, title) ? 4
      : title.includes(phrase) ? 3
        : title.replaceAll(' ', '').includes(wanted.join('')) ? 2 : 1;
  // Found the same way, a clearly shorter title is the likelier one; scattered letters rank by how well they fall.
  return tier * 1_000_000 + (tier === 1 ? total * 100 : 0) - Math.floor(letters.length / 4);
}

function wordsStartWords(words: readonly string[], title: string): boolean {
  let from = 0;
  for (const word of words) {
    let search = from, found = -1;
    for (let at = title.indexOf(word, search); at >= 0; at = title.indexOf(word, search)) {
      if (at === 0 || !/\p{L}/u.test(title[at - 1]!)) { found = at + word.length; break; }
      search = at + 1;
    }
    if (found < 0) return false;
    from = found;
  }
  return true;
}

/** Matching entries, best first, enabled ahead of disabled; with no query all of them in menu order, enabled first. */
export function rankPalette(entries: readonly PaletteEntry[], query: string): PaletteEntry[] {
  const scored = entries.flatMap((entry, index) => {
    const score = paletteScore(query, entry.title);
    return score === null ? [] : [{ entry, score, index }];
  });
  return scored.sort((a, b) => a.entry.enabled !== b.entry.enabled ? (a.entry.enabled ? -1 : 1)
    : !query.trim() || a.score === b.score ? a.index - b.index : b.score - a.score).map((item) => item.entry);
}

/** The menu bar as entries: every item that does something, with its path, key and current state. */
export function menuPaletteEntries(menus: readonly Menu[], skip: ReadonlySet<string> = new Set()): PaletteEntry[] {
  const seen = new Map<string, number>(), result: PaletteEntry[] = [];
  const visit = (items: readonly MenuEntry[], path: readonly string[], parentEnabled: boolean) => {
    for (const item of items) {
      if (item === 'separator' || !item.label || skip.has(item.label)) continue;
      if (item.submenu) { visit(item.submenu, [...path, item.label], parentEnabled && item.enabled); continue; }
      if (!item.run && item.enabled) continue;
      const title = [...path, item.label].join(' › '), count = seen.get(title) ?? 0;
      seen.set(title, count + 1);
      result.push({ id: count ? `${title} (${count + 1})` : title, title,
        shortcut: item.shortcut ? shortcutLabel(item.shortcut) : null, enabled: parentEnabled && item.enabled && !!item.run,
        on: !!item.checked, run: () => item.run?.() });
    }
  };
  for (const menu of menus) visit(menu.items, [menu.title], true);
  return result;
}
