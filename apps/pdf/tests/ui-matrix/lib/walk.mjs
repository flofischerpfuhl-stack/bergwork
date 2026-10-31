// Random walks over one open PDF: a step is one thing a person does (select an object, work a control, type, select part of
// a text, drag, turn, open the context menu, select several). Steps follow each other without Undo in between, so two
// actions meet on the same object. Nothing here knows a scenario: the next step is drawn from what the page offers right now
// (`discoverControls`), preferring ordered pairs of actions that have never run one right after the other. After each step the
// oracles that know no case run: no error toast, console or page error, the commit finishes. Every few steps and at the end:
// Undo to the start returns the starting pixels, Redo the end pixels, the model's text is in the saved file, and the saved
// file reopens as the screen shows it.
import { execFile as execFileCallback } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { qpdfCheck } from '../../lib/oracles.mjs';
import { candidates, dragSelection, findObject, openEditor, rotatePage, rotateSelection, select } from './objects.mjs';
import { discoverControls, operate, skipReason } from './controls.mjs';
import { matchMessage } from '../../lib/throw-sites.mjs';

const execFile = promisify(execFileCallback);

/** A small seeded generator (mulberry32), so a failing walk can be run again. */
export function makeRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = ['a', 'Qx', '12', ' ', 'é', 'ß', 'Ünï', '—', '"q"', '日本', '😀', '\n', 'ffi', 'W', ' ', '(', '%', '€'];
const randomText = rng => Array.from({ length: 1 + Math.floor(rng() * 4) }, () => PIECES[Math.floor(rng() * PIECES.length)]).join('');
const ARROWS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
const TYPES = ['text', 'image', 'path', 'shape', 'annotation', 'any'];

/** The name a step has in the pair table: what is done, not to which object or with which numbers. */
export function actionId(step) {
  switch (step.op) {
    case 'select': return `select:${step.type}`;
    case 'control': return `ctl:${step.key.replace(/^[a-z]+:/u, '').replace(/#\d+$/u, '')}`;
    case 'type': return `type:${step.where}${step.sel ? '+sel' : ''}${step.text ? '' : '-nothing'}${step.keep ? '+keep' : ''}`;
    case 'ctx-pick': return `ctx:${step.label}`;
    case 'check': return null;
    default: return step.op;
  }
}

/** One line a person can follow. */
export function describeStep(step) {
  switch (step.op) {
    case 'select': return `select ${step.type === 'any' ? 'an object' : `a ${step.type}`} (${step.surface}) ${step.picked || ''}`.trim();
    case 'control': return `${step.surface || step.key.split(':')[0]}: ${step.key.split(':').slice(1).join(' ')} ${step.done || ''}`.trim();
    case 'type': return `${step.where === 'page' ? 'on the page' : 'in Properties'}: ${step.sel ? `select ${step.sel.len} character(s) from ${Math.round(step.sel.from * 100)} % and ` : ''}${step.text ? `type ${JSON.stringify(step.text)}` : 'keep the selection'}${step.keep ? ', leave the editor open' : ', commit'}`;
    case 'ctx-open': return 'open the context menu on the object';
    case 'ctx-pick': return `context menu: ${step.label}`;
    case 'drag': return `drag the object by ${step.dx}, ${step.dy}`;
    case 'nudge': return `${step.shift ? 'Shift+' : ''}${step.key} on the object`;
    case 'multi': return 'Shift+click another object';
    case 'check': return `check: ${step.kind}`;
    default: return step.op;
  }
}

