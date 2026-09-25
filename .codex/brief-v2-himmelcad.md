# Lane: Himmel:CAD website v2 (production, English, multi-page)

Working directory (a git worktree on branch `website/v4`, `node_modules` symlinked):
`/home/oem/Dokumente/003_Projekte/10_himmelcad-website-v4`. Work only in `website/` and the `website:*` scripts of
the root `package.json`. Another session works in the main checkout `/home/oem/Dokumente/003_Projekte/10_himmelcad`
— never write there. Read-only sources from the main checkout are allowed; in particular the **current licence
texts are uncommitted there**: read `LICENSE`, `LICENSING.md`, `CLA.md` from the main checkout, not the worktree.

The common spec follows below this site brief and is binding.

## Site content (English)

Product family (source: `README.md`, `docs/PRODUCT-VISION.md`, `docs/CURRENT-DIRECTION.md`): Himmel:CAD is an
offline-first family of CAD, photogrammetry, capture and viewing applications for surveying and civil engineering.
PhotoLab is the first product to be released; Builder is the flagship (3D-first civil CAD with first-class 2D);
Cap (mobile capture, Flutter MVP, `.hcap`) and WeltView (browser viewer for shared projects) are companions.
None has a public release. The site must say so plainly.

Pages (adjust names if sources suggest better ones; keep the count small):
1. `/` — hero with the existing `sky-hero.jpg` and the Kamikaze wordmark; one factual line about what Himmel:CAD is
   and its status; the four products with a one-line purpose and a status label; the licence essentials in one
   block (free for up to 3 people etc.); links to product pages, roadmap, pricing, download.
2. `/photolab/` — what PhotoLab does (images → aligned cameras, point cloud, DEM/DTM/DSM, orthophoto, mesh, splats;
   offline; accuracy/processing report; cancellation and recovery), inputs and outputs (formats only if sourced),
   and an honest release-readiness section based on `docs/photolab-release-acceptance-status-2026-09-19.md` (and any
   newer evidence you find under `docs/` and `docs/builder-program/evidence/`). Media slots for: project overview,
   alignment result, dense cloud, DEM/orthophoto, report, a 20–30 s workflow video.
3. `/builder/` — what Builder does today vs. what is being built, sourced from
   `docs/ui-redesign/FUNCTION-INVENTORY-2026-09-24.md` (68 built / 8 backend-only / 142 planned / 3 deferred — use
   the numbers only if you verify them in the file), `docs/builder-program/` (MASTER-PLAN, REGISTRY, specs) and
   `docs/ROADMAP.md`. Media slots for: point cloud viewer, clipping box, ground extraction, breaklines with snapping,
   DEM with error list, export, a workflow video.
4. `/cap-weltview/` (or two short pages) — Cap and WeltView, briefly, with status.
5. `/roadmap/` — the staged roadmap, reconciled with `docs/ROADMAP.md` and the builder program. No dates unless a
   source commits to them. Status labels per stage.
6. `/pricing/` — owner-confirmed prices (sources: `.claude/codex/prompts/full/website-v3-redesign.md`,
   `website-v31-revision.md`, current `website/index.html`): the free tier is the message; Founders programme
   79 € per month per office or 790 € per year, price fixed for life; Supporter 20 € per month for individuals who
   would be free but want to contribute. Who needs a commercial licence (from `LICENSING.md`). Founders enquiry via
   the existing mailto (translate its subject/body to English).
7. `/licence/` — plain-language summary of BSL 1.1 + Additional Use Grant from `LICENSING.md` (free for personal
   use, organisations with **3 or fewer people** incl. paid client work, education and non-profit research;
   evaluation for anyone; >3 people in production or hosted offerings need a commercial licence; 90-day grace when
   growing; every release becomes AGPL-3.0-or-later four years after release; forks keep the licence and may not use
   the name/logo; CLA for contributions). Source availability: the current site says the source is available on
   request until downloads exist — keep that unless a source says the repository is public (`CONFIRM`).
8. `/download/` — per the common spec (PhotoLab first; Builder, Cap later). Empty manifest → honest status.
9. `/legal/`, `/privacy/` — English translations of `impressum.html` and `datenschutz.html` (all facts kept; add the
   service-worker/Cache Storage note to privacy).
10. `/offline/`, `404`.

