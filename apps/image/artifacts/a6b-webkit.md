# A6b WebKitGTK follow-up

Measured 2026-09-24 on the A6 reference Linux laptop (Intel HD Graphics 630, Linux Mint 22.2,
WebKitGTK 2.52.6, 1440×900 desktop). This follows `artifacts/a6-spike.md`; the release Tauri shell
kept its hardened CSP and offline configuration. Before every process, `scripts/tauri-a6b.sh`
recorded `uptime` and waited while the one-minute load average exceeded 3. Every result below has
three independent processes. Completed labels make the script resumable after the required
30-minute load-wait ceiling.

The six accepted normal-DPR processes started at one-minute loads 1.63–2.43 (default: 1.63–2.06;
forced SHM: 1.63–2.43). The three JPEG results are from the default processes, so they have the
same 1.63–2.06 start-load range. The single visual-only DPR pair started at 2.46–2.61.

## Hardened-CSP prerequisite

The first hardened release smoke exposed a post-A6 integration issue: basic WebGL2 was available,
but Pixi rejected its generated uniform synchronisers because CSP correctly omits JavaScript
`'unsafe-eval'`; the editor consequently used its software fallback. `gpuCompositor.ts` now imports
`pixi.js/unsafe-eval`. Despite its name, this existing Pixi entry installs static CSP-safe
synchronisers; it does not enable evaluation or weaken `src-tauri/tauri.conf.json`. The corrected
feature release reported the WebGL renderer as `Apple GPU` in every accepted run.

## Package 1: native presented frames and forced SHM

The feature-only Rust probe attaches to the WebView widget's `GdkFrameClock` and records one sample
from every native `after-paint` callback. Intervals use `gdk_frame_clock_get_frame_time`; this is a
homogeneous series even though `GdkFrameTimings.presentation_time` is populated for only 0–13 of
roughly 60 callbacks on this X11 backend. The latter count is retained in raw JSON as a diagnostic.
"Dropped" is the larger of skipped frame counters and elapsed refresh intervals beyond one at the
reported 16.65–16.67 ms refresh period.

| 1× workload, three processes | `renderNow` p95 range | after-paint p50 range | after-paint p95 range | dropped range |
|---|---:|---:|---:|---:|
| Zoom, default | 19–22 ms | 16.67–32.92 ms | 33.33–33.89 ms | 16–33 |
| Zoom, forced SHM | 7–8 ms | 16.65–16.67 ms | 16.67–99.99 ms | 0–53 |
| Brush, default | 25–35 ms | 16.65–16.67 ms | 16.67–33.33 ms | 0–9 |
| Brush, forced SHM | 13–20 ms | 16.62–16.67 ms | 16.67–33.33 ms | 0–5 |

Forced SHM improved zoom presentation in runs 1 and 2 (16.67 ms p95, no dropped refresh interval),
but run 3 regressed to 99.99 ms p95 and 53 dropped refresh intervals. That process passed the load
gate at 2.43; its independent RAF proxy also rose to 81 ms p95, so the native result cannot be
dismissed as a frame-clock calculation artifact. Product startup therefore **does not set**
`WEBKIT_DMABUF_RENDERER_FORCE_SHM`. Existing user environment behavior is unchanged and no opt-out
variable is needed.

GDK captured the actual 1440×900 window for zoom and brush in all six normal-DPR processes. No
capture was black; zoom and brush images differed in every run (no stale frame); visual inspection
showed the complete patterned canvas and complete soft stroke with no black, torn, or missing
region. Default-vs-SHM whole-window differences were max 78 and mean 0.0418–0.1461 channel values;
the maximum lies in UI/text antialiasing. On the shared 828×731 visible-image crop, brush max/mean
was 2/0.0747 in all runs and zoom max was 9–47 with mean 0.1070–0.1929; the deliberately
high-frequency zoom texture makes subpixel phase differences produce isolated high maxima.

One accepted `GDK_SCALE=2` pair reported DPR 2.39998 and captured non-black 1920×1008 windows after
the harness had already exercised both 960×600 and 1440×900 editor-root sizes. The corresponding
default/SHM zoom p95 was 79/21 ms, confirming the A6 high-DPR fill-rate limit; this single pair is a
visual resize/DPR check, not a reported three-run timing measurement.

