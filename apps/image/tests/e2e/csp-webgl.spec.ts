import { expect, test } from '@playwright/test';

/**
 * The Tauri build forbids JavaScript eval (tauri.conf.json: script-src 'self' 'wasm-unsafe-eval'). Pixi then needs its
 * static synchronisers; without them the editor silently fell back to the software renderer (A6b finding). The dev
 * server's inline preamble still needs 'unsafe-inline' here, but eval stays forbidden as in the app.
 */
test('the GPU renderer starts under a CSP without unsafe-eval', async ({ page }) => {
  await page.route(/\/\?harness=csp$/, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(),
      'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; worker-src 'self' blob:; "
        + "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: data: blob:" } });
  });
  const violations: string[] = [];
  page.on('console', (message) => { if (/unsafe-eval|Content Security Policy/i.test(message.text())) violations.push(message.text()); });
  await page.goto('/?harness=csp');
  // DevTools evaluation bypasses CSP, so probe with a string timer, which the page itself evaluates.
  expect(await page.evaluate(() => new Promise((resolve) => {
    document.addEventListener('securitypolicyviolation', (event) => resolve(event.blockedURI), { once: true });
    (window as any).__ran = false;
    setTimeout('window.__ran = true' as unknown as () => void, 0);
    setTimeout(() => resolve((window as any).__ran ? 'ran' : 'silent'), 500);
  }))).toBe('eval');
  violations.length = 0;
  const kind = await page.evaluate(async () => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const { mountEditor } = await load('/src/index.ts');
    const { createBrowserHost } = await load('/src/platform/browserHost.ts');
    const handle = await mountEditor(document.getElementById('root')!, { host: createBrowserHost(), locale: 'en' });
    await handle.newProject({ name: 'csp', width: 64, height: 64 });
    const view = (window as any).__editorForTests.canvasView;
    for (let i = 0; i < 100 && view.rendererKind === 'none'; i++) await new Promise((resolve) => setTimeout(resolve, 50));
    return view.rendererKind;
  });
  expect(kind).toBe('webgl2');
  expect(violations.filter((v) => /eval/i.test(v))).toEqual([]);
});