Known false or misleading text on the current site (remove or fix, and list in your report — find more):
- "unter 3 Personen" / "FREI UNTER DREI" contradicts the licence ("3 or fewer people").
- The founder quote was invented by an earlier brief ("e.g. …"); remove it. No quotes at all.
- "Meistgewählt" (nobody has chosen a plan yet), "Finanziert durch Gründerbüros und offene Entwicklung" (no founders
  yet), "Der Alltag von 90 % der Vermesser" (unsourced statistic), "Schneller.", "Flüssige Ansicht auch bei
  Milliarden Punkten" (only if sourced by a named benchmark), the `href="#"` "Vollständiges Funktionsregister" link
  (only with a real public URL), the "Das Übliche vs Himmel:CAD" promo table (replace with factual licence facts if
  useful), "KOSTENLOS LADEN" (there is nothing to download).
- Keep: the owner logos byte-identical (hash gate in the current `check.mjs`), the sky hero image, Kamikaze for the
  wordmark and display titles, the cream/ink/sky-blue palette.

`siteUrl`: `https://himmelcad.de` appears only as a JSON-schema `$id`; treat it as `CONFIRM` and leave `siteUrl`
empty unless a source clearly names the website domain.
# Common spec: production websites for Himmel:CAD and berg:work (v2)

Two sister sites (Himmel:CAD and berg:work) move from single-page mockups to real product websites. Both lanes
follow this common spec; the per-site brief adds the content. The owner's words (translated): "Make real sites, not
mockups or tests. Professionalise: hover animations, selection colour, PWA-ready, everything a proper website needs.
No standard promo page: only content we actually want to advertise with. No stock phrases, no invented quotes.
Prepare for screenshots/videos that show what the app can do. Prepare a download area. Not a one-pager. Remove or
replace misleading or false text. Site in English."

## 1. Hard content rules (the most important part)

1. **Every factual statement must be true today and backed by a source in the repositories.** Before writing pages,
   create `website/CLAIMS.md`: a table of every claim the site makes (feature, format, number, status, price, licence
   term), with the source file path (+ line or section) and a status: `WORKS` (implemented and verified in the
   internal build, cite the test/evidence), `IN PROGRESS`, `PLANNED`, `OWNER` (owner decision recorded in a brief or
   doc). Anything you cannot source is not published. Mark items that need owner confirmation `CONFIRM` and use the
   conservative wording on the site.
2. **Status is always visible.** Nothing unreleased may read as available. Features appear under explicit labels
   ("Works in the current build", "In progress", "Planned"). There is no public build of any product yet, so no copy
   may imply the reader can use the software today.
3. **Banned:** invented quotes or testimonials, customer logos, user counts, star ratings, "trusted by", fake
   urgency, vendor/competitor names, and marketing filler such as: seamless, powerful, cutting-edge, next-generation,
   revolutionary, game-changing, blazing fast, effortless, robust, intuitive, world-class, unlock, supercharge,
   empower, elevate, "take X to the next level", "all-in-one", "built for professionals". Add a gate that greps the
   built HTML for this list (case-insensitive) and fails on a hit.
4. Write plainly: short sentences, concrete nouns, numbers only when sourced. Say what a feature does, not how it
   feels. Headlines state facts ("Point clouds to terrain models, offline") not slogans.
5. English (en-GB spelling is fine; be consistent). Legal pages in English, keeping every legal fact of the current
   German pages (provider, address, contact, hosting, logs, legal bases, rights). The Legal notice page title is
   "Legal notice (Impressum)".
6. Keep the owner's contact address `fernwork.absolute836@passmail.net` wherever the current site uses it.

## 2. Architecture

- Static site generated by a **zero-dependency Node script** `website/build.mjs` (Node 22, only `node:` modules):
  sources in `website/src/` (page templates as JS modules exporting functions that return HTML strings, shared
  layout/partials, CSS, fonts, images, icons), content data in `website/content/` (`media.json`, `releases.json`,
  optional page data), output in `website/dist/` (git-ignored). `node website/build.mjs` builds, `--watch` optional.
  A preview command (`node website/serve.mjs`, zero-dependency static server with correct MIME types incl.
  `.webmanifest`, `.woff2`, `.avif`, `.webp`, `.mp4`, `.webm`) serves `dist/`.
- **Multi-page** with clean URLs: each page is `dist/<slug>/index.html`; home at `dist/index.html`; `dist/404.html`.
- Shared layout: skip link, header with wordmark (small) + primary navigation (current page marked with
  `aria-current="page"`), a no-JS-capable mobile menu (`<details>`/`<summary>` or a checkbox-free disclosure that
  works without JS; JS may enhance), footer with product links, download, legal notice, privacy, contact.
- **Asset fingerprinting:** CSS/JS/fonts/images copied to `dist/assets/` with a content hash in the file name;
  HTML references the hashed names. `_headers`: `Cache-Control: public, max-age=31536000, immutable` for
  `/assets/*`, `no-cache` for HTML, the manifest and the service worker.
