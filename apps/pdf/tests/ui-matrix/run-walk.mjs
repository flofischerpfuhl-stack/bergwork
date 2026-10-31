#!/usr/bin/env node
// Random walks over real PDFs in the real editor, looking for failures instead of testing cases (see lib/walk.mjs).
//
//   node apps/pdf/tests/ui-matrix/run-walk.mjs [--seed N] [--minutes N] [--walks N] [--length N] [--check-every N]
//     [--profile a,b] [--extra file.pdf] [--no-default-extra] [--undo-rate 0.25] [--shrink-replays 40] [--no-shrink] [--out dir]
//   node apps/pdf/tests/ui-matrix/run-walk.mjs --replay found/<family>.json     replays a shrunk walk (exit 1 when it still fails)
//
// A failing walk is reduced by itself to the shortest sequence of steps that still shows the same failure and written as
// found/<n>-<family>.json (readable steps, the seed, the file) so that it can be replayed and, once the editor is fixed,
// run again as the check that the family is gone.
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../headless/server.mjs';
import { launchBrowser, loadPlaywright } from '../../headless/host.mjs';
import { MatrixSession } from './lib/session.mjs';
import { selectFiles } from './lib/select-files.mjs';
import { checkReachability, openEnginePage, reachLines } from './lib/reach.mjs';
import { Walker, actionId, describeStep, makeRng } from './lib/walk.mjs';
import { ERROR_RECORDER, extractThrowSites, mergeThrown, throwCoverage, throwCoverageLines } from '../lib/throw-sites.mjs';

const testsDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const appDir = path.dirname(testsDir);
const argv = process.argv.slice(2);
const arg = (name, fallback = null) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : fallback; };
const flag = name => argv.includes(name);

const seed = Number(arg('--seed', Date.now() % 1_000_000));
const minutes = Number(arg('--minutes', 10));
const maxWalks = Number(arg('--walks', 1e9));
const length = Number(arg('--length', 24));
const checkEvery = Number(arg('--check-every', 8));
const undoRate = Number(arg('--undo-rate', 0.25));
const flickerRate = Number(arg('--flicker-rate', 0.3));
const shrinkReplays = Number(arg('--shrink-replays', 40));
const outDir = path.resolve(arg('--out') || path.join(testsDir, '.out', `walk-${seed}-${Date.now()}`));
await fs.mkdir(path.join(outDir, 'found'), { recursive: true });

const manifest = JSON.parse(await fs.readFile(path.join(testsDir, 'corpus', 'manifest.json'), 'utf8'));
const corpusRoot = path.resolve((process.env.BERGWORK_PDF_CORPUS || manifest.defaultRoot).replace(/^~(?=\/)/u, os.homedir()));
const defaultExtra = flag('--no-default-extra') ? [] : [path.join(appDir, 'scripts', 'fixtures', 'smoke.pdf'), '/mnt/daten/agentwork-pdf-text-bugs/bezuege.pdf']
  .filter(file => existsSync(file));
const files = selectFiles(manifest, corpusRoot, {
  profiles: arg('--profile')?.split(','),
  extra: [...defaultExtra, ...argv.flatMap((value, index) => (value === '--extra' ? [argv[index + 1]] : []))],
});

const replayFile = arg('--replay');
const replayData = replayFile ? JSON.parse(await fs.readFile(replayFile, 'utf8')) : null;
if (!files.length && !replayData) throw new Error('no PDF to walk on');

const sites = await extractThrowSites(path.join(appDir, 'editor', 'vendor', 'build', 'src'));
const workerSites = (await extractThrowSites(path.join(appDir, 'dist', 'tools', 'vendor', 'pdf-tools')).catch(() => []))
  .filter(site => site.file === 'pdfium-worker.js');

let browser = await launchBrowser(loadPlaywright(), 'chromium');
const server = await startServer({ distDir: process.env.BERGWORK_PDF_DIST || path.join(appDir, 'dist'), harnessDir: path.join(testsDir, '.build'), corpusRoot, outDir: path.join(outDir, 'upload') });
const session = new MatrixSession(browser, server.url);
const second = new MatrixSession(browser, server.url);
session.initScripts = second.initScripts = [ERROR_RECORDER];
let enginePage = await openEnginePage(browser, server.url);
const reach = [];
const pairs = new Map();
const actions = new Map();
const thrown = new Map();
const walker = new Walker({ session, second, outDir, sites, workerSites, pairs, actions, thrown, undoRate, flickerRate });

