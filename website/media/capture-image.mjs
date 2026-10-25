#!/usr/bin/env node
// Captures the berg:work Image screenshots and the hero video from the real web app (headless Chromium, light appearance,
// en-US, 1280 × 800 at 2×):
//
//   node website/media/capture-image.mjs [app-url] [out-dir] [--no-shots] [--no-video]
//
// Pictures: website/media/backpack.png (generated for these pictures, no third-party rights), cropped to the backpack so
// its layer bounds hug the subject, and the site's own mine-dusk illustration as the scene behind it. Files reach the
// editor through a stubbed showOpenFilePicker (what the browser's file dialog returns) or the welcome screen's file input.
//
// Background removal uses the app's "Best quality" model (BiRefNet lite, ~190 MB from Hugging Face): the fast model leaves
// the thin leather straps semi-transparent. Chromium runs with a persistent profile (CAPTURE_PROFILE, default
// ~/.cache/bergwork-capture) so the model is downloaded once; inference still takes about a minute and is cut from the video.
//
// The video is not a screen recording: Playwright's recordVideo captures CSS pixels only (blurry at 2×), so every step of
// the take is a page screenshot at 2× with its own duration, assembled with ffmpeg and sped up (SPEED). Waits cost nothing.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')));
const [url = 'https://bergwork.app/app/image/', out = path.join(here, '..', 'src', 'media')] = args;
const playwrightFrom = [process.env.PLAYWRIGHT_PACKAGE_JSON, '/home/flo/source/fernwork/package.json', path.join(repo, 'apps/image/package.json')]
  .filter((file) => file && existsSync(file));
const { chromium } = createRequire(playwrightFrom[0])('playwright');
const profile = process.env.CAPTURE_PROFILE ?? path.join(os.homedir(), '.cache', 'bergwork-capture');
const chromiumArgs = (process.env.CAPTURE_CHROMIUM_ARGS ?? '--enable-gpu --ignore-gpu-blocklist --use-angle=gl-egl').split(' ').filter(Boolean);
mkdirSync(out, { recursive: true });

// Inputs, named the way the layers should read.
const work = mkdtempSync(path.join(os.tmpdir(), 'bergwork-image-capture-'));
const backpack = path.join(work, 'Backpack.png');
const mountains = path.join(work, 'Mountains.jpg');
execFileSync('magick', [path.join(here, 'backpack.png'), '-crop', '840x830+345+90', '+repage', backpack]);
copyFileSync(path.join(repo, 'website/src/assets/img/mine-dusk@1440.jpg'), mountains);
const DOC = { width: 1440, height: 810 };
const TEXT = 'Into the hills';
const problems = [];

// MARK: Page helpers

/** showOpenFilePicker answers with the files queued by `queueFile`, as the browser's dialog would. */
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

/** A drawn arrow that follows the real pointer events (headless Chromium draws none). Runs in the page. */
function cursorOverlay() {
  const install = () => {
    const arrow = document.createElement('div');
    arrow.setAttribute('aria-hidden', 'true');
    arrow.style.cssText = 'position:fixed;left:0;top:0;width:24px;height:24px;z-index:2147483647;pointer-events:none;'
      + 'transform:translate(-100px,-100px);filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))';
    arrow.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M4 2l15 11-6.5 1.2L16 21l-3 1.4-3.6-6.9L4 20z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    document.documentElement.append(arrow);
    let down = false, x = -100, y = -100;
    const place = () => { arrow.style.transform = `translate(${x - 3}px, ${y - 2}px) scale(${down ? 0.86 : 1})`; };
    addEventListener('mousemove', (event) => { x = event.clientX; y = event.clientY; place(); }, true);
    addEventListener('mousedown', () => { down = true; place(); }, true);
    addEventListener('mouseup', () => { down = false; place(); }, true);
  };
  if (document.documentElement) install(); else addEventListener('DOMContentLoaded', install);
}

