#!/usr/bin/env node
// Materialises the editor builds that berg:work takes over from Fernwork and the compositor repository.
//
// The editors are developed upstream; berg:work pins one upstream commit per editor in upstream.lock.json and
// never edits the materialised files. See docs/ARCHITECTURE.md § Upstream editors.
//
//   node scripts/sync-upstream.mjs install [name…]   materialise the locked commits (skips targets that match)
//   node scripts/sync-upstream.mjs check [name…]     fail when a target is missing or differs from the lock
//   node scripts/sync-upstream.mjs update <name> [--ref <rev>]
//                                                     pin a new upstream commit and print the upstream changes
//   node scripts/sync-upstream.mjs status [name…]    show how far each pin is behind its upstream ref
//
// An upstream checkout can be overridden per machine with BERGWORK_UPSTREAM_<NAME>=<path>
// (name upper-cased, dashes as underscores), for example BERGWORK_UPSTREAM_FERNWORK_PDF=D:\src\fernwork.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MANIFEST_NAME = '.upstream-manifest.json';

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(here, '..');

export class SyncError extends Error {}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: options.encoding ?? 'utf8',
    maxBuffer: 1024 * 1024 * 1024,
    stdio: options.inherit ? 'inherit' : 'pipe',
    cwd: options.cwd,
    input: options.input,
    shell: process.platform === 'win32' && options.shell,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.inherit ? '' : `\n${String(result.stderr || '').trim()}`;
    throw new SyncError(`${command} ${args.join(' ')} failed with exit code ${result.status}${detail}`);
  }
  return result.stdout;
}

function git(repo, args, options = {}) {
  return run('git', ['-C', repo, ...args], options);
}

export async function readLock(root) {
  const file = path.join(root, 'upstream.lock.json');
  const lock = JSON.parse(await fs.readFile(file, 'utf8'));
  if (lock.schemaVersion !== 1 || typeof lock.upstreams !== 'object') {
    throw new SyncError(`${file}: unsupported lock format`);
  }
  return lock;
}

