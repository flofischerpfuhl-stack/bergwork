// Bootstrap of the berg:work PDF host page. Mirrors Fernwork's tools/pdf-tools.html and
// tools/js/pdf-tools-shell.js, without the site navigation, service worker, storage-version cleanup and
// file-open router. Paths are relative to dist/, where scripts/build-frontend.mjs puts the pinned build.
import * as PDFLib from './tools/vendor/pdf-runtime/pdf-lib.esm.min.js';
import * as pdfjsLib from './tools/vendor/pdf-runtime/pdf.min.mjs';
import { createShellHost } from './host.js';
import { installNativeFiles, openDocumentsFromSystem } from './native-files.js';
import { initTheme } from './theme-preference.js';

globalThis.PDFLib = PDFLib;
globalThis.pdfjsLib = pdfjsLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./tools/vendor/pdf-runtime/pdf.worker.min.mjs', import.meta.url).href;

initTheme();
installNativeFiles();

const root = document.getElementById('pdf-workbench-root');
document.body.classList.add('oo-pdf-workbench-route');
await loadEditorCSS('./tools/vendor/pdf-tools/oo-pdf-tools.css');
const bundle = await import('./tools/vendor/pdf-tools/oo-pdf-tools.js');
bundle.mount(root, { host: createShellHost() });
openDocumentsFromSystem();

/** Loads the editor stylesheet in front of theme.css, so the berg:work overrides come later in the cascade. */
function loadEditorCSS(href) {
  return new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.onload = () => resolve();
    link.onerror = () => reject(new Error(`Could not load ${href}`));
    const theme = document.getElementById('bw-theme');
    if (theme) theme.before(link);
    else document.head.append(link);
  });
}
