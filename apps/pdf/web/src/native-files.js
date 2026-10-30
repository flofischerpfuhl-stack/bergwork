// Native files for the editor inside the app (no-ops in a plain browser).
//
// - Save / Save as / Export: the editor uses the File System Access API when `showSaveFilePicker` exists. This
//   module provides it on top of the native save dialog, so Save overwrites the chosen file and Save as asks again.
//   A document opened from a file writes back to that file without a dialog (`fileHandle`); a file changed from
//   outside since then is overwritten only after asking.
// - Other exports (page ranges, OCR text, …) are browser downloads of blob URLs; they are routed through the same
//   save dialog instead of silently landing in a downloads folder.
// - Documents the app is opened with (file manager, "Open with", a second launch), the open dialog and drops from
//   other programs are handed to the editor like a dropped file, carrying their path and stamp.

const tauri = globalThis.__TAURI__;
const invoke = tauri?.core?.invoke;
// This window's own events: a plain `listen` would also receive the events meant for other windows.
const currentWindow = tauri?.webviewWindow?.getCurrentWebviewWindow?.();
const listen = currentWindow ? (name, handler) => currentWindow.listen(name, handler) : undefined;

const PROJECT_TYPE = 'application/vnd.fernwork.pdf-project+json';
const FILE_TYPES = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml' };

const basename = (path) => path.split(/[\\/]/).pop() || path;
const extensionOf = (name) => (/\.([a-z0-9]+)$/i.exec(name)?.[1] || '').toLowerCase();

export const sameStamp = (a, b) => a?.modifiedMs === b?.modifiedMs && a?.size === b?.size;

function aborted() {
  return new DOMException('The user aborted a request.', 'AbortError');
}

async function writePath(path, parts) {
  const bytes = new Uint8Array(await new Blob(parts).arrayBuffer());
  return invoke('write_file', bytes, { headers: { 'x-bergwork-path': encodeURIComponent(path) } });
}

let confirmOverwrite = async () => false;

/** The question before overwriting a file that changed from outside: `(name) => Promise<boolean>`. */
export function setOverwritePrompt(prompt) {
  confirmOverwrite = prompt;
}

/**
 * A minimal FileSystemFileHandle for a path. With a `stamp` the file is the one the document came from: it must still be
 * as it was then. `nativeFile` is what the document keeps after a save.
 */
export function fileHandle(path, stamp = null) {
  const handle = {
    kind: 'file',
    name: basename(path),
    nativeFile: { path, stamp },
    async createWritable() {
      const parts = [];
      return {
        async write(data) {
          parts.push(data instanceof Blob ? data : new Blob([data?.data ?? data]));
        },
        async close() {
          const known = handle.nativeFile.stamp;
          const current = known ? await invoke('file_stamp', { path }) : null;
          if (current && !sameStamp(current, known) && !await confirmOverwrite(handle.name)) throw aborted();
          handle.nativeFile = { path, stamp: await writePath(path, parts) };
        },
        async abort() {
          parts.length = 0;
        },
      };
    },
  };
  return handle;
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
export async function editorReady() {
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

// A file's path and stamp, for the editor (nativeFileOf): a File that went through a DataTransfer may arrive as
// another object, so they are found by name and size.
const nativeFiles = new Map();
const fileKey = (file) => `${file.name}:${file.size}`;

export function nativeFileOf(file) {
  return nativeFiles.get(fileKey(file)) ?? null;
}

/** Reads a file the app may read; the stamp comes first, so a change during the read shows as a change. */
export async function readFile(path) {
  const stamp = await invoke('file_stamp', { path });
  const buffer = await invoke('read_file', { path });
  const name = basename(path);
  const extension = extensionOf(name);
  const file = new File([buffer], name, { type: FILE_TYPES[extension] ?? PROJECT_TYPE });
  const key = fileKey(file);
  const nativeFile = extension === 'pdf' ? { path, stamp } : null;
  nativeFiles.set(key, nativeFile);
  setTimeout(() => { if (nativeFiles.get(key) === nativeFile) nativeFiles.delete(key); }, 60_000);
  return file;
}

let showOpenDocument = () => false;

/** `(path, page) => boolean`: shows a document this window has open already. */
export function setDocumentShower(shower) {
  showOpenDocument = shower;
}

// One at a time: while the editor loads a file, a second one would replace that load.
let openQueue = Promise.resolve();

// Documents arrive as [path, page] pairs (page 1-based, or null; `--page N` / `file.pdf#page=N`).
function openPaths(documents) {
  if (!documents?.length) return;
  openQueue = openQueue.then(async () => {
    await editorReady();
    for (const entry of documents) {
      const [path, page] = Array.isArray(entry) ? entry : [entry, null];
      if (showOpenDocument(path, page)) continue;
      try {
        const file = await readFile(path);
        await new Promise((opened) => {
          document.dispatchEvent(new CustomEvent('oo-open-file-pdf', { detail: { file, page, opened } }));
        });
      } catch (error) {
        console.error(`[bergwork] could not open ${path}`, error);
      }
    }
  });
}

/** The editor's "Open" input gets the native dialog, which knows paths. Its other file inputs stay as they are. */
function installOpenDialog(description) {
  document.addEventListener('click', (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.type !== 'file' || !input.accept.includes('.bwpdf')) return;
    event.preventDefault();
    invoke('choose_open_paths', { description }).then(openPaths, (error) => console.error('[bergwork] open dialog', error));
  }, true);
}

/**
 * Files dropped from other programs arrive with their paths from the native side, not as a DOM drop. They are
 * dispatched as that drop at the same place, so the editor treats them as it treats any drop.
 */
async function dropFiles([paths, x, y]) {
  const files = await Promise.all(paths.map(readFile));
  const transfer = new DataTransfer();
  for (const file of files) transfer.items.add(file);
  const [clientX, clientY] = [x / devicePixelRatio, y / devicePixelRatio];
  const target = document.elementFromPoint(clientX, clientY) ?? document.body;
  target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, composed: true, clientX, clientY, dataTransfer: transfer }));
}

/** Call before the editor bundle loads (downloads must be intercepted from the first object URL on). */
export function installNativeFiles({ openDialogDescription }) {
  if (!invoke) return;
  installSavePicker();
  installDownloads();
  installOpenDialog(openDialogDescription);
}

/** Call after mounting: opens the launch documents and those of later launches, and takes drops. */
export async function openDocumentsFromSystem() {
  if (!invoke) return;
  // Listening first: whatever arrives after `take_launch_files` comes as an event.
  await listen?.('bergwork://open-files', (event) => openPaths(event.payload));
  await listen?.('bergwork://dropped-files', (event) => {
    dropFiles(event.payload).catch((error) => console.error('[bergwork] dropped files', error));
  });
  invoke('take_launch_files').then(openPaths, (error) => console.error('[bergwork] launch files', error));
}
