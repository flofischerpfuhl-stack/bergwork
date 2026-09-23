import { startMatrixPage } from '../../tests/webview/matrix';
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
  if (new URLSearchParams(location.search).has('webview-matrix')) {
    const result = await startMatrixPage(root);
    await window.__TAURI__.core.invoke('write_matrix_result', { result: JSON.stringify(result, null, 2) });
    return;
  }
  document.body.style.cssText = 'margin:0;width:100vw;height:100vh;overflow:hidden';
  await mountEditor(root, {
    host: createTauriHost(),
    locale: navigator.language.startsWith('de') ? 'de' : 'en',
    theme: 'dark',
  });
  await window.__TAURI__.event.listen('fernwork-menu-new', () => dispatchNativeShortcut('n'));
  await window.__TAURI__.event.listen('fernwork-menu-close', () => dispatchNativeShortcut('w'));
}

void main();