- `_redirects` for the old URLs (e.g. `/impressum.html` → `/legal/`, `/datenschutz.html` → `/privacy/`, old anchors
  where it makes sense) with 301.
- Cloudflare: update `wrangler.jsonc` so the assets directory is `dist` (build command `node build.mjs` from
  `website/`), and document it in the README. Do **not** deploy.
- One config file `website/site.config.mjs`: site name, `siteUrl` (canonical origin; may be empty), contact e-mail,
  theme colours, product names. If `siteUrl` is empty, omit canonical/og:url/sitemap absolute URLs rather than
  emitting placeholders, and print a build warning.

## 3. Quality features (everything a proper site has)

- **Interaction design:** tasteful motion, 120–220 ms, `ease-out`; buttons/CTA "press" effect (hover: translate
  (-2px,-2px) and the hard shadow grows; active: translate to the shadow, shadow 0); cards lift slightly on hover;
  nav links with an underline that slides in; stickers straighten/rotate a little on hover; media frames zoom the
  image 1.02 inside an overflow-hidden frame; visible `:focus-visible` rings equivalent to hover. All motion
  disabled under `prefers-reduced-motion: reduce`. No scroll-jacking, no parallax, no autoplaying sound.
- `::selection` in the brand accent with a readable text colour; custom `accent-color`; `scrollbar-color` tuned.
- Header becomes compact/sticky on scroll using CSS only (e.g. `position: sticky` with a solid background on
  non-hero pages; on the home hero it may overlay).
- **PWA-ready:** `manifest.webmanifest` (name, short_name, description, start_url `/`, scope `/`, display
  `standalone`, background/theme colours, icons 192, 512 and 512 maskable PNG, SVG icon, `lang`), `apple-touch-icon`
  180 PNG, favicon.svg + favicon.ico (16/32/48); a service worker `sw.js` at the root: versioned by build hash,
  precaches the app shell (all HTML pages, CSS, JS, fonts, icons, offline page), runtime cache for images/media
  (stale-while-revalidate, capped), network-first for HTML with offline fallback to `/offline/`; deletes old caches on
  activate; never caches cross-origin or `mailto:`. Registered by a small `site.js`. Icons are rendered at build
  time or committed as generated files (use Inkscape `/usr/bin/inkscape` or headless Chromium via Playwright to
  rasterise the SVG; Pillow for .ico).
- **SEO/social:** unique `<title>` and meta description per page, canonical, Open Graph + Twitter card tags, a
  1200×630 OG image per site (generated from the hero + wordmark; commit it), `sitemap.xml`, `robots.txt`, JSON-LD
  (`Organization` + `SoftwareApplication` per product with `operatingSystem`, `applicationCategory`, and `offers`
  only where a real price exists), `hreflang="en"` + `x-default`.
- **Performance:** hero images as `image-set()` with WebP + JPEG fallback (cwebp at `/usr/bin/cwebp`; Pillow has no
  AVIF here — skip AVIF), responsive sizes (1440 / 2880), `fetchpriority="high"`/preload for the hero, `loading=
  "lazy"` + `decoding="async"` + explicit width/height for all other images; preload the display font; subset fonts
  where the licence allows (OFL yes; freeware Kamikaze: do not modify, only preload). Budget: every page < 150 KB
  excluding fonts, hero images and media; no layout shift from fonts (use `size-adjust`/fallback metrics or
  `font-display: swap` with a close fallback).