const clone = value => JSON.parse(JSON.stringify(value));

/** Runs a trace on a fresh copy of the file; reports each failure with the index of its step. `watch` ends the run early. */
async function runTrace(file, trace, { watch = null } = {}) {
  await walker.begin(file);
  const failures = [];
  const executed = [];
  for (let index = 0; index < trace.length; index += 1) {
    const step = clone(trace[index]);
    const result = await walker.step(step);
    if (result.applied) { executed.push(step); walker.note(step); }
    for (const failure of result.failures) failures.push({ ...failure, index });
    if (watch && failures.some(item => item.sig === watch)) break;
    if (result.failures.some(item => item.stop) && !watch) break;
  }
  return { failures, executed };
}

async function shrink(file, trace, signature) {
  let replays = 0;
  const reproduces = async candidate => {
    replays += 1;
    const { failures } = await runTrace(file, candidate, { watch: signature });
    return failures.some(item => item.sig === signature);
  };
  if (!(await reproduces(trace))) return { trace, reproduced: false, replays };
  let current = trace;
  let parts = 2;
  while (current.length >= 2 && replays < shrinkReplays) {
    const size = Math.ceil(current.length / parts);
    let reduced = false;
    for (let part = 0; part < parts && !reduced && replays < shrinkReplays; part += 1) {
      const complement = current.filter((_, index) => index < part * size || index >= (part + 1) * size);
      if (!complement.length || complement.length === current.length) continue;
      if (await reproduces(complement)) { current = complement; parts = Math.max(parts - 1, 2); reduced = true; }
    }
    if (!reduced) {
      if (parts >= current.length) break;
      parts = Math.min(current.length, parts * 2);
    }
  }
  // One more run keeps only the steps that did something, with the names of what they hit.
  const final = await runTrace(file, current, { watch: signature });
  const useful = final.failures.some(item => item.sig === signature) ? final.executed : current;
  return { trace: useful, reproduced: true, replays: replays + 1, detail: final.failures.find(item => item.sig === signature)?.detail };
}

// -------------------------------------------------------------------------------------------------------------------- replay
if (replayData) {
  const file = { profile: replayData.file.profile, path: replayData.file.path };
  const { failures } = await runTrace(file, replayData.steps, { watch: replayData.signature });
  const again = failures.some(item => item.sig === replayData.signature);
  console.log(again ? `STILL FAILS: ${replayData.signature}` : `no longer fails: ${replayData.signature}`);
  for (const failure of failures) console.log(`  step ${failure.index + 1}: ${failure.sig} (${failure.detail})`);
  await session.close(); await second.close(); await browser.close(); await server.close();
  process.exit(again ? 1 : 0);
}

// ---------------------------------------------------------------------------------------------------------------------- walk
const found = new Map();
const startedAt = Date.now();
const deadline = startedAt + minutes * 60_000;
let walks = 0;
let stepsRun = 0;
let notApplied = 0;
const perFile = new Map();
const order = files.map(file => file);
{ const rng = makeRng(seed); for (let index = order.length - 1; index > 0; index -= 1) { const other = Math.floor(rng() * (index + 1)); [order[index], order[other]] = [order[other], order[index]]; } }
const log = text => console.log(`[${((Date.now() - startedAt) / 60_000).toFixed(1)} min] ${text}`);

