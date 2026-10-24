# PRETOUCH — moving pixels and regional retouch performance

Date: 2026-09-25. Baseline: `917f8ea`. The browser workload uses a 1536×1536 RGBA8 layer,
an 896×896 moved selection, 12 pointer updates, and 320 px tips for Smudge, Liquify,
Blur, Clone Stamp, and Spot Healing. Chromium `perf-gpu` reported `ANGLE (Intel, Mesa
Intel(R) HD Graphics 630 (KBL GT2), OpenGL ES 3.2)`. WebKit under Xvfb reported
`Apple GPU`; its values are relative WebKit/JSC/llvmpipe evidence, not a real
WebKitGTK/Tauri/Intel measurement.

## Implementation

- Selected-pixel movement now lifts the selected patch and clears the base exactly once at
  pointer-down. Each move changes only the rounded offset. `documentWithPixelMovePreview()`
  supplies an isolated transient group containing the cleared base and geometry-placed lifted
  patch; the exact existing CPU resample/composite runs once at pointer-up. Layer opacity and
  masks remain outside the transient group and therefore apply once to the combined pixels.
  Warp/crop/live-filter layers conservatively retain the old raster preview path.
- Smudge, Liquify, Push/Bloat/Pucker/Reconstruct, and the Blur tool record immutable point
  batches while the overlay canvas shows the stroke footprint. Pointer-up dispatches the
  unchanged `WarpStroke`/`BlurStroke` rasterizer to a module worker; changed tile buffers alone
  return to the main thread. `waitForRetouch()` is the document-stability boundary, and the
  session remains busy until the exact result is installed as one undo item.
- Clone Stamp records geometry and displays the same lightweight footprint. Its arbitrary source
  sampler is intentionally replayed by the unchanged CPU brush rasterizer at commit. This removes
  synchronous work from pointer moves but does not yet remove the pointer-up stall.
- Spot Healing records raw point/pressure batches and displays the 45% dark geometry wash. A
  dedicated worker replays those raw samples with the unchanged CPU brush and transfers its
  coverage raster to the existing asynchronous healing kernel. Raw replay is deliberate: an
  initial attempt to reuse settled brush geometry differed from the independent oracle in 505
  output bytes and was rejected.
- No stored document is mutated by a preview. Cancel remains identity-preserving. No dependency,
  licence notice, shared contract, i18n key, generated artifact, or network behavior changed.

New/changed APIs are `documentWithPixelMovePreview()`, `currentRetouchGeometry()`,
`waitForRetouch()`, `lastRetouchWorkerTiming`, `currentDeferredBrushGeometry()`, and
`currentSpotHealingGeometry()`. The two worker protocols are private implementation boundaries.

## Before/after measurements

Values are p95 milliseconds over 12 pointer updates. The baseline run started at `21:32:03 up
18 min`, load averages `7.74, 6.37, 4.09`. The final Chromium run started at `21:48:57 up 35 min`,
load averages `15.96, 15.87, 11.76`; the final WebKit run started at `21:47:18 up 33 min`, load
averages `18.01, 16.19, 11.39`. The final host was substantially busier, so latency improvements
are conservative and completed-worker throughput is not treated as a stable speed comparison.

| Engine | Operation | Pointer event before → after | Frame before → after |
| --- | --- | ---: | ---: |
| Chromium / Intel GPU | move selected pixels | 356.98 → **1.18** | 69.14 → 60.65 |
| Chromium / Intel GPU | Smudge | 26.58 → **0.05** | 0.30 → 0.48 |
| Chromium / Intel GPU | Liquify | 104.12 → **0.01** | 0.31 → 0.70 |
| Chromium / Intel GPU | Blur tool | 1,342.24 → **0.01** | 0.30 → 1.56 |
| Chromium / Intel GPU | Clone Stamp | 55.59 → **0.28** | 0.28 → 0.44 |
| Chromium / Intel GPU | Spot Healing | 61.21 → **0.85** | 0.37 → 1.69 |
| WebKit / Xvfb | move selected pixels | 578.80 → **0.74** | 118.64 → 51.20 |
| WebKit / Xvfb | Smudge | 55.04 → **0.06** | 0.98 → 0.94 |
| WebKit / Xvfb | Liquify | 107.98 → **0.02** | 1.20 → 1.16 |
| WebKit / Xvfb | Blur tool | 767.94 → **0.06** | 0.96 → 0.90 |
| WebKit / Xvfb | Clone Stamp | 52.98 → **0.44** | 1.34 → 1.04 |
| WebKit / Xvfb | Spot Healing | 42.86 → **4.04** | 0.86 → 1.72 |

