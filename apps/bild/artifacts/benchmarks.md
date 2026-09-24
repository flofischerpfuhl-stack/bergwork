# Core-task benchmark status

Observed 2026-09-24 against the Phase 0 browser UI. The suite is intentionally red where PRODUCT-PLAN.md §7.2 capabilities have not landed. “Automated” below means the listed actions went through the real UI and were followed by pixel or manifest assertions.

| # | Core task | Steps automated and asserted | First missing capability | Current status |
|---:|---|---|---|---|
| 1 | Product photo / social formats | Create canvas; import a generated product image; select and clear its flat background; assert transparent background and preserved product pixels. | Editable drop shadow / layer effects, before three format-specific exports. | Red — expected missing capability |
| 2 | Campaign key visual | Create 16:9 canvas; import color field and photo through File → Import Images; assert ordered layer structure. | Text layers for the headline, before SVG placement, four artboards, and WebP export. | Red — expected missing capability |
| 3 | YouTube thumbnail | Import generated person fixture; remove flat background with Magic Wand; assert transparent and retained pixels. | Editable outline/glow effects. | Red — expected missing capability |
| 4 | Smart Object mockup | Mount editor; open File menu; verify the project-open action is available. | PSD/PSB import, before Smart Object replacement. | Red — expected missing capability |
| 5 | Editable client PSD | Mount editor; open File menu; verify the project-open action is available. | PSD/PSB import, before text editing and PSD write-back. | Red — expected missing capability |
| 6 | Portrait retouch | Import generated blemished portrait; paint with Spot Healing; poll exported pixels until the blemish is replaced. | Dodge/burn tool for eyes. | Red — expected missing capability |
| 7 | Sky replacement | Create canvas; import generated landscape; assert imported layer structure. | Object Selection UI, before edge refinement and adjustment-layer color matching. | Red — expected missing capability |
| 8 | Object removal | Import generated photo; marquee the object; run Content-Aware Fill; assert replacement pixels and unchanged layer structure. | None for the content-aware route specified by the task. | **Green** |
| 9 | Banner set | Import banner photo; draw a real vector shape; assert shape-layer structure. | Artboards and per-artboard resizing for five formats. | Red — expected missing capability |
| 10 | Vector icon | Draw vector rectangle; assert shape layer and opaque exported center pixel. | Boolean operations between shape layers. | Red — expected missing capability |
| 11 | Print / soft-proof | Generate an Adobe RGB ICC-tagged TIFF locally; import it through the UI; assert dimensions, alpha, and that exported sRGB pixels differ from unconverted source values. | CMYK soft-proof controls, before CMYK TIFF export. | Red — expected missing capability |
| 12 | RAW workflow | Mount editor; open File menu; verify image import is available. | RAW/DNG decoding in the Tauri import path. | Red — expected missing capability |
| 13 | 200 MP poster | Create a 20,000 × 10,000 canvas; assert the 200 MP manifest and initial layer. | Pro scratch-backed stress path for safely populating/editing 30 full-size layers. | Red — expected missing capability |
| 14 | Batch recipe | Import first series image; apply Levels through the dialog; assert brighter exported pixels. | Recordable recipes and a 50-image application/export queue. | Red — expected missing capability |
| 15 | Typo poster | Create poster canvas; verify no text tool is exposed. | Editable text layers, variable fonts, and OpenType ligatures. | Red — expected missing capability |
| 16 | Packaging mockup | Import package face; assert its centered layer transform. | Mesh-warp controls. | Red — expected missing capability |
| 17 | Upscale / denoise | Import generated old-photo texture; resize 40 × 40 to 80 × 80 through Image Size; assert resulting dimensions. | Denoise filter. | Red — expected missing capability |
| 18 | Screenshot instructions | Import generated screenshot; apply Gaussian Blur; assert softened boundary pixels. | Arrow and outline-only frame annotation primitives. | Red — expected missing capability |
| 19 | Raster logo | Import generated logo; remove flat background with Magic Wand; assert transparency and retained logo pixels. | Editable contour/stroke for raster artwork. | Red — expected missing capability |
| 20 | Crash recovery | Create and edit project; wait for IndexedDB recovery copy; remount; accept recovery; assert restored layers; verify Undo is disabled. | Persisted undo history after recovery. | Red — expected missing capability |

