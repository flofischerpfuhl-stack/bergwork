// Aggregates per-file results into report.json, coverage.csv and a short summary.md: operations by status,
// refusals by reason, failures grouped by operation/check and PDF category (each with a repro command), the
// operation × category coverage matrix and the operation-pair coverage of the seeded sequences.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CATEGORIES, EDIT_OPS, DOC_OPS, PHASES } from './plan.mjs';

const MATRIX_CATEGORIES = ['pdf-1.3', 'pdf-1.4', 'pdf-1.7', 'pdf-2.0', 'pdfa', 'tagged', 'scanned', 'cjk', 'rtl',
  'font-type3', 'font-cid', 'acroform', 'xfa', 'annotations', 'encrypted', 'incremental', 'broken', 'vector-heavy', 'many-pages'];

const pct = (part, whole) => (whole ? `${((100 * part) / whole).toFixed(1)}%` : '–');
const quantile = (values, q) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};
const normalizeMessage = (message) => String(message || '').replace(/\d+(\.\d+)?/g, 'N').replace(/BW[A-Z]{6}/g, 'BW…').replace(/pdf-[a-z]+-[0-9a-f-]{6,}/g, 'ID').slice(0, 140);

export async function writeReports({ outDir, results, args, tier, files, manifest, buildInfo, tools, wallMs }) {
  const ops = {};
  const refusals = {};
  const failures = {};
  const matrix = {};
  const pairs = new Map();
  const checkStats = {};
  let failedFiles = 0;
  let openedFiles = 0;
  const allOps = [...PHASES, ...EDIT_OPS, ...DOC_OPS];
  for (const op of allOps) ops[op] = { executed: 0, ok: 0, refused: 0, na: 0, fail: 0, skipped: 0, ms: [] };

  for (const result of results) {
    const tags = new Set(result.tags || []);
    if ((result.steps || []).some((step) => step.op === 'open.engine' && step.status === 'ok')) openedFiles += 1;
    if (result.failures?.length) failedFiles += 1;
    let previous = null;
    for (const step of result.steps || []) {
      const entry = ops[step.op] || (ops[step.op] = { executed: 0, ok: 0, refused: 0, na: 0, fail: 0, skipped: 0, ms: [] });
      entry.executed += 1;
      const key = step.status === 'n/a' ? 'na' : step.status;
      entry[key] = (entry[key] || 0) + 1;
      if (Number.isFinite(step.ms)) entry.ms.push(step.ms);
      if (step.status === 'refused') {
        const reason = `${step.error?.detailCode || step.error?.code}: ${normalizeMessage(step.error?.message)}`;
        const bucket = (refusals[step.op] ||= {});
        (bucket[reason] ||= { count: 0, files: [] }).count += 1;
        if (bucket[reason].files.length < 5) bucket[reason].files.push(result.id);
      }
      if (step.status === 'ok' && (EDIT_OPS.includes(step.op) || DOC_OPS.includes(step.op))) {
        for (const category of CATEGORIES) {
          if (!tags.has(category) && !(category === 'encrypted' && tags.has('encrypted'))) continue;
          ((matrix[step.op] ||= {})[category] = (matrix[step.op][category] || 0) + 1);
        }
        if (previous && EDIT_OPS.includes(step.op)) pairs.set(`${previous}>${step.op}`, (pairs.get(`${previous}>${step.op}`) || 0) + 1);
        if (EDIT_OPS.includes(step.op)) previous = step.op;
      }
    }
    for (const check of result.checks || []) {
      const name = check.name.replace(/\.(edited|project|doc\.[a-zA-Z]+)$/, '.*');
      const stat = (checkStats[name] ||= { pass: 0, fail: 0 });
      stat[check.ok ? 'pass' : 'fail'] += 1;
    }
    for (const failure of result.failures || []) {
      const group = (failures[failure.name] ||= { count: 0, categories: {}, messages: {}, cases: [] });
      group.count += 1;
      for (const tag of tags) if (CATEGORIES.includes(tag)) group.categories[tag] = (group.categories[tag] || 0) + 1;
      const message = normalizeMessage(failure.message);
      group.messages[message] = (group.messages[message] || 0) + 1;
      if (group.cases.length < 12) group.cases.push({ file: result.id, seed: result.seed, plan: result.plan, message: String(failure.message || '').slice(0, 200), repro: result.repro });
    }
  }
  const opRows = Object.entries(ops).filter(([, stat]) => stat.executed).map(([op, stat]) => ({
    op, executed: stat.executed, ok: stat.ok, refused: stat.refused, na: stat.na, fail: stat.fail, skipped: stat.skipped,
    meanMs: Math.round(stat.ms.reduce((a, b) => a + b, 0) / Math.max(1, stat.ms.length)), p95Ms: quantile(stat.ms, 0.95),
  }));
  const possiblePairs = EDIT_OPS.length * EDIT_OPS.length;
  const checksTotal = Object.values(checkStats).reduce((sum, item) => sum + item.pass + item.fail, 0);
  const checksFailed = Object.values(checkStats).reduce((sum, item) => sum + item.fail, 0);
  const stepTotal = opRows.reduce((sum, row) => sum + row.executed, 0);
  const editOk = opRows.filter((row) => EDIT_OPS.includes(row.op) || DOC_OPS.includes(row.op)).reduce((sum, row) => sum + row.ok, 0);
  const report = {
    generated: new Date().toISOString(),
    tier: args.tier, seed: args.seed, jobs: args.jobs, browser: args.browser, tierConfig: tier,
    build: buildInfo, tools,
    corpus: { manifestFiles: manifest.files.length, selected: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0) },
    totals: { files: results.length, openedFiles, failedFiles, steps: stepTotal, operationsOk: editOk, checks: checksTotal, checksFailed, wallMs,
      fileMsSum: results.reduce((sum, result) => sum + (result.wallMs || 0), 0) },
    operations: opRows, refusals, failures, checks: checkStats, coverage: matrix,
    pairCoverage: { distinct: pairs.size, possible: possiblePairs, pairs: Object.fromEntries([...pairs].sort()) },
  };
  await fs.writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  const csv = ['op,' + CATEGORIES.join(','), ...[...EDIT_OPS, ...DOC_OPS].map((op) => `${op},${CATEGORIES.map((category) => matrix[op]?.[category] || 0).join(',')}`)];
  await fs.writeFile(path.join(outDir, 'coverage.csv'), `${csv.join('\n')}\n`);

  const md = [];
  const summaryLine = `${results.length} files (${openedFiles} opened), ${editOk} operations ok, ${stepTotal} steps, ${checksTotal} checks ` +
    `(${checksFailed} failed), ${failedFiles} files with failures, ${(wallMs / 1000).toFixed(0)} s wall`;
  md.push(`# Corpus suite: ${args.tier} tier`, '', `${report.generated} · seed ${args.seed} · ${args.jobs} pages · ${args.browser}` +
    ` · shell ${buildInfo?.shellDigest || '?'}`, '', `**${summaryLine}.**`, '');
  md.push('## Operations', '', '| Operation | Run | OK | Refused | n/a | Fail | Mean ms | p95 ms |', '|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const row of opRows) md.push(`| ${row.op} | ${row.executed} | ${row.ok} | ${row.refused} | ${row.na} | ${row.fail} | ${row.meanMs} | ${row.p95Ms} |`);
  md.push('', '## Failures', '');
  const groups = Object.entries(failures).sort((a, b) => b[1].count - a[1].count);
  if (!groups.length) md.push('None.');
  for (const [name, group] of groups) {
    const categories = Object.entries(group.categories).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([tag, count]) => `${tag} ${count}`).join(', ');
    md.push(`### ${name} (${group.count})`, '', `Categories: ${categories || '–'}`, '');
    for (const [message, count] of Object.entries(group.messages).sort((a, b) => b[1] - a[1]).slice(0, 4)) md.push(`- ${count}× \`${message}\``);
    for (const item of group.cases.slice(0, 4)) md.push(`- \`${item.file}\` (seed ${item.seed}; plan ${item.plan?.ops?.join(' → ')}): \`${item.repro}\``);
    md.push('');
  }
  md.push('## Refusals (the editor declined the edit with a typed reason)', '');
  for (const [op, reasons] of Object.entries(refusals)) {
    for (const [reason, item] of Object.entries(reasons).sort((a, b) => b[1].count - a[1].count).slice(0, 4)) md.push(`- ${op}: ${item.count}× ${reason}`);
  }
  md.push('', '## Checks', '', '| Check | Pass | Fail |', '|---|---:|---:|');
  for (const [name, stat] of Object.entries(checkStats).sort()) md.push(`| ${name} | ${stat.pass} | ${stat.fail} |`);
  md.push('', '## Coverage: successful operations × category', '', `| Operation | ${MATRIX_CATEGORIES.join(' | ')} |`, `|---|${MATRIX_CATEGORIES.map(() => '---:').join('|')}|`);
  for (const op of [...EDIT_OPS, ...DOC_OPS]) md.push(`| ${op} | ${MATRIX_CATEGORIES.map((category) => matrix[op]?.[category] || '·').join(' | ')} |`);
  md.push('', `Operation pairs run back to back (both ok): ${pairs.size} of ${possiblePairs} ordered pairs (${pct(pairs.size, possiblePairs)}). Full matrix: coverage.csv.`, '');
  await fs.writeFile(path.join(outDir, 'summary.md'), `${md.join('\n')}\n`);
  return { summaryLine, failedFiles };
}
