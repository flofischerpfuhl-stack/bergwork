export function sourceCommitEntryState({
  nativeRequired = false,
  documentId = '',
  runtime = null,
  safety = null,
} = {}) {
  if (!nativeRequired) {
    return { allowed: true, nativeRequired: false, exactRuntime: false, reason: '' };
  }
  const exactRuntime = Boolean(runtime?.kernel && runtime.documentId === documentId);
  const queueableReadiness = exactRuntime && (
    safety?.opening === true || safety?.pageStructureBusy === true
  ) && safety?.readOnly !== true && safety?.tainted !== true && safety?.retiring !== true;
  if (exactRuntime && (
    (runtime.ready === true && safety?.mutationBlocked !== true) || queueableReadiness
  )) {
    return {
      allowed: true, nativeRequired: true, exactRuntime: true,
      ...(queueableReadiness ? { queued: true } : {}),
      reason: '',
    };
  }
  return {
    allowed: false,
    nativeRequired: true,
    exactRuntime,
    reason: exactRuntime
      ? safety?.reason || 'The PDF editing session is still opening. Try the change again.'
      : 'The PDF editing session changed before this edit could be committed. Try the change again.',
  };
}

export function acceptSourceCommitEntry(state, { cancelDraft, reportFailure } = {}) {
  if (state?.allowed === true) return true;
  if (state?.exactRuntime === true) cancelDraft?.();
  reportFailure?.(state?.reason || 'The PDF editing session is unavailable.');
  return false;
}
