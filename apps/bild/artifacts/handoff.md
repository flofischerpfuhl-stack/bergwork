# Fernwork Bildeditor handoff

Upstream reference: the MIT-licensed macOS editor at `a19db9011282399785dc18efcfded904627bdcc2`. Product: TypeScript 7 strict, React 19,
PixiJS 8 / WebGL 2, Web Workers + WASM (upstream C kernels), Vite 8. Standalone package; Fernwork's existing editor is
untouched and `contracts.ts` is unchanged. Per-feature status and every known deviation are in `parity.json`. Build,
test and architecture notes are in `README.md`.

Unless a later dated section states otherwise, the initial figures were measured on 2026-09-23 on the reference
machine (Intel HD Graphics 630, ANGLE/OpenGL, Chromium headless with GPU, 1440×900 at dpr 1).

## Status

All 14 upstream feature areas are implemented and reachable in the UI: workspace/tabs, history, layers/folders/blending,
masks/clipping, renderer, transform/distort, crop/canvas/image size, selections/wand/clipboard, brush engine,
retouch/content-aware, gradient/shapes/color, adjustments/adjustment layers/filters, subject removal, and I/O with
projects.

A read-only parity audit against the upstream sources (UI and document layers) listed 20 prioritized gaps. All were
closed except the software-rendering fallback, which is a documented deviation. 67 further upstream test cases were
ported afterwards. They revealed one behavioural difference, which is fixed: switching tools discards an unfinished
shape.

## Phase 0 (PRODUCT-PLAN.md), 2026-09-24

Status per feature-kit row: `artifacts/roadmap-status.md`. Measurement findings that change plan assumptions (M1–M7)
are recorded in `research/compositor-port/PRODUCT-PLAN.md` under "Änderungen nach Messung".

**B1 — saving and exporting large documents.** Save, Save As and export now choose the destination first and encode
afterwards (`chooseSaveTarget` + `saveFileTo`). `showSaveFilePicker` is now called bound to `window`; unbound it threw
"Illegal invocation". Evidence: `tests/e2e/large-save.spec.ts` (40 MP; checks that user activation is still valid
when the picker opens, and that a valid ZIP and an 8000 px PNG are written).

**B2 — texts.** Untranslated hints, tool names, tooltips and undo names are translated. Errors appear as a
localized sentence plus technical details, never as a raw browser message. Generated layer names follow the UI
language. Off Apple devices the UI says Ctrl/Strg and Alt instead of ⌘/Option, and German shortcut labels use
Strg/Umschalt. Evidence: `tests/unit/ui-text.test.ts`; a DOM scan of the German UI shows no English leftovers.

**E2 — own product name.**
- "Fernwork Bildeditor" is used as window title, Tauri app name and in the About box. "Compositor" appears only
  there, as a licence notice.
- The ".comp copy" item is gone from the menu; reading `.comp` files still works.
- Projects are saved as `.fwimg`. The format ID changes only with contracts v2 (M5).

**A1 — Tauri 2 shell.**
- The shell builds, starts and leaves no processes behind after quit. `.deb` and `.rpm` packages were built without
  root.
- WebView matrix (`artifacts/tauri-webview-matrix.md`) for Linux WebKitGTK:

  | Measurement | Result | Pro budget |
  |---|---|---|
  | Pan p95 | 14 ms | ≤ 16 ms, met |
  | Zoom p95 | 25 ms | ≤ 16 ms, missed |
  | Brush p95 | 34 ms | ≤ 16 ms, missed |
  | Opening a 46 MP JPEG | 2.4 s | ≤ 1.5 s, missed |

- The misses are recorded as M1. An A6 spike in Phase 1 examines them.
- Windows WebView2 is being measured on the Windows PC via the remote lane. macOS is not measured (E3).

**A5 — CanvasKit.** All abort criteria pass, re-measured by the integrator:
- identical raster output in Chromium, Firefox and WebKit (same SHA-256);
- 3.0 MB gzip;
- 500 characters in 9–11 ms p95.

E4 is confirmed; the Lite host must serve `.wasm` and `.js` compressed.