The auxiliary raw `gl.readPixels` files were uniformly black and identical because Pixi did not
leave the presented default framebuffer bound. They are rejected as evidence. The native GDK
captures prove the visible product output, while the Chromium test below supplies deterministic
GPU-full-recompose and CPU-raster references for the brush pixels.

## Package 2: brush preview

The A6 split showed default brush feedback dominated by full-view GPU work (`gl.finish` p95 20 ms,
WebGL submissions 5 ms, residual JS 9 ms) while every sample recomposited all five 4096² layers.
`GpuCompositor` now retains the completed preview frame for the active stroke, tracks the previous
and new replaceable brush tail plus newly settled segments, maps that damage to the viewport, and
clips every layer/adjustment pass and the final cache copy to that rectangle. Raster texture
uploads and the exact background CPU commit path are unchanged.

Against the A6 WebKit range of 32–39 ms, default WebKit brush p95 became 25–35 ms. The instrumented
default split became `gl.finish` 6–9 ms, WebGL submission 2–4 ms, and residual JS 3–10 ms p95; the
synchronous GPU wait is no longer the 20 ms dominant stage. Forced SHM produced 13–20 ms p95 but is
not enabled for the presentation reason above. The 16 ms Pro gate is therefore still not reliable
in WebKitGTK.

`tests/webview/a6b-brush.spec.ts` renders a deterministic soft stroke incrementally, compares it
with a fresh full GPU recomposition (maximum live delta 1 from float pass ordering), and compares
all 1,048,576 committed raster bytes with direct CPU replay (zero differences). The commit result,
which is the product document state, is byte-identical.

The integration baseline's stored headless `perf-gpu` record is 4.5 ms even-sample and 3.1 ms
irregular-sample brush p95 (SwiftShader). No after-change Chromium timing was accepted: the guarded
retry reached its 30-minute load-wait ceiling without starting a browser. Reporting that old single
run as a new three-run range would violate the measurement rule. The non-timing Chromium parity
test did run after the change and passed in 6.1 s.

## Package 3: one-response native JPEG transfer

The feature probe returns one raw `tauri::ipc::Response`: a 40-byte little-endian header followed
by the complete row-major RGBA8 buffer. The WebView validates it and constructs the existing tiled
`Raster`. The 46-MP images are 10109×4542: the A6 compressible fixture (0.414 MiB JPEG) and a
deterministic noisy camera-like fixture (26.776 MiB JPEG).

| End point, three processes | Compressible browser | Compressible native batch | Noisy browser | Noisy native batch |
|---|---:|---:|---:|---:|
| End to raster | 2117–3150 ms | 5069–6830 ms | 2700–7294 ms | 5196–14671 ms |
| End to first frame | 2966–4573 ms | 5884–8451 ms | 3550–8958 ms | 6017–17123 ms |

The raw response itself took 4.58–6.05 s for the compressible fixture and 4.74–13.12 s for the
noisy fixture, overwhelming the 0.33–0.64 s and 0.71–1.94 s native decode/RGBA work respectively.
It is 1.6–2.7× slower than the browser path rather than 25% faster. It is also not pixel-exact
enough for import: full-image comparison found max channel deltas 2 (mean 0.00115) and 11 (mean
0.29339). The optional native command remains behind `--features a6-spike`; product image import is
unchanged, and EXIF/ICC integration tests are intentionally not added because the speed and parity
gates both fail before format eligibility matters.

The remaining JS copy is structurally unavoidable with the current immutable tiled `Raster`:
the IPC response is row-major, while edge-aware 256 px tiles have separate typed-array storage.
Avoiding that copy would require a different raster backing contract, not an image-import-only
optimization.

## Package 4: final Linux matrix and offline gate

No post-change matrix timing was accepted. The resumed gate and two fresh, consecutive 30-minute
gates all refused to start because the one-minute load remained above 3; the recorded range was
5.23–39.38. Thus the earlier dated Linux numbers in `artifacts/tauri-webview-matrix.md` remain the
latest accepted matrix history rather than being silently replaced by contaminated data.

