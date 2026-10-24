import { describe, expect, it } from 'vitest';
import { menuPaletteEntries, paletteScore, rankPalette, type PaletteEntry } from '../../src/ui/commandPalette';
import type { Menu } from '../../src/ui/menus';

const entry = (title: string, enabled = true): PaletteEntry => ({ id: title, title, shortcut: null, enabled, on: false, run: () => {} });

describe('Search Commands ranking (CommandPalette.swift)', () => {
  it('needs the letters in order', () => {
    expect(paletteScore('gb', 'Filter › Gaussian Blur…')).not.toBeNull();
    expect(paletteScore('bg', 'Filter › Gaussian Blur…')).toBeNull();
    expect(paletteScore('', 'anything')).toBe(0);
  });

  it('prefers a whole word over letters scattered through a longer title', () => {
    const ranked = rankPalette([entry('Layer › New Adjustment Layer › Hue/Saturation…'), entry('Tool › Lasso')], 'lasso');
    expect(ranked[0]!.title).toBe('Tool › Lasso');
  });

  it('matches each typed word at a word start, in order', () => {
    const ranked = rankPalette([entry('Layer › Rename Layer…'), entry('Layer › New Blank Layer')], 'new layer');
    expect(ranked[0]!.title).toBe('Layer › New Blank Layer');
  });

  it('finds an abbreviation and keeps disabled entries behind enabled ones', () => {
    const ranked = rankPalette([entry('Filter › Gaussian Blur…', false), entry('Filter › Motion Blur…'), entry('Debug › Grab Bag')], 'gb');
    expect(ranked.map((item) => item.title)).toEqual(['Debug › Grab Bag', 'Filter › Gaussian Blur…']);
  });

  it('lists everything in menu order with an empty query, enabled first', () => {
    const ranked = rankPalette([entry('A', false), entry('B'), entry('C')], '');
    expect(ranked.map((item) => item.title)).toEqual(['B', 'C', 'A']);
  });
});

describe('menu entries', () => {
  it('flattens submenus into paths, numbers repeated titles and disables children of a disabled submenu', () => {
    let ran = '';
    const menus: Menu[] = [
      { title: 'Layer', items: [
        { label: 'Duplicate Layer', shortcut: 'mod+j', enabled: true, run: () => { ran = 'dup'; } },
        'separator',
        { label: 'Layer Mask', enabled: false, submenu: [{ label: 'Reveal All', enabled: true, run: () => {} }] },
        { label: 'Align', enabled: true, submenu: [{ label: 'Left Edges', enabled: true, run: () => {} }] },
      ] },
      { title: 'View', items: [
        { label: 'Snap', enabled: true, checked: true, run: () => {} },
        { label: 'Snap', enabled: true, run: () => {} },
        { label: 'Search Commands…', enabled: true, run: () => {} },
      ] },
    ];
    const entries = menuPaletteEntries(menus, new Set(['Search Commands…']));
    expect(entries.map((item) => item.id)).toEqual(['Layer › Duplicate Layer', 'Layer › Layer Mask › Reveal All',
      'Layer › Align › Left Edges', 'View › Snap', 'View › Snap (2)']);
    expect(entries[1]!.enabled).toBe(false);
    expect(entries[3]!.on).toBe(true);
    expect(entries[0]!.shortcut).toMatch(/J$/);
    entries[0]!.run();
    expect(ran).toBe('dup');
  });
});
