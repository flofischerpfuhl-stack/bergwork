/**
 * The Tauri window around the page, or null in a browser. The title bar is drawn by the page (the window has no
 * system decorations): dragging, double-click maximise, the window buttons and, on Linux, rounded corners drawn in
 * the transparent window (square when maximised).
 */
interface TauriWindow {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  startDragging(): Promise<void>;
  isMaximized(): Promise<boolean>;
  onResized(handler: () => void): Promise<() => void>;
  setTitle(title: string): Promise<void>;
}

interface TauriGlobal {
  window?: { getCurrentWindow?: () => TauriWindow };
  app?: { getVersion?: () => Promise<string> };
}

const tauri = (globalThis as { __TAURI__?: TauriGlobal }).__TAURI__;

export const desktopWindow: TauriWindow | null = (() => {
  try { return tauri?.window?.getCurrentWindow?.() ?? null; } catch { return null; }
})();

/** Runs a window call and logs (instead of throwing) a rejection such as a missing permission. */
export function windowCall(method: 'minimize' | 'toggleMaximize' | 'close' | 'startDragging'): void {
  if (!desktopWindow) return;
  Promise.resolve().then(() => desktopWindow[method]()).catch((error) => console.warn(`[bergwork] window.${method} failed`, error));
}

export function setWindowTitle(title: string): void {
  document.title = title;
  if (desktopWindow) desktopWindow.setTitle(title).catch(() => {});
}

export function appVersion(): Promise<string | undefined> {
  return Promise.resolve().then(() => tauri?.app?.getVersion?.()).catch(() => undefined);
}

/** Drag and double-click maximise on the title bar's empty parts; the maximised state and rounded corners. */
export function wireDesktopWindow(titleBar: HTMLElement): () => void {
  if (!desktopWindow) return () => {};
  const html = document.documentElement;
  if (/Linux/.test(navigator.userAgent)) html.classList.add('bw-rounded-window');
  const refresh = () => {
    desktopWindow.isMaximized().then((maximized) => html.classList.toggle('bw-window-maximized', maximized), () => {});
  };
  refresh();
  let stopResize: (() => void) | undefined;
  desktopWindow.onResized(refresh).then((stop) => { stopResize = stop; }, () => {});
  // Once a native drag starts the window manager owns the pointer and no dblclick arrives, so the second press of a
  // double-click is recognised on mousedown (as Tauri's own drag regions do).
  const onDown = (event: MouseEvent) => {
    if (event.button !== 0 || (event.target as Element).closest('button, [role="menu"]')) return;
    windowCall(event.detail === 2 ? 'toggleMaximize' : 'startDragging');
  };
  titleBar.addEventListener('mousedown', onDown);
  return () => { titleBar.removeEventListener('mousedown', onDown); stopResize?.(); };
}
