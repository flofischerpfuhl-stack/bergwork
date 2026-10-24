// Pure revision gate for drag handoff. It observes complete page generations
// and commit identities; the shell performs the resulting DOM switch in one
// layout task. No canvas, worker, clock or browser state lives here.

const validRevision = value => Number.isSafeInteger(value) && value >= 0;
const pageList = pages => [...new Set((Array.isArray(pages) ? pages : [])
  .filter(page => typeof page === 'string' && page))];
const targets = targetIds => [...new Set((Array.isArray(targetIds) ? targetIds : [])
  .filter(id => typeof id === 'string' && id))];
const pinsForPages = (pinRevisions, pages) => {
  if (pinRevisions == null) return null;
  if (typeof pinRevisions !== 'object' || Array.isArray(pinRevisions) ||
      ![null, Object.prototype].includes(Object.getPrototypeOf(pinRevisions))) {
    throw new TypeError('Pinned revisions must be a page-to-revision object.');
  }
  const entries = Object.entries(pinRevisions);
  if (entries.some(([pageId, revision]) => !pages.includes(pageId) || !validRevision(revision))) {
    throw new TypeError('Pinned revisions require linked pages and valid revisions.');
  }
  return entries.length ? Object.freeze(Object.fromEntries(entries)) : null;
};
const ownMove = (commit, targetId, kind) => kind === 'move' && commit.kind === 'move' &&
  commit.targetIds.length === 1 && commit.targetIds[0] === targetId;
const MAX_DETAILED_COMMITS = 128;

export class AtomicGenerationController {
  #pages = new Map();
  #holds = new Map();
  #gestures = new Map();
  #pending = new Map();
  #committed = new Map();
  #historyFloor = new Map();
  #compacted = new Map();