/** Equal problems get equal signatures: numbers, file names and quoted names do not make a new family. */
export function normalizeProblem(text) {
  return String(text)
    .replace(/^editing paused:\s*/iu, 'editing paused: ')
    .replace(/\b[\w .-]+\.(?:ttf|otf|ttc|woff2?|pdf)\b/giu, 'FILE')
    .replace(/(["'“‘]).{1,60}?\1/gu, '"…"')
    .replace(/\b[0-9a-f]{8,}\b/giu, 'ID')
    .replace(/\d+(?:\.\d+)?/gu, '#')
    .replace(/\s+/gu, ' ').trim().slice(0, 160);
}

const sameText = (typed, model) => {
  const squash = value => value.normalize('NFKC').replace(/[\s­]+/gu, '');
  return squash(model).includes(squash(typed));
};

export class Walker {
  /**
   * @param {{ session: import('./session.mjs').MatrixSession, second: import('./session.mjs').MatrixSession, outDir: string,
   *   sites: object[], workerSites: object[], pairs: Map<string, number>, actions: Map<string, number>, thrown: Map<string, number>,
   *   undoRate?: number, hardMs?: number }} options
   */
  constructor(options) {
    Object.assign(this, { undoRate: 0.25, flickerRate: 0.3, hardMs: 20_000 }, options);
    this.prev = null;
    this.timings = [];
  }

  get page() { return this.session.page; }

  async begin(file) {
    if (process.env.WALK_DEBUG) console.log(`  begin ${file.profile}`);
    this.file = file;
    this.prev = null;
    await this.harvest();
    await this.session.open(file.path);
    await this.session.blur();
    await this.session.settled();
    this.base = { depth: await this.session.historyDepth(), shot: await this.session.pageShot() };
    await this.session.takeProblems();
    this.page.setDefaultTimeout(20_000);
  }

  /** Every Error the page constructed so far (to count the throw sites reached). */
  async harvest() {
    const entries = await this.session.page?.evaluate(() => {
      const out = [...(window.__thrown || new Map())];
      window.__thrown?.clear();
      return out;
    }).catch(() => []);
    for (const [message, count] of entries || []) this.thrown.set(message, (this.thrown.get(message) || 0) + count);
  }

  dom() {
    return this.page.evaluate(() => {
      const field = document.querySelector('.oo-pdf-viewport textarea');
      return {
        selected: [...document.querySelectorAll('[data-selection-key].is-selected, [data-selection-key][aria-pressed="true"]')].map(node => node.dataset.selectionKey),
        editing: !!field && document.activeElement === field,
        menu: !!document.querySelector('.oo-pdf-context-menu'),
        depth: Number(document.querySelector('.oo-pdf-shell')?.dataset.historyDepth || 0),
      };
    });
  }

  boxOf(key) {
    return this.page.evaluate(selectionKey => {
      const node = [...document.querySelectorAll('[data-selection-key]')].find(item => item.dataset.selectionKey === selectionKey);
      const box = node?.getBoundingClientRect();
      return box ? { x: box.left, y: box.top, w: box.width, h: box.height, text: node.dataset.currentText || '' } : null;
    }, key);
  }

  // ------------------------------------------------------------------------------------------------------------ choosing

  /** Draws the next step from what the page offers now. */
  async propose(rng) {
    const dom = await this.dom();
    const options = [];
    const add = (group, step) => {
      if (['control', 'drag', 'rotate', 'nudge', 'type'].includes(step.op)) step.flicker = rng() < this.flickerRate;
      options.push({ group, step, id: actionId(step) });
    };
    if (dom.menu) {
      const labels = await this.page.evaluate(() => [...document.querySelectorAll('.oo-pdf-context-menu [role=menuitem]:not(:disabled)')]
        .map(item => item.innerText.replace(/\s+/gu, ' ').replace(/\s*Ctrl.*$/u, '').trim().slice(0, 40)).filter(Boolean));
      for (const label of labels) add('menu', { op: 'ctx-pick', label });
      add('menu', { op: 'dismiss' });
    } else {
      for (const type of TYPES) add('select', { op: 'select', type, nth: rng(), surface: rng() < 0.3 ? 'mini' : 'inspector' });
      add('rare', { op: 'page-rotate' });
      if (dom.selected.length) {
        const controls = (await discoverControls(this.page)).filter(item =>
          !skipReason(item) && !item.disabled && item.kind !== 'unknown-kind');
        for (const control of controls) {
          if (control.kind === 'textarea') continue;
          add('control', { op: 'control', key: control.key, surface: control.surface, undoCheck: rng() < this.undoRate });
        }
        const dx = Math.round((rng() - 0.5) * 160);
        const dy = Math.round((rng() - 0.5) * 120);
        add('gesture', { op: 'drag', dx, dy, undoCheck: rng() < this.undoRate });
        add('gesture', { op: 'rotate', undoCheck: rng() < this.undoRate });
        add('gesture', { op: 'nudge', key: ARROWS[Math.floor(rng() * 4)], shift: rng() < 0.4, undoCheck: rng() < this.undoRate });
        add('gesture', { op: 'ctx-open' });
        add('gesture', { op: 'multi', nth: rng() });
        if (dom.depth > 0) add('gesture', { op: 'undo-redo' });
        const onText = dom.selected[0]?.startsWith('text:');
        const selection = () => (rng() < 0.7 ? { from: Math.round(rng() * 100) / 100, len: 1 + Math.floor(rng() * 6) } : null);
        if (onText || dom.editing) {
          add('type', { op: 'type', where: 'page', text: randomText(rng), sel: selection(), keep: false, undoCheck: rng() < this.undoRate });
          add('type', { op: 'type', where: 'page', text: '', sel: { from: Math.round(rng() * 100) / 100, len: 1 + Math.floor(rng() * 6) }, keep: true });
        }
        if (controls.some(item => item.kind === 'textarea')) {
          add('type', { op: 'type', where: 'inspector', text: randomText(rng), sel: selection(), keep: false, undoCheck: rng() < this.undoRate });
        }
      }
      if (dom.editing) add('type', { op: 'commit' });
    }
    // Groups first (so the 55 controls do not drown everything else), then, inside a group, steps that never followed the last one.
    const groups = new Map();
    for (const option of options) {
      if (!groups.has(option.group)) groups.set(option.group, []);
      groups.get(option.group).push(option);
    }
    const BASE = { control: 38, type: 20, gesture: 18, select: 14, rare: 2, menu: 100 };
    const fresh = option => !(this.pairs.get(`${this.prev}→${option.id}`) > 0);
    const weights = [...groups].map(([group, list]) => [group, (BASE[group] || 5) * (1 + 3 * list.filter(fresh).length / list.length)]);
    let roll = rng() * weights.reduce((sum, [, weight]) => sum + weight, 0);
    let chosenGroup = weights[0][0];
    for (const [group, weight] of weights) { if ((roll -= weight) <= 0) { chosenGroup = group; break; } }
    const list = groups.get(chosenGroup);
    const unseen = list.filter(fresh);
    const pool = unseen.length && rng() < 0.9 ? unseen : list;
    return pool[Math.floor(rng() * pool.length)].step;
  }

  // ------------------------------------------------------------------------------------------------------------- running

  async executeAction(step) {
    const { session, page } = this;
    const dom = await this.dom();
    const keyOfSelection = dom.selected[0] || null;
    switch (step.op) {
      case 'select': {
        await page.keyboard.press('Escape');
        await session.settled();
        let object;
        if (step.type === 'shape' || step.type === 'annotation') {
          object = await findObject(session, step.type);
        } else {
          const list = (await candidates(page)).filter(item => !item.locked && (step.type === 'any' ? item.type !== 'other' : item.type === step.type) &&
            (item.type !== 'text' || item.w > 20));
          if (!list.length) return null;
          object = list[Math.min(list.length - 1, Math.floor(step.nth * list.length))];
          await select(session, object);
        }
        if (!object) return null;
        await session.enterSurface(step.surface, object.key);
        step.picked = object.key;
        return true;
      }
      case 'control': {
        const control = (await discoverControls(page)).find(item => item.key === step.key);
        if (!control || control.disabled) return null;
        step.done = await operate(page, control);
        return !!step.done;
      }
      case 'type': {
        if (!keyOfSelection || (!dom.editing && !keyOfSelection.startsWith('text:') && step.where === 'page')) return null;
        if (step.where === 'page') {
          if (!dom.editing && !(await openEditor(session, { key: keyOfSelection }))) {
            step.notOpened = true;
            return 'editor did not open';
          }
          await this.moveCaret(step);
          if (step.text) await page.keyboard.type(step.text, { delay: 6 });
          if (step.keep) { await session.settled(); return true; }
          return this.commitEditor();
        }
        const area = page.locator('.oo-pdf-inspector:not(.is-headless) textarea').first();
        if (!(await area.count())) return null;
        await area.click({ timeout: 3000 });
        await this.moveCaret(step);
        if (step.text) await page.keyboard.type(step.text, { delay: 6 });
        await area.evaluate(field => field.blur());
        return true;
      }
      case 'commit': return dom.editing ? this.commitEditor() : null;
      case 'dismiss': await page.keyboard.press('Escape'); await session.settled(); return true;
      case 'drag': return dragSelection(session, { key: keyOfSelection }, step.dx, step.dy);
      case 'rotate': return rotateSelection(session, { key: keyOfSelection });
      case 'nudge': {
        await page.evaluate(selectionKey => [...document.querySelectorAll('[data-selection-key]')].find(item => item.dataset.selectionKey === selectionKey)?.focus(), keyOfSelection);
        await page.keyboard.press(`${step.shift ? 'Shift+' : ''}${step.key}`);
        await session.settled();
        return true;
      }
      case 'ctx-open': {
        const box = await this.boxOf(keyOfSelection);
        if (!box) return null;
        await page.mouse.click(box.x + box.w / 2, box.y + box.h / 2, { button: 'right' });
        await page.waitForTimeout(120);
        return true;
      }
      case 'ctx-pick': {
        const item = page.locator('.oo-pdf-context-menu [role=menuitem]:not(:disabled)').filter({ hasText: step.label }).first();
        if (!(await item.count())) return null;
        await item.click({ timeout: 3000 });
        await session.settled();
        return true;
      }
      case 'multi': {
        const list = (await candidates(page)).filter(item => !item.locked && item.type !== 'other' && item.key !== keyOfSelection);
        if (!list.length) return null;
        const other = list[Math.min(list.length - 1, Math.floor(step.nth * list.length))];
        await page.keyboard.down('Shift');
        await page.mouse.click(other.x + other.w / 2, other.y + other.h / 2);
        await page.keyboard.up('Shift');
        await session.settled();
        step.picked = other.key;
        return true;
      }
      case 'page-rotate': await rotatePage(session); return true;
      case 'undo-redo': return this.undoRedoOnce();
      default: throw new Error(`unknown step ${step.op}`);
    }
  }

  async moveCaret(step) {
    const { page } = this;
    await page.keyboard.press('Control+Home');
    if (!step.sel) { await page.keyboard.press('Control+End'); return; }
    const length = await page.evaluate(() => document.activeElement?.value?.length || 0);
    for (let index = 0; index < Math.min(60, Math.floor(step.sel.from * length)); index += 1) await page.keyboard.press('ArrowRight');
    for (let index = 0; index < step.sel.len; index += 1) await page.keyboard.press('Shift+ArrowRight');
  }

  async commitEditor() {
    const { page, session } = this;
    await page.keyboard.press('Escape');
    await session.settled();
    // A subset font without the typed letters asks for another font; the person takes the one offered.
    const offered = page.getByRole('button', { name: /^Use / }).first();
    if (await offered.isVisible().catch(() => false)) { await offered.click(); await session.settled(); }
    return true;
  }

  async undoDown(target) {
    const { page, session } = this;
    await page.evaluate(() => {
      const active = document.activeElement;
      if (active?.matches?.('textarea, select, input:not([type=checkbox], [type=radio], [type=range], [type=color])')) active.blur();
    });
    for (let guard = 0; guard < 80; guard += 1) {
      const current = await session.historyDepth();
      if (current <= target) return current;
      await page.keyboard.press('Control+z');
      await session.settled();
    }
    return session.historyDepth();
  }

  async redoUp(target) {
    const { page, session } = this;
    for (let guard = 0; guard < 80; guard += 1) {
      const current = await session.historyDepth();
      if (current >= target) return current;
      await page.keyboard.press('Control+Shift+z');
      await session.settled();
    }
    return session.historyDepth();
  }

  /** The page after a moment's wait for the repaint; true when it matches `expected`. */
  async looksLike(expected, threshold = 12) {
    let difference = null;
    for (let wait = 0; wait < 5; wait += 1) {
      const shot = await this.session.pageShot();
      difference = await this.session.diff(expected, shot, { threshold });
      if (!difference.count) return { ok: true };
      await this.page.waitForTimeout(500);
    }
    return { ok: false, difference };
  }

  async undoRedoOnce() {
    const before = await this.session.historyDepth();
    if (!before) return null;
    const shot = await this.session.pageShot();
    await this.undoDown(before - 1);
    await this.redoUp(before);
    const same = await this.looksLike(shot);
    if (!same.ok) this.pending.push({ sig: 'undo-redo: one Undo then Redo does not return the pixels', detail: `${same.difference.count} pixels ${JSON.stringify(same.difference.box)}`, stop: true });
    return true;
  }

  // -------------------------------------------------------------------------------------------------------------- oracles

  classify(problem) {
    const text = String(problem.text);
    const internal = problem.type === 'toast' && (matchMessage(this.sites, text.replace(/^editing paused:\s*/u, '')).length > 0 ||
      matchMessage(this.workerSites, text.replace(/^editing paused:\s*/u, '')).length > 0);
    return {
      sig: `${problem.type}: ${normalizeProblem(text)}`,
      detail: text,
      stop: problem.type === 'pageerror' || problem.type === 'crash',
      internal,
    };
  }

  /** Runs one step with the per-step oracles. Returns what went wrong; `applied` is false when the page offered nothing to do. */
  async step(step) {
    this.current = step.op === 'check' ? `check ${step.kind}` : `${step.op} ${step.key || step.type || step.where || ''}`;
    if (process.env.WALK_DEBUG) console.log(`  step: ${this.current}`);
    let timer;
    const hung = new Promise(resolve => { timer = setTimeout(() => resolve({ applied: true, ms: 0, hung: true,
      failures: [{ sig: 'hang: a step did not return within two minutes', detail: this.current, stop: true }] }), 120_000); });
    try { return await Promise.race([this.stepInner(step), hung]); } finally { clearTimeout(timer); }
  }

  async stepInner(step) {
    this.pending = [];
    const started = Date.now();
    if (step.op === 'check') return { applied: true, failures: await this.checkpoint(step.kind), ms: Date.now() - started };
    const pre = step.undoCheck ? { depth: await this.session.historyDepth(), shot: await this.session.pageShot() } : null;
    let outcome;
    const caret = () => this.page.evaluate(() => {
      const field = document.querySelector('.oo-pdf-viewport textarea');
      return field ? { start: field.selectionStart, end: field.selectionEnd } : null;
    }).catch(() => null);
    // Characters are selected in the on-page editor: using a control of the bars must leave editor and selection alone.
    const marked = step.op === 'control' ? await caret() : null;
    const sampler = step.flicker ? await this.startSampling() : null;
    try {
      outcome = await this.executeAction(step);
    } catch (error) {
      await sampler?.cancel();
      const lines = String(error.message).replace(/\x1b\[\d+m/gu, '').split('\n');
      const detail = [lines[0], ...lines.filter(line => /intercepts|outside|not visible|not stable|not enabled|detached/u.test(line)).slice(-1)].join(' | ').slice(0, 300);
      return { applied: false, failures: [{ sig: `not operable: ${normalizeProblem(lines[0]).slice(0, 80)}`, detail, soft: true }], ms: Date.now() - started };
    }
    if (outcome === null || outcome === undefined || outcome === false) { await sampler?.cancel(); return { applied: false, failures: [], ms: Date.now() - started }; }
    const settled = await this.session.settled(this.hardMs);
    const failures = [...this.pending];
    if (marked && marked.end > marked.start) {
      const now = await caret();
      if (!now) failures.push({ sig: 'scope: the text editor closed when a control of the bars was used with characters selected', detail: `${step.key}: ${marked.end - marked.start} character(s) were selected`, scope: true });
      else if (now.start !== marked.start || now.end !== marked.end) failures.push({ sig: 'scope: the character selection changed when a control of the bars was used', detail: `${step.key}: ${marked.start}-${marked.end} became ${now.start}-${now.end}` });
    }
    if (sampler) {
      const flicker = await sampler.finish().catch(error => ({ error: String(error.message).slice(0, 100) }));
      if (flicker?.outside) failures.push({ sig: 'scope: pixels away from the selected object changed', detail: flicker.outside });
      if (flicker?.bad) failures.push({ sig: 'flicker: a frame showed the old state again before the commit was drawn', detail: flicker.bad });
    }
    if (outcome === 'editor did not open') failures.push({ sig: 'editor: a double click opened no editor', detail: `on ${step.where}`, soft: true });
    if (!settled.finished) failures.push({ sig: 'commit did not finish', detail: `no end within ${this.hardMs} ms`, stop: true });
    for (const problem of await this.session.takeProblems()) failures.push(this.classify(problem));
    await this.harvest();
    if (step.op === 'type' && step.text && !step.keep && step.where === 'page' && outcome === true) {
      const selected = (await this.dom()).selected[0];
      const model = selected ? (await this.boxOf(selected))?.text : null;
      if (model != null && !sameText(step.text.replace(/\n/gu, ''), model)) {
        failures.push({ sig: 'type: the typed text is not in the object afterwards', detail: `typed ${JSON.stringify(step.text)}, object has ${JSON.stringify(model.slice(-60))}`, soft: true });
      }
    }
    if (pre && !failures.some(item => item.stop)) {
      const after = await this.session.historyDepth();
      if (after > pre.depth) failures.push(...await this.undoRedoCheck(pre, after));
    }
    return { applied: true, failures, ms: Date.now() - started };
  }

  /**
   * Samples the screen frame by frame (CDP screencast) while a gesture runs and checks the box of the touched object: once a
   * frame shows the finished state, no later frame may show the old one again, a gap or a double. Needs no knowledge of the gesture.
   */
  async startSampling() {
    const { page } = this;
    const key = (await this.dom()).selected[0];
    if (!key) return null;
    const hide = await page.addStyleTag({ content: '.oo-pdf-mini-toolbar { visibility: hidden !important; }' });
    const before = await page.screenshot({ animations: 'disabled' });
    const boxBefore = await this.boxOf(key);
    if (!boxBefore) { await hide.evaluate(node => node.remove()); return null; }
    const cdp = await this.session.context.newCDPSession(page);
    const frames = [];
    cdp.on('Page.screencastFrame', event => {
      frames.push(event.data);
      cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
    const stop = async () => {
      await cdp.send('Page.stopScreencast').catch(() => {});
      await cdp.detach().catch(() => {});
      await hide.evaluate(node => node.remove()).catch(() => {});
    };
    return {
      cancel: stop,
      finish: async () => {
        await this.session.settled(this.hardMs);
        await page.waitForTimeout(250);
        const after = await page.screenshot({ animations: 'disabled' });
        await stop();
        const boxAfter = await this.boxOf(key) || boxBefore;
        const left = Math.min(boxBefore.x, boxAfter.x) + 4;
        const top = Math.min(boxBefore.y, boxAfter.y) + 4;
        const right = Math.max(boxBefore.x + boxBefore.w, boxAfter.x + boxAfter.w) - 4;
        const bottom = Math.max(boxBefore.y + boxBefore.h, boxAfter.y + boxAfter.h) - 4;
        if (right - left < 6 || bottom - top < 6 || frames.length < 3) return { frames: frames.length };
        const outside = /duplicate|delete|forward|backward|arrange/iu.test(step.key || '') ? null : await this.outsideChange(before, after, { left, top, right, bottom });
        const verdict = await page.evaluate(analyseFrames, { before: before.toString('base64'), after: after.toString('base64'), frames, box: { left, top, right, bottom } });
        if (verdict.bad) {
          const dir = path.join(this.outDir, 'flicker');
          await fs.mkdir(dir, { recursive: true });
          const name = `${this.file.profile}-${Date.now()}`;
          await fs.writeFile(path.join(dir, `${name}.before.png`), before);
          await fs.writeFile(path.join(dir, `${name}.after.png`), after);
          await fs.writeFile(path.join(dir, `${name}.frame.png`), Buffer.from(frames[verdict.frame], 'base64'));
        }
        return { ...verdict, outside };
      },
    };
  }

  /** Pixels of the sheet away from the touched object (30 px margin for its handles and growth) must stay as they were. */
  async outsideChange(before, after, box) {
    const sheet = await this.page.evaluate(() => { const rect = document.querySelector('.oo-pdf-sheet')?.getBoundingClientRect(); return rect && { l: rect.left, t: rect.top, r: rect.right, b: rect.bottom }; });
    if (!sheet) return null;
    const result = await this.page.evaluate(async ({ a, b, sheet, hole }) => {
      const decode = async base64 => {
        const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.drawImage(bitmap, 0, 0);
        return context.getImageData(0, 0, bitmap.width, bitmap.height).data;
      };
      const [first, second] = [await decode(a), await decode(b)];
      const width = Math.round(Math.min(window.innerWidth, 1440));
      let count = 0; let total = 0; let box = null;
      for (let y = Math.max(0, Math.round(sheet.t)); y < Math.min(900, Math.round(sheet.b)); y += 1) {
        for (let x = Math.max(0, Math.round(sheet.l)); x < Math.min(width - 380, Math.round(sheet.r)); x += 1) {
          if (x >= hole.l && x <= hole.r && y >= hole.t && y <= hole.b) continue;
          total += 1;
          const index = (y * 1440 + x) * 4;
          if (Math.abs(first[index] - second[index]) + Math.abs(first[index + 1] - second[index + 1]) + Math.abs(first[index + 2] - second[index + 2]) > 60) {
            count += 1;
            box = box ? { l: Math.min(box.l, x), t: Math.min(box.t, y), r: Math.max(box.r, x), b: Math.max(box.b, y) } : { l: x, t: y, r: x, b: y };
          }
        }
      }
      return { count, total, box };
    }, { a: before.toString('base64'), b: after.toString('base64'), sheet, hole: { l: box.left - 34, t: box.top - 34, r: box.right + 34, b: box.bottom + 34 } });
    return result.count > 40 ? `${result.count} pixels changed outside the object ${JSON.stringify(result.box)}` : null;
  }

  /** Undo of this one step returns the pixels from before it, Redo those from after it. */
  async undoRedoCheck(pre, after) {
    const post = await this.session.pageShot();
    await this.undoDown(pre.depth);
    const undone = await this.looksLike(pre.shot);
    await this.redoUp(after);
    const redone = await this.looksLike(post);
    const failures = [];
    if (!undone.ok) failures.push({ sig: 'undo: one Undo does not return the pixels from before the step', detail: `${undone.difference.count} pixels ${JSON.stringify(undone.difference.box)}`, stop: true });
    if (!redone.ok) failures.push({ sig: 'redo: Redo does not return the pixels from after the step', detail: `${redone.difference.count} pixels ${JSON.stringify(redone.difference.box)}`, stop: true });
    for (const problem of await this.session.takeProblems()) failures.push(this.classify(problem));
    return failures;
  }

  async checkpoint(kind) {
    const failures = [];
    const { session } = this;
    await session.blur();
    await session.settled();
    if (kind === 'undo-start') {
      const end = { depth: await session.historyDepth(), shot: await session.pageShot() };
      if (end.depth > this.base.depth) {
        await this.undoDown(this.base.depth);
        const start = await this.looksLike(this.base.shot);
        if (!start.ok) failures.push({ sig: 'undo-start: Undo to the start does not return the starting pixels', detail: `${start.difference.count} pixels ${JSON.stringify(start.difference.box)}`, stop: true });
        const reached = await this.redoUp(end.depth);
        const redone = await this.looksLike(end.shot);
        if (reached < end.depth) failures.push({ sig: 'redo-end: Redo stops before the end of the history', detail: `${reached} of ${end.depth}`, stop: true });
        else if (!redone.ok) failures.push({ sig: 'redo-end: Redo to the end does not return the end pixels', detail: `${redone.difference.count} pixels ${JSON.stringify(redone.difference.box)}`, stop: true });
      }
    } else if (kind === 'save') {
      failures.push(...await this.saveAndReopen());
    }
    for (const problem of await session.takeProblems()) failures.push(this.classify(problem));
    await this.harvest();
    return failures;
  }

  async saveAndReopen() {
    const { session, second } = this;
    const failures = [];
    const models = await this.page.evaluate(() => [...document.querySelectorAll('[data-selection-key^="text:"]')]
      .map(node => node.dataset.currentText || '').filter(text => text.trim().length >= 3));
    const screen = await session.pageShot();
    const target = path.join(this.outDir, 'saved', `${this.file.profile}-${Date.now()}.pdf`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await session.save(target);
    const qpdf = await qpdfCheck(target);
    if (qpdf.status === 'errors') failures.push({ sig: 'save: qpdf finds errors in the saved file', detail: String(qpdf.message).slice(0, 200) });
    const { stdout } = await execFile('pdftotext', ['-raw', target, '-'], { maxBuffer: 2 ** 26 }).catch(() => ({ stdout: null }));
    if (stdout !== null) {
      const missing = models.filter(text => !sameText(text, stdout));
      if (missing.length) failures.push({ sig: 'save: text the editor shows is not in the saved file', detail: `${missing.length} of ${models.length}, e.g. ${JSON.stringify(missing[0].slice(0, 70))}`, soft: true });
    }
    await second.open(target);
    const reopened = await second.pageShot();
    const difference = await second.diff(screen, reopened, { threshold: 60 });
    const share = difference.total ? difference.count / difference.total : 0;
    if (share > 0.002) failures.push({ sig: 'save: the reopened file does not look like the screen', detail: `${(share * 100).toFixed(2)} % of the pixels ${JSON.stringify(difference.box)}` });
    for (const problem of await second.takeProblems()) failures.push({ ...this.classify(problem), sig: `reopen ${this.classify(problem).sig}` });
    await second.close();
    await fs.rm(target, { force: true });
    return failures;
  }

  /** Registers a finished step in the pair table. */
  note(step) {
    const id = actionId(step);
    if (!id) return;
    this.actions.set(id, (this.actions.get(id) || 0) + 1);
    if (this.prev) this.pairs.set(`${this.prev}→${id}`, (this.pairs.get(`${this.prev}→${id}`) || 0) + 1);
    this.prev = id;
  }
}

/** Runs in the page. Fractions of box pixels that differ by more than a small colour distance. */
async function analyseFrames({ before, after, frames, box }) {
  const decode = async base64 => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
    const width = Math.round(box.right - box.left);
    const height = Math.round(box.bottom - box.top);
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(bitmap, Math.round(box.left), Math.round(box.top), width, height, 0, 0, width, height);
    return context.getImageData(0, 0, width, height).data;
  };
  const share = (first, second) => {
    let count = 0;
    for (let index = 0; index < first.length; index += 8) {
      if (Math.abs(first[index] - second[index]) + Math.abs(first[index + 1] - second[index + 1]) + Math.abs(first[index + 2] - second[index + 2]) > 60) count += 1;
    }
    return count / (first.length / 8);
  };
  const [old, fresh] = [await decode(before), await decode(after)];
  const change = share(old, fresh);
  if (change < 0.01) return { change, bad: null };
  let reached = -1;
  for (let index = 0; index < frames.length; index += 1) {
    const data = await decode(frames[index]);
    const toAfter = share(data, fresh);
    if (reached < 0) { if (toAfter <= 0.25 * change) reached = index; continue; }
    if (toAfter > 0.5 * change) {
      const toBefore = share(data, old);
      return { change, frames: frames.length, frame: index, reached,
        bad: `frame ${index + 1} of ${frames.length} left the finished state (frame ${reached + 1} had reached it): ${(toAfter / change * 100).toFixed(0)} % of the change away from the end, ${(toBefore / change * 100).toFixed(0)} % away from the start` };
    }
  }
  return { change, frames: frames.length, reached, bad: null };
}
