# GPU-native CMYK and grayscale interaction

Date: 2026-09-26. Scope: PSD13/PSD14 native document-space colour behavior, A3/A7/A8, and the
retained canvas-view work in `perf-view.md` / `perf-view-2.md`.

## Result and APIs

- `GpuCompositor` no longer calls `cpuCompositeView` for managed CMYK Difference, Exclusion, or
  Subtract layers. The layer, filtered-layer, brush, and mesh-warp passes evaluate those modes on
  four inverted CMYK process components in GLSL. The result matches the PSD13/PSD14 CPU algorithm;
  that CPU implementation remains the independent oracle and the software fallback.
- Each document's 33³ RGB-to-CMYK table and 17⁴ CMYK-to-display table are uploaded once as nearest
  RGBA8 textures and retained by transfer identity. Manual trilinear and four-dimensional linear
  interpolation use the same sample order as `sampleCubeChannels` / `sampleCmykForward`. K is stored
  in the fourth texture component with browser premultiplication explicitly disabled.
- `psdColorMode` is retained on layered and flattened PSD imports. It lets the compositor distinguish
  managed CMYK and grayscale frames without changing `contracts.ts`; documents made by older callers
  remain compatible because the presence of `psdCmykTransfer` also selects CMYK.
- `GpuPerformanceCounters` adds `nativeCmykFrames`, `nativeGrayFrames`, and
  `cpuDocumentFallbacks`. The last counter is an explicit regression signal and remains zero in all
  new correctness and performance coverage.
- RGB documents bind the existing 1×1 neutral textures and take a false uniform branch. They do not
  construct or upload CMYK tables. The retained-frame cache key includes the PSD colour mode and
  transfer identity, preventing a cached display-space frame from crossing colour-space state.
- Grayscale documents already used the regular GPU layer graph and their one-component adjustment
  programs. Source-mode metadata and coverage now make that route explicit and verify that it never
  enters a document CPU fallback. Masks, clipping, pass-through/isolated groups, effects, adjustments,
  live filters, and brush previews continue through the same graph as RGB. The final proof/gamut LUT
  remains the single presentation pass.

No dependency, model, licence notice, i18n key, or shared contract changed.

## Pixel evidence

The managed `blend-modes/cmyk-blend-modes.psd` fixture exercises the PSD13/PSD14 process-space
Difference, Exclusion, and Subtract implementation. GPU readback differs from the unchanged CPU
oracle by at most **1/255**. The managed `gray-blend-modes.psd` fixture is also within **1/255**.
Five grayscale/CMYK profile-space adjustment fixtures pass the same one-byte bound.

The synthetic preview coverage keeps a CMYK Difference layer active while exercising a top paint
layer, CMYK Invert, and Gaussian Blur. The brush changes 7,454 output channels; live GPU versus exact
brush replay is compared premultiplied because soft-stroke straight colour is undefined near zero
alpha. The filter changes 1,474 channels and is within 1/255 of CPU. The compositor reports zero
document fallbacks throughout.

## 20 MP before/after measurement

The focused fixture is 5,000×4,000 with two occupied tiled layers and Difference at 72% opacity. Its
800×640 view exercises visible-chunk upload, 24 retained integer-pixel pans, 24 zoom frames, 24
unchanged cache hits, and 24 incremental brush-preview frames. Every measured frame calls
`gl.finish()`. The baseline is the integration commit `8b6b192`, run from an isolated clean worktree
with the identical probe. Baseline uses two iterations to keep the known CPU fallback bounded.

| Engine | Metric | Before | GPU path | Change |
|---|---|---:|---:|---:|
| Chromium perf-gpu / Intel HD 630 | pan p95 | 5,115.55 ms | 3.97 ms | 1,290× faster |
| Chromium perf-gpu / Intel HD 630 | zoom p95 | 5,053.49 ms | 1.90 ms | 2,660× faster |
| Chromium perf-gpu / Intel HD 630 | brush preview p95 | CPU fallback made interaction non-viable | 2.15 ms | within 33 ms budget |
| Chromium perf-gpu / Intel HD 630 | unchanged p95 | 5,089.97 ms | 0.015 ms | retained hit |
| Chromium perf-gpu / Intel HD 630 | RGB control pan p95 | 2.645 ms | 0.485 ms | no regression |
| WebKit / Xvfb | pan p95 | 1,932.46 ms | 10.60 ms | 182× faster |
| WebKit / Xvfb | zoom p95 | 1,604.18 ms | 10.22 ms | 157× faster |
| WebKit / Xvfb | brush preview p95 | CPU fallback made interaction non-viable | 4.14 ms | within 33 ms budget |
| WebKit / Xvfb | unchanged p95 | 1,593.64 ms | 0.020 ms | retained hit |
| WebKit / Xvfb | RGB control pan p95 | 4.64 ms | 1.16 ms | no regression |

