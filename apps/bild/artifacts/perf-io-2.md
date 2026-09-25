# PIO2 — PSD worker I/O and streamed PNG export

Date: 2026-09-25

## Outcome

PSD product import and save no longer run `ag-psd`, channel conversion, `Raster.fromPixels`,
`Raster.toPixelsNative`, compositing, or the writer on the UI thread. A lazy module worker exchanges
the encoded input/output and independent 256 px raster tiles as transferables. Synchronous PSD APIs
remain unchanged for the fidelity and writer-oracle suites.

Large single-file RGB PNG exports with a `FileByteSink` now render directly into the same row bands
used by the parallel PNG workers. PNG header, zlib header, ordered IDAT chunks, combined Adler-32 and
IEND are written directly to the sink. The path does not allocate a complete output raster or assemble
a complete PNG. Other formats, multi-file ZIP export, small PNGs, and download-only hosts keep the
existing pipeline.

No dependency, licence notice, contract, i18n key, network behaviour, or generated artifact changed.

## APIs and instrumentation

- `readPsdDocumentInBackground(bytes)` and `writePsdDocumentInBackground(document, options)` are the
  product PSD entry points.
- `backgroundPsdTimings()` reports codec, tile pack/unpack, main-thread, total, tile-count, tile-byte,
  and copied-byte metrics for the last 32 operations.
- `packPsdValue` / `unpackPsdValue` preserve shared `Raster` identity and reconstruct real Raster
  prototypes from transferred sparse tiles.
- `runPngExportToSink(...)` is the one-file streaming counterpart of `runExport(...)`;
  `canStreamPngExport(...)` selects it only for PNG outputs at or above 1 MP.
- `streamPngBands(...)` returns band count, rendered bytes, written bytes, and the avoided full-output
  allocation. It uses exactly the same band boundaries and worker compression protocol as the retained
  large-PNG encoder.

## PSD responsiveness and equality

Fixture: `blend-modes/rgb-blend-modes.psd`, 1,870,147 encoded bytes, 164 layers. Each comparison ran
the old synchronous API and the product worker in the same page. Correctness compares the independently
rendered editable layer documents, never Photoshop's saved composite (M14). Writer outputs are compared
byte-for-byte. Times are milliseconds.

| Engine / operation | Direct total | Direct max heartbeat gap | Worker total | Worker max heartbeat gap | Gap change |
|---|---:|---:|---:|---:|---:|
| Chromium `perf-gpu` read | 2,688.36 | 2,695.27 | 3,222.32 | 392.25 | -85.4% |
| Chromium `perf-gpu` write | 6,724.94 | 6,725.80 | 9,319.62 | 45.87 | -99.3% |
| Playwright WebKit read | 4,596.30 | 4,631.36 | 6,044.54 | 130.64 | -97.2% |
| Playwright WebKit write | 8,064.40 | 8,254.84 | 11,240.28 | 104.24 | -98.7% |

The writer copied/transferred 58,211,138 live tile bytes in 380 nonzero tiles. Its main-thread pack and
finalise time was 42.38 ms in Chromium and 40.94 ms in WebKit; worker-side tile reconstruction was
30.14 ms and 128.44 ms respectively. Both worker writers produced the same 15,435,554 bytes as their
direct reference. Read output had maximum rendered-layer difference 0 in both engines.

Total PSD time is intentionally not claimed as improved: worker startup, input preservation, tile
transfer, and live-document tile copies raised the measured total. The user-visible win is that the UI
keeps advancing instead of freezing for 2.7–8.3 seconds. Baseline/final measurement starts were:

- Initial PSD comparison: `21:32:09 up 18 min`, load `7.76, 6.40, 4.12`.
- Final read/write comparison: `21:54:43 up 41 min`, load `9.91, 15.00, 12.93`.

## 46 MP PNG streaming

Fixture: the existing deterministic 8,256 × 5,568 (45.97 MP) WebGL2 export benchmark. The streamed
output was compared byte-for-byte against the existing worker output while it was written; it was not
decoded and reused as its own pixel source.

