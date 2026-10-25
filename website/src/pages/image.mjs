import config from '../../site.config.mjs';
import { escapeHtml, productMark } from '../lib/html.mjs';
import { featureRow } from '../lib/media.mjs';

export function render({ assets, media }) {
  return {
    current: 'image',
    path: '/image/',
    og: 'ogImage',
    title: 'Layered image editor in your browser',
    description: 'berg:work Image is a layered image editor in your browser: cut-outs on your own computer, masks, adjustment layers, text, vector shapes, layer styles and one export dialog. Your photos are not uploaded.',
    body: `<header class="page-band page-band--red">
      <div>
        ${productMark(assets.markImage, 'large')}
        <p class="kicker kicker--name">${escapeHtml(config.products.image)}</p>
        <h1>Layers, in your browser.</h1>
        <p>Cut out, compose, retouch and export layered images without installing anything. Your photos are opened and saved on your computer; nothing is uploaded.</p>
        <p class="band-actions"><a class="button button--ink" href="/app/image/">Open the image editor</a> <a class="text-link" href="/app/image/?sample">Try it with a sample photo <span aria-hidden="true">→</span></a></p>
      </div>
    </header>

    <section class="showcase ruled-section" aria-labelledby="image-move-title">
      <div class="section-heading">
        <p class="kicker">In the web app</p>
        <h2 id="image-move-title">Everything stays movable.</h2>
      </div>
      ${featureRow(media.get('image-move'), 'From photo to poster in one go', `<p>Remove the background, put the photo on a new scene, scale it, turn it, add a title with a shadow and warm it all up with Curves. Every step is a layer you can still move, hide or change later.</p>`)}
    </section>

    <section class="feature-section ruled-section" aria-labelledby="image-features-title">
      <div class="section-heading">
        <p class="kicker">Tools</p>
        <h2 id="image-features-title">What you can do.</h2>
      </div>
      <div class="feature-rows">
        ${featureRow(media.get('image-cutout'), 'Cut-outs on your computer', `<p>Remove a background with one command. The model runs in your browser, and the result is a layer mask: the original pixels stay, and you can paint the edge back in.</p>`)}
        ${featureRow(media.get('image-transform'), 'Move, scale, turn', `<p>Drag a layer's handles to scale and turn it, or type exact position, size and angle. Flip and distort are right there too.</p>`)}
        ${featureRow(media.get('image-layers'), 'Real layers', `<p>Groups, pixel and vector masks, clipping masks, opacity and fill, locks, colour labels, 27 blend modes and a search for when the list gets long.</p>`)}
        ${featureRow(media.get('image-curves'), 'Adjustments you can change later', `<p>Curves, levels, hue and saturation, exposure, gradient maps and more sit on their own layers above the photo. Double-click to change them again at any time.</p>`)}
        ${featureRow(media.get('image-text'), 'Type that stays type', `<p>Point and area text with full typography and OpenType features, editable on the canvas until the very end.</p>`)}
        ${featureRow(media.get('image-shapes'), 'Shapes and paths', `<p>Draw with the pen, then pull any point and its curve handles into place. Parametric shapes, Boolean operations and vector masks stay sharp at every size.</p>`)}
        ${featureRow(media.get('image-styles'), 'Layer styles', `<p>Drop shadow, stroke, outer glow, colour and gradient overlay, live on text, shapes and pictures.</p>`)}
        ${featureRow(media.get('image-selection'), 'Precise selections', `<p>Pick a colour range – here the whole sky in one click – or use rectangle, ellipse, lasso, magic wand and quick mask, with feather and refine edge.</p>`)}
        ${featureRow(media.get('image-export'), 'One export dialog', `<p>PNG, JPEG, WebP, AVIF or TIFF, with a preview and the file size before anything is written. Export whole documents, artboards or single layers at 1×, 2× and 3×.</p>`)}
      </div>
      <p class="also-line"><strong>Also in the box:</strong> brush and eraser with pen pressure, healing, clone stamp, content-aware fill, dodge and burn, live filters (blur, noise, sharpen, lens correction, denoise), artboards, and import of PNG, JPEG, TIFF, HEIC, WebP, AVIF and GIF with colour profiles.</p>
    </section>

    <section class="evidence-strip" aria-labelledby="measured-title">
      <div class="section-heading">
        <p class="kicker">Measured</p>
        <h2 id="measured-title">Made for big files.</h2>
      </div>
      <div class="evidence-grid">
        <article><p class="big-number">200 MP</p><h3>Documents</h3><p>A 20-layer document of 200 megapixels was saved, reopened and checked pixel by pixel – in the browser and in the desktop build.</p></article>
        <article><p class="big-number">0.9 MB</p><h3>To get started</h3><p>What your browser downloads before the editor is ready, usable after one to two seconds (24 October 2026, laptop, empty cache).</p></article>
        <article><p class="big-number">16-bit</p><h3>Colour depth</h3><p>Documents can work in 16 bits per channel, and tagged PNG, JPEG and TIFF files are converted with their colour profiles.</p></article>
      </div>
    </section>

    <section class="limitations ruled-section" aria-labelledby="image-limits-title">
      <div class="section-heading">
        <p class="kicker">Honest notes</p>
        <h2 id="image-limits-title">Good to know.</h2>
      </div>
      <ul class="plain-list plain-list--compact">
        <li><strong>PSD files:</strong> they open with their layers, but not every effect comes across yet. Saving as PSD is planned.</li>
        <li><strong>Object selection:</strong> clicking an object to select it works, but takes 14 to 22 seconds for now.</li>
        <li><strong>Not yet:</strong> RAW photos, CMYK print output and generative fill are planned, not built.</li>
        <li><strong>Phones:</strong> the editor runs on a phone, but it is made for a mouse or pen and a bigger screen.</li>
      </ul>
    </section>

    <section class="non-goals" aria-labelledby="non-goals-title">
      <div class="section-heading">
        <p class="kicker">To stay focused</p>
        <h2 id="non-goals-title">What it won't do.</h2>
      </div>
      <ul class="tag-list">
        <li>3D</li><li>Video or timelines</li><li>Animation</li><li>Slicing for web layouts</li><li>Cloud collaboration</li><li>A stock or template shop</li><li>A plug-in marketplace</li><li>Other editors' plug-ins</li><li>Pixel-identical results to other editors</li><li>Print separations</li>
      </ul>
      <p class="also-line also-line--center"><a class="text-link" href="/roadmap/">What is planned next <span aria-hidden="true">→</span></a></p>
    </section>

    <section class="cta-band cta-band--ink" aria-labelledby="image-cta-title">
      <h2 id="image-cta-title">Open a photo.</h2>
      <p>Nothing to install, nothing uploaded.</p>
      <div class="cta-actions">
        <a class="button button--red" href="/app/image/">Open the image editor</a>
        <a class="button button--cream" href="/app/image/?sample">Try the sample</a>
      </div>
    </section>`,
  };
}