async function launch({ pointer = false } = {}) {
  const context = await chromium.launchPersistentContext(profile, {
    headless: true, args: chromiumArgs, viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'light', locale: 'en-US',
  });
  // A first-time visitor: no remembered panel positions or settings, light appearance. (The model cache is Cache Storage.)
  await context.addInitScript(() => {
    try { localStorage.clear(); localStorage.setItem('bergwork.appearance', JSON.stringify({ theme: 'light', corners: 'round' })); } catch { /* private mode */ }
  });
  await context.addInitScript(pickerStub);
  if (pointer) await context.addInitScript(cursorOverlay);
  const page = context.pages()[0] ?? await context.newPage();
  page.on('pageerror', (error) => problems.push(String(error)));
  await page.goto(url);
  const discard = page.getByRole('button', { name: 'Discard', exact: true });
  await discard.or(page.getByTestId('welcome-import')).first().waitFor({ timeout: 60000 });
  await page.waitForTimeout(800);
  if (await discard.isVisible()) { await discard.click(); await page.waitForTimeout(500); }
  await page.getByTestId('welcome-import').waitFor();
  return { context, page };
}

async function queueFile(page, file) {
  const item = { name: path.basename(file), type: file.endsWith('.png') ? 'image/png' : 'image/jpeg', base64: readFileSync(file).toString('base64') };
  await page.evaluate((value) => { window.__queuedFiles.push(value); }, item);
}

const menu = async (page, name, item) => {
  await page.getByTestId(`menu-${name}`).click();
  await page.waitForTimeout(250);
  await page.getByRole('menuitem', { name: item }).first().click();
};

async function openDocument(page, file) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('welcome-import').click();
  await (await chooser).setFiles(file);
  await page.getByTestId('layer-row').first().waitFor();
  await page.waitForTimeout(1500);
}

async function place(page, file) {
  const rows = await page.getByTestId('layer-row').count();
  await queueFile(page, file);
  await menu(page, 'File', /^Place Embedded/);
  for (let i = 0; i < 100 && await page.getByTestId('layer-row').count() === rows; i += 1) await page.waitForTimeout(100);
  await page.waitForTimeout(800);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
}

async function rename(page, from, to) {
  await page.locator('[data-layer-name]').filter({ hasText: from }).first().dblclick();
  const input = page.getByLabel('Layer name');
  await input.fill(to);
  await input.press('Enter');
  await page.waitForTimeout(300);
}

const row = (page, name) => page.getByTestId('layer-row').filter({ hasText: name }).first();

/** Types into a context-bar or dialog field and leaves it with Tab (Enter would also confirm some dialogs). */
async function field(page, testId, value, leave = 'Tab') {
  const input = page.getByTestId(testId);
  await input.click();
  await input.fill(String(value));
  await input.press(leave);
  await page.waitForTimeout(200);
}

/** Moves/resizes the active layer through the transform bar and applies it. */
async function transformTo(page, values) {
  for (const [key, value] of Object.entries(values)) await field(page, `transform${key}`, value, 'Enter');
  const apply = page.getByTestId('applyTransform');
  if (await apply.isEnabled().catch(() => false)) await apply.click();
  await page.waitForTimeout(400);
}

/** Document pixels → CSS pixels on screen, from the canvas pane (the canvas is centred in it) and the zoom readout. */
async function view(page) {
  const pane = await page.getByTestId('canvas-pane').boundingBox();
  const zoom = parseFloat((await page.getByTestId('zoomStatus').innerText()).replace(',', '.')) / 100 / 2;
  const cx = pane.x + pane.width / 2, cy = pane.y + pane.height / 2;
  return (x, y) => ({ x: cx + (x - DOC.width / 2) * zoom, y: cy + (y - DOC.height / 2) * zoom });
}

