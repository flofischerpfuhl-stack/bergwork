// @ts-check

import { canonicalSerialize, createPdfCommand, createPdfTransaction } from './commands.js';
import {
  appendPendingTransaction,
  commitTransaction,
  createCommandJournal,
  rejectTransaction,
} from './journal.js';
import { resourceBindingRecords } from './journal-store.js';
import { exportPortablePdfNativeState } from './portable-project-state.js';

// Resources handed to the engine or to callers carry their binding records
// as objects, never as the journal's pre-encoded sidecar.
function engineResourceWithBindings(resource) {
  if (!(resource?.bindingsSidecar instanceof Uint8Array)) return resource;
  const { bindingsSidecar: _sidecar, ...plain } = resource;
  return { ...plain, bindings: resourceBindingRecords(resource) };
}

function regeneratedCommands(commands, prefix) {
  return commands.map((command, index) => createPdfCommand({
    commandId: `${prefix}:command-${index + 1}`,
    type: command.type,
    targetId: command.targetId,
    payload: command.payload,
  }));
}

function commandResourceHashes(commands) {
  return [...new Set(commands
    .flatMap(command => [
      command?.payload?.resourceHash,
      command?.payload?.fontResourceHash,
      ...(Array.isArray(command?.payload?.fontResourceHashes)
        ? command.payload.fontResourceHashes
        : []),
    ])
    .filter(hash => typeof hash === 'string' && hash))].sort();
}

function semanticCommandsDigest(commands = []) {
  return canonicalSerialize(commands.map(command => ({
    type: command.type,
    targetId: command.targetId,
    payload: command.payload,
  })));
}

function normalizedUiTransition(value) {
  if (!value || typeof value !== 'object' || !value.before || !value.after) return null;
  return Object.freeze(JSON.parse(canonicalSerialize({
    before: value.before,
    after: value.after,
    ...(value.optimisticAfter ? { optimisticAfter: value.optimisticAfter } : {}),
    baseUiRevision: Number.isSafeInteger(value.baseUiRevision) && value.baseUiRevision >= 0
      ? value.baseUiRevision
      : 0,
  })));
}

function uiTransitionFinalizationError(value) {
  if (!value || typeof value !== 'object') return null;
  const message = typeof value.message === 'string' && value.message
    ? value.message
    : 'A committed PDF change has an incomplete UI recovery transition.';
  const error = new Error(message);
  error.code = 'ui-transition-finalization-failed';
  return error;
}

function reversedUiTransition(value) {
  const transition = normalizedUiTransition(value);
  return transition
    ? normalizedUiTransition({
        before: transition.after,
        after: transition.before,
        baseUiRevision: transition.baseUiRevision,
      })
    : null;
}

function recoveredHistoryMode(entry) {
  if (['edit', 'undo', 'redo', 'none'].includes(entry?.historyMode)) {
    return entry.historyMode;
  }
  // Records written before historyMode was added used these exact prefixes
  // for compensating transactions. Keep those drafts recoverable.
  if (String(entry?.label || '').startsWith('Undo ')) return 'undo';
  if (String(entry?.label || '').startsWith('Redo ')) return 'redo';
  return 'edit';
}

function recoveredHistoryLabel(entry, mode) {
  if (typeof entry?.historyLabel === 'string' && entry.historyLabel) {
    return entry.historyLabel;
  }
  const label = entry?.label || 'Recovered PDF edit';
  if (mode === 'undo' && label.startsWith('Undo ')) return label.slice(5);
  if (mode === 'redo' && label.startsWith('Redo ')) return label.slice(5);
  return label;
}

/**
 * Semantic transaction owner above the PDFium mechanism. It persists pending
 * intent before mutation, records the worker effect digest, and implements
 * undo/redo as compensating transactions rather than document snapshots.
 */
export class PdfSemanticKernel {
  #engine;
  #store;
  #documentKey;
  #journal;
  #entries = [];
  #undo = [];
  #redo = [];
  // An Undo/Redo item is popped before its transaction runs and pushed onto
  // the opposite stack only after it committed. Meanwhile it is on neither
  // stack, but its snapshot resources are still needed (see
  // #pruneResourceMetadata).
  #historyInFlight = new Set();
  #sequence = 0;
  #checkpointEvery;
  #onCommit;
  #checkpointRevision = 0;
  #checkpointBytes = null;
  #checkpointBindings = [];
  #executionTail = Promise.resolve();
  #lastSemanticDigest = '';
  #lastSemanticTransactionId = '';
  #lastSemanticResult = null;
  #lastUndoError = null;
  #resources = new Map();
  #residentResourceHashes = new Set();
  #activeUiTransition = null;
  #snapshotHistoryLimit;
  #persistScheduled = null;
  #writerLease;
  #onRecoveryState;
  #recoveryError = null;
  #uiTransitionFinalizationError = null;