async function writeLock(root, lock) {
  await fs.writeFile(path.join(root, 'upstream.lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
}

export function upstreamRepo(root, name, entry, env = process.env) {
  const override = env[`BERGWORK_UPSTREAM_${name.toUpperCase().replace(/-/g, '_')}`];
  return path.resolve(root, override || entry.repo);
}

async function walk(dir, prefix = '') {
  const out = [];
  for (const item of await fs.readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) out.push(...await walk(path.join(dir, item.name), rel));
    else if (item.isFile() && rel !== MANIFEST_NAME) out.push(rel);
    else if (!item.isFile() && !item.isDirectory()) throw new SyncError(`unsupported file type: ${rel}`);
  }
  return out;
}

/** Hashes every file below `dir` (except the manifest); the digest covers paths and contents. */
export async function hashTree(dir) {
  const files = {};
  for (const rel of (await walk(dir)).sort()) {
    files[rel] = createHash('sha256').update(await fs.readFile(path.join(dir, rel))).digest('hex');
  }
  const digest = createHash('sha256');
  for (const [rel, sha] of Object.entries(files)) digest.update(`${sha}  ${rel}\n`);
  return { files, digest: digest.digest('hex'), fileCount: Object.keys(files).length };
}

export function diffTrees(expected, actual) {
  const changed = [];
  for (const rel of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    if (!(rel in actual)) changed.push(`missing   ${rel}`);
    else if (!(rel in expected)) changed.push(`added     ${rel}`);
    else if (expected[rel] !== actual[rel]) changed.push(`modified  ${rel}`);
  }
  return changed.sort((a, b) => a.slice(10).localeCompare(b.slice(10)));
}

async function extractCommit(repo, commit, paths, dest) {
  await fs.mkdir(dest, { recursive: true });
  const archive = git(repo, ['archive', '--format=tar', commit, '--', ...paths], { encoding: 'buffer' });
  run('tar', ['-x', '-f', '-', '-C', dest], { input: archive, encoding: 'buffer' });
}

/** Produces the upstream files for `commit` in a fresh directory and returns that directory. */
async function produce(root, name, entry, commit) {
  const repo = upstreamRepo(root, name, entry);
  const work = path.join(root, '.cache', 'upstream', name, commit);
  await fs.rm(work, { recursive: true, force: true });
  const out = path.join(work, 'out');
  if (entry.mode === 'committed') {
    await extractCommit(repo, commit, entry.sources.map((s) => s.from), path.join(work, 'src'));
  } else if (entry.mode === 'build') {
    const src = path.join(work, 'src');
    await extractCommit(repo, commit, ['.'], src);
    for (const step of entry.build) {
      console.log(`[${name}] ${step.join(' ')}`);
      run(step[0], step.slice(1), { cwd: src, inherit: true, shell: true });
    }
  } else {
    throw new SyncError(`${name}: unknown mode ${entry.mode}`);
  }
  for (const source of entry.sources) {
    const from = path.join(work, 'src', source.from);
    await fs.stat(from).catch(() => { throw new SyncError(`${name}: ${source.from} does not exist at ${commit}`); });
    await fs.cp(from, path.join(out, source.to), { recursive: true });
  }
  return { work, out };
}

async function readManifest(target) {
  try {
    return JSON.parse(await fs.readFile(path.join(target, MANIFEST_NAME), 'utf8'));
  } catch {
    return null;
  }
}

async function place(root, name, entry, commit, tree, out) {
  const target = path.join(root, entry.target);
  await fs.rm(target, { recursive: true, force: true });
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.rename(out, target);
  const manifest = { name, commit, digest: tree.digest, files: tree.files };
  await fs.writeFile(path.join(target, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
}

export async function checkOne(root, name, entry) {
  const target = path.join(root, entry.target);
  const manifest = await readManifest(target);
  if (!manifest) return { ok: false, reason: `${entry.target} is missing; run: npm run sync:install` };
  const tree = await hashTree(target);
  if (manifest.commit !== entry.commit || manifest.digest !== entry.digest) {
    return { ok: false, reason: `${entry.target} holds ${manifest.commit.slice(0, 10)}, the lock pins ${entry.commit.slice(0, 10)}; run: npm run sync:install` };
  }
  if (tree.digest !== entry.digest) {
    return {
      ok: false,
      reason: `${entry.target} was edited by hand. Change the editor upstream and pin the new commit instead.`,
      changed: diffTrees(manifest.files, tree.files),
    };
  }
  return { ok: true };
}

export async function install(root, names, { force = false } = {}) {
  const lock = await readLock(root);
  for (const name of selectNames(lock, names)) {
    const entry = lock.upstreams[name];
    if (!force && (await checkOne(root, name, entry)).ok) {
      console.log(`[${name}] up to date at ${entry.commit.slice(0, 10)}`);
      continue;
    }
    const { work, out } = await produce(root, name, entry, entry.commit);
    const tree = await hashTree(out);
    if (tree.digest !== entry.digest) {
      throw new SyncError(`[${name}] ${entry.commit.slice(0, 10)} produced digest ${tree.digest.slice(0, 16)}…, `
        + `the lock expects ${entry.digest.slice(0, 16)}…. The build is not reproducible on this machine or the lock is stale.`);
    }
    await place(root, name, entry, entry.commit, tree, out);
    await fs.rm(work, { recursive: true, force: true });
    console.log(`[${name}] installed ${tree.fileCount} files from ${entry.commit.slice(0, 10)}`);
  }
}

export async function update(root, name, ref) {
  const lock = await readLock(root);
  const entry = lock.upstreams[name];
  if (!entry) throw new SyncError(`unknown upstream: ${name}`);
  const repo = upstreamRepo(root, name, entry);
  const commit = git(repo, ['rev-parse', '--verify', `${ref || entry.ref}^{commit}`]).trim();
  const previous = entry.commit;
  const { work, out } = await produce(root, name, entry, commit);
  const tree = await hashTree(out);
  Object.assign(entry, { commit, digest: tree.digest, fileCount: tree.fileCount });
  await place(root, name, entry, commit, tree, out);
  await fs.rm(work, { recursive: true, force: true });
  await writeLock(root, lock);
  console.log(`[${name}] pinned ${commit.slice(0, 10)} (${tree.fileCount} files)`);
  if (previous && previous !== commit) {
    const log = git(repo, ['log', '--oneline', '--no-merges', `${previous}..${commit}`, '--', ...entry.watch]).trim();
    console.log(log ? `Upstream changes since ${previous.slice(0, 10)}:\n${log}` : 'No upstream changes in the watched paths.');
  }
}

export async function status(root, names) {
  const lock = await readLock(root);
  for (const name of selectNames(lock, names)) {
    const entry = lock.upstreams[name];
    const repo = upstreamRepo(root, name, entry);
    const head = git(repo, ['rev-parse', '--verify', `${entry.ref}^{commit}`]).trim();
    const behind = git(repo, ['rev-list', '--count', `${entry.commit}..${head}`, '--', ...entry.watch]).trim();
    const local = await checkOne(root, name, entry);
    console.log(`[${name}] pinned ${entry.commit.slice(0, 10)}, ${entry.ref} is ${head.slice(0, 10)}: `
      + `${behind} commit(s) behind in the watched paths; local copy ${local.ok ? 'matches' : 'does not match'} the lock`);
  }
}

function selectNames(lock, names) {
  const all = Object.keys(lock.upstreams);
  for (const name of names) if (!all.includes(name)) throw new SyncError(`unknown upstream: ${name}`);
  return names.length ? names : all;
}

async function main(argv) {
  const [command, ...rest] = argv;
  const root = process.env.BERGWORK_ROOT ? path.resolve(process.env.BERGWORK_ROOT) : defaultRoot;
  const refAt = rest.indexOf('--ref');
  const ref = refAt >= 0 ? rest.splice(refAt, 2)[1] : undefined;
  const force = rest.includes('--force');
  const names = rest.filter((arg) => arg !== '--force');
  if (command === 'install') return install(root, names, { force });
  if (command === 'update' && names.length === 1) return update(root, names[0], ref);
  if (command === 'status') return status(root, names);
  if (command === 'check') {
    const lock = await readLock(root);
    let failed = false;
    for (const name of selectNames(lock, names)) {
      const result = await checkOne(root, name, lock.upstreams[name]);
      console.log(`[${name}] ${result.ok ? 'OK' : result.reason}`);
      for (const line of (result.changed || []).slice(0, 40)) console.log(`  ${line}`);
      failed ||= !result.ok;
    }
    if (failed) process.exitCode = 1;
    return;
  }
  throw new SyncError('usage: sync-upstream.mjs install|check|status [name…] | update <name> [--ref <rev>]');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof SyncError ? error.message : error);
    process.exitCode = 1;
  });
}
