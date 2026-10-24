# PERF2 — remaining Phase-2 performance items

Date: 2026-09-25. Reference host: Intel Core i7-7820HQ (4 physical / 8 logical
cores), Intel HD 630 plus NVIDIA Quadro M2200 (4 GiB). Browser measurements
used headless Chromium on the invisible Xvfb display. No visible browser was
used for the retained results.

## Brush commit regression

### Cause and fix

The regression was CPU and memory-bandwidth oversubscription. The brush pool
used all eight SMT threads for four regional tile owners. A profile at `10:30:54
up 2:22, load average 6.86, 8.16, 8.34` measured 530.6 ms for the even stroke
and 381.4 ms for the irregular stroke. Pointer-up itself was only 0.5/0.1 ms;
the wait was in worker settling (117–375 ms per worker) and finish transfer
(80–137 ms), not journal/recovery, hydration, 16-bit kernels, or the main
thread.

`recommendedBrushWorkerCount()` now caps both prewarming and regional tile
ownership at four workers, matching the physical cores of the reference CPU.
The unit regression covers 1/2/4/8/16 reported logical CPUs. The performance
spec now enforces the 400 ms commit budget even when headless WebGL identifies
itself as a software renderer, because the measured work is the CPU worker and
document commit path.

An immediate post-fix run at `10:33:13 up 2:24, load average 5.46, 7.66, 8.17`
measured 366.6/278.9 ms (even/irregular), versus 530.6/381.4 ms in the profile.
A later stress run at load 20.94 measured 921/495 ms, and the final headless
real-GPU gate at `13:05:01 up 4:56, load 14.36,18.16,25.23` measured 716/582
ms. In the final run, pointer-up remained 0.60/0.12 ms while worker scheduling
alone took 351–511 ms. These two high-contention runs are retained to show the
failure mode, but are not presented as target-load measurements. A requested
three-repeat range below load 4 could not be obtained while other lanes kept
multiple Chromium suites active on all four physical cores.

## Object-selection encoder

### WebGPU and threaded WASM implementation

- The worker now imports ONNX Runtime's direct WebGPU build and its matching
  asyncify threaded-WASM module. The old JSEP module does not implement the
  direct build's `webgpuInit` bridge.
- WebGPU adapters are inspected before session creation. SlimSAM FP16 requires
  `shader-f16` and creates a 384 MiB MatMul scratch buffer, so the worker
  requests that feature and checked 512 MiB `maxBufferSize` and
  `maxStorageBufferBindingSize` limits explicitly.
- The high-performance adapter is preferred only when compatible. On this
  dual-GPU host, NVIDIA/Maxwell lacks `shader-f16`, while Intel Gen-9 exposes
  it; the worker therefore selects Intel.
- Encoder and decoder sessions are created sequentially. ONNX Runtime rejects
  concurrent direct-WebGPU session registration on one device.
- WebGPU creation, encoder, or decoder failure recreates both sessions on WASM
  and records the reason. Cross-origin-isolated WASM uses four physical-core
  threads; non-isolated contexts remain at one thread.

The pinned 20.7 MB FP16 graph remains the production graph. Diagnostic trials
found that the repository's FP32 graph exhausted the Quadro's 4 GiB budget.
The 13.8 MB quantized graph ran on NVIDIA only with a 1 GiB device limit, but at
load 23.04 its 5.794 s encoder was not faster than FP16/Intel, while its WASM
fallback was roughly twice as slow. Keeping FP16 therefore minimizes download,
GPU requirements, and fallback latency together.

### Provider proof and measurements

Headless Chromium reported `crossOriginIsolated=true`, `navigator.gpu=true`,
NVIDIA/Maxwell for the high-performance adapter and Intel Gen-9 for the
low-power adapter. The Intel adapter reported `shader-f16`, a 4,294,967,292-byte
maximum buffer and storage binding size. The initial `--use-angle=gl` probe used
llvmpipe; the final opt-in project uses `--use-angle=gl-egl`, which headlessly
reports `ANGLE (Intel, Mesa Intel(R) HD Graphics 630 (KBL GT2), OpenGL ES 3.2)`.

Every retained WebGPU run used the real Intel WebGPU adapter, produced
`backend=webgpu`, and passed the generated-scene mask check at IoU 0.999369:

| Run / `uptime` before launch | Encoder | first decoder | cached decoder |
| --- | ---: | ---: | ---: |
| `11:08:23 up 2:59, load 18.68,16.10,12.02` | 6,169 ms | 1,975 ms | 266 ms |
| `11:19:53 up 3:11, load 19.17,19.26,15.68` | 5,449 ms | 1,138 ms | 290 ms |
| `11:20:56 up 3:12, load 22.54,20.31,16.29` | 5,174 ms | 815 ms | 525 ms |

