#!/usr/bin/env node
// Captures the PDF screenshots of bergwork.app from the real web app (headless Chromium, 1280 × 800 at 2×), as
// listed in content/media.json. Run against a local `npx wrangler dev` of website/dist or the live site:
//
//   node website/media/capture-pdf.mjs [app-url] [out-dir]
//
// Playwright comes from apps/image's dependencies. The sample document is apps/pdf/scripts/fixtures/smoke.pdf.
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';
import { cursorOverlay, glide } from './pointer.mjs';
import { cutList, encode } from './video.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const { chromium } = createRequire(path.join(repo, 'apps/image/package.json'))('playwright');
const [url = 'http://127.0.0.1:8790/app/pdf/', out = path.join(here, '..', 'src', 'media')] = process.argv.slice(2);
const sample = path.join(repo, 'apps/pdf/scripts/fixtures/smoke.pdf');
const scan = path.join(repo, 'apps/pdf/scripts/fixtures/scanned-page.pdf');
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ headless: true });
const problems = [];

async function open(theme = 'dark', file = sample) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: theme, locale: 'en-US' });
  await context.addInitScript((value) => localStorage.setItem('bergwork.appearance', JSON.stringify({ theme: value, corners: 'round' })), theme);
  const page = await context.newPage();
  page.on('pageerror', (error) => problems.push(String(error)));
  await page.goto(url);
  await page.waitForTimeout(1500);
  await page.locator('input[type=file]').first().setInputFiles(file);
  await page.waitForTimeout(3000);
  return { context, page };
}

const shot = (page, name) => page.screenshot({ path: path.join(out, `${name}.png`) });

// Edit text in place: the heading selected in Edit PDF, its properties open.
{
  const { context, page } = await open('dark');
  await page.getByRole('button', { name: 'Edit PDF', exact: true }).first().click();
  await page.waitForTimeout(800);
  const heading = page.getByLabel('PDF text: Plot 14, Hillside Road', { exact: true }).first();
  await heading.click().catch(async () => { await page.mouse.click(520, 205); });
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: /^Font/ }).first().click().catch(() => {});
  await page.waitForTimeout(800);
  await shot(page, 'pdf-text-edit');
  await context.close();
}

// Organise pages: the page drawer with all four thumbnails, page 2 selected.
{
  const { context, page } = await open('light');
  await page.getByRole('button', { name: 'Pages', exact: true }).first().click();
  await page.waitForTimeout(1500);
  await page.locator('.oo-pdf-thumb').nth(1).click().catch(() => {});
  await page.waitForTimeout(800);
  await shot(page, 'pdf-page-organiser');
  await context.close();
}

// Redact content: Find and redact with the matches for one coordinate prefix.
{
  const { context, page } = await open('dark');
  await page.getByRole('button', { name: 'Markup' }).first().click();
  await page.getByRole('menuitem', { name: /Redact/ }).or(page.getByRole('button', { name: /^Redact$/ })).first().click();
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'Find and redact' }).click();
  await page.getByRole('dialog', { name: 'Find and redact' }).getByRole('searchbox').fill('Keller');
  await page.getByRole('button', { name: 'Find matches' }).click();
  await page.getByText(/matches on \d+ page/).waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: /^Mark \d+ for redaction/ }).click();
  await page.waitForTimeout(1500);
  await page.getByRole('dialog', { name: 'Find and redact' }).getByRole('button', { name: 'Close' }).click();
  await page.waitForTimeout(800);
  // The contact line in the middle of the window.
  await page.mouse.move(640, 450);
  await page.mouse.wheel(0, 420);
  await page.waitForTimeout(600);
  await page.mouse.move(1180, 420);
  await page.waitForTimeout(1200);
  await shot(page, 'pdf-redaction');
  await context.close();
}

// Recognise text in a scan: OCR over an image-only page, then the recognised text found with Find.
{
  const { context, page } = await open('light', scan);
  await page.getByRole('button', { name: 'Document tools' }).first().click();
  await page.getByRole('menuitem', { name: 'OCR' }).or(page.getByRole('button', { name: 'OCR', exact: true })).first().click();
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'Run OCR' }).click();
  const started = Date.now();
  await page.getByRole('button', { name: 'Run OCR' }).waitFor({ state: 'visible', timeout: 180000 }).catch(() => {});
  await page.waitForFunction(() => !document.body.innerText.match(/Recognizing|Recognising|Running OCR|Preparing OCR/i), null, { timeout: 180000 }).catch(() => {});
  console.log(`OCR took ${((Date.now() - started) / 1000).toFixed(1)} s`);
  await page.waitForTimeout(1500);
  await shot(page, 'pdf-ocr');
  await context.close();
}

