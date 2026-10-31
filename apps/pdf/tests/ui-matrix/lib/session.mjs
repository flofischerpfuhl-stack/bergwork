// One PDF open in the real page: everything the matrix does goes through mouse and keyboard, so a control that only
// works from a test hook cannot pass. The only hooks read state: data-live-commit-count and data-history-depth on the
// shell, the selection classes, and the save picker, which is replaced so that a save lands here.
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';

const VIEWPORT = { width: 1440, height: 900 };
// Hides everything that is not the page itself, for raster comparisons.
const HIDE_CHROME = `body * { visibility: hidden !important; }
  .oo-pdf-sheet, .oo-pdf-sheet canvas { visibility: visible !important; }`;
// Keeps what is drawn on the sheet, selection included, without the floating bars above it.
const HIDE_BARS = `body * { visibility: hidden !important; }
  .oo-pdf-sheet, .oo-pdf-sheet * { visibility: visible !important; }
  .oo-pdf-sheet .oo-pdf-mini-toolbar, .oo-pdf-sheet .oo-pdf-mini-toolbar * { visibility: hidden !important; }`;
// Noise of the page itself, not of the editor.
const IGNORED_CONSOLE = [/favicon/i, /Slow network is detected/i, /Failed to load resource.*\b404\b/i];

export class MatrixSession {
  constructor(browser, baseUrl) {
    this.browser = browser;
    this.baseUrl = baseUrl;
    this.events = [];
  }

