/**
 * Appearance: light / dark / system and round / sharp corners (Builder §9). An app setting, so it sits in
 * the title bar, not in the work bars. Stored per browser; the page renders correctly without storage.
 */
import { useCallback, useEffect, useState } from 'react';

export type ThemeChoice = 'light' | 'dark' | 'system';
export type Corners = 'round' | 'sharp';
export interface Appearance { readonly theme: ThemeChoice; readonly corners: Corners }

const KEY = 'bergwork.appearance';
const DEFAULT: Appearance = { theme: 'system', corners: 'round' };

function read(): Appearance {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? 'null') as Partial<Appearance> | null;
    return {
      theme: value?.theme === 'light' || value?.theme === 'dark' || value?.theme === 'system' ? value.theme : DEFAULT.theme,
      corners: value?.corners === 'sharp' ? 'sharp' : 'round',
    };
  } catch { return DEFAULT; }
}

function systemTheme(): 'light' | 'dark' {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** The theme the page shows: the choice, or the system's for "system", live. */
export function resolvedTheme(choice: ThemeChoice): 'light' | 'dark' {
  return choice === 'system' ? systemTheme() : choice;
}

/** Applies an appearance to the document root (data-theme, data-corners). Call before first paint to avoid a flash. */
export function applyAppearance(appearance: Appearance = read(), root: HTMLElement = document.documentElement): void {
  root.dataset['theme'] = resolvedTheme(appearance.theme);
  root.dataset['corners'] = appearance.corners;
}

/** The appearance with setters; keeps the document root in step, follows the system while "system" is chosen. */
export function useAppearance(): readonly [Appearance, (change: Partial<Appearance>) => void] {
  const [appearance, setAppearance] = useState(read);
  useEffect(() => {
    applyAppearance(appearance);
    if (appearance.theme !== 'system' || typeof matchMedia !== 'function') return;
    const media = matchMedia('(prefers-color-scheme: light)');
    const change = () => applyAppearance(appearance);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, [appearance]);
  // Another window or tab of the app changed it.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => { if (event.key === KEY) setAppearance(read()); };
    addEventListener('storage', onStorage);
    return () => removeEventListener('storage', onStorage);
  }, []);
  const update = useCallback((change: Partial<Appearance>) => {
    setAppearance((current) => {
      const next = { ...current, ...change };
      try { globalThis.localStorage?.setItem(KEY, JSON.stringify(next)); } catch { /* storage blocked */ }
      return next;
    });
  }, []);
  return [appearance, update] as const;
}
