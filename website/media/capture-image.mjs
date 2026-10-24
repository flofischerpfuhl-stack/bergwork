#!/usr/bin/env node
// Captures the Image screenshots of bergwork.app from the real web app (headless Chromium, 1280 × 800 at 2×), as
// listed in content/media.json, and records the workflow video (1920 × 1080) with a visible pointer:
//
//   node website/media/capture-image.mjs [app-url] [out-dir]
//
// The photo is media/backpack.png (generated for these pictures, no third-party rights); the second picture is the
// site's own mine-dusk illustration. Files are handed to the editor through a stubbed showOpenFilePicker, which is
// what the browser's file dialog returns. Playwright comes from apps/image's dependencies.
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cursorOverlay, glide } from './pointer.mjs';
import { cutList, encode } from './video.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const { chromium } = createRequire(path.join(repo, 'apps/image/package.json'))('playwright');
const [url = 'http://127.0.0.1:8790/app/image/', out = path.join(here, '..', 'src', 'media')] = process.argv.slice(2);
const photo = path.join(here, 'backpack.png');
const backdrop = path.join(repo, 'website/src/assets/img/mine-dusk.jpg');
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ headless: true });
const problems = [];

/** showOpenFilePicker answers with the files queued by `queueFiles`, as the browser's dialog would. */
function pickerStub() {
  window.__queuedFiles = [];
  window.showOpenFilePicker = async () => {
    const files = window.__queuedFiles.splice(0);
    if (!files.length) throw new DOMException('No file queued', 'AbortError');
    return files.map(({ name, type, base64 }) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const file = new File([bytes], name, { type });
      return { kind: 'file', name, getFile: async () => file, queryPermission: async () => 'granted' };
    });
  };
}

async function queueFiles(page, ...files) {
  const payload = files.map((file) => ({
    name: path.basename(file), type: file.endsWith('.png') ? 'image/png' : 'image/jpeg', base64: readFileSync(file).toString('base64'),
  }));
  await page.evaluate((items) => { window.__queuedFiles.push(...items); }, payload);
}

async function open({ theme = 'dark', video = false } = {}) {
  const context = await browser.newContext({
    viewport: video ? { width: 1920, height: 1080 } : { width: 1280, height: 800 },
    deviceScaleFactor: video ? 1 : 2, colorScheme: theme, locale: 'en-US',
    ...(video ? { recordVideo: { dir: path.join(out, '.video'), size: { width: 1920, height: 1080 } } } : {}),
  });
  await context.addInitScript((value) => localStorage.setItem('bergwork.appearance', JSON.stringify({ theme: value, corners: 'round' })), theme);
  await context.addInitScript(pickerStub);
  if (video) await context.addInitScript(cursorOverlay);
  const page = await context.newPage();
  const clock = cutList();
  page.on('pageerror', (error) => problems.push(String(error)));
  await page.goto(url);
  await page.waitForTimeout(2500);
  return { context, page, clock };
}

const menu = async (page, name, item) => {
  await page.getByTestId(`menu-${name}`).click();
  await page.waitForTimeout(250);
  await page.getByRole('menuitem', { name: item }).first().click();
};

async function importPhoto(page) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('welcome-import').click();
  await (await chooser).setFiles(photo);
  await page.waitForTimeout(2500);
}

async function removeBackground(page, clock) {
  await menu(page, 'Filter', 'Remove Background…');
  const ok = page.getByTestId('remove-background-ok');
  await ok.waitFor();
  clock?.start();
  for (let i = 0; i < 180 && await ok.isDisabled(); i += 1) await page.waitForTimeout(500);
  clock?.end();
  await page.waitForTimeout(600);
  return ok;
}

async function placeBackdrop(page, clock) {
  await queueFiles(page, backdrop);
  await menu(page, 'File', /^Place Embedded/);
  clock?.start();
  await page.waitForTimeout(2500);
  clock?.end(1);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);
  await menu(page, 'Layer', /^Move Layer Down/);
  await page.waitForTimeout(800);
}

