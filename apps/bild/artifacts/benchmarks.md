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

## Phase 2 re-run — 2026-09-25

Observed 2026-09-25 against the integrated Phase 2 browser UI (`integration` at `c29d606`). The Phase 0 and Phase 1 sections above are left as recorded.

### Unchanged Phase 1 suite, run as-is

18 failed, 2 passed (tasks 8 and 20). 14 failures ended at their `missing()` line. Four failed earlier:

- **Task 9 — product regression.** *Layer › Align* is disabled for the vector shape the task draws. Phase 1 shapes were raster-backed; Phase 2 shapes are vector layers without a raster, and `alignUnits` (`src/core/align.ts`) only counts layers with a raster. The click waited for the disabled item until the test timed out.
- **Task 13 — behaviour change, then a harness fix.** Since A4c the browser build defaults to the Lite profile (100 MP). *Create canvas* at 20,000 × 10,000 now does nothing, and no message appears (see bugs). A 200-MP poster is a Pro task, so the benchmark now mounts the Pro profile.
- **Task 14 — harness timing.** Levels now applies asynchronously: the panel shows “Applying…” after OK. The benchmark read the export before the commit finished. It now waits for the panel to close, as `applyGaussianBlur` already did. The product is not at fault.
- **Task 15 — capability landed.** The Phase 0/1 step asserted that no Type tool exists. The step was replaced by real text steps (below).

### Benchmarks extended with Phase 2 capabilities

Every step goes through the real UI (menus, tools on the canvas, panels, dialogs, file choosers) and is followed by pixel or document assertions. No earlier step was removed and no earlier assertion weakened. When a Phase 2 capability exists but gives a wrong result, the failing assertion names the expectation and the bug is listed below with a reproduction. The later steps of that task stay in the scenario and run once the bug is fixed.

New inputs are generated at run time. The PSDs of tasks 4 and 5 are written in Node with `ag-psd`. The SlimSAM model for task 7 is served from local files through `page.route` (`FERNWORK_SLIMSAM_DIR`, else `/tmp/slimsam.*`; here `/tmp/slimsam.batbap`). Without those files the step would be reported as skipped, never as passed.

