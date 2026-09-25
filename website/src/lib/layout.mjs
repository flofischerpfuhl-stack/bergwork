import config from '../../site.config.mjs';
import { escapeHtml } from './html.mjs';

const nav = [
  ['pdf', '/pdf/', 'PDF'],
  ['image', '/image/', 'Image'],
  ['roadmap', '/roadmap/', 'Roadmap'],
  ['download', '/download/', 'Download'],
];

function organizationData() {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        name: config.siteName,
        email: config.contactEmail,
        ...(config.siteUrl ? { url: config.siteUrl } : {}),
      },
      {
        '@type': 'SoftwareApplication',
        name: config.products.pdf,
        applicationCategory: 'ProductivityApplication',
        operatingSystem: 'Linux, Windows',
        description: 'A planned desktop application based on the working Fernwork browser PDF editor. No public build is available.',
      },
      {
        '@type': 'SoftwareApplication',
        name: config.products.image,
        applicationCategory: 'GraphicsApplication',
        operatingSystem: 'Linux, Windows',
        description: 'An image editor with an internal desktop build. No public build is available.',
      },
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
        <p>PDF and image editing, being prepared as separate desktop applications.</p>
      </div>
      <nav aria-label="Products">
        <h2>Products</h2>
        <a href="/pdf/">${escapeHtml(config.products.pdf)}</a>
        <a href="/image/">${escapeHtml(config.products.image)}</a>
        <a href="/roadmap/">Roadmap</a>
        <a href="/download/">Download status</a>
      </nav>
      <nav aria-label="Site information">
        <h2>Information</h2>
        <a href="/legal/">Legal notice</a>
        <a href="/privacy/">Privacy</a>
        <a href="mailto:${escapeHtml(config.contactEmail)}">Contact</a>
      </nav>
    </div>
    <p class="footer-note">From the same workshop as Himmel:CAD, surveying CAD.</p>
  </footer>`;
}

export function renderLayout(page, assets) {
  const title = `${page.title} — ${config.siteName}`;
  const canonical = config.siteUrl ? new URL(page.path, config.siteUrl).href : '';
  const ogImage = config.siteUrl ? new URL(assets.og, config.siteUrl).href : assets.og;
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
  ${page.current === 'home' ? `<link rel="preload" href="${assets.heroDusk}" as="image" type="image/webp" fetchpriority="high" />` : ''}
  <link rel="stylesheet" href="${assets.css}" />
  ${page.current === 'home' ? `<script src="${assets.heroJs}"></script>` : ''}
  <script src="${assets.siteJs}" defer></script>
  <script type="application/ld+json">${JSON.stringify(organizationData()).replaceAll('<', '\\u003c')}</script>
</head>
<body class="page-${escapeHtml(page.current)}">
  <a class="skip-link" href="#main">Skip to content</a>
  ${header(page.current, page.current === 'home')}
  <main id="main">${page.body}</main>
  ${footer()}
</body>
</html>`;
}