## Last benchmark run

Command:

```sh
PLAYWRIGHT_BROWSERS_PATH=/home/oem/.local/share/fernwork-compositor-lab/browser-cache E2E_PORT=5381 E2E_BENCHMARKS=1 npx playwright test --project=benchmarks
```

Observed summary:

```text
19 failed
1 passed
```

All 19 expected failures must end at `benchmark-helpers.ts:missing`. A failure earlier in a scenario is a regression, not an accepted red result.

## Phase 1 re-run — 2026-09-24

Observed 2026-09-24 against the integrated Phase 1 browser UI (strict layer model v2, 16-bit/float pipeline, all 27 blend modes, WebP/AVIF/GIF import, rulers/guides/align/distribute, history panel saved with the project, layer locks/fill opacity/colour labels/layer search, host capabilities and Pro/Lite profiles, dirty-region brush preview). The Phase 0 table above is left as recorded.

First, the unchanged Phase 0 suite was run as-is: 18 tasks still ended at their `missing()` line and task 8 stayed green, but two tasks failed before their documented step:

- **Task 13 — harness bug, not a product change.** `createCanvas` built the expected size label with Node's `toLocaleString()`, so on a `de_DE` host it expected `20.000 × 10.000 px` while the browser (en-US) shows `20,000 × 10,000 px`. The helper now formats the expected label in the browser, like the product does. The Phase 0 “red at `missing`” result for task 13 depended on the host locale of that run.
- **Task 20 — capability landed.** The Phase 0 step “verify Undo is disabled after recovery” failed because recovery copies now carry the history. The benchmark was extended through the new capability (below) and is now green.

Benchmarks extended with Phase 1 capabilities (real UI, pixel and document assertions, no steps removed):

- **Task 9:** after drawing the shape, *Layer › Align › Horizontal Centers* and *Vertical Centers* centre it on the layout; the exported pixels are asserted before (shape at x = 30, photo at x = 100) and after (shape at x = 100, photo at x = 30 and above the centred shape). Still red at artboards.
- **Task 20:** the project now gets two steps before the “crash” (import, then *Image › Invert* on the imported layer, asserted in pixels). The test waits for a recovery copy written *after* the invert, remounts, recovers, asserts layers and inverted pixels, then: the History panel lists the steps with the last one current; *Edit › Undo* is enabled and restores the pre-invert pixels and layer list; clicking the History row before the import returns to the one-layer canvas and its original pixel; clicking the last row redoes both steps with their pixels. Green.

No other red task stops at a step that Phase 1 provides: every other first missing capability is still absent from the UI (checked in `src/ui/menus.ts`, `src/core/session.ts` tool list, and the layers panel). The PSD reader (`src/io/psd`) exists but is used only by tests and the fidelity script; neither *Open Project…* nor *Import Images…* accepts a PSD.

