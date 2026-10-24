/**
 * The title bar: mark, the berg:work wordmark (the only place for Bergschrift) and the product on the left,
 * the document in the middle, app settings and — in the desktop app — the window buttons on the right.
 */
import type { ReactNode } from 'react';
import { Minus, Monitor, Moon, RectangleHorizontal, Square, Sun, X, Maximize2 } from 'lucide-react';
import { MenuButton, type MenuEntry } from './Menu';
import type { Appearance } from './appearance';

export interface TitleBarStrings {
  readonly appearance: string;
  readonly light: string;
  readonly dark: string;
  readonly system: string;
  readonly round: string;
  readonly sharp: string;
  readonly minimize: string;
  readonly maximize: string;
  readonly close: string;
}

export const TITLE_BAR_EN: TitleBarStrings = {
  appearance: 'Appearance', light: 'Light', dark: 'Dark', system: 'System', round: 'Round corners', sharp: 'Sharp corners',
  minimize: 'Minimize', maximize: 'Maximize', close: 'Close',
};
export const TITLE_BAR_DE: TitleBarStrings = {
  appearance: 'Darstellung', light: 'Hell', dark: 'Dunkel', system: 'System', round: 'Runde Ecken', sharp: 'Eckige Ecken',
  minimize: 'Minimieren', maximize: 'Maximieren', close: 'Schließen',
};

const ICON = { size: 16, strokeWidth: 1.7 } as const;

export function TitleBar(props: {
  readonly mark?: ReactNode;
  readonly product: string;
  readonly document?: string;
  readonly appearance: Appearance;
  readonly onAppearance: (change: Partial<Appearance>) => void;
  /** Window buttons, for the desktop app only; a web page cannot minimize its window. */
  readonly windowControls?: { readonly onMinimize: () => void; readonly onMaximize: () => void; readonly onClose: () => void };
  /** Further title bar buttons left of the appearance button. */
  readonly actions?: ReactNode;
  readonly strings?: TitleBarStrings;
}) {
  const t = props.strings ?? TITLE_BAR_EN;
  const { theme, corners } = props.appearance;
  const ThemeIcon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;
  const entries: MenuEntry[] = [
    { label: t.light, icon: <Sun {...ICON} />, checked: theme === 'light', onSelect: () => props.onAppearance({ theme: 'light' }) },
    { label: t.dark, icon: <Moon {...ICON} />, checked: theme === 'dark', onSelect: () => props.onAppearance({ theme: 'dark' }) },
    { label: t.system, icon: <Monitor {...ICON} />, checked: theme === 'system', onSelect: () => props.onAppearance({ theme: 'system' }) },
    { type: 'divider' },
    { label: t.round, icon: <RectangleHorizontal {...ICON} />, checked: corners === 'round', onSelect: () => props.onAppearance({ corners: 'round' }) },
    { label: t.sharp, icon: <Square {...ICON} />, checked: corners === 'sharp', onSelect: () => props.onAppearance({ corners: 'sharp' }) },
  ];
  return (
    <header className="bw-titlebar" data-tauri-drag-region>
      <div className="bw-titlebar-brand">
        {props.mark ? <span className="bw-titlebar-mark" aria-hidden>{props.mark}</span> : null}
        <span className="bw-wordmark">berg:work</span>
        <span className="bw-titlebar-product">{props.product}</span>
      </div>
      <div className="bw-titlebar-document" data-tip-overflow>{props.document}</div>
      <div className="bw-titlebar-actions">
        {props.actions}
        <MenuButton className="bw-titlebar-button" label={t.appearance} tip={t.appearance} entries={entries}>
          <ThemeIcon size={15} strokeWidth={1.7} />
        </MenuButton>
        {props.windowControls ? (
          <>
            <button type="button" className="bw-titlebar-button" aria-label={t.minimize} data-tip={t.minimize} onClick={props.windowControls.onMinimize}><Minus size={15} strokeWidth={1.7} /></button>
            <button type="button" className="bw-titlebar-button" aria-label={t.maximize} data-tip={t.maximize} onClick={props.windowControls.onMaximize}><Maximize2 size={14} strokeWidth={1.7} /></button>
            <button type="button" className="bw-titlebar-button is-close" aria-label={t.close} data-tip={t.close} onClick={props.windowControls.onClose}><X size={16} strokeWidth={1.7} /></button>
          </>
        ) : null}
      </div>
    </header>
  );
}
