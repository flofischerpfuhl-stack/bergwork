/** A gesture born from an optimistic PDF state must not outlive its rejection. */
export function dependsOnUnconfirmedPdfWork(runtime) {
  return Boolean(runtime && (
    runtime.pendingCommits?.size ||
    runtime.pendingObjectEdits?.size ||
    runtime.gestureCommits?.size ||
    runtime.pendingUiCommitCounts?.size ||
    runtime.uiDraftTargets?.size
  ));
}

export function shouldCancelDependentPdfDrag(drag, rejection) {
  return Boolean(drag?.dependsOnUnconfirmed && rejection?.runtime &&
    drag.releaseRuntime === rejection.runtime &&
    rejection.runtime.documentId === rejection.documentId);
}
