#!/usr/bin/env node
// Assembles apps/pdf/dist/, the frontendDist of the Tauri app:
//
//   dist/                      ← apps/pdf/web/ built with Vite (host page on the design base, owned here)
//   dist/tools/vendor/<name>/  ← apps/pdf/upstream/tools/vendor/<name>/ (pinned editor build, never edited)
//   dist/tools/js/converters/heic-decode-worker.js
//                              ← the pinned HEIC worker, with libheif addressed relative to it
//   dist/tools/vendor/pdf-tools/{oo-pdf-tools.js,oo-pdf-tools.css,chunks/}
//                              ← the editor built from berg:work's source fork (editor/, scripts/build-editor.mjs)
//
// The editor finds its workers, WASM and fonts below tools/vendor/ next to the page (web/src/editor.ts), so the same
// dist/ serves the desktop app and the web app at /app/pdf/. Node 22 and the workspace's devDependencies (npm install).
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const webDir = path.join(appDir, 'web');
const vendorSource = path.join(appDir, 'upstream', 'tools', 'vendor');
const distDir = path.join(appDir, 'dist');
const vendorTarget = path.join(distDir, 'tools', 'vendor');
const VENDOR_DIRS = ['pdf-tools', 'pdf-runtime', 'tesseract-5.0.4', 'libheif-js-1.23.5'];

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

// Vite empties dist/ rather than deleting it, so a static server running in it (browser preview) keeps working.
execFileSync('npx', ['vite', 'build', '--logLevel', 'warn'], { cwd: appDir, stdio: 'inherit', shell: process.platform === 'win32' });
await mkdir(vendorTarget, { recursive: true });
for (const name of VENDOR_DIRS) {
  await cp(path.join(vendorSource, name), path.join(vendorTarget, name), { recursive: true });
}

// Fernwork's HEIC worker loads libheif from the root of fernwork.net. The pair keeps its relative place here, so one
// relative path serves the desktop app and /app/pdf/. libheif stays a separate, replaceable file (LGPL-3.0).
const heicWorker = await readFile(path.join(appDir, 'upstream', 'tools', 'js', 'converters', 'heic-decode-worker.js'), 'utf8');
const relativeHeicWorker = heicWorker.replaceAll("'/tools/vendor/", "'../../vendor/");
if (relativeHeicWorker.includes('/tools/')) {
  console.error('build-frontend: the HEIC worker addresses /tools/ in a way this build does not rewrite.');
  process.exit(1);
}
await mkdir(path.join(distDir, 'tools', 'js', 'converters'), { recursive: true });
await writeFile(path.join(distDir, 'tools', 'js', 'converters', 'heic-decode-worker.js'), relativeHeicWorker);

// The editor's UI comes from the fork, not from the pin: rebuild it and replace the pinned bundle, its chunks and CSS.
const scripts = path.dirname(fileURLToPath(import.meta.url));
execFileSync(process.execPath, [path.join(scripts, 'build-editor.mjs')], { stdio: 'inherit' });
const pdfTools = path.join(vendorTarget, 'pdf-tools');
for (const name of ['oo-pdf-tools.js', 'oo-pdf-tools.css', 'chunks']) await rm(path.join(pdfTools, name), { recursive: true, force: true });
await cp(path.join(appDir, 'editor-dist'), pdfTools, { recursive: true });

// Licences view data (Settings → Licences); needs cargo, which every app build has.
try {
  execFileSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'collect-licenses.mjs')], { stdio: 'inherit' });
} catch (error) {
  console.warn(`build-frontend: licence list not generated (${error.message}); the Licences view will say so.`);
}

const { bytes, files } = await sizeOf(distDir);
console.log(`build-frontend: ${path.relative(process.cwd(), distDir) || '.'} (${files} files, ${(bytes / 2 ** 20).toFixed(1)} MiB)`);
