# FIX-PERF: real-GPU regression

Date: 2026-09-25. Renderer for every accepted GPU measurement: ANGLE/OpenGL on Intel HD Graphics 630.
The host was shared; every measurement below includes the observed `uptime` load average.

## Bisect

`artifacts/bisect-perf.sh` runs the existing Playwright specifications without a build, records `uptime`, treats a timeout as bad, and applies the requested 3× known-good limits. The effects test is skipped at revisions before that file existed.

First-parent bisect from `de2a364` to `b60e5ff`:

- Last measured good parent: `1d28096`; effects p95 3.1 ms, pan 7.3 ms, zoom 7.3 ms, 200% pan 3.6 ms, brush feedback 6.6/3.8 ms. Start load 4.37/4.02/4.87.
- First bad integration commit: `e424290` (`Merge A4c ...`); the effects test exceeded the runner's 120 s timeout while repeatedly destroying and recreating textures. Start load 4.37/4.02/4.87.

Inside the A4 branch:

- `4432d01` was good by the bisect criterion: pan 6.5 ms, zoom 6.0 ms, 200% pan 3.1 ms, brush feedback 14.9/8.5 ms. Its unrelated even-stroke worker commit took 505.4 ms under start load 8.02/6.14/5.44, but all frame p95 values stayed below 3× the good values.
- `a9fe5e2` (`Make raster swapping and recovery journal granular`) was the first bad branch commit. It introduced the GPU texture-budget eviction loop. Its performance test exceeded the 180 s runner timeout with an active-texture eviction warning every few seconds.
- The later `ddf266f` A4c integration merge added a second problem during conflict resolution: the half-float precision path was broadened from the four division-sensitive blend modes to every document containing a layer effect.

## Root causes and fixes

1. `GpuCompositor.collectTextures` enforced the 384 MiB soft GPU budget by evicting slots used in the current frame. The 4096² × 10-layer working set is approximately 853 MiB, so the next unchanged frame necessarily uploaded those same slots again. Current-frame slots now form the minimum working set; the budget still evicts inactive and stale slots.
2. The A4c merge widened all RGBA8 source and generated effect textures to half-float whenever any effect was enabled. This doubled the styled working set and was not part of the original precision fix. Half-float widening is again limited to Colour Burn, Colour Dodge, Vivid Light and Divide (plus native RGBA16 rasters).
3. Live-filter wrappers and effect-expanded documents were allocated on every frame. `LiveFilterHookAdapter` is stable for the compositor, `liveFilterHooks` memoizes stable CPU callers, and `documentWithLayerEffects` caches its expanded immutable document by document identity plus resolved raster/mask/placement identities.
4. The first brush sample uploaded a second copy of a fully resident layer under a brush-only texture key. Fully resident pixel and mask strokes now reuse the normal layer slot; swapped rasters retain the separate resident-view key.

The GPU exposes cumulative `performanceCounters` for regression tests. The 4096² styles test warms one frame and then asserts exactly **0 effect regenerations and 0 texture uploads across 60 unchanged frames**.

## Measurements

| Specification | Before fix | After fix | Load average |
|---|---:|---:|---|
| `effects-performance.spec.ts` | median 2736.5 ms, p95 3376.8 ms | median 1.0 ms, p95 2.3 ms; 0 regenerations/uploads | before 3.62/4.42/5.52 → 2.32/3.79/5.07; after 6.03/7.48/8.72 → 4.60/6.95/8.49 |
| `performance.spec.ts` | timed out after 300 s (reported regression and reproduced by bisect timeouts) | pan 5.4 ms, zoom 4.0 ms, 200% pan 2.6 ms; brush 3.4/3.2 ms; first sample 7.1 ms; commits 324.9/260.9 ms | 6.03/7.48/8.72 → 4.60/6.95/8.49 |
| `adjust-performance.spec.ts` | p95 10.6 ms in `artifacts/adjustments-p2.md` | median 0.5 ms, p95 1.0 ms, max 1.3 ms | 7.60/7.12/6.17 → part of run ending 5.62/6.69/6.10 |
| `export-performance.spec.ts` | best 10.1 s final run at load 17 in `artifacts/export-artboards.md` | total 10.945 s cold, 4.537/3.892 s warm; render 0.632–0.642 s; encode 3.115–3.519 s | 7.60/7.12/6.17 → 5.62/6.69/6.10 |

An earlier after-fix run under load 7.07/10.50/10.70 passed every rendering target but missed the asynchronous stroke commit guard while two other benchmark suites occupied CPU cores. The final combined run after those jobs ended passed both specifications and every guard.

## Files and exported API

- `src/core/effects/document.ts`
  - `EffectRenderDiagnostics { effectRegenerations: number }`
  - `documentWithLayerEffects(document: CanvasDocument, hooks: EffectSourceHooks, diagnostics?: EffectRenderDiagnostics): CanvasDocument`
- `src/render/liveFilterPasses.ts`
  - `LiveFilterHookAdapter`, with `use(source: CompositeHooks): CompositeHooks`
  - `liveFilterHooks(hooks: CompositeHooks): CompositeHooks` now memoizes its adapter
- `src/render/gpuCompositor.ts`
  - `GpuPerformanceCounters { effectRegenerations: number; textureUploads: number }`
  - `GpuCompositor.performanceCounters: GpuPerformanceCounters`
- `tests/unit/effects.test.ts`: stable expansion / zero regeneration over 60 frames
- `tests/e2e/effects-performance.spec.ts`: real-WebGL zero-regeneration and zero-upload assertion
- `artifacts/bisect-perf.sh`: reproducible bisect runner

## Upstream and deviations

No upstream rendering formula or state transition changed. This is browser-port cache/residency infrastructure with no corresponding Swift/C implementation to port. Effect pixels and ordering remain covered by the existing upstream-derived and product-plan tests.

The GPU texture budget is now a soft cap when the current frame's working set itself exceeds it. Enforcing a hard cap without a reduced representation makes unchanged frames thrash; inactive slots are still evicted to the configured budget. No feature was removed.

## Open issues / not implemented

No requested feature or regression coverage was omitted. PixiJS still emits its pre-existing warning when some texture sources are destroyed while bound during replacement or compositor teardown; this was not changed because the unchanged-frame counters prove those warnings are not cache misses or uploads in the fixed steady state.

## Verification

- `npx tsc --noEmit -p .`: clean.
- `npx vitest run tests/unit`: 78 files passed, 646 tests passed.
- Exact combined real-GPU run: 2 passed in 37.8 s. Effects p95 2.3 ms with zero regenerations/uploads; canvas passed every frame, first-sample, main-thread and worker-commit target.
- Real-GPU adjustment and export specifications: 2 passed.
- Full Chromium suite: 327 passed, 4 skipped in 29.8 min. Start load 7.54/9.31/10.08; end load 7.13/7.73/8.81.
- The preceding full run had one `.fwimg`/legacy `.zip` drag-and-drop failure at load 10.74/11.63/11.05; its immediate isolated rerun and the final full-suite run both passed.
