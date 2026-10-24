// A cross-page native text hold retains an honest outline and no optimistic
// destination DOM ink until the committed raster is shown. Each hold owns its
// own nodes, so concurrent holds can end in any order.
const heldAnnouncements = new WeakMap();

function acquireHeldAnnouncement(owner, status) {
  let state = heldAnnouncements.get(owner);
  if (!state) {
    const node = document.createElement('span');
    node.className = 'oo-pdf-mini-stat oo-pdf-drag-preview-status';
    node.setAttribute('role', 'status');
    node.setAttribute('data-pdf-held-status', 'true');
    owner.appendChild(node);
    state = { node, messages: new Map() };
    heldAnnouncements.set(owner, state);
  }
  const token = Symbol('held-text-status');
  state.messages.set(token, status);
  state.node.textContent = [...state.messages.values()].at(-1) || '';
  return () => {
    state.messages.delete(token);
    if (state.messages.size) {
      state.node.textContent = [...state.messages.values()].at(-1) || '';
    } else {
      state.node.remove();
      heldAnnouncements.delete(owner);
    }
  };
}

export function createHeldTextDestinationGuard(surface, pageId, sourceId, status) {
  if (!surface || !pageId || !sourceId) return null;
  const owner = surface.closest('.oo-pdf-viewport') || surface;
  const style = document.createElement('style');
  style.textContent = `.oo-pdf-sheet[data-page-id="${CSS.escape(pageId)}"] ` +
    `.oo-pdf-textbox[data-source-id="${CSS.escape(sourceId)}"] ` +
    ':is(.oo-pdf-text-inline,.oo-pdf-text-snapshot) { visibility: hidden !important; }';
  // The source TextItem can unmount when React re-parents it to the target
  // page. The viewport survives that change and can keep the announcement.
  owner.appendChild(style);
  const releaseAnnouncement = acquireHeldAnnouncement(owner, status);
  let destroyed = false;
  return { destroy() {
    if (destroyed) return;
    destroyed = true;
    style.remove();
    releaseAnnouncement();
  } };
}
