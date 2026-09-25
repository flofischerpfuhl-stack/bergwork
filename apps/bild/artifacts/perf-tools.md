# PERFTOOLS — editing tools and operations performance audit

Date: 2026-09-25. Baseline: `430f45d` (the integrated PERF3 selected-brush work). The measured workload uses a
2048×2048 RGBA8 pixel layer, ten warmed Hue/Saturation slider updates, one exact Apply, and 80 metadata history edits
over a logical 16384×16384 tiled raster. The large history raster deliberately shares one immutable tile so the test
measures accounting traversal rather than memory bandwidth. `tests/webview/perftools-performance.spec.ts` records worker
creations, source bytes materialised, raster texture uploads, document notifications, frame/event distributions,
long tasks where the engine exposes them, history scan counters, and pixel parity.

Chromium `perf-gpu` reported `ANGLE (Intel, Mesa Intel(R) HD Graphics 630 (KBL GT2), OpenGL ES 3.2)`. WebKit on
Xvfb reported `Apple GPU`; these WebKit numbers are Linux/WebKit/llvmpipe-relative evidence, not a real Tauri/Intel
presentation measurement. No window was opened on the owner's display.

## Ranked findings and decisions

1. **Destructive Levels/Hue preview rebuilt the full raster for every input (implemented).** `updateLevelsEdit` and
   `updateHueSaturationEdit` created a new worker, synchronously flattened the complete source, terminated the previous
   worker, then uploaded a complete result for every slider move. Ten 2048² moves created 10 workers, copied 160 MiB on
   the main thread, and caused 10 full-raster uploads. A transient clipped adjustment layer now runs in the existing
   compositor at view resolution. The stored document is untouched, a selection becomes the transient adjustment mask,
   and an already-clipped target conservatively retains the old worker fallback because the renderer does not support a
   clipping stack rooted at another clipped child. Apply remains the exact full-resolution CPU-worker path.

2. **History's memory cap ignored shared raster identity while scanning (implemented).** Snapshots already share immutable
   rasters and tiles; there were no full-layer undo copies. The expensive part was `retainedBytes`: every trim walked both
   documents of every command, then every layer/raster/tile again. It now deduplicates document and raster identities
   before visiting resident tiles. `HistoryPerformanceCounters` exposes cumulative scans, documents, rasters, tiles,
   trimmed entries, and scan time. The 80-edit workload visits 327,680 tiles rather than the baseline algorithm's inferred
   26,869,760 (81.99× fewer) while retaining the same 0 bytes for metadata-only edits.

3. **Pixel workers flattened and re-tiled exact results (implemented).** Adjustment/filter workers converted a finished
   tiled raster to one contiguous buffer; the main thread then looped over every sample to construct the same tiles again.
   `PixelWorkerResponse` now transfers the worker's immutable tile buffers directly. This applies to destructive
   adjustments and filters, supports RGBA8/RGBA16 and null tiles, and does not change the synchronous fallback.

4. **Live filters still execute full-resolution CPU kernels synchronously on a cache miss (not implemented).**
   `LiveFilterHookAdapter.raster` calls `applyLiveFilters` during composition. Any filter-array change invalidates the
   identity cache, so a Gaussian/unsharp/denoise drag can block the render call and materialise full rasters. Expected
   gain: comparable to the adjustment-preview win for large layers. Effort: high; implement native view-space GPU passes
   (including halo/boundary rules) while keeping CPU bake/export as the exact oracle.

5. **Destructive filter dialogs still start/cancel a full-raster worker per input (not implemented).** The worker keeps
   this computation off the main thread, but `filterPixelJob` still performs the source flatten on each request and worker
   churn discards completed work. Expected gain: high for Gaussian Blur, sharpening, denoise and lens correction. Effort:
   medium/high; use a view-resolution compositor preview per filter, then the tiled worker protocol for exact Apply.

6. **Moving selected pixels rebuilds the selected patch on every pointer move (not implemented).** `movePixels` calls
   `renderPixelMove`, clears the source selection again and resamples/composites the lifted raster for every event. Expected
   gain: high for megapixel selections. Effort: medium; render the cleared base plus a geometry-only lifted overlay and
   rasterise once on pointer-up.

7. **Smudge/liquify/blur and clone/heal remain synchronous regional CPU paths (not implemented).** They are correctly
   bounded to touched regions and copy-on-write tiles, unlike the old full-canvas design, but large tips or dense coalesced
   moves can still exceed 50 ms. Expected gain: medium/high in WebKit for large tips. Effort: high; a geometry preview or
   worker needs stroke-state continuity and exact CPU replay. PERF3 already covers ordinary brush/eraser/dodge/burn/sponge
   GPU preview, so it was not duplicated here.

