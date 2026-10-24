# A6 WebKitGTK/native spike

Measured 2026-09-24 on the reference Linux laptop at commit `a803d03` plus this spike:
WebKitGTK 2.52.6, Linux 6.8.0-139, Mesa 25.2.8, Intel HD Graphics 630 (KBL GT2),
1440×900 desktop, Rust 1.98.1, and Node 22.18.0. The machine also has a Quadro M2200;
`MESA_VK_DEVICE_SELECT=8086:591b!` kept the native Vulkan comparison on the Intel GPU.
WebKit masks its WebGL renderer as `Apple GPU`; `glxinfo` identifies the active accelerated OpenGL
device as the Intel HD 630.

This is measurement-only code behind Cargo feature `a6-spike`. Build it with
`npm run tauri:build -- --features a6-spike --no-bundle`, then run
`src-tauri/a6-run.sh [output-directory]`. The final launcher run wrote the raw JSON outside the
repository to `/tmp/fernwork-a6-final3`; the tables below transcribe that run. Two preceding complete
launcher runs were retained long enough to quote repeat ranges where they materially affect the
interpretation.

## Probe and method

`tests/webview/a6-spike.ts` uses the real editor controller, raster, brush preview, and WebGL2
compositor. The zoom workload is the `tests/e2e/performance.spec.ts` 4096² ten-layer sequence. The
brush workload uses five layers (within the 100-MP document limit), a 300 px soft brush, all 60
pointer samples, and the same zero-delay task boundary between samples. The uninstrumented headline
is the comparable p95. A second stroke wraps WebGL calls and splits elapsed time into:

- JS/editor work: residual wall time after wrapped WebGL calls;
- WebGL command calls: time inside command-submission methods;
- `gl.finish`: synchronous GPU completion;
- presentation proxy: time from return of `gl.finish` to the next `requestAnimationFrame` timestamp.

The instrumented p95 values are percentiles of each series independently and therefore must not be
added. Wrapping calls has observer overhead, and the split stroke is a separate run. GTK/WebKit does
not expose the compositor's actual presented timestamp to Web content, so the RAF number includes
vsync scheduling and is a proxy, not a proof of scan-out time.

The window was requested at 1440×900. With the desktop's fractional scale, WebKit reported DPR
1.19999 and the editor canvas (after application chrome) was 1132×784 CSS / 1358×941 backing pixels.
The smaller requested root produced 652×484 CSS / 782×581 backing pixels. `GDK_SCALE=2` produced
DPR 2.39998 and a 2717×1882 large backing canvas.

## Zoom and brush: where the misses occur

The default run reproduced the A1 misses closely: zoom was 22 ms p95 (A1: 25 ms) and brush was
39 ms p95 (A1: 34 ms). The smaller canvas zoom was 12 ms p95.

| Workload, default WebKit | Uninstrumented p95 | Instrumented total p95 | JS p95 | WebGL calls p95 | `gl.finish` p95 | RAF proxy p95 |
|---|---:|---:|---:|---:|---:|---:|
| Zoom, 1358×941 backing | 22 ms | 31 ms | 3 ms | 2 ms | 30 ms | 7 ms |
| Brush preview, 60 samples | 39 ms | 25 ms | 9 ms | 5 ms | 20 ms | 21 ms |

Zoom is GPU/compositor-bound at the WebGL synchronization point: JS and command calls account for
only a few milliseconds while `gl.finish` dominates the instrumented frame. Brush has more editor
and submission work, but `gl.finish` is still the largest measured in-frame component; its high RAF
proxy also shows that a `renderNow` timing alone misses post-submit scheduling pressure.

### WebKitGTK settings, canvas size, and DPR

Each row is a fresh process. Zoom and brush are the uninstrumented p95 values; presentation is the
corresponding instrumented RAF proxy. The damage row enables WebKit's diagnostic
`WEBKIT_SHOW_DAMAGE=1` overlay; it is not a product setting.