| # | Core task | Phase 0 | Phase 1 | First missing capability (Phase 1) | Plan item(s) that fix it |
|---:|---|---|---|---|---|
| 1 | Product photo / social formats | Red | Red | Editable drop shadow (layer effects) | Phase 2: layer styles (basic set) → then export dialog with sizes/formats; green after Phase 2 |
| 2 | Campaign key visual | Red | Red | Text layers for the headline | Phase 2: text (A5), SVG placement, artboards + export dialog (WebP); green after Phase 2 |
| 3 | YouTube thumbnail | Red | Red | Editable stroke/outer-glow effects | Phase 2: layer styles (stroke, outer glow), text with stroke (A5); gradient background already exists; green after Phase 2 |
| 4 | Smart Object mockup | Red | Red | PSD/PSB import in the open/import UI | Phase 2: PSD read (A7) wired to the UI, embedded content with “replace contents”, export; green after Phase 2 |
| 5 | Editable client PSD | Red | Red | PSD/PSB import in the open/import UI | Phase 2: PSD read (A7) + text (A5) move it forward; PSD write is Phase 3, so green only after Phase 3 |
| 6 | Portrait retouch | Red | Red | Dodge/burn for the eyes | Phase 2: dodge/burn as brush mode, basic adjustment layer, colour lookup (`.cube`); green after Phase 2 |
| 7 | Sky replacement | Red | Red | Object selection UI | Phase 2: object selection + refine edge (adjustment layers already exist); green after Phase 2 |
| 8 | Object removal | Green | Green | — | — |
| 9 | Banner set | Red | Red | Artboards (per-artboard sizes for five formats) | Phase 2: artboards with format presets + per-artboard export; green after Phase 2 |
| 10 | Vector icon | Red | Red | Boolean operations between shapes | Phase 2: vector booleans (A5) + export @1x/@2x per layer/artboard; green after Phase 2 |
| 11 | Print / soft-proof | Red | Red | CMYK soft-proof controls | No Phase 2 item; Phase 3: CMYK soft-proof/export |
| 12 | RAW workflow | Red | Red | RAW/DNG decoding (Tauri import) | No Phase 2 item (the TIFF option of the Phase 2 export dialog covers the last step); Phase 3: RAW (Tauri) |
| 13 | 200 MP poster | Red | Red | Pro scratch-backed stress path for 30 full-size layers | No Phase 2 item; the Phase 1 leftover A4 (swap + journal, lane A4c, not merged) and the Phase 1 exit “200 MP test in Pro” |
| 14 | Batch recipe | Red | Red | Recipes applied to a 50-image queue | No Phase 2 item; Phase 3: recipes + batch export |
| 15 | Typo poster | Red | Red | Editable text layers (variable fonts, OpenType ligatures) | Phase 2: text (A5) moves it forward; text on path is Phase 3, so green only after Phase 3 |
| 16 | Packaging mockup | Red | Red | Mesh-warp controls | No Phase 2 item; Phase 3: mesh warp |
| 17 | Upscale / denoise | Red | Red | Denoise filter | No plan item: §6.4 has only *Add Noise*; AI upscaling is Phase 3 and a denoise filter is not scheduled in any phase (plan gap) |
| 18 | Screenshot instructions | Red | Red | Arrow and outline-only frame annotations | Phase 2: vector stroke options (A5) can give outline frames; arrowheads are not named in the plan (plan gap) |
| 19 | Raster logo | Red | Red | Editable stroke around transparent raster artwork | Phase 2: layer styles (stroke); green after Phase 2 |
| 20 | Crash recovery | Red | **Green** | — (recovered history continues: undo, History-panel jump, redo, all pixel-asserted) | — |

Summary: **Phase 0: 1 green / 19 red → Phase 1: 2 green / 18 red.** After Phase 2 as planned, tasks 1, 2, 3, 4, 6, 7, 9, 10 and 19 would be green (the Phase 2 exit criterion “tasks 1–10” also needs 5, which requires PSD write from Phase 3); 18 needs arrowheads and 17 a denoise filter, neither scheduled.

### Product observations (no product code changed)

- **Number formatting ignores the editor's UI language (minor).** `src/ui/ContextBar.tsx:166` and `src/ui/LayersPanel.tsx:179` call `toLocaleString()` without the editor locale, while e.g. the recovery dialog uses `toLocaleString(this.locale)`. Reproduction: mount the editor with `locale: 'de'` in an en-US browser/WebView and create a 20 000 × 10 000 canvas; the status bar shows `20,000 × 10,000 px` next to German UI text (a German OS with English UI shows the reverse). Not a benchmark step, so no benchmark test was added.

### Last benchmark run (Phase 1)

Command:

```sh
PLAYWRIGHT_BROWSERS_PATH=/home/oem/.local/share/fernwork-compositor-lab/browser-cache E2E_PORT=5621 E2E_BENCHMARKS=1 npx playwright test --project=benchmarks --output=/tmp/pw-out-bench
```

Observed summary (host locale `de_DE.UTF-8`):

```text
18 failed
2 passed
```

All 18 failures end at `benchmark-helpers.ts:missing` with the capability listed above; tasks 8 and 20 pass.
