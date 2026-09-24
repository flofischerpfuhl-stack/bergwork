import { startMatrixPage } from '../../tests/webview/matrix';
import { startA6SpikePage } from '../../tests/webview/a6-spike';
import { mountEditor } from '../../src';
import { runLargeDocumentAcceptance } from '../../src/platform/largeDocumentAcceptance';
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
  if (new URLSearchParams(location.search).has('a4c-acceptance')) {
    document.body.style.cssText = 'margin:0;width:100vw;height:100vh;overflow:hidden';
    const archivePath = await window.__TAURI__.core.invoke<string>('a4c_archive_path');
    let controller!: EditorController;
    let markReady!: (value: EditorController) => void;
    const ready = new Promise<EditorController>((resolve) => { markReady = resolve; });
    const host = createTauriHost({ acceptanceArchivePath: archivePath, tileBudgetBytes: 4 * 1024 ** 3,
      controllerReady(value) { controller = value; markReady(value); } });
    await mountEditor(root, { host, locale: 'en', theme: 'dark' });
    await ready;
    const result = await runLargeDocumentAcceptance(controller, {
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
  await mountEditor(root, {
    host: createTauriHost(),
    locale: navigator.language.startsWith('de') ? 'de' : 'en',
    theme: 'dark',
  });
  await window.__TAURI__.event.listen('fernwork-menu-new', () => dispatchNativeShortcut('n'));
  await window.__TAURI__.event.listen('fernwork-menu-close', () => dispatchNativeShortcut('w'));
}

const started = main();
if (new URLSearchParams(location.search).has('a6-spike') || new URLSearchParams(location.search).has('a4c-acceptance')) {
  void started.catch(async (error: unknown) => {
    const message = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error);
    console.error(message);
    const command = new URLSearchParams(location.search).has('a6-spike') ? 'a6_write_result' : 'write_matrix_result';
    try { await window.__TAURI__.core.invoke(command, { result: JSON.stringify({ fatalError: message }, null, 2) }); }
    catch { /* The original error is the useful one. */ }
  });
} else {
  void started;
}