- **1 (green):** Cutout, then *Layer Style › Drop Shadow* (distance 8, size 3) with pixel-checked shadow. Three artboards come from presets: Instagram Post, then Duplicate Artboard + preset for Story and Facebook Cover. *Export As* writes a ZIP of `Post.png` 1080², `Story.png` 1080×1920 and `Cover.png` 851×315, each checked for product, shadow and white background.
- **2 (green):** Headline via the Type tool (24 pt), checked for ink. Logo SVG via *File › Place Embedded…*, moved with the X/Y fields + Apply, checked for green. Four artboards: one drawn around the layout, three duplicates. *Export As* WebP and then PNG: four files each, every one checked for photo, colour field, logo and headline.
- **3 (red, product bug):** Gradient background (Gradient tool). Person gets Stroke + Outer Glow through the Layer Style dialog, both pixel-checked. Bold 24 pt magenta text gets a Stroke → **fails**: the 2 px stroke adds 2 black pixels (expected > 100). JPEG export follows.
- **4 (red, product bug):** The mockup PSD (grey background + Smart Object “Screen” in perspective, embedded PNG) opens through *File › Open Project…* as an embedded layer with its warp quad. *Layer › Replace Contents…* keeps the transform and warp. *Export As* PNG shows the artwork in the screen and the background untouched. **Fails** at the perspective check: the quad is drawn as a rotated rectangle.
- **5 (red, product bug, then missing):** The client PSD opens with “Summer Sale” as an editable text layer. Double-clicking the T thumbnail and typing makes it “Winter Sale”, rendered. *Export As* has no PSD format. **Fails** at the missing-font check (NotoSans-Regular), before `missing('PSD write')`.
- **6 (green):** Spot healing (unchanged). *Dodge* brush mode (midtones, exposure 80) across both eyes brightens the iris. A *Basic* adjustment layer (exposure +0.5) brightens the skin. A *Color Lookup* layer loads a red/blue-swap `.cube` through the file picker; the swap is checked in pixels.
- **7 (red, product bug):** *Object Selection* (Shift-W, model download on click) with one click in the sky: IoU ≥ 0.9 against the generated horizon. *Refine Edge* (feather 1.5) gives a soft horizon, still IoU ≥ 0.9. New-sky import, then *Add layer mask* → **fails**: the mask hides the selected sky. With a debug-only *Select › Inverse* before the mask (not committed), the rest passes: a *Photo Filter* (Warming 85) adjustment layer warms the hill while the new sky stays unchanged.
- **9 (red, product bugs):** **Fails** at the Phase 1 Align step (disabled for the vector shape). The Phase 2 steps are written: five preset artboards (Web 1280, Post, Story, Cover, LinkedIn), photo resized to each artboard with W/H/X/Y + Apply, shape centred with Align, five-file export. A debug-only raster stand-in for the shape (not committed) passed the artboard and photo steps. It then failed at the second bug: in an artboard, Align centres on the whole canvas.
- **10 (green):** Rectangle + ellipse → *Layer › Combine Shapes › Subtract Front Shape*: one vector layer with a hole, pixel-checked, one undo step. *Export As* with *Selected layers* only, @1x and @2x: two PNGs, the @2x exactly twice as large, hole and solid corner checked in both.
- **13 (red, missing):** Pro profile, 200-MP canvas, *Edit › Fill with Foreground Color* on the full-size layer (pixels checked at three corners/centre). Then `missing()`: the Pro (Tauri) 200-MP path for 30 full-size layers with save and reopen is not accepted (A4c: WebKitGTK killed the Tauri run at 16 GB). The full run is not attempted here: it needs about 25 GB of scratch and archive disk (30 GB free on this machine).
- **15 (red, missing):** 90 pt “ffi” with the Type tool. Variable Noto Sans: Thin (wght 100) and Black (wght 900) are stored as the axis and change coverage by > 2×. The Character panel's Ligatures switch is on by default and stored per run. It cannot change a pixel with the bundled font: Noto Sans builds f_f_i/fi/fl as composites of the plain glyphs (checked with fontTools). OpenType reaching the shaper is shown with Small Caps (> 500 pixels change). Then `missing('text on a path')`.
- **17 (red, quality):** The Image Size upscale is unchanged. The generated photo now has heavy grain (±30) over a dark/light split. *Filter › Reduce Noise…* (smart filter) at luminance and colour 100 % → **fails**: grain σ drops only from 15.4 to 13.0 (the benchmark asks for −40 %).
- **18 (red, product bug):** Blur is unchanged. The frame is a rectangle with *Fill: None* and a solid 3 px red stroke → **fails**: nothing is drawn. The rest is written and passed with a debug-only Center-aligned stroke (not committed): a Line with an arrow end marker (head wider than the shaft, checked geometrically) and a PNG export with frame, arrow and blur.
- **19 (green):** Cutout, *Layer Style › Stroke* 4 px: black contour on four sides, transparent beyond, via *Export As* PNG. Re-edited from the fx row to 8 px, and the contour re-renders.
- **11, 12, 16:** Unchanged; still no soft-proof/CMYK, RAW or mesh warp in the UI.

### Status per task