- **Security headers** in `_headers`: strict CSP (`default-src 'self'; img-src 'self' data:; media-src 'self';
  style-src 'self'; script-src 'self'; font-src 'self'; manifest-src 'self'; worker-src 'self'; connect-src 'self';
  frame-ancestors 'none'; base-uri 'self'; form-action 'none'` — so no inline scripts/styles: move them to files),
  `X-Content-Type-Options`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`, `X-Frame-Options:
  DENY`, `Cross-Origin-Opener-Policy: same-origin`.
- **Accessibility:** WCAG 2.2 AA: contrast, headings order, landmarks, alt texts, 44 px targets, keyboard path,
  visible focus, `lang`, reduced motion, no information by colour alone (status labels have text).
- Print stylesheet (hide nav/hero image, show URLs of external links).
- No tracking, no cookies, no third-party requests of any kind (fonts, CDNs, analytics, embeds). The privacy page
  must stay accurate: mention the service worker/Cache Storage (stored locally for offline use, no personal data).

## 4. Media slots (screenshots and videos come later)

- `content/media.json` describes every slot: `id`, `page`, `section`, `kind` (`image`|`video`), `file` (path under
  `src/media/`), `poster` (video), `alt`/`caption`, `width`, `height`, `what` (precise shot description for the
  person capturing it). The layout renders a slot as `<figure>` (images: `<picture>` with WebP + fallback; videos:
  `<video muted loop playsinline preload="none" poster>` with MP4/H.264 and optional WebM, autoplay only when in view
  and not under reduced motion, controls available, no sound) **only when the file exists**. Missing slots are
  omitted from the output (never an empty frame or "coming soon" box) and listed by the build as a warning.
- Write `website/MEDIA.md`: the shot list (one row per slot: file name, format and size — screenshots 2560×1600 PNG
  from a 1280×800 @2x window, videos 1920×1080 H.264 ≤ 30 s ≤ 8 MB with poster frame — what exactly must be visible,
  which dataset/document to use, and on which page it appears) plus how to add a file (drop into `src/media/`,
  rebuild). Design pages so they read well with zero media and get better as media arrives.

## 5. Download area

- `content/releases.json`: per product a list of releases `{version, date, channel ("alpha"|"beta"|"stable"),
  notes (markdown-lite or HTML string), files: [{os: "windows"|"linux"|"macos", arch, kind ("msi"|"exe"|"AppImage"|
  "deb"|"rpm"|"tar.gz"), url, size, sha256, signature?}], requirements: {...}}`. Start with **empty** release lists.
- `/download/` page: per product, if a release exists: primary button for the detected OS (small progressive JS
  reading `navigator.userAgentData`/`userAgent`; without JS all platforms are listed), all files in a table with size
  and SHA-256 (copy button), system requirements, link to release notes, verification instructions. If no release
  exists: an honest status block ("No public build yet"), what the first release will contain (from the sourced
  roadmap), supported platforms planned, and a mailto to be notified. No fake buttons, no disabled download buttons.
- `/releases/` (or a section on download) renders release notes from the same manifest; hidden when empty.
- Document the manifest in the README with one complete example (not in the live manifest).

## 6. Visual system

Keep each site's established identity (read the current `website/` files and screenshots first): cream/ink paper
palette + one accent, full-bleed painted hero on the home page with the huge display wordmark, mono typography for
UI and body, stickers with hard offset shadows, 1px ruled grids, no rounded corners, no gradients except inside
images, no soft shadows. Refine rather than replace: consistent spacing scale, type scale (clamp-based), max line
length ~70ch for prose, a readable body size (16–18 px), generous section rhythm. Inner pages get a compact header
band instead of the full hero, with an optional section image. The display font stays limited to the wordmark and
major titles.

## 7. Gates (a `website/check.mjs` that runs after the build; all must pass)

HTML validity (`npx -y html-validate@9` on all built pages), axe-core on every page (Playwright, Chromium), internal
links and assets resolve (including hashed names), no horizontal overflow at 360/768/1440, keyboard: skip link
first, then primary nav, focus visible, banned-phrase grep, no external requests (Playwright request log only hits
the local origin), CSP has no violations (listen for `securitypolicyviolation`), manifest parses and icons exist in
the declared sizes, the service worker installs and an offline reload of `/` and one inner page succeeds, page-weight
budget, `prefers-reduced-motion` disables transitions (computed style check on one CTA), the OG image exists at
1200×630. Screenshots of every page at 1440 and 360 into `website/.check-out/` (git-ignored). The Playwright module
may be imported from `/home/oem/Dokumente/003_Projekte/17_fernwork/node_modules/playwright/index.mjs` if the repo has
none; axe-core from `/home/oem/Dokumente/003_Projekte/10_himmelcad/node_modules/axe-core/axe.min.js`.

## 8. Process and constraints

- Work only inside the given website directory (plus the repo's root `package.json` script entry if one exists for
  the website). Do not touch other files. Never `git add -A`; stage only website paths; **do not commit**.
- Do not deploy, do not push, do not call any external service except `npx -y html-validate@9`.
- Order: read the current site + sources → write `CLAIMS.md` → information architecture in the README (page list +
  purpose) → build system → pages → quality features → gates → screenshots → README (how to build, preview, add
  media, add a release, deploy settings, gate table with the real results, font licences).
- When a rule here conflicts with something in the current site's README "design contract", this spec wins (e.g.
  motion is now wanted; client-side JS is now allowed for the SW, hero rotation, OS detection, copy buttons and video
  in-view playback).
- Final report (`-o` file): pages built, gate table, the list of claims marked `CONFIRM`, the list of text removed as
  misleading/false with the reason, missing media slots, and anything you could not do.
