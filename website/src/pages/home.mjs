import config from '../../site.config.mjs';
import { productMark, status } from '../lib/html.mjs';
import { renderMedia } from '../lib/media.mjs';

export function render({ assets, media }) {
  return {
    current: 'home',
    path: '/',
    title: 'PDF and image editors for the desktop',
    description: 'berg:work PDF and berg:work Image run in the browser at bergwork.app; files stay on your device. Desktop builds for Linux are internal.',
    body: `<section class="hero" aria-labelledby="hero-title">
      <div class="hero-wordmark-wrap">
        <h1 class="hero-wordmark" id="hero-title"><span>berg:</span><span>work</span></h1>
      </div>
      <div class="hero-copy">
        <p class="sticker sticker--cream">Two editors, one for PDF documents and one for images. Both run in the browser today.</p>
        <p class="sticker sticker--red">No account · files stay on your device</p>
      </div>
      <a class="hero-link button button--cream" href="#products-title">Open an editor <span aria-hidden="true">↓</span></a>
    </section>

    <section class="intro-band ruled-section" aria-labelledby="products-title">
      <div class="section-heading section-heading--wide">
        <p class="kicker">Two applications</p>
        <h2 id="products-title">Two editors.</h2>
        <p>Different documents need separate tools. Both editors open in the browser at bergwork.app: you pick a file, it is read on your device, and saving writes it back to your device. Desktop builds for Linux exist internally and are not distributed yet.</p>
      </div>
      <div class="product-grid">
        <article class="product-card">
          ${status('Web app: works', 'works')}
          ${productMark(assets.markPdf)}
          <p class="product-name">${config.products.pdf}</p>
          <h3>Edit the contents and structure of PDF files.</h3>
          <p>Change existing text, organise pages, find and redact, sign, fill forms and recognise text in scans. PDFium, qpdf and Tesseract run as WebAssembly in the page.</p>
          <a class="button button--ink" href="/app/pdf/">Open berg:work PDF</a>
          <a class="text-link" href="/pdf/">What it does, with screenshots <span aria-hidden="true">→</span></a>
        </article>
        <article class="product-card product-card--ink">
          ${status('Web app: works', 'works')}
          ${productMark(assets.markImage)}
          <p class="product-name">${config.products.image}</p>
          <h3>Compose, retouch and export layered images.</h3>
          <p>Layers, masks, adjustment layers, text, vector tools, background removal on the device and one export dialog for five formats. Rendering runs on the GPU through WebGL 2.</p>
          <a class="button button--cream" href="/app/image/">Open berg:work Image</a>
          <a class="text-link" href="/image/">What it does, with screenshots <span aria-hidden="true">→</span></a>
        </article>
      </div>
    </section>

    <section class="feature-section ruled-section" aria-labelledby="recordings-title">
      <div class="section-heading section-heading--wide">
        <p class="kicker">Recorded in the web apps</p>
        <h2 id="recordings-title">Two takes.</h2>
        <p>Each recording is one continuous session in the published web app, with sample files made for this site. Waiting times are cut out; every step shown runs at its real speed.</p>
      </div>
      ${renderMedia(media.get('pdf-workflow'))}
      ${renderMedia(media.get('image-workflow'))}
    </section>

    <section class="commitments ruled-section" aria-labelledby="commitments-title">
      <div class="section-heading">
        <p class="kicker">Recorded product rules</p>
        <h2 id="commitments-title">Commitments.</h2>
        <p>These design constraints come from the image-editor product plan. Each one is labelled with its current status.</p>
      </div>
      <div class="commitment-grid">
        <article>${status('Measured', 'works')}<h3>Files stay local</h3><p>The web apps are static files. Their content policy allows network requests only to bergwork.app itself (and, for one optional image model, to Hugging Face); opening, editing and saving happen in the page. The desktop image build made no network connections in a five-minute Windows probe.</p></article>
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
        <p>The web apps are public. There are no desktop downloads yet, and no prices or licence terms have been announced. Desktop files will appear on the download page when they exist.</p>
        <a class="button button--red" href="/download/">Download status</a>
      </div>
    </section>`,
  };
}
