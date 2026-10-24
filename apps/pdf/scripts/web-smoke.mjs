#!/usr/bin/env node
// Headless smoke test of an assembled berg:work PDF frontend: load it, open a PDF through the file input, save
// screenshots, fail on page errors, console errors or failed requests. Serve the frontend first (for apps/pdf/dist:
// `python3 -m http.server 5250 -d apps/pdf/dist`). Playwright comes from apps/image's dependencies; headless only.
//
//   node apps/pdf/scripts/web-smoke.mjs [url] [pdf] [out-dir]
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { chromium } = createRequire(path.join(appDir, '..', 'image', 'package.json'))('playwright');
const [url = 'http://127.0.0.1:5250/', pdf = path.join(appDir, 'scripts', 'fixtures', 'smoke.pdf'), out = 'pdf-smoke'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ headless: true });
const problems = [];
for (const scheme of ['dark', 'light']) {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme, locale: 'en-US' })).newPage();
  page.on('pageerror', (error) => problems.push(`${scheme}: page error ${error}`));
  page.on('console', (message) => { if (message.type() === 'error') problems.push(`${scheme}: console ${message.text()}`); });
  page.on('response', (response) => { if (response.status() >= 400) problems.push(`${scheme}: ${response.status()} ${response.url()}`); });
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(out, `${scheme}-empty.png`) });
  await page.locator('input[type=file]').first().setInputFiles(pdf);
  await page.waitForTimeout(5000);
  await page.screenshot({ path: path.join(out, `${scheme}-open.png`) });
}
await browser.close();
console.log(problems.length ? problems.join('\n') : `web-smoke: no problems, screenshots in ${out}/`);
process.exitCode = problems.length ? 1 : 0;
