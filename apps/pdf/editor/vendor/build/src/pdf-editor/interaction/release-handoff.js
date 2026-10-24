// A release owns its preview until both the native transaction and the visible
// raster have caught up. The caller supplies the browser's next-paint boundary.
export class ReleaseHandoff {
  #holds = new Map();
  #coverage = new Map();
  #afterPaint;

  constructor({ afterPaint = callback => requestAnimationFrame(callback) } = {}) {
    this.#afterPaint = afterPaint;
  }

  begin(key, pages, dismiss, { autoPaint = true } = {}) {
    this.#holds.get(key)?.end('successor');
    const hold = {
      key,
      pages: new Set(pages.filter(Boolean)),
      revision: null,
      done: false,
      scheduled: false,
      end: reason => {
        if (hold.done) return;
        hold.done = true;
        if (this.#holds.get(key) === hold) this.#holds.delete(key);
        dismiss(reason);
      },
    };
    this.#holds.set(key, hold);
    const check = () => {
      if (!autoPaint || hold.done || hold.scheduled || hold.revision == null) return;
      if (![...hold.pages].every(page => {
        const coverage = this.#coverage.get(page);
        return coverage && (coverage.required
          ? coverage.covered && coverage.revision >= hold.revision
          : coverage.shownRevision >= hold.revision);
      })) return;
      hold.scheduled = true;
      this.#afterPaint(() => {
        hold.scheduled = false;
        if (!hold.done && hold.revision != null && [...hold.pages].every(page => {
          const coverage = this.#coverage.get(page);
          return coverage && (coverage.required
            ? coverage.covered && coverage.revision >= hold.revision
            : coverage.shownRevision >= hold.revision);
        })) hold.end('painted');
      });
    };
    hold.check = check;
    return Object.freeze({
      commit: revision => {
        if (Number.isSafeInteger(revision) && revision >= 0) {
          hold.revision = revision;
          check();
        } else hold.end('invalid-revision');
      },
      reject: () => hold.end('rejected'),
      end: reason => hold.end(reason),
    });
  }

  coverage(page, state) {
    this.#coverage.set(page, state);
    for (const hold of this.#holds.values()) if (hold.pages.has(page)) hold.check();
  }

  terminal(page, reason) {
    this.#coverage.delete(page);
    for (const hold of [...this.#holds.values()]) if (hold.pages.has(page)) hold.end(reason);
  }

  clear(reason = 'session-replaced') {
    for (const hold of [...this.#holds.values()]) hold.end(reason);
    this.#coverage.clear();
  }
}