  async open(file, { timeout = 90_000 } = {}) {
    await this.close();
    this.context = await this.browser.newContext({ viewport: VIEWPORT, colorScheme: 'light', locale: 'en-US' });
    const page = this.page = await this.context.newPage();
    this.events = [];
    page.on('pageerror', error => this.events.push({ type: 'pageerror', text: String(error.message).slice(0, 300) }));
    page.on('crash', () => this.events.push({ type: 'crash', text: 'page crashed' }));
    page.on('console', message => {
      if (message.type() !== 'error') return;
      const text = message.text();
      if (!IGNORED_CONSOLE.some(pattern => pattern.test(text))) this.events.push({ type: 'console', text: text.slice(0, 300) });
    });
    // Scripts a caller wants in the page before any editor code runs (the walk records every Error constructed).
    for (const script of this.initScripts || []) await page.addInitScript(script);
    await page.addInitScript(() => {
      window.__saved = null;
      window.showSaveFilePicker = async options => ({
        name: options?.suggestedName || 'out.pdf',
        kind: 'file',
        createWritable: async () => {
          const chunks = [];
          return {
            write: async data => { chunks.push(data?.data !== undefined ? data.data : data); },
            close: async () => { window.__saved = await new Blob(chunks).arrayBuffer(); },
          };
        },
      });
      // Toasts disappear by themselves; every error one is kept until the matrix has seen it.
      window.__errorToasts = [];
      new MutationObserver(records => {
        for (const record of records) for (const node of record.addedNodes) {
          if (node.nodeType !== 1) continue;
          const toast = node.matches?.('.toast-error, .toast-warning, .oo-pdf-operation-notice.is-error')
            ? node : node.querySelector?.('.toast-error, .toast-warning, .oo-pdf-operation-notice.is-error');
          const text = toast?.innerText.split('\n')[0].slice(0, 200);
          // A warning that informs is fine ("runs past the page edge"); one that stops the work is not.
          if (text && (!toast.classList.contains('toast-warning') || /paused|failed|could not/iu.test(text))) window.__errorToasts.push(text);
        }
      }).observe(document, { childList: true, subtree: true });
    });
    const started = Date.now();
    await page.goto(`${this.baseUrl}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelector('input[type=file]'), null, { timeout });
    await page.locator('input[type=file]').first().setInputFiles(file);
    await page.waitForFunction(() => {
      const button = [...document.querySelectorAll('button')].find(item => /^Edit PDF/.test(item.getAttribute('aria-label') || item.innerText || ''));
      return button && !button.disabled;
    }, null, { timeout });
    this.openMs = Date.now() - started;
    await this.editMode();
    await page.getByRole('button', { name: 'Properties' }).first().click();
    await this.settled();
    await this.propertiesTab();
    return this;
  }

  async close() {
    await this.context?.close().catch(() => {});
    this.context = null;
    this.page = null;
  }

  async editMode() {
    await this.page.getByRole('button', { name: 'Edit PDF' }).first().click();
    await this.page.waitForFunction(() => document.querySelector('[data-selection-key]'), null, { timeout: 20_000 }).catch(() => {});
  }

  async propertiesTab() {
    const tab = this.page.locator('.oo-pdf-inspector').getByRole('tab', { name: 'Properties', exact: true }).first();
    if (await tab.count()) await tab.click({ timeout: 3000 }).catch(() => {});
  }

  /** The mini toolbar shows with Properties closed, so each surface gets its own pass over the selected object. */
  async enterSurface(surface, key) {
    const open = (await this.page.locator('.oo-pdf-inspector:not(.is-headless)').count()) > 0;
    if ((surface === 'inspector') !== open) {
      await this.page.getByRole('button', { name: 'Properties' }).first().click();
      await this.settled();
    }
    if (surface === 'mini') {
      // The toolbar comes with a new selection, not with the closing of Properties.
      const sheet = await this.page.locator('.oo-pdf-sheet').first().boundingBox();
      await this.page.mouse.click(Math.max(8, sheet.x - 40), Math.max(120, sheet.y + 200));
      await this.settled();
    }
    await this.page.evaluate(selectionKey => {
      [...document.querySelectorAll('[data-selection-key]')].find(item => item.dataset.selectionKey === selectionKey)?.focus();
    }, key);
    await this.settled();
    if (surface === 'inspector') await this.propertiesTab();
  }

  /** Waits until no native commit runs and the panel is enabled again; returns the time that took. */
  async settled(limit = 30_000) {
    const started = Date.now();
    const finished = await this.page.evaluate(limitMs => new Promise(resolve => {
      const begin = performance.now();
      let quiet = 0;
      const check = () => {
        const shell = document.querySelector('.oo-pdf-shell');
        const busy = !shell || shell.dataset.liveCommitCount !== '0' || document.querySelector('.oo-pdf-load-overlay') ||
          document.querySelector('.oo-pdf-inspector[data-native-busy]');
        quiet = busy ? 0 : quiet + 1;
        if (quiet >= 6) return resolve(true);
        if (performance.now() - begin > limitMs) return resolve(false);
        setTimeout(check, 40);
      };
      check();
    }), limit).catch(() => false);
    return { ms: Math.max(0, Date.now() - started - 240), finished };
  }

  /** New errors since the last call: toasts, page errors, console errors. */
  async takeProblems() {
    const toasts = await this.page.evaluate(() => {
      const stopped = window.__fernworkLastLivePdfUiTransitionError;
      window.__fernworkLastLivePdfUiTransitionError = undefined;
      return [...window.__errorToasts.splice(0), ...(stopped ? [`editing paused: ${stopped.message}`] : [])];
    }).catch(() => []);
    const problems = [...toasts.map(text => ({ type: 'toast', text })), ...this.events.splice(0)];
    return problems;
  }

  historyDepth() {
    return this.page.evaluate(() => Number(document.querySelector('.oo-pdf-shell')?.dataset.historyDepth || 0));
  }

  async undoTo(depth) {
    // In a text field Ctrl+Z belongs to the field, so a person leaves it first. Everywhere else it undoes the document.
    await this.page.evaluate(() => {
      const active = document.activeElement;
      if (active?.matches?.('textarea, select, input:not([type=checkbox], [type=radio], [type=range], [type=color])')) active.blur();
    });
    for (let guard = 0; guard < 6; guard += 1) {
      const current = await this.historyDepth();
      if (current <= depth) return current;
      await this.page.keyboard.press('Control+z');
      await this.settled();
    }
    return this.historyDepth();
  }

  async blur() {
    await this.page.evaluate(() => document.activeElement?.blur?.());
  }

  /** The sheet of the active page as PNG, without selection, handles or toolbars. */
  async pageShot({ chrome = false } = {}) {
    const sheet = this.page.locator('.oo-pdf-sheet').first();
    const style = await this.page.addStyleTag({ content: chrome ? HIDE_BARS : HIDE_CHROME });
    // Selecting and undoing scroll to the object; a comparison needs the page where it was.
    await this.page.evaluate(() => {
      document.querySelector('.oo-pdf-sheet')?.scrollIntoView({ block: 'start', inline: 'nearest' });
      return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    const png = await sheet.screenshot({ animations: 'disabled' });
    await style.evaluate(node => node.remove());
    return png;
  }

  /** Pixels that differ between two PNGs, ignoring small colour noise and optional quads (in sheet pixels). */
  diff(left, right, { threshold = 40, exclude = [] } = {}) {
    if (left.equals(right)) return Promise.resolve({ count: 0, total: 0, box: null });
    return this.page.evaluate(async ({ a, b, threshold, exclude }) => {
      const decode = async base64 => {
        const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob();
        const bitmap = await createImageBitmap(blob);
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.drawImage(bitmap, 0, 0);
        return { width: bitmap.width, height: bitmap.height, data: context.getImageData(0, 0, bitmap.width, bitmap.height).data };
      };
      const [first, second] = await Promise.all([decode(a), decode(b)]);
      // The sheet's box lands on a fraction of a pixel: one row more or less is the screenshot, not the page.
      if (Math.abs(first.width - second.width) > 1 || Math.abs(first.height - second.height) > 1) {
        return { count: first.width * first.height, total: first.width * first.height, box: null, sizeChanged: true };
      }
      const inside = (x, y, quad) => {
        let positive = false;
        let negative = false;
        for (let index = 0; index < 4; index += 1) {
          const from = quad[index];
          const to = quad[(index + 1) % 4];
          const cross = (to.x - from.x) * (y - from.y) - (to.y - from.y) * (x - from.x);
          if (cross > 0) positive = true; else if (cross < 0) negative = true;
        }
        return !(positive && negative);
      };
      let count = 0;
      let box = null;
      const width = Math.min(first.width, second.width);
      const height = Math.min(first.height, second.height);
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const offset = (y * first.width + x) * 4;
          const other = (y * second.width + x) * 4;
          const delta = Math.abs(first.data[offset] - second.data[other]) + Math.abs(first.data[offset + 1] - second.data[other + 1]) +
            Math.abs(first.data[offset + 2] - second.data[other + 2]);
          if (delta <= threshold || exclude.some(quad => inside(x, y, quad))) continue;
          count += 1;
          box = box ? { l: Math.min(box.l, x), t: Math.min(box.t, y), r: Math.max(box.r, x), b: Math.max(box.b, y) }
            : { l: x, t: y, r: x, b: y };
        }
      }
      return { count, total: first.width * first.height, box };
    }, { a: left.toString('base64'), b: right.toString('base64'), threshold, exclude });
  }

  async save(target) {
    await this.page.evaluate(() => { window.__saved = null; });
    await this.blur();
    await this.page.getByRole('button', { name: /^Save/ }).first().click();
    await this.page.waitForFunction(() => window.__saved, null, { timeout: 90_000 });
    const base64 = await this.page.evaluate(() => {
      const bytes = new Uint8Array(window.__saved);
      let text = '';
      for (let index = 0; index < bytes.length; index += 0x8000) text += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
      return btoa(text);
    });
    await fs.writeFile(target, Buffer.from(base64, 'base64'));
    await this.settled();
    return target;
  }
}

export const sha = bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 16);
