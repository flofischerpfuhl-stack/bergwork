import { status } from '../lib/html.mjs';

export function render() {
  return {
    current: 'roadmap',
    path: '/roadmap/',
    title: 'Roadmap',
    description: 'What works in the berg:work PDF and image editors today, what is being worked on and what comes later. No release dates are announced.',
    body: `<header class="page-band">
      <div><p class="kicker">Roadmap</p><h1>What's next.</h1><p>What works today, what is being worked on, and what comes later. There are no release dates yet.</p></div>
    </header>
    <section class="roadmap-product ruled-section" aria-labelledby="image-phases-title">
      <div class="section-heading section-heading--wide">
        <p class="kicker kicker--name">berg:work Image</p>
        <h2 id="image-phases-title">Image editor.</h2>
        <p>Built in five steps. The first two are done, the third is mostly in the <a href="/app/image/">web app</a> already.</p>
      </div>
      <ol class="phase-list">
        <li><div>${status('Done', 'works')}<span class="phase-index">00</span></div><div><h3>Groundwork</h3><p>The product's direction, measurements of the desktop app, the text and vector engine, and a test set of PSD files.</p></div></li>
        <li><div>${status('Done', 'works')}<span class="phase-index">01</span></div><div><h3>Foundation</h3><p>A separate editing engine, project format version 2, 16-bit colour, colour profiles, storage for very large documents, 27 blend modes, guides, locks, history and layer search.</p></div></li>
        <li><div>${status('In progress', 'progress')}<span class="phase-index">02</span></div><div><h3>Design toolkit</h3><p>Text, vectors, layer styles, embedded content, artboards, export, object selection, adjustments, live filters and swatches are in. Still open: better PSD import and speed with large files.</p></div></li>
        <li><div>${status('Planned', 'planned')}<span class="phase-index">03</span></div><div><h3>Production work</h3><p>Saving PSD, CMYK soft proof and export, RAW photos, generative fill on your computer, upscaling, mesh warp, perspective, straighten, liquify, brush presets, text on a path, batch export and recipes.</p></div></li>
        <li><div>${status('Later', 'owner')}<span class="phase-index">04</span></div><div><h3>Extensions</h3><p>A safe plug-in or scripting interface, recorded actions and linked copies – only after a careful design.</p></div></li>
      </ol>
    </section>

    <section class="roadmap-product roadmap-product--ink" aria-labelledby="pdf-roadmap-title">
      <div class="section-heading section-heading--wide">
        <p class="kicker kicker--name">berg:work PDF</p>
        <h2 id="pdf-roadmap-title">PDF editor.</h2>
        <p>The editor is public as a <a href="/app/pdf/">web app</a>; a desktop version is in testing.</p>
      </div>
      <div class="roadmap-columns">
        <article>${status('Works', 'works')}<h3>Web app</h3><p>Moving and retyping text, pictures and drawings, pages, redaction, signing, text recognition, forms, markup, stamps, smaller files, passwords and document details.</p></article>
        <article>${status('In progress', 'progress')}<h3>Editor</h3><p>Paragraphs that reflow as one block, automatic zoom while editing on phones, and faster opening and saving of very large scans.</p></article>
        <article>${status('In testing', 'progress')}<h3>Desktop app</h3><p>A Linux app with its own window, real open and save dialogs and PDFs opened from the file manager. Windows follows; what the first release contains is not fixed yet.</p></article>
      </div>
    </section>

    <section class="status-panel" aria-labelledby="roadmap-release-title">
      <div><p class="kicker">Desktop</p><h2 id="roadmap-release-title">Web apps today.</h2></div>
      <div><p>Both editors are public as web apps. Desktop apps for Linux and Windows come first; macOS is not planned for the first release because there is no Mac to test on.</p><a class="button button--red" href="/download/">Desktop status</a></div>
    </section>`,
  };
}