| Setting | Zoom p95 | Zoom RAF proxy | Brush p95 | Brush RAF proxy | Result |
|---|---:|---:|---:|---:|---|
| Default: on-demand acceleration, accelerated 2D on | 22 ms | 7 ms | 39 ms | 21 ms | Reproduces misses |
| Hardware acceleration `always` | 26 ms | 5 ms | 32 ms | 6 ms | No fix |
| Hardware acceleration `never` | 23 ms | 35 ms | 30 ms | 3 ms | No fix; zoom presentation worsens |
| Accelerated 2D canvas off | 26 ms | 4 ms | 28 ms | 5 ms | No material fix |
| `WEBKIT_DISABLE_COMPOSITING_MODE=1` | 57 ms | 86 ms | 68 ms | 8 ms | Strong regression |
| `WEBKIT_FORCE_COMPOSITING_MODE=1` | 42 ms | 22 ms | 73 ms | 37 ms | Strong regression |
| `WEBKIT_DISABLE_DMABUF_RENDERER=1` | 15 ms | 57 ms | 32 ms | 7 ms | Moves substantial zoom cost after `finish` |
| `WEBKIT_DMABUF_RENDERER_FORCE_SHM=1` | 9 ms | 12 ms | 22 ms | 24 ms | Best zoom; brush still misses Pro |
| `WEBKIT_SHOW_DAMAGE=1` | 42 ms | 28 ms | 55 ms | 7 ms | Diagnostic overhead; no fix |
| DPR 2.39998, 2717×1882 backing | 98 ms | 6 ms | 51 ms | 3 ms | Fill-rate/synchronization cost grows sharply |

The apparent DMA-BUF gains require care. Across three complete runs, default zoom was 22–25 ms and
brush 32–39 ms; DMA-BUF-disabled zoom was 7–15 ms but brush 11–32 ms; forced-SHM zoom was consistently
7–9 ms while brush ranged 15–22 ms. Disabling DMA-BUF can make `gl.finish` return sooner while the RAF
proxy becomes much worse (57 ms in the final run), so it is not an end-to-end presentation fix.
Forced SHM is the only setting that consistently fixes the zoom `renderNow` gate, but it does not
reliably meet the 16 ms Pro brush gate and can shift latency into presentation. DPR 2.4 increases
large-canvas pixel count about fourfold and makes `gl.finish` 95 ms p95, identifying fill/sync cost,
not JavaScript, as the high-DPR limit.

## 46-MP JPEG split and native decode prototype

The fixture matches A1: a generated 10109×4542 JPEG (45,915,078 pixels, 0.414 MiB compressed).
The browser path reads it through Tauri, decodes with `createImageBitmap` and colour conversion
disabled, draws/reads an sRGB `OffscreenCanvas`, builds the immutable 256 px tiled raster, and uploads
the first WebGL frame. The native path uses `zune-jpeg`, expands RGB to straight-alpha RGBA, copies
720 tightly packed tiles, sends each through a Tauri binary channel, constructs the same `Raster` in
the WebView, and uploads it.

| Browser path | Final run |
|---|---:|
| File read | 14 ms |
| JPEG decode | 719 ms |
| Colour conversion + RGBA readback | 884 ms |
| Raster tiling | 572 ms |
| **End to raster** | **2189 ms** |
| First upload + `gl.finish` | 948 ms |
| **End to first uploaded frame** | **3137 ms** |

| Native `zune-jpeg` + binary tiles | Final run |
|---|---:|
| Native file read | 0.22 ms |
| JPEG decode + YCbCr-to-RGB | 181.98 ms |
| RGB-to-RGBA | 266.06 ms |
| Tile copies | 107.62 ms |
| Time in binary channel `send` calls | 7.08 ms |
| Native command total | 573.59 ms |
| **Command start to WebView raster (720 tiles)** | **1831 ms** |
| First upload + `gl.finish` | 983 ms |
| **End to first uploaded frame** | **2814 ms** |

The native codec reduces the final run's end-to-raster time by 358 ms (16.4%) and first-frame time
by 323 ms (10.3%), but does not meet the 1500 ms Pro open budget. Browser decode plus conversion was
1603 ms, while native decode plus RGBA expansion was 448 ms; roughly 1.26 s then elapsed between the
native command's internal completion and completion of WebView raster construction. The 720-message
tile channel, WebView delivery, and JS-side array assembly therefore erase most of the codec gain.
Across the three scripted runs, browser end-to-raster ranged 2116–2613 ms and native IPC-to-raster
1682–1831 ms. Five spatial pixel samples matched within one channel value, including both corners;
dimensions and all 720 tiles were validated.

## Native wgpu surface prototype

`src-tauri/src/a6_spike.rs` also creates a WebView-free Tauri window and a Vulkan wgpu surface. Ten
resident 4096² RGBA textures (640 MiB total) are drawn as textured quads with source-alpha blending
while pan/zoom changes. It uses FIFO presentation, maximum frame latency 1, 15 warm-up frames, and 90
measured frames. Each frame waits for GPU completion, matching the synchronization semantics of the
WebGL measurement.

| Intel HD 630 Vulkan stage | p95 | Median |
|---|---:|---:|
| **Whole frame** | **38.16 ms** | **32.79 ms** |
| Surface acquire | 0.09 ms | 0.05 ms |
| Encode + submit | 0.69 ms | 0.51 ms |
| GPU completion wait | 36.69 ms | 31.99 ms |
| Present call | 0.48 ms | 0.30 ms |

