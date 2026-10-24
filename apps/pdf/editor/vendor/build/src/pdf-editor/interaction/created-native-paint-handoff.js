// A created text annotation gains a native object binding when inspection of
// its committed edit finishes. That binding can arrive before the matching
// page raster is shown. Keep its DOM ink until the native generation is
// visible, then keep the handoff latched across unrelated later revisions.
export class CreatedNativePaintHandoff {
  #runtime = null;
  #pageId = '';
  #shownRevision = -1;
  #bindings = new Map();

  reset(runtime, pageId) {
    if (this.#runtime === runtime && this.#pageId === pageId) return;
    this.#runtime = runtime;
    this.#pageId = pageId;
    this.#shownRevision = -1;
    this.#bindings.clear();
  }

  show(revision) {
    if (!Number.isSafeInteger(revision) || revision < 0) return false;
    this.#shownRevision = revision;
    let changed = false;
    for (const binding of this.#bindings.values()) {
      if (!binding.painted && revision >= binding.requiredRevision) {
        binding.painted = true;
        changed = true;
      }
    }
    return changed;
  }

  observe(annotationId, stableId, requiredRevision) {
    if (!annotationId || !stableId) return false;
    const previous = this.#bindings.get(annotationId);
    if (previous?.stableId === stableId) return previous.painted;
    const revision = Number.isSafeInteger(requiredRevision) && requiredRevision >= 0
      ? requiredRevision : Number.MAX_SAFE_INTEGER;
    const binding = { stableId, requiredRevision: revision,
      painted: this.#shownRevision >= revision };
    this.#bindings.set(annotationId, binding);
    return binding.painted;
  }

  prune(activeAnnotationIds) {
    for (const id of this.#bindings.keys()) {
      if (!activeAnnotationIds.has(id)) this.#bindings.delete(id);
    }
  }
}
