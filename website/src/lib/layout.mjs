import config from '../../site.config.mjs';
import { escapeHtml } from './html.mjs';

const nav = [
  ['pdf', '/pdf/', 'PDF'],
  ['image', '/image/', 'Image'],
  ['roadmap', '/roadmap/', 'Roadmap'],
  ['download', '/download/', 'Desktop'],
];

function structuredData() {
  const app = (name, path, category, description) => ({
    '@type': 'WebApplication',
    name,
    applicationCategory: category,
    operatingSystem: 'Any (runs in a web browser)',
    browserRequirements: 'Requires a current browser with WebAssembly',
    description,
    ...(config.siteUrl ? { url: new URL(path, config.siteUrl).href } : {}),
  });
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        name: config.siteName,
        email: config.contactEmail,
        founder: { '@type': 'Person', name: 'Florian Fischer' },
        ...(config.siteUrl ? { url: config.siteUrl } : {}),
      },
      app(config.products.pdf, '/app/pdf/', 'ProductivityApplication', 'Edit existing PDFs in the browser: move and retype text, images and drawings, sort pages, redact, sign and run OCR. Files are not uploaded.'),
      app(config.products.image, '/app/image/', 'GraphicsApplication', 'A layered image editor in the browser with masks, adjustment layers, text, vector shapes and background removal on the device. Files are not uploaded.'),
    ],
  };
}

function header(current, home = false) {
  // A closed <details> never renders its content, so the wide layout gets its own nav outside the menu.
  const links = nav.map(([key, href, label]) => `<a href="${href}"${current === key ? ' aria-current="page"' : ''}>${label}</a>`).join('');
  return `<header class="site-header${home ? ' site-header--hero' : ''}">
    <div class="header-inner">
      <a class="header-wordmark" href="/"${current === 'home' ? ' aria-current="page"' : ''}>berg:work</a>
      <nav class="nav-menu nav-wide" aria-label="Primary navigation">
        ${links}
      </nav>
      <details class="nav-menu nav-narrow">
        <summary><span aria-hidden="true">+</span> Menu</summary>
        <nav aria-label="Primary navigation (menu)">
          ${links}
        </nav>
      </details>
    </div>
  </header>`;
}

function footer() {
  return `<footer class="site-footer">
    <div class="footer-grid">
      <div>
        <a class="footer-wordmark" href="/">berg:work</a>
        <p>A PDF editor and an image editor that run in your browser. Made by Florian Fischer in the Allgäu, Germany.</p>
      </div>
      <nav aria-label="Products">
        <h2>Editors</h2>
        <a href="/app/pdf/">Open the PDF editor</a>
        <a href="/app/image/">Open the image editor</a>
        <a href="/pdf/">About ${escapeHtml(config.products.pdf)}</a>
        <a href="/image/">About ${escapeHtml(config.products.image)}</a>
      </nav>
      <nav aria-label="Site information">
        <h2>More</h2>
        <a href="/roadmap/">Roadmap</a>
        <a href="/download/">Desktop apps</a>
        <a href="/privacy/">Privacy</a>
        <a href="/legal/">Legal notice</a>
        <a href="mailto:${escapeHtml(config.contactEmail)}">Contact</a>
      </nav>
    </div>
  </footer>`;
}

export function renderLayout(page, assets) {
  const title = page.fullTitle || `${page.title} — ${config.siteName}`;
  const canonical = config.siteUrl ? new URL(page.path, config.siteUrl).href : '';
  const og = page.og ? assets[page.og] : assets.og;
  const ogImage = config.siteUrl ? new URL(og, config.siteUrl).href : og;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(page.description)}" />
  <meta name="theme-color" content="${escapeHtml(config.theme.ink)}" />
  <meta name="color-scheme" content="light" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="${escapeHtml(config.siteName)}" />
  <meta property="og:title" content="${escapeHtml(title)}" />
  <meta property="og:description" content="${escapeHtml(page.description)}" />
  <meta property="og:image" content="${escapeHtml(ogImage)}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escapeHtml(title)}" />
  <meta name="twitter:description" content="${escapeHtml(page.description)}" />
  <meta name="twitter:image" content="${escapeHtml(ogImage)}" />
  ${canonical ? `<link rel="canonical" href="${escapeHtml(canonical)}" /><meta property="og:url" content="${escapeHtml(canonical)}" />` : ''}
  <link rel="alternate" hreflang="en" href="${canonical || page.path}" />
  <link rel="alternate" hreflang="x-default" href="${canonical || page.path}" />
  <link rel="manifest" href="/manifest.webmanifest" />
  <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  <link rel="icon" href="/favicon.ico" sizes="any" />
  <link rel="apple-touch-icon" href="${assets.appleTouch}" />
  <link rel="preload" href="${assets.font}" as="font" type="font/woff2" crossorigin />
  <link rel="preload" href="${assets.monoFont}" as="font" type="font/woff2" crossorigin />
  <link rel="stylesheet" href="${assets.css}" />
  ${page.current === 'home' ? `<script src="${assets.heroJs}"></script>` : ''}
  <script src="${assets.siteJs}" defer></script>
  <script type="application/ld+json">${JSON.stringify(structuredData()).replaceAll('<', '\\u003c')}</script>
</head>
<body class="page-${escapeHtml(page.current)}">
  <a class="skip-link" href="#main">Skip to content</a>
  ${header(page.current, page.current === 'home')}
  <main id="main">${page.body}</main>
  ${footer()}
</body>
</html>`;
}
