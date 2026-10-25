import config from '../../site.config.mjs';
import { escapeHtml, productMark } from '../lib/html.mjs';
import { featureRow } from '../lib/media.mjs';

export function render({ assets, media }) {
  return {
    current: 'pdf',
    path: '/pdf/',
    og: 'ogPdf',
    title: 'PDF editor in your browser: move, retype, redact, sign',
    description: 'berg:work PDF changes what is already in a PDF: move and retype text, pictures and drawings, sort pages, redact for real, sign and make scans searchable. In your browser; nothing is uploaded.',
    body: `<header class="page-band">
      <div>
        ${productMark(assets.markPdf, 'large')}
        <p class="kicker kicker--name">${escapeHtml(config.products.pdf)}</p>
        <h1>Edit the PDF itself.</h1>
        <p>Not just notes on top: change the text, pictures and drawings that are already in the file, then save a normal PDF. It all happens in your browser, and the file never leaves your computer.</p>
        <p class="band-actions"><a class="button button--cream" href="/app/pdf/">Open the PDF editor</a> <a class="text-link" href="/app/pdf/?sample">Try it with a sample PDF <span aria-hidden="true">→</span></a></p>
      </div>
    </header>

    <section class="showcase ruled-section" aria-labelledby="pdf-move-title">
      <div class="section-heading">
        <p class="kicker">In the web app</p>
        <h2 id="pdf-move-title">Move anything.</h2>
      </div>
      ${featureRow(media.get('pdf-move'), 'Grab it, turn it, retype it', `<p>Switch to <strong>Edit PDF</strong> and every object on the page becomes yours: the heading moves, a drawing and its label move together and turn, and a double-click lets you type in the line itself.</p>
        <p>Undo is always one key away, and nothing changes in your file until you save.</p>`)}
    </section>

    <section class="feature-section ruled-section" aria-labelledby="pdf-features-title">
      <div class="section-heading">
        <p class="kicker">Tools</p>
        <h2 id="pdf-features-title">What you can do.</h2>
      </div>
      <div class="feature-rows">
        ${featureRow(media.get('pdf-text-edit'), 'Retype text in its own font', `<p>Click a line and change it. Font, size, style and colour come from the PDF, and mixed formatting survives undo, saving and reopening.</p>`)}
        ${featureRow(media.get('pdf-select-many'), 'Grab many things at once', `<p>Draw a box around a table and all twenty cells are selected. Move them together, group them or line them up.</p>`)}
        ${featureRow(media.get('pdf-precise'), 'Exact when it matters', `<p>Every object shows its position, size and angle. Type the numbers you need, align it to the page, turn it by 90° or edit the points of a path.</p>`)}
        ${featureRow(media.get('pdf-insert'), 'Add what is missing', `<p>Put new text, images, rectangles, ellipses, arrows, freehand lines, comments or a visible signature on any page.</p>`)}
        ${featureRow(media.get('pdf-pages'), 'Sort the pages', `<p>Drag pages into order, duplicate, delete or rotate them, add pages, or save a range of pages as its own PDF.</p>`)}
        ${featureRow([media.get('pdf-redaction-find'), media.get('pdf-redaction')], 'Black out names – for real', `<p>Search for a name, check every match in context and mark them all at once. When you save, the characters are deleted from the file, not just hidden under a black box.</p>`)}
        ${featureRow(media.get('pdf-sign'), 'Sign it', `<p>Draw, type or insert your signature and place it on the page, or sign with a certificate. Signing happens on your computer.</p>`)}
        ${featureRow(media.get('pdf-ocr'), 'Make scans searchable', `<p>Text recognition runs in your browser – about two to four seconds for a page like this – and adds a text layer you can search and copy.</p>`)}
        ${featureRow(media.get('pdf-tools'), 'And the rest of the toolbox', `<p>Bookmarks, page numbers, watermarks, form fields, document details, smaller files, password protection, comparing two versions and batch jobs.</p>`)}
      </div>
    </section>

    <section class="evidence-strip" aria-labelledby="pdf-measured-title">
      <div class="section-heading">
        <p class="kicker">Measured on 24 October 2026, laptop, empty cache</p>
        <h2 id="pdf-measured-title">Light, and local.</h2>
      </div>
      <div class="evidence-grid">
        <article><p class="big-number">1 MB</p><h3>To get started</h3><p>That is all your browser downloads before you can open a PDF – ready in about two seconds. The PDF engine and text recognition load only when a document needs them.</p></article>
        <article><p class="big-number">2–4 s</p><h3>Per scanned page</h3><p>Text recognition of the sample scan above took 2.4 and 3.6 seconds, on the laptop itself.</p></article>
        <article><p class="big-number">0</p><h3>Places your file goes</h3><p>The editor may only talk to bergwork.app, which serves the app and accepts nothing. Opening, editing and saving the sample made 25 requests, all of them for the app's own files.</p></article>
      </div>
    </section>

    <section class="limitations ruled-section" aria-labelledby="pdf-limits-title">
      <div class="section-heading">
        <p class="kicker">Honest notes</p>
        <h2 id="pdf-limits-title">Good to know.</h2>
      </div>
      <ul class="plain-list plain-list--compact">
        <li><strong>Long paragraphs:</strong> some paragraphs edit line by line instead of flowing as one block.</li>
        <li><strong>Narrow text boxes:</strong> a box does not grow taller by itself when you make it narrower.</li>
        <li><strong>Phones:</strong> it works, but editing text on a small screen is fiddly; it does not zoom in for you yet.</li>
        <li><strong>Huge scans:</strong> opening and saving very large scanned documents is still slow.</li>
      </ul>
    </section>

    <section class="planned-panel" aria-labelledby="pdf-desktop-title">
      <div><p class="kicker">Coming later</p><h2 id="pdf-desktop-title">Desktop app.</h2></div>
      <div>
        <p>A desktop version for Linux is in testing: its own window, real open and save dialogs, PDFs opened straight from the file manager. Windows follows. It is not public yet.</p>
        <a class="button button--cream" href="/download/">Desktop status</a>
      </div>
    </section>

    <section class="cta-band" aria-labelledby="pdf-cta-title">
      <h2 id="pdf-cta-title">Open a PDF.</h2>
      <p>Nothing to install, nothing uploaded.</p>
      <div class="cta-actions">
        <a class="button button--cream" href="/app/pdf/">Open the PDF editor</a>
        <a class="button button--ink" href="/app/pdf/?sample">Try the sample</a>
      </div>
    </section>`,
  };
}
