#!/usr/bin/env node
// Captures the PDF media of bergwork.app from the real web app (headless Chromium, 1280 × 800 at 2×), as listed in
// content/media.json: small screenshots cropped to what each one explains, and one short, fast take of moving and
// editing objects. Run against a local `npx wrangler dev` of website/dist or the live site:
//
//   node website/media/capture-pdf.mjs [app-url] [out-dir] [--no-video] [--only=name,name]
//
// Playwright comes from Fernwork's or apps/image's dependencies. Samples: apps/pdf/scripts/fixtures/*.pdf.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cursorOverlay, glide } from './pointer.mjs';
import { cutList, encodeFrames, grabFrames } from './video.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
// Fernwork's Playwright first: its browsers are installed on the capture machines; apps/image may pin a newer one.
const playwrightFrom = ['/home/flo/source/fernwork/package.json', path.join(repo, 'apps/image/package.json')]
  .find((file) => existsSync(path.join(path.dirname(file), 'node_modules/playwright')));
const { chromium } = createRequire(playwrightFrom)('playwright');
const args = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const [url = 'http://127.0.0.1:8790/app/pdf/', out = path.join(here, '..', 'src', 'media')] = args;
const only = process.argv.find((arg) => arg.startsWith('--only='))?.slice(7).split(',');
const want = (name) => !only || only.includes(name);
const sample = path.join(repo, 'apps/pdf/scripts/fixtures/smoke.pdf');
const scan = path.join(repo, 'apps/pdf/scripts/fixtures/scanned-page.pdf');
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ headless: true });
const problems = [];

async function ready(page) {
  await page.waitForFunction(() => !/Preparing the editor|Opening the PDF safely|Loading/i.test(document.body.innerText), null, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(600);
}

async function open(file = sample, { video = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'light', locale: 'en-US' });
  await context.addInitScript(() => localStorage.setItem('bergwork.appearance', JSON.stringify({ theme: 'light', corners: 'round' })));
  if (video) await context.addInitScript(cursorOverlay);
  const page = await context.newPage();
  page.on('pageerror', (error) => problems.push(String(error)));
  // A busy machine sometimes leaves the first load without its file input; one reload fixes that.
  for (let attempt = 0; ; attempt += 1) {
    await page.goto(url);
    const input = page.locator('input[type=file]').first();
    try {
      await input.waitFor({ state: 'attached', timeout: 45000 });
      await page.waitForTimeout(800);
      await input.setInputFiles(file);
      break;
    } catch (error) {
      if (attempt) throw error;
    }
  }
  await page.waitForTimeout(1500);
  await ready(page);
  return { context, page };
}

/** Screenshot of one region (CSS pixels), saved as PNG and WebP. */
async function shot(page, name, clip) {
  const file = path.join(out, `${name}.png`);
  await page.screenshot({ path: file, clip });
  execFileSync('magick', [file, '-quality', '82', file.replace(/\.png$/, '.webp')]);
  console.log(`${name}: ${clip.width * 2} × ${clip.height * 2}`);
}

const editMode = async (page) => {
  // Edit PDF stays disabled until the editing engine has loaded.
  await page.waitForFunction(() => { const b = document.querySelector('button[aria-label="Edit PDF"]'); return b && !b.disabled; }, null, { timeout: 120000 });
  await page.getByRole('button', { name: 'Edit PDF', exact: true }).first().click();
  await page.waitForTimeout(900);
};
const deselect = async (page) => { await page.mouse.click(1100, 300); await page.waitForTimeout(400); };
async function drag(page, from, to, steps = 18) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up();
}

// Exact values: the building rectangle selected, with handles, rotation and its position and size.
if (want('pdf-precise')) {
  const { context, page } = await open();
  await editMode(page);
  await page.mouse.click(640, 640);
  await page.waitForTimeout(500);
  await drag(page, { x: 640, y: 640 }, { x: 700, y: 610 });
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: /Position & size/ }).first().click().catch(() => {});
  await page.waitForTimeout(700);
  await shot(page, 'pdf-precise', { x: 380, y: 300, width: 890, height: 470 });
  await context.close();
}

