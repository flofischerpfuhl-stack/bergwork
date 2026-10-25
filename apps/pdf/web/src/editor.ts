/**
 * Loads and mounts the PDF editor. Its files sit below the page at tools/vendor/ (scripts/build-frontend.mjs): the
 * PDF.js and pdf-lib runtimes the editor expects as globals, its stylesheet and the bundle built from the source fork.
 * The bundle takes its vendor root from globalThis.__bergworkVendor (scripts/build-editor.mjs), so the app runs at
 * any path: the root of the desktop app or /app/pdf/ on bergwork.app.
 */
export interface EditorShell {
  /** The active document for the window title; empty when none is open. */
  readonly setTitle: (title: string, options?: { readonly dirty?: boolean }) => void;
  /** A sample document the empty state offers next to "Choose PDF or project" (the web app only). */
  readonly sample?: { readonly label: string; readonly open: () => void };
}

interface EditorBundle {
  mount(element: HTMLElement, options: { host: { capabilities: Record<string, unknown> } }): unknown;
}

declare global {
  // eslint-disable-next-line no-var
  var __bergworkVendor: string | undefined;
}

/** The editor stylesheet goes first in <head>, so the berg:work stylesheets win the cascade. */
function loadStylesheet(href: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.onload = () => resolve();
    link.onerror = () => reject(new Error(`Could not load ${href}`));
    document.head.prepend(link);
  });
}

export async function mountEditor(element: HTMLElement, shell: EditorShell): Promise<void> {
  const vendor = new URL('./tools/vendor/', document.baseURI).href;
  globalThis.__bergworkVendor = vendor;
  const [pdfLib, pdfjs] = await Promise.all([
    import(/* @vite-ignore */ `${vendor}pdf-runtime/pdf-lib.esm.min.js`),
    import(/* @vite-ignore */ `${vendor}pdf-runtime/pdf.min.mjs`),
    loadStylesheet(`${vendor}pdf-tools/oo-pdf-tools.css`),
  ]);
  Object.assign(globalThis, { PDFLib: pdfLib, pdfjsLib: pdfjs });
  pdfjs.GlobalWorkerOptions.workerSrc = `${vendor}pdf-runtime/pdf.worker.min.mjs`;
  const bundle = await import(/* @vite-ignore */ `${vendor}pdf-tools/oo-pdf-tools.js`) as EditorBundle;
  // 'islands': the chrome laid out as berg:work Image's (top: document and tools | file and panels; bottom: status).
  // 'manual': Properties opens on request only; formatting is in the mini toolbar at the object.
  bundle.mount(element, { host: { capabilities: { shell: {
    version: 1, chrome: 'islands', inspector: 'manual', setTitle: shell.setTitle, sample: shell.sample,
  } } } });
}
