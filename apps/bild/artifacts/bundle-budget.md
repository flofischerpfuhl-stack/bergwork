# Lite bundle budget (A10)

Measured 2026-09-25 with `npm run build`. The build plugin writes `dist/bundle-report.json` from Rollup/Rolldown's
module information; `scripts/check-bundle-budget.mjs` resolves `src/index.ts` through Vite's manifest and gzips the
written file. The hard gate is **400,000 bytes**, matching Vite's decimal kB display. No dependency was added.

## Result

| | Before | After | Change | A10 |
|---|---:|---:|---:|---:|
| Lite editor start chunk, gzip (written file, Node zlib) | 525.27 kB | 263.10 kB | -262.17 kB (-49.9 %) | ≤ 400.00 kB |
| Vite-reported gzip | 529.37 kB | 265.34 kB | -264.03 kB | ≤ 400.00 kB |

Baseline uptime/load: `up 3:57, load average 24.89, 26.70, 27.09`. Final measurement uptime/load:
`up 4:07, load average 30.51, 30.93, 29.60`. These are sizes rather than timing results; the load is recorded for
reproducibility.

## Every output at least 20 kB gzip

Names contain content hashes and therefore differ between builds. Sizes below use the written file with Node's gzip;
large unchanged WASM assets use the build report's same gzip calculation. Worker files are included even though Vite's
console only prints their uncompressed size. WASM/worker/lazy rows are emitted by the build but are not startup fetches.

### Before

| Gzip | Content |
|---:|---|
| 6,727.97 kB | ONNX Runtime Web WebGPU/SIMD JSEP WASM (AI, lazy) |
| 6,673.53 kB | ONNX Runtime Web asyncify WASM (AI fallback, lazy) |
| 2,963.64 kB | CanvasKit WASM (text/vector, lazy) |
| 1,273.30 kB | AVIF codec WASM (lazy) |
| 525.27 kB | **Lite start:** React DOM, Pixi compositor, project I/O, ag-psd + pako, TIFF/JPEG/HEIC/lcms, all Phase-2 feature installers and UI, export dialog, i18n |
| 397.38 kB | libheif WASM (opt-in HEIC capability, lazy) |
| 143.78 kB | WebP codec WASM (lazy) |
| 101.37 kB | Little CMS WASM (lazy asset, though its JS glue was in start) |
| 87.03 kB | JPEG codec WASM (lazy asset, though its JS glue was in start) |
| 41.52 kB | background-removal worker |
| 40.45 kB | object-selection worker |
| 39.94 kB | CanvasKit JS/text engine loader |
| 36.77 kB | shared session, selection/canvas operations, React and model code |
| 23.82 kB | image-operation kernels WASM |

### After

| Gzip | Content |
|---:|---|
| 6,727.97 kB | ONNX Runtime Web WebGPU/SIMD JSEP WASM (AI, lazy) |
| 6,673.53 kB | ONNX Runtime Web asyncify WASM (AI fallback, lazy) |
| 2,963.64 kB | CanvasKit WASM (text/vector, lazy) |
| 1,273.30 kB | AVIF codec WASM (lazy) |
| 397.38 kB | libheif WASM (opt-in HEIC capability, lazy) |
| 263.10 kB | **Lite start:** React DOM, Pixi compositor, project-tab core, layer UI/controller, i18n and CPU/GPU composition |
| 143.78 kB | WebP codec WASM (lazy) |
| 101.37 kB | Little CMS WASM (lazy) |
| 98.11 kB | PSD reader/writer, ag-psd and pako (lazy on PSD open/import) |
| 87.03 kB | JPEG codec WASM (lazy) |
| 41.52 kB | background-removal worker |
| 40.45 kB | object-selection worker |
| 39.94 kB | CanvasKit JS/text engine loader |
| 23.82 kB | image-operation kernels WASM |
| 20.91 kB | shared editor session, gradient/text/vector model, history and locks |

Feature chunks are individually below 20 kB gzip: adjustments 19.05, vector UI 18.44, project archive I/O 18.13,
text UI 17.31, vector commands 14.97, object-selection UI 13.82, painting 12.77, retouch 12.76, browser/Pixi
adapters 11.16, colour UI 9.13, embedded UI/engine 8.76, selection commands 7.10, Export As 4.93, and the remaining feature/codecs
0.30–6.78 kB.

## Split points and behavior

- The existing feature registry now owns dynamic imports for canvas operations, selection/object selection, painting,
  retouch, adjustments, subject removal, guides, layer styles, artboards, colour, and embedded content. Menu commands
  are lightweight first-use proxies. Tool selection awaits its installer before changing tools, so a first gesture
  cannot race an absent handler. New canvas setup callbacks are applied to an already-mounted canvas.
- Feature dependencies preserve the old installer order (for example retouch after selection, object selection after
  selection/painting/retouch, colour after painting). All enabled feature chunks are requested during an idle period,
  avoiding a normal-use delay without putting them into the startup graph.
- The existing text/vector startup stubs remain small and continue to load their CanvasKit-backed UI/renderers when a
  tool is selected or an opened document contains text/vector content.
- Export As uses `React.lazy` and is preloaded on idle. PSD, TIFF, HEIC, JPEG/lcms, WebP, AVIF and GIF code load only
  after their format is detected or selected. PNG/project ZIP support remains in the core because it is required for
  ordinary project open/save and first image import.

## Gate

`npm run test:perf` now runs `vite build`, the manifest-based `scripts/check-bundle-budget.mjs` gate, then the existing
performance tests. The gate fails if the manifest no longer identifies exactly one Lite editor start chunk or its
written gzip size exceeds 400,000 bytes.

## Verification

- `npx tsc --noEmit -p .`: passed with no diagnostics.
- `npx vitest run tests/unit`: **79 files and 659 tests passed** in 24.96 s.
  An earlier run under load had timed out in the brush-distance case and the allowed 4000x3000 TIFF benchmark; both
  passed in the final whole-suite run without changing a timeout or assertion.
- The deterministic archive-open race regression has **2 passing tests**. It checks that a loading tab is selected
  synchronously and that two concurrent opens retain request-order selection independent of completion order.
- The focused `.fwimg`/legacy `.zip` drop E2E run passed **2 tests in 40.6 s**. The required single full Chromium run
  completed **317 passed, 16 conditionally skipped, 3 timed out in 1.0 h** (starting load average 38.60, 39.79,
  36.90). The exact canvas-drop test and the adjacent new-tab drop test both passed. The three failures were the
  Invert, Threshold and Posterize adjustment cases reaching the unchanged 90 s timeout; rerunning only those cases at
  lower load passed **3/3 in 19.2 s**, with no assertion failure.
- `npm run test:perf`: the build and bundle gate passed at **263.10 kB gzip**. Existing CPU brush timing gates remained
  load-sensitive: **9/11 tests passed**; blank median/p95/finish were 34.46/81.91/137.67 ms and opaque were
  40.13/91.14/120.45 ms (load average 6.09, 8.49, 12.21). No limit, timeout or assertion was changed.
- `node node_modules/vite/bin/vite.js build --config src-tauri/frontend/vite.config.ts`: passed; the Tauri frontend
  start output was 290.24 kB gzip by Vite. Real-GPU Tauri measurement was not attempted on the invisible Xvfb display.

The only shared build surfaces changed are the appended `test:perf` step in `package.json` and the reporting plugin in
`vite.config.ts`. No dependency or licence-notice change was needed.
