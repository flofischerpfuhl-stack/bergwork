#!/usr/bin/env node
// Fetch and verify the berg:work PDF test corpus described by manifest.json.
//
// The PDFs themselves are third-party files and never live in this repository; this
// script downloads them into the corpus root (env BERGWORK_PDF_CORPUS, default
// ~/AgentWork/bergwork-pdf-corpus) and verifies size + sha256 of every file.
//
// Usage:
//   node fetch-corpus.mjs [--verify-only] [--source <id>[,<id>...]] [--tags a,b] [--all-tags]
//                         [--limit N] [--jobs N] [--manifest path] [--root dir] [--quiet]
//
//   --verify-only   do not download anything, only check what is on disk
//   --source        only entries of these source ids
//   --tags a,b      only entries carrying at least one of these tags (with --all-tags: all of them)
//   --limit N       only the first N selected entries (manifest order)
//   --jobs N        parallel downloads (default 4, capped at 6)
//
// Exit code 0 when every selected file is present and matches, 1 otherwise.
// Entries with an "archive" field are zip members: the member is extracted with HTTP
// range requests (only the central directory and the member's bytes are transferred);
// if the server does not support ranges the whole archive is downloaded once into
// <root>/.archives/, verified against archive.sha256 and the member is extracted from it.
// Node >= 22, no dependencies.

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const UA = 'bergwork-pdf-corpus/1 (+https://bergwork.app)';
const HERE = path.dirname(fileURLToPath(import.meta.url));
// Minimum delay between two requests to the same host (robots.txt crawl-delay / courtesy).
const HOST_DELAY_MS = {
  'arxiv.org': 15000,
  'archive.org': 2000,
  'ntrs.nasa.gov': 1500,
  'www.irs.gov': 1000,
  'www.ohchr.org': 1000,
  'upload.wikimedia.org': 500,
  'digitalcorpora.s3.amazonaws.com': 500,
  'prd-tnm.s3.amazonaws.com': 500,
};
const RETRIES = 4;
const REQUEST_TIMEOUT_MS = 30 * 60 * 1000; // generous: some files are > 100 MB

function parseArgs(argv) {
  const a = { verifyOnly: false, sources: null, tags: null, allTags: false, limit: Infinity, jobs: 4,
    manifest: path.join(HERE, 'manifest.json'), root: null, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Error(`missing value for ${k}`);
      return argv[++i];
    };
    if (k === '--verify-only') a.verifyOnly = true;
    else if (k === '--source') a.sources = new Set(val().split(',').filter(Boolean));
    else if (k === '--tags') a.tags = val().split(',').filter(Boolean);
    else if (k === '--all-tags') a.allTags = true;
    else if (k === '--limit') a.limit = Number(val());
    else if (k === '--jobs') a.jobs = Math.max(1, Math.min(6, Number(val()) || 4));
    else if (k === '--manifest') a.manifest = path.resolve(val());
    else if (k === '--root') a.root = val();
    else if (k === '--quiet') a.quiet = true;
    else if (k === '-h' || k === '--help') {
      console.log(`usage: node fetch-corpus.mjs [--verify-only] [--source id,...] [--tags a,b] [--all-tags] [--limit N] [--jobs N] [--manifest path] [--root dir]`);
      process.exit(0);
    } else throw new Error(`unknown argument ${k}`);
  }
  return a;
}

function expandHome(p) {
  return p.startsWith('~/') || p === '~' ? path.join(os.homedir(), p.slice(1)) : p;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- per-host politeness: serialise requests to hosts that ask for a crawl delay
const hostNext = new Map();
async function hostGate(url) {
  const host = new URL(url).hostname;
  const delay = HOST_DELAY_MS[host] ?? 0;
  if (!delay) return;
  // chain on a per-host promise so that concurrent workers queue up
  const prev = hostNext.get(host) ?? Promise.resolve();
  let release;
  const p = new Promise((r) => (release = r));
  hostNext.set(host, prev.then(() => p));
  await prev;
  setTimeout(release, delay);
}

async function httpGet(url, { range, accept } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    if (attempt) await sleep(1000 * 2 ** attempt);
    await hostGate(url);
    try {
      const headers = { 'User-Agent': UA };
      if (range) headers.Range = `bytes=${range[0]}-${range[1]}`;
      if (accept) headers.Accept = accept;
      const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
        const ra = Number(res.headers.get('retry-after'));
        if (ra) await sleep(Math.min(ra, 120) * 1000);
        continue;
      }
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { fatal: true });
      const buf = Buffer.from(await res.arrayBuffer());
      return { buf, status: res.status, headers: res.headers };
    } catch (e) {
      lastErr = e;
      if (e.fatal) break;
    }
  }
  throw lastErr;
}

