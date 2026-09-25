import config from '../../site.config.mjs';
import { escapeHtml, status } from '../lib/html.mjs';

function markdownLite(value = '') {
  const lines = String(value).trim().split(/\r?\n/);
  const output = [];
  let list = [];
  const inline = (text) => escapeHtml(text).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  const flushList = () => {
    if (list.length) output.push(`<ul>${list.map((item) => `<li>${inline(item)}</li>`).join('')}</ul>`);
    list = [];
  };
  for (const line of lines) {
    if (line.startsWith('- ')) { list.push(line.slice(2)); continue; }
    flushList();
    if (line.trim()) output.push(`<p>${inline(line.trim())}</p>`);
  }
  flushList();
  return output.join('');
}

function noRelease(product, text) {
  const subject = encodeURIComponent(`${product} public build notification`);
  return `<article class="download-card">
    ${status('No public build yet', 'progress')}
    <h2>${escapeHtml(product)}</h2>
    <p>${escapeHtml(text)}</p>
    <dl class="platform-list">
      <div><dt>Linux</dt><dd>Planned for the first release</dd></div>
      <div><dt>Windows</dt><dd>Planned for the first release</dd></div>
      <div><dt>macOS</dt><dd>Not planned for the first release; no test device</dd></div>
    </dl>
    <a class="text-link" href="mailto:${escapeHtml(config.contactEmail)}?subject=${subject}">Ask to be notified <span aria-hidden="true">→</span></a>
  </article>`;
}

function releaseCard(product, releases) {
  const release = releases[0];
  const rows = release.files.map((file) => `<tr data-download-row="${escapeHtml(file.os)}"><td>${escapeHtml(file.os)}</td><td>${escapeHtml(file.arch)}</td><td>${escapeHtml(file.kind)}</td><td>${escapeHtml(file.size)}</td><td><code>${escapeHtml(file.sha256)}</code> <button class="copy-button" type="button" data-copy="${escapeHtml(file.sha256)}">Copy</button></td><td>${file.signature ? `<a href="${escapeHtml(file.signature)}">Signature</a>` : '—'}</td><td><a href="${escapeHtml(file.url)}">Download</a></td></tr>`).join('');
  const primary = release.files.map((file) => `<a class="button button--red os-primary" data-os="${escapeHtml(file.os)}" href="${escapeHtml(file.url)}">Download for ${escapeHtml(file.os)} (${escapeHtml(file.kind)})</a>`).join('');
  return `<article class="download-card download-card--release"><h2>${escapeHtml(product)} ${escapeHtml(release.version)}</h2><p>${escapeHtml(release.channel)} · ${escapeHtml(release.date)}</p><div class="detected-downloads">${primary}</div><div class="table-wrap"><table><thead><tr><th>OS</th><th>Architecture</th><th>File</th><th>Size</th><th>SHA-256</th><th>Signature</th><th></th></tr></thead><tbody>${rows}</tbody></table></div><h3>Requirements</h3><dl>${Object.entries(release.requirements || {}).map(([key, value]) => `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl><h3>Verify a download</h3><p>Compute the file's SHA-256 digest and compare every character with the value in the table. Where a signature is listed, verify it with the published signing key before running the installer.</p><div class="release-notes"><h3>Release notes</h3>${markdownLite(release.notes || '')}</div></article>`;
}

export function render({ releases }) {
  const pdfReleases = releases.products.pdf;
  const imageReleases = releases.products.image;
  return {
    current: 'download',
    path: '/download/',
    title: 'Download status',
    description: 'There are no public berg:work builds yet. Linux and Windows are planned first.',
    body: `<header class="page-band page-band--red"><div><p class="kicker">Release status</p><h1>Downloads.</h1><p>There is no public download yet. There are no prices or announced release dates.</p></div></header>
    <section class="download-section ruled-section" aria-label="Product release status">
      ${pdfReleases.length ? releaseCard(config.products.pdf, pdfReleases) : noRelease(config.products.pdf, 'The first release is planned to put the working browser PDF editor in a desktop app with native file opening and saving. Its final scope is not fixed.')}
      ${imageReleases.length ? releaseCard(config.products.image, imageReleases) : noRelease(config.products.image, 'The first release is planned as a Linux and Windows desktop app based on the current internal build. Its final scope is not fixed.')}
    </section>`,
  };
}