  #compactCommit(commit) {
    // Keep the proof needed for old, still-visible bases without retaining an
    // unbounded transaction log. A mixed interval may reject an otherwise
    // compatible candidate; it can never admit foreign ink by mistake.
    for (const pageId of commit.pages) {
      const previous = this.#compacted.get(pageId);
      const targetId = commit.kind === 'move' && commit.targetIds.length === 1 ?
        commit.targetIds[0] : null;
      this.#compacted.set(pageId, {
        minRevision: Math.min(previous?.minRevision ?? commit.revision, commit.revision),
        maxRevision: Math.max(previous?.maxRevision ?? commit.revision, commit.revision),
        soleTarget: previous && previous.soleTarget !== targetId ? null : targetId,
      });
    }
  }

  #pruneHistory() {
    for (const [pageId, page] of this.#pages) {
      if (page.shownRevision == null) continue;
      const bases = [
        ...[...this.#holds.values()].filter(hold => hold.pages.includes(pageId)).map(hold => hold.baseRevision),
        ...[...this.#gestures.values()].filter(gesture => gesture.pages.includes(pageId)).map(gesture => gesture.baseRevision),
      ];
      const safeFloor = Math.min(page.shownRevision, ...bases);
      this.#historyFloor.set(pageId, Math.max(this.#historyFloor.get(pageId) || 0, safeFloor));
    }
    for (const [id, commit] of this.#committed) {
      if (commit.pages.every(pageId => !this.#pages.has(pageId) ||
          commit.revision <= (this.#historyFloor.get(pageId) || 0))) this.#committed.delete(id);
    }
    for (const [pageId, summary] of this.#compacted) {
      const floor = this.#historyFloor.get(pageId) || 0;
      if (!this.#pages.has(pageId) || summary.maxRevision <= floor) this.#compacted.delete(pageId);
      else summary.minRevision = Math.max(summary.minRevision, floor + 1);
    }
    if (this.#committed.size > MAX_DETAILED_COMMITS) {
      const oldest = [...this.#committed.values()]
        .sort((left, right) => left.revision - right.revision || String(left.id).localeCompare(String(right.id)))
        .slice(0, this.#committed.size - MAX_DETAILED_COMMITS);
      for (const commit of oldest) {
        this.#compactCommit(commit);
        this.#committed.delete(commit.id);
      }
    }
  }

  #page(pageId) {
    let page = this.#pages.get(pageId);
    if (!page) {
      // A linked destination may never mount. Only an actual page view may
      // opt into joint publication after checking viewport intersection.
      page = { shownRevision: null, shownCoverageKey: null, prepared: new Map(), participating: false };
      this.#pages.set(pageId, page);
    }
    return page;
  }

  registerHold({ id, pages, baseRevision, targetId, kind = 'other', commitRevision = null,
    pinRevisions = null }) {
    if (!id || !validRevision(baseRevision) || !targetId ||
        (commitRevision != null && !validRevision(commitRevision))) {
      throw new TypeError('Hold requires an ID, canonical target, and valid revisions.');
    }
    const linkedPages = pageList(pages);
    if (!linkedPages.length) throw new TypeError('Hold needs at least one page.');
    const pins = pinsForPages(pinRevisions, linkedPages);
    linkedPages.forEach(page => this.#page(page));
    this.#holds.set(id, { id, pages: linkedPages, baseRevision, targetId, kind, commitRevision,
      pinRevisions: pins });
    this.#pruneHistory();
  }

  updateHoldRevision(id, revision) {
    if (!validRevision(revision)) throw new TypeError('Invalid committed hold revision.');
    const hold = this.#holds.get(id);
    if (!hold) return false;
    hold.commitRevision = revision;
    return true;
  }

  endHold(id) {
    const removed = this.#holds.delete(id);
    if (removed) this.#pruneHistory();
    return removed;
  }

  commitPending({ id, pages, targetIds = [], kind = 'other' }) {
    if (!id) throw new TypeError('Pending commit needs an ID.');
    const linkedPages = pageList(pages);
    if (!linkedPages.length) throw new TypeError('Pending commit needs a page.');
    linkedPages.forEach(page => this.#page(page));
    this.#pending.set(id, { id, pages: linkedPages, targetIds: targets(targetIds),
      kind: typeof kind === 'string' ? kind : 'other' });
  }

  commitSettled({ id, revision, pages, targetIds, kind } = {}) {
    // Native callbacks can arrive out of order while a session retires. The
    // caller terminals affected pages on false; never throw through its
    // promise callback or change the ledger for a conflicting identity.
    if (typeof id !== 'string' || !id || !validRevision(revision)) return false;
    const previous = this.#pending.get(id);
    const linkedPages = pageList(pages ?? previous?.pages);
    if (!linkedPages.length) return false;
    const record = { id, revision, pages: linkedPages,
      targetIds: targets(targetIds ?? previous?.targetIds),
      kind: typeof kind === 'string' ? kind : previous?.kind || 'other' };
    const existing = this.#committed.get(id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(record)) {
      return false;
    }
    linkedPages.forEach(page => this.#page(page));
    this.#pending.delete(id);
    this.#committed.set(id, record);
    this.#pruneHistory();
    return true;
  }

  commitRejected(id) {
    return this.#pending.delete(id);
  }

  generationPrepared({ pageId, revision, coverageKey }) {
    if (!pageId || !validRevision(revision) || !coverageKey) {
      throw new TypeError('Prepared generation needs page, revision and coverage key.');
    }
    this.#page(pageId).prepared.set(revision, coverageKey);
  }

  generationInvalidated({ pageId, coverageKey = null }) {
    if (!pageId) throw new TypeError('Page ID required.');
    const page = this.#pages.get(pageId);
    if (!page) return;
    if (coverageKey == null) page.prepared.clear();
    else for (const [revision, key] of page.prepared) {
      if (key === coverageKey) page.prepared.delete(revision);
    }
  }

  generationShown({ pageId, revision, coverageKey } = {}) {
    if (typeof pageId !== 'string' || !pageId || !validRevision(revision) ||
        typeof coverageKey !== 'string' || !coverageKey) return false;
    const page = this.#page(pageId);
    if (page.shownRevision != null && revision < page.shownRevision) {
      return false;
    }
    page.shownRevision = revision;
    page.shownCoverageKey = coverageKey;
    for (const preparedRevision of page.prepared.keys()) {
      if (preparedRevision <= revision) page.prepared.delete(preparedRevision);
    }
    this.#pruneHistory();
    return true;
  }

  setPageParticipating(pageId, participating) {
    if (!pageId) throw new TypeError('Page ID required.');
    this.#page(pageId).participating = Boolean(participating);
  }

  enterGesture({ id, pages, baseRevision, targetId, kind = 'other', usesComposition = false,
    pinRevisions = null }) {
    if (!id || !validRevision(baseRevision) || !targetId) {
      throw new TypeError('Gesture requires ID, canonical target and base revision.');
    }
    const linkedPages = pageList(pages);
    if (!linkedPages.length) throw new TypeError('Gesture needs at least one page.');
    const pins = pinsForPages(pinRevisions, linkedPages);
    linkedPages.forEach(page => this.#page(page));
    this.#gestures.set(id, { id, pages: linkedPages, baseRevision, targetId, kind,
      usesComposition: Boolean(usesComposition), pinRevisions: pins });
  }

  exitGesture(id) {
    const removed = this.#gestures.delete(id);
    if (removed) this.#pruneHistory();
    return removed;
  }

  hasBarrier(pageId) {
    return [...this.#holds.values()].some(hold => hold.pages.includes(pageId)) ||
      [...this.#gestures.values()].some(gesture => gesture.pages.includes(pageId));
  }

  #compatibleAt({ pages, baseRevision, targetId, kind, pinRevisions }, revisionForPage,
    includeUnpaintedForeign = false) {
    const participating = pages.filter(pageId => this.#pages.get(pageId)?.participating);
    if (!participating.length) return false;
    for (const pageId of participating) {
      const shown = revisionForPage(pageId);
      if (!validRevision(shown) || shown < baseRevision) return false;
      if (pinRevisions && Object.hasOwn(pinRevisions, pageId) &&
          shown !== pinRevisions[pageId]) return false;
      if (baseRevision < (this.#historyFloor.get(pageId) || 0)) return false;
      for (const pending of this.#pending.values()) {
        if (pending.pages.includes(pageId) && !ownMove(pending, targetId, kind)) return false;
      }
      for (const committed of this.#committed.values()) {
        if (committed.pages.includes(pageId) && committed.revision > baseRevision &&
            (includeUnpaintedForeign || committed.revision <= shown) &&
            !ownMove(committed, targetId, kind)) return false;
      }
      const compacted = this.#compacted.get(pageId);
      if (compacted && compacted.maxRevision > baseRevision &&
          (includeUnpaintedForeign || compacted.minRevision <= shown) &&
          (kind !== 'move' || compacted.soleTarget !== targetId)) return false;
    }
    return true;
  }

  canShowComposition({ pages, baseRevision, targetId, kind = 'other' }) {
    return this.#compatibleAt({ pages: pageList(pages), baseRevision, targetId, kind },
      pageId => this.#pages.get(pageId)?.shownRevision, true);
  }

  #components() {
    // Paint staging remains active offscreen, while publication waits only
    // for currently participating pages. A linked visible page may advance
    // without losing its hold merely because its partner scrolled out.
    const barrierPages = [...this.#pages.keys()].filter(pageId =>
      this.#pages.get(pageId).participating && this.hasBarrier(pageId));
    const remaining = new Set(barrierPages), components = [];
    while (remaining.size) {
      const component = new Set([remaining.values().next().value]);
      remaining.delete(component.values().next().value);
      let changed = true;
      while (changed) {
        changed = false;
        for (const entry of [...this.#holds.values(), ...this.#gestures.values()]) {
          const linked = entry.pages.filter(pageId => this.#pages.get(pageId)?.participating);
          if (!linked.some(pageId => component.has(pageId))) continue;
          for (const pageId of linked) if (remaining.delete(pageId)) {
            component.add(pageId); changed = true;
          }
        }
      }
      components.push([...component].sort());
    }
    return components;
  }

  planSwitches() {
    const plans = [];
    for (const component of this.#components()) {
      const firstPage = this.#pages.get(component[0]);
      const revisions = [...new Set([...firstPage.prepared.keys(), firstPage.shownRevision])]
        .filter(revision => component.every(pageId => {
          const page = this.#pages.get(pageId);
          return (page.prepared.has(revision) || page.shownRevision === revision) &&
            page.shownRevision != null && revision >= page.shownRevision;
        }) && (component.some(pageId => revision > this.#pages.get(pageId).shownRevision ||
          (this.#pages.get(pageId).prepared.has(revision) &&
            this.#pages.get(pageId).prepared.get(revision) !== this.#pages.get(pageId).shownCoverageKey)) ||
          [...this.#holds.values()].some(hold => hold.commitRevision != null &&
            hold.commitRevision <= revision && hold.pages.some(pageId => component.includes(pageId)))))
        .sort((left, right) => right - left);
      for (const revision of revisions) {
        const holds = [...this.#holds.values()].filter(hold =>
          hold.pages.some(pageId => component.includes(pageId)));
        const dismissHoldIds = holds.filter(hold => hold.commitRevision != null &&
          hold.commitRevision <= revision).map(hold => hold.id).sort();
        if (holds.some(hold => !dismissHoldIds.includes(hold.id) &&
          !this.#compatibleAt(hold, () => revision))) continue;
        const activeVisuals = [...this.#gestures.values()].filter(gesture =>
          (gesture.usesComposition || gesture.pinRevisions) &&
          gesture.pages.some(pageId => component.includes(pageId)));
        if (activeVisuals.some(gesture => gesture.pages.some(pageId =>
          this.#pages.get(pageId)?.participating && !component.includes(pageId)) ||
          !this.#compatibleAt(gesture, () => revision))) continue;
        plans.push({ pages: component.map(pageId => ({ pageId, revision,
          coverageKey: this.#pages.get(pageId).prepared.get(revision) ??
            this.#pages.get(pageId).shownCoverageKey })), dismissHoldIds });
        break;
      }
    }
    return plans;
  }

  planOffscreenHolds(currentRevision) {
    if (!validRevision(currentRevision)) return [];
    const remaining = new Set(this.#holds.keys()), plans = [];
    while (remaining.size) {
      const firstId = remaining.values().next().value;
      const holdIds = new Set([firstId]);
      const pageIds = new Set(this.#holds.get(firstId).pages);
      remaining.delete(firstId);
      let changed = true;
      while (changed) {
        changed = false;
        for (const id of [...remaining]) {
          const hold = this.#holds.get(id);
          if (!hold.pages.some(pageId => pageIds.has(pageId))) continue;
          holdIds.add(id);
          remaining.delete(id);
          for (const pageId of hold.pages) pageIds.add(pageId);
          changed = true;
        }
      }
      const pages = [...pageIds].sort();
      if (pages.some(pageId => this.#pages.get(pageId)?.participating)) continue;
      if ([...holdIds].some(id => {
        const revision = this.#holds.get(id)?.commitRevision;
        return !validRevision(revision) || revision > currentRevision;
      })) continue;
      // A future or unknown edit can change the page after the shell's
      // overview preflight. Keep the hold until the ledger has settled and a
      // current overview can be staged. An active gesture also retains its
      // own page generation until the interaction ends.
      if ([...this.#pending.values()].some(commit =>
        commit.pages.some(pageId => pageIds.has(pageId))) ||
          [...this.#gestures.values()].some(gesture =>
            gesture.pages.some(pageId => pageIds.has(pageId))) ||
          [...this.#committed.values()].some(commit =>
            commit.revision > currentRevision &&
            commit.pages.some(pageId => pageIds.has(pageId))) ||
          [...this.#compacted.entries()].some(([pageId, summary]) =>
            pageIds.has(pageId) && summary.maxRevision > currentRevision)) continue;
      plans.push({ pages, revision: currentRevision, dismissHoldIds: [...holdIds].sort() });
    }
    return plans;
  }

  dismissOffscreenHolds(plan) {
    const current = this.planOffscreenHolds(plan?.revision).find(candidate =>
      JSON.stringify(candidate) === JSON.stringify(plan));
    if (!current) return null;
    for (const id of current.dismissHoldIds) this.#holds.delete(id);
    this.#pruneHistory();
    return current;
  }

  applySwitch(plan) {
    const current = this.planSwitches().find(candidate =>
      JSON.stringify(candidate) === JSON.stringify(plan));
    if (!current) return null;
    for (const page of current.pages) this.generationShown(page);
    for (const id of current.dismissHoldIds) this.#holds.delete(id);
    this.#pruneHistory();
    return { pages: current.pages, dismissHoldIds: current.dismissHoldIds };
  }

  terminalPage(pageId, reason = 'page-unavailable') {
    const dismissHoldIds = [...this.#holds.values()].filter(hold =>
      hold.pages.includes(pageId)).map(hold => hold.id).sort();
    dismissHoldIds.forEach(id => this.#holds.delete(id));
    for (const [id, gesture] of this.#gestures) if (gesture.pages.includes(pageId)) this.#gestures.delete(id);
    this.#pages.delete(pageId);
    this.#historyFloor.delete(pageId);
    this.#compacted.delete(pageId);
    this.#pruneHistory();
    return { pageId, reason, dismissHoldIds };
  }

  clear() {
    this.#pages.clear(); this.#holds.clear(); this.#gestures.clear();
    this.#pending.clear(); this.#committed.clear(); this.#historyFloor.clear(); this.#compacted.clear();
  }
}
