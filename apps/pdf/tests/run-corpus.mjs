#!/usr/bin/env node
// berg:work PDF corpus suite. Runs seeded combinations of the editor's operations over the public PDF corpus
// (tests/corpus/manifest.json, files fetched by tests/corpus/fetch-corpus.mjs) in a few long-lived headless pages,
// checks the results inside the page (PDFium reopen, PDF.js, undo, redactions, text) and outside it (qpdf,
// poppler), and writes results.jsonl, report.json and summary.md. See tests/README.md.
//
//   node apps/pdf/tests/run-corpus.mjs --tier quick|sample|full [--jobs 3] [--seed 1] [--limit N]
//        [--file <id>[,<id>]] [--ops op1,op2] [--tags a,b] [--source s] [--out dir] [--no-build] [--keep-pdfs]
import { existsSync, promises as fs, createWriteStream } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHarness, outDir as harnessDir } from './harness/build-harness.mjs';
import { startServer } from './lib/server.mjs';
import { TIERS, selectFiles, planFor, donorPool, workWeights, fileBudgetMs, stepLimits } from './lib/plan.mjs';
import { detectTools, qpdfCheck, qpdfPages, qpdfEncrypted, popplerWordsInRects } from './lib/oracles.mjs';
import { writeReports } from './lib/report.mjs';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.dirname(testsDir);
// BERGWORK_PDF_DIST serves another build's /tools/vendor/ (a Fernwork worktree's root) with BERGWORK_PDF_EDITOR_SRC.
const distDir = process.env.BERGWORK_PDF_DIST ? path.resolve(process.env.BERGWORK_PDF_DIST) : path.join(appDir, 'dist');

function parseArgs(argv) {
  const args = { tier: 'quick', jobs: 3, seed: 1, build: true, keepPdfs: false, browser: 'chromium' };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = () => argv[(i += 1)];
    if (key === '--tier') args.tier = next();
    else if (key === '--jobs') args.jobs = Math.max(1, Math.min(6, Number(next())));
    else if (key === '--seed') args.seed = Number(next());
    else if (key === '--limit') args.limit = Number(next());
    else if (key === '--file') args.ids = next().split(',');
    else if (key === '--ops') args.ops = next().split(',');
    else if (key === '--tags') args.tags = next().split(',');
    else if (key === '--source') args.source = next().split(',');
    else if (key === '--out') args.out = next();
    else if (key === '--root') args.root = next();
    else if (key === '--no-build') args.build = false;
    else if (key === '--keep-pdfs') args.keepPdfs = true;
    else if (key === '--browser') args.browser = next();
    else if (key === '--refresh-all') args.refreshAll = true;
    else if (key === '--help' || key === '-h') args.help = true;
    else throw new Error(`Unknown argument ${key}`);
  }
  if (!TIERS[args.tier]) throw new Error(`Unknown tier ${args.tier} (quick, sample, full)`);
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log((await fs.readFile(fileURLToPath(import.meta.url), 'utf8')).split('\n').slice(1, 9).join('\n'));
  process.exit(0);
}
const tier = TIERS[args.tier];
const manifest = JSON.parse(await fs.readFile(path.join(testsDir, 'corpus', 'manifest.json'), 'utf8'));
const corpusRoot = path.resolve((args.root || process.env.BERGWORK_PDF_CORPUS || manifest.defaultRoot).replace(/^~(?=\/)/, os.homedir()));
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outDir = path.resolve(args.out || path.join(testsDir, '.out', `${args.tier}-${stamp}`));
const pdfDir = path.join(outDir, 'pdf');

if (!existsSync(path.join(distDir, 'index.html')) || !existsSync(path.join(distDir, 'tools', 'vendor', 'pdf-tools', 'pdfium-worker.js'))) {
  console.error('apps/pdf/dist is missing: run `npm run build:web -w @bergwork/pdf` first.');
  process.exit(2);
}
const filter = (file) => (!args.tags || args.tags.some((tag) => file.tags.includes(tag))) &&
  (!args.source || args.source.includes(file.source));
const files = selectFiles(manifest, args.tier, { seed: args.seed, limit: args.limit, filter, ids: args.ids })
  .filter((file) => existsSync(path.join(corpusRoot, file.id)));