Range: encoder 5.17–6.17 s, first decoder 0.82–1.98 s. These runs do not meet
the 3 s encoder target, and they were all taken far above the requested load
threshold because three foreign long-running browser suites kept the
eight-logical-CPU host at load 18–23. This is reported as a deviation, not
represented as an idle-machine result.

Four-thread WASM exploratory repeats at low/moderate load measured 5.45–7.34 s
for the FP16 encoder (one recorded run: load 2.73, 5.731 s encoder, 172 ms
decoder, 37 ms refinement). A deliberately retained high-contention check at
`11:21:56 up 3:13, load 21.17,20.28,16.53` measured 15.057 s. Thus the threaded
path materially improves the original 14–22 s single-thread result when the
machine is available, but it cannot overcome severe host contention.

### Cross-origin isolation and compatibility

Vite dev/preview, the Tauri frontend dev/preview server, and Tauri packaged
responses now send `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`.

- Chromium, Firefox, and WebKit all reported cross-origin isolation and
  `SharedArrayBuffer`; the CanvasKit blob-worker pixel hash matched its main
  thread in all tested browsers.
- An actual fetch from an isolated Chromium page to the pinned Hugging Face
  encoder returned HTTP 200, response type `cors`, `Access-Control-Allow-Origin:
  *`, content length 12,170,657, and a 133,885-byte first stream chunk. Remote
  model download therefore remains compatible with COEP and still happens only
  after the existing user action.
- Same-origin CanvasKit WASM/fonts, module workers, blob workers, blob model
  URLs, and cached model reload all passed browser tests.
- `npx tauri build --debug --no-bundle` accepted the configuration and completed
  the 1,013-module frontend build. Native compilation then stopped because this
  host lacks the development `glib-2.0`/`gobject-2.0` pkg-config files; no Rust
  or configuration error was reported before that environmental blocker.

## One CanvasKit instance

`loadSharedTextEngine()` is a process-wide lazy promise used by both
`TextRuntime` and `VectorRuntime`; a rejected initialization clears the promise
so retry remains possible. `loadTextEngine()` stays available for deliberately
isolated workers/tests.

Direct before/after resource measurements:

| | Instances | WASM heap | CanvasKit WASM transfer |
| --- | ---: | ---: | ---: |
| before (`loadTextEngine()` twice; load 5.44) | 2 | 268,435,456 B | 14,635,290 B |
| after (`loadSharedTextEngine()` twice; load 3.56) | 1 | 134,217,728 B | 7,317,645 B |

This saves 128 MiB of WASM heap and 7,317,645 transfer bytes (50% each) when
text and vector tools are both used. The unit test also checks referential
identity and the 128 MiB heap size.

## Verification

- Focused unit tests: 4 files passed, 25 tests passed; after the GPU-limit
  regression was added, object-selection alone passed 6/6.
- Firefox + WebKit CanvasKit/isolation: 2 passed in 21.4 s, with identical sheet,
  PNG, and worker hashes.
- Final full unit run at `13:07:23 up 4:58, load 19.29,18.20,24.21`: 80 files
  and 664 tests passed in 40.41 s, including the 4000×3000 TIFF benchmark. An
  earlier contended run had timed that benchmark out at the suite wall limit;
  run alone at `11:24:31 up 3:15, load 23.89,22.00,17.76`, it also passed
  (1/1) in 20.89 s with 7,783.8 ms decoder time.
- TypeScript: clean (`npx tsc --noEmit -p .`).
- Full headless Chromium: 318 passed, 16 skipped, 1 failed in 1.5 h. The sole
  failure was the legacy `.zip` half of the drag/drop document-state test; the
  exact test passed alone immediately afterward (1/1 in 12.1 s). This is an
  unresolved suite-order/load flake, not recorded as a green full-suite gate.
- Final opt-in `perf-gpu`: real renderer
  `ANGLE (Intel, Mesa Intel(R) HD Graphics 630 (KBL GT2), OpenGL ES 3.2)`;
  pan p95 10.47 ms, zoom p95 8.91 ms, first brush sample 20.46 ms. It failed
  only the 400 ms commit assertion at 716/582 ms under load
  14.36/18.16/25.23, with the scheduler profile above. No headed browser or
  visible owner display was used.

Shared files changed minimally: `THIRD_PARTY_NOTICES.md` and
`MODEL_LICENSES.md` gained the previously missing pinned SlimSAM notice and
the measured graph-selection rationale. `contracts.ts` was not changed.
