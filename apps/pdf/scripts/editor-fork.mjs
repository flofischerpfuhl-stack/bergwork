#!/usr/bin/env node
// The PDF editor's source fork. berg:work owns a copy of the Fernwork PDF editor's UI sources (the PDF Tools shell
// and everything it imports) under apps/pdf/editor/, laid out with Fernwork's paths, so its interface can follow the
// berg:work design base. Workers, WebAssembly, fonts and the OCR engine still come from the pinned build in
// upstream.lock.json; fork and pin always name the same Fernwork commit.
//
//   node apps/pdf/scripts/editor-fork.mjs init [--ref <rev>]   copy the sources at <rev> (default: the pinned commit)
//   node apps/pdf/scripts/editor-fork.mjs status [--ref <rev>]  Fernwork commits since the fork's base, per file
//   node apps/pdf/scripts/editor-fork.mjs port [--ref <rev>]   apply Fernwork's changes since the base to the fork
//   node apps/pdf/scripts/editor-fork.mjs check                fork and pin agree; every listed file exists
//
// `port` applies Fernwork's diff with `git apply --reject`: hunks that clash with berg:work's own changes are left
// as `<file>.rej` next to the file. Resolve those by hand, delete the .rej files, then pin the same commit with
// `npm run sync:update -- fernwork-pdf --ref <commit>` (the skill bergwork-pdf-sync walks through it).
// The Fernwork checkout is the one upstream.lock.json names, overridable with BERGWORK_UPSTREAM_FERNWORK_PDF.

import { spawnSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLock, upstreamRepo } from '../../../scripts/sync-upstream.mjs';

const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const root = path.resolve(appDir, '../..');
const forkDir = path.join(appDir, 'editor');
const forkFile = path.join(forkDir, 'fork.json');
const UPSTREAM = 'fernwork-pdf';
/** Walked through their relative imports; `extras` are taken as they are (stylesheets). */
const ENTRIES = ['vendor/build/src/pdf-tools-shell.jsx'];
const EXTRAS = ['vendor/build/src/pdf-tools-theme.css'];

function git(repo, args, { input, allowFail = false } = {}) {
  // English messages: port() reads git apply's reject report.
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', input, maxBuffer: 1 << 30, env: { ...process.env, LC_ALL: 'C' } });
  if (result.status !== 0 && !allowFail) throw new Error(`git ${args.join(' ')}: ${result.stderr.trim()}`);
  return result;
}

async function upstream() {
  const lock = await readLock(root);
  const entry = lock.upstreams[UPSTREAM];
  return { entry, repo: upstreamRepo(root, UPSTREAM, entry) };
}

const resolveCommit = (repo, ref) => git(repo, ['rev-parse', '--verify', `${ref}^{commit}`]).stdout.trim();

/** Every file reachable from ENTRIES through relative static or dynamic imports, read from the commit itself. */
function sourceFiles(repo, commit) {
  const tree = new Set(git(repo, ['ls-tree', '-r', '--name-only', commit]).stdout.split('\n').filter(Boolean));
  const pattern = /(?:import|export)\s[^'"]*?from\s*['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)|import\s*['"](\.[^'"]+)['"]/g;
  const seen = new Set();
  const stack = [...ENTRIES];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.(m?js|jsx)$/.test(file)) continue;
    const text = git(repo, ['show', `${commit}:${file}`]).stdout;
    for (const match of text.matchAll(pattern)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1] ?? match[2] ?? match[3]));
      const found = [target, `${target}.js`, `${target}.jsx`, `${target}/index.js`].find((candidate) => tree.has(candidate));
      if (found) stack.push(found);
    }
  }
  for (const extra of EXTRAS) if (tree.has(extra)) seen.add(extra);
  return [...seen].sort();
}

async function readFork() {
  if (!existsSync(forkFile)) throw new Error(`${path.relative(root, forkFile)} is missing; run: editor-fork.mjs init`);
  return JSON.parse(await fs.readFile(forkFile, 'utf8'));
}

async function writeFork(commit, files) {
  const fork = {
    schemaVersion: 1,
    upstream: UPSTREAM,
    description: 'Fernwork PDF editor sources forked into berg:work; paths as in Fernwork. See apps/pdf/scripts/editor-fork.mjs.',
    commit,
    entries: ENTRIES,
    extras: EXTRAS,
    files,
  };
  await fs.writeFile(forkFile, `${JSON.stringify(fork, null, 2)}\n`);
}