// Select many: a marquee over the table picks all 20 cells at once.
if (want('pdf-select-many')) {
  const { context, page } = await open();
  await editMode(page);
  await drag(page, { x: 372, y: 336 }, { x: 900, y: 452 });
  await page.waitForTimeout(800);
  await shot(page, 'pdf-select-many', { x: 360, y: 240, width: 910, height: 480 });
  await context.close();
}

// Edit text: the heading as a live text object with its font, size and colour.
if (want('pdf-text-edit')) {
  const { context, page } = await open();
  await editMode(page);
  await page.mouse.click(500, 205);
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: /^Font/ }).first().click().catch(() => {});
  await page.waitForTimeout(700);
  await shot(page, 'pdf-text-edit', { x: 360, y: 120, width: 910, height: 520 });
  await context.close();
}

// Insert: text, images, shapes, drawing, comments and a visible signature.
if (want('pdf-insert')) {
  const { context, page } = await open();
  await page.getByRole('button', { name: 'Insert' }).first().click();
  await page.waitForTimeout(700);
  await shot(page, 'pdf-insert', { x: 180, y: 50, width: 720, height: 370 });
  await context.close();
}

// Document tools: the menu of whole-document tools.
if (want('pdf-tools')) {
  const { context, page } = await open();
  await page.getByRole('button', { name: 'Document tools' }).first().click();
  await page.waitForTimeout(700);
  await shot(page, 'pdf-tools', { x: 820, y: 50, width: 460, height: 510 });
  await context.close();
}

// Organise pages: the page drawer with all four thumbnails, page 2 selected.
if (want('pdf-pages')) {
  const { context, page } = await open();
  await page.getByRole('button', { name: 'Pages', exact: true }).first().click();
  await page.waitForTimeout(1500);
  await page.locator('.oo-pdf-thumb').nth(1).click().catch(() => {});
  await page.waitForTimeout(800);
  const drawer = await page.locator('.oo-pdf-thumb').first().boundingBox().catch(() => null);
  await shot(page, 'pdf-pages', { x: 0, y: 100, width: 720, height: drawer ? 520 : 600 });
  await context.close();
}

// Redact: every match of a name found and marked; export deletes the characters.
if (want('pdf-redaction')) {
  const { context, page } = await open();
  await page.getByRole('button', { name: 'Markup' }).first().click();
  await page.getByRole('menuitem', { name: /Redact/ }).or(page.getByRole('button', { name: /^Redact$/ })).first().click();
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'Find and redact' }).click();
  await page.getByRole('dialog', { name: 'Find and redact' }).getByRole('searchbox').fill('Keller');
  await page.getByRole('button', { name: 'Find matches' }).click();
  await page.getByText(/matches on \d+ page/).waitFor({ timeout: 30000 });
  await page.waitForTimeout(600);
  await shot(page, 'pdf-redaction-find', { x: 280, y: 110, width: 720, height: 560 });
  await page.getByRole('button', { name: /^Mark \d+ for redaction/ }).click();
  await page.waitForTimeout(1500);
  await page.getByRole('dialog', { name: 'Find and redact' }).getByRole('button', { name: 'Close' }).click();
  await page.waitForTimeout(800);
  await page.mouse.move(640, 450);
  await page.mouse.wheel(0, 420);
  await page.waitForTimeout(600);
  await page.mouse.move(1200, 300);
  await page.waitForTimeout(1000);
  const line = await page.getByText(/marks? redacted on export/).first().boundingBox().catch(() => null);
  const y = line ? Math.max(90, Math.round(line.y) - 150) : 380;
  await shot(page, 'pdf-redaction', { x: 340, y, width: 600, height: 300 });
  await context.close();
}

// Sign: a handwritten mark (drawn, typed or an image) or a certificate signature, on the device.
if (want('pdf-sign')) {
  const { context, page } = await open();
  await page.getByRole('button', { name: 'Document tools' }).first().click();
  await page.getByRole('menuitem', { name: 'Sign' }).or(page.getByRole('button', { name: 'Sign', exact: true })).first().click();
  await page.waitForTimeout(1200);
  await shot(page, 'pdf-sign', { x: 12, y: 104, width: 420, height: 290 });
  await context.close();
}

