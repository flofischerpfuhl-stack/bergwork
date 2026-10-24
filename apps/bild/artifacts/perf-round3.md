# PERF4 — performance round 3 close-out

Date: 2026-09-26. Scope: the remaining UI, Clone Stamp, resident-raster LOD, PNG export,
and CanvasKit items from `perf-ui.md`, `perf-retouch.md`, `perf-view-2.md`, and
`perf-io-2.md`.

## Outcome and APIs

- The Layers panel virtualizes fixed-height rows at 100 or more simple layers (six-row
  overscan), retains scroll position per session, and keeps the already retained Layers/History
  subtrees mounted. Variable-height effect/filter rows conservatively use the complete list.
  Accessibility keeps full-set `aria-posinset`/`aria-setsize` values.
- `cachedMenus(controller)` memoizes the menu model by immutable document revision, selected
  project, feature revision, and menu-relevant UI state. Opening a warm menu does not rebuild the
  model. Popup placement updates the DOM in its layout effect, avoiding a second position-state
  commit.
- Clone Stamp now snapshots its source document and replays recorded point batches in the module
  worker. `DeferredCloneStroke.finishInBackground()` uses the existing pending-commit boundary;
  `lastCloneWorkerTiming` exposes dispatch/worker/total timing for the audit. Output tiles are
  transferred, and retained lossless source encodings are excluded from the snapshot.
- `GpuCompositor.prepareResidentLod(raster)` constructs the 1/8 resident LOD in a module worker.
  Automatic low-zoom use queues the same job, invalidates the retained viewport when it completes,
  and requests a redraw. Copies are yielded after at most 2 MiB. The worker handles both RGBA
  rasters and one-channel masks; `lastResidentLodTiming` reports copy/worker/total time.
- Interactive PNG export defaults to deflate level 1 (an explicit level is still exact and TIFF
  keeps level 6), uses up to eight bands, and filters the dominant RGBA8 path without copying each
  row to a temporary scanline. The filter heuristic samples a channel-balanced stride; decoded
  pixels are unchanged. Streaming and retained paths still emit identical bytes for the same
  request.
- Text and vector already called the same `loadSharedTextEngine()` singleton in the integrated
  tree. No second runtime existed to remove. The existing cross-feature singleton test and the
  browser CanvasKit audit passed with one 128 MiB WASM heap.

No dependency, licence notice, v1/v2 contract, translation key, network behaviour, or generated
artifact changed.

## Before/after measurements

Chromium used the `perf-gpu` project. WebKit is Playwright WebKit on Linux/Xvfb and is relative
browser evidence, not a real Tauri/WebKitGTK GPU measurement. The shared machine was busy, so the
bounded render/work counters and pixel comparisons are stronger than isolated wall-clock samples.

### UI, 400 layers

The previous audit used 80 layers and mounted 81 rows/thumbnails on every project-tab return.
The new fixture uses 400 layers and mounts 16 rows in the tested viewport; tab return rendered 17
rows/thumbnails. Layers/History switching rendered zero rows and zero thumbnails.

| Engine | Tab switch before (80 layers) | After (400 layers) | Warm menu model | Menu wall time, cold → cached |
| --- | ---: | ---: | ---: | ---: |
| Chromium | 194–316 ms; 81 rows | 134.77 ms; 17 rows | 1 → 0 rebuilds | 27.98 → 63.02 ms |
| WebKit | 131 ms; 81 rows | 59.26 ms; 17 rows | 1 → 0 rebuilds | 88.08 → 38.18 ms |

Start: `14:37:57 up 17:24`, load `12.34, 11.31, 9.10`. Chromium's warm-menu wall sample was
reversed by host noise even though the deterministic model work was removed. WebKit improved
56.7%. Earlier same-code tab samples were 77–85 ms Chromium and 64 ms WebKit; the final table uses
the combined run rather than selecting the fastest result.

### Clone Stamp worker commit

The 1536² stress case is byte-compared to a separately replayed synchronous stroke; the known
sample is `[24,84,160,255]` and the difference count is zero in both engines.

| Engine | Synchronous pointer-up before | Pointer-up dispatch after | Worker result ready |
| --- | ---: | ---: | ---: |
| Chromium | 582 ms | 0.87 ms | 507.10 ms |
| WebKit | 630 ms | 1.70 ms | 625.46 ms |

