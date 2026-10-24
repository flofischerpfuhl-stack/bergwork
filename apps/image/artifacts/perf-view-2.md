# PVIEW2: canvas-view LOD, pan reprojection, and interaction fill rate

Date: 2026-09-25. Scope: `src/render/gpuCompositor.ts`,
`src/ui/canvas/CanvasView.ts`, and the focused PERFVIEW benchmark. This round implements the three
open canvas-view items from `perf-view.md`; it does not alter the exact CPU Apply/export path.

## Result

### Resident-raster upload LOD

At effective scales of 1/8 or below, a fully resident RGBA raster now builds and uploads a tile-local
1/8 premultiplied LOD instead of first uploading its full-resolution chunks. Three halvings follow
upstream `Rendering/DownsampleCache.swift` (`halve`), with explicit zero padding at document edges.
The LOD is cached by immutable raster and source-tile identity; an opaque-tile fast path avoids
unnecessary alpha multiplication. WebGL generates the remaining lower mip levels from this base.

The path is deliberately limited to bilinear RGBA resident rasters. Nearest-neighbour layers retain
their exact texel semantics, swapped rasters retain their existing reduced-copy path, and masks remain
on the established upload path. `GpuPerformanceCounters` adds `residentLodBuilds` and
`residentLodSourcePixels`.

### Exact pan reprojection

An integer-device-pixel pan can now reproject the previous half-float composite into a second pooled
target and render only the newly exposed non-overlapping strips through the normal layer/effect graph.
The optimization requires unchanged visual content, target size, scale, snapping, and linear view
transform; exposed area must be below 50%. Fractional pans, zooms, mesh warps, large jumps, and active
brush previews use a full composite. This keeps document-space sampling and dissolve coordinates
unchanged in the newly rendered strips. `GpuPerformanceCounters` adds `panReprojections` and
`panExposedPixels`; `fullComposites` excludes successful reprojections.

### Interactive device scale

`CanvasView` caps compositor render scale at 1 while the user navigates with the hand tool, middle
button, wheel, or pinch. The display and overlay remain at the real device pixel ratio. Pointer
navigation restores full quality immediately on release; wheel/pinch restores it after 120 ms idle.
Idle pixels are therefore unchanged rather than merely visually similar. `CanvasPerformanceCounters`
adds `reducedResolutionFrames` and `lastRenderScale`.

## Measurement

The focused audit ran Chromium with the Playwright `perf-gpu` project on
`ANGLE (Intel, Mesa Intel(R) HD Graphics 630 (KBL GT2), OpenGL ES 3.2)` and Playwright WebKit on
Linux/Xvfb. WebKit reported `Apple GPU`, so its results are same-machine relative browser figures,
not proof of a particular WebKitGTK hardware backend. The shared host was substantially busier in the
final run; timings are directional and the structural byte/pixel counters are the stronger result.

The LOD fixture contains 46,137,344 resident source pixels (8192x5632, 704 distinct resident tile
objects). Its full-path comparator disables LOD with nearest sampling while preserving the old
upload/mipmap workload; a separate patterned translucent fixture checks bilinear output against the
independent software compositor. `gl.finish()` is benchmark-only.

| Engine | 46 MP first-fit metric | Full upload | Resident LOD | Change |
|---|---:|---:|---:|---:|
| Chromium / Intel GPU | completed frame | 929.02 ms | 495.40 ms | -46.7% |
| WebKit / Xvfb | completed frame | 1178.70 ms | 1024.94 ms | -13.0% |
| Both | estimated texture bytes | 253.00 MiB | 4.87 MiB | -98.1% |

The independent high-frequency CPU oracle differed by at most 1/255 after LOD selection. The
resident LOD consumes 1/64 of the source pixel storage before GPU mip generation. Cold construction
is still synchronous and visible in the first-fit time, especially in WebKit; this is recorded as
open work below.

