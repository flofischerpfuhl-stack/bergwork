// berg:work: the windows of the desktop app, from the editor's side.
//
// Each window has its own workspace record in IndexedDB (the record `default` is the main window's, so a workspace of
// an older version simply stays in it); journals and writer leases were keyed by document already, so they follow a
// document from window to window. Moving a document to a new window is therefore the same as a restart of that one
// document: its record goes to the new window's workspace in one transaction with its removal from this one, and
// the new window restores it as it would after a crash.
import { useEffect, useRef, useState } from 'react';

const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
const SESSION_START_MS = 15_000;

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('Workspace transaction aborted.'));
  });
}

/**
 * Takes a document out of `sourceId` and writes `target` in one transaction: after a crash the document is in exactly
 * one workspace. The other documents of the source stay byte for byte as they are durable now.
 */
export async function moveWorkspaceDocument(db, storeName, { sourceId, documentId, nextActiveDocId, target }) {
  const transaction = db.transaction(storeName, 'readwrite');
  const done = transactionDone(transaction);
  const store = transaction.objectStore(storeName);
  const source = await requestResult(store.get(sourceId));
  if (source) {
    store.put({
      ...source,
      docs: (source.docs || []).filter(doc => doc.id !== documentId),
      activeDocId: nextActiveDocId,
      savedAt: Date.now(),
    });
  }
  store.put(target);
  await done;
}

export async function deleteWorkspace(db, storeName, id) {
  const transaction = db.transaction(storeName, 'readwrite');
  const done = transactionDone(transaction);
  transaction.objectStore(storeName).delete(id);
  await done;
}

/**
 * After a start: the workspaces other than `mainId` that no window owns. The main window takes the first one if its own
 * is empty (an empty window next to the restored ones helps nobody); the rest are returned, to be opened in windows.
 * Records without documents are removed.
 */
export async function claimOrphanWorkspaces(db, storeName, mainId) {
  const transaction = db.transaction(storeName, 'readwrite');
  const done = transactionDone(transaction);
  const store = transaction.objectStore(storeName);
  const records = await requestResult(store.getAll());
  const orphans = [];
  for (const record of records) {
    if (record.id === mainId) continue;
    if (record.docs?.length) orphans.push(record);
    else store.delete(record.id);
  }
  orphans.sort((a, b) => Number(a.savedAt || 0) - Number(b.savedAt || 0));
  const main = records.find(record => record.id === mainId);
  if (!main?.docs?.length && orphans.length) {
    const first = orphans.shift();
    store.put({ ...first, id: mainId });
    store.delete(first.id);
  }
  await done;
  return orphans.map(record => record.id);
}

/**
 * Connects the editor to the desktop host (`shell.desktop`, see berg:work docs/PDF-HOST-CONTRACT.md). `deps` is read at
 * call time, so the host's calls always see the current render.
 */
