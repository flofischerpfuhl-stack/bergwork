// Native files for the editor inside the app (no-ops in a plain browser).
//
// - Save / Save as / Export: the editor uses the File System Access API when `showSaveFilePicker` exists. This
//   module provides it on top of the native save dialog, so Save overwrites the chosen file and Save as asks again.
// - Other exports (page ranges, OCR text, …) are browser downloads of blob URLs; they are routed through the same
//   save dialog instead of silently landing in a downloads folder.
// - Documents the app is opened with (file manager, "Open with", a second launch) are handed to the editor like a
//   dropped file.

const invoke = globalThis.__TAURI__?.core?.invoke;
const listen = globalThis.__TAURI__?.event?.listen;

const PROJECT_TYPE = 'application/vnd.fernwork.pdf-project+json';

const basename = (path) => path.split(/[\\/]/).pop() || path;
const extensionOf = (name) => (/\.([a-z0-9]+)$/i.exec(name)?.[1] || '').toLowerCase();

function aborted() {
  return new DOMException('The user aborted a request.', 'AbortError');
}

async function writePath(path, parts) {
  const bytes = new Uint8Array(await new Blob(parts).arrayBuffer());
  await invoke('write_file', bytes, { headers: { 'x-bergwork-path': encodeURIComponent(path) } });
}

/** A minimal FileSystemFileHandle for a path chosen in the save dialog. */
function fileHandle(path) {
  return {
    kind: 'file',
    name: basename(path),
    async createWritable() {
      const parts = [];
      return {
        async write(data) {
          parts.push(data instanceof Blob ? data : new Blob([data?.data ?? data]));
        },
        async close() {
          await writePath(path, parts);
        },
        async abort() {
          parts.length = 0;
        },
      };
    },
  };
}

async function chooseSavePath(suggestedName, extensions, description) {
  return invoke('choose_save_path', { suggestedName, extensions, description });
}

function installSavePicker() {
  window.showSaveFilePicker = async (options = {}) => {
    const type = options.types?.[0];
    const extensions = type
      ? Object.values(type.accept || {}).flat().map((extension) => String(extension).replace(/^\./, ''))
      : [];
    const path = await chooseSavePath(options.suggestedName || 'document', extensions, type?.description || 'File');
    if (!path) throw aborted();
    return fileHandle(path);
  };
}

/** Keeps the blobs behind object URLs, so a download can still be read after the page revoked its URL. */
function installDownloads() {
  const blobs = new Map();
  const createObjectURL = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (object) => {
    const url = createObjectURL(object);
    if (object instanceof Blob) {
      blobs.set(url, object);
      setTimeout(() => blobs.delete(url), 60_000);
    }
    return url;
  };
  document.addEventListener('click', (event) => {
    const link = event.target instanceof Element ? event.target.closest('a[download]') : null;
    const blob = link && blobs.get(link.href);
    if (!blob) return;
    event.preventDefault();
    const name = link.download || 'download';
    const extension = extensionOf(name);
    chooseSavePath(name, extension ? [extension] : [], extension ? `${extension.toUpperCase()} file` : 'File')
      .then((path) => (path ? writePath(path, [blob]) : null))
      .catch((error) => console.error('[bergwork] saving the download failed', error));
  }, true);
}

/** Resolves once the editor has restored its workspace and listens for opened files. */
async function editorReady() {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const shell = document.querySelector('.oo-pdf-shell');
    const restoring = [...document.querySelectorAll('.oo-pdf-empty h1')].some((node) => /restoring/i.test(node.textContent));
    if (shell && !restoring) {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function openPaths(paths) {
  if (!paths?.length) return;
  await editorReady();
  for (const path of paths) {
    try {
      const buffer = await invoke('read_file', { path });
      const name = basename(path);
      const type = extensionOf(name) === 'pdf' ? 'application/pdf' : PROJECT_TYPE;
      const file = new File([buffer], name, { type });
      document.dispatchEvent(new CustomEvent('oo-open-file-pdf', { detail: { file } }));
    } catch (error) {
      console.error(`[bergwork] could not open ${path}`, error);
    }
  }
}

/** Call before the editor bundle loads (downloads must be intercepted from the first object URL on). */
export function installNativeFiles() {
  if (!invoke) return;
  installSavePicker();
  installDownloads();
}

/** Call after mounting: opens the launch documents and those of later launches. */
export function openDocumentsFromSystem() {
  if (!invoke) return;
  invoke('take_launch_files').then(openPaths, (error) => console.error('[bergwork] launch files', error));
  listen?.('bergwork://open-files', (event) => openPaths(event.payload));
}