// Stream a plain URL to disk (temp file + rename) while hashing; never holds the file in memory.
async function downloadTo(url, dest, entry) {
  let lastErr;
  await mkdir(path.dirname(dest), { recursive: true });
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    if (attempt) await sleep(1000 * 2 ** attempt);
    await hostGate(url);
    const tmp = `${dest}.part-${process.pid}-${Math.random().toString(36).slice(2)}`;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
        const ra = Number(res.headers.get('retry-after'));
        if (ra) await sleep(Math.min(ra, 120) * 1000);
        await res.body?.cancel();
        continue;
      }
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { fatal: true });
      const h = createHash('sha256');
      const out = createWriteStream(tmp);
      let n = 0;
      try {
        for await (const chunk of res.body) {
          n += chunk.length;
          if (n > entry.bytes) throw Object.assign(new Error(`more than ${entry.bytes} bytes`), { result: 'size' });
          h.update(chunk);
          if (!out.write(chunk)) await once(out, 'drain');
        }
      } finally {
        await new Promise((r) => out.end(r));
      }
      if (n !== entry.bytes) return { status: 'size', detail: `got ${n} bytes, expected ${entry.bytes}` };
      const hex = h.digest('hex');
      if (hex !== entry.sha256) return { status: 'sha256', detail: `got ${hex}` };
      await rename(tmp, dest);
      return { status: 'ok', bytes: n };
    } catch (e) {
      if (e.result) return { status: e.result, detail: e.message };
      lastErr = e;
      if (e.fatal) break;
    } finally {
      await rm(tmp, { force: true });
    }
  }
  throw lastErr;
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function sha256File(p) {
  const h = createHash('sha256');
  await new Promise((res, rej) => {
    createReadStream(p).on('data', (d) => h.update(d)).on('end', res).on('error', rej);
  });
  return h.digest('hex');
}