| # | Core task | Phase 0 | Phase 1 | Phase 2 | First missing capability or blocker (Phase 2) | What turns it green |
|---:|---|---|---|---|---|---|
| 1 | Product photo / social formats | Red | Red | **Green** | — | — |
| 2 | Campaign key visual | Red | Red | **Green** | — | — |
| 3 | YouTube thumbnail | Red | Red | Red — product bug | Stroke (any size-based effect) on a text layer is applied in the 4× text raster | Bug fix; no Phase 3 item needed |
| 4 | Smart Object mockup | Red | Red | Red — product bug | PSD Smart Object in perspective: warp quad imported, never rendered | Bug fix (A7 fidelity); Phase 3 “Perspektive/Mesh-Warp” would also need to render `layer.warp` |
| 5 | Editable client PSD | Red | Red | Red — product bug, then missing | PSD font names (PostScript) not matched to bundled fonts; then **PSD write** | Bug fix + Phase 3 *PSD schreiben* |
| 6 | Portrait retouch | Red | Red | **Green** | — | — |
| 7 | Sky replacement | Red | Red | Red — product bug | *Add layer mask* with a selection hides the selection (inverted polarity) | Bug fix; no Phase 3 item needed |
| 8 | Object removal | Green | Green | **Green** | — | — |
| 9 | Banner set | Red | Red | Red — product bugs | Align disabled for vector layers (regression); single-layer Align on an artboard targets the canvas | Both bug fixes; no Phase 3 item needed |
| 10 | Vector icon | Red | Red | **Green** | — | — |
| 11 | Print / soft-proof | Red | Red | Red | CMYK soft-proof controls | Phase 3 *CMYK-Softproof/-Export* |
| 12 | RAW workflow | Red | Red | Red | RAW/DNG decoding (Tauri) | Phase 3 *RAW (Tauri)*; 16-bit TIFF export already exists |
| 13 | 200 MP poster | Red | Red | Red | Pro (Tauri) 200-MP path with 30 layers, save, reopen | Not a Phase 3 item: A4c acceptance (WebKitGTK working set, Phase 1 exit “200-MP-Test in Pro”) |
| 14 | Batch recipe | Red | Red | Red | Recipes applied to a 50-image queue | Phase 3 *Rezepte* + *Stapel-Export* |
| 15 | Typo poster | Red | Red | Red | Text on path | Phase 3 *Text auf Pfad* |
| 16 | Packaging mockup | Red | Red | Red | Mesh-warp controls | Phase 3 *Mesh-Warp* |
| 17 | Upscale / denoise | Red | Red | Red — quality | Reduce Noise too weak for heavy grain (−15 % σ at 100 %) | Stronger denoise (still no plan item, M12); Phase 3 AI *Hochskalieren* does not address it |
| 18 | Screenshot instructions | Red | Red | Red — product bug | Fill None + Inside stroke renders nothing | Bug fix; arrowheads exist now (M12 gap closed) |
| 19 | Raster logo | Red | Red | **Green** | — | — |
| 20 | Crash recovery | Red | Green | **Green** | — | — |

Summary: **Phase 0: 1 green / 19 red → Phase 1: 2 / 18 → Phase 2: 7 green / 13 red** (1, 2, 6, 8, 10, 19, 20).

Six red tasks (3, 4, 7, 9, 17, 18) have every Phase 2 capability they need but fail on a product bug or on quality. Fixing those bugs would give 12 green without Phase 3. Task 5 additionally needs PSD write (M12). Of the Phase 2 exit set “1–10”, 1, 2, 6, 8 and 10 are green.

### Product bugs found (no product code changed)

Each is a failing benchmark step unless noted.