// The workflow video: edit a heading, find and mark a redaction, look at the pages, save.
if (!process.argv.includes('--no-video')) {
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 }, colorScheme: 'dark', locale: 'en-US',
    recordVideo: { dir: path.join(out, '.video'), size: { width: 1920, height: 1080 } },
  });
  await context.addInitScript(() => localStorage.setItem('bergwork.appearance', JSON.stringify({ theme: 'dark', corners: 'round' })));
  await context.addInitScript(cursorOverlay);
  // Save goes through the browser's save dialog; here it answers with a file that keeps nothing.
  await context.addInitScript(() => {
    window.showSaveFilePicker = async (options = {}) => ({
      kind: 'file', name: options.suggestedName || 'document.pdf',
      createWritable: async () => ({ write: async () => {}, close: async () => {} }),
      queryPermission: async () => 'granted', requestPermission: async () => 'granted',
    });
  });
  const page = await context.newPage();
  const clock = cutList();
  page.on('pageerror', (error) => problems.push(String(error)));
  await page.goto(url);
  await page.waitForTimeout(2000);
  clock.cuts.push([0, 1.8]);
  const choose = page.getByRole('button', { name: /Choose PDF/ }).first();
  await glide(page, choose);
  await page.locator('input[type=file]').first().setInputFiles(sample);
  clock.start();
  await page.waitForTimeout(2500);
  clock.end(1);
  await glide(page, page.getByRole('button', { name: 'Edit PDF', exact: true }).first());
  await page.getByRole('button', { name: 'Edit PDF', exact: true }).first().click();
  await page.waitForTimeout(700);
  const heading = page.getByLabel('PDF text: Plot 14, Hillside Road', { exact: true }).first();
  await glide(page, heading);
  await heading.dblclick();
  await page.waitForTimeout(900);
  await page.keyboard.press('End');
  await page.keyboard.type(' (revised)', { delay: 90 });
  await page.waitForTimeout(900);
  await glide(page, { x: 1500, y: 640 });
  await page.mouse.click(1500, 640);
  clock.start();
  await page.waitForTimeout(1500);
  clock.end(0.8);
  await glide(page, page.getByRole('button', { name: 'Markup' }).first());
  await page.getByRole('button', { name: 'Markup' }).first().click();
  await page.waitForTimeout(500);
  const redact = page.getByRole('menuitem', { name: /Redact/ }).or(page.getByRole('button', { name: /^Redact$/ })).first();
  await glide(page, redact);
  await redact.click();
  await page.waitForTimeout(600);
  await glide(page, page.getByRole('button', { name: 'Find and redact' }));
  await page.getByRole('button', { name: 'Find and redact' }).click();
  await page.waitForTimeout(500);
  await page.getByRole('dialog', { name: 'Find and redact' }).getByRole('searchbox').pressSequentially('Keller', { delay: 110 });
  await glide(page, page.getByRole('button', { name: 'Find matches' }));
  await page.getByRole('button', { name: 'Find matches' }).click();
  clock.start();
  await page.getByText(/matches on \d+ page/).waitFor({ timeout: 30000 });
  clock.end(0.8);
  await page.waitForTimeout(1200);
  const mark = page.getByRole('button', { name: /^Mark \d+ for redaction/ });
  await glide(page, mark);
  await mark.click();
  clock.start();
  await page.waitForTimeout(2500);
  clock.end(1.2);
  await page.waitForTimeout(1200);
  const closeDialog = page.getByRole('dialog', { name: 'Find and redact' }).getByRole('button', { name: 'Close' });
  await glide(page, closeDialog);
  await closeDialog.click();
  await page.waitForTimeout(800);
  await glide(page, page.getByRole('button', { name: 'Pages', exact: true }).first());
  await page.getByRole('button', { name: 'Pages', exact: true }).first().click();
  await page.waitForTimeout(2200);
  await page.getByRole('button', { name: 'Pages', exact: true }).first().click();
  await page.waitForTimeout(500);
  const save = page.getByRole('button', { name: 'Save PDF' });
  await glide(page, save);
  await save.click();
  clock.start();
  await page.getByText(/Saved|saved/).first().waitFor({ timeout: 60000 }).catch(() => {});
  clock.end(0.6);
  await page.waitForTimeout(2200);
  const video = page.video();
  await context.close();
  const length = encode(await video.path(), clock.cuts, path.join(out, 'pdf-workflow.mp4'), path.join(out, 'pdf-workflow-poster.jpg'), { posterAt: 0.97 });
  rmSync(path.join(out, '.video'), { recursive: true, force: true });
  console.log(`pdf-workflow.mp4: ${length.toFixed(1)} s`);
}

await browser.close();
console.log(problems.length ? problems.join('\n') : `capture-pdf: screenshots in ${out}`);
