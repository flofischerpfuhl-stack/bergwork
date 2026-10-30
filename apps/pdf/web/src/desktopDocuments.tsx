/**
 * The desktop app's document windows, from the host page's side: the `desktop` capability the editor is mounted with
 * (see docs/PDF-HOST-CONTRACT.md), the question before a window with unsaved changes closes, documents that change on
 * disk, and the keys a desktop app has that a page does not. Windows and routing live in src-tauri/src/windows.rs; each
 * window's documents in its workspace record (editor: pdf-editor/persistence/bergwork-windows.js).
 */
import { useSyncExternalStore } from 'react';
import { Button, Dialog } from '@bergwork/ui';
import { windowCall } from './desktopWindow';
// @ts-expect-error plain ES module without types
import { editorReady, fileHandle, nativeFileOf, readFile, sameStamp, setDocumentShower, setOverwritePrompt } from './native-files.js';

interface FileStamp { readonly modifiedMs: number; readonly size: number }
interface NativeFile { readonly path: string; readonly stamp: FileStamp | null }
interface OpenDocument { readonly id: string; readonly name: string; readonly nativeFile: NativeFile | null; readonly unsaved: boolean }

/** What the editor offers the host. */
export interface EditorDocuments {
  documents(): readonly OpenDocument[];
  detach(id: string): Promise<void>;
  saveUnsaved(): Promise<boolean>;
  closeWindow(options: { readonly keepSession: boolean; readonly discardUnsaved: boolean }): Promise<void>;
  reload(id: string, file: File): Promise<void>;
  show(id: string, page: number | null): void;
  closeActive(): boolean;
  cycle(delta: number): void;
  toggleFullscreen(): void;
}

const tauri = (globalThis as { __TAURI__?: any }).__TAURI__;
const invoke: (<T>(command: string, args?: unknown) => Promise<T>) | undefined = tauri?.core?.invoke;
const appWindow = tauri?.webviewWindow?.getCurrentWebviewWindow?.();
const label: string = appWindow?.label ?? 'main';

const WATCH_INTERVAL_MS = 3000;
const SETTLE_RECHECK_MS = 700;
const NOTICE_MS = 5000;

const STRINGS = {
  de: {
    openDialog: 'PDF und Projekte',
    closeTitle: 'Änderungen speichern?',
    closeOne: (name: string) => `„${name}“ hat ungespeicherte Änderungen.`,
    closeMany: (count: number) => `${count} Dokumente haben ungespeicherte Änderungen.`,
    cancel: 'Abbrechen', discard: 'Nicht speichern', save: 'Speichern',
    conflictTitle: 'Datei wurde außerhalb geändert',
    conflictBody: (name: string) => `„${name}“ wurde seit dem Öffnen von einem anderen Programm geändert. Überschreiben ersetzt diese Fassung.`,
    overwrite: 'Überschreiben',
    changed: (name: string) => `„${name}“ wurde außerhalb geändert.`,
    missing: (name: string) => `„${name}“ ist am Speicherort nicht mehr vorhanden.`,
    reloaded: (name: string) => `„${name}“ wurde neu geladen.`,
    reloadFailed: (name: string) => `„${name}“ konnte nicht neu geladen werden.`,
    reload: 'Neu laden', keep: 'Behalten',
    discardTitle: 'Änderungen verwerfen?',
    discardBody: (name: string) => `Neu laden ersetzt „${name}“ durch die Fassung auf der Platte. Deine ungespeicherten Änderungen gehen verloren.`,
  },
  en: {
    openDialog: 'PDF documents and projects',
    closeTitle: 'Save changes?',
    closeOne: (name: string) => `“${name}” has unsaved changes.`,
    closeMany: (count: number) => `${count} documents have unsaved changes.`,
    cancel: 'Cancel', discard: 'Don’t save', save: 'Save',
    conflictTitle: 'File changed outside the app',
    conflictBody: (name: string) => `“${name}” was changed by another program since it was opened. Overwriting replaces that version.`,
    overwrite: 'Overwrite',
    changed: (name: string) => `“${name}” changed outside the app.`,
    missing: (name: string) => `“${name}” is no longer where it was.`,
    reloaded: (name: string) => `“${name}” was reloaded.`,
    reloadFailed: (name: string) => `“${name}” could not be reloaded.`,
    reload: 'Reload', keep: 'Keep',
    discardTitle: 'Discard changes?',
    discardBody: (name: string) => `Reloading replaces “${name}” with the version on disk. Your unsaved changes will be lost.`,
  },
};
const strings = STRINGS[navigator.language.startsWith('de') ? 'de' : 'en'];

export const openDialogDescription = strings.openDialog;

let editor: EditorDocuments | null = null;

