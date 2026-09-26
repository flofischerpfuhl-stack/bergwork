#!/usr/bin/env node
// Assembles apps/pdf/dist/, the frontendDist of the Tauri app:
//
//   dist/                      ← apps/pdf/web/* (host page, owned here)
//   dist/tools/vendor/<name>/  ← apps/pdf/upstream/tools/vendor/<name>/ (pinned editor build, never edited)
//
// The editor bundle fetches its workers, WASM and fonts from absolute /tools/vendor/... URLs, so the vendor
// directories have to sit at exactly that path below the dist root. No dependencies; Node 22.
import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const webDir = path.join(appDir, 'web');
const vendorSource = path.join(appDir, 'upstream', 'tools', 'vendor');
const distDir = path.join(appDir, 'dist');
const vendorTarget = path.join(distDir, 'tools', 'vendor');
const VENDOR_DIRS = ['pdf-tools', 'pdf-runtime', 'tesseract-5.0.4'];

async function isDirectory(dir) {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

async function sizeOf(dir) {
  let bytes = 0;
  let files = 0;
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    bytes += (await stat(path.join(entry.parentPath, entry.name))).size;
    files += 1;
  }
  return { bytes, files };
}

const missing = [];
for (const name of VENDOR_DIRS) {
  if (!(await isDirectory(path.join(vendorSource, name)))) missing.push(name);
}
if (missing.length) {
  console.error(`build-frontend: the pinned editor build is missing (${missing.join(', ')} in ${vendorSource}).`);
  console.error('Run `npm run sync:install` in the repository root first.');
  process.exit(1);
}
if (!(await isDirectory(webDir))) {
  console.error(`build-frontend: ${webDir} does not exist.`);
  process.exit(1);
}

// Empty dist/ rather than deleting it, so a static server running in it (browser preview) keeps working.
await mkdir(distDir, { recursive: true });
for (const entry of await readdir(distDir)) await rm(path.join(distDir, entry), { recursive: true, force: true });
await mkdir(vendorTarget, { recursive: true });
await cp(webDir, distDir, { recursive: true });
for (const name of VENDOR_DIRS) {
  await cp(path.join(vendorSource, name), path.join(vendorTarget, name), { recursive: true });
}

// Licences view data (Settings → Licences); needs cargo, which every app build has.
try {
  execFileSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'collect-licenses.mjs')], { stdio: 'inherit' });
} catch (error) {
  console.warn(`build-frontend: licence list not generated (${error.message}); the Licences view will say so.`);
}

const { bytes, files } = await sizeOf(distDir);
console.log(`build-frontend: ${path.relative(process.cwd(), distDir) || '.'} (${files} files, ${(bytes / 2 ** 20).toFixed(1)} MiB)`);
