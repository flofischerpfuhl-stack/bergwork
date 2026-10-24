/** The Search Commands panel (UI/CommandPaletteView.swift): a search field over the ranked commands. ↑/↓ choose, Return runs, Esc closes. */

import { useEffect, useMemo, useRef, useState } from 'react';
import styles from './editor.module.css';
import type { EditorController } from './controller';
import { cachedMenus } from './menus';
import { menuPaletteEntries, rankPalette, type PaletteEntry } from './commandPalette';
import { TOOL_LABELS, TOOLS } from '../core/session';
import { markUiRender } from './performance';

/** Tools by the name someone searches for; the key shows where a command's shortcut would. */
function toolEntries(controller: EditorController): PaletteEntry[] {
  const t = controller.t, hasDocument = !!controller.session.document;
  return TOOLS.filter((tool) => controller.availableTools.has(tool)).flatMap((tool) =>
    // "Brush (B) · Eraser (E)": one entry per named mode; both select the tool, which keeps its own mode keys.
    t(TOOL_LABELS[tool]).split(' · ').filter((part, index) => index === 0 || /\([^)]+\)$/.test(part.trim())).map((part) => {
      const match = /^(.*?)\s*\(([^)]+)\)$/.exec(part.trim());
      const name = match?.[1] ?? part.trim();
      return { id: `tool:${tool}:${name}`, title: `${t('Tool')} › ${name}`, shortcut: match?.[2] ?? null,
        enabled: hasDocument, on: controller.session.tool === tool, run: () => { void controller.activateTool(tool); } };
    }));
}

export function CommandPalette({ controller, close }: { controller: EditorController; close: () => void }) {
  markUiRender('CommandPalette');
  const t = controller.t;
  // Read once per opening, like the Swift palette: the titles and states are those of the moment it opened.
  const entries = useMemo(() => [...menuPaletteEntries(cachedMenus(controller), new Set([t('Search Commands…')])),
    ...toolEntries(controller)], [controller, t]);
  const [query, setQuery] = useState('');
  const [selection, setSelection] = useState(0);
  const results = useMemo(() => rankPalette(entries, query), [entries, query]);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { setSelection(0); }, [query]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${selection}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selection]);
  const run = (entry: PaletteEntry | undefined) => {
    if (!entry?.enabled) return;
    close();
    // After the dialog is gone, so a command that opens its own dialog is not closed with this one.
    queueMicrotask(entry.run);
  };
  return (
    <div className={`${styles.dialog} ${styles.commandPalette}`} role="dialog" aria-modal aria-label={t('Search Commands')} data-testid="command-palette">
      <input autoFocus className={styles.commandSearch} value={query} placeholder={t('Search commands and tools')}
        aria-label={t('Search commands and tools')} role="combobox" aria-expanded aria-controls="cmp-palette-list"
        aria-activedescendant={results[selection] ? `cmp-palette-${selection}` : undefined} data-testid="command-palette-input"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            const step = event.key === 'ArrowDown' ? 1 : -1;
            setSelection((current) => results.length ? (current + step + results.length) % results.length : 0);
            event.preventDefault();
          } else if (event.key === 'Enter') { run(results[selection]); event.preventDefault(); }
        }} />
      <div ref={list} className={styles.commandList} role="listbox" id="cmp-palette-list" aria-label={t('Commands')}>
        {results.length ? results.map((entry, index) => (
          <button key={entry.id} type="button" role="option" id={`cmp-palette-${index}`} data-index={index}
            aria-selected={index === selection} aria-disabled={!entry.enabled} tabIndex={-1}
            className={`${styles.menuItem} ${index === selection ? styles.commandChosen : ''}`}
            onPointerMove={() => { if (index !== selection) setSelection(index); }} onClick={() => run(entry)}>
            {entry.on ? <span className={styles.menuCheck}>✓</span> : null}
            <span className={entry.enabled ? undefined : styles.commandDisabled}>{entry.title}</span>
            {entry.shortcut ? <span className={styles.shortcut}>{entry.shortcut}</span> : null}
          </button>
        )) : <p className={styles.dialogMessage} style={{ padding: 12 }}>{t('No commands match')}</p>}
      </div>
    </div>
  );
}