**A7 — PSD corpus.** 300 psd-tools files, pinned by commit and SHA-256; `third-party-psds/` and `issues/` are
excluded.
- Baseline, reproduced by the integrator: 276 files parsed, 43.3 % under the threshold.
- The 13 existing blend modes pass against Photoshop's composite; 14 are missing (A8).
- ag-psd reads no CMYK/Lab, no 32-bit and many descriptors not at all (M3).

**Benchmarks (7.2).** 20 core tasks as E2E. 1 is green (object removal); 19 are red, each at its first missing
capability (`artifacts/benchmarks.md`).

**Verification (integration → master):**
- unit tests: 355 passed;
- Chromium: 53 passed, 1 skipped;
- Firefox + WebKit: 95 passed, 1 skipped;
- perf-gpu: passed;
- runner gates including acceptance: green; `contracts.ts` unchanged.

## Phase 1 (PRODUCT-PLAN.md), 2026-09-24

Status per row: `artifacts/roadmap-status.md`. New measurement findings M9–M11 are in PRODUCT-PLAN.md under
"Änderungen nach Messung".

**Done, green on `integration`** (Chromium, Firefox and WebKit e2e, perf-gpu on the real GPU):
- **A2:** strict layer model v2 with typed adjustments; `.fwimg` format v2 with migration from v1 and `.comp`; history
  saved in the project. Evidence: `tests/unit/model-v2.test.ts`, `model-compat.test.ts`, `format-v2.test.ts`.
- **A3:** RGBA16 rasters and a float pipeline on GPU and CPU. The banding test is green in all browsers, including
  semi-transparent 16-bit (a WebKit half-float upload bug was fixed). ICC for 16-bit sources still runs at 8-bit
  precision.
- **A8:** all 27 blend modes. The 26 deterministic modes pass against Photoshop's composite; dissolve follows
  Photoshop's rule. PSD blend-modes folder: 93.8 %.
- **Files:** WebP, AVIF and GIF import, checked with unseen files in all three browsers.
- **Guides:** rulers, guides (create, move, delete, lock, numeric), snapping to guides, align/distribute
  (6 edges, 4 modes).
- **History panel:** jump between states; history optionally saved with the project.
- **Layers:** locks (transparency, pixels, position, all; inherited from folders) with a notice that names the locked
  layer; fill opacity including Photoshop's eight special fill modes (GPU = CPU within 1/255); colour labels; search
  and filter. PSD import covers all three.
- **A0:** a test enforces the engine boundary, plus a headless engine test. Versioned host capabilities (files, fonts,
  codecs, compute, models, colour, scratch) run in the browser and in Tauri. Pro/Lite profiles.
- **Offline (M8):** the hardened WebView2 build made 0 connections in 5 min. On Windows the real app was driven over
  CDP: menus and shortcuts pass, and no browser accelerator leaks through.
- **A6/A6b:** the brush preview renders only the dirty region. p95 in Chromium went from 12.9 to 5.7 ms, in WebKitGTK
  from 32–39 to 25–35 ms. The CSP no longer turns off the GPU renderer (M9). Forced SHM and native JPEG decoding were
  measured and not adopted (M10).

**Fixes from the integrator's own checks:**
- the CSP turned off the GPU renderer (M9);
- OS-opened files were outside the Tauri fs scope (M11);
- the save picker depended on the open picker (Firefox/WebKit);
- the Windows build needed Git Bash / LF; `<html lang>` was wrong;
- `.fwimg` could not be opened by drag and drop;
- test harness: tab selectors, base64 pixel transfer, separate Playwright output directories.

**Open at the end of Phase 1:**
- **A4 (swapping + journal):** A4b delivered residency, LOD and a granular journal, but lost brush strokes (3 e2e
  regressions in all browsers). It is not merged. Lane A4c fixes this and runs the 200-MP / 20-layer acceptance
  (Chromium 1.5 GiB, Tauri 4 GiB). This is the last Phase-1 exit criterion.
- **Runner gates:** the two time-measured gates (`test:e2e` perf-gpu under SwiftShader, `test:perf` CPU brush) were red
  at load 5–24. `master` fails the same way under the same load. A rerun on an idle machine is pending.
