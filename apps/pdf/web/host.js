// berg:work host for the Fernwork PDF editor: the `shell` capability of `mount(element, { host })`.
//
// The editor reports the active document through setTitle() and, when it supports titleBar, moves `leading`
// (app icon) and `trailing` (window controls) into its own top row, which then acts as the window title bar.
// Outside Tauri (plain browser, Playwright) every native call is a no-op and the window controls stay hidden.

const APP_NAME = 'berg:work PDF';
const ICON_SRC = './bergwork-pdf-icon.svg';

const SVG_NS = 'http://www.w3.org/2000/svg';
// 10×10 glyphs in the Windows 11 caption style; stroked with currentColor.
const GLYPHS = {
  minimize: 'M0 5.5h10',
  maximize: 'M.5 .5h9v9h-9z',
  restore: 'M2.5 2.5h7v7h-7z M2.5 .5h7v7',
  close: 'M.5 .5l9 9 M9.5 .5l-9 9',
};

/** The current Tauri window, or null in a plain browser. */
function currentWindow() {
  try {
    return globalThis.__TAURI__?.window?.getCurrentWindow?.() ?? null;
  } catch {
    return null;
  }
}

/** Runs a native window call and swallows rejections (e.g. a missing permission) after logging them. */
function call(win, method, ...args) {
  if (!win) return;
  Promise.resolve()
    .then(() => win[method](...args))
    .catch((error) => console.warn(`[bergwork] window.${method} failed`, error));
}

function glyph(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 10 10');
  svg.setAttribute('width', '10');
  svg.setAttribute('height', '10');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('bw-glyph', `bw-glyph-${name}`);
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', GLYPHS[name]);
  svg.append(path);
  return svg;
}

function controlButton(kind, label, onClick, ...glyphs) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `bw-window-control bw-window-control-${kind}`;
  button.setAttribute('aria-label', label);
  button.title = label;
  button.append(...glyphs);
  button.addEventListener('click', onClick);
  return button;
}

function createIcon() {
  const leading = document.createElement('div');
  leading.className = 'bw-titlebar-icon';
  const img = document.createElement('img');
  img.src = ICON_SRC;
  img.alt = '';
  img.draggable = false;
  leading.append(img);
  return leading;
}

function createWindowControls(win) {
  const controls = document.createElement('div');
  controls.className = 'bw-window-controls';
  controls.setAttribute('role', 'group');
  controls.setAttribute('aria-label', 'Window');
  if (!win) {
    controls.hidden = true;
    return controls;
  }

  const minimize = controlButton('minimize', 'Minimize', () => call(win, 'minimize'), glyph('minimize'));
  const maximize = controlButton(
    'maximize',
    'Maximize',
    () => call(win, 'toggleMaximize'),
    glyph('maximize'),
    glyph('restore'),
  );
  const close = controlButton('close', 'Close', () => call(win, 'close'), glyph('close'));
  controls.append(minimize, maximize, close);

  const showMaximized = (maximized) => {
    controls.classList.toggle('is-maximized', maximized);
    const label = maximized ? 'Restore' : 'Maximize';
    maximize.setAttribute('aria-label', label);
    maximize.title = label;
  };
  const refresh = () => {
    Promise.resolve()
      .then(() => win.isMaximized())
      .then(showMaximized, () => {});
  };
  refresh();
  // Maximising, restoring and snapping all resize the window; re-read the state instead of guessing.
  Promise.resolve()
    .then(() => win.onResized(refresh))
    .catch((error) => console.warn('[bergwork] cannot track the maximized state', error));
  return controls;
}

/** Builds the host object passed to `bundle.mount(element, { host })`. */
export function createShellHost() {
  const win = currentWindow();
  const leading = createIcon();
  const trailing = createWindowControls(win);
  const setTitle = (title, { dirty = false } = {}) => {
    const windowTitle = title ? `${dirty ? '• ' : ''}${title} — ${APP_NAME}` : APP_NAME;
    document.title = windowTitle;
    call(win, 'setTitle', windowTitle);
  };
  const startDrag = () => call(win, 'startDragging');
  const toggleMaximize = () => call(win, 'toggleMaximize');

  const host = {
    capabilities: {
      shell: {
        version: 1,
        setTitle,
        titleBar: { leading, trailing, startDrag, toggleMaximize },
      },
    },
  };

  return host;
}
