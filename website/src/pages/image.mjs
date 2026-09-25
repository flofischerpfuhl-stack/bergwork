import config from '../../site.config.mjs';
import { productMark, status } from '../lib/html.mjs';
import { renderMedia } from '../lib/media.mjs';

export function render({ assets, media }) {
  return {
    current: 'image',
    path: '/image/',
    title: 'Image editor — current internal build',
    description: 'What works in the current internal berg:work Image build, the measured gaps, roadmap phases and explicit non-goals.',
    body: `<header class="page-band page-band--red">
      <div>
        ${productMark(assets.markImage, 'large')}
        <p class="kicker">${config.products.image}</p>
        <h1>${config.products.image}</h1>
        <p>Layered image editing in an internal desktop build. The desktop app builds for Linux and Windows. It is not publicly distributed.</p>
      </div>
      ${status('Internal build', 'progress')}
    </header>

    <section class="feature-section ruled-section" aria-labelledby="image-works-title">
      <div class="section-heading">
        <p class="kicker">Works in the current internal build</p>
        <h2 id="image-works-title">Current build.</h2>
        <p>These features have test evidence in the current internal build.</p>
      </div>
      <div class="feature-grid feature-grid--dense">
        <article><h3>Layers and masks</h3><p>Groups, pixel and vector masks, clipping masks, opacity and fill opacity, locks, colour labels and layer search.</p></article>
        <article><h3>Selections</h3><p>Rectangle, ellipse, lasso, polygon, magic wand, colour range, quick mask, feather and refine edge.</p></article>
        <article><h3>Paint and retouch</h3><p>Pressure-aware brush and eraser, spot healing, clone stamp, content-aware fill, smudge, dodge, burn and sponge.</p></article>
        <article><h3>Adjustments</h3><p>Curves, levels, hue/saturation, exposure, gradient map, grain, a Basic adjustment group and colour lookup.</p></article>
        <article><h3>Filters</h3><p>Live filter stacks with blur, motion blur, noise, lens correction, sharpen, high pass and denoise.</p></article>
        <article><h3>Text and vector</h3><p>Point and area text, typography and OpenType; parametric shapes, pen editing, Boolean operations and vector masks.</p></article>
        <article><h3>Layer styles</h3><p>Drop shadow, stroke, outer glow, colour overlay and gradient overlay.</p></article>
        <article><h3>Blend modes</h3><p>All 27 planned blend modes are implemented; 26 are deterministic and dissolve follows its binary-alpha rule.</p></article>
        <article><h3>Import</h3><p>PNG, JPEG, TIFF, HEIC, WebP, AVIF and GIF. Tagged PNG, JPEG and TIFF files use ICC conversion.</p></article>
        <article><h3>Export</h3><p>One export flow for PNG, JPEG, WebP, AVIF and TIFF, including per-artboard or per-layer output at 1×, 2× and 3×.</p></article>
      </div>
      ${renderMedia(media.get('image-layers-masks'))}
      ${renderMedia(media.get('image-adjustment-layers'))}
      ${renderMedia(media.get('image-background-removal'))}
    </section>

    <section class="evidence-strip" aria-labelledby="measured-title">
      <div class="section-heading">
        <p class="kicker">Measured, with limits</p>
        <h2 id="measured-title">Measured limits.</h2>
        <p>Large documents and local models work with the limits stated below.</p>
      </div>
      <div class="evidence-grid">
        <article><p class="big-number">200 MP</p><h3>20-layer workflow completed</h3><p>The save, reopen and pixel checks completed in Chromium and the Linux desktop build. Latency targets at this size remain open.</p></article>
        <article><p class="big-number">67%</p><h3>Native PSD fidelity</h3><p>PSD reading is partial and below the 90% Phase 2 target. PSD writing is planned for Phase 3.</p></article>
        <article><p class="big-number">14–22 s</p><h3>Object-selection time</h3><p>Local object selection works, but its current processing step is slow.</p></article>
      </div>
      ${renderMedia(media.get('image-large-document'))}
    </section>

    <section class="phase-summary ruled-section" aria-labelledby="image-roadmap-title">
      <div class="section-heading">
        <p class="kicker">Roadmap status</p>
        <h2 id="image-roadmap-title">Roadmap.</h2>
        <p>Phase 2 features are present, but its completion target is still open.</p>
      </div>
      <ol class="phase-list phase-list--compact">
        <li>${status('Complete', 'works')}<strong>Phase 0</strong><span>Product split, desktop shell measurements, text-engine and PSD-corpus spikes.</span></li>
        <li>${status('Complete', 'works')}<strong>Phase 1</strong><span>Document/format v2, 16-bit colour, large-document storage, 27 blend modes, guides and layer controls.</span></li>
        <li>${status('In progress', 'progress')}<strong>Phase 2</strong><span>Design features are implemented, but PSD fidelity and performance work remains open.</span></li>
        <li>${status('Planned', 'planned')}<strong>Phase 3</strong><span>PSD writing, RAW, colour-managed print output, local generative fill and remaining transform/automation work.</span></li>
        <li>${status('Design decision later', 'owner')}<strong>Phase 4</strong><span>A versioned scripting or plug-in interface, recorded actions and linked instances.</span></li>
      </ol>
      <a class="button button--ink" href="/roadmap/">Full roadmap</a>
    </section>

    <section class="non-goals" aria-labelledby="non-goals-title">
      <div class="section-heading">
        <p class="kicker">What we will not build</p>
        <h2 id="non-goals-title">Scope.</h2>
        <p>These explicit exclusions are recorded in the product plan.</p>
      </div>
      <ul class="tag-list">
        <li>3D</li><li>Video or timeline editing</li><li>Animation</li><li>Image-slicing tools</li><li>Cloud collaboration</li><li>Stock or template marketplace</li><li>Scripting ecosystem</li><li>Third-party plug-in compatibility</li><li>Pixel-for-pixel compatibility with other editors</li><li>Print separations and overprint workflows</li>
      </ul>
    </section>
    ${renderMedia(media.get('image-workflow'))}`,
  };
}
