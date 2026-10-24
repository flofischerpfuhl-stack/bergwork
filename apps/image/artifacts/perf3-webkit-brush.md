# PERF3 — selected brush/eraser latency in WebKitGTK

Date: 2026-09-25. The owner workload is a 40 px, 100% hard stroke on a
350×300 px transformed layer in a 1600×900 document and 1920×1080 editor,
with and without an antialiased polygon selection. All browsers ran headless
on the invisible Xvfb display. WebKit therefore used llvmpipe (`Apple GPU`);
Chromium `perf-gpu` used `ANGLE (Intel, Mesa Intel(R) HD Graphics 630 (KBL
GT2), OpenGL ES 3.2)`. The WebKit results are relative product-path evidence,
not a real Tauri/Intel presentation measurement.

## Root cause

The A6b dirty-rectangle compositor was already active and pointer input was
already consuming `getCoalescedEvents()`. The selection path bypassed it:
`beginBrushStroke()` refused `RecordedBrushStroke` whenever a selection was
active. Every pointer sample consequently ran the exact CPU rasterizer and
published another raster snapshot synchronously on the main thread. The
exact finish worker rejected selections for the same reason. Meanwhile, the
selection painter drew the unchanged marching-ants path again on every stroke
frame. No selection outline geometry was rebuilt (it already has a WeakMap
cache), and no `readPixels`/synchronous GPU readback occurs in the stroke loop.

Before the change, each selected pointer sample sampled selection coverage in
the CPU raster loop and selected strokes used zero workers. The original
diagnostic exposed the previous unselected stroke's worker timing for this
synchronous path; the worker-timing state is now reset when a job starts.

## Implementation

- Ordinary brush and eraser strokes retain geometry-only GPU preview even
  with a selection. The immutable selection travels in `GpuBrushPreview`.
- The compositor uploads a selection raster through the existing raster-id
  texture cache, creates one native-grid R8 coverage texture per touched brush
  chunk, and reuses it for every dab. The selection is multiplied into final
  coverage. Existing A6b old-tail/new-tail dirty rectangles remain the only
  region recomposited after the initial cached frame.
- The exact background worker receives the selection once in its `init`
  message. It uses the unchanged CPU rasterizer, so committed document bytes
  remain the oracle rather than being derived from the GPU preview.
- Marching ants are hidden only while a brush stroke is active and reappear on
  pointer-up. Their 120 ms idle animation remains unchanged.
- The 350×300 transformed owner layer deliberately uses one exact worker even
  when four logical workers are advertised: its working grid is non-patchable,
  and four workers would copy four complete grids. Patchable full-canvas
  strokes continue using up to four regional workers; the selected-stroke E2E
  check observed four on this 8-thread host.

The stroke loop performs one full-view cache build followed by dirty-region
composites for the pointer frames, then one normal post-commit frame. Across
the measured 49-point stroke this was 50–56 compositor calls both before and
after; it did not turn into per-dab full-view rendering. Selection raster
uploads were 8 for the eraser scenarios before and after. Actual ants path
paints fell from 60–73 to 3–5 (the overlay canvas can still be cleared by its
independent scheduler).

## Before/after measurements

Times below are p95 milliseconds over the 48 extend events/frames in each
scenario. `event` is synchronous `extendBrushStroke`; `frame` is product
`CanvasView.renderNow()` including its GPU completion measurement. Each row is
one process, not an average. Baseline and change were run back-to-back from a
detached baseline worktree and this worktree. The matrices cover paint/erase,
selection on/off, reported hardware concurrency 1/4, and isolation on/off;
the tables show eraser as the owner-reported case.

### WebKitGTK / Xvfb llvmpipe

Baseline start: `16:02:48 up 7:54, load average 5.01,6.34,4.96`.
After start: `16:03:30 up 7:54, load average 4.13,5.95,4.88`.

