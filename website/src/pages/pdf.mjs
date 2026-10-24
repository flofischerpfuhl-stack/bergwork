import config from '../../site.config.mjs';
import { productMark, status } from '../lib/html.mjs';
import { renderMedia } from '../lib/media.mjs';

export function render({ assets, media }) {
  return {
    current: 'pdf',
    path: '/pdf/',
    title: 'PDF editor — web app, tested features and limits',
    description: 'berg:work PDF in the browser: edit text, organise pages, redact, OCR and sign, with screenshots and a recording from the published web app, known limits and the internal desktop build.',
    body: `<header class="page-band">
      <div>
        ${productMark(assets.markPdf, 'large')}
        <p class="kicker">${config.products.pdf}</p>
        <h1>${config.products.pdf}</h1>
        <p>Edit PDF content and pages in the browser: files are opened and saved on your device, nothing is uploaded. A desktop build for Linux exists internally and is not distributed yet.</p>
        <a class="button button--ink" href="/app/pdf/">Open berg:work PDF in the browser</a>
      </div>
      ${status('Web app: works', 'works')}
    </header>

    <section class="feature-section ruled-section" aria-labelledby="pdf-works-title">
      <div class="section-heading">
        <p class="kicker">Works in the current browser build</p>
        <h2 id="pdf-works-title">Workflows.</h2>
        <p>These editing workflows are covered by automated tests of the editor. The pictures below are screenshots of the published web app with this site's sample files.</p>
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
      ${renderMedia(media.get('pdf-ocr'))}
    </section>

    <section class="evidence-strip" aria-labelledby="pdf-measured-title">
      <div class="section-heading">
        <p class="kicker">Measured on 24 October 2026</p>
        <h2 id="pdf-measured-title">Measured.</h2>
        <p>Headless Chromium on a laptop, empty cache, the published web app. The numbers are single runs, not averages.</p>
      </div>
      <div class="evidence-grid">
        <article><p class="big-number">1.0 MB</p><h3>Until the editor is ready</h3><p>Transferred on a first visit before a PDF can be opened, ready after about 2 seconds. PDFium and the OCR engine load when a document needs them.</p></article>
        <article><p class="big-number">2–4 s</p><h3>OCR of a scanned page</h3><p>Tesseract recognised the sample scan above in 2.4 and 3.6 seconds on the device. Nothing is sent anywhere.</p></article>
        <article><p class="big-number">0</p><h3>Upload endpoints</h3><p>The page may only make requests to bergwork.app, which serves static files and accepts none. In a session that opened, edited and saved the sample PDF, all 25 requests were GETs for the app's own files.</p></article>
      </div>
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
      <div>${status('Internal build', 'progress')}<h2 id="pdf-desktop-title">Desktop app</h2></div>
      <div>
        <p>The same editor runs in a desktop app for Linux (Tauri 2): its own window, native open and save dialogs, PDFs opened from the file manager. It is an internal build; Windows packaging is configured but not built yet, and the first-release scope is not fixed.</p>
        <a class="button button--cream" href="/roadmap/">See the roadmap</a>
      </div>
    </section>
    ${renderMedia(media.get('pdf-workflow'))}`,
  };
}