For the focused 16-layer pan audit, initial round-two baseline at uptime `up 4 min, load average
4.25, 1.95, 0.80` was Chromium median/p95 1.405/5.635 ms and WebKit 5.46/7.56 ms. The final combined
audit, run after allocating the unique 46 MP fixture at uptime `up 20 min, load average 7.64, 7.00,
4.59`, measured Chromium 5.185/19.095 ms and WebKit 2.98/7.80 ms. The host load and preceding large
allocation make those wall times non-comparable; neither result exceeds the 33 ms p95 navigation
budget. Structural counters show that each qualifying frame retains the overlap and composites only
the exposed strips. Reprojection versus a forced full composite had maximum float-channel delta
0.00048828125 (one RGBA16F ULP, below 1/255).

At DPR 2, navigation used scale 1 and an internal width of 972 instead of the idle width of 1944:
75% fewer target pixels. After idle restoration the framebuffer matched the pre-interaction idle
frame byte-for-byte (maximum delta 0), and the reported render scale returned from 1 to 2.

## Verification

- Focused PVIEW2 audit: Chromium and WebKit, 2/2 passed in 24.1 s. The 46 MP LOD, independent CPU
  oracle, pan full-composite comparison, DPR reduction, and exact idle restoration are assertions.
- Directly affected compositor specs: Chromium and WebKit, 16/16 passed in 24.3 s
  (`banding`, `effects`, `gpu-chunks`, `gpu-compositor`). Transformed chunk maximum error was 1/255
  in both engines (means 0.02523 Chromium and 0.04565 WebKit); 16-bit alpha maximum float error was
  0.0004701 and 0.00068325 respectively.
- Chromium GPU-versus-independent-CPU compositor: 1/1 passed; maximum 1/255, mean 0.016183/255,
  zero channels over 3/255.
- Standard real-GPU gate first run: every navigation/brush feedback budget passed (pan p95 8.87 ms,
  zoom 6.54 ms, 200% pan 6.445 ms, brush feedback 13.875 ms, irregular brush 9.93 ms, first brush
  13.67 ms). Its unrelated even-stroke worker commit was 546.045 ms against the load-sensitive
  400 ms guard; irregular commit was 353.62 ms. A final rerun at load average 17.15 again passed all
  canvas budgets (pan 19.62 ms, zoom 8.09 ms, 200% pan 8.94 ms, brush feedback 14.22 ms,
  irregular brush 14.66 ms, first brush 7.85 ms) and again failed only even-stroke commit at
  633.485 ms; irregular commit was 347.375 ms. The guard was not changed or hidden.
- Whole-project TypeScript completed cleanly. The final unit run passed 92 files and 780 tests in
  94.41 s with `--maxWorkers=2`.

## Decisions, limits, and open work

- The LOD is created tile-by-tile, so it does not require a second full-resolution contiguous image.
  It is nevertheless built synchronously. Moving its cold construction off the UI thread needs an A4
  worker/residency ownership protocol that does not duplicate 46-200 MP storage; this remains the
  largest open item.
- Mask LOD was not added. Masks are one channel rather than four, and changing their sampling edge
  path for a smaller byte win needs separate pixel evidence.
- Pan reuse is exact only for integer target-pixel translation. Fractional reprojection would add a
  second filtering step and could violate the pixel bound; it intentionally falls back.
- Interaction scale reduction applies to navigation, not painting. Brush feedback already uses dirty
  regions, while a scale transition during a stroke would invalidate its retained target.
- The measured source size was 46 MP, the lower edge of the requested 46-200 MP range. The algorithm
  is tile-bounded and its byte reduction scales with source size, but a 200 MP browser allocation was
  not attempted on the shared host.
- A real Tauri/WebKitGTK GPU measurement was not attempted: the mandated invisible Xvfb session
  cannot represent the owner's real app/GPU. Playwright WebKit is included as the requested Linux
  proxy.

No dependencies, licence notices, shared contracts, or i18n keys changed.

## Final command summaries

- `npx tsc --noEmit -p .`: exit 0, no diagnostics.
- `npx vitest run tests/unit --maxWorkers=2`: `Test Files 92 passed (92)`,
  `Tests 780 passed (780)`, `Duration 94.41s`.
- Final standard gate rerun uptime: `up 23 min, load average: 17.15, 10.93, 6.47`.
  Playwright summary: `1 failed`; the sole assertion was the known worker commit guard
  (`633.485 ms <= 400 ms`). All canvas-view timing assertions passed.
