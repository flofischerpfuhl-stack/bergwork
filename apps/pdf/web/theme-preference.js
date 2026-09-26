// Light/dark: follows the system unless the user picks one in the title bar settings.

const KEY = 'bw-theme';
const media = matchMedia('(prefers-color-scheme: dark)');

export function themePreference() {
  const value = localStorage.getItem(KEY);
  return value === 'light' || value === 'dark' ? value : 'system';
}

function apply() {
  const preference = themePreference();
  const dark = preference === 'dark' || (preference === 'system' && media.matches);
  // The editor CSS defaults to dark tokens and switches on html[data-theme="light"].
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

export function setThemePreference(value) {
  if (value === 'system') localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, value);
  apply();
}

export function initTheme() {
  apply();
  media.addEventListener('change', apply);
}
