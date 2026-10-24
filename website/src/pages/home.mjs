import config from '../../site.config.mjs';
import { escapeHtml, productMark } from '../lib/html.mjs';
import { featureRow } from '../lib/media.mjs';

export function render({ assets, media }) {
  return {
    current: 'home',
    path: '/',
    fullTitle: 'berg:work — PDF and image editing in your browser',
    title: 'PDF and image editing in your browser',
    description: 'Two editors that run in your browser: change the text, pictures and drawings inside any PDF, and edit photos in layers. Files are opened and saved on your computer. Nothing is uploaded, no account.',
    body: `<section class="hero" aria-labelledby="hero-title">
      <div class="hero-wordmark-wrap">
        <h1 class="hero-wordmark" id="hero-title"><span>berg:</span><span>work</span></h1>
      </div>
      <div class="hero-copy">
        <p class="sticker sticker--cream">Edit PDFs and images right in your browser.</p>
        <p class="sticker sticker--red">Nothing uploaded · no account · no tracking</p>
      </div>
      <div class="hero-actions">
        <a class="button button--cream" href="/app/pdf/">Open the PDF editor</a>
        <a class="button button--red" href="/app/image/">Open the image editor</a>
        <p class="hero-sample">Or start with a sample: <a href="/app/pdf/?sample">a PDF</a> · <a href="/app/image/?sample">a photo</a></p>
      </div>
    </section>

    <section class="showcase ruled-section" aria-labelledby="pdf-show-title">
      <div class="section-heading">
        <p class="kicker kicker--name">${escapeHtml(config.products.pdf)}</p>
        <h2 id="pdf-show-title">Move anything.</h2>
      </div>
      ${featureRow(media.get('pdf-move'), 'A PDF you can rearrange', `<p>Every line of text, every picture and every drawing in a PDF is an object you can grab. Drag the heading somewhere else, pick up a drawing and turn it, retype a word in the document's own font. Then save a normal PDF.</p>
        <p>Pages, redaction, signatures and text recognition for scans are in there too.</p>`, {
        actions: `<p class="row-actions"><a class="button button--ink" href="/app/pdf/">Open the PDF editor</a> <a class="text-link" href="/pdf/">Everything it does <span aria-hidden="true">→</span></a></p>`,
      })}
    </section>

    <section class="showcase showcase--ink ruled-section" aria-labelledby="image-show-title">
      <div class="section-heading">
        <p class="kicker kicker--name">${escapeHtml(config.products.image)}</p>
        <h2 id="image-show-title">Layers that stay loose.</h2>
      </div>
      ${featureRow(media.get('image-move'), 'Cut out, place, adjust', `<p>Take a product out of its background on your own computer, drop it into a new scene, scale it, turn it and put text over it. Layers stay movable and adjustments stay editable, so nothing is final until you export.</p>`, {
        actions: `<p class="row-actions"><a class="button button--cream" href="/app/image/">Open the image editor</a> <a class="text-link" href="/image/">Everything it does <span aria-hidden="true">→</span></a></p>`,
      })}
    </section>

    <section class="commitments ruled-section" aria-labelledby="commitments-title">
      <div class="section-heading">
        <p class="kicker">How it works</p>
        <h2 id="commitments-title">Your files stay yours.</h2>
        <p>Both editors are web pages that do all their work on your computer.</p>
      </div>
      <div class="commitment-grid">
        <article><h3>Nothing is uploaded</h3><p>The editor reads your file in the browser and saves it back to your disk. bergwork.app only hands out the app itself; there is nowhere for your files to go.</p></article>
        <article><h3>No account</h3><p>Open the page and start. No sign-up, no login, no licence check.</p></article>
        <article><h3>No tracking</h3><p>No analytics, no cookies, no third-party scripts – on this site or in the editors.</p></article>
        <article><h3>AI on your machine</h3><p>Background removal and subject selection run on your computer. A larger model is downloaded only if you choose it.</p></article>
        <article><h3>An open format</h3><p>Image projects are a documented ZIP of JSON and image files, so your work never depends on this site.</p></article>
        <article><h3>Desktop apps coming</h3><p>Linux and Windows versions with the same editors are in development. <a href="/download/">Desktop status</a></p></article>
      </div>
    </section>

    <section class="maker-panel" aria-labelledby="maker-title">
      <div>
        <p class="kicker">Who makes this</p>
        <h2 id="maker-title">One person, in the Allgäu.</h2>
      </div>
      <div>
        <p>berg:work is built by Florian Fischer in Grünenbach, Germany – the same workshop that makes Himmel:CAD for land surveyors.</p>
        <p>Found a bug or missing something? Your message goes straight to the person who writes the code.</p>
        <a class="text-link" href="mailto:${escapeHtml(config.contactEmail)}">Send feedback <span aria-hidden="true">→</span></a>
      </div>
    </section>

    <section class="cta-band" aria-labelledby="cta-title">
      <h2 id="cta-title">Try it now.</h2>
      <p>Both editors open in a current desktop browser. Nothing to install.</p>
      <div class="cta-actions">
        <a class="button button--cream" href="/app/pdf/">${productMark(assets.markPdf, 'inline')}Open the PDF editor</a>
        <a class="button button--ink" href="/app/image/">${productMark(assets.markImage, 'inline')}Open the image editor</a>
      </div>
    </section>`,
  };
}
