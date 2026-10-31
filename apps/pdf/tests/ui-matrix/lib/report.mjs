// results.jsonl (one line per control or check), summary.md (the table) and matrix.csv.
import { promises as fs } from 'node:fs';
import path from 'node:path';

const STATUS_ORDER = ['fail', 'slow', 'ok', 'skip', 'n/a'];
const worst = statuses => STATUS_ORDER.find(status => statuses.includes(status)) || 'n/a';
const SYMBOL = { fail: 'FAIL', slow: 'slow', ok: 'ok', skip: 'skip', 'n/a': '–' };

export async function writeReport(outDir, { results, tier, seed, files, startedAt, budget }) {
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'results.jsonl'), results.map(item => JSON.stringify(item)).join('\n') + '\n');
  const rows = new Map();
  for (const item of results) {
    const key = `${item.profile}|${item.type}|${item.state}`;
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push(item);
  }
  const failures = results.filter(item => item.status === 'fail');
  const slow = results.filter(item => item.status === 'slow');
  const worked = results.filter(item => item.control);
  const distinct = new Set(worked.map(item => `${item.type}:${item.control}`));
  const lines = [
    `# UI matrix: ${tier}`,
    '',
    `Seed ${seed}. ${files.length} files, ${rows.size} cells, ${worked.length} control runs over ${distinct.size} distinct controls, ` +
      `${failures.length} failures, ${slow.length} over the time budget, ${((Date.now() - startedAt) / 60_000).toFixed(1)} min.`,
    '',
    '| File | Object | State | Controls | Failed | Slow | Editor | Undo | Save | Slowest |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  const csv = ['profile,file,type,state,control,check,status,ms,detail'];
  for (const [key, items] of rows) {
    const [profile, type, state] = key.split('|');
    const controls = items.filter(item => item.control);
    const check = name => SYMBOL[worst(items.filter(item => item.check === name).map(item => item.status))];
    lines.push(`| ${profile} | ${type} | ${state} | ${controls.length} | ${controls.filter(item => item.status === 'fail').length} | ` +
      `${items.filter(item => item.status === 'slow').length} | ${check('editor')} | ${check('undo')} | ${check('save')} | ` +
      `${Math.max(0, ...items.map(item => Number(item.ms) || 0))} ms |`);
  }
  if (failures.length) {
    lines.push('', '## Failures', '');
    const grouped = new Map();
    for (const item of failures) {
      const key = `${item.check || 'control'}: ${String(item.detail || '').slice(0, 120)}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(item);
    }
    for (const [key, items] of [...grouped].sort((left, right) => right[1].length - left[1].length)) {
      const sample = items[0];
      lines.push(`- **${key}** (${items.length}×), e.g. ${sample.profile} ${sample.type} ${sample.state}${sample.control ? ` \`${sample.control}\`` : ''}`);
    }
  }
  if (slow.length) {
    lines.push('', '## Over the time budget', '');
    for (const item of slow.sort((left, right) => right.ms - left.ms).slice(0, 15)) {
      lines.push(`- ${item.ms} ms: ${item.profile} ${item.type} ${item.state} ${item.control || item.check}`);
    }
  }
  if (budget?.dropped) lines.push('', `Time budget reached: ${budget.dropped} cells not run.`);
  for (const item of results) {
    csv.push([item.profile, item.file, item.type, item.state, item.control || '', item.check || '', item.status, item.ms ?? '', item.detail || '']
      .map(value => `"${String(value).replaceAll('"', '""')}"`).join(','));
  }
  await fs.writeFile(path.join(outDir, 'summary.md'), lines.join('\n') + '\n');
  await fs.writeFile(path.join(outDir, 'matrix.csv'), csv.join('\n') + '\n');
  return { failures: failures.length, slow: slow.length, summary: path.join(outDir, 'summary.md') };
}