// What the overlays show; changed through `update`.
interface Notice { readonly key: string; readonly text: string; readonly reload?: () => void; readonly keep?: () => void }
interface Question {
  readonly title: string;
  readonly body: string;
  readonly choices: readonly { readonly id: string; readonly label: string; readonly primary?: boolean }[];
  readonly answer: (id: string) => void;
}
let overlays: { readonly notices: readonly Notice[]; readonly question: Question | null } = { notices: [], question: null };
const subscribers = new Set<() => void>();
const update = (change: Partial<typeof overlays>) => {
  overlays = { ...overlays, ...change };
  for (const subscriber of subscribers) subscriber();
};
const ask = (title: string, body: string, choices: Question['choices']) => new Promise<string>((resolve) => {
  update({ question: { title, body, choices, answer: (id) => { update({ question: null }); resolve(id); } } });
});

const showNotice = (notice: Notice) => update({ notices: [...overlays.notices.filter((item) => item.key !== notice.key), notice] });
const dropNotice = (key: string) => {
  if (overlays.notices.some((item) => item.key === key)) update({ notices: overlays.notices.filter((item) => item.key !== key) });
};

let reportedPaths = '';

/** The capability handed to the editor; undefined in a browser. */
export const desktop = invoke ? {
  workspaceId: label === 'main' ? 'default' : label,
  connect(documents: EditorDocuments) {
    editor = documents;
    return () => { editor = null; };
  },
  detach: (id: string) => editor?.detach(id),
  newWindowId: () => `doc-${crypto.randomUUID()}`,
  openWindow: (windowLabel: string) => invoke('open_window', { label: windowLabel }),
  newWindow: () => invoke('open_window', { label: `doc-${crypto.randomUUID()}` }),
  documentsChanged(paths: readonly string[]) {
    const key = JSON.stringify(paths);
    if (key === reportedPaths) return;
    reportedPaths = key;
    invoke('window_documents', { paths }).catch((error) => console.warn('[bergwork] window documents', error));
  },
  recentFiles: async () => (await invoke<string[]>('recent_files')).map((path) => ({ path, name: path.split(/[\\/]/).pop() ?? path })),
  openRecent: (path: string) => invoke('open_recent', { path }),
  saveHandle: (nativeFile?: NativeFile | null) => (nativeFile ? fileHandle(nativeFile.path, nativeFile.stamp) : null),
  nativeFileOf,
} : undefined;

/** The windows of the last run other than this one's own: reopened once this window's documents are in. */
export async function reopenWindows(labels: readonly string[]): Promise<void> {
  if (!invoke || !labels.length) return;
  await editorReady();
  for (const windowLabel of labels) await invoke('open_window', { label: windowLabel });
}

/** After a restart a workspace-less start must not look for orphans again; only the first page of a run does. */
export async function shouldClaimOrphans(): Promise<boolean> {
  return Boolean(invoke && label === 'main' && await invoke<boolean>('take_restore_scan'));
}

let closing = false;

/** A close request (title bar, Alt+F4, window manager): asks when something is unsaved, then ends the window. */
async function onCloseRequested(): Promise<void> {
  if (!invoke) return;
  const keepSession = await invoke<boolean>('window_close_answered');
  if (closing) return;
  closing = true;
  const cancel = async () => {
    closing = false;
    await invoke('window_close_cancelled');
  };
  let discardUnsaved = false;
  try {
    const unsaved = editor?.documents().filter((doc) => doc.unsaved) ?? [];
    if (unsaved.length) {
      const body = unsaved.length === 1 ? strings.closeOne(unsaved[0].name) : strings.closeMany(unsaved.length);
      const choice = await ask(strings.closeTitle, body, [
        { id: 'cancel', label: strings.cancel }, { id: 'discard', label: strings.discard }, { id: 'save', label: strings.save, primary: true },
      ]);
      if (choice === 'cancel') { await cancel(); return; }
      if (choice === 'save' && !await editor?.saveUnsaved()) { await cancel(); return; }
      discardUnsaved = choice === 'discard';
    }
    await editor?.closeWindow({ keepSession, discardUnsaved });
  } catch (error) {
    // The window closes anyway: what could not be cleaned up stays in its workspace and comes back on the next start.
    console.error('[bergwork] closing the window', error);
  }
  await invoke('window_close_confirmed');
}

// Files on disk. Polling, not a file system watcher: it also works on network drives, and a stat per open document
// every few seconds costs nothing. Editors and exporters replace files in several steps, so a change counts once two
// checks in a row see the same stamp.
const candidates = new Map<string, FileStamp>();
const dismissed = new Map<string, FileStamp>();
const gone = new Set<string>();
let recheck = 0;

async function reloadDocument(doc: OpenDocument): Promise<void> {
  const path = doc.nativeFile!.path;
  try {
    await editor?.reload(doc.id, await readFile(path));
    dropNotice(path);
    const key = `${path}:reloaded`;
    showNotice({ key, text: strings.reloaded(doc.name) });
    setTimeout(() => dropNotice(key), NOTICE_MS);
  } catch (error) {
    console.warn('[bergwork] reload', error);
    showNotice({ key: path, text: strings.reloadFailed(doc.name), keep: () => dropNotice(path) });
  }
}

