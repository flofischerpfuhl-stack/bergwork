#!/usr/bin/env node
// Drives the real editor in a headless browser: for each PDF profile, object type and state, every control the
// Inspector and the mini toolbar show is found in the DOM and worked with mouse and keyboard. After each one: no error
// toast or console error, the commit arrives, Undo restores the page pixel for pixel, within the time budget. For each
// cell: the on-page editor opens and commits, the object keeps its angle, the selection frame stays on the object, and
// the saved file reopens the same and passes qpdf.
//
//   node apps/pdf/tests/ui-matrix/run-matrix.mjs [--tier quick|full] [--profile a,b] [--type text,path] [--state normal,rotated]
//     [--extra file.pdf] [--seed N] [--minutes N] [--out dir] [--no-save]
import { execFile as execFileCallback } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { startServer } from '../../headless/server.mjs';
import { loadPlaywright } from '../../headless/host.mjs';
import { qpdfCheck } from '../lib/oracles.mjs';
import { MatrixSession, sha } from './lib/session.mjs';
import { selectFiles } from './lib/select-files.mjs';
import { OBJECT_TYPES, STATES, applicable, applyState, currentObject, findObject, openEditor, rotatePage, typeAndCommit } from './lib/objects.mjs';
import { discoverControls, operate, skipReason } from './lib/controls.mjs';
import { writeReport } from './lib/report.mjs';

const execFile = promisify(execFileCallback);
const testsDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const appDir = path.dirname(testsDir);
const argv = process.argv.slice(2);
const arg = (name, fallback = null) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : fallback; };
const flag = name => argv.includes(name);
const list = (name, fallback) => arg(name)?.split(',') || fallback;

const TIERS = {
  // First the cells that broke before, in this order, then the others in an order drawn from the seed until the minutes
  // run out. Controls in a non-normal state are sampled by the seed too, so successive merges with different seeds cover
  // all of them; the normal state always works them all.
  quick: {
    minutes: 13,
    profiles: ['word-tagged', 'chrome-skia', 'rotated-page'],
    types: OBJECT_TYPES,
    states: STATES,
    sample: 0.34,
    first: [
      'word-tagged/text/normal', 'word-tagged/image/normal', 'word-tagged/path/normal', 'word-tagged/shape/normal',
      'word-tagged/annotation/normal', 'word-tagged/text/rotated', 'word-tagged/text/wrapped', 'word-tagged/text/edited',
      'word-tagged/text/rotated-page', 'word-tagged/image/rotated', 'word-tagged/path/rotated', 'chrome-skia/text/normal',
      'rotated-page/text/normal',
    ],
  },
  full: { minutes: 600, profiles: null, types: OBJECT_TYPES, states: STATES, sample: 1, first: [] },
};

const tierName = arg('--tier', 'quick');
const tier = TIERS[tierName];
if (!tier) throw new Error(`Unknown tier ${tierName}`);
const seed = Number(arg('--seed', new Date().toISOString().slice(0, 10).replaceAll('-', '')));
const minutes = Number(arg('--minutes', tier.minutes));
// Time from input to a settled page. A commit may take a moment on a loaded machine, it may not stall.
const BUDGET_MS = Number(arg('--budget-ms', 3000));
const HARD_MS = Number(arg('--hard-ms', 20_000));
const outDir = path.resolve(arg('--out') || path.join(testsDir, '.out', `ui-matrix-${tierName}-${Date.now()}`));
await fs.mkdir(path.join(outDir, 'pdf'), { recursive: true });

const manifest = JSON.parse(await fs.readFile(path.join(testsDir, 'corpus', 'manifest.json'), 'utf8'));
const corpusRoot = path.resolve((process.env.BERGWORK_PDF_CORPUS || manifest.defaultRoot).replace(/^~(?=\/)/u, os.homedir()));
const files = selectFiles(manifest, corpusRoot, {
  profiles: list('--profile', tier.profiles || undefined),
  extra: argv.flatMap((value, index) => (value === '--extra' ? [argv[index + 1]] : [])),
});
const types = list('--type', tier.types);
const states = list('--state', tier.states);

// A small seeded generator, so a failing sample can be run again.
const random = (() => { let state = seed >>> 0 || 1; return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 2 ** 32; }; })();
const cells = [];
for (const state of states) {
  for (const file of files) {
    for (const type of types) if (applicable(type, state)) cells.push({ file, type, state });
  }
}
// Normal first, so that with little time every control has run once before the states are sampled.
for (let index = cells.length - 1; index > 0; index -= 1) {
  const other = Math.floor(random() * (index + 1));
  [cells[index], cells[other]] = [cells[other], cells[index]];
}
const cellRank = cell => {
  const named = tier.first.indexOf(`${cell.file.profile}/${cell.type}/${cell.state}`);
  return named >= 0 ? named : tier.first.length + (cell.state === 'normal' ? 0 : 1);
};
cells.sort((left, right) => cellRank(left) - cellRank(right));

