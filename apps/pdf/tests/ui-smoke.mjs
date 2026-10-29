#!/usr/bin/env node
// Thin UI-level smoke for the wiring the engine-level corpus suite bypasses: the real berg:work PDF page
// (apps/pdf/dist) opens a few corpus PDFs through its file input, renders them, rotates a page with the toolbar
// button, undoes and redoes it, saves (download, since the save picker is hidden) and the saved file is checked
// with qpdf. Headless Chromium; fails on page errors, failed requests and wrong page counts.
//
//   node apps/pdf/tests/ui-smoke.mjs [--file <id>,<id>] [--out dir]
import { execFileSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../headless/server.mjs';
import { qpdfCheck, qpdfPages } from './lib/oracles.mjs';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.dirname(testsDir);
const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const manifest = JSON.parse(await fs.readFile(path.join(testsDir, 'corpus', 'manifest.json'), 'utf8'));
const corpusRoot = path.resolve((process.env.BERGWORK_PDF_CORPUS || manifest.defaultRoot).replace(/^~(?=\/)/, os.homedir()));
const ids = arg('--file')?.split(',') || ['pdfjs/tracemonkey.pdf', 'irs/f1040--2023.pdf', 'wikimedia-commons/Cheatsheet-3-ja.pdf', 'irs/f1040--1985.pdf', 'wikimedia-commons/Stop_the_Spread_of_Germs_updated_Hebrew.pdf'];
const files = ids.map((id) => manifest.files.find((file) => file.id === id)).filter((file) => file && existsSync(path.join(corpusRoot, file.id)));
const outDir = path.resolve(arg('--out') || path.join(testsDir, '.out', `ui-smoke-${Date.now()}`));
await fs.mkdir(outDir, { recursive: true });

const { chromium } = createRequire(path.join(appDir, '..', 'image', 'package.json'))('playwright');
const server = await startServer({ distDir: path.join(appDir, 'dist'), harnessDir: path.join(testsDir, '.build'), corpusRoot, outDir });
const browser = await chromium.launch({ headless: true });
const failures = [];
const started = Date.now();
for (const file of files) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
  page.on('response', (response) => { if (response.status() >= 400) problems.push(`${response.status()} ${response.url()}`); });
  await page.addInitScript(() => Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined }));
  const t0 = Date.now();
  try {
    await page.goto(`${server.url}/`, { waitUntil: 'load' });
    await page.locator('input[type=file]').first().setInputFiles(path.join(corpusRoot, file.id));
    await page.waitForFunction(() => {
      const canvas = document.querySelector('.oo-pdf-sheet canvas');
      return canvas && canvas.width > 0 && canvas.height > 0;
    }, null, { timeout: 45_000 });
    // Wait for the live editing session (Undo becomes meaningful only then).
    await page.waitForTimeout(1500);
    const rotate = page.getByRole('button', { name: 'Rotate page right' }).first();
    if (await rotate.count()) {
      await rotate.click();
      await page.waitForTimeout(1500);
      await page.keyboard.press('Control+z');
      await page.waitForTimeout(1000);
      await page.keyboard.press('Control+Shift+z');
      await page.waitForTimeout(1000);
    } else problems.push('no "Rotate page right" button');
    const download = page.waitForEvent('download', { timeout: 45_000 });
    await page.getByRole('button', { name: 'Save PDF' }).first().click();
    const saved = await download;
    const target = path.join(outDir, `${file.id.replace(/[^A-Za-z0-9._-]/g, '_')}.saved.pdf`);
    await saved.saveAs(target);
    const check = await qpdfCheck(target);
    const pages = await qpdfPages(target);
    if (check.status === 'errors') problems.push(`qpdf: ${check.message}`);
    if (pages !== file.pages) problems.push(`saved page count ${pages}, expected ${file.pages}`);
    // Rotate, Undo, Redo: page 1 must be saved a quarter turn further than it was.
    const rotation = async (pdf) => Number((execFileSync('pdfinfo', ['-f', '1', '-l', '1', pdf], { encoding: 'utf8' })
      .match(/Page\s+1\s+rot:\s+(\d+)/) || [])[1] || 0);
    const before = await rotation(path.join(corpusRoot, file.id));
    const after = await rotation(target);
    if (after !== (before + 90) % 360) problems.push(`saved page 1 rotation ${after}, expected ${(before + 90) % 360}`);
    await page.screenshot({ path: target.replace(/\.pdf$/, '.png') });
  } catch (error) {
    problems.push(String(error.message).split('\n')[0]);
  }
  console.log(`${problems.length ? 'FAIL' : 'ok  '} ${((Date.now() - t0) / 1000).toFixed(1)}s ${file.id}${problems.length ? `\n  ${problems.join('\n  ')}` : ''}`);
  if (problems.length) failures.push({ file: file.id, problems });
  await context.close();
}
await browser.close();
await server.close();
await fs.writeFile(path.join(outDir, 'ui-smoke.json'), JSON.stringify({ files: files.map((file) => file.id), failures, ms: Date.now() - started }, null, 2));
console.log(`ui-smoke: ${files.length - failures.length}/${files.length} ok in ${((Date.now() - started) / 1000).toFixed(0)} s, ${outDir}`);
process.exitCode = failures.length ? 1 : 0;
