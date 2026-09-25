import { status } from '../lib/html.mjs';

export function render() {
  return {
    current: 'roadmap',
    path: '/roadmap/',
    title: 'Roadmap and current status',
    description: 'Current, evidence-backed roadmap status for the berg:work PDF and image editors. No release dates are announced.',
    body: `<header class="page-band">
      <div><p class="kicker">Products</p><h1>Roadmap.</h1><p>What is implemented, what remains open and what is planned. No release dates have been announced.</p></div>
    </header>
    <section class="roadmap-product ruled-section" aria-labelledby="image-phases-title">
      <div class="section-heading section-heading--wide">
        <p class="kicker">Image editor</p>
        <h2 id="image-phases-title">Image editor.</h2>
        <p>The product plan has five phases. Phase 2 features are implemented in the current internal build, but its PSD-fidelity target and some performance work remain open.</p>
      </div>
      <ol class="phase-list">
        <li><div>${status('Complete', 'works')}<span class="phase-index">00</span></div><div><h3>Set the direction</h3><p>Choose the product identity, measure the desktop apps, verify the text/vector engine, measure PSD fidelity and create tests for core workflows.</p></div></li>
        <li><div>${status('Complete', 'works')}<span class="phase-index">01</span></div><div><h3>Foundation</h3><p>Separate the editing engine from the desktop app, add project format v2, 16-bit colour, ICC handling, storage for large documents, all 27 blend modes, guides, locks, history and layer search.</p></div></li>
        <li><div>${status('In progress', 'progress')}<span class="phase-index">02</span></div><div><h3>Design core</h3><p>Text, vectors, layer styles, embedded content, artboards, export, object selection, adjustments, live filters and swatches are in the build. PSD import is at 67% native fidelity, below the 90% completion target.</p></div></li>
        <li><div>${status('Planned', 'planned')}<span class="phase-index">03</span></div><div><h3>Remaining production work</h3><p>PSD writing, CMYK soft proof and export, RAW, local generative fill, upscaling, mesh warp, perspective, straighten, light liquify, brush presets, text on path, batch export and recipes.</p></div></li>
        <li><div>${status('Decision later', 'owner')}<span class="phase-index">04</span></div><div><h3>Open design decisions</h3><p>A versioned and sandboxed plug-in or scripting interface, recorded actions and linked instances are considered only after a design decision.</p></div></li>
      </ol>
    </section>

    <section class="roadmap-product roadmap-product--ink" aria-labelledby="pdf-roadmap-title">
      <div class="section-heading section-heading--wide">
        <p class="kicker">PDF editor</p>
        <h2 id="pdf-roadmap-title">PDF editor.</h2>
        <p>The browser editor works. Its separate desktop application is planned.</p>
      </div>
      <div class="roadmap-columns">
        <article>${status('Works', 'works')}<h3>Browser editor</h3><p>Text editing, page organisation, redaction, signing, OCR, forms, text markup, stamps, compression, security and metadata tools have implementation or test evidence.</p></article>
        <article>${status('Open', 'progress')}<h3>Editor work</h3><p>Paragraph-wide reflow, automatic mobile editing zoom, default snapping, some responsive toolbar labels, nested-path rotation and large-file performance remain open.</p></article>
        <article>${status('Planned', 'planned')}<h3>Desktop shell</h3><p>Wrap the working editor as a separate application and add native open/save integration. The shell has not started and its release scope is not fixed.</p></article>
      </div>
    </section>

    <section class="status-panel">
      <div><p class="kicker">Release status</p><h2>No public builds.</h2></div>
      <div><p>Linux and Windows are planned first. macOS is not planned for the first release because there is no test device.</p><a class="button button--red" href="/download/">Download status</a></div>
    </section>`,
  };
}
