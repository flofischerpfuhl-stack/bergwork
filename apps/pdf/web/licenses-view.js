// Settings → Licences: every component the app ships with its licence and full licence text.
// Data: licenses.json, generated at build time by scripts/collect-licenses.mjs.

let dialog = null;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** One entry; its licence texts are only rendered when it is opened (the full set is several MB). */
function entry(item) {
  const details = element('details', 'bw-licence-entry');
  const summary = element('summary');
  summary.append(
    element('span', 'bw-licence-name', `${item.name}${item.version ? ` ${item.version}` : ''}`),
    element('span', 'bw-licence-spdx', item.licence || ''),
  );
  details.append(summary);
  details.dataset.search = `${item.name} ${item.licence || ''}`.toLowerCase();
  details.addEventListener('toggle', () => {
    if (!details.open || details.dataset.rendered) return;
    details.dataset.rendered = 'true';
    if (item.url) {
      const link = element('a', 'bw-licence-link', item.url);
      link.href = item.url;
      link.target = '_blank';
      link.rel = 'noreferrer';
      details.append(link);
    }
    if (!item.texts?.length) {
      details.append(element('p', 'bw-licence-missing', 'This package ships no licence file; its licence is the SPDX expression above.'));
    }
    for (const text of item.texts || []) {
      details.append(element('div', 'bw-licence-file', text.file), element('pre', 'bw-licence-text', text.text));
    }
  });
  return details;
}

function section(title, items, note = '') {
  const wrapper = element('section', 'bw-licence-section');
  const heading = element('h3', null, title);
  if (note) heading.append(' ', element('span', 'bw-licence-note', note));
  wrapper.append(heading);
  for (const item of items) wrapper.append(entry(item));
  return wrapper;
}

async function build() {
  const root = element('div', 'bw-licences-backdrop');
  root.setAttribute('role', 'presentation');
  const box = element('section', 'bw-licences');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-label', 'Licences');
  const head = element('div', 'bw-licences-head');
  const close = element('button', 'bw-titlebar-button', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close licences');
  const search = element('input', 'bw-licences-search');
  search.type = 'search';
  search.placeholder = 'Find a component…';
  search.setAttribute('aria-label', 'Find a component');
  head.append(element('h2', null, 'Licences'), search, close);
  const body = element('div', 'bw-licences-body', 'Loading…');
  box.append(head, body);
  root.append(box);

  const hide = () => { root.hidden = true; };
  close.addEventListener('click', hide);
  root.addEventListener('mousedown', (event) => { if (event.target === root) hide(); });
  root.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.stopPropagation(); hide(); } });
  search.addEventListener('input', () => {
    const query = search.value.trim().toLowerCase();
    body.querySelectorAll('.bw-licence-entry').forEach((node) => {
      node.hidden = Boolean(query) && !node.dataset.search.includes(query);
    });
  });

  try {
    const data = await (await fetch('./licenses.json')).json();
    body.textContent = '';
    body.append(
      element('p', 'bw-licences-intro', `${data.app.name} and the ${data.editor.name} are source-available under the Business Source License 1.1. They include the components below; each is listed with its licence and the licence text it ships.`),
      section('berg:work PDF', [data.app]),
      section(data.editor.name, data.editor.components, `(Fernwork ${String(data.editor.commit || '').slice(0, 7)})`),
      section(`Native app: Rust crates (${data.rust.length})`, data.rust, data.generatedFor),
    );
  } catch (error) {
    body.textContent = `The licence list could not be loaded (${error.message}).`;
  }
  document.body.append(root);
  return root;
}

export async function showLicences() {
  if (!dialog) dialog = await build();
  dialog.hidden = false;
  dialog.querySelector('.bw-licences-search')?.focus();
}
