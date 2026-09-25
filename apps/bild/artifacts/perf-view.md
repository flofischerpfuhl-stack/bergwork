# PERFVIEW: canvas view and compositor audit

Date: 2026-09-25. Scope: `src/render/**` and `src/ui/canvas/**`. The Chromium run used the
Playwright `perf-gpu` launch flags and reported `ANGLE (Intel, Mesa Intel(R) HD Graphics 630 (KBL
GT2), OpenGL ES 3.2)`. The Linux WebKit run used the inherited Xvfb display; WebGL's debug string
was `Apple GPU`, so its values are treated only as same-machine relative numbers, not as proof of a
specific hardware backend.

## Result

Two user-visible costs were removed without changing pixels:

1. Interactive viewport frames can retain their final composite. A visual fingerprint covers the
   immutable layer list/resources plus resolved rasters, masks, transient transforms, blend preview,
   and brush revision. An unchanged frame now skips the layer/effect/adjustment passes. Export and
   readback views do not opt into this cache. Active brush previews retain their existing dirty-region
   path instead.
2. Raster and mask textures now upload only source chunks intersecting the current view. Previously,
   opening a small 100% view uploaded every occupied chunk in the document. Visited chunks remain warm,
   while chunk-level LRU eviction enforces the existing byte budget. Occupancy is cached per immutable
   `Raster`, avoiding a tile scan and set allocation on every pan frame.

The existing 4096 px chunk size remains deliberate. A measured 2048 px experiment reduced a
boundary-crossing working set from 363.0 to 96.3 MiB, but raised the established 4096² × 10-layer
pan/zoom p95 into the 20–30 ms range under load by multiplying draw calls. It was rejected; view
culling at 4096 px preserves the navigation path and gives a 90.75 MiB one-chunk working set in the
audit case.

## Before / after

Same `tests/e2e/perf-view.performance.spec.ts` workload: an occupied 8192² RGBA8 raster viewed through
an 800×600 100% viewport, and a 16-layer 800×600 composite rendered repeatedly. `gl.finish()` is used
only by the benchmark to measure completed GPU work. The source pattern is known independently and
the test checks its straight-alpha readback; retained-frame equality is also checked independently.

| Engine | Metric | Before | After | Change |
|---|---:|---:|---:|---:|
| Chromium / Intel GPU | cold visible upload | 2032.69 ms | 1108.55 ms | −45.5% |
| Chromium / Intel GPU | upload calls | 5 | 2 | −60.0% |
| Chromium / Intel GPU | texture working set | 363.00 MiB | 90.75 MiB | −75.0% |
| Chromium / Intel GPU | unchanged frame p95 | 2.24 ms | 0.07 ms | −96.9% |
| WebKit / Xvfb | cold visible upload | 1175.74 ms | 363.50 ms | −69.1% |
| WebKit / Xvfb | upload calls | 5 | 2 | −60.0% |
| WebKit / Xvfb | texture working set | 363.00 MiB | 90.75 MiB | −75.0% |
| WebKit / Xvfb | unchanged frame p95 | 7.34 ms | 0.12 ms | −98.4% |

Baseline uptime/load: `up 8:10, load average 4.36, 4.97, 5.27`. Final uptime/load: `up 8:21,
load average 5.99, 7.96, 7.35`. Because the shared machine was busier for the final run, percentage
changes are directional rather than laboratory-quality. Structural counters corroborate them: 25 of
55 repeated scene requests hit the cache, one UI-only `CanvasView` redraw added one request and one
cache hit but zero full composites, and moving to a distant chunk stayed at 90.75 MiB under a 100 MiB
budget. The 55-request scene needed three render-target allocations because targets are pooled.

The audit's pan loop was intentionally not optimized. Final p95 was 2.37 ms in Chromium and 9.26 ms
in WebKit; the standard 4096² × 10-layer real-GPU gate measured pan 11.49 ms, zoom 9.31 ms and 200%
pan 8.30 ms at load average 6.25 (all under 33 ms). That gate's unrelated worker commit sample was
load-sensitive and missed its 400 ms guard (476 ms); see Verification.

## Instrumentation API

- `GpuPerformanceCounters` now exposes texture uploads, render-target allocations, draw passes,
  estimated drawn pixels, composite requests, full composites, unchanged-frame hits, and effect
  regenerations.