if (!files.length) {
  console.error(`No corpus files found under ${corpusRoot}. Fetch them with node apps/pdf/tests/corpus/fetch-corpus.mjs.`);
  process.exit(2);
}
const donors = donorPool(manifest).filter((file) => existsSync(path.join(corpusRoot, file.id)));
const buildInfo = args.build ? await buildHarness({ quiet: true }) : JSON.parse(await fs.readFile(path.join(harnessDir, 'build-info.json'), 'utf8'));
const tools = await detectTools();
await fs.mkdir(pdfDir, { recursive: true });

const require = createRequire(path.join(appDir, '..', 'image', 'package.json'));
const playwright = require('playwright');
const server = await startServer({ distDir, harnessDir, corpusRoot, outDir: pdfDir });
const browser = await playwright[args.browser].launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });

console.log(`corpus suite: tier ${args.tier}, ${files.length} files, ${args.jobs} pages, seed ${args.seed}, out ${path.relative(process.cwd(), outDir) || outDir}`);
const started = Date.now();
const resultsStream = createWriteStream(path.join(outDir, 'results.jsonl'));
const results = [];

async function newHarnessPage() {
  const page = await context.newPage();
  page.__events = [];
  page.on('pageerror', (error) => page.__events.push({ type: 'pageerror', message: String(error.message).slice(0, 300) }));
  page.on('crash', () => page.__events.push({ type: 'crash' }));
  await page.goto(`${server.url}/__harness/harness.html`);
  await page.waitForFunction(() => window.BW || window.__harnessError, null, { timeout: 60_000 });
  const error = await page.evaluate(() => window.__harnessError);
  if (error) throw new Error(`harness failed to load: ${error}`);
  return page;
}

async function nodeOracles(file, job, result) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), ...(detail != null ? { detail } : {}), oracle: 'node' });
  for (const output of result.outputs || []) {
    if (output.image) continue;
    const target = path.join(pdfDir, output.name);
    if (!existsSync(target)) { add(`${output.kind}.written`, false, output.name); continue; }
    if (tools.qpdf) {
      const check = await qpdfCheck(target, output.password);
      // An output may keep damage the input already had; it must not add new damage.
      const sourceBroken = file.facts?.qpdfCheck === 'errors' || file.tags.includes('broken');
      add(`qpdf.check.${output.kind}`, check.status !== 'errors' || sourceBroken, `${check.status}${check.message ? `: ${check.message}` : ''}`);
      const pages = await qpdfPages(target, output.password);
      if (output.expectPages != null) add(`qpdf.pages.${output.kind}`, pages === output.expectPages, `${pages}/${output.expectPages}`);
      if (output.kind === 'doc.encrypt') add('qpdf.encrypted', await qpdfEncrypted(target), output.name);
      // Observation only: whether saving an encrypted input keeps its encryption.
      if (output.kind === 'edited' && file.facts?.encrypted) checks.push({ name: 'info.savedStillEncrypted', ok: true, info: true, detail: String(await qpdfEncrypted(target)), oracle: 'node' });
    }
    if (tools.pdftotext && output.kind === 'edited') {
      for (const redaction of output.redactions || []) {
        if (redaction.pageIndex < 0) continue;
        const rects = redaction.rects.map((rect) => ({ left: rect.left + 1, right: rect.right - 1, bottom: rect.bottom + 1, top: rect.top - 1 }));
        const found = await popplerWordsInRects(target, redaction.pageIndex + 1, rects);
        if (found.skipped) continue;
        const leaked = redaction.word ? found.words.filter((word) => word.includes(redaction.word)) : found.words;
        add('poppler.redactedTextGone', leaked.length === 0, `page ${redaction.pageIndex + 1}: ${leaked.slice(0, 5).join(' ')}`);
      }
    }
  }
  return checks;
}

function classify(file, result) {
  // Failures are steps with status 'fail', checks that are false, timeouts and crashes. A file that no reader opens
  // (expect.open = fail) may fail to open without counting.
  const expectedOpenFail = file.expect?.open === 'fail';
  const failures = [];
  // When the editor itself cannot open such a file (open.ui failed), the engine-only steps after it are moot.
  const editorOpenFailed = expectedOpenFail && (result.steps || []).some((step) => step.op === 'open.ui' && step.status === 'fail');
  if (editorOpenFailed) return [];
  for (const step of result.steps || []) {
    if (step.status !== 'fail') continue;
    if (expectedOpenFail && /^open\./.test(step.op)) continue;
    failures.push({ kind: 'step', name: step.op, message: step.error?.message, code: step.error?.code });
  }
  for (const check of result.checks || []) if (!check.ok && !check.info) failures.push({ kind: 'check', name: check.name, message: check.detail });
  return failures;
}