async function atomicWrite(dest, buf) {
  await mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part-${process.pid}-${Math.random().toString(36).slice(2)}`;
  await writeFile(tmp, buf);
  await rename(tmp, dest);
}

// ---- zip member extraction (central directory based; zip64 for large archives)
function findEocd(tail) {
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error('zip: end of central directory not found');
}

async function zipMember(readRange, totalSize, member) {
  const tailLen = Math.min(totalSize, 65557 + 20);
  const tail = await readRange(totalSize - tailLen, totalSize - 1);
  const e = findEocd(tail);
  let cdSize = tail.readUInt32LE(e + 12);
  let cdOff = tail.readUInt32LE(e + 16);
  if (cdOff === 0xffffffff || cdSize === 0xffffffff) {
    const loc = e - 20; // zip64 locator
    if (loc < 0 || tail.readUInt32LE(loc) !== 0x07064b50) throw new Error('zip: zip64 locator missing');
    const z64off = Number(tail.readBigUInt64LE(loc + 8));
    const z64 = await readRange(z64off, z64off + 55);
    cdSize = Number(z64.readBigUInt64LE(40));
    cdOff = Number(z64.readBigUInt64LE(48));
  }
  const cd = await readRange(cdOff, cdOff + cdSize - 1);
  let p = 0;
  while (p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50) {
    const method = cd.readUInt16LE(p + 10);
    let csize = cd.readUInt32LE(p + 20);
    let usize = cd.readUInt32LE(p + 24);
    const nlen = cd.readUInt16LE(p + 28);
    const xlen = cd.readUInt16LE(p + 30);
    const clen = cd.readUInt16LE(p + 32);
    let lho = cd.readUInt32LE(p + 42);
    const name = cd.subarray(p + 46, p + 46 + nlen).toString('utf8');
    if (name === member) {
      // zip64 extra field
      let x = p + 46 + nlen;
      const xend = x + xlen;
      while (x + 4 <= xend) {
        const id = cd.readUInt16LE(x);
        const sz = cd.readUInt16LE(x + 2);
        if (id === 1) {
          let q = x + 4;
          if (usize === 0xffffffff) { usize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (csize === 0xffffffff) { csize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (lho === 0xffffffff) { lho = Number(cd.readBigUInt64LE(q)); q += 8; }
        }
        x += 4 + sz;
      }
      const lh = await readRange(lho, lho + 29);
      if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error('zip: bad local header');
      const dataOff = lho + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      const data = csize ? await readRange(dataOff, dataOff + csize - 1) : Buffer.alloc(0);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data);
      throw new Error(`zip: unsupported compression method ${method}`);
    }
    p += 46 + nlen + xlen + clen;
  }
  throw new Error(`zip: member not found: ${member}`);
}

const archiveSizes = new Map();
async function fetchArchiveMember(entry, root) {
  const { url, member } = entry.archive;
  // 1) HTTP range requests
  try {
    let size = archiveSizes.get(url);
    if (size === undefined) {
      const probe = await httpGet(url, { range: [0, 0] });
      const cr = probe.headers.get('content-range');
      if (probe.status !== 206 || !cr) throw new Error('no range support');
      size = Number(cr.split('/')[1]);
      archiveSizes.set(url, size);
    }
    const readRange = async (a, b) => {
      const r = await httpGet(url, { range: [a, b] });
      if (r.status !== 206) throw new Error('no range support');
      return r.buf;
    };
    return await zipMember(readRange, size, member);
  } catch (e) {
    if (!/range/.test(String(e.message))) throw e;
  }
  // 2) full archive download (cached, verified)
  const cache = path.join(root, '.archives', `${entry.archive.sha256}.zip`);
  let ok = false;
  try {
    ok = (await sha256File(cache)) === entry.archive.sha256;
  } catch {}
  if (!ok) {
    const { buf } = await httpGet(url);
    if (sha256(buf) !== entry.archive.sha256) throw new Error('archive sha256 mismatch');
    await atomicWrite(cache, buf);
  }
  const fh = await open(cache, 'r');
  try {
    const { size } = await fh.stat();
    const readRange = async (a, b) => {
      const buf = Buffer.alloc(b - a + 1);
      await fh.read(buf, 0, buf.length, a);
      return buf;
    };
    return await zipMember(readRange, size, member);
  } finally {
    await fh.close();
  }
}

async function checkFile(p, entry) {
  let st;
  try {
    st = await stat(p);
  } catch {
    return 'missing';
  }
  if (st.size !== entry.bytes) return 'size';
  return (await sha256File(p)) === entry.sha256 ? 'ok' : 'sha256';
}

async function processEntry(entry, root, verifyOnly) {
  const dest = path.join(root, entry.id);
  const state = await checkFile(dest, entry);
  if (state === 'ok') return { status: 'ok' };
  if (verifyOnly) return { status: state };
  const fresh = state === 'missing' ? 'fetched' : 'replaced';
  if (!entry.archive) {
    const r = await downloadTo(entry.url, dest, entry);
    return r.status === 'ok' ? { status: fresh, bytes: r.bytes } : r;
  }
  const buf = await fetchArchiveMember(entry, root);
  if (buf.length !== entry.bytes) return { status: 'size', detail: `got ${buf.length} bytes, expected ${entry.bytes}` };
  const h = sha256(buf);
  if (h !== entry.sha256) return { status: 'sha256', detail: `got ${h}` };
  await atomicWrite(dest, buf);
  return { status: fresh, bytes: buf.length };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(await readFile(args.manifest, 'utf8'));
  const root = path.resolve(expandHome(args.root || process.env.BERGWORK_PDF_CORPUS || manifest.defaultRoot || '~/AgentWork/bergwork-pdf-corpus'));
  let entries = manifest.files.filter((e) => {
    if (args.sources && !args.sources.has(e.source)) return false;
    if (args.tags) {
      const has = (t) => e.tags.includes(t);
      if (args.allTags ? !args.tags.every(has) : !args.tags.some(has)) return false;
    }
    return true;
  });
  if (Number.isFinite(args.limit)) entries = entries.slice(0, args.limit);
  const t0 = Date.now();
  const counts = {};
  const problems = [];
  let fetchedBytes = 0;
  let done = 0;
  const queue = entries.slice();
  async function worker() {
    for (let entry = queue.shift(); entry; entry = queue.shift()) {
      let r;
      try {
        r = await processEntry(entry, root, args.verifyOnly);
      } catch (e) {
        r = { status: 'error', detail: String(e.message || e) };
      }
      counts[r.status] = (counts[r.status] || 0) + 1;
      if (r.bytes) fetchedBytes += r.bytes;
      done++;
      if (!['ok', 'fetched', 'replaced'].includes(r.status)) problems.push({ id: entry.id, ...r });
      if (!args.quiet && (r.status !== 'ok' || done % 100 === 0)) {
        console.log(`[${done}/${entries.length}] ${r.status.padEnd(8)} ${entry.id}${r.detail ? `  (${r.detail})` : ''}`);
      }
    }
  }
  await Promise.all(Array.from({ length: args.verifyOnly ? 6 : args.jobs }, worker));
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const totalBytes = entries.reduce((s, e) => s + e.bytes, 0);
  console.log(`\ncorpus root: ${root}`);
  console.log(`selected ${entries.length} files (${(totalBytes / 1e9).toFixed(2)} GB) in ${secs}s` +
    (fetchedBytes ? `, downloaded ${(fetchedBytes / 1e6).toFixed(1)} MB` : ''));
  console.log(Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(', '));
  if (problems.length) {
    console.log(`\n${problems.length} problem(s):`);
    for (const p of problems.slice(0, 50)) console.log(`  ${p.status.padEnd(8)} ${p.id}${p.detail ? `  ${p.detail}` : ''}`);
    if (problems.length > 50) console.log(`  ... and ${problems.length - 50} more`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