export function useDesktopWindow(desktop, deps) {
  const latest = useRef(deps);
  latest.current = deps;
  const [recent, setRecent] = useState([]);

  useEffect(() => {
    if (!desktop) return undefined;
    const current = () => latest.current;
    const snapshot = () => current().workspaceSnapshotRef.current;
    const findDoc = id => snapshot().docs.find(doc => doc.id === id) || null;

    /** Lets running edits, saves and a closing session finish, then ends the document's session here. */
    const settleDocument = async id => {
      const { documentSaveCoordinator, pageStructureTailRef, retiringPdfRuntimeClosures, livePdfRuntimeRef,
        workspaceSnapshotRef, settleQueuedFormValues, waitForLiveRuntimeCommits } = current();
      document.activeElement?.blur?.();
      await nextFrame();
      await documentSaveCoordinator.waitForDocument(id);
      await pageStructureTailRef.current;
      await settleQueuedFormValues(workspaceSnapshotRef, id);
      const retiring = retiringPdfRuntimeClosures.get(id);
      if (retiring) await retiring.catch(() => {});
      const runtime = livePdfRuntimeRef.current;
      if (runtime?.documentId === id) {
        await waitForLiveRuntimeCommits(runtime);
        await runtime.close?.();
      }
      await nextFrame();
      await nextFrame();
    };

    /** Runs a save of the document, which must first become the active one: the editor saves what it shows. */
    const saveDocument = async id => {
      const { setActiveDocId, exportRef, livePdfRuntimeRef } = current();
      setActiveDocId(id);
      for (let frames = 0; frames < 600 && exportRef.current.documentId !== id; frames += 1) await nextFrame();
      if (exportRef.current.documentId !== id) return false;
      // The save waits for a session that is opening, but the session must exist. A background tab has none yet.
      const started = Date.now();
      while (livePdfRuntimeRef.current?.documentId !== id && Date.now() - started < SESSION_START_MS) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const result = await exportRef.current.exportPdf();
      return Boolean(result?.saved);
    };

    const detach = async id => {
      const { liveRuntimeSafetyState, livePdfRuntimeRef, moveDocumentToWorkspace, setDocs, setActiveDocId, setActivePage,
        setSelected, showToast } = current();
      const doc = findDoc(id);
      if (!doc) return;
      const safety = liveRuntimeSafetyState(livePdfRuntimeRef.current, id);
      if (safety.exportBlocked) {
        showToast(safety.reason, 'warning');
        return;
      }
      await settleDocument(id);
      const settled = snapshot();
      const moving = settled.docs.find(item => item.id === id);
      if (!moving) return;
      const isActive = settled.activeDocId === id;
      const docs = settled.docs.filter(item => item.id !== id);
      const activeDocId = isActive ? docs[0]?.id || null : settled.activeDocId;
      const windowId = desktop.newWindowId();
      // The snapshot first: a workspace save queued from here on must not write the document back.
      current().workspaceSnapshotRef.current = { ...settled, docs, activeDocId };
      setDocs(docs);
      setActiveDocId(activeDocId);
      if (isActive) {
        setActivePage(0);
        setSelected(null);
      }
      try {
        await moveDocumentToWorkspace({
          document: moving, targetId: windowId, activeDocId,
          page: isActive ? settled.activePage : 0, zoom: settled.zoom,
        });
        await desktop.openWindow(windowId);
      } catch (error) {
        console.error('[bergwork] moving the document failed', error);
        setDocs(items => [...items, moving]);
        setActiveDocId(id);
        showToast('The document could not be moved to a new window.', 'error');
      }
    };

    const closeWindow = async ({ keepSession, discardUnsaved }) => {
      const { discardAndCloseDoc, hasUnsavedPdfChanges, savePdfWorkspace, forgetWorkspace, livePdfRuntimeRef } = current();
      const discarding = keepSession
        ? snapshot().docs.filter(doc => discardUnsaved && hasUnsavedPdfChanges(doc))
        : snapshot().docs;
      for (const doc of discarding) await discardAndCloseDoc(doc.id);
      if (keepSession) {
        const runtime = livePdfRuntimeRef.current;
        if (runtime) await settleDocument(runtime.documentId);
        await savePdfWorkspace(snapshot());
      } else {
        await forgetWorkspace();
      }
    };

    const reload = async (id, file) => {
      const { loadPdfFile, discardAndCloseDoc, setDocs, setActiveDocId, setActivePage, setZoom, setSelected } = current();
      const before = snapshot();
      const index = before.docs.findIndex(doc => doc.id === id);
      if (index < 0) return;
      const wasActive = before.activeDocId === id;
      const { activePage, zoom } = before;
      const loaded = await loadPdfFile(file);
      loaded.nativeFile = desktop.nativeFileOf(file);
      await discardAndCloseDoc(id);
      setDocs(docs => [...docs.slice(0, index), loaded, ...docs.slice(index)]);
      if (wasActive) {
        setActiveDocId(loaded.id);
        setSelected(null);
        setActivePage(Math.min(activePage, Math.max(0, loaded.pages.length - 1)));
        setZoom(zoom);
      }
    };

    return desktop.connect({
      documents: () => snapshot().docs.map(doc => ({
        id: doc.id, name: doc.name, nativeFile: doc.nativeFile || null, unsaved: current().hasUnsavedPdfChanges(doc),
      })),
      detach,
      saveUnsaved: async () => {
        for (const doc of snapshot().docs.filter(item => current().hasUnsavedPdfChanges(item))) {
          if (!await saveDocument(doc.id)) return false;
        }
        return true;
      },
      closeWindow,
      reload,
      show: (id, page) => {
        current().setActiveDocId(id);
        if (Number.isInteger(page) && page > 0) current().requestPage(page);
      },
      toggleFullscreen: () => current().toggleFullscreen(),
      closeActive: () => {
        const id = snapshot().activeDocId;
        if (id) void current().closeDoc(id);
        return Boolean(id);
      },
      cycle: delta => {
        const { docs, activeDocId } = snapshot();
        if (docs.length < 2) return;
        const index = docs.findIndex(doc => doc.id === activeDocId);
        current().setActiveDocId(docs[(index + delta + docs.length) % docs.length].id);
      },
    });
  }, [desktop]);

  const { docs } = deps;
  useEffect(() => {
    desktop?.documentsChanged?.(docs.map(doc => doc.nativeFile?.path).filter(Boolean));
  }, [desktop, docs]);

  return {
    recent,
    refreshRecent: () => { void desktop?.recentFiles?.().then(setRecent); },
  };
}