const queue = files.map((file, index) => ({ file, index }));
let done = 0;
async function worker(slot) {
  let page = await newHarnessPage();
  let sinceReset = 0;
  while (queue.length) {
    const { file, index } = queue.shift();
    const plan = planFor(file, { seed: args.seed, tierName: args.tier, donors, only: args.ops });
    // Limits scale with the document's size (maps, posters, scanned books), see workWeights.
    const weights = workWeights(file);
    const budgetMs = fileBudgetMs(tier, weights, plan);
    const job = {
      id: file.id, url: `/__corpus/${file.id}`, password: file.password || '', seed: plan.seed, ops: plan.ops,
      docOps: plan.docOps, undo: plan.undo, project: plan.project, uiLoad: true, budgetMs, stepLimits: stepLimits(weights),
      refreshAll: args.refreshAll === true, baselinePages: tier.baselinePages, inspectPages: tier.inspectPages, outPrefix: `${String(index).padStart(4, '0')}-${file.id.replace(/[^A-Za-z0-9._-]/g, '_')}`,
    };
    const t0 = Date.now();
    let result;
    page.__events = [];
    let timer;
    try {
      result = await Promise.race([
        page.evaluate((value) => window.BW.runFile(value), job),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(`file timed out after ${budgetMs + 60_000} ms`), { code: 'timeout' })), budgetMs + 60_000); }),
      ]);
    } catch (error) {
      const crashed = page.__events.some((event) => event.type === 'crash');
      result = { id: file.id, seed: plan.seed, steps: [{ op: 'harness', status: 'fail', error: { message: String(error.message).slice(0, 300), code: crashed ? 'crash' : (error.code || 'error') } }], checks: [], outputs: [] };
      await page.close().catch(() => {});
      page = await newHarnessPage();
      sinceReset = 0;
    } finally { clearTimeout(timer); }
    result.wallMs = Date.now() - t0;
    result.slot = slot;
    result.pageErrors = page.__events.filter((event) => event.type === 'pageerror').slice(0, 5);
    result.plan = { ops: plan.ops.map((item) => item.op + (item.params?.donorId ? `<${item.params.donorId}` : '')), docOps: plan.docOps, project: plan.project };
    result.checks = [...(result.checks || []), ...(await nodeOracles(file, job, result))];
    result.tags = file.tags;
    result.source = file.source;
    result.failures = classify(file, result);
    result.repro = `node apps/pdf/tests/run-corpus.mjs --tier ${args.tier} --seed ${args.seed} --file ${file.id}`;
    results.push(result);
    resultsStream.write(`${JSON.stringify(result)}\n`);
    if (!args.keepPdfs && !result.failures.length) {
      for (const output of result.outputs || []) await fs.rm(path.join(pdfDir, output.name), { force: true });
    }
    done += 1;
    const mark = result.failures.length ? `FAIL ${result.failures.map((item) => item.name).slice(0, 4).join(', ')}` : 'ok';
    console.log(`[${String(done).padStart(4)}/${files.length}] p${slot} ${(result.wallMs / 1000).toFixed(1).padStart(5)}s ${file.id} ${mark}`);
    sinceReset += 1;
    if (sinceReset >= 20) {
      // Bound worker memory on long runs: a fresh page (and PDFium worker) every 20 files.
      await page.close().catch(() => {});
      page = await newHarnessPage();
      sinceReset = 0;
    }
  }
  await page.close().catch(() => {});
}

process.on('SIGINT', () => { queue.length = 0; });
await Promise.all(Array.from({ length: Math.min(args.jobs, files.length) }, (_, slot) => worker(slot + 1)));
resultsStream.end();
await browser.close();
await server.close();

const report = await writeReports({ outDir, results, args, tier, files, manifest, buildInfo, tools, wallMs: Date.now() - started });
console.log(`\n${report.summaryLine}\nreport: ${path.join(outDir, 'summary.md')}`);
process.exitCode = report.failedFiles ? 1 : 0;
