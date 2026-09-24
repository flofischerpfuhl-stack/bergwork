# Handoff: Compositor browser port

Upstream: Compositor (macOS, MIT) at `a19db9011282399785dc18efcfded904627bdcc2`. Port: TypeScript 7 strict, React 19,
PixiJS 8 / WebGL 2, Web Workers + WASM (upstream C kernels), Vite 8. Standalone package; Fernwork's existing editor is
untouched and `contracts.ts` is unchanged. Per-feature status and every known deviation are in `parity.json`. Build,
test and architecture notes are in `README.md`.

All figures below were measured on 2026-09-23 on the reference machine (Intel HD Graphics 630, ANGLE/OpenGL, Chromium
headless with GPU, 1440×900 at dpr 1).

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

## Tests (current master)

| Suite | Result |
|---|---|
| TypeScript (`tsc --noEmit`, whole project) | clean |
| Unit (Vitest, 36 files) | 347 passed |
| Browser e2e, Chromium | 51 passed, 1 skipped (best-quality subject model not downloaded locally) |
| Browser e2e, Firefox + WebKit (`E2E_ALL_BROWSERS=1`) | 91 passed, 1 skipped: Firefox drops `clipboardData` on synthetic paste events, a test artefact |
| Acceptance specs (research/compositor-port/acceptance) | 5 passed |
| Official runner gates (sandboxed: typecheck, build, unit, e2e, perf, acceptance) | all passed, contract unchanged; 5 e2e specs skipped (reference photos and the downloaded best-quality model are absent in the sandbox); see `artifacts/runner-gates.json` |

The subject-removal and visual-tour specs use reference photos outside the repository and are skipped when they are
missing. In the sandboxed gates they are therefore skipped.

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