- **Nutzertest (A9):** collected later, by owner decision. Phase 1 counts as technically done.
- **WebKitGTK:** the brush Pro budget of 16 ms is still not reached (M10).

## Phase 2 (PRODUCT-PLAN.md), 2026-09-24/25

Owner decisions: Phase 2 started in parallel with the close of Phase 1; the A9 user test with real Photoshop users is collected
later; licence question M13 (MPL-2.0/Unicode-3.0 via Tauri) awaits legal advice, so the Tauri app stays an internal build.

**Phase 1 closed.** A4 (swapping + journal) is merged. The 200-MP / 20-layer workflow (navigate, stroke on a swapped layer,
adjustment, undo/redo, streaming save, reopen, 20/20 exact pixel checks) completes in Chromium (6.4 GiB peak RSS) and in the Linux
Tauri build (4.3 GiB peak; before the fix it was killed at 16 GiB). Evidence: `artifacts/a4-storage.md`,
`artifacts/a4d-memory.md`. The latency gates at 200 MP are still open.

**Phase 2 in `integration`, each item with engine, UI, three-browser e2e and German UI:**
- Text: CanvasKit, point and area text, typography, OpenType, missing-font handling. Identical pixels in all three browsers.
- Vector: parametric shapes, pen, direct selection, booleans, vector masks, line markers.
- Layer styles: drop shadow, stroke, outer glow, colour/gradient overlay. PSD import.
- Export As: one pipeline for PNG/JPEG/WebP/AVIF/TIFF, @1x/2x/3x, per artboard/layer, size preview. Artboard tool with presets.
- Adjustments: Basic, Colour Lookup (.cube), Colour (B&W/balance/selective), photo filter, channel mixer and more. Smart filters
  as a live stack (sharpen, high pass, denoise). Dodge/burn/sponge as brush modes.
- Embedded/linked content: Place, Replace Contents, Edit Contents, SVG. PDF only through a host capability, because the
  Fernwork PDFium build is `releaseApproved: false`.
- Object selection: SlimSAM (Apache-2.0), downloaded only after a user action. Refine Edge, Quick Mask, Colour Range.
- Colour panel, swatches (.aco/.ase), recent colours, eyedropper everywhere (screen eyedropper via host capability).
- 16-bit throughout: brush family, destructive ops, 16-bit ICC import.
- PSD open/import: honest native fidelity 67 % (M14). The target of 90 % is not reached.

**Core-task benchmarks (A9):** 13 green / 7 red (Phase 0: 1, Phase 1: 2). All red tasks need Phase-3 items: PSD write, CMYK
soft-proof, RAW, recipes/batch, text on path, mesh warp, and the 30-layer 200-MP run needs more disk. Evidence:
`artifacts/benchmarks.md`.

**Found and fixed by own checks, QA and benchmarks** (each with a test):
- data loss: guides in history, TIFF/ICC reopen, recovery race on save;
- two A4b regressions (lost strokes, eviction thrash: effects p95 3.4 s → 2.3 ms);
- CSP turning off the GPU renderer;
- the Tauri build shipping no fonts or models;
- Windows scratch index (fsync on a read-only handle);
- align on vector layers and artboards;
- effect sizes on oversampled text;
- inside stroke without fill;
- smart-object perspective;
- PostScript font names;
- a denoise that was too weak;
- mask polarity. Integrator decision: Photoshop's "Reveal Selection" instead of the Mac original's inverse.

**Open after Phase 2:**
- PSD native fidelity from 67 % to 90 %. The remaining gaps: HDR/32-bit, blend-if, non-RGB adjustment ordering, pattern/bevel
  effects.
- Object-selection encoder takes 14–22 s on single-thread WASM (needs WebGPU or threads with COOP/COEP).
- WebKitGTK brush Pro budget (M10); navigation/stroke latency at 200 MP.
- Two CanvasKit instances when text and vector tools are both used.
- PDF placement waits for an approved PDFium build.
- Windows re-check of the scratch-index and bundled-fonts fixes.
- Screen eyedropper on Windows not yet verified by hand.

## Phase 3, performance rounds and UI v0.2 — 2026-09-25/26

