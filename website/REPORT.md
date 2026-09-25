# berg:work website v2 — final report

Date: 2026-09-25. No deployment or commit was made.

## Owner review changes

- Long display-font headlines were replaced with short titles and mono lead text. Counts, timings and phase numbers use the mono face.
- The Bergschrift webfont now carries the full Latin-1, Latin Extended-A and Cyrillic ranges, plus General Punctuation. Automated checks verify every displayed character against its font map.
- The mobile hero wordmark has exactly two lines: “berg:” and “work”. Display words and headings are checked for splitting and overflow at 360, 768 and 1440 px.
- The download page now has one concise status block per product. Public implementation terms were replaced with plain descriptions.
- PDF limitations now use a compact list rather than cards.

## Pages built

| Route | Result |
| --- | --- |
| `/` | Random four-image mine hero, factual two-product overview, sourced commitments and honest release status. |
| `/pdf/` | Tested browser features, current limitations, planned desktop app and five optional media slots. |
| `/image/` | Current internal-build features, measured limits, Phase 0–4 summary, non-goals and five optional media slots. |
| `/roadmap/` | Evidence-backed status for both apps, with no unsourced dates. |
| `/download/` | Empty-manifest state for both apps, planned platforms, notification email and release-driven rendering for future files. |
| `/legal/` | English “Legal notice (Impressum)” preserving provider, address and contact facts. |
| `/privacy/` | English privacy page preserving hosting, log, legal-basis and rights facts, plus service-worker Cache Storage. |
| `/offline/` | Service-worker navigation fallback. |
| `/404.html` | Static-hosting not-found page. |

## Gate results

| Gate | Result |
| --- | --- |
| HTML validity on all 9 pages | PASS |
| axe-core WCAG 2.2 AA on all 9 pages | PASS |
| Internal links and assets resolve | PASS |
| No horizontal overflow at 360, 768 or 1440 px | PASS |
| No split display words, overflowing headings or display-font numbers | PASS |
| Every displayed character exists in the Bergschrift font map | PASS |
| Skip link first, header next, focus visible | PASS |
| Banned phrases and competitor names absent | PASS |
| Browser requests stay on the local origin | PASS |
| No CSP violations | PASS |
| Manifest parses and declared icon dimensions match | PASS |
| Service worker installs; offline `/` and `/pdf/` reload | PASS |
| Every page below 150 KB excluding fonts, hero images and media | PASS |
| Reduced-motion CTA transitions disabled | PASS |
| Open Graph image is 1200×630 | PASS |
| 1440 px and 360 px screenshot for every page | PASS (18 files, ignored in `.check-out/`) |

## Claims marked `CONFIRM`

- Product names: `berg:work PDF` and `berg:work Image` are working names from the owner brief. The image product plan still records its final Tauri product name as open.
- `siteUrl`: no canonical domain has been chosen. It remains empty; the build omits canonical URLs, `og:url` and `sitemap.xml` and prints a warning.

## Misleading or false v1 text removed or corrected

| Previous text or idea | Change and reason |
| --- | --- |
| “Photoshop ersetzen” | Replaced with the sourced direction “compose, retouch and export layered images”; competitor names are not published. |
| “PSD als Brücke, rein und raus” | Corrected to partial PSD reading at 67% native fidelity; PSD writing is explicitly Phase 3 planned. |
| “Absturzsicher mit Wiederherstellung” | Removed as an unqualified promise. Recovery and the 200 MP workflow are described only under current internal-build evidence and limitations. |
| “Kleine Installer, kein Hintergrunddienst” | Installer-size claim removed because it is a target, not evidence. The process-after-quit result remains only in the claims ledger, not promotional copy. |
| “Linux und Windows von Anfang an” | Corrected to planned first-release platforms. The existing image shells and open Linux performance target are distinguished. |
| “Offenes, dokumentiertes Projektformat” | Kept only for the image format and labelled as implemented/documented; it is no longer a blanket two-product promise. |
| “Freistellen mit lokaler KI” | Corrected to locally running subject selection/background removal in the current internal image build, with explicit model-download behaviour. |
| “2 Apps · Linux · Windows · in Arbeit” | Replaced with separate per-product statuses: working browser PDF features, planned PDF shell, internal image desktop build, no public builds. |
| “PDF und Bild. Auf deinem Rechner.” | Replaced with a factual statement that two desktop editors are in development and are not publicly available. |
| “Das Übliche vs berg:work” comparison | Removed. Sourced design constraints now appear as commitments with status labels and measured caveats. |
| “Beide Apps laufen heute als interne Builds” | Corrected: only the image editor has an internal desktop build; the PDF features run in the Fernwork browser build and its shell has not started. |
| “Frühzugang gibt es auf Anfrage” | Removed because no sourced early-access programme is recorded. Notification links now only ask for release notice. |
| “Nicht-destruktiv” as a blanket current claim | Removed from the home commitments because it is partly a product rule and the crop tool remains incomplete. Specific working adjustment/filter behaviours are listed on the image page. |

## Missing media slots

All ten planned slots are missing and therefore omitted from the generated HTML:

- `pdf-text-edit.png`
- `pdf-page-organiser.png`
- `pdf-redaction.png`
- `pdf-sign-ocr.png`
- `pdf-workflow.mp4` + `pdf-workflow-poster.png`
- `image-layers-masks.png`
- `image-adjustment-layers.png`
- `image-background-removal.png`
- `image-large-document.png`
- `image-workflow.mp4` + `image-workflow-poster.png`

Capture instructions, datasets, dimensions and page destinations are in `MEDIA.md`.

## Not done

- No deployment or push.
- No public release files were added; both live release arrays remain empty.
- No canonical domain or sitemap was invented while `siteUrl` remains unconfirmed.
- No screenshots or videos were fabricated for product UI.
