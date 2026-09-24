import { startMatrixPage } from '../../tests/webview/matrix';
import { startA6SpikePage } from '../../tests/webview/a6-spike';
import { mountEditor } from '../../src';
import { createTauriHost } from './host';

function dispatchNativeShortcut(key: 'n' | 'w'): void {
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  window.dispatchEvent(new KeyboardEvent('keydown', {
    key, code: `Key${key.toUpperCase()}`, bubbles: true, cancelable: true,
    metaKey: mac, ctrlKey: !mac,
  }));
}

async function main(): Promise<void> {
  const root = document.getElementById('root');
  if (!root) throw new Error('Missing application root');
  if (new URLSearchParams(location.search).has('a6-spike')) {
    const result = await startA6SpikePage(root);
    await window.__TAURI__.core.invoke('a6_write_result', { result: JSON.stringify(result, null, 2) });
    return;
  }
  if (new URLSearchParams(location.search).has('webview-matrix')) {
    const result = await startMatrixPage(root);
    await window.__TAURI__.core.invoke('write_matrix_result', { result: JSON.stringify(result, null, 2) });
    return;
  }
  document.body.style.cssText = 'margin:0;width:100vw;height:100vh;overflow:hidden';
  const locale = navigator.language.startsWith('de') ? 'de' : 'en';
  // The standalone app owns the page, so the document language follows the UI (screen readers, hyphenation).
  document.documentElement.lang = locale;
  const host = createTauriHost();
  await mountEditor(root, {
    host,
    profile: 'pro',
    locale,
    theme: 'dark',
  });
  const [fonts, profile] = await Promise.all([
    host.capabilities!.fonts!.listSystemFonts(), host.capabilities!.color!.displayProfile(),
  ]);
  console.info(`[Fernwork host] ${fonts.length} system fonts; display profile: ${profile.name}${profile.assumed ? ' (assumed)' : ''}`);
  await window.__TAURI__.event.listen('fernwork-menu-new', () => dispatchNativeShortcut('n'));
  await window.__TAURI__.event.listen('fernwork-menu-close', () => dispatchNativeShortcut('w'));
}

const started = main();
if (new URLSearchParams(location.search).has('a6-spike')) {
  void started.catch(async (error: unknown) => {
    const message = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error);
    console.error(message);
    try { await window.__TAURI__.core.invoke('a6_write_result', { result: JSON.stringify({ fatalError: message }, null, 2) }); }
    catch { /* The original error is the useful one. */ }
  });
} else {
  void started;
}