- `CanvasView.performanceCounters` exposes redraw requests, full and overlay-only frames, synchronous
  frame CPU maxima, frames over 50 ms, and Long Tasks observer count/duration where the engine
  supports the `longtask` entry type.
- The comparison run observed four Chromium long tasks totalling 2295 ms while constructing and
  synchronously measuring the deliberately heavy fixture (3678 ms in a repeat started at load 11.09).
  WebKit exposes no Long Tasks entries in this environment. The actual cached UI redraw added no
  >50 ms frame in either engine.

## Ranked findings

| Rank | Finding | Expected gain | Effort | Status |
|---:|---|---|---|---|
| 1 | UI-only or duplicate frames repeated the complete layer/adjustment graph. | Very high for many layers; measured 97–98% p95 reduction. | Medium | Implemented. |
| 2 | First use of a raster uploaded every occupied chunk, even for a small 100% viewport. | Very high for 46–200 MP documents; measured 75% working-set reduction in the fixture. | Medium | Implemented with chunk-level LRU. |
| 3 | A fully resident raster at fit/very low zoom still uploads full-resolution chunks before GPU mip selection. Swapped rasters already use their reduced copy. | Estimated 2–8× lower upload bytes and much faster first fit for resident 46 MP sources. | High: build/store premultiplied LODs off-main-thread without duplicating A4 storage. | Open. |
| 4 | Every pan and zoom recomposites the whole visible view. Integer-pixel pan reprojection plus exposed-strip rendering could avoid most fill, but fractional pans, dissolve coordinates, proofing and exact sampling require care. | Estimated 30–80% for many-layer pan; smaller at current 4–11 ms GPU baseline. | High | Open. |
| 5 | Backing dimensions always use full `devicePixelRatio`; DPR 2 means roughly 4× fragments and target bytes. | Up to 2–4× during interaction on high-DPI WebKit. | Medium, but dynamic resolution changes transient pixels and therefore conflicts with the identical-pixel requirement. | Not adopted. |
| 6 | A changed tile refreshes affected chunk aprons and regenerates that chunk's complete mip chain. | Estimated 10–30% for non-brush small edits; brush feedback already has dirty-region targets. | Medium | Open. |

Other checks: marching ants and tool overlays already use the separate 2D overlay RAF, so they do not
need a compositor frame. Live filters, layer effects and adjustment LUT uploads already use immutable
identity caches. There is no `gl.finish()` or `readPixels()` in the normal animation-frame path;
`gl.finish()` is restricted to explicit `renderNow()` measurement/tests, and readback is restricted to
export/merge/sample paths.

## Pixel and regression verification

- Whole-project TypeScript: clean. Unit suite: 91 files, 774 tests passed in 81.66 s with
  `--maxWorkers=2`.
- Focused PERFVIEW harness: Chromium + WebKit, 2/2 passed. Known RGBA samples remained
  `[31,97,181,255]` before and after a distant-chunk pan; unchanged retained target max delta 0;
  transient hook override changed 480,000 pixels and forced exactly one full composite. In-place A4
  residency resolution invalidated the cache and changed the checked pixel from red LOD to blue
  full-resolution data.
- Directly affected Chromium specs: 9/9 passed (`gpu-chunks`, `gpu-compositor`, `gpu-vs-cpu`,
  `effects`, `banding`). GPU versus independent CPU compositor: max 1/255, mean 0.0162, zero channels
  over 3/255. Transformed chunk region: max 1/255, mean 0.0252.
- Directly affected WebKit specs: 8/8 passed (`gpu-chunks`, `gpu-compositor`, `effects`, `banding`).
  Transformed chunk region: max 1/255, mean 0.0457; 16-bit alpha GPU/CPU max float delta 0.000683.
- Standard real-GPU navigation/brush gate: navigation budgets passed. One even-stroke worker commit
  took 476 ms against the 400 ms guard while system load was 6.25; irregular commit was 279 ms. This
  path is outside the changes (worker raster commit), and the project handoff already records the
  guard as load-sensitive up to and beyond 0.4 s. A later run started at load 11.20 and was worse
  across unrelated CPU/GPU metrics (even commit 960 ms, zoom p95 49.30 ms). Neither limit was hidden
  or relaxed; a quiet-machine rerun remains necessary.

No dependencies or licence notices changed. No real Tauri GPU measurement was attempted because the
required invisible Xvfb session cannot provide the owner's real app/GPU measurement.
