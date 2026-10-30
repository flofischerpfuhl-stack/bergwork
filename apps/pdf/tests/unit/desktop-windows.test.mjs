// berg:work: the desktop windows' workspace records (node --test apps/pdf/tests/unit/).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  claimOrphanWorkspaces, deleteWorkspace, moveWorkspaceDocument,
} from '../../editor/vendor/build/src/pdf-editor/persistence/bergwork-windows.js';

/** A one-store IndexedDB: writes are kept back until the transaction completes, and vanish when `failCommit` is set. */
function fakeDb(records = [], { failCommit = false } = {}) {
  const rows = new Map(records.map(record => [record.id, record]));
  const request = result => {
    const pending = {};
    queueMicrotask(() => { pending.result = result; pending.onsuccess?.(); });
    return pending;
  };
  return {
    rows,
    transaction() {
      const writes = [];
      const transaction = {
        objectStore: () => ({
          get: id => request(rows.get(id)),
          getAll: () => request([...rows.values()]),
          put: value => { writes.push(() => rows.set(value.id, value)); return request(value.id); },
          delete: id => { writes.push(() => rows.delete(id)); return request(undefined); },
        }),
      };
      setTimeout(() => {
        if (failCommit) { transaction.error = new Error('quota'); transaction.onabort?.(); return; }
        for (const write of writes) write();
        transaction.oncomplete?.();
      }, 0);
      return transaction;
    },
  };
}

const doc = id => ({ id, name: `${id}.pdf` });
const move = (db, target = { id: 'doc-1', docs: [doc('a')], activeDocId: 'a' }) => moveWorkspaceDocument(db, 'workspaces', {
  sourceId: 'default', documentId: 'a', nextActiveDocId: 'b', target,
});

test('a move takes the document out of the source and writes the target', async () => {
  const db = fakeDb([{ id: 'default', docs: [doc('a'), doc('b')], activeDocId: 'a', zoom: 2 }]);
  await move(db);
  assert.deepEqual(db.rows.get('default').docs, [doc('b')]);
  assert.equal(db.rows.get('default').activeDocId, 'b');
  assert.equal(db.rows.get('default').zoom, 2);
  assert.deepEqual(db.rows.get('doc-1').docs, [doc('a')]);
});

test('a document not stored yet still moves', async () => {
  const db = fakeDb();
  await move(db);
  assert.equal(db.rows.has('default'), false);
  assert.deepEqual(db.rows.get('doc-1').docs, [doc('a')]);
});

test('a failed move leaves the document where it was', async () => {
  const before = { id: 'default', docs: [doc('a'), doc('b')], activeDocId: 'a' };
  const db = fakeDb([before], { failCommit: true });
  await assert.rejects(move(db));
  assert.deepEqual(db.rows.get('default'), before);
  assert.equal(db.rows.has('doc-1'), false);
});

test('a closed window loses its record', async () => {
  const db = fakeDb([{ id: 'doc-1', docs: [] }]);
  await deleteWorkspace(db, 'workspaces', 'doc-1');
  assert.equal(db.rows.size, 0);
});

test('after a crash every window comes back', async () => {
  const db = fakeDb([
    { id: 'default', docs: [doc('a')], savedAt: 3 },
    { id: 'doc-2', docs: [doc('c')], savedAt: 2 },
    { id: 'doc-1', docs: [doc('b')], savedAt: 1 },
  ]);
  assert.deepEqual(await claimOrphanWorkspaces(db, 'workspaces', 'default'), ['doc-1', 'doc-2']);
  assert.equal(db.rows.size, 3);
});

test('an empty main window takes over the first window instead of staying empty next to it', async () => {
  const db = fakeDb([
    { id: 'default', docs: [], savedAt: 3 },
    { id: 'doc-2', docs: [doc('c')], savedAt: 2 },
    { id: 'doc-1', docs: [doc('b')], savedAt: 1 },
  ]);
  assert.deepEqual(await claimOrphanWorkspaces(db, 'workspaces', 'default'), ['doc-2']);
  assert.deepEqual(db.rows.get('default').docs, [doc('b')]);
  assert.equal(db.rows.get('default').id, 'default');
  assert.equal(db.rows.has('doc-1'), false);
});

test('records without documents are cleared', async () => {
  const db = fakeDb([{ id: 'default', docs: [doc('a')] }, { id: 'doc-1', docs: [] }]);
  assert.deepEqual(await claimOrphanWorkspaces(db, 'workspaces', 'default'), []);
  assert.equal(db.rows.has('doc-1'), false);
});
