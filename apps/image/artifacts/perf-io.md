# PERFIO — startup and I/O performance audit

Date: 2026-09-25
Scope: first interactive frame, image/project open, project/PSD save, Export As, batch, A4 tile swap, and Tauri file/RAW IPC.

## Outcome and ranking

| Rank | Finding | User-visible impact | Change |
|---:|---|---|---|
| 1 | All lazy feature chunks were fetched and parsed from one early idle callback. In practice that callback competed with the first usable frame, most visibly in WebKit. | High; startup input stalls of 0.8–1.1 s were observed. | Delay speculative warming for 2.5 s, then warm one feature per idle period. An invoked tool still loads immediately. |
| 2 | PNG/JPEG/TIFF/WebP/AVIF/GIF decode, colour conversion, hashing, and 256 px tile construction ran on the UI thread. | High; a 2048² PNG stopped timer progress for 1.1–2.0 s. | New module worker decodes and constructs tiles. Encoded input is copied once because the live raster retains it; decoded tiles transfer back without clone. RAW/HEIC/host overrides retain the direct path. |
| 3 | Native multi-file selection eagerly read every file, copied each `Uint8Array`, and constructed every `File` before sequential import began. | High memory/latency for multi-select and batch input on WebKitGTK. | Tauri file objects are now lazy range-backed blobs using 1 MiB binary `read_file_chunk` requests. Only the currently consumed file is materialised. |
| 4 | Native RAW camera bytes and the 16-bit RGBA result crossed Tauri IPC as JSON number arrays. | Very high CPU and allocation amplification on large RAWs. | Added `decode_raw_binary`: a small JSON options header plus binary camera bytes in, then an 8-byte dimension header plus little-endian RGBA16 out. |
| 5 | The ZIP writer cloned every immutable emitted chunk even when a streaming sink consumed it immediately. | High peak memory for retained JPEG/TIFF assets during `.fwimg` save. | Streaming sink mode passes owned chunks by identity; Blob mode still snapshots them. Allocation counters make this testable. |

No dependencies or licence notices changed. `contracts.ts` and `contracts-v2.ts` are unchanged.

Shared touch points were kept narrow: `src/ui/controller.ts` selects the decoder, `src/io/project.ts` returns writer metrics, `src/app/features.ts` schedules warm-up, and `src/app/batch/services.ts` selects the project-asset decoder. Native shared touch points are limited to lazy file objects in `src-tauri/frontend/host.ts` and registration of the binary command in `src-tauri/src/lib.rs`. The format decoders, compositor, raster contract, export pipeline, document model, and i18n table were not changed.

## Instrumentation/APIs

- `decodeImageAssetInBackground()` and `decodeImageFileInBackground()` expose the worker paths.
- `backgroundImageDecodeTimings()` reports decode/tile/finalise/total time and encoded, decoded, tile, and copied-input bytes (last 32 operations).
- `Zip64StreamWriter.metrics` and `writeArchiveStreaming(...).metrics` report emitted chunks/bytes and bytes copied by the writer.
- `nativeRawIpcTimings()` reports native RAW request/response byte counts and IPC latency (last 32 operations).
- `tests/e2e/perfio-startup.spec.ts` records first-interactive time, resource count/transfer, Long Tasks where supported, 10 ms heartbeat gaps, and loaded WASM. The dev-served `perfio.spec.ts` import check hashes all 16,777,216 decoded bytes rather than sampling only.

## Before/after measurements

All browser measurements used `DISPLAY=:99`, one worker, port 6117, and the pinned browser cache. Timings are wall-clock and are intentionally reported with machine load. WebKit's Playwright build identifies its renderer as `Apple GPU`; it is useful as a relative WebKit/JSC result but is not a WebKitGTK/llvmpipe or Tauri real-GPU measurement.

### Production startup

Command: `playwright test --config tests/e2e/perfio.playwright.config.ts --workers=1` against `vite preview`. The table is the same test and 2 s observation window before and after the staged warm-up change.

| Engine | Metric | Before | After | Change |
|---|---|---:|---:|---:|
| Chromium GPU | editor interactive | 992 ms | 522 ms | -47.4% |
| Chromium GPU | maximum 10 ms heartbeat gap | 831.83 ms | 321.10 ms | -61.4% |
| Chromium GPU | resources after observation window | 73 | 50 | -31.5% |
| Chromium GPU | transferred bytes | 649,474 | 509,412 | -21.6% |
| WebKit | editor interactive | 1,854 ms | 1,050 ms | -43.4% |
| WebKit | maximum 10 ms heartbeat gap | 1,125.36 ms | 644.68 ms | -42.7% |
| WebKit | resources after observation window | 71 | 61 | -14.1% |
| WebKit | transferred bytes | 650,243 | 593,034 | -8.8% |

Chromium Long Tasks changed from `[94, 257, 132, 763, 59, 52]` ms to `[79, 185, 262]` ms. WebKit does not implement the Long Tasks API, so the heartbeat is the cross-engine indicator. Neither run loaded WASM during the observation window: CanvasKit, codec kernels, and fonts remain feature/document driven rather than startup prerequisites.

