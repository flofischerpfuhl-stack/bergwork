/**
 * Fernwork — debug event log
 *
 * Always-on in-memory ring buffer of recent app events. Debug mode
 * (`?debug=1`, remembered in localStorage, `?debug=0` turns it off) also
 * mirrors entries to the console and enables the report capture hotkey.
 *
 * Entries hold names, codes, IDs and geometry only — never document text or
 * file bytes — so a captured report can be shared without leaking content.
 */

const STATE_KEY = '__fernworkDebugLog';
const DEBUG_STORAGE_KEY = 'fernwork.debug';
const SESSION_STORAGE_KEY = 'fernwork.debug.session';
const CARRY_STORAGE_KEY = 'fernwork.debug.carry';
const CARRY_WINDOW_MS = 120_000;
const CARRY_MAX_ENTRIES = 500;
const MAX_ENTRIES = 1000;
const MAX_STRING = 300;
const MAX_ARRAY = 20;
const MAX_DEPTH = 6;
const LEVELS = ['debug', 'info', 'warn', 'error'];

function pad(value) {
  return String(value).padStart(2, '0');
}

function newSessionId() {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
}

function readDebugFlag() {
  if (typeof window === 'undefined') return false;
  try {
    const param = new URLSearchParams(window.location.search).get('debug');
    if (param === '1' || param === 'true') localStorage.setItem(DEBUG_STORAGE_KEY, '1');
    else if (param === '0' || param === 'false') localStorage.removeItem(DEBUG_STORAGE_KEY);
    return localStorage.getItem(DEBUG_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function readSessionId() {
  // A test session survives reloads in the same tab so one capture folder
  // collects every report of that sitting.
  try {
    const existing = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (existing) return existing;
    const created = newSessionId();
    sessionStorage.setItem(SESSION_STORAGE_KEY, created);
    return created;
  } catch {
    return newSessionId();
  }
}

// Bundled and directly imported copies of this module must share one buffer.
function state() {
  const existing = globalThis[STATE_KEY];
  if (existing) return existing;
  const created = {
    entries: [],
    seq: 0,
    debug: readDebugFlag(),
    sessionId: readSessionId(),
    startedAt: Date.now(),
    snapshotProviders: new Map(),
    hooksInstalled: false,
    // Entry point for modules that must stay import-free (assets/toast.js).
    write: (level, event, data) => write(LEVELS.includes(level) ? level : 'info', event, data),
    // Lets automation (test/e2e/corpus-objects.spec.ts) read the same state a report captures.
    snapshot: () => debugSnapshot(),
  };
  globalThis[STATE_KEY] = created;
  if (created.debug) restoreCarriedEntries(created);
  installGlobalHooks(created);
  return created;
}

// Debug mode keeps the recent log across reloads in the same tab, so reports
// about reload loops or crashes still show what happened before the reload.
function restoreCarriedEntries(s) {
  try {
    const carried = JSON.parse(sessionStorage.getItem(CARRY_STORAGE_KEY) || '[]');
    sessionStorage.removeItem(CARRY_STORAGE_KEY);
    const cutoff = Date.now() - CARRY_WINDOW_MS;
    const recent = Array.isArray(carried) ? carried.filter(entry => entry?.t >= cutoff) : [];
    if (!recent.length) return;
    s.entries.push(...recent);
    s.seq = Math.max(...recent.map(entry => Number(entry.seq) || 0));
    s.pendingReloadMarker = recent.length;
  } catch {
    // Unreadable carry-over; start with an empty log.
  }
}

function carryEntries(s) {
  if (!s.debug) return;
  try {
    const cutoff = Date.now() - CARRY_WINDOW_MS;
    const recent = s.entries.filter(entry => entry.t >= cutoff).slice(-CARRY_MAX_ENTRIES);
    sessionStorage.setItem(CARRY_STORAGE_KEY, JSON.stringify(recent));
  } catch {
    // Storage full or unavailable; the next page starts with an empty log.
  }
}

function compact(value, depth = 0) {
  if (value == null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : String(value);
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (value instanceof Error) {
    return compact({ name: value.name, message: value.message, code: value.code, details: value.details }, depth);
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return `[${value.byteLength} bytes]`;
  if (depth >= MAX_DEPTH) return '[…]';
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY).map(item => compact(item, depth + 1));
    if (value.length > MAX_ARRAY) items.push(`… ${value.length - MAX_ARRAY} more`);
    return items;
  }
  if (value instanceof Map) return compact(Object.fromEntries(value), depth);
  if (value instanceof Set) return compact([...value], depth);
  if (typeof Element !== 'undefined' && value instanceof Element) return `<${value.tagName.toLowerCase()}>`;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    const next = compact(item, depth + 1);
    if (next !== undefined) out[key] = next;
  }
  return out;
}

// Keys whose values may carry document content (text, form values, metadata,
// embedded bytes); summaries keep only their size.
const CONTENT_KEY = /text|content|string|glyph|char|runs|html|title|author|subject|comment|value|bytes|dataurl|image|stream/i;

/**
 * Geometry/style summary of an edit payload or object model: numbers,
 * booleans, short identifiers and numeric arrays. Content-like keys and long
 * strings are replaced by their size.
 */
export function summarizePayload(value, depth = 0) {
  if (value == null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : String(value);
  if (typeof value === 'string') return value.length <= 40 ? value : `[${value.length} chars]`;
  if (typeof value !== 'object') return undefined;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return `[${value.byteLength} bytes]`;
  if (Array.isArray(value)) {
    if (value.every(item => typeof item === 'number')) {
      return value.length <= 12 ? value.map(item => summarizePayload(item)) : `[${value.length} numbers]`;
    }
    if (depth >= 2) return `[${value.length} items]`;
    const items = value.slice(0, 5).map(item => summarizePayload(item, depth + 1));
    if (value.length > 5) items.push(`… ${value.length - 5} more`);
    return items;
  }
  if (depth >= 3) return '[…]';
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (CONTENT_KEY.test(key)) {
      out[key] = typeof item === 'string' ? `[${item.length} chars]` : item == null ? item : '[omitted]';
      continue;
    }
    const next = summarizePayload(item, depth + 1);
    if (next !== undefined) out[key] = next;
  }
  return out;
}

function write(level, event, data) {
  const s = state();
  const entry = {
    seq: ++s.seq,
    t: Date.now(),
    level,
    event: String(event),
  };
  if (data !== undefined) entry.data = compact(data);
  s.entries.push(entry);
  if (s.entries.length > MAX_ENTRIES) s.entries.splice(0, s.entries.length - MAX_ENTRIES);
  if (s.debug && typeof console !== 'undefined') {
    const method = level === 'debug' ? 'debug' : level;
    console[method](`[fernwork] ${entry.event}`, entry.data ?? '');
  }
  return entry;
}

export const log = Object.freeze(Object.fromEntries(
  LEVELS.map(level => [level, (event, data) => write(level, event, data)]),
));

export function isDebugMode() {
  return state().debug;
}

export function debugSessionId() {
  return state().sessionId;
}

/** Entries newer than `sinceMs` milliseconds ago (all entries when omitted). */
export function recentEvents(sinceMs) {
  const entries = state().entries;
  if (!Number.isFinite(sinceMs)) return entries.slice();
  const cutoff = Date.now() - sinceMs;
  return entries.filter(entry => entry.t >= cutoff);
}

/**
 * Registers a function contributing a section to `debugSnapshot()`.
 * Returns an unregister function.
 */
export function registerDebugSnapshot(name, provider) {
  const providers = state().snapshotProviders;
  providers.set(name, provider);
  return () => {
    if (providers.get(name) === provider) providers.delete(name);
  };
}

export function debugSnapshot() {
  const s = state();
  const snapshot = {
    at: new Date().toISOString(),
    sessionId: s.sessionId,
    url: typeof location !== 'undefined' ? `${location.pathname}${location.search}` : '',
    browser: typeof navigator !== 'undefined' ? String(navigator.userAgent || '') : '',
    viewport: typeof window !== 'undefined'
      ? { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio }
      : null,
  };
  for (const [name, provider] of s.snapshotProviders) {
    try {
      snapshot[name] = compact(provider());
    } catch (error) {
      snapshot[name] = { snapshotError: String(error?.message || error) };
    }
  }
  return snapshot;
}

const CLICK_TARGETS = 'button, [role="button"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="tab"], [role="option"], a[href], summary';
const PAGE_CONTENT = '.oo-pdf-sheet';

function shortText(value, max = 60) {
  const text = String(value || '').replace(/\s+/gu, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function controlLabel(node) {
  // Page overlays can be labelled with document text; name them by class.
  if (node.closest(PAGE_CONTENT)) {
    return `[page ${String(node.className || node.tagName).split(/\s+/u).filter(Boolean).slice(0, 2).join('.')}]`;
  }
  return shortText(node.getAttribute('aria-label') || node.getAttribute('title') || node.textContent ||
    node.getAttribute('name') || node.tagName.toLowerCase());
}

function fieldLabel(field) {
  return shortText(field.getAttribute('aria-label') || field.labels?.[0]?.textContent ||
    field.getAttribute('placeholder') || field.getAttribute('name') || field.tagName.toLowerCase(), 40);
}

function isEditable(node) {
  return node instanceof Element && (node.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/u.test(node.tagName));
}

function inDebugUi(node) {
  return node instanceof Element && Boolean(node.closest('[data-debug-report-dialog], [data-debug-badge]'));
}

const LOGGED_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Delete', 'Backspace', 'Escape', 'Enter', 'Tab']);

function installInteractionHooks() {
  if (typeof document === 'undefined' || !document.addEventListener) return;
  document.addEventListener('click', event => {
    const node = event.target instanceof Element ? event.target.closest(CLICK_TARGETS) : null;
    if (!node || inDebugUi(node)) return;
    const pressed = node.closest(PAGE_CONTENT)
      ? null
      : node.getAttribute('aria-pressed') ?? node.getAttribute('aria-checked') ?? node.getAttribute('aria-selected');
    write('info', 'ui.click', { label: controlLabel(node), ...(pressed != null ? { wasPressed: pressed } : {}) });
  }, true);
  document.addEventListener('change', event => {
    const field = event.target;
    if (!(field instanceof HTMLInputElement || field instanceof HTMLSelectElement || field instanceof HTMLTextAreaElement)) return;
    if (inDebugUi(field) || field.closest(PAGE_CONTENT)) return;
    const data = { label: fieldLabel(field) };
    if (field instanceof HTMLSelectElement) data.value = shortText(field.selectedOptions[0]?.textContent || field.value, 40);
    else if (field.type === 'checkbox' || field.type === 'radio') data.checked = field.checked;
    else if (['number', 'range', 'color'].includes(field.type)) data.value = field.value;
    else data.length = field.value.length;
    write('info', 'ui.input', data);
  }, true);
  document.addEventListener('keydown', event => {
    if (event.repeat || isEditable(event.target) || inDebugUi(event.target)) return;
    const modified = event.metaKey || event.ctrlKey || event.altKey;
    if (!modified && !LOGGED_KEYS.has(event.key)) return;
    if (['Meta', 'Control', 'Alt', 'Shift'].includes(event.key)) return;
    const combo = [event.ctrlKey && 'Ctrl', event.metaKey && 'Cmd', event.altKey && 'Alt', event.shiftKey && 'Shift', event.key]
      .filter(Boolean).join('+');
    write('info', 'ui.key', { key: combo });
  }, true);
}

function installGlobalHooks(s) {
  if (s.hooksInstalled || typeof window === 'undefined' || !window.addEventListener) return;
  s.hooksInstalled = true;
  installInteractionHooks();
  window.addEventListener('pagehide', () => carryEntries(s));
  if (s.pendingReloadMarker) {
    write('info', 'debug.page-loaded', { restoredEntries: s.pendingReloadMarker });
    delete s.pendingReloadMarker;
  }
  window.addEventListener('error', event => {
    write('error', 'window.error', {
      message: event.message,
      source: event.filename ? String(event.filename).split('/').pop() : '',
      line: event.lineno,
      column: event.colno,
      stack: event.error?.stack ? String(event.error.stack).split('\n').slice(0, 6).join('\n') : undefined,
    });
  });
  window.addEventListener('unhandledrejection', event => {
    const reason = event.reason;
    write('error', 'window.unhandledrejection', {
      message: String(reason?.message || reason),
      code: reason?.code,
      stack: reason?.stack ? String(reason.stack).split('\n').slice(0, 6).join('\n') : undefined,
    });
  });
}

state();
