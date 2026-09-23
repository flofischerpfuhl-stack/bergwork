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

## Tests (current master)

| Suite | Result |
|---|---|
| TypeScript (`tsc --noEmit`, whole project) | clean |
| Unit (Vitest, 30 files) | 309 passed |
| Browser e2e, Chromium | 40 passed |
| Browser e2e, Firefox + WebKit (`E2E_ALL_BROWSERS=1`) | 71 passed, 1 skipped: Firefox drops `clipboardData` on synthetic paste events, a test artefact |
| Acceptance specs (research/compositor-port/acceptance) | 5 passed |
| Official runner gates (sandboxed) | see `artifacts/runner-gates.json` |

The subject-removal and visual-tour specs use reference photos outside the repository and are skipped when they are
missing. In the sandboxed gates they are therefore skipped.

## Performance (real GPU)

| Measurement | Result | Target |
|---|---|---|
| Pan, 4096² × 10 layers (167 Mpx), p95 | 4–7 ms | ≤ 33 ms |
| Zoom, p95 | 2–5 ms | ≤ 33 ms |
| Pan at 200 %, p95 | 1–4 ms | ≤ 33 ms |
| Brush feedback, 300 px soft brush on an 84 Mpx document, even / irregular samples, p95 | 3–11 ms / 3–9 ms | ≤ 16 ms |
| First brush sample | 14–22 ms | ≤ 50 ms |
| Main-thread time at pointer-up | < 1 ms | ≤ 16 ms |
| Stroke committed (worker) after pointer-up | ≈ 0.25–0.28 s | ≤ 0.3 s |
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

- **WebGL 2 required:** there is no software-rendering fallback.
- **HEIC:** decoded only where the browser supports it.
- **Remove Background:** uses U²-Netp (Apache-2.0) via ONNX Runtime Web instead of Apple Vision. It produces one fused
  subject map.
- **Core Image blurs:** approximated with box passes.
- **Colour:** sRGB only, no ICC conversion.
- **Browser limits:**
  - ⌘N/⌘W → ⌥⌘N/⌥⌘W.
  - Page close offers only the browser's generic "leave page?" prompt.
  - Save overwrites a chosen file only in Chromium (File System Access API).
- **Projects:** the contract ZIP is the default format. The Mac `.comp` format (v1–7) opens and can be saved as a copy.

## Open points / suggestions for integration

1. **Fernwork host adapter.** Implement `HostAdapter` (and optionally `saveFileAs`/`saveFileTo` from
   `FileTargetHost`) with native dialogs in Tauri/Electron.
2. **Memory.** A 4096² × 10 document uses about 0.8 GB of JS heap and about 0.85 GB of GPU textures. For mobile targets
   consider a lower document budget than upstream's 100 Mpx.
3. **WebGL-2 fallback.** A software-rendering fallback was not built. Evaluate whether Fernwork targets need it.
4. **Bundle size.** The main chunk is about 1 MB minified (≈ 310 KB gzip). The U²-Netp model (4.6 MB) and the ONNX
   runtime load only on first use of Remove Background.

## Licences

- **Upstream:** MIT (`LICENSE.upstream`).
- **Copied upstream C kernels:** MIT; see `THIRD_PARTY_NOTICES.md`.
- **U²-Netp weights:** Apache-2.0 (`MODEL_LICENSES.md`, pinned SHA-256).
- **ONNX Runtime Web:** MIT.
- **Runtime npm dependencies:** MIT or ISC (react, pixi.js, zustand, immer, idb, fflate).
