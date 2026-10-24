// @ts-check

export const JournalStatus = Object.freeze({
  PENDING: 'pending',
  COMMITTED: 'committed',
  REJECTED: 'rejected',
});

/**
 * @typedef {import('./commands.js').PdfTransaction} PdfTransaction
 */

/**
 * @typedef {object} JournalEntry
 * @property {PdfTransaction} transaction
 * @property {string} status
 * @property {number | null} committedRevision
 * @property {string | null} effectDigest
 * @property {{ code: string, message: string } | null} rejection
 */

/**
 * @typedef {object} CommandJournal
 * @property {string} sessionId
 * @property {readonly JournalEntry[]} entries
 */

/**
 * @param {string} sessionId
 * @returns {CommandJournal}
 */
export function createCommandJournal(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) throw new TypeError('sessionId is required.');
  return Object.freeze({ sessionId, entries: Object.freeze([]) });
}

/**
 * @param {CommandJournal} journal
 * @param {PdfTransaction} transaction
 * @returns {CommandJournal}
 */
export function appendPendingTransaction(journal, transaction) {
  if (transaction.sessionId !== journal.sessionId) {
    throw new Error('Transaction session does not match journal session.');
  }
  const existing = journal.entries.find(
    (entry) => entry.transaction.transactionId === transaction.transactionId,
  );
  if (existing) {
    if (existing.transaction !== transaction) {
      throw new Error(`Transaction ID collision: ${transaction.transactionId}`);
    }
    return journal;
  }
  const entry = Object.freeze({
    transaction,
    status: JournalStatus.PENDING,
    committedRevision: null,
    effectDigest: null,
    rejection: null,
  });
  return Object.freeze({
    ...journal,
    entries: Object.freeze([...journal.entries, entry]),
  });
}

/**
 * @param {CommandJournal} journal
 * @param {string} transactionId
 * @param {number} committedRevision
 * @param {string} effectDigest
 * @returns {CommandJournal}
 */
export function commitTransaction(journal, transactionId, committedRevision, effectDigest) {
  if (!Number.isSafeInteger(committedRevision) || committedRevision < 1) {
    throw new TypeError('committedRevision must be a positive safe integer.');
  }
  if (typeof effectDigest !== 'string' || !effectDigest) {
    throw new TypeError('effectDigest is required.');
  }
  let found = false;
  const entries = journal.entries.map((entry) => {
    if (entry.transaction.transactionId !== transactionId) return entry;
    found = true;
    if (entry.status === JournalStatus.REJECTED) {
      throw new Error('A rejected transaction cannot be committed.');
    }
    if (entry.status === JournalStatus.COMMITTED) {
      if (
        entry.committedRevision !== committedRevision ||
        entry.effectDigest !== effectDigest
      ) {
        throw new Error(`Conflicting duplicate commit for ${transactionId}.`);
      }
      return entry;
    }
    return Object.freeze({
      ...entry,
      status: JournalStatus.COMMITTED,
      committedRevision,
      effectDigest,
    });
  });
  if (!found) throw new Error(`Unknown transaction: ${transactionId}`);

  const committedRevisions = entries
    .filter((entry) => entry.status === JournalStatus.COMMITTED)
    .map((entry) => /** @type {number} */ (entry.committedRevision));
  if (new Set(committedRevisions).size !== committedRevisions.length) {
    throw new Error('Committed revisions must be unique.');
  }

  return Object.freeze({ ...journal, entries: Object.freeze(entries) });
}

/**
 * @param {CommandJournal} journal
 * @param {string} transactionId
 * @param {{ code: string, message: string }} rejection
 * @returns {CommandJournal}
 */
export function rejectTransaction(journal, transactionId, rejection) {
  if (!rejection || typeof rejection.code !== 'string' || typeof rejection.message !== 'string') {
    throw new TypeError('A typed rejection is required.');
  }
  let found = false;
  const entries = journal.entries.map((entry) => {
    if (entry.transaction.transactionId !== transactionId) return entry;
    found = true;
    if (entry.status === JournalStatus.COMMITTED) {
      throw new Error('A committed transaction cannot be rejected.');
    }
    return Object.freeze({
      ...entry,
      status: JournalStatus.REJECTED,
      rejection: Object.freeze({ ...rejection }),
    });
  });
  if (!found) throw new Error(`Unknown transaction: ${transactionId}`);
  return Object.freeze({ ...journal, entries: Object.freeze(entries) });
}

/**
 * @param {CommandJournal} journal
 * @returns {readonly PdfTransaction[]}
 */
export function committedTransactions(journal) {
  return Object.freeze(
    journal.entries
      .filter((entry) => entry.status === JournalStatus.COMMITTED)
      .sort(
        (left, right) =>
          /** @type {number} */ (left.committedRevision) -
          /** @type {number} */ (right.committedRevision),
      )
      .map((entry) => entry.transaction),
  );
}