/** The document's left and right edge on screen along one row, found in the pixels (the zoom readout lags a re-fit). */
async function canvasEdges(page, y) {
  const png = await page.screenshot({ clip: { x: 0, y, width: 1280, height: 1 }, scale: 'css' });
  const text = execFileSync('magick', ['png:-', '-depth', '8', 'txt:-'], { input: png, encoding: 'utf8' });
  const dark = text.split('\n').map((line) => /^(\d+),0: \((\d+),(\d+),(\d+)/.exec(line)).filter(Boolean)
    .filter(([, , r, g, b]) => Number(r) + Number(g) + Number(b) < 450).map(([, x]) => Number(x)).filter((x) => x > 150);
  return { left: Math.min(...dark), right: Math.max(...dark) };
}

async function layerBox(page) {
  const read = async (id) => parseFloat((await page.getByTestId(`transform${id}`).inputValue()).replace(/,/g, ''));
  return { x: await read('X'), y: await read('Y'), width: await read('W'), height: await read('H') };
}

/** Filter > Remove Background with the "Best quality" model; `wait` brackets the model run (download + inference). */
async function removeBackground(page, { open = null, wait = {} } = {}) {
  if (open) await open(); else await menu(page, 'Filter', 'Remove Background…');
  const ok = page.getByTestId('remove-background-ok');
  await ok.waitFor();
  await page.waitForTimeout(400);
  return {
    ok,
    best: page.getByTestId('remove-background-panel').getByText('Best quality', { exact: true }),
    async run() {
      wait.start?.();
      for (let i = 0; i < 1200 && await ok.isDisabled(); i += 1) await page.waitForTimeout(500);
      wait.end?.();
      if (await ok.isDisabled()) throw new Error('Remove Background: the model did not finish in 10 minutes');
    },
  };
}

async function textToolReady(page) {
  await page.getByTestId('tool-text').click();
  await page.locator('[data-testid="text-bar"][data-engine="ready"]').waitFor({ timeout: 90000 });
  await page.waitForTimeout(300);
}

/** Bold, 80 pt, warm white – for the text being edited, or the Type tool's settings when nothing is being edited. */
async function textStyle(page) {
  await page.getByTestId('font-style').selectOption({ label: 'Bold' });
  await page.waitForTimeout(200);
  await field(page, 'font-size', 80, 'Enter');
  await page.getByTestId('text-color').click();
  await field(page, 'color-hex', 'FFF4E2', 'Enter');
  if (await page.getByTestId('color-ok').isVisible().catch(() => false)) await page.getByTestId('color-ok').click();
  await page.waitForTimeout(300);
}

/** The pen tool's paint: no fill, a white dashed round-capped stroke, 8 px. */
async function trailStyle(page) {
  await page.getByTestId('vector-fill').click();
  await page.getByTestId('vector-fill-none').click();
  await page.keyboard.press('Escape');
  await page.getByTestId('vector-stroke').click();
  await page.getByTestId('vector-stroke-solid').click();
  await page.getByTestId('vector-stroke-popover').getByRole('button', { name: 'Background color' }).click();
  await page.keyboard.press('Escape');
  await page.getByTestId('vector-stroke-options').click();
  const options = page.locator('[role=dialog]').last();
  await options.getByText('Center', { exact: true }).click();
  await options.getByText('Round', { exact: true }).first().click();
  await options.getByText('Dashed', { exact: true }).click();
  const [dash, gap] = [options.locator('input').nth(0), options.locator('input').nth(1)];
  for (const [input, value] of [[dash, 14], [gap, 14]]) { await input.click(); await input.fill(String(value)); await input.press('Tab'); }
  await page.keyboard.press('Escape');
  await field(page, 'vector-stroke-width', 8);
}

/** The trail from the backpack to the mine: anchors and the drag that sets each one's handles, in document pixels. */
const TRAIL = [[560, 752, 640, 742], [820, 662, 870, 627], [900, 480, 910, 420], [962, 300, 982, 255]];

const curvesOk = (page) => page.getByTestId('adjustment-ok');

/** A rotation (unlike a move or a handle resize) stays a pending transform until it is applied. */
async function applyPendingTransform(page) {
  const apply = page.getByTestId('applyTransform');
  if (await apply.isVisible().catch(() => false) && await apply.isEnabled().catch(() => false)) await apply.click();
  await page.waitForTimeout(300);
}

// MARK: Screenshots

const shotPath = (name) => path.join(out, `${name}.png`);
async function shot(page, name, clip) {
  const file = shotPath(name);
  await page.screenshot({ path: file, clip });
  execFileSync('magick', [file, '-quality', '82', path.join(out, `${name}.webp`)]);
  console.log(`${name}.png ${Math.round(clip.width * 2)}×${Math.round(clip.height * 2)}`);
}

async function screenshots() {
  const { context, page } = await launch();
  await openDocument(page, mountains);
  await place(page, backpack);
  await rename(page, 'Backpack.png', 'Backpack');

  // The cut-out: Best quality model, then the result on transparency with its mask in the Layers panel.
  const removal = await removeBackground(page);
  await removal.best.click();
  await removal.run();
  await removal.ok.click();
  await page.waitForTimeout(1500);
  await transformTo(page, { W: 462 });
  await transformTo(page, { X: 900, Y: 176 });
  await row(page, 'Mountains').getByTestId('layer-eye').click();
  await row(page, 'Backpack').click();
  await page.waitForTimeout(800);
  await shot(page, 'image-cutout', { x: 590, y: 292, width: 632, height: 376 });
  await row(page, 'Mountains').getByTestId('layer-eye').click();
  await row(page, 'Backpack').click();

  // Mid-rotation: rotated bounding box and handles, the angle live in the transform bar.
  await transformTo(page, { X: 100, Y: 320 });
  await page.waitForTimeout(400);
  {
    const toScreen = await view(page);
    const box = await layerBox(page);
    const centre = toScreen(box.x + box.width / 2, box.y + box.height / 2);
    const top = toScreen(box.x + box.width / 2, box.y);
    const radius = centre.y - top.y + 28;
    const at = (deg) => [centre.x + radius * Math.sin(deg * Math.PI / 180), centre.y - radius * Math.cos(deg * Math.PI / 180)];
    await page.mouse.move(...at(0));
    await page.mouse.down();
    for (let deg = 0; deg >= -12; deg -= 1) await page.mouse.move(...at(deg));
    await page.waitForTimeout(500);
    await shot(page, 'image-transform', { x: 165, y: 92, width: 735, height: 576 });
    for (let deg = -12; deg <= -6; deg += 1) await page.mouse.move(...at(deg));
    await page.mouse.up();
    await page.waitForTimeout(300);
    await applyPendingTransform(page);
  }

  // Text being edited, with the type controls.
  await textToolReady(page);
  await textStyle(page);
  {
    const toScreen = await view(page);
    const point = toScreen(80, 120);
    await page.mouse.click(point.x, point.y);
  }
  await page.waitForTimeout(500);
  await page.keyboard.type(TEXT, { delay: 40 });
  await page.waitForTimeout(800);
  await shot(page, 'image-text', { x: 12, y: 92, width: 962, height: 470 });
  await page.getByTestId('text-commit').click();
  await page.waitForTimeout(500);
  await page.getByTestId('tool-move').click();
  await transformTo(page, { X: 64, Y: 44 });

  // Layer style: a drop shadow on the text, the dialog moved beside it.
  await page.getByTestId('fx-button').click();
  await page.getByRole('menuitem', { name: /Drop Shadow/ }).click();
  const style = page.getByTestId('layer-style-dialog');
  await style.waitFor();
  await page.waitForTimeout(500);
  await field(page, 'style-opacity', 60);
  await field(page, 'style-distance', 8);
  await field(page, 'style-size', 16);
  const textWidth = (await layerBox(page)).width;
  await page.getByTestId('toggle-panels').click();   // no Layers panel showing through the dialog's glass
  await page.waitForTimeout(1500);
  {
    const sky = await canvasEdges(page, 640);
    const zoom = (sky.right - sky.left + 1) / DOC.width;
    const canvasLeft = sky.left, textRight = canvasLeft + (64 + textWidth) * zoom;
    const box = await style.boundingBox();
    const from = { x: box.x + 160, y: box.y + 22 };
    const dx = textRight + 24 - box.x;
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= 10; i += 1) await page.mouse.move(from.x + dx * i / 10, from.y);
    await page.mouse.up();
    await page.waitForTimeout(500);
    const moved = await style.boundingBox();
    const left = Math.max(0, canvasLeft - 10);
    await shot(page, 'image-styles', { x: left, y: moved.y - 8, width: moved.x + moved.width + 10 - left, height: moved.height + 16 });
  }
  await page.getByTestId('style-ok').click();
  await page.waitForTimeout(300);
  await page.getByTestId('toggle-panels').click();
  await page.waitForTimeout(1000);
  await page.getByTestId('fit').click();   // back to the fitted view the other pictures are framed for
  await page.waitForTimeout(800);

  // A pen path: the dashed trail, one anchor's handle being dragged with Direct Selection.
  await page.getByTestId('tool-pen').click();
  await page.getByTestId('vector-fill').waitFor();
  await page.waitForTimeout(500);
  await trailStyle(page);
  {
    const toScreen = await view(page);
    for (const [x, y, hx, hy] of TRAIL) {
      const a = toScreen(x, y), b = toScreen(hx, hy);
      await page.mouse.move(a.x, a.y);
      await page.mouse.down();
      for (let i = 1; i <= 6; i += 1) await page.mouse.move(a.x + (b.x - a.x) * i / 6, a.y + (b.y - a.y) * i / 6);
      await page.mouse.up();
      await page.waitForTimeout(200);
    }
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    await rename(page, 'Shape 1', 'Trail');
    await page.getByTestId('tool-directSelect').click();
    await page.waitForTimeout(600);
    const [x, y, hx, hy] = TRAIL[2];
    const anchor = toScreen(x, y), handle = toScreen(hx, hy);
    await page.mouse.click(anchor.x, anchor.y);
    await page.waitForTimeout(400);
    await page.mouse.move(handle.x, handle.y);
    await page.mouse.down();
    for (let i = 1; i <= 8; i += 1) await page.mouse.move(handle.x + 26 * i / 8, handle.y - 6 * i / 8);
    await page.waitForTimeout(400);
    await shot(page, 'image-shapes', { x: 12, y: 92, width: 892, height: 576 });
    await page.mouse.up();
    await page.waitForTimeout(300);
  }

  // Curves as an adjustment layer, an S-curve next to the canvas.
  await page.getByTestId('tool-move').click();
  await menu(page, 'Layer', /^New Adjustment Layer/);
  await page.waitForTimeout(300);
  await page.getByRole('menuitem', { name: /^Curves/ }).last().click();
  await page.getByTestId('curves-graph').waitFor();
  await page.waitForTimeout(800);
  await sCurve(page, async () => {});
  await page.waitForTimeout(800);
  await shot(page, 'image-curves', { x: 136, y: 160, width: 808, height: 520 });
  await curvesOk(page).click();
  await page.waitForTimeout(800);

  // The Layers panel: adjustment, shape, text with effect, photo with mask, illustration.
  await shot(page, 'image-layers', { x: 372, y: 164, width: 850, height: 500 });

  // Color Range on the illustration: the sky sampled, the unselected rest tinted.
  await row(page, 'Mountains').click();
  await page.getByTestId('tool-marquee').click();
  await menu(page, 'Select', /^Color Range/);
  await page.getByTestId('color-range-panel').waitFor();
  await page.waitForTimeout(800);
  {
    const toScreen = await view(page);
    const sky = toScreen(170, 120);
    await page.mouse.click(sky.x, sky.y);
  }
  await field(page, 'color-range-fuzziness', 70);
  await page.getByTestId('color-range-panel').getByText('Color Range', { exact: true }).click();
  await page.waitForTimeout(5000);
  await shot(page, 'image-selection', { x: 136, y: 160, width: 808, height: 520 });
  await page.getByTestId('color-range-cancel').click();
  await page.waitForTimeout(500);

  // Export: WebP with its quality, the preview and the estimated size.
  await row(page, 'Curves').click();
  await menu(page, 'File', /^Export As/);
  await page.getByTestId('export-preview-image').waitFor({ timeout: 120000 });
  await page.getByTestId('export-format-webp').click();
  for (let i = 0; i < 100 && !/[KM]B/.test(await page.getByTestId('export-estimate').innerText().catch(() => '')); i += 1) await page.waitForTimeout(200);
  await page.waitForTimeout(1500);
  await shot(page, 'image-export', await page.getByTestId('export-dialog').boundingBox());
  await page.getByTestId('export-dialog').getByRole('button', { name: 'Cancel' }).click();
  await context.close();
}

