// @ts-check

/**
 * The worker emits this proof only after a one-for-one replacement retained
 * every untouched native object handle at the same top-level index.
 *
 * @param {object} result
 * @param {number} pageIndex
 */
export function hasTopologyPreservingReplacementProof(result, pageIndex) {
  if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) return false;
  const pages = result?.diagnostics?.timing?.topologyPreservingTextReplacementPages;
  return Array.isArray(pages) && pages.some(value => value === pageIndex);
}

/**
 * Cross-page and nested edits always need a canonical readback. A changed
 * Page Epoch normally does too, except when the worker proved that the sole
 * structural replacement preserved every untouched top-level binding.
 *
 * @param {object} input
 * @param {boolean} input.crossesPages
 * @param {boolean} input.nested
 * @param {number} input.committedPageEpoch
 * @param {number} input.inspectedPageEpoch
 * @param {object} input.result
 * @param {number} input.pageIndex
 */
export function requiresImmediateCommittedPageInspection({
  crossesPages,
  nested,
  committedPageEpoch,
  inspectedPageEpoch,
  result,
  pageIndex,
}) {
  if (crossesPages || nested) return true;
  if (committedPageEpoch === inspectedPageEpoch) return false;
  return !hasTopologyPreservingReplacementProof(result, pageIndex);
}

/**
 * Canonical refinement must not enter the single PDFium FIFO ahead of the
 * visible rasters for the current revision.
 *
 * @param {object} input
 * @param {number} input.currentRevision
 * @param {{ revision: number, required: boolean, covered: boolean } | null | undefined} input.coverage
 * @param {number} input.schedulerRunning
 * @param {number} input.schedulerQueued
 * @param {number} input.pendingCommitCount
 */
export function canStartDeferredPageInspection({
  currentRevision,
  coverage,
  schedulerRunning,
  schedulerQueued,
  pendingCommitCount,
}) {
  if (pendingCommitCount > 0 || schedulerRunning > 0 || schedulerQueued > 0) return false;
  if (!coverage?.required) return true;
  return coverage.revision === currentRevision && coverage.covered === true;
}