Phase 3's named feature scope is merged. The automated phase exit is not complete: the current core-task capability
state is 19 green / 1 red, task 13 still lacks the packaged Pro/Tauri 200-MP **30-layer** save/reopen proof, and the
A9 user test remains owner-deferred. The 2026-09-26 benchmark run observed 18 passes, task 13 red and task 7 skipped
because no local SlimSAM model files were present; see `artifacts/benchmarks.md`.

**Phase 3 features (implementation commits):**

- Mesh Warp, Perspective, Straighten and Liquify light: `20effa7` (`artifacts/warp.md`).
- CMYK soft proof and TIFF/JPEG export: `57490af`; exact Little CMS transform follow-up: `f6887a3`
  (`artifacts/cmyk-exact.md`). No redistributable output profile was added.
- Brush presets, dynamics and `.abr` tips: `779604a`.
- Local Remove (optional MI-GAN) and 2x/4x Upscale (optional Real-ESRGAN), with user-initiated downloads and offline
  fallbacks: `c4115f6` (`artifacts/genai.md`).
- Text on a path and Warp Text: `874a20a`; Recipes and File > Batch: `ba5f481`.
- Browser DNG plus optional Tauri host RAW paths: `84e581f`, hardened by `4f23b58` (`artifacts/raw.md`). System LibRaw
  remains opt-in and no LGPL library is bundled.
- Remaining live layer styles: `a1e1150`, corrected by `8d7ef88` (`artifacts/layer-styles-2.md`).
- Layered PSD/PSB writing: `73d6caf`/`d598034`, completed for editable Phase-3 structures and 16-bit precision by
  `69f74c8` (`artifacts/psd-write.md`). Photoshop itself is unavailable here; independent `psd-tools`/`ag-psd` and
  read/write/read state/pixel checks are the compatibility evidence.
- Non-destructive crop, Reveal All, artboard crop and embedded-layer crop: `09699b9` (`artifacts/crop.md`).

**PSD read fidelity and M15.** Twelve fidelity rounds bring the native product render to **248/300 = 82.7%**. The
binding M14 rule never uses the PSD's saved composite as the render oracle. M15 replaces the old blanket 90% exit:
the target is every fixable deviation, with the current measured ceiling **267/300 = 89.0%**. A later 90% target would
need owner approval for a separate text/effect antialiasing tolerance. Evidence: `artifacts/psd-fidelity.md`,
`artifacts/psd-target.md`; target documentation commit `4d13092`.

**Performance rounds (measured results, not generic claims):**

- `469021e`: brush workers capped to four physical cores; SlimSAM gained WebGPU/threaded-WASM selection; text and
  vector share one CanvasKit instance, saving **128 MiB** WASM heap and **7,317,645 bytes** of transfer. Contended
  SlimSAM WebGPU encoder measurements were 5.17–6.17 s, still above the 3 s target (`artifacts/perf2.md`).
- `430f45d`: selected brush/eraser strokes stay off the main-thread raster path. Intel selected-event p95 fell
  **86–92%** and committed pixels stayed byte-identical to independent CPU replay (`artifacts/perf3-webkit-brush.md`).
- `a87fea6` and `e085d16`: retained frames, visible-chunk upload and view LOD. The measured visible texture working set
  fell **363.00 → 90.75 MiB** and unchanged-frame p95 **2.24 → 0.07 ms** in Chromium (`artifacts/perf-view.md`,
  `artifacts/perf-view-2.md`).
- `fdade6f` and `ae1497c`: adjustment/filter previews moved to compositor/view-space passes. Steady Chromium live-
  filter p95 is **5.61 ms** and preview versus exact Apply differs by at most **1/255** (`artifacts/perf-tools.md`,
  `artifacts/perf-filters.md`).
- `6b35fbf`: fine-grained React subscriptions; pan, opacity and brush input render **zero** layer rows/thumbnails
  (`artifacts/perf-ui.md`).
- `28daa6c` and `76ddb40`: staged startup, background image decode, binary/lazy native I/O, PSD workers and streamed
  PNG. Import heartbeat gaps fell to 10–12 ms; PSD main-thread gaps fell 85–99%; the 46-MP stream avoids
  **183,877,632 bytes** of complete output allocation (`artifacts/perf-io.md`, `artifacts/perf-io-2.md`).