async function writeSummary(final = false) {
  const lines = [];
  const elapsed = (Date.now() - startedAt) / 60_000;
  const known = [...actions.keys()];
  const possible = known.length * known.length;
  const covered = pairs.size;
  lines.push(`# Random walks: seed ${seed}`, '',
    `${walks} walks, ${stepsRun} steps in ${elapsed.toFixed(1)} min (${(walks / elapsed).toFixed(2)} walks/min, ${(stepsRun / elapsed).toFixed(1)} steps/min), ` +
    `${notApplied} proposed steps that the page did not allow. Files: ${files.map(file => file.profile).join(', ')}.`, '',
    '## Pair coverage', '',
    `${known.length} different actions seen; ${covered} of ${possible} ordered pairs (${(100 * covered / Math.max(1, possible)).toFixed(1)} %) ran directly one after the other. ` +
    'Not every pair can happen (a control exists only for some objects), so the share understates what was reachable.');
  const rows = [...pairs].sort((left, right) => right[1] - left[1]);
  lines.push('', `Most run: ${rows.slice(0, 8).map(([pair, count]) => `${pair} ×${count}`).join(', ')}`);
  lines.push('', '## Failure families', '');
  if (!found.size) lines.push('None found in this run.');
  for (const [signature, family] of [...found].sort((left, right) => right[1].count - left[1].count)) {
    lines.push(`### ${signature}${family.internal ? '  (an internal rule shown as a toast)' : ''}`, '',
      `${family.count}× in ${family.walks} walk(s); first on ${family.profile}, walk seed ${family.walkSeed}. ${family.detail ? `Detail: ${String(family.detail).slice(0, 200)}.` : ''}`);
    if (family.shrunk) {
      lines.push(`Shrunk from ${family.originalLength} to ${family.shrunk.length} steps (${family.replays} replays), replay: \`node apps/pdf/tests/ui-matrix/run-walk.mjs --replay ${family.saved}\``, '',
        ...family.shrunk.map((text, index) => `${index + 1}. ${text}`));
    } else if (family.reason) {
      lines.push(family.reason);
    }
    lines.push('');
  }
  lines.push(...reachLines(reach), '');
  const coverage = throwCoverage(sites, thrown);
  lines.push('## Throw sites', '', ...throwCoverageLines(coverage));
  await fs.writeFile(path.join(outDir, 'summary.md'), `${lines.join('\n')}\n`);
  await fs.writeFile(path.join(outDir, 'thrown.json'), JSON.stringify(Object.fromEntries(thrown)));
  await fs.writeFile(path.join(outDir, 'pairs.json'), JSON.stringify({ actions: Object.fromEntries(actions), pairs: Object.fromEntries(pairs) }, null, 1));
  if (final) log(`summary: ${path.join(outDir, 'summary.md')}`);
}