  constructor({
    engine,
    store,
    documentKey,
    checkpointEvery = 20,
    snapshotHistoryLimit = 80,
    onCommit = () => {},
    writerLease = null,
    onRecoveryState = () => {},
  }) {
    if (!engine?.sessionId) throw new TypeError('An open PDF engine session is required.');
    if (!store?.load || !store?.save) throw new TypeError('A command journal store is required.');
    if (typeof documentKey !== 'string' || !documentKey) throw new TypeError('documentKey is required.');
    this.#engine = engine;
    this.#store = store;
    this.#documentKey = documentKey;
    this.#journal = createCommandJournal(engine.sessionId);
    this.#checkpointEvery = checkpointEvery;
    this.#snapshotHistoryLimit = Math.max(1, Number(snapshotHistoryLimit));
    this.#onCommit = onCommit;
    this.#writerLease = writerLease;
    this.#onRecoveryState = onRecoveryState;
  }

  get revision() {
    return this.#engine.revision;
  }

  get canUndo() {
    return this.#undo.length > 0;
  }

  get canRedo() {
    return this.#redo.length > 0;
  }

  get blockedEntry() {
    if (!this.#lastUndoError || !this.#undo.length) return null;
    const item = this.#undo[this.#undo.length - 1];
    return Object.freeze({ label: item.label, error: this.#lastUndoError });
  }

  get entries() {
    return Object.freeze([...this.#entries]);
  }

  get recoveryState() {
    const error = this.#uiTransitionFinalizationError || this.#recoveryError;
    return Object.freeze({
      durable: error == null,
      editingBlocked: this.#uiTransitionFinalizationError != null,
      error,
      checkpointRevision: this.#checkpointRevision,
    });
  }

  async loadRecoveryRecord() {
    return this.#store.load(this.#documentKey);
  }

  exportPortableState() {
    this.#writerLease?.assertWritable();
    const run = this.#executionTail.then(async () => {
      await this.checkpoint();
      return exportPortablePdfNativeState({
        store: this.#store,
        documentKey: this.#documentKey,
        expectedRevision: this.#engine.revision,
      });
    });
    this.#executionTail = run.then(() => undefined, () => undefined);
    return run;
  }

  async recover({ fromCheckpointRevision = 0 } = {}) {
    const record = await this.loadRecoveryRecord();
    for (const resource of record?.resources || []) {
      if (!resource || typeof resource.hash !== 'string') continue;
      this.#resources.set(resource.hash, Object.freeze({
        ...resource,
        ...(resource.bytes instanceof Uint8Array && resource.bytes.byteLength
          ? { bytes: resource.bytes.slice() }
          : { bytes: null }),
      }));
    }
    const checkpointRevision = Number.isSafeInteger(fromCheckpointRevision)
      ? fromCheckpointRevision
      : 0;
    this.#checkpointRevision = checkpointRevision;
    this.#checkpointBytes = checkpointRevision > 0 && record?.checkpointBytes
      ? record.checkpointBytes
      : null;
    this.#checkpointBindings = checkpointRevision > 0
      ? record?.checkpointBindings || []
      : [];
    const durableEntries = (record?.entries || []).map((entry, journalIndex) => ({
      ...entry,
      journalIndex,
    }));
    const durableFinalizationFailure = durableEntries.find(entry => (
      entry.status === 'committed' && entry.uiTransitionFinalizationError
    ));
    if (durableFinalizationFailure) {
      this.#uiTransitionFinalizationError = uiTransitionFinalizationError(
        durableFinalizationFailure.uiTransitionFinalizationError,
      );
      try {
        this.#onRecoveryState(this.recoveryState);
      } catch {
        // A diagnostic hook cannot make native recovery fail.
      }
    }
    const discardedUiTransitions = durableEntries
      .filter(entry => entry.status !== 'committed' && entry.uiTransition)
      .map(entry => ({
        status: entry.status === 'rejected' ? 'rejected' : 'pending',
        journalIndex: entry.journalIndex,
        historyMode: entry.historyMode || 'edit',
        uiTransition: normalizedUiTransition(entry.uiTransition),
      }));
    const committed = durableEntries
      .filter(entry => entry.status === 'committed')
      .sort((left, right) => left.committedRevision - right.committedRevision);
    if (!committed.length) {
      return {
        recoveredTransactions: 0,
        checkpointedTransactions: 0,
        revision: this.revision,
        checkpointRevision,
        uiTransitions: discardedUiTransitions,
      };
    }
    this.#entries = [];
    this.#undo = [];
    this.#redo = [];
    this.#journal = createCommandJournal(this.#engine.sessionId);
    const historical = committed.filter(entry => entry.committedRevision <= checkpointRevision);
    const replay = committed.filter(entry => entry.committedRevision > checkpointRevision);
    for (const [index, entry] of committed.entries()) {
      const isHistorical = entry.committedRevision <= checkpointRevision;
      const prefix = this.#nextId(isHistorical
        ? `checkpoint-history-${index + 1}`
        : `recovery-${index + 1}`);
      const commands = regeneratedCommands(entry.commands || [], prefix);
      const inverseCommands = regeneratedCommands(entry.inverseCommands || [], `${prefix}:inverse`);
      const mode = recoveredHistoryMode(entry);
      const historyLabel = recoveredHistoryLabel(entry, mode);
      const transaction = createPdfTransaction({
        transactionId: `${prefix}:transaction`,
        sessionId: this.#engine.sessionId,
        baseRevision: this.#engine.revision,
        createdAt: Number.isSafeInteger(entry.createdAt) ? entry.createdAt : Date.now(),
        commands,
        resourceHashes: entry.resourceHashes || commandResourceHashes([...commands, ...inverseCommands]),
      });
      let result = null;
      if (!isHistorical) {
        // Recovery mutates only this private engine session. It must never
        // rewrite the durable journal while replay is incomplete: a crash or
        // rejected tail command leaves the original complete record intact.
        await this.#ensureTransactionResources(transaction.resourceHashes);
        try {
          // A replayed command targets objects nobody inspected since the
          // preceding replayed entry; let the worker rebind them first.
          result = await this.#engine.applyTransaction(transaction, { rebindStaleTargets: true });
        } catch (error) {
          const noReplayMutation = this.#engine.revision === checkpointRevision &&
            this.#entries.every(item => item.committedRevision <= checkpointRevision);
          const staleBinding = error?.code === 'transaction-rejected' &&
            /no current Stable Binding or valid page locator/i.test(error?.message || '');
          if (!noReplayMutation || !staleBinding) throw error;

          const rejectedRecoveryTransitions = replay
            .filter(item => item.uiTransition)
            .map(item => ({
              status: 'stale',
              journalIndex: item.journalIndex,
              historyMode: item.historyMode || 'edit',
              uiTransition: normalizedUiTransition(item.uiTransition),
            }));
          await this.#persist();
          return {
            recoveredTransactions: 0,
            checkpointedTransactions: historical.length,
            revision: this.revision,
            checkpointRevision,
            discardedRecoveryTransactions: replay.length,
            recoveryWarning: error?.message || String(error),
            uiTransitions: [...discardedUiTransitions, ...rejectedRecoveryTransitions]
              .sort((left, right) => left.journalIndex - right.journalIndex),
          };
        } finally {
          await this.#releaseTransactionSnapshots(transaction.resourceHashes);
        }
        // Structural commands advance the worker's page epoch. The ordinary
        // live-edit path inspects each dirty page before preparing the next
        // gesture, which rebinds every untouched sibling to that epoch.
        // Recovery must establish the same invariant between journal entries;
        // otherwise the next command can see a valid sibling Stable ID as
        // stale solely because replay runs without UI inspection.
        if (typeof this.#engine.inspectPage === 'function') {
          for (const pageId of new Set(result.dirtyPages || [])) {
            await this.#engine.inspectPage({ pageId });
          }
        }
        this.#onCommit(result);
      }
      const recoveredEntry = {
        label: entry.label || 'Checkpointed PDF edit',
        transaction,
        inverseCommands,
        status: 'committed',
        committedRevision: result?.committedRevision ?? entry.committedRevision,
        effectDigest: result?.effectDigest || entry.effectDigest,
        historyMode: mode,
        historyLabel,
        uiTransition: normalizedUiTransition(entry.uiTransition),
        uiTransitionFinalizationError: entry.uiTransitionFinalizationError || null,
        journalIndex: entry.journalIndex,
      };
      this.#entries.push(recoveredEntry);
      this.#rebuildRecoveredHistory(recoveredEntry);
    }
    this.#trimHistory();
    return {
      recoveredTransactions: replay.length,
      checkpointedTransactions: historical.length,
      revision: this.revision,
      checkpointRevision,
      uiTransitions: [...discardedUiTransitions, ...this.#entries
        .filter(entry => entry.status === 'committed' && entry.uiTransition)
        .map(entry => ({
          status: 'committed',
          journalIndex: entry.journalIndex,
          committedRevision: entry.committedRevision,
          historyMode: entry.historyMode,
          uiTransition: entry.uiTransition,
        }))]
        .sort((left, right) => left.journalIndex - right.journalIndex),
    };
  }

  async withUiTransition(uiTransition, work) {
    if (typeof work !== 'function') throw new TypeError('UI transition work must be a function.');
    const previous = this.#activeUiTransition;
    this.#activeUiTransition = normalizedUiTransition(uiTransition);
    try {
      return await work();
    } finally {
      this.#activeUiTransition = previous;
    }
  }

  /**
   * Makes a content-addressed binary resource durable before it can be
   * referenced by a typed command.
   */
  async registerResource(resource, { persist = true, recovery = false } = {}) {
    if (!recovery) this.#writerLease?.assertWritable();
    if (recovery && persist) {
      throw new TypeError('Recovery resources cannot be persisted during replay.');
    }
    if (
      !resource ||
      typeof resource.hash !== 'string' ||
      !(resource.bytes instanceof Uint8Array)
    ) {
      throw new TypeError('A hashed Uint8Array resource is required.');
    }
    // A checkpoint the engine session retained as a resource
    // (checkpoint({ retainAsResource: true })) is already resident there; do
    // not send the document-sized bytes back. Never persist the marker.
    const { engineResidentSessionId, ...plainResource } = resource;
    const engineResident = typeof engineResidentSessionId === 'string' &&
      engineResidentSessionId === this.#engine.sessionId;
    const existing = this.#resources.get(resource.hash);
    if (!existing) {
      // Pre-encoded binding records (bindingsSidecar) stay encoded for the
      // journal; only an engine that does not hold them yet needs objects.
      const owned = Object.freeze({ ...plainResource, bytes: resource.bytes.slice() });
      if (!engineResident) await this.#engine.putResource(engineResourceWithBindings(owned));
      this.#residentResourceHashes.add(resource.hash);
      this.#resources.set(resource.hash, owned);
      if (persist) await this.#persist();
    } else if (!this.#residentResourceHashes.has(resource.hash)) {
      if (!engineResident) {
        let bindingSource = existing;
        if (!resourceBindingRecords(existing).length && Number(existing.bindingsCount) > 0 &&
            typeof this.#store.loadResource === 'function') {
          // Persisted snapshots keep their records only in the journal.
          bindingSource = await this.#store.loadResource(this.#documentKey, resource.hash) || existing;
        }
        await this.#engine.putResource(engineResourceWithBindings({
          ...existing,
          bindings: resourceBindingRecords(bindingSource),
          bytes: resource.bytes.slice(),
        }));
      }
      this.#residentResourceHashes.add(resource.hash);
    }
    return resource.hash;
  }

  // Clipboard ownership is independent of the source session and journal.
  // Return an owned copy; never detach the kernel's resident resource bytes.
  async copyResource(hash) {
    let resource = this.#resources.get(hash);
    if (!resource) throw new Error(`PDF clipboard resource is unavailable: ${hash}`);
    if (!(resource.bytes instanceof Uint8Array) || !resource.bytes.byteLength) {
      resource = await this.#store.loadResource(this.#documentKey, hash);
    }
    if (!(resource?.bytes instanceof Uint8Array) || !resource.bytes.byteLength) {
      throw new Error(`PDF clipboard resource cannot be read: ${hash}`);
    }
    return { ...engineResourceWithBindings(resource), bytes: resource.bytes.slice() };
  }

  /**
   * @param {object} input
   * @param {import('./commands.js').PdfCommand[]} input.commands
   * @param {import('./commands.js').PdfCommand[]} [input.inverseCommands]
   * @param {string} [input.label]
   * @param {string} [input.transactionId]
   * @param {boolean} [input.recordHistory]
   * @param {string[]} [input.resourceHashes]
   * @param {(result: object, transition: object) => object} [input.finalizeUiTransition]
   */
  execute(input) {
    try {
      this.#writerLease?.assertWritable();
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.#uiTransitionFinalizationError) {
      return Promise.reject(this.#uiTransitionFinalizationError);
    }
    const prepared = {
      ...input,
      uiTransition: normalizedUiTransition(input.uiTransition || this.#activeUiTransition),
    };
    const run = this.#executionTail.then(() => this.#execute(prepared));
    this.#executionTail = run.then(() => undefined, () => undefined);
    return run;
  }

  async #execute({
    commands,
    inverseCommands = [],
    label = 'PDF edit',
    transactionId = this.#nextId('tx'),
    recordHistory = true,
    historyMode = recordHistory ? 'edit' : 'none',
    historyLabel = label,
    uiTransition = null,
    finalizeUiTransition = null,
    // Undo/Redo: the page of each target at the original commit.
    replayTargetPageIds = null,
    // Inverse commands can own resources too. A pre-edit document snapshot is
    // the exact inverse for destructive font-family replacement, and it must
    // remain durable even though the forward command does not reference it.
    resourceHashes = commandResourceHashes([...commands, ...inverseCommands]),
  }) {
    // execute() can enqueue behind an in-flight native transaction. Recheck
    // the durable block at dequeue time so a successor prepared before a
    // finalizer failure cannot create a journal row or reach the engine.
    if (this.#uiTransitionFinalizationError) {
      throw this.#uiTransitionFinalizationError;
    }
    const semanticDigest = canonicalSerialize(commands.map(command => ({
      type: command.type,
      targetId: command.targetId,
      payload: command.payload,
    })));
    // Only collapse a retry of the exact same transaction. Two intentional
    // edits can have identical semantic payloads and must still create two
    // revisions (for example inserting the same image twice).
    if (
      transactionId === this.#lastSemanticTransactionId &&
      semanticDigest === this.#lastSemanticDigest &&
      this.#lastSemanticResult
    ) {
      return this.#lastSemanticResult;
    }
    const transaction = createPdfTransaction({
      transactionId,
      sessionId: this.#engine.sessionId,
      baseRevision: this.#engine.revision,
      createdAt: Date.now(),
      commands,
      resourceHashes,
    });
    this.#journal = appendPendingTransaction(this.#journal, transaction);
    const entry = {
      label,
      transaction,
      inverseCommands,
      status: 'pending',
      committedRevision: null,
      effectDigest: null,
      historyMode,
      historyLabel,
      uiTransition: normalizedUiTransition(uiTransition),
    };
    this.#entries.push(entry);
    await this.#persist();
    let nativeResult = null;
    let committedResult = null;
    try {
      await this.#ensureTransactionResources(transaction.resourceHashes);
      // Undo/Redo replays commands authored for the document state the
      // history has just restored. Their targets' pages need not have been
      // inspected since (page-structure steps keep bindings only until the
      // next inspection, and the editor refreshes only visible pages), so the
      // worker rebinds stale targets exactly as an inspection would.
      const replay = historyMode === 'undo' || historyMode === 'redo';
      const result = await this.#engine.applyTransaction(
        transaction,
        ...(replay ? [{
          rebindStaleTargets: true,
          ...(replayTargetPageIds ? { targetPageIds: replayTargetPageIds } : {}),
        }] : []),
      );
      nativeResult = result;
      committedResult = result;
      if (typeof finalizeUiTransition === 'function' && entry.uiTransition) {
        const originalTransition = entry.uiTransition;
        const originalBeforeDigest = canonicalSerialize(originalTransition.before);
        const finalizerTransition = normalizedUiTransition(originalTransition);
        try {
          // The finalizer receives a detached copy. A buggy callback cannot
          // mutate the pending transition that is already durable.
          const finalizedValue = finalizeUiTransition(result, finalizerTransition);
          if (finalizedValue && typeof finalizedValue.then === 'function') {
            throw new TypeError('PDF UI transition finalizers must be synchronous.');
          }
          const finalized = normalizedUiTransition(finalizedValue);
          if (!finalized) throw new TypeError('The confirmed PDF UI transition is invalid.');
          if (
            canonicalSerialize(finalized.before) !== originalBeforeDigest ||
            finalized.baseUiRevision !== originalTransition.baseUiRevision
          ) {
            throw new TypeError('A confirmed PDF UI transition cannot change its baseline.');
          }
          entry.uiTransition = normalizedUiTransition({
            ...finalized,
            optimisticAfter: originalTransition.after,
          });
        } catch (cause) {
          const error = new Error(
            `The native PDF change was committed, but its UI transition could not be finalized: ${cause?.message || String(cause)}`,
          );
          error.code = 'ui-transition-finalization-failed';
          error.cause = cause;
          this.#uiTransitionFinalizationError = error;
          entry.uiTransitionFinalizationError = Object.freeze({
            code: error.code,
            message: error.message,
          });
          committedResult = {
            ...result,
            uiTransitionFinalizationError: entry.uiTransitionFinalizationError,
          };
        }
      }
      this.#journal = commitTransaction(
        this.#journal,
        transactionId,
        result.committedRevision,
        result.effectDigest,
      );
      entry.status = 'committed';
      entry.committedRevision = result.committedRevision;
      entry.effectDigest = result.effectDigest;
      if (recordHistory) {
        this.#undo.push({
          label, commands, inverseCommands, uiTransition: entry.uiTransition,
          ...(result.targetPageIds ? { targetPageIds: { ...result.targetPageIds } } : {}),
        });
        this.#redo = [];
        this.#trimHistory();
        this.#pruneResourceMetadata();
      }
      // Releasing the worker copies is cleanup only; publishing the commit
      // must not wait for that round trip behind queued renders.
      this.#releaseTransactionSnapshotsInBackground(transaction.resourceHashes);
      await this.#schedulePersist();
      if (entry.uiTransitionFinalizationError) {
        // The native transaction and its failure marker are durable before the
        // shell is told to block further edits. Export remains available from
        // the committed engine state, while this edit can never be retried.
        try {
          this.#onRecoveryState(this.recoveryState);
        } catch {
          // A diagnostic hook cannot reject an already committed edit.
        }
      }
      if (
        this.#checkpointEvery > 0 &&
        result.committedRevision % this.#checkpointEvery === 0
      ) {
        try {
          await this.checkpoint();
        } catch (checkpointError) {
          this.#recoveryError = checkpointError;
          this.#onRecoveryState(this.recoveryState);
        }
      }
      this.#onCommit(committedResult);
      this.#lastSemanticDigest = semanticDigest;
      this.#lastSemanticTransactionId = transactionId;
      this.#lastSemanticResult = committedResult;
      return committedResult;
    } catch (error) {
      if (nativeResult && this.#uiTransitionFinalizationError) {
        // Nothing after a successful native mutation may turn this operation
        // into a rejected/retriable edit. If persisting the committed marker
        // or notifying the shell also fails, retain the editing block and let
        // the user export the authoritative in-memory native document.
        try {
          await this.#releaseTransactionSnapshots(transaction.resourceHashes);
        } catch {
          // Resource release is cleanup only after the native commit.
        }
        try {
          this.#onRecoveryState(this.recoveryState);
        } catch {
          // A diagnostic hook cannot reject an already committed edit.
        }
        this.#lastSemanticDigest = semanticDigest;
        this.#lastSemanticTransactionId = transactionId;
        this.#lastSemanticResult = committedResult;
        return committedResult;
      }
      await this.#releaseTransactionSnapshots(transaction.resourceHashes);
      const rejection = {
        code: typeof error?.code === 'string' ? error.code : 'internal',
        message: error?.message || String(error),
      };
      this.#journal = rejectTransaction(this.#journal, transactionId, rejection);
      entry.status = 'rejected';
      entry.rejection = rejection;
      await this.#persist();
      throw error;
    }
  }

  async undo({ uiTransition = null } = {}) {
    const item = this.#undo.pop();
    if (!item) return null;
    if (!item.inverseCommands.length) {
      this.#undo.push(item);
      throw new Error(`Edit cannot be undone without inverse commands: ${item.label}`);
    }
    const prefix = this.#nextId('undo');
    this.#historyInFlight.add(item);
    try {
      const result = await this.execute({
        commands: regeneratedCommands(item.inverseCommands, prefix),
        inverseCommands: regeneratedCommands(item.commands, `${prefix}:inverse`),
        label: `Undo ${item.label}`,
        transactionId: `${prefix}:transaction`,
        recordHistory: false,
        historyMode: 'undo',
        replayTargetPageIds: item.targetPageIds || null,
        historyLabel: item.label,
        uiTransition: normalizedUiTransition(uiTransition) || reversedUiTransition(item.uiTransition),
      });
      this.#redo.push(item);
      this.#trimHistory();
      this.#pruneResourceMetadata();
      await this.#persist();
      this.#lastUndoError = null;
      return result;
    } catch (error) {
      this.#undo.push(item);
      this.#lastUndoError = error;
      throw error;
    } finally {
      this.#historyInFlight.delete(item);
    }
  }

  async redo({ uiTransition = null } = {}) {
    const item = this.#redo.pop();
    if (!item) return null;
    const prefix = this.#nextId('redo');
    this.#historyInFlight.add(item);
    try {
      const result = await this.execute({
        commands: regeneratedCommands(item.commands, prefix),
        inverseCommands: regeneratedCommands(item.inverseCommands, `${prefix}:inverse`),
        label: `Redo ${item.label}`,
        transactionId: `${prefix}:transaction`,
        recordHistory: false,
        historyMode: 'redo',
        replayTargetPageIds: item.targetPageIds || null,
        historyLabel: item.label,
        uiTransition: normalizedUiTransition(uiTransition) || normalizedUiTransition(item.uiTransition),
      });
      this.#undo.push(item);
      this.#trimHistory();
      this.#pruneResourceMetadata();
      await this.#persist();
      this.#lastUndoError = null;
      return result;
    } catch (error) {
      this.#redo.push(item);
      throw error;
    } finally {
      this.#historyInFlight.delete(item);
    }
  }

  async checkpoint() {
    const checkpoint = await this.#engine.checkpoint();
    const previous = {
      revision: this.#checkpointRevision,
      bytes: this.#checkpointBytes,
      bindings: this.#checkpointBindings,
    };
    this.#checkpointRevision = checkpoint.revision;
    this.#checkpointBytes = checkpoint.bytes;
    this.#checkpointBindings = checkpoint.bindings || [];
    try {
      this.#pruneResourceMetadata();
      await this.#persist();
      this.#recoveryError = null;
      this.#onRecoveryState(this.recoveryState);
    } catch (error) {
      this.#checkpointRevision = previous.revision;
      this.#checkpointBytes = previous.bytes;
      this.#checkpointBindings = previous.bindings;
      throw error;
    }
    return checkpoint;
  }

  async #persist() {
    const saved = await this.#store.save(this.#documentKey, {
      entries: this.#entries.map(entry => ({
        label: entry.label,
        transactionId: entry.transaction.transactionId,
        baseRevision: entry.transaction.baseRevision,
        createdAt: entry.transaction.createdAt,
        commands: entry.transaction.commands,
        resourceHashes: entry.transaction.resourceHashes,
        inverseCommands: entry.inverseCommands,
        status: entry.status,
        committedRevision: entry.committedRevision,
        effectDigest: entry.effectDigest,
        rejection: entry.rejection || null,
        historyMode: entry.historyMode || 'none',
        historyLabel: entry.historyLabel || entry.label,
        uiTransition: entry.uiTransition || null,
        uiTransitionFinalizationError: entry.uiTransitionFinalizationError || null,
      })),
      checkpointRevision: this.#checkpointRevision,
      checkpointBytes: this.#checkpointBytes,
      checkpointBindings: this.#checkpointBindings,
      resources: [...this.#resources.values()],
    });
    // Snapshot bytes are durable in the resource backend. Keep only metadata in
    // the kernel heap; undo/recovery hydrate the exact bytes by content hash.
    for (const [hash, resource] of this.#resources) {
      if (resource.kind !== 'pdf-snapshot' || !(resource.bytes instanceof Uint8Array)) continue;
      const { bindingsSidecar: _persistedSidecar, ...metadata } = resource;
      this.#resources.set(hash, Object.freeze({
        ...metadata,
        bytes: null,
        byteLength: resource.bytes.byteLength,
      }));
    }
    return saved;
  }

  async #ensureTransactionResources(resourceHashes = []) {
    for (const hash of resourceHashes) {
      if (this.#residentResourceHashes.has(hash)) continue;
      const metadata = this.#resources.get(hash);
      if (!metadata) throw new Error(`PDF transaction resource is unavailable: ${hash}`);
      let resource = metadata;
      if (!(resource.bytes instanceof Uint8Array) || !resource.bytes.byteLength) {
        if (typeof this.#store.loadResource !== 'function') {
          throw new Error(`PDF recovery resource cannot be hydrated: ${hash}`);
        }
        resource = await this.#store.loadResource(this.#documentKey, hash);
      }
      if (!(resource?.bytes instanceof Uint8Array) || !resource.bytes.byteLength) {
        throw new Error(`PDF recovery resource is unavailable: ${hash}`);
      }
      await this.#engine.putResource(engineResourceWithBindings(resource));
      this.#residentResourceHashes.add(hash);
    }
  }

  async #releaseTransactionSnapshots(resourceHashes = []) {
    if (typeof this.#engine.releaseResource !== 'function') return;
    for (const hash of resourceHashes) {
      const resource = this.#resources.get(hash);
      if (resource?.kind !== 'pdf-snapshot' || !this.#residentResourceHashes.has(hash)) continue;
      try {
        await this.#engine.releaseResource(hash);
        this.#residentResourceHashes.delete(hash);
      } catch {
        // A failed release leaves a bounded worker resource resident; it must
        // not turn an already committed transaction into a reported failure.
      }
    }
  }

  // Same effect as #releaseTransactionSnapshots without awaiting the engine.
  // The hashes stop counting as resident immediately, so a following
  // transaction that needs one of them (an immediate Undo) re-sends it, and
  // the engine handles that put after this release.
  #releaseTransactionSnapshotsInBackground(resourceHashes = []) {
    if (typeof this.#engine.releaseResource !== 'function') return;
    for (const hash of resourceHashes) {
      const resource = this.#resources.get(hash);
      if (resource?.kind !== 'pdf-snapshot' || !this.#residentResourceHashes.has(hash)) continue;
      this.#residentResourceHashes.delete(hash);
      try {
        void Promise.resolve(this.#engine.releaseResource(hash)).catch(() => {
          // A failed release leaves a bounded worker resource resident; a
          // later put of the same hash is answered as a duplicate.
        });
      } catch {
        // See above: cleanup only after the native commit.
      }
    }
  }

  #trimHistory() {
    if (this.#resources.size === 0) return;
    const trimSnapshots = stack => {
      let retained = 0;
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        const item = stack[index];
        const ownsSnapshot = commandResourceHashes([...item.commands, ...item.inverseCommands])
          .some(hash => this.#resources.get(hash)?.kind === 'pdf-snapshot');
        if (!ownsSnapshot) continue;
        retained += 1;
        if (retained > this.#snapshotHistoryLimit) stack.splice(index, 1);
      }
    };
    trimSnapshots(this.#undo);
    trimSnapshots(this.#redo);
  }

  #pruneResourceMetadata() {
    if (this.#resources.size === 0) return;
    const retainedSnapshots = new Set();
    // The periodic checkpoint runs inside the Undo/Redo transaction, before
    // the item reaches the opposite stack. Without the in-flight item, its
    // snapshot was dropped and the next Redo/Undo of it failed with
    // "PDF transaction resource is unavailable".
    for (const item of [...this.#undo, ...this.#redo, ...this.#historyInFlight]) {
      for (const hash of commandResourceHashes([...item.commands, ...item.inverseCommands])) {
        if (this.#resources.get(hash)?.kind === 'pdf-snapshot') retainedSnapshots.add(hash);
      }
    }
    for (const entry of this.#entries) {
      if (
        entry.status !== 'pending' &&
        Number(entry.committedRevision || 0) <= this.#checkpointRevision
      ) continue;
      for (const hash of commandResourceHashes(entry.transaction.commands)) {
        if (this.#resources.get(hash)?.kind === 'pdf-snapshot') retainedSnapshots.add(hash);
      }
    }
    for (const [hash, resource] of this.#resources) {
      if (resource.kind === 'pdf-snapshot' && !retainedSnapshots.has(hash)) {
        this.#resources.delete(hash);
        this.#residentResourceHashes.delete(hash);
      }
    }
  }

  #rebuildRecoveredHistory(entry) {
    const mode = entry.historyMode;
    if (mode === 'none') return;
    const commands = entry.transaction.commands;
    const inverseCommands = entry.inverseCommands;
    if (mode === 'edit') {
      this.#undo.push({
        label: entry.historyLabel,
        commands,
        inverseCommands,
        uiTransition: entry.uiTransition || null,
      });
      this.#redo = [];
      return;
    }
    if (mode === 'undo') {
      const item = this.#undo.at(-1);
      if (!item || semanticCommandsDigest(item.inverseCommands) !== semanticCommandsDigest(commands)) {
        throw new Error(`Recovered Undo history does not match its preceding edit: ${entry.historyLabel}`);
      }
      this.#undo.pop();
      this.#redo.push(item);
      return;
    }
    if (mode === 'redo') {
      const item = this.#redo.at(-1);
      if (!item || semanticCommandsDigest(item.commands) !== semanticCommandsDigest(commands)) {
        throw new Error(`Recovered Redo history does not match its preceding Undo: ${entry.historyLabel}`);
      }
      this.#redo.pop();
      this.#undo.push(item);
    }
  }

  #schedulePersist() {
    if (this.#persistScheduled) return this.#persistScheduled;
    const scheduled = new Promise((resolve, reject) => {
      queueMicrotask(() => {
        this.#persist().then(resolve, reject);
      });
    });
    let wrapped = null;
    wrapped = scheduled.finally(() => {
      if (this.#persistScheduled === wrapped) {
        this.#persistScheduled = null;
      }
    });
    this.#persistScheduled = wrapped;
    return wrapped;
  }

  #nextId(kind) {
    this.#sequence += 1;
    return `${kind}-${Date.now()}-${this.#sequence}`;
  }
}
