import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, watch } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import config from './site.config.mjs';
import { renderLayout } from './src/lib/layout.mjs';
import { prepareMedia } from './src/lib/media.mjs';
import { render as renderHome } from './src/pages/home.mjs';
import { render as renderPdf } from './src/pages/pdf.mjs';
import { render as renderImage } from './src/pages/image.mjs';
import { render as renderRoadmap } from './src/pages/roadmap.mjs';
import { render as renderDownload } from './src/pages/download.mjs';
import { render as renderLegal } from './src/pages/legal.mjs';
import { render as renderPrivacy } from './src/pages/privacy.mjs';
import { render as renderOffline } from './src/pages/offline.mjs';
import { render as renderNotFound } from './src/pages/not-found.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');
const sourceAssets = path.join(root, 'src', 'assets');
const warnings = [];
const copiedAssets = new Set();

function digest(data, length = 10) {
  return createHash('sha256').update(data).digest('hex').slice(0, length);
}

async function ensureParent(file) {
  await mkdir(path.dirname(file), { recursive: true });
}

async function fingerprintAsset(source, preferredName) {
  const data = await readFile(source);
  const parsed = path.parse(preferredName);
  const relative = path.join(parsed.dir, `${parsed.name}.${digest(data)}${parsed.ext}`);
  const output = path.join(dist, 'assets', relative);
  await ensureParent(output);
  await writeFile(output, data);
  const url = `/assets/${relative.split(path.sep).join('/')}`;
  copiedAssets.add(url);
  return url;
}

/**
 * The web apps on bergwork.app: berg:work Image at /app/image/ and berg:work PDF at /app/pdf/. Each is built once per
 * process into .apps/<name>/ and copied into dist/ on every site build. Dependencies are installed when missing
 * (Workers Builds starts from a bare checkout): the repo's workspaces for the design base and the PDF app, the image
 * editor from its own lockfile, and the PDF editor's pinned build from its mirror tag when no Fernwork checkout is
 * there (scripts/sync-upstream.mjs). BERGWORK_SKIP_APPS=1 leaves the apps out.
 */
const repo = path.resolve(root, '..');
const appsCache = path.join(root, '.apps');
const webApps = [
  {
    name: 'image',
    base: '/app/image/',
    build(out) {
      const dir = path.join(repo, 'apps', 'image');
      if (!existsSync(path.join(dir, 'node_modules', 'vite'))) run('npm', ['ci', '--no-audit', '--no-fund'], dir);
      run('npx', ['vite', 'build', '--outDir', out, '--emptyOutDir'], dir, { BERGWORK_BASE: this.base });
    },
  },
  {
    name: 'pdf',
    base: '/app/pdf/',
    async build(out) {
      const dir = path.join(repo, 'apps', 'pdf');
      run('node', ['scripts/sync-upstream.mjs', 'install', 'fernwork-pdf'], repo);
      run('node', ['scripts/build-frontend.mjs'], dir);
      await rm(out, { recursive: true, force: true });
      await cp(path.join(dir, 'dist'), out, { recursive: true });
    },
  },
];
let appsBuilt = false;

function run(command, args, cwd, env = {}) {
  console.log(`$ (${path.relative(repo, cwd) || '.'}) ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed in ${cwd}`);
}

async function buildWebApps() {
  if (appsBuilt || process.env.BERGWORK_SKIP_APPS === '1') return;
  if (!existsSync(path.join(repo, 'node_modules', '.package-lock.json'))) {
    run('npm', ['ci', '--workspace', 'packages/ui', '--workspace', 'apps/pdf', '--no-audit', '--no-fund'], repo);
  }
  for (const app of webApps) await app.build(path.join(appsCache, app.name));
  appsBuilt = true;
}

async function copyWebApps() {
  if (process.env.BERGWORK_SKIP_APPS === '1') return;
  for (const app of webApps) {
    // Source maps, the bundle report and Vite's manifest stay out of the deployment.
    await cp(path.join(appsCache, app.name), path.join(dist, app.base.slice(1)), {
      recursive: true,
      filter: (source) => !/\.map$|bundle-report\.json$|[\\/]\.vite([\\/]|$)/.test(source),
    });
  }
}

async function writeText(relative, text) {
  const output = path.join(dist, relative);
  await ensureParent(output);
  await writeFile(output, text, 'utf8');
}