8. **Content-aware fill has several full buffers, but is a one-shot worker operation (not implemented).** Preparation
   creates straight and premultiplied source copies plus coverage; inference also receives copies. Expected gain: medium
   memory reduction, low interaction gain. Effort: medium; transfer tile/coverage ownership or use shared buffers where
   isolation permits.

Selection marquee/lasso drafts, free transform, mesh warp handles and marching ants do not rasterise the full layer per
move. Selection outlines are identity-cached. Object selection already caches its embedding and runs inference off-thread.
No applicable existing WASM kernel replaces Levels/Hue; the available pixel kernels cover other operations, while the new
GPU preview removes these slider computations entirely from the CPU hot loop.

## Before/after measurements

One unmeasured preview warms the worker/shader. Each row is one process on the shared machine, not an average. `event` is
the awaited product update (baseline includes its full worker preview; after includes the scheduled compositor preview),
and `frame` is `CanvasView.renderNow()` including GPU completion. Times are milliseconds over ten updates.

### Chromium `perf-gpu` / Intel HD 630

Baseline start: `16:36:04 up 8:27, load average 10.52,11.11,9.00`.
After start: `16:35:28 up 8:26, load average 12.05,11.41,9.00`.

| measurement | before | after | change |
| --- | ---: | ---: | ---: |
| event median | 1680.04 | 16.31 | -99.0% |
| event p95 | 2035.14 | 25.82 | -98.7% |
| frame median | 86.74 | 15.84 | -81.7% |
| frame p95 | 147.34 | 25.92 | -82.4% |
| workers / 10 moves | 10 | 0 | -100% |
| source copied / 10 moves | 160 MiB | 0 MiB | -100% |
| raster uploads / 10 moves | 10 | 0 | -100% |
| exact Apply | 2417.53 | 1643.87 | -32.0% |
| whole-scenario long tasks | 11 / 8125 ms | 2 / 2031 ms | -75.0% duration |
| 80 history edits | 456.97 | 9.01 | -98.0% |

### WebKit / Xvfb llvmpipe

Baseline start: `16:36:34 up 8:27, load average 9.53,10.77,8.95`.
After start: `16:35:39 up 8:27, load average 11.09,11.23,8.98`.

| measurement | before | after | change |
| --- | ---: | ---: | ---: |
| event median | 4199.88 | 29.72 | -99.3% |
| event p95 | 4746.16 | 50.08 | -98.9% |
| frame median | 158.48 | 41.40 | -73.9% |
| frame p95 | 171.00 | 88.02 | -48.5% |
| workers / 10 moves | 10 | 0 | -100% |
| source copied / 10 moves | 160 MiB | 0 MiB | -100% |
| raster uploads / 10 moves | 10 | 0 | -100% |
| exact Apply | 5827.04 | 4362.64 | -25.1% |
| 80 history edits | 560.58 | 13.34 | -97.6% |

WebKit does not expose `PerformanceObserver` long-task entries in this harness. Its frame numbers remain above the 16 ms
Pro budget under llvmpipe, but slider feedback no longer waits seconds for a full-resolution worker result. The busy shared
host produced substantial run-to-run frame variance; allocation/worker/upload counts and the multi-order event reduction
were stable.

## Pixel and state correctness

- GPU preview versus the separately executed exact CPU-worker commit: maximum delta **1/255** in Chromium and WebKit.
- Selected Levels preview/commit: bytes outside selection unchanged; preview and committed bytes identical in the CPU
  reference test.
- Stored document contains no transient adjustment layer and no raster override during the compositor preview.
- Apply produces one undo item; Cancel leaves no document state behind.
- History retained-byte results are unchanged, including swapped-tile exclusion and zero-byte metadata history.

This follows M14: the measured preview comes from the compositor shader and the comparison comes from the exact worker
raster path; the reference is not generated from the measured GPU output.

## Verification

Focused results before the final full run:

- Unit (`adjust.test.ts`, `filter.test.ts`, `upstream-history-layers.test.ts`): **3 files, 38 tests passed**.
- Existing adjustment UI, Chromium + WebKit: **6 passed**.
- Adjustment GPU/CPU variants, Chromium: **1 passed**.
- PERFTOOLS matrix: Chromium `perf-gpu` **1 passed**; WebKit **1 passed**.

- `npx tsc --noEmit -p .`: exit 0, no output.
- Final unit run at `16:43:10 up 8:34, load average 12.93,14.17,11.32`:
  **91 files passed, 776 tests passed**, 91.00 s, including the 4000×3000 TIFF benchmark.

No dependency, licence notice, shared contract, i18n key, generated artifact or network behavior changed. Real
Tauri/WebKitGTK GPU measurements were not possible on Xvfb and were not attempted.
