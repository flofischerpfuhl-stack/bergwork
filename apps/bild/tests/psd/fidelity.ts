import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { compositeRegion } from '../../src/core/composite';
import { PSD_BLEND_MODES, readPsdDocument, type PsdUnsupportedFeature } from '../../src/io/psd';

export interface FidelityThreshold { readonly mean: number; readonly p99: number }

export const THRESHOLDS: Readonly<Record<string, FidelityThreshold>> = {
  'blend-modes': { mean: 2, p99: 8 },
  adjustments: { mean: 8, p99: 64 },
  layers: { mean: 2, p99: 16 },
  effects: { mean: 8, p99: 64 },
  'path-operations': { mean: 4, p99: 32 },
  masks: { mean: 3, p99: 24 },
  'group-clipping': { mean: 3, p99: 24 },
  transparency: { mean: 4, p99: 32 },
  colormodes: { mean: 3, p99: 24 },
  colorprofiles: { mean: 3, p99: 24 },
  gradients: { mean: 4, p99: 32 },
  descriptors: { mean: 2, p99: 16 },
  '16/32-bit': { mean: 3, p99: 24 },
  PSB: { mean: 2, p99: 16 },
  root: { mean: 2, p99: 16 },
};

const FOLDER_ALIASES: Readonly<Record<string, string>> = { 'layers-minimal': 'layers' };

export interface DifferenceMetrics { readonly mean: number; readonly p99: number; readonly maximum: number }

export interface FidelityResult {
  readonly file: string;
  readonly categories: readonly string[];
  readonly parsed: boolean;
  readonly rendered: boolean;
  readonly passed: boolean;
  readonly threshold: FidelityThreshold;
  readonly metrics?: DifferenceMetrics;
  readonly unsupported: readonly PsdUnsupportedFeature[];
  readonly error?: string;
  readonly bitsPerChannel?: number;
}

export function differenceMetrics(actual: Uint8Array, expected: Uint8Array): DifferenceMetrics {
  if (actual.length !== expected.length) throw new RangeError('Compared pixel buffers have different lengths');
  if (actual.length % 4 !== 0) throw new RangeError('Compared pixel buffers are not RGBA');
  const histogram = new Uint32Array(256);
  let sum = 0, maximum = 0;
  for (let pixel = 0; pixel < actual.length; pixel += 4) {
    const actualAlpha = actual[pixel + 3]!, expectedAlpha = expected[pixel + 3]!;
    for (let channel = 0; channel < 4; channel++) {
      // Straight RGB below transparency is unspecified in PSD composites. Compare visible,
      // premultiplied colour while keeping alpha as its own channel.
      const left = channel === 3 ? actualAlpha : Math.round(actual[pixel + channel]! * actualAlpha / 255);
      const right = channel === 3 ? expectedAlpha : Math.round(expected[pixel + channel]! * expectedAlpha / 255);
      const delta = Math.abs(left - right);
      histogram[delta] = histogram[delta]! + 1;
      sum += delta;
      if (delta > maximum) maximum = delta;
    }
  }
  const target = Math.ceil(actual.length * 0.99);
  let seen = 0, p99 = 0;
  for (; p99 < histogram.length; p99++) {
    seen += histogram[p99]!;
    if (seen >= target) break;
  }
  return { mean: actual.length ? sum / actual.length : 0, p99: Math.min(255, p99), maximum };
}

export async function corpusFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (/\.ps[db]$/i.test(entry.name)) output.push(absolute);
    }
  }
  await visit(root);
  return output;
}

function categoriesFor(relative: string, bitsPerChannel?: number): string[] {
  const parts = relative.split('/');
  const folder = parts.length > 1 ? parts[0]! : 'root';
  const categories = [FOLDER_ALIASES[folder] ?? (THRESHOLDS[folder] ? folder : 'root')];
  if (bitsPerChannel === 16 || bitsPerChannel === 32 || /(?:^|[-_])(16|32)bit/i.test(relative)) categories.push('16/32-bit');
  if (/\.psb$/i.test(relative)) categories.push('PSB');
  return [...new Set(categories)];
}

