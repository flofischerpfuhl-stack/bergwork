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