// OCR: an image-only scan made searchable on the device.
if (want('pdf-ocr')) {
  const { context, page } = await open(scan);
  await page.getByRole('button', { name: 'Document tools' }).first().click();
  await page.getByRole('menuitem', { name: 'OCR' }).or(page.getByRole('button', { name: 'OCR', exact: true })).first().click();
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'Run OCR' }).click();
  const started = Date.now();
  await page.waitForTimeout(1000);
  await page.waitForFunction(() => /OCR done|OCR complete/i.test(document.body.innerText), null, { timeout: 180000 }).catch(() => {});
  console.log(`OCR took ${((Date.now() - started) / 1000).toFixed(1)} s`);
  await page.waitForTimeout(1200);
  await shot(page, 'pdf-ocr', { x: 12, y: 100, width: 760, height: 560 });
  await context.close();
}

// The take: in Edit PDF, move the heading, pick up the building with its label and turn it, then retype the
// heading – one continuous session. Frames are grabbed sharp at 2× but only ~5 per second, so the session
// runs SLOW times slower than a hand would and is played back a little more than SLOW times faster: brisk.
const SLOW = 4;
async function sweep(page, from, to, ms, { press = false } = {}) {
  const steps = Math.max(2, Math.round((ms * SLOW) / 16));
  await page.mouse.move(from.x, from.y);
  if (press) await page.mouse.down();
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const ease = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    await page.mouse.move(from.x + (to.x - from.x) * ease, from.y + (to.y - from.y) * ease);
    await page.waitForTimeout(16);
  }
  if (press) await page.mouse.up();
}
const pause = (page, ms) => page.waitForTimeout(ms * SLOW);

if (want('pdf-move-video') && !process.argv.includes('--no-video')) {
  const { context, page } = await open(sample, { video: true });
  await editMode(page);
  let at = { x: 1000, y: 520 };
  const go = async (to, ms = 350) => { await sweep(page, at, to, ms); at = to; };
  const dragTo = async (to, ms = 450) => { await sweep(page, at, to, ms, { press: true }); at = to; };
  const click = async () => { await page.mouse.down(); await page.mouse.up(); };
  await page.mouse.move(at.x, at.y);
  await page.waitForTimeout(500);
  const frames = path.join(out, '.frames-pdf');
  const clock = cutList();
  const grab = await grabFrames(page, frames, { x: 330, y: 112, width: 600, height: 688 });
  await pause(page, 300);
  // The heading: pick it up and set it further right and lower.
  await go({ x: 470, y: 205 });
  await dragTo({ x: 600, y: 300 }, 500);
  await pause(page, 250);
  // The building and its label: one marquee, then drag them across the plot.
  await go({ x: 556, y: 568 }, 300);
  await dragTo({ x: 705, y: 676 }, 350);
  await pause(page, 150);
  await go({ x: 650, y: 640 }, 200);
  await dragTo({ x: 735, y: 668 }, 450);
  await pause(page, 200);
  // Turn it with the rotation handle.
  const handle = page.getByRole('button', { name: 'Rotate selection' }).first();
  const box = await handle.boundingBox().catch(() => null);
  if (box && box.x < 920) {
    const c = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await go(c, 250);
    await dragTo({ x: c.x + 24, y: c.y + 4 }, 450);
    await pause(page, 200);
  }
  // Retype the heading in place.
  await go({ x: 900, y: 250 }, 250);
  await click();
  await go({ x: 640, y: 300 }, 300);
  await page.mouse.dblclick(at.x, at.y);
  await pause(page, 200);
  await page.keyboard.press('End');
  await page.keyboard.type(' (revised)', { delay: 60 * SLOW });
  await pause(page, 250);
  await go({ x: 900, y: 520 }, 300);
  await click();
  await pause(page, 700);
  const list = await grab.stop();
  await context.close();
  const length = encodeFrames(list, {
    t0: clock.t0, cuts: clock.cuts, speed: SLOW * 1.3, width: 1000,
    mp4: path.join(out, 'pdf-move.mp4'), poster: path.join(out, 'pdf-move-poster.jpg'), posterAt: 1,
  });
  rmSync(frames, { recursive: true, force: true });
  console.log(`pdf-move.mp4: ${length.toFixed(1)} s, ${list.length} frames`);
}

await browser.close();
console.log(problems.length ? problems.join('\n') : `capture-pdf: media in ${out}`);