/** Pulls the curve into an S: darker shadows, brighter highlights. `step` runs after every pointer move (a video frame). */
async function sCurve(page, step, glide = null) {
  const graph = await page.getByTestId('curves-graph').boundingBox();
  for (const [fx, fy, dy] of [[0.25, 0.75, 0.08], [0.75, 0.25, -0.08]]) {
    const x = graph.x + graph.width * fx, y = graph.y + graph.height * fy;
    if (glide) await glide({ x, y }); else await page.mouse.move(x, y);
    await page.mouse.down();
    for (let i = 1; i <= 7; i += 1) {
      await page.mouse.move(x, y + graph.height * dy * (i / 7));
      await page.waitForTimeout(40);
      await step();
    }
    await page.mouse.up();
    await page.waitForTimeout(200);
    await step();
  }
}

// MARK: Video

const SPEED = 1.5;              // playback speed-up of the assembled take (setpts=PTS/1.5)
const FRAME = 1 / 30;           // nominal duration of one captured step
const VIDEO_CLIP = { x: 0, y: 46, width: 1264, height: 700 };
const VIDEO_WIDTH = 1600;

async function video() {
  const { context, page } = await launch({ pointer: true });
  const frameDir = path.join(work, 'frames');
  mkdirSync(frameDir, { recursive: true });
  const frames = [];
  const frame = async (duration = FRAME) => {
    const file = path.join(frameDir, `${String(frames.length).padStart(5, '0')}.jpg`);
    await page.screenshot({ path: file, type: 'jpeg', quality: 92, clip: VIDEO_CLIP });
    frames.push({ file, duration });
  };
  const hold = (seconds) => { frames[frames.length - 1].duration += seconds; };
  let pointer = { x: 1010, y: 690 };
  const centre = async (target) => {
    if (!target.boundingBox) return target;
    const box = await target.boundingBox();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const glide = async (target, steps = 12) => {
    const to = await centre(target);
    const from = pointer;
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps, ease = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      await page.mouse.move(from.x + (to.x - from.x) * ease, from.y + (to.y - from.y) * ease);
      await frame();
    }
    pointer = to;
  };
  // Inside an open menu the pointer moves along the menu first (straight down, or across into a submenu), so it never
  // crosses another menu-bar title or item on the way, which would switch menus.
  const menuGlide = async (target, across = false, steps = 7) => {
    const to = await centre(target);
    await glide(across ? { x: to.x, y: pointer.y } : { x: pointer.x, y: to.y }, Math.ceil(steps / 2));
    await glide(to, Math.ceil(steps / 2));
  };
  const menuClick = async (target, across = false) => {
    await menuGlide(target, across);
    await page.mouse.down();
    await frame();
    await page.mouse.up();
    await frame();
  };
  const click = async (target, steps = 12) => {
    await glide(target, steps);
    await page.mouse.down();
    await frame();
    await page.mouse.up();
    await frame();
  };
  const drag = async (from, to, steps = 16, settle = 0) => {
    await glide(from);
    await page.mouse.down();
    await frame();
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps, ease = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      await page.mouse.move(from.x + (to.x - from.x) * ease, from.y + (to.y - from.y) * ease);
      if (settle) await page.waitForTimeout(settle);
      await frame();
    }
    await page.mouse.up();
    await frame();
    pointer = to;
  };
  const frames_ = async (count, gap = 60) => { for (let i = 0; i < count; i += 1) { await page.waitForTimeout(gap); await frame(); } };

  // Setup, not filmed: the scene, the Type tool's style, the photo placed on top.
  await openDocument(page, mountains);
  await row(page, 'Mountains').click();
  await textToolReady(page);
  await textStyle(page);
  await page.getByTestId('tool-move').click();
  await place(page, backpack);
  await rename(page, 'Backpack.png', 'Backpack');
  await row(page, 'Mountains').getByTestId('layer-eye').click();
  await row(page, 'Backpack').click();
  await page.mouse.move(pointer.x, pointer.y);
  await page.waitForTimeout(800);
  const toScreen = await view(page);

  // 1. The photo alone (the scene layer hidden); remove its background (the model run is cut).
  await frame(0.7);
  await click(page.getByTestId('menu-Filter'));
  await frames_(2);
  const removal = await removeBackground(page, { open: () => menuClick(page.getByRole('menuitem', { name: 'Remove Background…' }).first()) });
  await frames_(3);
  await click(removal.best, 8);
  await frames_(5, 120);
  await removal.run();
  await frame(0.15);
  await click(removal.ok, 8);
  await frames_(4, 250);
  hold(0.5);

  // The mountains appear behind the cut-out.
  await click(row(page, 'Mountains').getByTestId('layer-eye'), 12);
  await frames_(3, 150);
  hold(0.35);
  await glide(toScreen(1000, 600), 10);

  // 2. Scale with the bottom-right handle, move it onto the meadow, rotate it.
  let box = await layerBox(page);
  const corner = toScreen(box.x + box.width, box.y + box.height);
  const scaled = toScreen(box.x + box.width * 0.55, box.y + box.height * 0.55);
  await drag(corner, scaled, 16);
  hold(0.15);
  box = await layerBox(page);
  const middle = toScreen(box.x + box.width / 2, box.y + box.height / 2);
  const target = toScreen(100 + box.width / 2, 320 + box.height / 2);
  await drag(middle, target, 18);
  hold(0.15);
  box = await layerBox(page);
  {
    const c = toScreen(box.x + box.width / 2, box.y + box.height / 2);
    const radius = c.y - toScreen(0, box.y).y + 28;
    const at = (deg) => ({ x: c.x + radius * Math.sin(deg * Math.PI / 180), y: c.y - radius * Math.cos(deg * Math.PI / 180) });
    await glide(at(0));
    await page.mouse.down();
    await frame();
    for (let deg = -1; deg >= -6; deg -= 1) { await page.mouse.move(at(deg).x, at(deg).y); await frame(); }
    await page.mouse.up();
    if (await page.getByTestId('applyTransform').isEnabled().catch(() => false)) await page.getByTestId('applyTransform').evaluate((button) => button.click());
    await page.waitForTimeout(100);
    await frame();
    pointer = at(-6);
  }
  hold(0.3);

  // 3. A text layer, typed, committed and dragged into place.
  await click(page.getByTestId('tool-text'));
  await frame();
  await click(toScreen(300, 130), 10);
  await frames_(2);
  for (const char of TEXT) { await page.keyboard.type(char); await frame(); }
  hold(0.2);
  await click(page.getByTestId('text-commit'), 10);
  await frames_(2);
  await click(page.getByTestId('tool-move'), 10);
  box = await layerBox(page);
  await drag(toScreen(box.x + box.width * 0.4, box.y + box.height * 0.5), toScreen(64 + box.width * 0.4, 44 + box.height * 0.5), 16);
  hold(0.3);

  // A drop shadow on the text: Layer > Layer Style > Drop Shadow.
  await click(page.getByTestId('menu-Layer'), 12);
  await frames_(2);
  await menuGlide(page.getByRole('menuitem', { name: /^Layer Style/ }).first());
  await page.waitForTimeout(300);
  if (!await page.getByRole('menuitem', { name: /^Drop Shadow/ }).last().isVisible().catch(() => false)) await page.mouse.click(pointer.x, pointer.y);
  await frames_(2);
  await menuClick(page.getByRole('menuitem', { name: /^Drop Shadow/ }).last(), true);
  await page.getByTestId('layer-style-dialog').waitFor();
  for (const [id, value] of [['style-opacity', 60], ['style-size', 16]]) {
    await page.getByTestId(id).fill(String(value));   // typed without the pointer, which stays where the video shows it
    await page.getByTestId(id).press('Tab');
  }
  await frames_(3, 120);
  hold(0.3);
  await click(page.getByTestId('style-ok'), 10);
  await frames_(3, 150);
  hold(0.2);

  // 4. A Curves adjustment layer on top: an S-curve, OK.
  await click(page.getByTestId('menu-Layer'));
  await frames_(2);
  await menuGlide(page.getByRole('menuitem', { name: /^New Adjustment Layer/ }).first());
  await page.waitForTimeout(300);
  if (!await page.getByRole('menuitem', { name: /^Curves/ }).last().isVisible().catch(() => false)) await page.mouse.click(pointer.x, pointer.y);
  await frames_(2);
  await menuClick(page.getByRole('menuitem', { name: /^Curves/ }).last(), true);
  await page.getByTestId('curves-graph').waitFor();
  await frames_(4, 120);
  await sCurve(page, () => frame(), async (point) => glide(point, 7));
  pointer = await centre(page.getByTestId('curves-graph'));
  hold(0.25);
  await click(curvesOk(page), 8);
  await frames_(3, 200);

  // A calm end: the finished picture, the pointer back where it started.
  await glide({ x: 1010, y: 690 }, 12);
  await frame(1.2);
  await context.close();

  const list = ['ffconcat version 1.0', ...frames.flatMap(({ file, duration }) => [`file '${file}'`, `duration ${duration.toFixed(4)}`]), `file '${frames.at(-1).file}'`];
  writeFileSync(path.join(work, 'frames.txt'), `${list.join('\n')}\n`);
  const mp4 = path.join(out, 'image-move.mp4');
  for (const crf of [23, 25, 27, 29, 31]) {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', path.join(work, 'frames.txt'),
      '-vf', `setpts=PTS/${SPEED},fps=30,scale=${VIDEO_WIDTH}:-2:flags=lanczos:in_range=full:out_range=tv,format=yuv420p`, '-pix_fmt', 'yuv420p', '-color_range', 'tv',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', String(crf), '-movflags', '+faststart', '-an', mp4]);
    if (statSync(mp4).size < 3.8 * 1024 * 1024) break;
  }
  execFileSync('magick', [frames.at(-1).file, '-resize', `${VIDEO_WIDTH}x`, '-quality', '86', path.join(out, 'image-move-poster.jpg')]);
  const length = frames.reduce((sum, { duration }) => sum + duration, 0) / SPEED;
  console.log(`image-move.mp4: ${length.toFixed(1)} s (${frames.length} frames, ${(statSync(mp4).size / 1024 / 1024).toFixed(2)} MB)`);
}

try {
  if (!flags.has('--no-shots')) await screenshots();
  if (!flags.has('--no-video')) await video();
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(problems.length ? `page errors:\n${problems.join('\n')}` : `capture-image: done in ${out}`);