The final hardened release binary was nevertheless exercised for 300 s by the process-tree offline
probe: 346 `/proc` samples found **zero TCP or connected-UDP remote endpoints**. The low sample
count reflects scheduler contention. As documented by the script, Linux `/proc` cannot reveal a
destination used only by an unconnected UDP `sendto`; no runtime code was added that performs one.

## Files and APIs

- `src-tauri/src/a6_spike.rs` adds feature-only frame-clock reset/take, native window/PNG capture,
  and single-response JPEG decode commands. `src-tauri/src/lib.rs` registers them only for
  `a6-spike`; normal product IPC is unchanged.
- `tests/webview/a6-spike.ts` runs the reordered render-first probe, noisy and compressible JPEG
  comparisons, canvas captures, and end-to-first-frame accounting.
- `src/render/gpuCompositor.ts` adds CSP-safe Pixi setup and the retained dirty brush composite.
- `scripts/tauri-a6b.sh`, `scripts/tauri-offline-probe.sh`, and
  `scripts/tauri-webview-matrix.sh` provide resumable, load-gated three-run measurement and the
  process-tree socket probe.
- `tests/webview/a6b-test.html` and `tests/webview/a6b-brush.spec.ts` provide pixel/commit parity.
- Direct optional `gdk`/`gtk` dependencies expose types already present transitively in the Tauri
  Linux graph; no new crate package or licence was added.

No upstream editor behavior was ported. The workload is the existing
`tests/e2e/performance.spec.ts` sequence and the brush geometry remains the port of upstream
`MetalBrushCoverage`; the new cache changes only how much of an equivalent preview is recomputed.

## Verification

- `npx tsc --noEmit -p .`: exit 0, no output.
- `npx vitest run tests/unit`: **46 files passed, 398 tests passed**, 29.65 s.
- `cargo check`: final cached check finished successfully in 0.69 s.
- `cargo check --features a6-spike`: final cached check finished successfully in 0.39 s.
- `cargo fmt --all -- --check`, `bash -n scripts/tauri-*.sh`, and `git diff --check`: clean.
- `tests/webview/a6b-brush.spec.ts` on `chromium-gpu`: **1 passed**, 6.1 s; maximum live
  difference ≤1 and committed bytes exact by assertion.
- `E2E_PORT=5241 npx playwright test --project=chromium --output=/tmp/pw-out-a6b`: **60 passed,
  1 skipped, 5 failed**, 12.5 min under shared load. The changed GPU brush tests passed. One WebP
  case computed the expected 0.00 mean pixel delta and then exceeded its 90 s timeout; four existing
  workspace tests use `getByRole('tab')` across both document and panel tabs (received 4, expected
  2, or a strict-mode collision). No A6b-owned file can correct those selectors.
- `scripts/tauri-build.sh --features a6-spike --no-bundle`: release build passed (1 min 43 s).
- `scripts/tauri-build.sh --no-bundle`: release build passed; final summary was `Finished release
  profile [optimized] target(s) in 38m 17s`, then `Built application .../fernwork-bildeditor`.
- `scripts/tauri-offline-probe.sh 300`: `network_connections=0` across 346 samples.

The required three-run final matrix and after-change `perf-gpu` range were not run after their load
gates expired, as disclosed above. The Chromium suite is not clean for the unrelated failures
listed here; it is not reported as passing.

## Deviations and open work

- GDK exposes true presentation timestamps intermittently on this backend. The accepted native
  method is therefore `after-paint` callback cadence plus `frame_time`, explicitly allowed by the
  task, with timestamp availability disclosed.
- A window/canvas screenshot is one completed frame, so it can prove equality, non-black output,
  resize/DPR correctness, and absence of stale content in that frame; it cannot prove that no
  transient tear ever occurred between captures.
- Brush dirty recomposition materially reduces the GPU wait but does not make every WebKitGTK
  process meet 16 ms. Coalescing real pointer events per display frame remains a possible follow-up,
  but was not substituted for the binding 60-sample benchmark sequence.
- Native batch JPEG and forced SHM are measurement-only negative results and are not product paths.
- Final matrix and Chromium performance reruns remain open for an uncontended interval. Three
  consecutive native load gates and the earlier Chromium gate exhausted their 30-minute ceilings;
  running anyway would invalidate the task's method.