Selected-pixel move event p95 fell 99.7% in Chromium and 99.9% in WebKit. Regional tool event
p95 fell 98.0–99.99%. The moved-selection frame still recomposites the visible stack because the
lifted geometry changes. Under the final heavy load it remained 60.65 ms in Chromium and 51.20 ms
in WebKit; a lower-load Chromium confirmation (`load 9.45, 6.22, 3.88`) measured 27.22 ms. The
important structural change is that no source raster is rebuilt or uploaded per move.

Exact replay is asynchronous for retouch and healing. Final pointer-up dispatch was 0.63–6.06 ms
in Chromium and 1.06–2.14 ms in WebKit. Completed 320 px replay remained deliberately expensive:
Smudge 1.92/2.52 s, Liquify 1.91/1.57 s, Blur 17.74/13.83 s, and healing 1.60/2.58 s
(Chromium/WebKit). The editor stays responsive and blocks conflicting document edits while these
jobs run. Clone commit remains synchronous at 582 ms Chromium and 630 ms WebKit; this is listed as
open work rather than hidden.

## Pixel and state correctness

- Moved GPU preview versus committed CPU raster: maximum delta **0/255** in both engines.
- Worker retouch versus a separately executed main-thread `WarpStroke`/`BlurStroke`: **zero byte
  differences** for Smudge, Liquify, and Blur in both engines.
- Deferred Clone Stamp versus a separately executed exact CPU clone stroke: **zero byte
  differences** in both engines; the independently known sampled pixel was `[24,84,160,255]`.
- Worker healing coverage plus existing healing kernel versus a raw-sample main-thread coverage
  replay and separate kernel invocation: **zero byte differences** in both engines.
- Unit coverage also compares the transient move group with the committed CPU document under a
  non-unit layer opacity and enabled mask; all bytes are equal. Undo/cancel and RGBA16 tests pass.

The measured previews and references are separate paths: transient GPU document geometry or
overlay geometry is measured; unchanged CPU rasterizers produce the reference. No measured output
is reused as its own oracle (M14).

## Verification and limitations

- PRETOUCH performance/oracle harness: Chromium `perf-gpu` **1 passed** in 1.0 min; WebKit **1
  passed** in 50.0 s.
- Directly affected workflow files across Chromium and WebKit: **23/26 passed**. All selection
  movement and Clone Stamp cases passed in both engines, and Spot Healing passed in WebKit. Three
  Chromium cases failed before their changed operation (ordinary brush export raced its existing
  background commit; Color Picker did not open; Magic Wand did not create a selection). Each
  repeated once with the same result; the corresponding WebKit cases passed. Assertions/timeouts
  were not weakened.
- Focused units before the final run: **5 files, 78 tests passed**; healing/RGBA16 confirmation:
  **2 files, 44 tests passed**.
- Final whole-project TypeScript and unit summaries are recorded below after the final verification
  run: `npx tsc --noEmit -p .` exited 0 with no diagnostics. At `21:51:05 up 37 min`, load
  averages `17.72, 16.80, 12.63`, `npx vitest run tests/unit --maxWorkers=2` reported **92 files
  passed, 780 tests passed**, duration 91.16 s. The 4000×3000 TIFF benchmark completed in the main
  run, so no isolated retry was needed.

Open work:

1. Clone's arbitrary rendered-canvas sampler is still not serialisable; move exact clone replay to
   a snapshot-based worker without changing All Layers/mask/blend sampling.
2. The moved-selection geometry still requires a full visible composite each frame. A retained
   base plus dirty lifted-patch pass should target the remaining 27–61 ms Chromium and 51 ms WebKit
   frame cost.
3. Warp/crop/live-filter pixel moves use the old raster preview for correctness.
4. Geometry previews show the affected footprint, not the final warped/blurred pixels. Exact pixels
   appear when the worker commit completes.
5. No real Tauri/WebKitGTK GPU measurement was made: Xvfb cannot expose the owner's Intel GPU and
   the Tauri app was not started.
