# PFILTERS — view-space filter previews

## Result

Live and destructive pixel-filter previews no longer run an unbounded native-resolution worker/kernel for every UI change when WebGL2 is available. `GpuCompositor` now evaluates Gaussian Blur, Motion Blur, Add Noise, Lens Correction, Unsharp Mask, Smart Sharpen, High Pass, and Denoise on an expanded view-sized surface. CPU filtering remains the exact Apply/export path.

The destructive edit state publishes runtime-only `gpuFilterPreview` metadata through `documentWithPixelFilterPreview`; `setFilterViewPreviewEnabled` selects that path only while a GPU canvas exists. Slider updates then notify the document without creating a worker or installing a raster override. Apply still calls the tiled `filterPixelJob` with expansion and selection handling. Software rendering retains the previous worker preview.

The GPU path preserves transparent boundaries, ordered filter stacks, source bit depth quantization, masks, clipping, crop, opacity, fill opacity, selection mixing, and blend mode. It uses direct finite Gaussian taps for small grids and the CPU Young–van Vliet impulse response when the CPU bake selects its bounded IIR path. The upstream behavior reference is `Compositor/Document/Filters.swift`, `PixelFilter.run`.

Layer-style generation still needs native-grid filtered alpha. A filter+effect combination therefore has a counted CPU fallback for style-source generation, after which the visible layer filters in view space. A second exact, bounded fallback applies only to magnified live-filter layers of at most 128×128 pixels; it prevents a small icon at high zoom from becoming a much larger upsampled filter surface. The existing Chromium smart-filter workflow fell from a 90 s timeout to 16.5 s with that bound.

New diagnostic counters are `viewFilterLayers`, `viewFilterPasses`, and `cpuLiveFilterFallbacks`. Dynamic render targets distinguish RGBA16F compositor surfaces from RGBA32F filter surfaces, and shader resources are detached before pooled textures are destroyed.

No dependency, licence, contract, or i18n changes were made.

## Pixel evidence

`tests/e2e/filter-gpu.spec.ts` compares GPU output against the independent CPU bake; the oracle is never generated from GPU output. At 1:1 in both Chromium and Playwright WebKit, every individual filter and an ordered Gaussian→Noise stack had maximum channel error **1/255**. The matrix includes non-zero Unsharp Mask threshold and transparent-boundary behavior. Mean absolute errors ranged from 0.0005–0.0459 byte in Chromium and 0.0010–0.0547 byte in WebKit.

The 1536×1536 destructive Gaussian preview used a 768×768 selection. The preview-versus-exact-Apply maximum was **1/255** in both engines; pixels outside the selection changed by **0**. Apply produced real document pixels and one exact committed raster.

## Performance method

The harness uses a 1536×1536 shared-tile RGBA8 raster, a 1280×800 viewport, six live Gaussian changes, and six destructive Gaussian slider changes. It counts `Worker` construction and full-raster `toPixelsNative` copies. The final harness explicitly separates first GPU-filter interaction, steady filter frames, slider handler time, and preview frame time.

Baseline was captured before implementation at uptime `up 7 min`, load `5.34, 3.74, 1.71`. Chromium used ANGLE/Mesa Intel HD Graphics 630 through the `perf-gpu` project; WebKit reported Apple GPU. The original baseline mixed its first interaction into the six-sample distribution, so cold-versus-steady comparison is labelled rather than presented as identical methodology.

| Measurement | Chromium baseline | Chromium final | WebKit baseline | WebKit final |
|---|---:|---:|---:|---:|
| Live filter median | 494.89 ms | 3.04 ms | 489.76 ms | 70.70 ms |
| Live filter p95 | 512.64 ms | 5.61 ms steady | 599.52 ms | 75.60 ms steady |
| Explicit first GPU-filter frame | not isolated | 577.79 ms | not isolated | 165.94 ms |
| Destructive slider update median | 811.40 ms | 0.23 ms | 1176.86 ms | 0.32 ms |
| Destructive slider update p95 | 882.08 ms | 0.71 ms | 1263.30 ms | 0.44 ms |
| Destructive preview frame median | not isolated | 1.73 ms | not isolated | 63.92 ms |
| Destructive preview frame p95 | not isolated | 2.31 ms | not isolated | 65.22 ms |
| Preview workers, six changes | 6 | 0 | 6 | 0 |
| Preview full-raster copied bytes | 56,623,104 | 0 | 56,623,104 | 0 |

Final Chromium uptime/load: `up 1:08`, `0.81, 3.20, 7.33`. Final WebKit uptime/load: `up 1:08`, `0.91, 3.10, 7.24`. The final Chromium steady median is 163× lower; WebKit is 6.9× lower. More importantly, the synchronous destructive input path is below 1 ms and creates no raster worker/copy in either engine.

Exact Apply took 1534.02 ms in the final Chromium run and 2034.16 ms in WebKit. Baseline Apply was 970.47/1334.22 ms, but that baseline did not include the later selection-preservation fixture, so these are not a controlled regression comparison. Apply intentionally remains CPU/tiled and outside the drag path.

## Verification

- GPU/CPU matrix, Chromium + WebKit: 2 passed; all maximum errors 1/255.
- Performance harness, Chromium `perf-gpu`: 1 passed; no worker/copy, selection outside delta 0, preview/commit delta 1.
- Performance harness, WebKit: 1 passed with the same structural and pixel assertions.
- Existing smart-filter workflow: Chromium 1 passed (16.5 s), WebKit 1 passed (10.3 s).
- Existing Gaussian Blur + Curves workflow: Chromium 1 passed on focused rerun (1.3 min); WebKit passed in the selected cross-engine batch.
- Existing effects and GPU-compositor workflows: six selected cross-engine assertions passed in the batch. The first overloaded Chromium batch also had three unrelated/slow UI timeouts; focused reruns above passed without changing timeouts.
- Targeted unit filters: 4 files, 24 tests passed.

Final verification:

```text
npx tsc --noEmit -p .
(no output; exit 0)

Test Files  92 passed (92)
     Tests  781 passed (781)
  Duration  76.44s
```

## Limits and work not done

- The first large RGBA32F view allocation still causes a visible cold frame on Chromium (577.79 ms in the final run). Filter shaders are linked/executed during compositor preparation, but allocating the first large precision surface remains driver-bound. Subsequent interactions meet the view-feedback budget; eliminating the allocation spike needs asynchronous size-aware target provisioning.
- The interactive Gaussian/IIR halo and taps are capped at 96 source pixels and the combined view halo at 256 target pixels. Extreme radii therefore remain a bounded visual preview; Apply/export is the exact CPU oracle.
- A layer with both live filters and layer effects retains the CPU style-alpha fallback. Removing it requires GPU-native distance-field/effect generation, which is outside this lane.
- Mesh-warped layers use the view-space filtered image, but mesh-local feathered crop coordinates were not given a new inverse-mesh solution.
- Real Tauri/WebKitGTK GPU measurement was not run because the task forbids starting the single-instance app without a Tauri-specific need. Playwright WebKit is the Linux-WebKit proxy measurement.
- No full browser suite or full Firefox/WebKit suite was run, per the test-load rule.

## Files

Shared implementation files changed minimally: `src/core/filters/editing.ts`, `src/render/gpuCompositor.ts`, `src/render/liveFilterPasses.ts`, `src/render/shaders.ts`, and `src/ui/canvas/CanvasView.ts`. New filter shader/conversion code is isolated in `src/render/gpuFilterPasses.ts`. Tests are in `tests/unit/filter.test.ts`, `tests/e2e/filter-gpu.spec.ts`, and `tests/webview/perffilters-*`.
