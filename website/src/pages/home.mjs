import config from '../../site.config.mjs';
import { productMark, status } from '../lib/html.mjs';

export function render({ assets }) {
  return {
    current: 'home',
    path: '/',
    title: 'PDF and image editors for the desktop',
    description: 'berg:work is preparing separate PDF and image editing applications for Linux and Windows. There are no public builds yet.',
    body: `<section class="hero" aria-labelledby="hero-title">
      <div class="hero-wordmark-wrap">
        <h1 class="hero-wordmark" id="hero-title"><span>berg:</span><span>work</span></h1>
      </div>
      <div class="hero-copy">
        <p class="sticker sticker--cream">Two desktop editors are in development: one for PDF documents and one for images.</p>
        <p class="sticker sticker--red">No public build yet</p>
      </div>
      <a class="hero-link button button--cream" href="/download/">Read the release status <span aria-hidden="true">→</span></a>
    </section>

    <section class="intro-band ruled-section" aria-labelledby="products-title">
      <div class="section-heading section-heading--wide">
        <p class="kicker">Two applications</p>
        <h2 id="products-title">Two editors.</h2>
        <p>Different documents need separate tools. The PDF features run today in Fernwork's browser build. The image editor has an internal desktop build. Neither is publicly distributed.</p>
      </div>
      <div class="product-grid">
        <article class="product-card">
          ${status('Browser features work', 'works')}
          ${productMark(assets.markPdf)}
          <p class="product-name">${config.products.pdf}</p>
          <h3>Edit the contents and structure of PDF files.</h3>
          <p>Change text, organise pages, redact content, sign documents and recognise text in scans. A separate desktop shell is planned.</p>
          <a class="text-link" href="/pdf/">PDF editor evidence <span aria-hidden="true">→</span></a>
        </article>
        <article class="product-card product-card--ink">
          ${status('Internal desktop build', 'progress')}
          ${productMark(assets.markImage)}
          <p class="product-name">${config.products.image}</p>
          <h3>Compose, retouch and export layered images.</h3>
          <p>Layers, masks, adjustment layers, text, vector tools, local subject selection and a single export flow work in the current internal build.</p>
          <a class="text-link" href="/image/">Image editor evidence <span aria-hidden="true">→</span></a>
        </article>
      </div>
    </section>

    <section class="commitments ruled-section" aria-labelledby="commitments-title">
      <div class="section-heading">
        <p class="kicker">Recorded product rules</p>
        <h2 id="commitments-title">Commitments.</h2>
        <p>These design constraints come from the image-editor product plan. Each one is labelled with its current status.</p>
      </div>
      <div class="commitment-grid">
        <article>${status('Rule + measured', 'works')}<h3>Works offline</h3><p>The current image shell opens and saves without a server. A five-minute Windows probe observed no network connections. The PDF browser build is client-side.</p></article>
        <article>${status('Owner rule', 'owner')}<h3>No account</h3><p>The product plan requires operation without an account or online licence check.</p></article>
        <article>${status('Owner decision', 'owner')}<h3>No telemetry</h3><p>Telemetry is excluded by the current owner decision.</p></article>
        <article>${status('Works internally', 'works')}<h3>Local AI models</h3><p>Subject selection and background removal run locally. Optional model downloads start only after an explicit action and are cached on the device.</p></article>
        <article>${status('Documented', 'works')}<h3>Open project format</h3><p>The image project is a versioned ZIP format with JSON and assets. Its format specification is in the product repository.</p></article>
        <article>${status('Rule; performance open', 'progress')}<h3>Linux first-class</h3><p>Linux and Windows are the first target platforms. One Linux brush-performance target is still open.</p></article>
      </div>
    </section>

    <section class="status-panel" aria-labelledby="current-status-title">
      <div>
        <p class="kicker">Current status</p>
        <h2 id="current-status-title">Release status.</h2>
      </div>
      <div>
        <p>There is nothing to download yet. No prices or licence terms have been announced. Public files will appear on the download page when they exist.</p>
        <a class="button button--red" href="/download/">Download status</a>
      </div>
    </section>`,
  };
}
