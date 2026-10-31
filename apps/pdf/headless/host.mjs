// Node side of a headless engine page: the static server (server.mjs), headless Chromium (Playwright from
// apps/image's dependencies, the browsers already in ~/.cache/ms-playwright) and pages that load a bundled engine
// entry and wait until it is ready. Shared by the corpus runner (tests/run-corpus.mjs) and the agent CLI.
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';

const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Playwright, resolved from apps/image (no `npx playwright install`; the suite uses the local browsers). */
export function loadPlaywright() {
  const require = createRequire(path.join(appDir, '..', 'image', 'package.json'));
  return require('playwright');
}

/** The newest headless Chromium shell in the Playwright cache, for a Playwright whose own revision is not downloaded. */
function cachedHeadlessShell() {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), '.cache', 'ms-playwright');
  const candidates = (existsSync(cache) ? readdirSync(cache) : [])
    .map((name) => /^chromium_headless_shell-(\d+)$/.exec(name))
    .filter(Boolean)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .map((match) => path.join(cache, match[0], 'chrome-headless-shell-linux64', 'chrome-headless-shell'));
  return candidates.find((file) => existsSync(file)) || null;
}

// BERGWORK_PDF_CHROMIUM names a Chromium executable. Without it Playwright's own revision is used, or, when that one
// was never downloaded (node_modules newer than the browser cache), the newest headless shell that is there.
export async function launchBrowser(playwright, browserName) {
  const executablePath = browserName === 'chromium' ? process.env.BERGWORK_PDF_CHROMIUM : undefined;
  try {
    return await playwright[browserName].launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  } catch (error) {
    const fallback = browserName === 'chromium' && !executablePath && /Executable doesn't exist/.test(String(error?.message)) ? cachedHeadlessShell() : null;
    if (!fallback) throw error;
    return playwright.chromium.launch({ headless: true, executablePath: fallback });
  }
}

/**
 * Starts the server and a headless browser.
 * @param {{ distDir: string, harnessDir: string, corpusRoot: string, outDir: string, browser?: string,
 *   viewport?: { width: number, height: number } }} options
 */
export async function startHost({ distDir, harnessDir, corpusRoot, outDir, browser: browserName = 'chromium', viewport = { width: 1000, height: 800 } }) {
  const playwright = loadPlaywright();
  const server = await startServer({ distDir, harnessDir, corpusRoot, outDir });
  let browser;
  try {
    browser = await launchBrowser(playwright, browserName);
  } catch (error) {
    await server.close();
    throw error;
  }
  const context = await browser.newContext({ viewport });
  return {
    server,
    browser,
    context,
    /**
     * Opens `/__harness/<html>` and waits for `window.BW` (or `window.__harnessError`). The page records page errors
     * and crashes in `page.__events`.
     */
    async newEnginePage(html = 'harness.html', { timeout = 60_000 } = {}) {
      const page = await context.newPage();
      page.__events = [];
      page.on('pageerror', (error) => page.__events.push({ type: 'pageerror', message: String(error.message).slice(0, 300) }));
      page.on('crash', () => page.__events.push({ type: 'crash' }));
      await page.goto(`${server.url}/__harness/${html}`);
      await page.waitForFunction(() => window.BW || window.__harnessError, null, { timeout });
      const error = await page.evaluate(() => window.__harnessError);
      if (error) throw new Error(`harness failed to load: ${error}`);
      return page;
    },
    async close() {
      await browser.close().catch(() => {});
      await server.close();
    },
  };
}