async function checkDocument(doc: OpenDocument): Promise<void> {
  const known = doc.nativeFile;
  if (!invoke || !known?.stamp) return;
  const { path, stamp } = known;
  const now = await invoke<FileStamp | null>('file_stamp', { path }).catch(() => undefined);
  if (now === undefined) return;
  if (now === null) {
    if (!gone.has(path)) {
      gone.add(path);
      showNotice({ key: path, text: strings.missing(doc.name), keep: () => dropNotice(path) });
    }
    return;
  }
  if (gone.delete(path)) dropNotice(path);
  if (sameStamp(now, stamp)) {
    candidates.delete(path);
    dismissed.delete(path);
    dropNotice(path);
    return;
  }
  if (sameStamp(now, dismissed.get(path))) return;
  if (!sameStamp(now, candidates.get(path))) {
    candidates.set(path, now);
    clearTimeout(recheck);
    recheck = window.setTimeout(() => void checkFiles(), SETTLE_RECHECK_MS);
    return;
  }
  candidates.delete(path);
  if (!doc.unsaved) {
    await reloadDocument(doc);
    return;
  }
  showNotice({
    key: path,
    text: strings.changed(doc.name),
    reload: () => void ask(strings.discardTitle, strings.discardBody(doc.name), [
      { id: 'cancel', label: strings.cancel }, { id: 'reload', label: strings.reload, primary: true },
    ]).then((choice) => { if (choice === 'reload') void reloadDocument(doc); }),
    keep: () => { dismissed.set(path, now); dropNotice(path); },
  });
}

let checking = false;
async function checkFiles(): Promise<void> {
  if (checking || !editor) return;
  checking = true;
  try {
    for (const doc of editor.documents()) await checkDocument(doc);
  } finally {
    checking = false;
  }
}

/** Keys of a desktop app; Reload does nothing, it would only throw away the page's state. */
function onKey(event: KeyboardEvent): void {
  const modifier = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  const take = () => { event.preventDefault(); event.stopPropagation(); };
  if (event.key === 'F5' || (modifier && !event.altKey && key === 'r')) { take(); return; }
  if (event.key === 'F11') { take(); editor?.toggleFullscreen(); return; }
  if (!modifier || event.altKey || event.repeat) return;
  if (key === 'tab') { take(); editor?.cycle(event.shiftKey ? -1 : 1); return; }
  if (key === 'w') {
    take();
    if (event.shiftKey || !editor?.closeActive()) windowCall('close');
    return;
  }
  if (key === 'q' && !event.shiftKey) { take(); void invoke?.('quit_app'); return; }
  if (key === 'n' && event.shiftKey) { take(); void desktop?.newWindow(); }
}

/** The WebView's own menu (Reload, Inspect) has no place in the app; text fields and selected text keep theirs. */
function onContextMenu(event: MouseEvent): void {
  const target = event.target as Element | null;
  if (target?.closest?.('input, textarea, [contenteditable="true"]')) return;
  if (!(window.getSelection()?.isCollapsed ?? true)) return;
  event.preventDefault();
}

/** Call once the editor is mounted. */
export function installDesktopDocuments(): void {
  if (!invoke) return;
  setOverwritePrompt(async (name: string) => (await ask(strings.conflictTitle, strings.conflictBody(name), [
    { id: 'cancel', label: strings.cancel }, { id: 'overwrite', label: strings.overwrite, primary: true },
  ])) === 'overwrite');
  setDocumentShower((path: string, page: number | null) => {
    const doc = editor?.documents().find((item) => item.nativeFile?.path === path);
    if (doc) editor?.show(doc.id, page);
    return Boolean(doc);
  });
  void appWindow.listen('bergwork://close-requested', () => void onCloseRequested());
  void appWindow.listen('bergwork://show-document', ({ payload }: { payload: [string, number | null] }) => {
    const [path, page] = payload;
    const doc = editor?.documents().find((item) => item.nativeFile?.path === path);
    if (doc) editor?.show(doc.id, page);
  });
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('contextmenu', onContextMenu);
  window.addEventListener('focus', () => void checkFiles());
  window.setInterval(() => void checkFiles(), WATCH_INTERVAL_MS);
}

/** The questions and notices above the editor. */
export function DesktopOverlays() {
  const { notices, question } = useSyncExternalStore((subscriber) => {
    subscribers.add(subscriber);
    return () => { subscribers.delete(subscriber); };
  }, () => overlays);
  return (
    <>
      {notices.length ? (
        <div className="bw-file-notices" role="status">
          {notices.map((notice) => (
            <div className="bw-file-notice" key={notice.key}>
              <span>{notice.text}</span>
              {notice.reload ? <Button onClick={notice.reload}>{strings.reload}</Button> : null}
              {notice.keep ? <Button variant="quiet" onClick={notice.keep}>{strings.keep}</Button> : null}
            </div>
          ))}
        </div>
      ) : null}
      {question ? (
        <Dialog title={question.title} onCancel={() => question.answer('cancel')} buttons={question.choices.map((choice) => (
          <Button key={choice.id} variant={choice.primary ? 'primary' : 'default'} onClick={() => question.answer(choice.id)}>{choice.label}</Button>
        ))}>
          <p className="bw-dialog-text">{question.body}</p>
        </Dialog>
      ) : null}
    </>
  );
}