async function init(ref) {
  const { entry, repo } = await upstream();
  const commit = resolveCommit(repo, ref ?? entry.commit);
  const files = sourceFiles(repo, commit);
  for (const file of files) {
    const out = path.join(forkDir, file);
    await fs.mkdir(path.dirname(out), { recursive: true });
    const blob = spawnSync('git', ['-C', repo, 'show', `${commit}:${file}`], { maxBuffer: 1 << 30 });
    await fs.writeFile(out, blob.stdout);
  }
  await writeFork(commit, files);
  console.log(`editor fork: ${files.length} files from ${commit.slice(0, 10)} in ${path.relative(root, forkDir)}/`);
  if (commit !== entry.commit) console.log(`Pin the same commit: npm run sync:update -- ${UPSTREAM} --ref ${commit}`);
}

async function status(ref) {
  const fork = await readFork();
  const { entry, repo } = await upstream();
  const head = resolveCommit(repo, ref ?? entry.ref);
  const log = git(repo, ['log', '--oneline', `${fork.commit}..${head}`, '--', ...fork.files]).stdout.trim();
  console.log(`editor fork at ${fork.commit.slice(0, 10)}, ${ref ?? entry.ref} is ${head.slice(0, 10)}`);
  console.log(log ? log : 'No Fernwork changes to the forked files.');
  const added = sourceFiles(repo, head).filter((file) => !fork.files.includes(file));
  if (added.length) console.log(`Files the editor imports at ${head.slice(0, 10)} that the fork lacks:\n  ${added.join('\n  ')}`);
}

async function port(ref) {
  const fork = await readFork();
  const { entry, repo } = await upstream();
  const target = resolveCommit(repo, ref ?? entry.ref);
  if (target === fork.commit) { console.log('editor fork: already at', target.slice(0, 10)); return; }
  const files = sourceFiles(repo, target);
  const paths = [...new Set([...fork.files, ...files])];
  const patch = git(repo, ['diff', '--binary', '--no-renames', fork.commit, target, '--', ...paths]).stdout;
  const prefix = path.relative(root, forkDir).split(path.sep).join('/');
  let rejected = [];
  if (patch.trim()) {
    const applied = git(root, ['apply', '--reject', '--whitespace=nowarn', `--directory=${prefix}`, '-'], { input: patch, allowFail: true });
    rejected = [...applied.stderr.matchAll(/Rejected hunk #\d+\.|Applying patch (\S+) with (\d+) reject/g)]
      .filter((match) => match[1]).map((match) => `${match[1]} (${match[2]} rejected)`);
    if (applied.status !== 0 && !rejected.length) throw new Error(`git apply failed:\n${applied.stderr}`);
  }
  // A file that is newly imported but unchanged since the base is not in the diff.
  for (const file of files) {
    const local = path.join(forkDir, file);
    if (existsSync(local)) continue;
    await fs.mkdir(path.dirname(local), { recursive: true });
    await fs.writeFile(local, git(repo, ['show', `${target}:${file}`]).stdout);
  }
  const dropped = fork.files.filter((file) => !files.includes(file));
  await writeFork(target, files);
  console.log(git(repo, ['log', '--oneline', `${fork.commit}..${target}`, '--', ...paths]).stdout.trim() || '(no commits)');
  console.log(`\neditor fork: ${fork.commit.slice(0, 10)} -> ${target.slice(0, 10)}, ${files.length} files`);
  if (dropped.length) console.log(`No longer imported (delete if berg:work does not use them):\n  ${dropped.join('\n  ')}`);
  if (rejected.length) console.log(`Conflicts left as .rej files:\n  ${rejected.join('\n  ')}`);
  console.log(`Then pin the same commit: npm run sync:update -- ${UPSTREAM} --ref ${target}`);
}

async function check() {
  const fork = await readFork();
  const { entry } = await upstream();
  const problems = [];
  if (fork.commit !== entry.commit) problems.push(`fork is at ${fork.commit.slice(0, 10)}, the pin at ${entry.commit.slice(0, 10)}`);
  for (const file of fork.files) if (!existsSync(path.join(forkDir, file))) problems.push(`missing ${file}`);
  const rejects = (await fs.readdir(forkDir, { recursive: true })).filter((file) => file.endsWith('.rej'));
  for (const file of rejects) problems.push(`unresolved ${file}`);
  if (problems.length) { console.error(`editor fork:\n  ${problems.join('\n  ')}`); process.exit(1); }
  console.log(`editor fork: ${fork.files.length} files at ${fork.commit.slice(0, 10)}, matches the pin`);
}

const [command, ...rest] = process.argv.slice(2);
const refIndex = rest.indexOf('--ref');
const ref = refIndex >= 0 ? rest[refIndex + 1] : undefined;
const commands = { init: () => init(ref), status: () => status(ref), port: () => port(ref), check };
if (!commands[command]) {
  console.error('usage: editor-fork.mjs init|status|port|check [--ref <rev>]');
  process.exit(2);
}
await commands[command]();
