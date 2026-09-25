import config from '../../site.config.mjs';
import { status } from '../lib/html.mjs';
import { renderMedia } from '../lib/media.mjs';

export function render({ media }) {
  return {
    current: 'pdf',
    path: '/pdf/',
    title: 'PDF editor — tested browser features',
    description: 'Tested PDF editing features in Fernwork today, known limitations, and the planned berg:work PDF desktop app.',
    body: `<header class="page-band">
      <div>
        <p class="kicker">${config.products.pdf}</p>
        <h1>${config.products.pdf}</h1>
        <p>Edit PDF content and pages. The editor works in Fernwork's browser build. The separate desktop application has not been started.</p>
      </div>
      ${status('Browser build: works', 'works')}
    </header>

    <section class="feature-section ruled-section" aria-labelledby="pdf-works-title">
      <div class="section-heading">
        <p class="kicker">Works in the current browser build</p>
        <h2 id="pdf-works-title">Workflows.</h2>
        <p>These editing workflows are covered by automated tests in the current browser build.</p>
      </div>
      <div class="feature-grid">
        <article><h3>Edit text in place</h3><p>Edit existing rich text. Mixed formatting survives undo, redo, export and reopen.</p></article>
        <article><h3>Organise pages</h3><p>Append, reorder, delete and rotate pages. Merge and split tools are also present.</p></article>
        <article><h3>Redact content</h3><p>Preview the affected content, redact a marked area, or find and redact every text match.</p></article>
        <article><h3>Sign documents</h3><p>Add visible signatures or use a certificate. Invalid credentials are rejected before export.</p></article>
        <article><h3>Recognise scanned text</h3><p>Run OCR and select the recognised text layer over a scanned page.</p></article>
        <article><h3>Forms and markup</h3><p>Fill form fields. Copy, highlight, underline and strike through text.</p></article>
        <article><h3>Page stamps</h3><p>Add watermarks and page numbers across rotated and cropped pages.</p></article>
        <article><h3>File operations</h3><p>Compress files, edit metadata, and encrypt or decrypt PDF documents.</p></article>
      </div>
      ${renderMedia(media.get('pdf-text-edit'))}
      ${renderMedia(media.get('pdf-page-organiser'))}
      ${renderMedia(media.get('pdf-redaction'))}
      ${renderMedia(media.get('pdf-sign-ocr'))}
    </section>

    <section class="limitations ruled-section" aria-labelledby="pdf-limits-title">
      <div class="section-heading">
        <p class="kicker">Known limitations</p>
        <h2 id="pdf-limits-title">Limitations.</h2>
        <p>These points remain open in the browser editor.</p>
      </div>
      <ul class="plain-list plain-list--compact">
        <li><strong>Text frames:</strong> narrowing a frame does not automatically fit its height. A word wider than the frame can break inside the word.</li>
        <li><strong>Paragraphs:</strong> some multiline source paragraphs still edit as separate line objects rather than one reflowing paragraph.</li>
        <li><strong>Phones:</strong> text can be small at fit-to-width because editing does not yet trigger an automatic zoom.</li>
        <li><strong>Placement:</strong> snapping is off by default while that product decision remains open.</li>
        <li><strong>Nested paths:</strong> a path inside a form object cannot be rotated alone; its group can be rotated.</li>
        <li><strong>Large files:</strong> opening and committing changes to very large scanned documents still has performance work remaining.</li>
        <li><strong>Toolbar:</strong> at some desktop widths, a few labels collapse to icons.</li>
      </ul>
    </section>

    <section class="planned-panel" aria-labelledby="pdf-desktop-title">
      <div>${status('Planned', 'planned')}<h2 id="pdf-desktop-title">Desktop app</h2></div>
      <div>
        <p>The planned desktop application will wrap the working editor and add native file opening and saving. The shell has not been started, and its first-release scope is not fixed.</p>
        <a class="button button--cream" href="/roadmap/">See the roadmap</a>
      </div>
    </section>
    ${renderMedia(media.get('pdf-workflow'))}`,
  };
}