while (Date.now() < deadline && walks < maxWalks) {
  const file = order[walks % order.length];
  const walkSeed = (seed * 1000 + walks) >>> 0;
  const rng = makeRng(walkSeed);
  walks += 1;
  const trace = [];
  const seen = new Map();
  const fresh = [];
  let applied = 0;
  let idle = 0;
  let stopped = false;
  try {
    await walker.begin(file);
    if (!reach.some(item => item.profile === file.profile)) {
      const result = await checkReachability(session, enginePage, file).catch(error => ({ profile: file.profile, skipped: `error: ${String(error.message).slice(0, 80)}`, rows: new Map() }));
      reach.push(result);
      for (const row of new Set([...(result.missing || []).map(item => item.row)])) fresh.push({ sig: `reach: ${row} drawn by the document has no selection in the editor`, detail: `${(result.missing || []).filter(item => item.row === row).length} on ${file.profile}`, index: 0, walkTrace: [], soft: false });
      for (const row of new Set([...(result.unhittable || []).map(item => item.row)])) fresh.push({ sig: `reach: ${row} edge middle hits nothing`, detail: `${(result.unhittable || []).filter(item => item.row === row).length} on ${file.profile}`, index: 0, walkTrace: [], soft: false });
      await walker.begin(file);
    }
    for (const problem of await session.takeProblems()) log(`on open ${file.profile}: ${problem.type} ${problem.text}`);
    const run = async step => {
      const result = await walker.step(step);
      if (result.applied) { trace.push(step); walker.note(step); stepsRun += 1; } else notApplied += 1;
      for (const failure of result.failures) {
        const count = (seen.get(failure.sig) || 0) + 1;
        seen.set(failure.sig, count);
        const family = found.get(failure.sig);
        if (family) { family.count += 1; if (count === 1) family.walks += 1; }
        if (count === 1) fresh.push({ ...failure, index: trace.length - 1, walkTrace: clone(trace) });
        if (failure.stop || count >= 3) stopped = true;
      }
      if (result.hung) throw new Error(`hang in ${walker.current}`);
      return result;
    };
    while (applied < length && !stopped && idle < 6) {
      const result = await run(await walker.propose(rng));
      if (result.applied) { applied += 1; idle = 0; } else idle += 1;
      if (applied && applied % checkEvery === 0 && result.applied && !stopped) {
        await run({ op: 'check', kind: 'undo-start' });
        if (applied % (checkEvery * 2) === 0) await run({ op: 'check', kind: 'save' });
      }
    }
    if (!stopped) { await run({ op: 'check', kind: 'undo-start' }); await run({ op: 'check', kind: 'save' }); }
  } catch (error) {
    const message = String(error.message).split('\n')[0].slice(0, 160);
    log(`walk ${walks} on ${file.profile} broke the driver: ${message}`);
    fresh.push({ sig: `driver: ${normalizeDriver(message)}`, detail: message, index: trace.length, walkTrace: clone(trace), stop: true, soft: true });
    if (!browser.isConnected()) {
      browser = await launchBrowser(loadPlaywright(), 'chromium');
      session.browser = second.browser = browser;
      enginePage = await openEnginePage(browser, server.url);
      log('browser relaunched');
    }
  }
  perFile.set(file.profile, (perFile.get(file.profile) || 0) + applied);
  log(`walk ${walks} on ${file.profile}: ${applied} steps, ${fresh.length} new failure(s), ${pairs.size} pairs, ${stepsRun} steps in total`);
  for (const failure of fresh) {
    if (found.has(failure.sig)) continue;
    const family = {
      count: seen.get(failure.sig) || 1, walks: 1, profile: file.profile, walkSeed, detail: failure.detail, internal: !!failure.internal,
      originalLength: failure.walkTrace.length, soft: !!failure.soft,
    };
    found.set(failure.sig, family);
    log(`NEW ${failure.sig} (${failure.detail}) at step ${failure.index + 1}`);
    if (flag('--no-shrink') || failure.sig.startsWith('driver:') || failure.sig.startsWith('reach:')) { family.reason = 'Not shrunk.'; continue; }
    if (failure.soft && !flag('--shrink-soft')) { family.reason = `Not shrunk (a suspicion, not a hard failure). Walk of ${failure.walkTrace.length} steps kept in the JSON.`; }
    const result = flag('--no-shrink') || (failure.soft && !flag('--shrink-soft'))
      ? { trace: failure.walkTrace, reproduced: null, replays: 0 }
      : await shrink(file, failure.walkTrace, failure.sig).catch(error => ({ trace: failure.walkTrace, reproduced: false, replays: 0, error: String(error.message).slice(0, 100) }));
    const slug = failure.sig.replace(/[^A-Za-z0-9]+/gu, '-').slice(0, 60).replace(/^-|-$/gu, '');
    const saved = path.join(outDir, 'found', `${String(found.size).padStart(2, '0')}-${slug}.json`);
    family.shrunk = result.trace.map(describeStep);
    family.replays = result.replays;
    family.saved = saved;
    if (result.reproduced === false) family.reason = `Did not reproduce on a second run (${result.error || 'flaky or state-dependent'}); the full walk of ${failure.walkTrace.length} steps is kept.`;
    family.detail = result.detail || family.detail;
    await fs.writeFile(saved, JSON.stringify({
      signature: failure.sig, detail: family.detail, file: { profile: file.profile, path: file.path }, seed, walkSeed,
      reproduced: result.reproduced, readable: family.shrunk, steps: result.trace,
    }, null, 1));
    log(`  shrunk ${failure.walkTrace.length} -> ${result.trace.length} steps in ${result.replays} replays: ${saved}`);
  }
  await writeSummary();
}

await session.close();
await second.close();
await browser.close();
await server.close();
await writeSummary(true);
const hard = [...found.values()].filter(family => !family.soft).length;
console.log(`walks: ${walks} walks, ${stepsRun} steps, ${found.size} failure families (${hard} hard).`);
process.exitCode = found.size ? 1 : 0;

function normalizeDriver(message) { return message.replace(/\d+/gu, '#').slice(0, 80); }
void mergeThrown; void actionId;
