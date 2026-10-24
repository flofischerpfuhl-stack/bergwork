import { mountEditor } from '../../src';
import type { EditorController } from '../../src/ui/controller';
import { createTauriHost, nativeProjectBlob } from './host';

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
  if (import.meta.env.VITE_FERNWORK_MEASUREMENT === '1' && new URLSearchParams(location.search).has('webview-matrix')) {
    const { startMatrixPage } = await import('../../tests/webview/matrix');
    const result = await startMatrixPage(root);
    await window.__TAURI__.core.invoke('write_matrix_result', { result: JSON.stringify(result, null, 2) });
    return;
  }
  if (import.meta.env.VITE_FERNWORK_MEASUREMENT === '1' && new URLSearchParams(location.search).has('a4c-acceptance')) {
    const { runLargeDocumentAcceptance } = await import('../../src/platform/largeDocumentAcceptance');
    document.body.style.cssText = 'margin:0;width:100vw;height:100vh;overflow:hidden';
    const archivePath = await window.__TAURI__.core.invoke<string>('a4c_archive_path');
    let controller!: EditorController;
    let markReady!: (value: EditorController) => void;
    const ready = new Promise<EditorController>((resolve) => { markReady = resolve; });
    const host = createTauriHost({ acceptanceArchivePath: archivePath,
      controllerReady(value) { controller = value; markReady(value); },
      reportError(error) { throw new Error(`${error.code}: ${error.message}`); } });
    await mountEditor(root, { host, locale: 'en', theme: 'dark' });
    await ready;
    const result = await runLargeDocumentAcceptance(controller, {
      async stage(snapshot) {
        await window.__TAURI__.core.invoke('a4d_write_progress', { progress: JSON.stringify(snapshot) });
      },
      async save() {
        await controller.save(true);
        const archive = await nativeProjectBlob(archivePath);
        return { archive, bytes: archive.size };
      },
      async closeAndReopen(archive) {
        controller.workspace.removeTab(controller.workspace.current.id);
        await controller.openArchive(archive, 'A4c 200 MP');
      },
    });
    await window.__TAURI__.core.invoke('write_matrix_result', {
      result: JSON.stringify({ runtime: 'tauri-linux', ...result }, null, 2),
    });
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
  await window.__TAURI__.event.listen('fernwork-menu-new', () => dispatchNativeShortcut('n'));
  await window.__TAURI__.event.listen('fernwork-menu-close', () => dispatchNativeShortcut('w'));
}

const started = main();
const measurementPage = import.meta.env.VITE_FERNWORK_MEASUREMENT === '1'
  && ['webview-matrix', 'a4c-acceptance'].some((name) => new URLSearchParams(location.search).has(name));
if (measurementPage) {
  void started.catch(async (error: unknown) => {
    const message = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error);
    console.error(message);
    try { await window.__TAURI__.core.invoke('write_matrix_result', { result: JSON.stringify({ fatalError: message }, null, 2) }); }
    catch { /* The original error is the useful one. */ }
  });
} else {
  void started;
}
