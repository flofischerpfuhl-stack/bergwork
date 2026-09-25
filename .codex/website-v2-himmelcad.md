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