export async function measureFile(absolute: string, corpusRoot: string): Promise<FidelityResult> {
  const file = path.relative(corpusRoot, absolute).split(path.sep).join('/');
  let categories = categoriesFor(file);
  try {
    const bytes = new Uint8Array(await readFile(absolute));
    const imported = readPsdDocument(bytes);
    categories = categoriesFor(file, imported.source.bitsPerChannel);
    const threshold = THRESHOLDS[categories[0]!]!;
    if (!imported.oracle) return { file, categories, parsed: true, rendered: false, passed: false,
      threshold, unsupported: imported.unsupported, bitsPerChannel: imported.source.bitsPerChannel,
      error: 'No embedded composite image' };
    const rendered = compositeRegion(imported.document,
      { x: 0, y: 0, width: imported.document.width, height: imported.document.height }).rgba;
    const expected = imported.oracle.toPixels();
    const metrics = differenceMetrics(rendered, expected);
    return { file, categories, parsed: true, rendered: true,
      passed: metrics.mean <= threshold.mean && metrics.p99 <= threshold.p99,
      threshold, metrics, unsupported: imported.unsupported, bitsPerChannel: imported.source.bitsPerChannel };
  } catch (error) {
    const threshold = THRESHOLDS[categories[0]!]!;
    return { file, categories, parsed: false, rendered: false, passed: false, threshold, unsupported: [],
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
}

interface CategorySummary {
  readonly files: number;
  readonly parsed: number;
  readonly rendered: number;
  readonly passed: number;
  readonly causes: readonly string[];
}

function failureCause(result: FidelityResult): string {
  if (!result.parsed) return `parse: ${result.error ?? 'unknown error'}`;
  if (!result.rendered) return result.error ?? 'not rendered';
  const unsupported = result.unsupported.find((feature) => feature.impact !== 'editability-only');
  return unsupported ? `unsupported: ${unsupported.code}` : 'wrong math/order/colour conversion';
}

function summarize(results: readonly FidelityResult[], category: string): CategorySummary {
  const selected = results.filter((result) => result.categories.includes(category));
  const counts = new Map<string, number>();
  for (const result of selected) if (!result.passed) {
    const cause = failureCause(result);
    counts.set(cause, (counts.get(cause) ?? 0) + 1);
  }
  const causes = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3).map(([cause, count]) => `${cause} (${count})`);
  return { files: selected.length, parsed: selected.filter((r) => r.parsed).length,
    rendered: selected.filter((r) => r.rendered).length, passed: selected.filter((r) => r.passed).length, causes };
}

function cell(value: string): string { return value.replaceAll('|', '\\|').replaceAll('\n', ' '); }
function decimal(value: number | undefined): string { return value === undefined ? '—' : value.toFixed(3); }
function slug(mode: string): string { return mode.replaceAll(' ', '-'); }

export function fidelityMarkdown(results: readonly FidelityResult[], commit: string): string {
  const categories = Object.keys(THRESHOLDS);
  const parsed = results.filter((result) => result.parsed).length;
  const rendered = results.filter((result) => result.rendered).length;
  const passed = results.filter((result) => result.passed).length;
  const passRate = results.length ? passed / results.length * 100 : 0;
  const lines = [
    '# PSD fidelity baseline', '',
    `Corpus: psd-tools commit \`${commit}\`; ${results.length} PSD/PSB files. ag-psd 31.0.2, canvas-free \`useImageData\` mode.`, '',
    'The oracle is each PSD’s embedded Photoshop composite. Metrics are absolute byte deltas over premultiplied RGB plus',
    'alpha (so undefined straight RGB below transparency is ignored): mean over all channels and the nearest-rank 99th',
    'percentile. A file passes only when both limits for its primary feature folder pass.',
    'The runner is a measurement baseline: fidelity failures are reported but do not make the command itself fail.', '',
    `Overall: ${parsed}/${results.length} parsed, ${rendered}/${results.length} rendered, ${passed}/${results.length} passed (${passRate.toFixed(1)}%).`,
    `The Product Plan A7 acceptance target of at least 90% is ${passRate >= 90 ? 'met' : '**not met**'} by this baseline.`, '',
    '## Thresholds and feature summary', '',
    '| Feature | Limits (mean / p99) | Files | Parsed | Rendered | Passed | Pass rate | Top failure causes |',
    '|---|---:|---:|---:|---:|---:|---:|---|',
  ];
  for (const category of categories) {
    const summary = summarize(results, category), threshold = THRESHOLDS[category]!;
    const rate = summary.files ? `${(summary.passed / summary.files * 100).toFixed(1)}%` : '—';
    lines.push(`| ${category} | ≤ ${threshold.mean} / ≤ ${threshold.p99} | ${summary.files} | ${summary.parsed} | ${summary.rendered} | ${summary.passed} | ${rate} | ${cell(summary.causes.join('; ') || '—')} |`);
  }
  lines.push('', 'Files in the `16/32-bit` and `PSB` rows are also counted in their feature/root row.', '');

  const blendByFile = new Map(results.filter((r) => r.file.startsWith('blend-modes/')).map((r) => [path.posix.basename(r.file, '.psd'), r]));
  lines.push('## Photoshop blend-mode oracle', '',
    '| Mode | Current mapping | Oracle result | Mean | p99 |', '|---|---|---:|---:|---:|');
  const nativeFailures: string[] = [], unsupportedFailures: string[] = [], unsupportedCoincidences: string[] = [];
  for (const mode of PSD_BLEND_MODES) {
    const result = blendByFile.get(slug(mode));
    const supported = !result?.unsupported.some((feature) => feature.code === `blend-mode:${mode}`);
    const metricStatus = !result ? 'missing' : !result.parsed ? 'parse failed' : result.passed ? 'pass' : 'fail';
    const status = supported ? metricStatus : `unsupported (pixel ${metricStatus})`;
    if (supported && metricStatus !== 'pass') nativeFailures.push(`${mode} (${metricStatus})`);
    else if (!supported && metricStatus === 'pass') unsupportedCoincidences.push(mode);
    else if (!supported) unsupportedFailures.push(`${mode} (${metricStatus})`);
    lines.push(`| ${mode} | ${supported ? 'native' : 'fallback to normal'} | ${status} | ${decimal(result?.metrics?.mean)} | ${result?.metrics?.p99 ?? '—'} |`);
  }
  lines.push('', `Native formula failures: ${nativeFailures.length ? nativeFailures.join(', ') : 'none'}.`,
    `Unsupported modes whose fallback fails the oracle: ${unsupportedFailures.join(', ') || 'none'}.`,
    `Unsupported modes whose particular fixture happens to pass under the normal fallback: ${unsupportedCoincidences.join(', ') || 'none'}.`,
    'Those coincidental pixel passes do not count as implementation support and all 14 unsupported modes remain A8 work.', '');

  const unsupportedCounts = new Map<string, number>();
  for (const result of results) for (const feature of result.unsupported) {
    const key = `${feature.impact}: ${feature.code}`;
    unsupportedCounts.set(key, (unsupportedCounts.get(key) ?? 0) + 1);
  }
  lines.push('## Unsupported and approximated features', '',
    'Nothing detected by the adapter is silently discarded. Counts below are layer/file occurrences; editability-only items',
    'use the PSD’s saved pixel cache and can still match the visual oracle.', '', '| Impact and feature | Occurrences |', '|---|---:|');
  for (const [feature, count] of [...unsupportedCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    lines.push(`| ${cell(feature)} | ${count} |`);
  }
  if (!unsupportedCounts.size) lines.push('| — | 0 |');

  const warnings = new Map<string, number>();
  for (const result of results) for (const feature of result.unsupported) if (feature.code === 'ag-psd-parser') {
    warnings.set(feature.message, (warnings.get(feature.message) ?? 0) + 1);
  }
  lines.push('', '### ag-psd parser warnings', '', '| Warning | Occurrences |', '|---|---:|');
  for (const [warning, count] of [...warnings].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    lines.push(`| ${cell(warning)} | ${count} |`);
  }
  if (!warnings.size) lines.push('| — | 0 |');

  lines.push('', '## Per-file results', '',
    '| File | Primary feature | Parsed | Rendered | Pass | Mean | p99 | Max | Unsupported (non-editability) / error |',
    '|---|---|---:|---:|---:|---:|---:|---:|---|');
  for (const result of results) {
    const unsupported = result.unsupported.filter((feature) => feature.impact !== 'editability-only')
      .map((feature) => feature.code).join(', ');
    const issues = result.error ?? (unsupported || '—');
    lines.push(`| ${cell(result.file)} | ${result.categories[0]} | ${result.parsed ? 'yes' : 'no'} | ${result.rendered ? 'yes' : 'no'} | ${result.passed ? 'yes' : 'no'} | ${decimal(result.metrics?.mean)} | ${result.metrics?.p99 ?? '—'} | ${result.metrics?.maximum ?? '—'} | ${cell(issues)} |`);
  }
  lines.push('', '## Known deviations and next work', '',
    '- ag-psd converts non-RGB documents without ICC colour management; embedded profiles are not exposed by this ag-psd version.',
    '- 16/32-bit channels are reduced to the editor’s RGBA8 raster model before compositing.',
    '- PSD adjustment layers, effects, vector masks, smart filters, blend-if, knockouts, isolated groups, and advanced group',
    '  compositing are reported but not evaluated. Text, vector, and smart-object layers use saved pixel caches only.',
    '- A bounded raster mask is mapped to the editor’s placed mask. Outside coverage uses the editor’s edge-majority inference;',
    '  a conflict with the PSD mask default is reported as `mask-default`.',
    '- Missing blend modes fall back to normal solely to keep the diagnostic render complete; their failures are A8 input.',
    '', 'Run `npm run psd:fidelity` after `scripts/fetch-psd-corpus.sh` to regenerate this report.', '',
  );
  return lines.join('\n');
}

export async function writeFidelityReport(results: readonly FidelityResult[], output: string, commit: string): Promise<void> {
  await writeFile(output, fidelityMarkdown(results, commit), 'utf8');
}
