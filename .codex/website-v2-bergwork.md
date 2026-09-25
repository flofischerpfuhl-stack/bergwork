# Lane: berg:work website v2 (production, English, multi-page)

Working directory: `/home/oem/Dokumente/003_Projekte/21_bergwork` (git repo, nothing committed yet; the current
state is staged — leave the index alone except for staging your website paths at the end). Work only in `website/`
and `README.md`. The common spec follows below this site brief and is binding.

## What berg:work is

berg:work is the brand for two desktop apps spun out of Fernwork (a static, client-side browser toolbox at
`/home/oem/Dokumente/003_Projekte/17_fernwork`, read-only for you): a **PDF editor** and an **image editor**, both
to ship as standalone Tauri apps for Linux and Windows. Working product names: "berg:work PDF" and "berg:work Image"
(put them in `site.config.mjs`; `CONFIRM`). Sister project: Himmel:CAD (surveying CAD) — a footer mention is fine.
There is no public build of either app and no price or licence decision yet: no prices, no licence claims.

Sources (read-only):
- PDF editor: `17_fernwork/README.md` (PDF tools list), `tools/pdf-*.html`, `tools/js/` PDF modules,
  `test/e2e/pdf-*.spec.ts` (evidence for WORKS), `PDF_OPEN_ISSUES.md`, `PDF_POLISH_TODO.md`, `docs/`. The PDF
  editor works today in the Fernwork browser build; a desktop (Tauri) shell for it has **not** been started — the
  desktop app is `PLANNED`, the editing features are `WORKS` (in the browser build) where tests back them.
- Image editor: `17_fernwork/research/compositor-port/PRODUCT-PLAN.md` (principles P1–P12, G1–G8, phases, core
  tasks, non-goals), `THREAD-BRIEF.md`, and the code/docs in
  `/home/oem/.local/share/fernwork-compositor-lab/workspaces/claude` (branch `integration`: `git log`, `docs/`
  incl. `tauri.md`, `format-v2.md`, handoff/roadmap status docs, `MODEL_LICENSES.md`). A Tauri build exists
  internally (`dist-tauri`). Use the latest handoff/roadmap status in that workspace to decide what WORKS.
- Current site: `website/` (index, legal pages, CSS, fonts, images, README).

Pages:
1. `/` — keep the hero: random one of the four mine images per load (move the inline script to a file for the CSP;
   keep the no-JS default `mine-dusk` and the mobile per-image crop), Bergschrift wordmark `berg:work` (lowercase).
   One factual line about what berg:work is and its status; the two apps with purpose and status; the commitments
   that are design rules, not features (offline, no account, no telemetry, local AI models, open documented file
   format, Linux as a first-class platform) — phrased as commitments with their status, sourced from PRODUCT-PLAN.
2. `/pdf/` — what the PDF editor does (only tested features), known limitations from `PDF_OPEN_ISSUES.md` stated
   briefly and honestly, what the desktop app adds (planned: open/save files directly, etc. only if sourced), media
   slots (text editing in place, page organiser, redaction, signing, OCR, a workflow video).
3. `/image/` — the image editor: what works in the current internal build (tools, adjustments, filters, blend
   modes, formats, large-document numbers only with evidence), the roadmap phases, the non-goals list ("what we
   will not build"), media slots (layers + masks, adjustment layers, background removal, large document, a workflow
   video).
4. `/roadmap/` — both apps; image editor phases 0–4 from PRODUCT-PLAN with the real status from the workspace; PDF
   editor: desktop shell planned + open items. No dates unless sourced.
5. `/download/` — per the common spec; empty manifest → honest "No public build yet" per app with planned
   platforms (Linux, Windows; macOS: no test device, not planned for the first release — per PRODUCT-PLAN E3).
   Do not mention legal review.
6. `/legal/`, `/privacy/` — English versions of the current German pages (all facts kept, add the service-worker
   note), `/offline/`, `404`.

Known false or misleading text on the current site (remove or fix, list in your report — find more):
- "Photoshop ersetzen" is an internal goal statement; keep the idea only as a sourced product direction, and no
  competitor names on the site at all (the common spec bans vendor names) — rephrase without naming Photoshop.
- "PSD als Brücke, rein und raus" (PSD read is phase 2, write phase 3), "Absturzsicher mit Wiederherstellung",
  "Kleine Installer, kein Hintergrunddienst", "Linux und Windows von Anfang an", "Offenes, dokumentiertes
  Projektformat", "Freistellen mit lokaler KI" — each only with the right status label and a source.
- "2 Apps · Linux · Windows · in Arbeit" sticker, "PDF und Bild. Auf deinem Rechner." — rewrite factually.
- The comparison table "Das Übliche vs berg:work" is promo; drop it or turn it into sourced commitments.
- Keep: Bergschrift font (`assets/fonts/Bergschrift-Regular.ttf`, OFL, rebuilt by `scripts/build-wordmark-font.py`),
  the four mine images, the red/cream/ink palette, the logo mark (improve it only if needed for PWA icons; keep the
  motif).

`siteUrl`: no domain yet → leave empty (`CONFIRM`).
