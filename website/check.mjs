import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { startServer } from './serve.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');
const shots = path.join(root, '.check-out');
const playwrightPath = '/home/oem/Dokumente/003_Projekte/17_fernwork/node_modules/playwright/index.mjs';
const axePath = '/home/oem/Dokumente/003_Projekte/10_himmelcad/node_modules/axe-core/axe.min.js';
const routes = ['/', '/pdf/', '/image/', '/roadmap/', '/download/', '/legal/', '/privacy/', '/offline/', '/404.html'];
const results = [];
const failures = [];

function record(gate, passed, detail) {
  results.push({ gate, passed, detail });
  if (!passed) failures.push(`${gate}: ${detail}`);
}

async function filesBelow(directory, extension = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const item = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(item, extension));
    else if (!extension || item.endsWith(extension)) files.push(item);
  }
  return files;
}

function localTarget(urlPath) {
  const clean = urlPath.split('#')[0].split('?')[0];
  if (!clean || clean.startsWith('mailto:') || clean.startsWith('tel:') || clean.startsWith('data:')) return null;
  if (/^[a-z]+:/i.test(clean)) return clean;
  const relative = clean.replace(/^\//, '');
  const candidates = clean.endsWith('/') || clean === '' ? [path.join(dist, relative, 'index.html')] : [path.join(dist, relative), path.join(dist, relative, 'index.html')];
  return candidates.find((candidate) => existsSync(candidate)) || candidates[0];
}

function pngSize(buffer) {
  if (buffer.toString('hex', 0, 8) !== '89504e470d0a1a0a') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function staticChecks() {
  const htmlFiles = await filesBelow(dist, '.html');
  try {
    execFileSync('npx', ['-y', 'html-validate@9', ...htmlFiles], { cwd: root, stdio: 'pipe' });
    record('HTML validity', true, `${htmlFiles.length} pages`);
  } catch (error) {
    record('HTML validity', false, String(error.stdout || error.stderr || error.message).trim().slice(0, 1200));
  }

  const banned = [
    'seamless', 'powerful', 'cutting-edge', 'next-generation', 'revolutionary', 'game-changing',
    'blazing fast', 'effortless', 'robust', 'intuitive', 'world-class', 'unlock', 'supercharge',
    'empower', 'elevate', 'take it to the next level', 'take your work to the next level', 'all-in-one',
    'built for professionals', 'photoshop', 'gimp', 'photopea', 'affinity',
  ];
  const hits = [];
  for (const file of htmlFiles) {
    const content = (await readFile(file, 'utf8')).toLowerCase();
    for (const phrase of banned) if (content.includes(phrase)) hits.push(`${path.relative(dist, file)}: ${phrase}`);
  }
  record('Banned phrases and competitor names', hits.length === 0, hits.length ? hits.join(', ') : 'none found');

  const { default: siteConfig } = await import('./site.config.mjs');
  const siteOrigin = siteConfig.siteUrl ? new URL(siteConfig.siteUrl).origin : '';
  const unresolved = [];
  for (const file of htmlFiles) {
    const content = await readFile(file, 'utf8');
    const attributes = [...content.matchAll(/\b(?:href|src|poster)="([^"]+)"/g)].map((match) => match[1]);
    for (let value of attributes) {
      // Canonical, hreflang and og:url point at the production origin; check them as local paths.
      if (siteOrigin && value.startsWith(siteOrigin)) value = value.slice(siteOrigin.length) || '/';
      const target = localTarget(value);
      if (!target) continue;
      if (/^[a-z]+:/i.test(target)) { unresolved.push(`${path.relative(dist, file)} external: ${target}`); continue; }
      if (!existsSync(target)) unresolved.push(`${path.relative(dist, file)} → ${value}`);
    }
  }
  const cssFile = (await filesBelow(path.join(dist, 'assets', 'css'), '.css'))[0];
  const css = await readFile(cssFile, 'utf8');
  for (const match of css.matchAll(/url\(['"]?([^)'"\s]+)['"]?\)/g)) {
    const target = localTarget(match[1]);
    if (target && !existsSync(target)) unresolved.push(`CSS → ${match[1]}`);
  }
  if (css.includes('__HERO_') || css.includes('__FONT_')) unresolved.push('CSS contains unresolved build tokens');
  record('Internal links and assets', unresolved.length === 0, unresolved.length ? unresolved.join(', ') : 'all resolved');

  const manifest = JSON.parse(await readFile(path.join(dist, 'manifest.webmanifest'), 'utf8'));
  const iconErrors = [];
  for (const icon of manifest.icons) {
    const target = localTarget(icon.src);
    if (!target || !existsSync(target)) { iconErrors.push(`missing ${icon.src}`); continue; }
    if (icon.type === 'image/png') {
      const dimensions = pngSize(await readFile(target));
      if (`${dimensions?.width}x${dimensions?.height}` !== icon.sizes) iconErrors.push(`${icon.src}: expected ${icon.sizes}, got ${dimensions?.width}x${dimensions?.height}`);
    }
  }
  record('Manifest and icon sizes', iconErrors.length === 0, iconErrors.length ? iconErrors.join(', ') : `${manifest.icons.length} icons verified`);

  const ogFile = (await filesBelow(path.join(dist, 'assets', 'img'), '.png')).find((file) => path.basename(file).startsWith('og-bergwork.'));
  const ogSize = ogFile ? pngSize(await readFile(ogFile)) : null;
  record('Open Graph image', ogSize?.width === 1200 && ogSize?.height === 630, ogSize ? `${ogSize.width}×${ogSize.height}` : 'missing');

  const weightErrors = [];
  const sharedWeight = (await stat(cssFile)).size + (await Promise.all((await filesBelow(path.join(dist, 'assets', 'js'), '.js')).map((file) => stat(file)))).reduce((sum, info) => sum + info.size, 0);
  for (const file of htmlFiles) {
    const bytes = (await stat(file)).size + sharedWeight;
    if (bytes >= 150 * 1024) weightErrors.push(`${path.relative(dist, file)} ${Math.ceil(bytes / 1024)} KB`);
  }
  record('Page-weight budget', weightErrors.length === 0, weightErrors.length ? weightErrors.join(', ') : 'all pages below 150 KB excluding fonts, hero images and media');
}

async function browserChecks() {
  if (!existsSync(playwrightPath)) {
    record('Browser gates', false, `Playwright not found at ${playwrightPath}`);
    return;
  }
  if (!existsSync(axePath)) {
    record('axe-core', false, `axe-core not found at ${axePath}`);
    return;
  }
  const { chromium } = await import(playwrightPath);
  const axeSource = await readFile(axePath, 'utf8');
  const { server, url } = await startServer({ port: 0, quiet: true });
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ serviceWorkers: 'allow' });
    const page = await context.newPage();
    const external = new Set();
    page.on('request', (request) => {
      try { if (new URL(request.url()).origin !== new URL(url).origin) external.add(request.url()); } catch {}
    });
    await page.addInitScript(() => {
      window.__cspViolations = [];
      window.addEventListener('securitypolicyviolation', (event) => window.__cspViolations.push(`${event.violatedDirective}: ${event.blockedURI}`));
    });

    const axeErrors = [];
    const overflowErrors = [];
    const typographyErrors = [];
    const displayCharacters = new Set();
    const cspErrors = [];
    await rm(shots, { recursive: true, force: true });
    await mkdir(shots, { recursive: true });

    for (const route of routes) {
      const slug = route === '/' ? 'home' : route.replace(/^\//, '').replace(/\/$/, '').replace(/\.html$/, '') || 'home';
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${url}${route}`, { waitUntil: 'networkidle' });
      await page.evaluate(axeSource);
      const axeResult = await page.evaluate(async () => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] } }));
      if (axeResult.violations.length) axeErrors.push(`${route}: ${axeResult.violations.map((item) => item.id).join(', ')}`);
      await page.screenshot({ path: path.join(shots, `${slug}-1440.png`), fullPage: true });
      for (const width of [360, 768, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        const overflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth);
        if (overflow > 1) overflowErrors.push(`${route} @ ${width}: ${overflow}px`);
        const typography = await page.evaluate(() => {
          const visible = (element) => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
          };
          const transformedText = (element) => {
            const text = element.innerText || '';
            const transform = getComputedStyle(element).textTransform;
            if (transform === 'uppercase') return text.toLocaleUpperCase('en');
            if (transform === 'lowercase') return text.toLocaleLowerCase('en');
            if (transform === 'capitalize') return text.replace(/\b\p{L}/gu, (character) => character.toLocaleUpperCase('en'));
            return text;
          };
          const wordSplits = [];
          const headingOverflow = [];
          const numericDisplay = [];
          const characters = [];
          const displayElements = [...document.querySelectorAll('*')].filter((element) => visible(element) && getComputedStyle(element).fontFamily.includes('Bergschrift'));
          for (const element of displayElements) {
            const displayText = transformedText(element);
            characters.push(...displayText);
            if (/[\p{N}\p{Sc}]/u.test(displayText)) numericDisplay.push(`${element.tagName.toLowerCase()} “${displayText.trim()}”`);
            const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode())) {
              for (const match of node.data.matchAll(/\S+/gu)) {
                const range = document.createRange();
                range.setStart(node, match.index);
                range.setEnd(node, match.index + match[0].length);
                const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
                if (rects.length > 1) wordSplits.push(`${element.tagName.toLowerCase()} “${match[0]}”`);
              }
            }
          }
          for (const heading of document.querySelectorAll('h1, h2, h3')) {
            if (!visible(heading)) continue;
            const parent = heading.parentElement;
            const parentRect = parent.getBoundingClientRect();
            const parentStyle = getComputedStyle(parent);
            const left = parentRect.left + parseFloat(parentStyle.paddingLeft || '0');
            const right = parentRect.right - parseFloat(parentStyle.paddingRight || '0');
            const range = document.createRange();
            range.selectNodeContents(heading);
            const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
            // Bergschrift has pronounced side bearings. Permit their small visual
            // overhang while still failing titles that exceed their container.
            if (heading.scrollWidth > heading.clientWidth + 2 || rects.some((rect) => rect.left < left - 8 || rect.right > right + 8)) {
              headingOverflow.push(`${heading.tagName.toLowerCase()} “${(heading.innerText || '').trim()}”`);
            }
          }
          return { wordSplits: [...new Set(wordSplits)], headingOverflow: [...new Set(headingOverflow)], numericDisplay: [...new Set(numericDisplay)], characters };
        });
        for (const character of typography.characters) displayCharacters.add(character);
        if (typography.wordSplits.length) typographyErrors.push(`${route} @ ${width} split: ${typography.wordSplits.join(', ')}`);
        if (typography.headingOverflow.length) typographyErrors.push(`${route} @ ${width} overflow: ${typography.headingOverflow.join(', ')}`);
        if (typography.numericDisplay.length) typographyErrors.push(`${route} @ ${width} numeric display text: ${typography.numericDisplay.join(', ')}`);
      }
      await page.setViewportSize({ width: 360, height: 800 });
      await page.screenshot({ path: path.join(shots, `${slug}-360.png`), fullPage: true });
      const violations = await page.evaluate(() => window.__cspViolations || []);
      if (violations.length) cspErrors.push(`${route}: ${violations.join(', ')}`);
    }
    record('axe-core WCAG 2.2 AA', axeErrors.length === 0, axeErrors.length ? axeErrors.join(' | ') : `${routes.length} pages`);
    record('Horizontal overflow', overflowErrors.length === 0, overflowErrors.length ? overflowErrors.join(' | ') : `${routes.length} pages at 360/768/1440`);
    record('Display typography layout', typographyErrors.length === 0, typographyErrors.length ? typographyErrors.join(' | ') : 'no split display words, overflowing headings or display-font numbers at 360/768/1440');
    let missingGlyphs = [];
    try {
      const fontPath = path.join(root, 'src', 'assets', 'fonts', 'Bergschrift-Regular.woff2');
      const script = "import json,sys; from fontTools.ttLib import TTFont; f=TTFont(sys.argv[1]); cmap={c for t in f['cmap'].tables for c in t.cmap}; chars=json.loads(sys.argv[2]); print(json.dumps([c for c in chars if not c.isspace() and ord(c) not in cmap]))";
      missingGlyphs = JSON.parse(execFileSync('python3', ['-c', script, fontPath, JSON.stringify([...displayCharacters])], { encoding: 'utf8' }));
    } catch (error) {
      missingGlyphs = [`font cmap check failed: ${error.message}`];
    }
    record('Display font character coverage', missingGlyphs.length === 0, missingGlyphs.length ? `missing: ${[...new Set(missingGlyphs)].join(' ')}` : `${displayCharacters.size} transformed characters covered`);
    record('CSP violations', cspErrors.length === 0, cspErrors.length ? cspErrors.join(' | ') : 'none');
    record('No external requests', external.size === 0, external.size ? [...external].join(', ') : 'local origin only');

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.keyboard.press('Tab');
    const firstFocus = await page.evaluate(() => document.activeElement?.classList.contains('skip-link'));
    const focusOutline = await page.evaluate(() => {
      const style = getComputedStyle(document.activeElement);
      return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
    });
    await page.keyboard.press('Tab');
    const secondFocus = await page.evaluate(() => document.activeElement?.closest('.site-header') !== null);
    record('Keyboard and focus', firstFocus && secondFocus && focusOutline.style !== 'none' && focusOutline.width >= 2, `skip first=${firstFocus}, header second=${secondFocus}, outline=${focusOutline.style} ${focusOutline.width}px`);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const transition = await page.locator('.button').first().evaluate((element) => getComputedStyle(element).transitionDuration);
    record('Reduced motion', transition.split(',').every((value) => value.trim() === '0s'), `CTA transition-duration: ${transition}`);

    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.goto(`${url}/pdf/`, { waitUntil: 'networkidle' });
    await context.setOffline(true);
    let offlineHome = false;
    let offlineInner = false;
    try { await page.goto(url, { waitUntil: 'domcontentloaded' }); offlineHome = await page.locator('h1').count() > 0; } catch {}
    try { await page.goto(`${url}/pdf/`, { waitUntil: 'domcontentloaded' }); offlineInner = await page.locator('h1').count() > 0; } catch {}
    await context.setOffline(false);
    record('Service worker offline reload', offlineHome && offlineInner, `home=${offlineHome}, /pdf/=${offlineInner}`);
    record('Responsive screenshots', true, `${routes.length * 2} files in website/.check-out/`);
    await context.close();
  } catch (error) {
    record('Browser gates', false, error.stack || error.message);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

await staticChecks();
await browserChecks();

console.log('\nGate results');
for (const result of results) console.log(`${result.passed ? 'PASS' : 'FAIL'}\t${result.gate}\t${result.detail}`);
if (failures.length) {
  console.error(`\n${failures.length} gate(s) failed.`);
  process.exitCode = 1;
}