const results = [];
const record = (cell, entry) => {
  const item = { profile: cell.file.profile, file: cell.file.id, type: cell.type, state: cell.state, ...entry };
  results.push(item);
  if (item.status === 'fail') console.log(`  FAIL ${cell.file.profile}/${cell.type}/${cell.state} ${item.control || item.check}: ${item.detail}`);
  return item;
};

const launch = () => loadPlaywright().chromium.launch({ headless: true });
let browser = await launch();
const distDir = process.env.BERGWORK_PDF_DIST || path.join(appDir, 'dist');
const server = await startServer({ distDir, harnessDir: path.join(testsDir, '.build'), corpusRoot, outDir: path.join(outDir, 'upload') });
const session = new MatrixSession(browser, server.url);
const startedAt = Date.now();
const deadline = startedAt + minutes * 60_000;

async function keepEvidence(cell, control, shots) {
  const name = `${cell.file.profile}-${cell.type}-${cell.state}-${control}`.replace(/[^A-Za-z0-9-]+/gu, '_').slice(0, 90);
  for (const [label, png] of Object.entries(shots)) await fs.writeFile(path.join(outDir, 'pdf', `${name}.${label}.png`), png);
}

const SURFACES = ['inspector', 'mini'];
const statusFor = ms => (ms > HARD_MS ? 'fail' : ms > BUDGET_MS ? 'slow' : 'ok');

async function prepare(cell) {
  await session.open(cell.file.path);
  if (cell.state === 'rotated-page') await rotatePage(session);
  const object = await findObject(session, cell.type);
  if (!object) return null;
  const applied = await applyState(session, object, cell.state);
  if (!applied) {
    record(cell, { check: 'state', status: cell.state === 'wrapped' ? 'n/a' : 'fail', detail: `the ${cell.state} gesture changed nothing` });
    return null;
  }
  await session.blur();
  await session.settled();
  const problems = await session.takeProblems();
  for (const problem of problems) record(cell, { check: 'state', status: 'fail', detail: `${problem.type}: ${problem.text}` });
  return object;
}

// After a turn, nothing may be drawn outside the object's own quad: the selection of a turned object once cut white
// strips through the page, and its editor covered the neighbours in its bounding box.
async function checkChromeStaysOnObject(cell, object) {
  const current = await currentObject(session, object.key);
  if (!current?.angle || !current.w) return;
  const sheet = await session.page.locator('.oo-pdf-sheet').first().boundingBox();
  const angle = current.angle * Math.PI / 180;
  const cx = current.x + current.w / 2 - sheet.x;
  const cy = current.y + current.h / 2 - sheet.y;
  // Half lengths of the turned box from its bounding box.
  const c = Math.abs(Math.cos(angle));
  const s = Math.abs(Math.sin(angle));
  const determinant = c * c - s * s;
  if (Math.abs(determinant) < 0.2) return;
  const halfW = Math.abs((current.w * c - current.h * s) / determinant) / 2 + 26;
  const halfH = Math.abs((current.h * c - current.w * s) / determinant) / 2 + 26;
  const corner = (x, y) => ({ x: cx + x * Math.cos(angle) - y * Math.sin(angle), y: cy + x * Math.sin(angle) + y * Math.cos(angle) });
  const quad = [corner(-halfW, -halfH), corner(halfW, -halfH), corner(halfW, halfH), corner(-halfW, halfH)];
  const selectedShot = await session.pageShot({ chrome: true });
  // The same sheet without the selection: a click beside the page, then the object is selected again.
  const after = await session.page.locator('.oo-pdf-sheet').first().boundingBox();
  await session.page.mouse.click(Math.max(8, after.x - 40), after.y + 200);
  await session.settled();
  const clean = await session.pageShot({ chrome: true });
  await focusObject(current.key);
  await session.settled();
  const difference = await session.diff(selectedShot, clean, { exclude: [quad], threshold: 24 });
  record(cell, {
    check: 'selection-frame',
    status: difference.count > 6 ? 'fail' : 'ok',
    detail: difference.count > 6 ? `${difference.count} pixels outside the object, ${JSON.stringify(difference.box)}` : '',
  });
}

