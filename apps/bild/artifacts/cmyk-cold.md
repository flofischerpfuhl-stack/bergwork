# Cold CMYK and grayscale setup

Date: 2026-09-27. Scope: PSD gray/CMYK product-worker open, profile transfer-table reuse,
first canvas frame, and the GPU process-table upload added by `cmyk-gpu.md`.

## Result and APIs

- `readPsdDocumentManaged(bytes, { deferColorTransfer: true })` returns the decoded, editable
  document with a bounded saved-composite preview before building its gray or CMYK process table.
  Normal direct callers retain the exact, ready-before-return behavior.
- `PsdReadResult.colorTransferReady` is the product-worker completion promise.
  `installPsdColorTransfer(document, result)` immutably installs the table on both the document and
  native PSD adjustment layers. `EditorController` redraws the same open tab when it resolves; batch
  and import-as-layers wait for exact colour because they have no interactive progressive frame.
- `buildPsdColorTransfer` caches immutable tables in the long-lived PSD worker. Embedded profiles are
  keyed by SHA-256 plus model/bit depth/intent/BPC/table dimensions. Fernwork's generated default
  profiles use versioned semantic keys because generated ICC header bytes are not stable identity.
- Gray 8/16-bit curves and the CMYK 33³ inverse + 17⁴ forward tables use the same mechanism. The
  second document with the same profile performs no Little CMS table build.
- `GpuCompositor` uses a small dedicated preview shader while the table is pending. The preview is the
  PSD saved composite reduced to at most 1,024 px per side; it is only transient presentation and is
  never the M14 fidelity oracle or the final editable render.
- CMYK transfer textures are now created and uploaded only when Difference, Exclusion, or Subtract
  actually samples process space. Normal passes bind the neutral texture and do not trigger an upload.
  Counters `progressiveColorFrames`, `progressivePreviewFrames`, and `cmykTransferUploads` make the
  behavior testable.

No dependency, model, licence notice, i18n key, or shared contract changed.

## Measurement

The 5,000×4,000 fixture and `gl.finish()` discipline are unchanged from `cmyk-gpu.md`. Its recorded
integration baseline was 1,677.43 ms in Chromium perf-gpu and 792.00 ms in WebKit. The new result is
the first visible progressive frame; the exact editable layer graph replaces it after worker table
readiness.

| Engine | 20 MP CMYK first visible frame, before | Progressive frame | Change |
|---|---:|---:|---:|
| Chromium perf-gpu / Intel HD 630 | 1,677.43 ms | 17.02 ms | 98.6× faster |
| Playwright WebKit / Xvfb | 792.00 ms | 62.78 ms | 12.6× faster |

Additional final-run measurements:

| Engine | CMYK cold table build | CMYK warm lookup | Exact CMYK replacement frame | Gray progressive frame | Gray warm lookup |
|---|---:|---:|---:|---:|---:|
| Chromium perf-gpu | 115.38 ms | 0.005 ms | 1,625.64 ms | 14.12 ms | 0.045 ms |
| WebKit | 118.76 ms | 0.000 ms | 883.44 ms | 14.58 ms | 0.000 ms |

The final probe recorded zero CMYK process-table uploads before the preview, exactly one upload for
the exact CMYK frame, two progressive preview requests, warm-cache hits for both CMYK and grayscale,
and zero document CPU fallbacks. Warm interaction remained within the existing budget: Chromium pan
p95 0.845 ms and WebKit pan p95 10.66 ms.

The run began at uptime `up 40 min`, load average `2.49, 3.12, 3.23`. Chromium reported
`ANGLE (Intel, Mesa Intel(R) HD Graphics 630 (KBL GT2), OpenGL ES 3.2)`; Playwright WebKit reported
`Apple GPU`, so the WebKit result remains same-machine browser evidence, not a WebKitGTK hardware
claim. The PSD fixture decode itself was heavily load-sensitive (12–16 seconds for CMYK in this run)
and was not part of the prior 1,677/792 ms compositor baseline; it remains separate I/O work rather
than being hidden in the first-frame number.

## Pixel and state evidence

- The progressive shader's sampled pixel equals the reduced saved-composite pixel (including the
  defined zero RGB at zero alpha).
- After install, the grayscale 20 MP GPU sample is byte-identical to the independent CPU compositor
  (maximum difference 0/255 in Chromium and WebKit).
- The existing managed CMYK GPU regression remains the independent final-frame guard and requires
  GPU = CPU within 1/255. A unit fixture additionally proves that installing a deferred CMYK table
  changes an actual threshold result from `[0,0,0,255]` to `[255,255,255,255]` and installs the same
  immutable table on document and adjustment state.

## Decisions and limits

- Memory caching is intentionally worker-local and LRU-bounded to 16 profile variants, which satisfies
  reuse across open documents without IndexedDB lifetime/eviction complexity. A browser restart
  rebuilds the small immutable table once.
- The preview keeps the editor responsive but is not editable-layer output; the exact replacement can
  still take roughly the former cold shader-composition time. Moving shader compilation off the WebGL
  main thread is not available in this architecture and shifting it into app startup would regress all
  RGB users.
- Real Tauri/WebKitGTK GPU measurement was not done because the required Xvfb isolation cannot
  represent the owner's real application/GPU.

## Verification

- Focused Chromium perf-gpu + WebKit: 4/4 passed in 2.0 minutes.
- Focused CMYK/PSD unit set: 3 files, 35 tests passed.
- Requested Chromium `colour-cmyk,psd` area: 42/42 passed in 5.3 minutes.
- Whole-project TypeScript: exit 0, no diagnostics.
- Full unit suite: 95 files, 820 tests passed in 64.18 seconds (`--maxWorkers=2`).
