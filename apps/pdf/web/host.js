// berg:work host for the Fernwork PDF editor.
//
// The app draws its own title bar (index.html): icon, wordmark, settings and macOS-style window controls. The
// editor keeps its floating top bar below it and receives the `shell` capability of `mount(element, { host })`,
// through which it reports the active document for the native window title (task switcher, window lists). No
// `setFullscreen`: the app has no fullscreen toggle. Outside Tauri (plain browser) the window controls only show
// with `?preview`, without function.

import { showLicences } from './licenses-view.js';
import { setThemePreference, themePreference } from './theme-preference.js';

const APP_NAME = 'berg:work PDF';
const SVG_NS = 'http://www.w3.org/2000/svg';

// Glyphs shown on the traffic lights while the pointer is over them (viewBox 0 0 10 10).
const GLYPHS = {
  minimize: 'M2 5h6',
  maximize: 'M3 3h4v4H3z',
  restore: 'M2.5 4.5h3v3h-3z M4.5 2.5h3v3',
  close: 'M3 3l4 4 M7 3L3 7',
};
const GEAR = '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>';

/** The current Tauri window, or null in a plain browser. */
function currentWindow() {
  try {
    return globalThis.__TAURI__?.window?.getCurrentWindow?.() ?? null;
  } catch {
    return null;
  }
}

/** Runs a native window call and logs (instead of throwing) a rejection such as a missing permission. */
function call(win, method, ...args) {
  if (!win) return;
  Promise.resolve()
    .then(() => win[method](...args))
    .catch((error) => console.warn(`[bergwork] window.${method} failed`, error));
}

function glyph(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 10 10');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('bw-glyph', `bw-glyph-${name}`);
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', GLYPHS[name]);
  svg.append(path);
  return svg;
}

function trafficLight(kind, label, onClick, ...glyphs) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `bw-traffic bw-traffic-${kind}`;
  button.setAttribute('aria-label', label);
  button.title = label;
  button.append(...glyphs);
  button.addEventListener('click', onClick);
  return button;
}

/** Window controls on the right (close outermost), dragging and double-click maximise on the empty bar. */
function wireTitleBar(win) {
  const bar = document.getElementById('bw-titlebar');
  const controls = document.getElementById('bw-window-controls');
  if (!bar || !controls) return;
  const preview = !win && new URLSearchParams(location.search).has('preview');
  if (!win && !preview) {
    controls.hidden = true;
    return;
  }
  const maximize = trafficLight('maximize', 'Maximize', () => call(win, 'toggleMaximize'), glyph('maximize'), glyph('restore'));
  controls.append(
    trafficLight('minimize', 'Minimize', () => call(win, 'minimize'), glyph('minimize')),
    maximize,
    trafficLight('close', 'Close', () => call(win, 'close'), glyph('close')),
  );
  // Inactive windows show grey lights, as on macOS.
  window.addEventListener('blur', () => document.documentElement.classList.add('bw-window-inactive'));
  window.addEventListener('focus', () => document.documentElement.classList.remove('bw-window-inactive'));
  if (preview) return;

  const showMaximized = (maximized) => {
    // Maximised windows are square and without the outline (see theme.css).
    document.documentElement.classList.toggle('bw-window-maximized', maximized);
    const label = maximized ? 'Restore' : 'Maximize';
    maximize.setAttribute('aria-label', label);
    maximize.title = label;
  };
  const refresh = () => {
    Promise.resolve().then(() => win.isMaximized()).then(showMaximized, () => {});
  };
  refresh();
  // Maximising, restoring and snapping all resize the window; re-read the state instead of guessing.
  Promise.resolve().then(() => win.onResized(refresh)).catch((error) => console.warn('[bergwork] cannot track the maximized state', error));

  // Once a native drag starts the window manager owns the pointer and no dblclick arrives, so the second press
  // of a double-click is recognised on mousedown (as Tauri's own drag regions do).
  bar.addEventListener('mousedown', (event) => {
    if (event.button !== 0 || event.target.closest('button, .bw-settings-panel')) return;
    if (event.detail === 2) call(win, 'toggleMaximize');
    else call(win, 'startDragging');
  });
}

/** Gear button with the app settings: theme and version. */
function wireSettings() {
  const host = document.getElementById('bw-settings');
  if (!host) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'bw-titlebar-button';
  button.setAttribute('aria-label', 'Settings');
  button.setAttribute('aria-haspopup', 'true');
  button.setAttribute('aria-expanded', 'false');
  button.title = 'Settings';
  button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${GEAR}</svg>`;

  const panel = document.createElement('div');
  panel.className = 'bw-settings-panel';
  panel.hidden = true;
  panel.setAttribute('role', 'group');
  panel.setAttribute('aria-label', 'Settings');
  panel.innerHTML = `
    <div class="bw-settings-title">Theme</div>
    <div class="bw-segmented" role="radiogroup" aria-label="Theme">
      <button type="button" role="radio" data-theme-choice="system">System</button>
      <button type="button" role="radio" data-theme-choice="light">Light</button>
      <button type="button" role="radio" data-theme-choice="dark">Dark</button>
    </div>
    <div class="bw-settings-about">
      <span><span class="bw-settings-app">${APP_NAME}</span> <span class="bw-settings-version"></span></span>
      <button type="button" class="bw-settings-link" data-action="licences">Licences</button>
    </div>`;

  const showChoice = () => {
    const current = themePreference();
    panel.querySelectorAll('[data-theme-choice]').forEach((choice) => {
      const on = choice.dataset.themeChoice === current;
      choice.classList.toggle('is-active', on);
      choice.setAttribute('aria-checked', String(on));
    });
  };
  panel.addEventListener('click', (event) => {
    if (event.target.closest('[data-action="licences"]')) {
      setOpen(false);
      void showLicences();
      return;
    }
    const choice = event.target.closest('[data-theme-choice]');
    if (!choice) return;
    setThemePreference(choice.dataset.themeChoice);
    showChoice();
  });
  const setOpen = (open) => {
    panel.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    button.classList.toggle('is-open', open);
    if (open) showChoice();
  };
  button.addEventListener('click', () => setOpen(panel.hidden));
  document.addEventListener('pointerdown', (event) => {
    if (!panel.hidden && !host.contains(event.target)) setOpen(false);
  }, true);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !panel.hidden) setOpen(false);
  });
  Promise.resolve()
    .then(() => globalThis.__TAURI__?.app?.getVersion?.())
    .then((version) => { if (version) panel.querySelector('.bw-settings-version').textContent = version; }, () => {});
  host.append(button, panel);
}

/** Wires the title bar and builds the host object passed to `bundle.mount(element, { host })`. */
export function createShellHost() {
  const win = currentWindow();
  // Linux draws rounded corners in the page (transparent window); Windows 11 rounds undecorated windows itself.
  if (win && /Linux/.test(navigator.userAgent)) document.documentElement.classList.add('bw-rounded-window');
  wireTitleBar(win);
  wireSettings();
  const setTitle = (title, { dirty = false } = {}) => {
    const windowTitle = title ? `${dirty ? '• ' : ''}${title} — ${APP_NAME}` : APP_NAME;
    document.title = windowTitle;
    call(win, 'setTitle', windowTitle);
  };
  return {
    capabilities: {
      shell: { version: 1, setTitle },
    },
  };
}