Chromium started at `14:26:30 up 17:12`, load `14.33, 10.11, 6.46`; WebKit at `14:27:27 up
17:13`, load `11.59, 10.31, 6.75`. The expensive work is now asynchronous rather than claimed as
a throughput win.

### Cold resident LOD and masks

The 8,256×5,568 fixture contains 46,137,344 source pixels. The worker result is 4.875 MiB versus
253 MiB for the full mipmapped texture. RGBA and mask LOD output differed from the independent CPU
box-average oracle by at most 1/255.

| Engine | Old synchronous LOD | Worker ready total | Largest main-thread heartbeat gap | Frame after ready |
| --- | ---: | ---: | ---: | ---: |
| Chromium | 495.40 ms | 3,020.19 ms | 66.28 ms | 59.75 ms |
| WebKit | 1,024.94 ms | 2,461.22 ms | 85.18 ms | 49.82 ms |

Chromium started at `14:28:34`, load `10.48, 10.26, 6.99`; WebKit at `14:28:59`, load
`10.58, 10.34, 7.11`. Total readiness is slower because the immutable raster must be copied without
detaching the live document, but construction/averaging no longer blocks for 0.5–1.0 seconds.
Automatic first use preserves pixels by drawing the full raster until the worker result is ready;
that fallback upload can still stall. Shared memory or a worker-owned residency protocol would be
needed to remove both the copy and that first fallback upload.

### 46 MP PNG

Both engines used eight transferable bands, began writing in 3–4 ms, avoided a 183,877,632-byte
full-output allocation, decoded to the expected pixels, and matched their retained pipeline bytes
exactly. The level-1 output was 54,558,759 bytes on this fixture (16.6% larger than the previous
level-6 Chromium fixture).

| Engine | Before streamed | After streamed | Pro target |
| --- | ---: | ---: | ---: |
| Chromium | 4,649 ms | 3,076 ms | missed 3,000 ms by 76 ms |
| WebKit | 5,207 ms | 2,702 ms | met |

Chromium started at `14:40:00 up 17:26`, load `13.72, 12.70, 9.92`; WebKit at `14:36:23 up
17:22`, load `9.53, 10.78, 8.71`. A native/shared-memory compressor remains the credible path to
a robust Chromium margin; weakening decoding or exact-byte comparisons was not accepted.

### Full-window interaction checks

The full-window `adjust-performance` run started at `14:38:47 up 17:25`, load `15.52, 12.36,
9.57`. Chromium measured median/p95/max 3.91/12.20/13.70 ms; WebKit measured
7.60/13.70/13.84 ms. Both stayed inside the 16 ms assertion. The focused navigation audit measured
pan p95 10.42 ms Chromium and 10.54 ms WebKit, below its 33 ms budget; the retained-pan comparison
remained within one half-float ULP.

## Verification

- `npx tsc --noEmit -p .`: exit 0, no diagnostics.
- `npx vitest run tests/unit --maxWorkers=2`: **95 files passed, 808 tests passed**, duration
  **46.50 s**. The 4000×3000 TIFF benchmark completed in this run.
- `npm run test:e2e:changed -- --project=chromium --workers=1`: **153 passed, 2 skipped** by
  existing project conditions, duration **15.0 min**.
- `npm run test:e2e:smoke -- --project=chromium --workers=1`: **22 passed**, duration **1.9 min**.
- Focused Chromium/WebKit audits passed for the 400-layer UI/menu case, Clone Stamp worker oracle,
  resident RGBA/mask LOD oracle, 46 MP export, full-window adjustment, and canvas navigation.

No Tauri process was started. A real Tauri/WebKitGTK GPU measurement was therefore not done, as
required for the Xvfb-only environment.

## Remaining limitations

1. Chromium's 46 MP PNG run is 76 ms above the 3 s Pro target under the recorded load; compression
   level 1 also trades 16.6% more bytes for latency.
2. Resident LOD completion is responsive but slower end-to-end, and automatic cold use may upload
   the full raster for the first frame while the worker builds the reduced copy.
3. Virtualization deliberately falls back for expanded effects/filter subrows until variable-height
   measurement and drag/drop coverage are added.
4. WebKit evidence is the Linux Playwright engine under Xvfb, not the Tauri WebKitGTK application.