/** Pulls the curve into a gentle S: darker shadows, brighter highlights. */
async function sCurve(page, video = false, clock = null) {
  const graph = await page.getByTestId('curves-graph').boundingBox();
  for (const [fx, fy, dy] of [[0.28, 0.72, 0.07], [0.72, 0.28, -0.07]]) {
    const x = graph.x + graph.width * fx, y = graph.y + graph.height * fy;
    if (video) await glide(page, { x, y }); else await page.mouse.move(x, y);
    await page.mouse.down();
    // Each move re-renders the preview; headless Chromium renders on the CPU and takes seconds per move, so the video
    // keeps a short moment of each step and cuts the rest.
    for (let i = 1; i <= 6; i += 1) {
      clock?.start();
      await page.mouse.move(x, y + graph.height * dy * (i / 6));
      clock?.end(0.12);
    }
    await page.mouse.up();
    await page.waitForTimeout(400);
  }
}

const curvesOk = (page) => page.getByRole('dialog').filter({ hasText: 'Curves' }).getByRole('button', { name: 'OK', exact: true })
  .or(page.locator('[data-testid="curves-graph"]').locator('xpath=ancestor::*[.//button[normalize-space()="OK"]][1]').getByRole('button', { name: 'OK', exact: true })).first();

const shot = (page, name) => page.screenshot({ path: path.join(out, `${name}.png`) });

// Local background removal: the panel after the model ran, then the result with its layer mask.
{
  const { context, page } = await open();
  await importPhoto(page);
  const ok = await removeBackground(page);
  await ok.click();
  await page.waitForTimeout(1500);
  await shot(page, 'image-background-removal');
  // Layers and masks: the cut-out over a placed backdrop, a Curves adjustment on top.
  await placeBackdrop(page);
  await page.getByTestId('layer-row').first().click();
  await menu(page, 'Layer', /^New Adjustment Layer/);
  await page.waitForTimeout(300);
  await page.getByRole('menuitem', { name: /^Curves/ }).last().click();
  await page.waitForTimeout(1500);
  await sCurve(page);
  await shot(page, 'image-adjustment-layers');
  await curvesOk(page).click();
  await page.waitForTimeout(800);
  await shot(page, 'image-layers-masks');
  // One export flow: the export dialog with its formats.
  await menu(page, 'File', /^Export As/);
  await page.getByTestId('export-preview-image').waitFor({ timeout: 120000 });
  await page.waitForTimeout(800);
  await shot(page, 'image-export');
  await context.close();
}

// The workflow video: import, remove the background, place a backdrop, adjust with Curves, export.
if (!process.argv.includes('--no-video')) {
  const { context, page, clock } = await open({ video: true });
  clock.cuts.push([0, 2.2]);
  const chooser = page.waitForEvent('filechooser');
  await glide(page, page.getByTestId('welcome-import'));
  await page.getByTestId('welcome-import').click();
  await (await chooser).setFiles(photo);
  await page.waitForTimeout(1800);
  await glide(page, page.getByTestId('menu-Filter'));
  const ok = await removeBackground(page, clock);
  await page.waitForTimeout(600);
  await glide(page, ok);
  await ok.click();
  await page.waitForTimeout(1500);
  await glide(page, page.getByTestId('menu-File'));
  await placeBackdrop(page, clock);
  await page.waitForTimeout(1000);
  await glide(page, page.getByTestId('menu-Layer'));
  await menu(page, 'Layer', /^New Adjustment Layer/);
  await page.waitForTimeout(300);
  await page.getByRole('menuitem', { name: /^Curves/ }).last().click();
  await page.waitForTimeout(1000);
  await sCurve(page, true, clock);
  await page.waitForTimeout(800);
  await glide(page, curvesOk(page));
  await curvesOk(page).click();
  await page.waitForTimeout(800);
  await glide(page, page.getByTestId('menu-File'));
  await menu(page, 'File', /^Export As/);
  clock.start();
  await page.getByTestId('export-preview-image').waitFor({ timeout: 120000 });
  clock.end(1);
  await page.waitForTimeout(2500);
  const video = page.video();
  await context.close();
  const length = encode(await video.path(), clock.cuts, path.join(out, 'image-workflow.mp4'), path.join(out, 'image-workflow-poster.jpg'));
  rmSync(path.join(out, '.video'), { recursive: true, force: true });
  console.log(`image-workflow.mp4: ${length.toFixed(1)} s`);
}

await browser.close();
console.log(problems.length ? problems.join('\n') : `capture-image: done in ${out}`);