- Before uptime/load: `up 8:17`, load averages `7.75, 9.26, 7.41`.
- After uptime/load: `up 8:18`, load averages `8.10, 9.25, 7.54`.

The final production Lite start chunk is 281.26 kB gzip against the 400 kB gate. The new decoder worker is a lazy 43.59 kB raw chunk and does not load at startup.

### Large lossless image import

The controlled benchmark generates one 2048×2048 lossless PNG, runs the unchanged direct decoder three times and the worker decoder three times in the same page, and verifies the complete RGBA output SHA-256 (`e9f525…`), a fixed pixel, and exactly 16,777,216 tile bytes for every run.

| Engine | Path | Total runs (ms) | Median total | Median max heartbeat gap |
|---|---|---|---:|---:|
| Chromium GPU | direct | 971.70, 1,118.71, 1,189.95 | 1,118.71 ms | 1,119.91 ms |
| Chromium GPU | worker | 1,343.46, 1,389.04, 1,022.66 | 1,343.46 ms | 10.25 ms |
| WebKit | direct | 1,981.36, 1,995.12, 1,740.00 | 1,981.36 ms | 1,991.98 ms |
| WebKit | worker | 1,554.60, 1,246.12, 1,153.58 | 1,246.12 ms | 11.32 ms |

The worker reduces the median main-thread stall by 99.1% in Chromium and 99.4% in WebKit. Total latency improves 37.1% in WebKit, but is 20.1% slower in Chromium for this unusually compressible fixture. The change is retained because a responsive editor during a one-second import is the primary outcome, WebKit gains in both dimensions, and main-thread finalisation is only 0.07–0.11 ms. Chromium renderer: `ANGLE (Intel, Mesa Intel(R) HD Graphics 630 (KBL GT2), OpenGL ES 3.2)`. The `uptime` captures retained load averages `6.35, 8.41, 7.43` (Chromium) and `8.87, 9.02, 7.57` (WebKit); their elapsed-uptime fields were not retained, a measurement-log deficiency. Only relative engine results are used.

A final same-page confirmation under substantially heavier load (`16:43:57 up 8:35`, load `16.52, 14.90, 11.70`) found median totals of 1,761.64 → 1,313.66 ms in Chromium and 2,201.14 → 1,988.50 ms in WebKit. Median heartbeat gaps changed from 1,764.61 → 9.84 ms and 2,209.22 → 12.00 ms respectively. This confirms the stable responsiveness result and shows that total-throughput deltas are load-sensitive. The encoded input was 101,988 bytes; one deliberate retained-source copy was reported on every worker run.

### Streaming/native allocation checks

| Path | Before | After | Evidence |
|---|---|---|---|
| ZIP to native sink | one writer clone for every emitted byte | 0 copied bytes in writer | 2 MiB exact payload test also checks sink receives the original object and archive reopens byte-exactly |
| Tauri multi-select | eager `fs.readFile` for all files plus an explicit full copy per file | size metadata only; requested 1.5 MB file read as 1 MiB + remainder, second file unread | exact unit test, 2 chunk calls and pixel/source bytes unchanged |
| Native RAW IPC | two JSON numeric arrays | disabled system LibRaw sends 0 bytes; enabled request = input bytes + 4-byte length + options; response = 8 bytes + 8 bytes/pixel | binary protocol/unit byte-order test; a 24 MP RGBA16 result is 192,000,008 bytes rather than a value-dependent JSON string |

The Tauri paths could not be given honest Chromium/WebKit wall-time comparisons: they exist only behind native commands, and the task explicitly forbids using the owner's display for a real-GPU Tauri run. The byte/copy deltas above are deterministic; real WebKitGTK/Tauri timing remains open.

### Export and batch observations

The existing 46 MP PNG Export As gate was rerun on the Chromium GPU project. Runs were 13,431 / 5,596 / 6,007 ms total; render was 644 / 750 / 673 ms and measured encode was 3,780 / 4,846 / 3,664 ms. Output was 46,804,571 bytes; legacy single-thread encode was 35,253 ms. Eight worker threads were active and the renderer was WebGL2. The warm Lite target (≤8 s) passes; the 3 s Pro target and cold run do not. The `uptime` capture retained load averages `5.72, 7.72, 7.29`; its elapsed-uptime field was not retained.

Batch processing is deliberately sequential and keeps one document live. Background image decoding now removes the UI-thread decode portion, including non-PNG project assets, without doubling document memory through speculative prefetch. Focused batch/large-save E2E tests pass; throughput itself was not re-measured because no concurrency policy changed.

## Remaining findings, ordered by expected gain

