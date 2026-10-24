/**
 * Fernwork — Toast Notification System
 */

let container = null;

function ensureContainer() {
  if (container?.isConnected) return container;
  // PDF Tools bundles this module, while shared file/drop/clipboard helpers
  // also import it directly. Both module instances must use the same DOM
  // stack, otherwise their fixed containers draw notifications over each other.
  const existing = document.getElementById('toast-container');
  if (existing) {
    container = existing;
    return container;
  }
  container = document.createElement('div');
  container.className = 'toast-container';
  container.id = 'toast-container';
  document.body.appendChild(container);
  // Narrow workspaces reserve room for the visible notification stack so
  // messages do not cover the property field that produced them.
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(() => {
      document.body.style.setProperty('--toast-stack-height', `${container.getBoundingClientRect().height}px`);
    });
    observer.observe(container);
  }
  return container;
}

const ICONS = {
  success: `<svg class="toast-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
  error: `<svg class="toast-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
  info: `<svg class="toast-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
  warning: `<svg class="toast-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`
};

/**
 * Show a toast notification
 * @param {string} message - Text to display
 * @param {'success'|'error'|'info'|'warning'} type - Toast type
 * @param {number} [duration=3000] - Auto-dismiss duration in ms; 0 keeps the
 *   toast until the user dismisses it (failures that must not vanish unread)
 * @param {{action?: {label: string, onClick: () => void}}} [options]
 */
export function showToast(message, type = 'info', duration = 3000, options = {}) {
  const c = ensureContainer();
  const textMessage = String(message);
  const persistent = duration === 0;
  // Kept import-free (see debug-log.js): logs only once that module is loaded.
  const logLevel = type === 'error' ? 'error' : type === 'warning' ? 'warn' : 'info';
  globalThis.__fernworkDebugLog?.write?.(logLevel, 'toast', { type, message: textMessage, persistent });
  // Rapid repeated saves/exports should not cover the workspace with the same
  // success card. Keep distinct messages and every warning/error independent.
  // A repeated persistent failure also counts up instead of stacking cards.
  // State belongs to the DOM node so bundled and direct-import callers agree.
  if (type === 'success' || type === 'info' || persistent) {
    const existing = [...c.children].find(node => !node.classList.contains('removing') &&
      node.__fernworkToast?.type === type && node.__fernworkToast?.message === textMessage &&
      Boolean(node.__fernworkToast?.persistent) === persistent);
    if (existing) {
      const state = existing.__fernworkToast;
      clearTimeout(state.timer);
      state.count += 1;
      if (!state.badge) {
        state.badge = document.createElement('small');
        state.badge.className = 'toast-repeat-count';
        existing.appendChild(state.badge);
      }
      state.badge.textContent = `×${state.count}`;
      state.badge.setAttribute('aria-label', `${state.count} notifications`);
      if (!persistent) state.timer = setTimeout(() => removeToast(existing), duration);
      return;
    }
  }

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
  toast.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
  toast.setAttribute('aria-atomic', 'true');
  toast.innerHTML = persistent ? '' : ICONS[type] || ICONS.info;
  const text = document.createElement('span');
  text.textContent = textMessage;
  toast.appendChild(text);

  if (options.action?.label && typeof options.action.onClick === 'function') {
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'toast-action';
    action.textContent = options.action.label;
    action.addEventListener('click', event => {
      event.stopPropagation();
      options.action.onClick();
      removeToast(toast);
    });
    toast.appendChild(action);
  }

  if (persistent) {
    // Toasts do not take pointer events; only this button does.
    toast.classList.add('toast-persistent');
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast-close';
    close.setAttribute('aria-label', 'Dismiss notification');
    close.textContent = '×';
    close.addEventListener('click', () => removeToast(toast));
    toast.appendChild(close);
  }

  c.appendChild(toast);

  // Auto-dismiss
  const state = { message: textMessage, type, count: 1, badge: null, persistent,
    timer: persistent ? 0 : setTimeout(() => removeToast(toast), duration) };
  toast.__fernworkToast = state;

  // Click to dismiss early
  toast.addEventListener('click', () => {
    clearTimeout(state.timer);
    removeToast(toast);
  });
}

function removeToast(toast) {
  if (toast.classList.contains('removing')) return;
  toast.classList.add('removing');
  // Reduced motion, route changes or cancelled CSS animations need not emit
  // animationend. Never leave an expired notice permanently covering the UI.
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(fallback);
    toast.removeEventListener('animationend', onAnimationEnd);
    toast.removeEventListener('animationcancel', onAnimationEnd);
    toast.remove();
  };
  const onAnimationEnd = event => { if (event.target === toast) finish(); };
  const fallback = setTimeout(finish, 500);
  toast.addEventListener('animationend', onAnimationEnd);
  toast.addEventListener('animationcancel', onAnimationEnd);
}
