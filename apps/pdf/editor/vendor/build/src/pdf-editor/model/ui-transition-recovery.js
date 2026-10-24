// @ts-check

/**
 * Resolves the only two durable UI phases that may accompany a committed
 * native transaction whose workspace revision marker still trails it.
 */
export function resolveCommittedUiProjection({
  currentState,
  transition,
  historyBaselineMatches,
  firstMismatch,
  applyDifference,
}) {
  if (!historyBaselineMatches || !transition?.before || !transition?.after) return null;
  const optimisticAfter = transition.optimisticAfter;
  if (
    !firstMismatch(currentState, transition.after, transition.before) &&
    (!optimisticAfter || !firstMismatch(currentState, transition.after, optimisticAfter))
  ) {
    return { phase: 'confirmed', state: currentState };
  }
  if (
    optimisticAfter &&
    !firstMismatch(currentState, optimisticAfter, transition.before) &&
    !firstMismatch(currentState, optimisticAfter, transition.after)
  ) {
    return {
      phase: 'optimistic',
      state: applyDifference(currentState, optimisticAfter, transition.after),
    };
  }
  return null;
}
