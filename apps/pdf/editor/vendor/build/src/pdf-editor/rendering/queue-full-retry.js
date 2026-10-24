// A refused tile did not enter the worker queue. Wait for capacity freed by
// work completed *after the refusal*, not work that completed while the tile
// was still waiting in the page scheduler.
export function subscribeQueueFullRetry(engine, wake) {
  if (typeof engine?.onWorkCompleted !== 'function' || typeof wake !== 'function') return null;
  const baseline = Number(engine.completedWorkSequence) || 0;
  let active = true;
  let unsubscribe = () => {};
  const onCompletion = sequence => {
    if (!active || Number(sequence) <= baseline) return;
    active = false;
    unsubscribe();
    wake();
  };
  unsubscribe = engine.onWorkCompleted(onCompletion);
  if (!active) unsubscribe();
  // A completion may arrive between reading the baseline and subscribing.
  if (Number(engine.completedWorkSequence) > baseline) {
    queueMicrotask(() => onCompletion(engine.completedWorkSequence));
  }
  return () => {
    active = false;
    unsubscribe();
  };
}