- `0ae302b`: moving-pixel and retouch pointer-event p95 fell 98.0–99.99%; exact Clone commit remains synchronous at
  roughly 582–630 ms (`artifacts/perf-retouch.md`).

Open performance gates are explicit: warm Lite 46-MP PNG meets ≤8 s, but Pro ≤3 s and the cold run do not;
WebKitGTK brush ≤16 ms remains open (M10); task 13's 30-layer native workflow remains open. Real Tauri/GPU measurements
were not repeated under Xvfb.

**UI v0.2.** Merge `8d9976b` (implementation `6cfe761`, layout follow-up `ff0edc9`) adopts the Fernwork PDF visual
language while retaining image-editor/Photoshop conventions: full-bleed canvas, floating top/options/tool/panel/status
cards, panel resize/toggle, Tab and Shift+Tab chrome controls, desktop/tablet/phone layouts, light/dark token themes,
and live host theme overrides. The editor fills its mount element and exposes `fw-image-editor` plus `--cmp-*` tokens;
no web font or network request was added. Evidence: `tests/e2e/floating-chrome.spec.ts`, `artifacts/ui-v2.md`.

**Licensing and test selection.** Commit `e82f033` adds generated notices, 546-entry offline inventory, 20 complete
licence texts, checker and searchable About/Preferences UI (`artifacts/licensing.md`). The repository is BSL 1.1;
MPL-2.0/Unicode-3.0 are restricted to the Tauri runtime and opt-in LGPL host capabilities remain unbundled. Tauri
stays internal pending M13 legal advice. Commit `ee05a58` adds smoke, changed, area and capped gate commands plus a
16-area manifest whose unit test requires every E2E spec to be assigned (`artifacts/e2e-sets.md`).

## Current verification (2026-09-26 documentation update)

| Suite | Result |
|---|---|
| TypeScript (`npx tsc --noEmit -p .`, whole project) | clean |
| Unit (`npx vitest run tests/unit --maxWorkers=2`) | 95 files / 807 tests passed in 69.84 s; the 4000×3000 TIFF case passed in-suite |
| Core-task benchmarks, Chromium, one worker | 18 passed, task 13 red, task 7 environment-skipped, 13.0 min (`artifacts/benchmarks.md`) |
| `npm run test:e2e:changed`, Chromium, one worker | No area matched the docs/benchmark-only diff, so the selector explicitly used smoke: 22 passed in 2.5 min |
| `npm run test:e2e:smoke`, Chromium, one worker | 22 passed in 2.8 min |

The benchmark start load was 14.33/10.11/6.46; unit start load was 10.35/9.95/9.52. Durations are execution context,
not performance claims. Task 7 was skipped because neither `FERNWORK_SLIMSAM_DIR` nor a `/tmp/slimsam.*` model pair
was present; it is not counted as a pass. Full Chromium and Firefox/WebKit suites were not run in this lane under the
change-relevant test-set rule; integration retains responsibility for the complete matrices.

## Integrator's own checks with unseen files

Files that no lane saw: ImageMagick conversions of a reference photo with system ICC profiles, plus a real camera HEIC
found elsewhere on the machine. Values are mean |Δ| to the sRGB original; "raw" is the error without any conversion.

| File | Result | Raw |
|---|---|---|
| AdobeRGB PNG | 0.61 | 10.1 |
| AdobeRGB JPEG | 2.62 | 10.1 |
| ECI TIFF | 0.23 | 8.5 |
| ProPhoto 16-bit TIFF | 0.76 | 11.3 |
| CMYK TIFF | 6.69 | 17.0 |
| CMYK JPEG | 6.96 | 17.0 |
| Camera HEIC | 0.38 | — |

- **CMYK:** the residual reflects FOGRA39 gamut limits.
- **Blur:** Gaussian blur (σ 8) against ImageMagick in the image interior gives mean 0.50, max 1.
- **Found by these checks, then fixed:** the CMYK JPEG was at 27.2, and Firefox did not convert AdobeRGB JPEGs.