async function build() {
  await buildWebApps();
  warnings.length = 0;
  copiedAssets.clear();
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });

  const font = await fingerprintAsset(path.join(sourceAssets, 'fonts', 'Bergschrift-Regular.woff2'), 'fonts/Bergschrift-Regular.woff2');
  const monoFont = await fingerprintAsset(path.join(sourceAssets, 'fonts', 'JetBrainsMono-latin.woff2'), 'fonts/JetBrainsMono-latin.woff2');
  const logo = await fingerprintAsset(path.join(sourceAssets, 'icons', 'bergwork-mark.svg'), 'icons/bergwork-mark.svg');
  const favicon = await fingerprintAsset(path.join(sourceAssets, 'icons', 'favicon.ico'), 'icons/favicon.ico');
  const appleTouch = await fingerprintAsset(path.join(sourceAssets, 'icons', 'apple-touch-icon.png'), 'icons/apple-touch-icon.png');
  const icon192 = await fingerprintAsset(path.join(sourceAssets, 'icons', 'icon-192.png'), 'icons/icon-192.png');
  const icon512 = await fingerprintAsset(path.join(sourceAssets, 'icons', 'icon-512.png'), 'icons/icon-512.png');
  const iconMaskable = await fingerprintAsset(path.join(sourceAssets, 'icons', 'icon-maskable-512.png'), 'icons/icon-maskable-512.png');
  // Open Graph pictures (website/media/og-images.py). The web apps link them from their own pages, so each also gets a
  // stable, unfingerprinted copy under /og/.
  const ogImages = {};
  for (const [key, name] of [['og', 'og-bergwork'], ['ogPdf', 'og-pdf'], ['ogImage', 'og-image']]) {
    const source = path.join(sourceAssets, 'img', `${name}.jpg`);
    if (!existsSync(source)) { warnings.push(`Missing Open Graph picture ${name}.jpg`); continue; }
    ogImages[key] = await fingerprintAsset(source, `img/${name}.jpg`);
    await ensureParent(path.join(dist, 'og', `${name}.jpg`));
    await cp(source, path.join(dist, 'og', `${name}.jpg`));
  }
  const og = ogImages.og;
  const markPdf = await fingerprintAsset(path.join(sourceAssets, 'logos', 'bergwork-pdf.svg'), 'logos/bergwork-pdf.svg');
  const markImage = await fingerprintAsset(path.join(sourceAssets, 'logos', 'bergwork-image.svg'), 'logos/bergwork-image.svg');

  const heroNames = ['dusk', 'day', 'inside', 'winter'];
  const hero = {};
  for (const name of heroNames) {
    for (const size of ['', '@1440']) {
      for (const extension of ['jpg', 'webp']) {
        const fileName = `mine-${name}${size}.${extension}`;
        hero[`${name}${size || '@2880'}-${extension}`] = await fingerprintAsset(path.join(sourceAssets, 'img', fileName), `img/${fileName}`);
      }
    }
  }

  const cssTokens = {
    __FONT_WOFF2__: font,
    __MONO_WOFF2__: monoFont,
    __HERO_DUSK_WEBP__: hero['dusk@2880-webp'], __HERO_DUSK_JPG__: hero['dusk@2880-jpg'],
    __HERO_DAY_WEBP__: hero['day@2880-webp'], __HERO_DAY_JPG__: hero['day@2880-jpg'],
    __HERO_INSIDE_WEBP__: hero['inside@2880-webp'], __HERO_INSIDE_JPG__: hero['inside@2880-jpg'],
    __HERO_WINTER_WEBP__: hero['winter@2880-webp'], __HERO_WINTER_JPG__: hero['winter@2880-jpg'],
    __HERO_DUSK_1440_WEBP__: hero['dusk@1440-webp'], __HERO_DUSK_1440_JPG__: hero['dusk@1440-jpg'],
    __HERO_DAY_1440_WEBP__: hero['day@1440-webp'], __HERO_DAY_1440_JPG__: hero['day@1440-jpg'],
    __HERO_INSIDE_1440_WEBP__: hero['inside@1440-webp'], __HERO_INSIDE_1440_JPG__: hero['inside@1440-jpg'],
    __HERO_WINTER_1440_WEBP__: hero['winter@1440-webp'], __HERO_WINTER_1440_JPG__: hero['winter@1440-jpg'],
  };
  let cssSource = await readFile(path.join(root, 'src', 'site.css'), 'utf8');
  for (const [token, value] of Object.entries(cssTokens)) cssSource = cssSource.replaceAll(token, value);
  const cssTemp = path.join(dist, '.site.css');
  await writeFile(cssTemp, cssSource, 'utf8');
  const css = await fingerprintAsset(cssTemp, 'css/site.css');
  await rm(cssTemp);

  const siteJs = await fingerprintAsset(path.join(root, 'src', 'site.js'), 'js/site.js');
  const heroes = Object.fromEntries(heroNames.map((name) => [`mine-${name}`, { wide: hero[`${name}@2880-webp`], narrow: hero[`${name}@1440-webp`] }]));
  const heroSource = (await readFile(path.join(root, 'src', 'hero.js'), 'utf8')).replace('__HEROES__', JSON.stringify(heroes));
  const heroTemp = path.join(dist, '.hero.js');
  await writeFile(heroTemp, heroSource, 'utf8');
  const heroJs = await fingerprintAsset(heroTemp, 'js/hero.js');
  await rm(heroTemp);

  const mediaData = JSON.parse(await readFile(path.join(root, 'content', 'media.json'), 'utf8'));
  const releases = JSON.parse(await readFile(path.join(root, 'content', 'releases.json'), 'utf8'));
  const media = await prepareMedia(mediaData, path.join(root, 'src', 'media'), fingerprintAsset, warnings);

  const assets = {
    css, siteJs, heroJs, font, monoFont, logo, favicon, appleTouch, icon192, icon512, iconMaskable, og, markPdf, markImage,
    ogPdf: ogImages.ogPdf || og, ogImage: ogImages.ogImage || og,
  };
  const pageContext = { assets, media, releases, config };
  const pages = [renderHome(pageContext), renderPdf(pageContext), renderImage(pageContext), renderRoadmap(pageContext), renderDownload(pageContext), renderLegal(pageContext), renderPrivacy(pageContext), renderOffline(pageContext)];

  for (const page of pages) {
    const relative = page.path === '/' ? 'index.html' : path.join(page.path.slice(1), 'index.html');
    await writeText(relative, renderLayout(page, assets));
  }
  const notFound = renderNotFound(pageContext);
  await writeText('404.html', renderLayout(notFound, assets));

  await cp(path.join(sourceAssets, 'icons', 'bergwork-mark.svg'), path.join(dist, 'favicon.svg'));
  await cp(path.join(sourceAssets, 'icons', 'favicon.ico'), path.join(dist, 'favicon.ico'));

  const manifest = {
    name: 'berg:work PDF and Image',
    short_name: 'berg:work',
    description: 'A PDF editor and an image editor that run in your browser. Nothing is uploaded.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: config.theme.cream,
    theme_color: config.theme.ink,
    lang: 'en',
    icons: [
      { src: icon192, sizes: '192x192', type: 'image/png' },
      { src: icon512, sizes: '512x512', type: 'image/png' },
      { src: iconMaskable, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: logo, sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    ],
  };
  await writeText('manifest.webmanifest', `${JSON.stringify(manifest, null, 2)}\n`);

  const routePaths = ['/', '/pdf/', '/image/', '/roadmap/', '/download/', '/legal/', '/privacy/', '/offline/', '/404.html'];
  const precache = [...routePaths, css, siteJs, heroJs, font, monoFont, logo, icon192, icon512, iconMaskable, appleTouch, '/manifest.webmanifest', '/favicon.svg', '/favicon.ico'];
  let sw = await readFile(path.join(root, 'src', 'sw-template.js'), 'utf8');
  const swVersion = digest(JSON.stringify([...copiedAssets].sort()) + sw, 12);
  sw = sw.replace('__CACHE_VERSION__', swVersion).replace('__PRECACHE__', JSON.stringify(precache));
  await writeText('sw.js', sw);

  await copyWebApps();
  await cp(path.join(root, '_headers'), path.join(dist, '_headers'));
  await cp(path.join(root, '_redirects'), path.join(dist, '_redirects'));
  await writeText('robots.txt', `User-agent: *\nAllow: /\n`);
  if (config.siteUrl) {
    const urls = pages.filter((page) => page.current !== 'offline').map((page) => `  <url><loc>${new URL(page.path, config.siteUrl).href}</loc></url>`).join('\n');
    await writeText('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
  } else {
    warnings.push('siteUrl is empty (CONFIRM): canonical URLs, og:url and sitemap.xml were omitted.');
  }

  console.log(`Built ${pages.length + 1} HTML pages in ${path.relative(process.cwd(), dist) || 'dist'}.`);
  for (const warning of warnings) console.warn(`WARN: ${warning}`);
}

async function directoryTree(start) {
  const result = [start];
  for (const entry of await readdir(start, { withFileTypes: true })) {
    if (entry.isDirectory()) result.push(...await directoryTree(path.join(start, entry.name)));
  }
  return result;
}

let running = false;
let queued = false;
async function rebuild() {
  if (running) { queued = true; return; }
  running = true;
  try { await build(); } catch (error) { console.error(error); }
  running = false;
  if (queued) { queued = false; await rebuild(); }
}

await build();
if (process.argv.includes('--watch')) {
  const watched = [...await directoryTree(path.join(root, 'src')), path.join(root, 'content'), root];
  let timer;
  for (const directory of watched) {
    watch(directory, { persistent: true }, (_event, file) => {
      if (!file || directory === root && !['site.config.mjs'].includes(String(file))) return;
      clearTimeout(timer);
      timer = setTimeout(rebuild, 120);
    });
  }
  console.log('Watching src/, content/ and site.config.mjs…');
}