| isolation | reported workers | selection | event before → after | frame before → after |
| --- | ---: | --- | ---: | ---: |
| on | 1 | no | 4.52 → 0.22 | 11.22 → 12.32 |
| on | 1 | yes | **1.12 → 0.20** | 8.28 → 11.22 |
| on | 4 | no | 0.20 → 2.54 | 14.48 → 9.32 |
| on | 4 | yes | **1.80 → 0.30** | 6.58 → 15.46 |
| off | 1 | no | 4 → 1 | 23 → 19 |
| off | 1 | yes | 2 → 1 | 20 → 20 |
| off | 4 | no | 3 → 1 | 22 → 17 |
| off | 4 | yes | 2 → 4 | 22 → 24 |

With the Tauri/default isolation-on, selected eraser main-thread p95 fell 82%
at the 1-worker setting and 83% at the 4-worker setting. The owner-shaped job
uses one worker in both settings for the reason above, so this isolates
reported-concurrency scheduling rather than claiming four-way fan-out.
llvmpipe frame p95 is noisy and is not claimed as improved: after the change,
selected eraser frame p95 was in the same band as the corresponding unselected
GPU eraser. The non-isolated 1 ms timer exposes only coarse values and the
4-worker selected row regressed under load; isolation does not change the
chosen one-worker owner path.

For completeness, the isolation-on paint rows were: workers=1/no selection
4.90/19.38 → 4.92/18.16 ms event/frame, workers=1/selection 6.38/8.94 →
4.42/12.92; workers=4/no selection 5.20/18.90 → 5.14/15.66, and
workers=4/selection 6.96/9.44 → 0.34/11.48. The selected brush benefits from
the same removal of synchronous CPU preview work.

### Chromium `perf-gpu` / Intel HD 630

Baseline start: `16:01:39 up 7:53, load average 4.07,6.56,4.91`.
After start: `16:02:11 up 7:53, load average 4.72,6.47,4.93`.

| isolation | reported workers | selection | event before → after | frame before → after |
| --- | ---: | --- | ---: | ---: |
| on | 1 | no | 0.245 → 0.205 | 1.225 → 1.205 |
| on | 1 | yes | **1.755 → 0.145** | 0.625 → 0.970 |
| on | 4 | no | 0.170 → 0.235 | 1.060 → 2.430 |
| on | 4 | yes | **1.355 → 0.190** | 0.550 → 1.395 |
| off | 1 | no | 0.3 → 0.3 | 1.3 → 1.2 |
| off | 1 | yes | 1.4 → 0.2 | 0.5 → 1.4 |
| off | 4 | no | 0.2 → 0.2 | 1.4 → 1.3 |
| off | 4 | yes | 1.8 → 0.2 | 0.6 → 1.3 |

The selected eraser main-thread p95 fell 86–92% in the real-GPU isolated
rows. The live selected preview matched exact CPU replay within one
premultiplied RGBA8 level; every measured committed raster was byte-identical
to an independent synchronous CPU replay, and every selection scenario had
zero changed pixels outside selection coverage. This respects M14: the
measured output and reference are produced by separate GPU-preview and exact
CPU-raster paths.

## Verification

- `npx tsc --noEmit -p .`: exit 0, no output.
- Focused Chromium (`a6b-brush.spec.ts`, `gpu-brush.spec.ts`): 6 passed in
  39.2 s.
- Focused WebKit (`a6b-brush.spec.ts`, `gpu-brush.spec.ts`): 6 passed in
  25.8 s.
- Final unit run at `16:07:52 up 7:59, load average 5.46,5.77,5.06`:
  **91 files passed, 774 tests passed**, 58.09 s, including the 4000×3000 TIFF
  benchmark.
- Product-path performance matrix: WebKit 1 passed in 34.9 s baseline and
  37.5 s after; Chromium `perf-gpu` 1 passed in 25.9 s baseline and 27.7 s
  after. All 32 scenario/config results had zero committed differences and
  zero out-of-selection changes.

No real Tauri/GPU measurement was made because Xvfb exposes only llvmpipe to
WebKitGTK. No dependency, licence notice, shared contract, i18n key, generated
artifact, or network behavior changed.