The native prototype is GPU-bound and slower than default WebGL zoom (22–25 ms p95) on the same Intel
GPU. Three scripted native runs ranged 32.40–39.22 ms p95. An exploratory run that accidentally chose
the discrete Quadro measured 18.84 ms p95 and is excluded from the comparison because A6 specifies
the Intel HD 630.

## Recommendation (measurement, not an architecture decision)

Do not integrate a native renderer on this evidence: the same-GPU wgpu prototype is 1.5–1.8× slower
than default WebGL zoom and adds a second rendering architecture. For the current WebView path,
forced-SHM is worth a controlled presented-frame/visual-correctness follow-up because it consistently
cuts zoom `renderNow` to 7–9 ms, but it is not yet a brush fix and the RAF results show that some cost
moves past `gl.finish`. Native JPEG decode is promising only if IPC is redesigned: codec/format work
drops from 1603 ms in the browser to 448 ms natively, yet 720 tile messages leave end-to-raster at
1831 ms. A shared buffer or batched tile transfer should be measured before any product architecture
choice. This spike therefore recommends two narrower follow-ups and makes no native/WebView decision.

## Implementation, APIs, and provenance

- `tests/webview/a6-spike.ts` exports
  `measurementDistribution(values)`, `runA6Spike(root, status?)`, and
  `startA6SpikePage(root)`; it contains the real-pixel JPEG, zoom, and brush probes.
- `src-tauri/src/a6_spike.rs` supplies feature-only Tauri commands for runtime settings, exact-file
  fixture access, zune decode/binary tile streaming, result capture, and the separate native wgpu
  window. `src-tauri/src/a6_quad.wgsl` is the prototype shader.
- `src-tauri/a6-run.sh` runs the complete setting/native matrix reproducibly. `src-tauri/src/lib.rs`
  and the Tauri frontend route the feature-only spike without changing normal product behaviour.
- `src-tauri/frontend/tauri-globals.d.ts` adds the binary `Channel` typing needed by the probe.
- `wgpu` 30.0.1 is `MIT OR Apache-2.0`; `zune-jpeg` 0.5.15 and `zune-core` 0.5.3 are
  `MIT OR Apache-2.0 OR Zlib`. They are optional and unreachable without `a6-spike`. The ownership
  boundary excludes `THIRD_PARTY_NOTICES.md`, so the dependency notice is recorded here.

This is new PRODUCT-PLAN A1/A6/§8 and M1/M2 measurement work; no upstream image-editor behaviour
was ported or changed. The scene and state transitions are taken from `tests/e2e/performance.spec.ts`,
and the A1 comparison numbers come from `artifacts/tauri-webview-matrix.md`.

## Deviations, limits, and open work

- Web content cannot obtain GTK's actual presentation timestamp. RAF is the closest non-invasive
  proxy; presented-frame tracing is still open before treating a shifted `gl.finish` cost as fixed.
- Browser colour conversion cannot be timed separately from 2D draw/readback. The generated fixture
  is untagged sRGB with no EXIF rotation; zune does not reproduce a general ICC/EXIF import pipeline.
- The fixture is intentionally highly compressible to match A1. Results do not represent a noisy
  camera JPEG of the same dimensions.
- The native renderer covers only resident textured quads and source-alpha blending. It omits editor
  blend modes, effects, masks, clipping, colour management, uploads, and CPU/GPU ownership transfer;
  it is a prototype, not an integration.
- No Windows or macOS measurements were made. No product setting was changed, and no native decode
  or renderer path is wired into normal application behaviour.

## Verification

The feature release build and the complete `src-tauri/a6-run.sh` matrix completed successfully.
The probe checked real dimensions, tile count, and decoded pixels rather than only checking for
errors. Final static/build checks were clean:

```text
$ npx tsc --noEmit -p .
(no output; exit 0)

$ npx vitest run tests/unit --maxWorkers=1
Test Files  38 passed (38)
Tests  355 passed (355)
Duration  81.19s

$ cargo check
Finished `dev` profile [unoptimized + debuginfo] target(s) in 5.01s

$ cargo check --features a6-spike
Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.76s

$ cargo test --features a6-spike --lib
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
```

The unit suite was serialized because unrelated concurrent Playwright jobs on the shared eight-core
machine caused the existing 4000×3000 TIFF benchmark to hit its 30 s test timeout in two parallel
runs; its measured decode body was only 5.6–6.6 s. The serialized run executed every one of the same
355 tests and passed.