The Chromium baseline began at uptime `up 19:25`, load average `1.28, 2.03, 2.91`; its final
implementation run began at `up 19:29`, load average `4.67, 2.63, 2.91`. The earlier WebKit result
is from the same paired run. Chromium used
`ANGLE (Intel, Mesa Intel(R) HD Graphics 630 (KBL GT2), OpenGL ES 3.2)`; Playwright WebKit reported
`Apple GPU`, so the WebKit figures are same-machine relative browser evidence rather than a claim
about a particular WebKitGTK hardware backend.

The warm RGB control was isolated from the multi-second CPU-CMYK baseline so both revisions receive
24 retained-pan samples within the unchanged 90-second test timeout. That baseline began at uptime
`up 20:05`, load average `5.29, 5.09, 4.50`; 24/24 pans reprojected on both engines. One attempted
combined Chromium run exceeded 90 seconds before producing a result; the timeout was not raised.

Structural counters are less load-sensitive: the final probe recorded 24/24 unchanged hits, 24 pan
reprojections, 27,440 exposed pan pixels, nine texture uploads, 100 native-CMYK requests, and zero
document CPU fallbacks. The PSD14 full 20 MP CPU measurement remains **158,606.5 ms**; the focused
viewport baseline above is intentionally the directly comparable navigation workload.

## Verification

- Focused 20 MP Chromium perf-gpu + WebKit probe: 2/2 passed in 1.1 minutes.
- Managed PSD GPU/CPU regression after the shader-name fix: 14/14 passed in 2.1 minutes; maximum
  CMYK and grayscale error was 1/255.
- The requested area command first passed 77/78 in 7.9 minutes. Its sole failure was the new
  soft-edge brush fixture at 3/255 against the existing 2/255 brush guard. The guard was retained and
  this CMYK-document coverage now uses the hard opaque stroke it intends to test; the focused rerun
  passed 1/1 in 30.9 seconds. The final changed-area superset then passed 82/82 in 9.1 minutes.
- Chromium smoke passed 22/22 in 2.0 minutes. The RGB 27-mode GPU/CPU audit in the area run retained
  maximum error 1/255 and mean error 0.016183/255.
- Focused PSD fidelity passed for CMYK (3 files/6 tests, 329.18 s) and grayscale (3 files/6 tests,
  273.73 s). The required unfiltered final corpus run passed 3 files/6 tests in 387.79 s. Its generated
  `artifacts/psd-fidelity.md` was restored because this lane does not own that report.
- Whole-project TypeScript completed with exit 0 and no diagnostics. The final unit run passed
  95 files and 815 tests in 76.86 seconds with `--maxWorkers=2`.

## Decisions and limits

- The process tables are immutable per imported document and small (about 467 KiB together), so a
  retained GPU upload is simpler and faster than rebuilding a 3D/4D approximation per frame.
- Native process blending is enabled only for the three modes for which PSD13/PSD14 established a
  CPU oracle. Other modes intentionally retain their existing RGB behavior; changing them without a
  Photoshop-backed oracle would violate M14.
- The four-component value lives in shader registers across the blend operation while RGB+alpha
  remains the established render-target format. This exactly mirrors the CPU oracle, preserves all
  RGB group/effect semantics, and avoids a second full-size attachment. Proof conversion remains at
  presentation.
- Cold table compilation/upload and first visible-chunk/LUT setup measured 1,677.43 ms in Chromium
  and 792.00 ms in WebKit. Warm interaction is below budget, but reducing this first-frame setup is
  useful follow-up work.
- A real Tauri/WebKitGTK GPU measurement was not attempted: the required invisible Xvfb session
  cannot represent the owner's real app/GPU. Playwright Chromium perf-gpu and WebKit are the requested
  browser measurements.

## Final command summaries

- `npx tsc --noEmit -p .`: exit 0, no diagnostics.
- `npx vitest run tests/unit --maxWorkers=2`: `Test Files 95 passed (95)`,
  `Tests 815 passed (815)`, `Duration 76.86s`.
- `npm run test:e2e:changed -- --project=chromium --workers=1`: `82 passed (9.1m)`.
- `npm run test:e2e:smoke -- --project=chromium --workers=1`: `22 passed (2.0m)`.
- `npm run psd:fidelity`: `Test Files 3 passed (3)`, `Tests 6 passed (6)`,
  `Duration 387.79s`.
