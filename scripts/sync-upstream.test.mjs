import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { MANIFEST_NAME, checkOne, hashTree, install, readLock, update, upstreamRepo } from './sync-upstream.mjs';

const quiet = { log: console.log };

async function withFixture(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bergwork-sync-'));
  const upstream = path.join(dir, 'upstream');
  const root = path.join(dir, 'bergwork');
  const git = (...args) => execFileSync('git', ['-C', upstream, ...args], { encoding: 'utf8' }).trim();
  const commitFile = async (rel, text) => {
    await fs.mkdir(path.dirname(path.join(upstream, rel)), { recursive: true });
    await fs.writeFile(path.join(upstream, rel), text);
    git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', `edit ${rel}`);
    return git('rev-parse', 'HEAD');
  };
  await fs.mkdir(upstream, { recursive: true });
  await fs.mkdir(root, { recursive: true });
  git('init', '-q', '-b', 'main');
  await commitFile('bundle/app.js', 'one');
  await fs.writeFile(path.join(root, 'upstream.lock.json'), JSON.stringify({
    schemaVersion: 1,
    upstreams: {
      editor: {
        repo: '../upstream', ref: 'main', mode: 'committed',
        sources: [{ from: 'bundle', to: 'vendor/bundle' }],
        watch: ['bundle'], target: 'apps/x/upstream', commit: '', digest: '', fileCount: 0,
      },
    },
  }));
  console.log = () => {};
  try {
    await fn({ root, commitFile });
  } finally {
    console.log = quiet.log;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('update pins the upstream head and materialises the mapped files', () => withFixture(async ({ root }) => {
  await update(root, 'editor');
  const lock = await readLock(root);
  const entry = lock.upstreams.editor;
  assert.match(entry.commit, /^[0-9a-f]{40}$/);
  assert.equal(entry.fileCount, 1);
  const target = path.join(root, 'apps/x/upstream');
  assert.equal(await fs.readFile(path.join(target, 'vendor/bundle/app.js'), 'utf8'), 'one');
  assert.equal((await hashTree(target)).digest, entry.digest, 'the manifest is not part of the digest');
  assert.deepEqual(await checkOne(root, 'editor', entry), { ok: true });
}));

test('check reports hand edits with the changed files', () => withFixture(async ({ root }) => {
  await update(root, 'editor');
  const target = path.join(root, 'apps/x/upstream');
  await fs.writeFile(path.join(target, 'vendor/bundle/app.js'), 'patched');
  await fs.writeFile(path.join(target, 'extra.js'), 'new');
  const result = await checkOne(root, 'editor', (await readLock(root)).upstreams.editor);
  assert.equal(result.ok, false);
  assert.match(result.reason, /edited by hand/);
  assert.deepEqual(result.changed, ['added     extra.js', 'modified  vendor/bundle/app.js']);
}));

test('install restores the pinned commit even after upstream moved on', () => withFixture(async ({ root, commitFile }) => {
  await update(root, 'editor');
  const pinned = (await readLock(root)).upstreams.editor.commit;
  await commitFile('bundle/app.js', 'two');
  await fs.rm(path.join(root, 'apps/x/upstream'), { recursive: true });
  assert.match((await checkOne(root, 'editor', (await readLock(root)).upstreams.editor)).reason, /missing/);
  await install(root, []);
  const target = path.join(root, 'apps/x/upstream');
  assert.equal(await fs.readFile(path.join(target, 'vendor/bundle/app.js'), 'utf8'), 'one');
  assert.equal(JSON.parse(await fs.readFile(path.join(target, MANIFEST_NAME), 'utf8')).commit, pinned);
}));

test('install refuses a build whose digest differs from the lock', () => withFixture(async ({ root }) => {
  await update(root, 'editor');
  const lock = await readLock(root);
  lock.upstreams.editor.digest = '0'.repeat(64);
  await fs.writeFile(path.join(root, 'upstream.lock.json'), JSON.stringify(lock));
  await assert.rejects(install(root, ['editor']), /not reproducible on this machine or the lock is stale/);
}));

test('an environment variable overrides the upstream checkout', () => {
  const entry = { repo: '../17_fernwork' };
  assert.equal(upstreamRepo('/r/bergwork', 'fernwork-pdf', entry, {}), path.resolve('/r/17_fernwork'));
  assert.equal(upstreamRepo('/r/bergwork', 'fernwork-pdf', entry, { BERGWORK_UPSTREAM_FERNWORK_PDF: '/src/fw' }),
    path.resolve('/src/fw'));
});