async function checkEditor(cell, object) {
  const before = await currentObject(session, object.key);
  if (!before) return record(cell, { check: 'editor', status: 'fail', detail: 'selection lost' });
  const opened = await openEditor(session, { key: before.key });
  if (!opened) {
    return record(cell, { check: 'editor', status: 'fail', detail: `double click opened no editor (${before.text.slice(0, 30)})` });
  }
  // An editor on a turned object lies on that object.
  const editor = await session.page.evaluate(() => {
    const field = document.querySelector('.oo-pdf-viewport textarea');
    const box = field?.closest('.oo-pdf-textbox');
    const style = field && getComputedStyle(field);
    return { fontFamily: style?.fontFamily, matrix: style?.transform, outer: box ? getComputedStyle(box).boxShadow : '', cls: box?.className };
  });
  if (before.angle && Math.abs(before.angle) > 0.5) {
    if (!/matrix/.test(editor.matrix || '')) record(cell, { check: 'editor-rotation', status: 'fail', detail: 'editor is not turned with the text' });
    if (editor.outer && editor.outer !== 'none') record(cell, { check: 'editor-rotation', status: 'fail', detail: 'a frame is drawn on the bounding box' });
  }
  // A family the browser does not know falls through to the generic: the widths then follow it.
  const known = await session.page.evaluate(families => {
    const context = document.createElement('canvas').getContext('2d');
    const width = generic => { context.font = `40px ${families}, ${generic}`; return context.measureText('Bezüge Reserve mwMW').width; };
    return width('serif') === width('monospace');
  }, editor.fontFamily);
  if (!known) record(cell, { check: 'editor-font', status: 'fail', detail: `editor font ${editor.fontFamily} is not loaded` });
  const marker = ` zq${Math.floor(random() * 900 + 100)}`;
  const commit = await typeAndCommit(session, marker);
  const after = await currentObject(session, before.key);
  const problems = await session.takeProblems();
  for (const problem of problems) record(cell, { check: 'editor', status: 'fail', detail: `${problem.type}: ${problem.text}` });
  if (!commit.finished) return record(cell, { check: 'editor', status: 'fail', detail: 'commit did not finish' });
  if (!after) return record(cell, { check: 'editor', status: 'fail', detail: 'object gone after the commit' });
  if (!after.text.includes(marker.trim())) {
    return record(cell, { check: 'editor', status: 'fail', ms: commit.ms, detail: `typed text did not arrive (${after.text.slice(-30)})` });
  }
  if (Math.abs((after.angle ?? 0) - (before.angle ?? 0)) > 1) {
    return record(cell, { check: 'editor', status: 'fail', ms: commit.ms, detail: `angle changed from ${before.angle} to ${after.angle}` });
  }
  record(cell, { check: 'editor', status: statusFor(commit.ms), ms: commit.ms, detail: '' });
  return marker.trim();
}

async function checkSave(cell, marker) {
  const target = path.join(outDir, 'pdf', `${cell.file.profile}-${cell.type}-${cell.state}.pdf`);
  const before = await session.pageShot();
  await session.save(target);
  const qpdf = await qpdfCheck(target);
  if (qpdf.status === 'errors') record(cell, { check: 'save', status: 'fail', detail: `qpdf: ${qpdf.message}` });
  if (marker) {
    // -raw keeps content order: turned text does not fall apart into columns.
    const { stdout } = await execFile('pdftotext', ['-raw', target, '-'], { maxBuffer: 2 ** 26 }).catch(() => ({ stdout: null }));
    if (stdout !== null && !stdout.replace(/\s+/gu, '').includes(marker)) {
      record(cell, { check: 'save', status: 'fail', detail: `saved text has no ${marker}` });
    }
  }
  await session.open(target);
  if (cell.state === 'rotated-page') await session.settled();
  const reopened = await session.pageShot();
  const difference = await session.diff(before, reopened, { threshold: 60 });
  const share = difference.total ? difference.count / difference.total : 0;
  if (share > 0.002) await keepEvidence(cell, 'save', { before, after: reopened });
  record(cell, {
    check: 'save',
    status: share > 0.002 ? 'fail' : 'ok',
    detail: share > 0.002 ? `reopened page differs in ${(share * 100).toFixed(2)} % of the pixels ${JSON.stringify(difference.box)}` : '',
  });
  const problems = await session.takeProblems();
  for (const problem of problems) record(cell, { check: 'save', status: 'fail', detail: `${problem.type}: ${problem.text}` });
}

const focusObject = (key) => session.page.evaluate(selectionKey => {
  [...document.querySelectorAll('[data-selection-key]')].find(item => item.dataset.selectionKey === selectionKey)?.focus();
}, key);

