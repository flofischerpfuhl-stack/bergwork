#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = resolve(root, 'tests/e2e/areas.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

export const GATE_SPEC_LIMIT = 24;

function normalisePath(value) {
  return value.replaceAll('\\', '/').replace(/^\.\//, '');
}

export function matchesGlob(path, glob) {
  const source = normalisePath(glob);
  let expression = '^';
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '*') {
      if (source[index + 1] === '*') {
        expression += '.*';
        index += 1;
      } else {
        expression += '[^/]*';
      }
    } else if (char === '?') {
      expression += '[^/]';
    } else {
      expression += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  return new RegExp(`${expression}$`).test(normalisePath(path));
}

export function areasForPaths(paths, areas = manifest.areas) {
  const changed = paths.map(normalisePath);
  return Object.entries(areas)
    .filter(([, area]) => changed.some((path) => area.specs.includes(path)
      || area.sourceGlobs.some((glob) => matchesGlob(path, glob))))
    .map(([name]) => name);
}

export function specsForAreas(names, areas = manifest.areas) {
  return [...new Set(names.flatMap((name) => areas[name]?.specs ?? []))].sort();
}

export function capGateSpecs(smokeSpecs, changedSpecs, limit = GATE_SPEC_LIMIT) {
  const included = [...new Set(smokeSpecs)];
  const candidates = changedSpecs.filter((spec) => !included.includes(spec));
  const room = Math.max(0, limit - included.length);
  return {
    specs: [...included, ...candidates.slice(0, room)],
    skipped: candidates.slice(room),
  };
}

function gitLines(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    .split(/\r?\n/)
    .map(normalisePath)
    .filter(Boolean);
}

export function changedPaths(base = 'integration') {
  const mergeBase = gitLines(['merge-base', base, 'HEAD'])[0];
  if (!mergeBase) throw new Error(`could not find merge-base for ${base}`);
  return [...new Set([
    ...gitLines(['diff', '--name-only', `${mergeBase}...HEAD`]),
    ...gitLines(['diff', '--name-only', 'HEAD']),
    ...gitLines(['ls-files', '--others', '--exclude-standard']),
  ])].sort();
}

function parseArgs(argv) {
  const options = { areas: [], changed: false, smoke: false, gate: false, dryRun: false, base: 'integration', extra: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--area' || arg.startsWith('--area=')) {
      const value = arg === '--area' ? argv[++index] : arg.slice('--area='.length);
      if (!value) throw new Error('--area needs a comma-separated area name');
      options.areas.push(...value.split(',').map((name) => name.trim()).filter(Boolean));
    } else if (arg === '--base' || arg.startsWith('--base=')) {
      const value = arg === '--base' ? argv[++index] : arg.slice('--base='.length);
      if (!value) throw new Error('--base needs a git ref');
      options.base = value;
    } else if (arg === '--changed') {
      options.changed = true;
    } else if (arg === '--smoke') {
      options.smoke = true;
    } else if (arg === '--gate') {
      options.gate = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else {
      options.extra.push(arg);
    }
  }
  return options;
}

function usage() {
  const names = Object.keys(manifest.areas).join(', ');
  return `Usage: node scripts/e2e-select.mjs [--area <name>[,<name>]] [--changed [--base <ref>]] [--smoke] [--dry-run] [Playwright args]\nAreas: ${names}`;
}

function selectChanged(base) {
  try {
    const paths = changedPaths(base);
    const areas = areasForPaths(paths);
    if (areas.length === 0) {
      console.log(`[e2e-select] No E2E area matched ${paths.length} changed path(s); using smoke set.`);
      return { areas: [], specs: manifest.smoke };
    }
    console.log(`[e2e-select] Changed areas: ${areas.join(', ')}`);
    return { areas, specs: specsForAreas(areas) };
  } catch (error) {
    console.warn(`[e2e-select] Git change detection unavailable (${error.message}); using smoke set.`);
    return { areas: [], specs: manifest.smoke };
  }
}

export function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`[e2e-select] ${error.message}\n${usage()}`);
    return 2;
  }

  const unknown = [...new Set(options.areas)].filter((name) => !manifest.areas[name]);
  if (unknown.length > 0) {
    console.error(`[e2e-select] Unknown area(s): ${unknown.join(', ')}\n${usage()}`);
    return 2;
  }
  if (!options.gate && !options.smoke && !options.changed && options.areas.length === 0) {
    console.error(usage());
    return 2;
  }

  let specs = [];
  let skipped = [];
  if (options.gate) {
    const changed = selectChanged(options.base);
    ({ specs, skipped } = capGateSpecs(manifest.smoke, changed.specs));
  } else {
    if (options.smoke) specs.push(...manifest.smoke);
    if (options.areas.length > 0) specs.push(...specsForAreas([...new Set(options.areas)]));
    if (options.changed) specs.push(...selectChanged(options.base).specs);
    specs = [...new Set(specs)];
  }

  console.log(`[e2e-select] Selected ${specs.length} spec file(s):`);
  for (const spec of specs) console.log(`  ${spec}`);
  if (skipped.length > 0) {
    console.warn(`[e2e-select] Gate cap is ${GATE_SPEC_LIMIT} spec files; skipped ${skipped.length}:`);
    for (const spec of skipped) console.warn(`  ${spec}`);
  }
  if (options.dryRun) return 0;

  const executable = process.platform === 'win32'
    ? resolve(root, 'node_modules/.bin/playwright.cmd')
    : resolve(root, 'node_modules/.bin/playwright');
  const args = ['test', ...specs, ...options.extra];
  console.log(`[e2e-select] Running: playwright ${args.join(' ')}`);
  const result = spawnSync(executable, args, { cwd: root, env: process.env, stdio: 'inherit' });
  if (result.error) {
    console.error(`[e2e-select] Could not start Playwright: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) process.exitCode = main();