| Priority | Finding / proposed work | Estimated gain | Effort / risk |
|---:|---|---|---|
| 1 | Export currently allocates the complete output raster, then the large-PNG path slices all worker bands up front (approximately another full raster). Stream renderer bands through stateful PNG filtering/compression directly to `FileByteSink`. | Roughly 184 MB lower peak for a 46 MP RGBA8 export, earlier first write; likely material GC reduction. | High. PNG filters depend on the previous row; exact output and cancellation require a protocol redesign. |
| 2 | PSD import/export remains synchronous: `ag-psd`, channel conversion, `Raster.fromPixels`, and per-layer `toPixelsNative()` all create full buffers on the UI thread. | Seconds of UI responsiveness and one or more full-layer copies on large PSDs. | High; worker protocol plus strict PSD fidelity/oracle coverage. |
| 3 | The image worker still needs one encoded-input copy because the original bytes are retained for lossless project saves, and transiently holds decoded contiguous pixels plus tiles. Decode PNG/TIFF directly into tiles and compute the retained-source hash incrementally. | Remove about one decoded-image allocation (16.8 MB in the benchmark; hundreds of MB near limits). | High; colour-managed and 16-bit paths must remain bit-identical. |
| 4 | Project unzip accumulates non-PNG compressed chunks and consolidates them before decode; PNG already has a tile-streaming path. Add streaming TIFF/JPEG asset readers and return worker-built tiles directly from project read. | One encoded copy and one main-thread tiling pass for retained non-PNG assets. | Medium/high. |
| 5 | A4 scratch fault-in has bounded 256 KiB messages, but `TauriScratchHost` slices the response and `TileCache.load` slices again; store also hashes synchronously. | Estimated 5–15% swap-fault improvement and less churn, not a top interactive bottleneck. | Medium; align the binary header/view lifetime and move hash work off-thread. |
| 6 | Adaptive batch prefetch could overlap the next decode with current encode. | Estimated 15–30% throughput when decode and encode are balanced. | Medium and intentionally deferred: it can nearly double peak memory, conflicting with the A4 budget. |
| 7 | Two CanvasKit users can instantiate separate runtimes once text/vector features are used. | Approximately one 7.3 MB WASM download/cache is already shared, but duplicate runtime heap/state may be avoided. No startup gain because CanvasKit is lazy. | High; consolidate ownership across text/vector lifecycle. |
| 8 | Native streamed save still crosses IPC in 256 KiB messages and constructs one header+payload buffer per call. | Moderate command overhead on multi-gigabyte `.fwimg`; memory is already bounded. | Medium; use a long-lived channel/file handle and measure on real WebKitGTK. |

## Correctness and limitations

- Pixel equality is byte-exact in the new import benchmark, stronger than the required GPU/CPU tolerance of 1/255.
- Existing Chromium and WebKit format-import specs pass after routing controller imports through the worker.
- The `.fwimg` ZIP change preserves Blob snapshot semantics; only the awaited streaming-sink contract is zero-copy.
- HEIC, DNG/camera RAW, and caller-supplied native decoders stay on their capability-aware paths; capabilities are not cloned into a worker.
- Rust/Tauri compilation could not complete in this container because `glib-2.0.pc` is absent. The new command follows the existing `save_file_chunk`/scratch `Request<'_>` + `InvokeBody::Raw` pattern. TypeScript, both Vite bundles, and binary frontend tests pass. Whole-crate `cargo fmt --check` also encounters pre-existing formatting drift across unrelated host/RAW/screen code, so those shared files were not mass-reformatted. A native package build on the integration machine remains required.
- Full Tauri real-GPU and real WebKitGTK/llvmpipe timing was not done under Xvfb, per the display restriction.

## Verification summary

- `npx tsc --noEmit -p .`: exit 0, no diagnostics.
- `npx vitest run tests/unit --maxWorkers=2`: **92 files passed, 776 tests passed**, duration 97.10 s. The 4000×3000 TIFF test did not time out, so no isolated retry was needed.
- Final native-I/O focused check after the file MIME/default refinement: **2 files passed, 5 tests passed**, duration 8.46 s; TypeScript remained clean.
- PERFIO production-startup projects: **2 passed** in 12.1 s. Final high-load confirmation: Chromium 770 ms interactive, WebKit 1,727 ms; no startup WASM.
- PERFIO exact import projects (`PERFIO_DEV=1`): **2 passed** in 46.1 s.
- Existing import-formats: Chromium **4 passed** in 30.7 s; WebKit **4 passed** in 26.4 s.
- Existing batch plus large-save specs: Chromium **2 passed** in 1.4 min.
- Existing 46 MP export performance spec: **1 passed** in 1.4 min.
- Web and Tauri frontend production builds pass. Bundle budget: Lite start chunk 281.26 kB gzip ≤ 400 kB.
- `cargo test --manifest-path src-tauri/Cargo.toml raw_codec`: not completed because the build host lacks the required system `glib-2.0.pc`; see limitation above.

## FIXREG follow-up (2026-09-25)

Staggered warm-up remains enabled, but feature registration now invalidates shell UI without a session notification,
so background installers cannot trigger full composites during an overlay-only gesture. Feature-only Q loads Object
Selection on demand. PNG/JPEG below 2 MP use the direct decoder to preserve file-chooser/follow-up action ordering;
larger images retain worker decoding. The 2048² exact-pixel PERFIO check used the worker for all three runs, with
maximum timer gaps 5.20 / 5.20 / 8.13 ms versus 713.92 / 675.39 / 669.83 ms direct, and passed in 18.5 s.
Final host capture after the focused timing runs: `22:36:56 up 1:23`, load averages `4.29, 4.63, 6.23`.