## Performance (real GPU)

| Measurement | Result | Target |
|---|---|---|
| Pan, 4096² × 10 layers (167 Mpx), p95 | 4–7 ms | ≤ 33 ms |
| Zoom, p95 | 2–5 ms | ≤ 33 ms |
| Pan at 200 %, p95 | 1–4 ms | ≤ 33 ms |
| Brush feedback, 300 px soft brush on an 84 Mpx document, even / irregular samples, p95 | 3–11 ms / 3–9 ms | ≤ 16 ms |
| First brush sample | 14–22 ms | ≤ 50 ms |
| Main-thread time at pointer-up | < 1 ms | ≤ 16 ms |
| Stroke committed (worker) after pointer-up; the GPU preview stays visible meanwhile | ≈ 0.25–0.37 s on a quiet system; up to 0.41 s measured under load (load average ≈ 6) | regression guard ≤ 0.4 s (load-sensitive) |
| JS heap for the 4096² × 10 scene | ≈ 756–803 MB | — |

The brush preview runs on the GPU (a port of `MetalBrushCoverage`); the exact raster is built incrementally in a
worker. Node engine timings are in `artifacts/performance/core.json`, and the latest browser run is in
`artifacts/performance/browser-perf-gpu.json`.

## Screenshots

In `artifacts/screenshots/`:
- Acceptance views: desktop, tablet, phone portrait, phone landscape.
- Visual tour, desktop: layers, transform, selection, brush, Levels, Hue/Saturation adjustment layer, color picker,
  Gaussian Blur, German start screen.
- Visual tour, phone: brush, layers sheet, Hue/Saturation panel.

## Deviations (summary; full list in `parity.json`)

Apple-only parts are replaced by the nearest available alternative:

| Apple part | Replacement |
|---|---|
| GPU renderer | WebGL 2, with a CPU/Canvas 2D fallback when WebGL 2 is missing |
| HEIC decoding | Browser codec; otherwise a host OS codec (Tauri); otherwise an opt-in LGPL WASM decoder |
| ColorSync | Little CMS for PNG, TIFF and tagged JPEG (libjpeg-turbo decoder, incl. CMYK), identical in all browsers |
| Vision (subject masks) | U²-Netp ("Fast") and BiRefNet_lite ("Best quality", 200 MB download) |
| Core Image blurs | True Gaussian and Gaussian-weighted directional blur |

Browser limits that remain:
- ⌘N/⌘W → ⌥⌘N/⌥⌘W.
- Page close offers only the browser's generic "leave page?" prompt.
- Save overwrites a chosen file only in Chromium.

## Open points / suggestions for integration

1. **Fernwork host adapter.** Implement `HostAdapter` (and optionally `saveFileAs`/`saveFileTo` from
   `FileTargetHost`) with native dialogs in Tauri/Electron.
2. **Memory.** A 4096² × 10 document uses about 0.8 GB of JS heap and about 0.85 GB of GPU textures. For mobile targets
   consider a lower document budget than upstream's 100 Mpx.
3. **Self-host the best-quality subject model.** It is 200 MB, and the default URL points at Hugging Face. On devices
   without WebGPU it is slow (≈ 36 s) and memory-hungry (≈ 3 GB).
4. **Bundle size.** The main chunk is about 1 MB minified (≈ 310 KB gzip). The U²-Netp model (4.6 MB) and the ONNX
   runtime load only on first use of Remove Background.
5. **HEIC in the Tauri app.** Implement `decodeImage` with OS codecs (sketch in `docs/tauri-heic.md`).

## Licences

- **Upstream:** MIT (`LICENSE.upstream`).
- **Copied upstream C kernels:** MIT; see `THIRD_PARTY_NOTICES.md`.
- **Little CMS:** MIT. **BiRefNet_lite:** MIT (downloaded at runtime). **libheif/libde265:** LGPL-3.0, optional and off by default.
- **U²-Netp weights:** Apache-2.0 (`MODEL_LICENSES.md`, pinned SHA-256).
- **ONNX Runtime Web:** MIT.
- **Runtime npm dependencies:** MIT or ISC (react, pixi.js, zustand, immer, idb, fflate).