1. **Align ignores vector layers (Phase 2 regression, task 9).** `alignUnits` in `src/core/align.ts` keeps only members with `l.raster`. Shape layers are now `vector` layers without a raster, so *Layer › Align/Distribute* is disabled. Repro: new 160 × 90 canvas, Shape tool, drag a rectangle → *Layer › Align* is greyed out. `session.canAlign()` returns false while the shape is selected.
2. **Align on an artboard targets the whole canvas (task 9).** `alignLayers` uses the selection bounds or the document, never the artboard. Repro: two preset artboards (Web 1280 at x 0 and its duplicate at x 1380); a 40 px square at x 1500 on the second; *Align › Horizontal Centers* → x 1310, straddling both artboards (Photoshop: centred on its artboard, x 2000).
3. **Size-based layer effects on text are 4× too small (task 3).** A text layer's displayed raster is oversampled 4× (105 × 54.5 pt text → 420 × 218 raster). The Stroke width is applied in raster pixels. Repro: white 200 × 100 canvas, magenta 40 pt “WOW”, *Layer Style › Stroke* 3 px outside → a grey ~0.75 px fringe; the export has 1 near-black pixel. The same stroke on a pixel layer is a solid 3 px black contour (task 19 green). Distance/size of shadows and glows on text are presumably affected the same way (not measured).
4. **Add layer mask from a selection hides the selection (task 7).** `addMaskFromSelection` (`src/core/selectionCommands.ts:238`) writes `base = revealing ? 255 : 0` outside and the opposite inside. The Layers-panel button calls it with `revealing = true` and gets a mask that is 0 inside the selection. Repro: 100 × 100 canvas, blue then red full-size layers, marquee 10–50, *Add layer mask* → blue inside the marquee, red outside. The unit test `selection.test.ts` pins this as “upstream polarity”; Photoshop's rule (reveal the selection) needs a decision.
5. **Fill None + Inside stroke renders nothing (task 18).** Repro: Shape tool rectangle, *Fill: None*, *Stroke: Color*, width 3 → the displayed raster has 0 opaque pixels in either order of the two changes. Center or Outside alignment draws the stroke; Inside is the default.
6. **PSD Smart Object perspective is dropped silently (task 4).** The reader stores a non-affine `placedLayer.transform` as `layer.warp` (a quad), but no renderer reads `layer.warp`. The layer is drawn as a rotated rectangle and the import reports no approximation. Repro: the generated `mockup.psd` in `scenarios.ts` (corners 30,20 · 90,24 · 90,66 · 30,70) → pixel (88, 22) is screen, not background.
7. **PSD fonts by PostScript name show as missing (task 5).** A PSD text run in `NotoSans-Regular` (Photoshop stores PostScript names) raises *Missing Fonts* (“NotoSans-Regular … shown as Noto Sans”) although that exact face is bundled. Repro: `clientPsd()` in `scenarios.ts`, open through *Open Project…*.
8. **Reduce Noise is too weak for real grain (task 17, quality).** `denoise` in `src/core/filters/sharpen.ts` is a 3 × 3 bilateral filter with a fixed range weight `exp(−20·ΔY)`. Grain above about ±15 levels counts as edges, and the strength slider only blends the result. Measured: σ 15.4 → 13.0 at 100 % after a 2× upscale. Simulated on uncorrelated noise: σ 17 → 13 (±30 uniform), σ 8 → 4.
9. **Lite silently refuses canvases over 100 MP (not a benchmark step).** The New Canvas dialog accepts up to 30,000 px per side. In the browser's Lite profile, 20,000 × 10,000 then does nothing: no document, no message, `reportError` not called (`session.createDocument` returns early at `maxPixels`). Repro: default mount, enter 20000 × 10000, *Create canvas*.
10. **Minor, not failing:** adding a layer style to one layer re-rounds unrelated semi-transparent export pixels by up to 2 levels (gradient pixel with alpha 126: 30,79,190 → 32,81,192), seen in task 3.
11. **Minor, not failing:** a PSD point-text layer without text bounds (`left/top` absent in the TySh data, as the ag-psd writer produces) imports with a NaN origin and is invisible. Photoshop always writes the bounds; the fixture now sets them.

### Last benchmark run (Phase 2)

Command:

```sh
PLAYWRIGHT_BROWSERS_PATH=/home/oem/.local/share/fernwork-compositor-lab/browser-cache E2E_PORT=5931 E2E_BENCHMARKS=1 npx playwright test --project=benchmarks --output=/tmp/pw-out-bench2
```

Observed summary (host locale `de_DE.UTF-8`, 8.4 min):

```text
13 failed
7 passed
```

Six failures end at `benchmark-helpers.ts:missing` (11, 12, 13, 14, 15, 16). Seven end at a named assertion: 3, 4, 5, 7, 9 and 18 at a product bug, 17 at the quality threshold. The SlimSAM model was present, so no step was environment-skipped.