Deterministic changes in both engines:

- 7 transferable renderer/compression bands and 10 sink writes.
- 183,877,632 bytes of complete RGBA8 output allocation avoided.
- 184,075,776 renderer-band bytes include the six required previous-row filter contexts.
- First sink write was 6 ms in Chromium and 4 ms in WebKit (header before rendering).
- Exact output: Chromium 46,804,571 bytes; WebKit 48,482,769 bytes. Each matched that engine's retained
  parallel-worker output exactly.

| Engine | Retained pipeline totals | Streamed total | Result |
|---|---:|---:|---|
| Chromium `perf-gpu` | 14,828 / 7,209 / 5,562 ms | 4,649 ms | 16.4% below the warm retained run; exact bytes |
| Playwright WebKit | 23,504 / 4,360 / 4,387 ms | 5,207 ms | within the load-sensitive warm band, not a throughput win; exact bytes |

The Chromium before-change run at `21:19:45 up 6 min`, load `5.61, 2.98, 1.28`, measured retained
totals 12,516 / 4,652 / 3,898 ms (render 728 / 713 / 652 ms; explicit encode 3,804 / 3,247 /
2,942 ms). The after run began at `21:33:49 up 20 min`, load `7.78, 7.02, 4.58`. WebKit began at
`21:35:35 up 22 min`, load `11.53, 8.97, 5.57`. The shared host was substantially busier during the
after runs, so only same-process deltas and deterministic allocation/byte results are treated as evidence.

The 3 s Pro target remains open. Streaming removes the extra 183.9 MB allocation and starts file I/O
early, but compression remains the limiting stage. The warm Lite target remains met.

## Fidelity and verification

- `npm run psd:fidelity`: **3 files passed, 6 tests passed**, duration **1016.95 s** under load. Fidelity
  remained **224/300 (74.7%)**. The writer corpus accepted and round-tripped all **300/300** files with
  no pixel failure. `artifacts/psd-fidelity.md` regenerated byte-identically and was not committed.
- Focused unit tests after implementation: **4 files passed, 45 tests passed** (PSD read/write plus
  protocol/export), then **2 files passed, 20 tests passed** after the final streaming sequencing change.
- Existing PSD open/save workflows: Chromium **6 passed** across the combined/isolated runs; WebKit
  **6 passed** in 28.1 s.
- FileByteSink product-path test: Chromium **1 passed** in 7.2 s; WebKit **1 passed** in 9.1 s. It
  decodes the ordered chunks and checks the 1024² transparent document pixels/state.
- 46 MP performance/equality: Chromium **1 passed** in 1.6 min; WebKit **1 passed** in 1.7 min.
- Production Vite build passed. The lazy PSD client is 3.06 kB raw / 1.39 kB gzip; the worker is 474.89 kB
  raw and does not enter the start chunk.
- Performance unit suite: 3 files passed; the two brush finish guards missed by 5.34/8.34 ms while
  load was about 13–14. The directly rerun brush file then passed **4/4** in 9.41 s without changes.
- Final `npx tsc --noEmit -p .`: exit 0, no diagnostics.
- Final `npx vitest run tests/unit --maxWorkers=2` at load `10.63, 13.30, 12.94`:
  **93 files passed, 782 tests passed**, duration **104.10 s**. The 4000×3000 TIFF test did not time out.

## Open work and limitations

- The Pro 46 MP PNG target (≤3 s) is not reached. A native/host compressor or a shared-memory pipeline
  needs measurement; changing PNG bytes or weakening the exact oracle was rejected.
- PSD write responsiveness costs total latency and one copy of every live nonzero tile because worker
  transfer must not detach the immutable document. Shared memory or native compute could remove that copy.
- Streaming currently covers one large RGB PNG to a host byte sink. ZIP/multiple outputs and non-PNG
  codecs remain buffered; browser download fallback has no streaming destination.
- Playwright WebKit is relative JSC/WebKit evidence under Xvfb, not a real WebKitGTK/Tauri GPU result.
  The Tauri app was not started, per the display/single-instance restriction.