async function runCell(cell) {
  let object = await prepare(cell);
  if (!object) return record(cell, { check: 'object', status: 'n/a', detail: 'no such object or state on this file' });
  await checkChromeStaysOnObject(cell, object);
  await session.enterSurface('inspector', object.key);
  let baseDepth = await session.historyDepth();
  let baseShot = await session.pageShot();
  const seen = new Set();
  let reselect = false;
  for (const surface of SURFACES) for (let pass = 0; object && pass < 200; pass += 1) {
    if (Date.now() > deadline) break;
    if (reselect || !pass) {
      await session.enterSurface(surface, object.key);
      reselect = false;
    }
    const control = (await discoverControls(session.page)).find(item => item.surface === surface && !seen.has(item.key));
    if (!control) break;
    seen.add(control.key);
    const reason = skipReason(control);
    if (reason) { record(cell, { control: control.key, status: 'skip', detail: reason }); continue; }
    if (control.kind === 'unknown-kind') { record(cell, { control: control.key, status: 'fail', detail: 'control of an unknown kind' }); continue; }
    if (control.disabled) { record(cell, { control: control.key, status: 'skip', detail: 'disabled' }); continue; }
    if (cell.state !== 'normal' && tier.sample < 1 && random() > tier.sample) continue;
    const started = Date.now();
    let action = null;
    try {
      action = await operate(session.page, control);
    } catch (error) {
      record(cell, { control: control.key, status: 'fail', detail: `not operable: ${String(error.message).split('\n')[0].slice(0, 160)}` });
      continue;
    }
    if (!action) continue;
    const settled = await session.settled(HARD_MS);
    const ms = Date.now() - started;
    const problems = await session.takeProblems();
    if (!settled.finished) { record(cell, { control: control.key, status: 'fail', ms, detail: 'commit did not finish' }); break; }
    if (problems.length) {
      for (const problem of problems) record(cell, { control: control.key, status: 'fail', ms, detail: `${problem.type}: ${problem.text}` });
    }
    const depth = await session.historyDepth();
    const changedHistory = depth !== baseDepth;
    let undoStatus = 'ok';
    if (changedHistory) {
      await session.undoTo(baseDepth);
      reselect = true;
      // The commit is done when the history is; the page repaints a moment later.
      let restored = await session.pageShot();
      let difference = await session.diff(baseShot, restored, { threshold: 12 });
      for (let wait = 0; difference.count && wait < 5; wait += 1) {
        await session.page.waitForTimeout(600);
        restored = await session.pageShot();
        difference = await session.diff(baseShot, restored, { threshold: 12 });
      }
      if (difference.count) {
        undoStatus = 'fail';
        record(cell, { control: control.key, check: 'undo', status: 'fail', detail: `Undo left ${difference.count} pixels different ${JSON.stringify(difference.box)}` });
        await keepEvidence(cell, control.key, { before: baseShot, after: restored });
        // One broken control must not hide the others: the rest run on a fresh copy.
        object = await prepare(cell);
        if (!object) break;
        await session.enterSurface(surface, object.key);
        baseDepth = await session.historyDepth();
        baseShot = await session.pageShot();
      } else {
        record(cell, { control: control.key, check: 'undo', status: 'ok', ms: 0, detail: '' });
      }
    } else if (control.kind === 'toggle' || control.pressed !== null) {
      // A view setting (hide, lock): the second click sets it back.
      await operate(session.page, control).catch(() => {});
      await session.settled();
      reselect = true;
    }
    record(cell, { control: control.key, status: problems.length ? 'fail' : statusFor(ms), ms, detail: `${action}${changedHistory ? '' : ', no history step'}${undoStatus === 'fail' ? ', Undo failed' : ''}` });
  }
  let marker = null;
  if (!object) return null;
  await session.undoTo(baseDepth);
  if (cell.type === 'text') {
    await focusObject(object.key);
    await session.settled();
    marker = await checkEditor(cell, object);
    if (typeof marker !== 'string') marker = null;
  }
  if (!flag('--no-save')) await checkSave(cell, marker);
  return null;
}

let dropped = 0;
for (const cell of cells) {
  if (Date.now() > deadline) { dropped += 1; continue; }
  const cellStart = Date.now();
  try {
    await runCell(cell);
  } catch (error) {
    record(cell, { check: 'cell', status: 'fail', detail: String(error.message).split('\n')[0].slice(0, 200) });
    // A crash of the page can take the browser along; the next cell starts on a new one.
    if (!browser.isConnected()) {
      browser = await launch();
      session.browser = browser;
    }
  }
  console.log(`${cell.file.profile}/${cell.type}/${cell.state}: ${((Date.now() - cellStart) / 1000).toFixed(0)} s, ${results.length} results`);
  await writeReport(outDir, { results, tier: tierName, seed, files, startedAt, budget: { dropped } });
}
await session.close();
await browser.close();
await server.close();
const summary = await writeReport(outDir, { results, tier: tierName, seed, files, startedAt, budget: { dropped } });
console.log(`ui-matrix: ${results.length} results, ${summary.failures} failures, ${summary.slow} slow, ${dropped} cells not run in ${((Date.now() - startedAt) / 60_000).toFixed(1)} min. ${summary.summary}`);
process.exitCode = summary.failures ? 1 : 0;
void sha;
