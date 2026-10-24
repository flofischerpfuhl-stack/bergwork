# Phase-2 cleanup report

Date: 2026-09-25. Branch: `p2-cleanup`.

## Outcome

This pass removed the superseded measurement spike and dead compatibility paths, consolidated pixel-colour helpers,
made the measurement frontend/Rust command opt-in, and removed duplicate subject-model and archive ownership. The
frozen `contracts.ts` and `contracts-v2.ts` were not changed.

### Safe removals (A)

- **A1:** removed `a6_spike.rs`, `a6_quad.wgsl`, `a6-run.sh`, `scripts/tauri-a6b.sh`, the A6 browser harness, the
  Cargo feature/dependencies, and all Rust wiring. Moved the dirty-region brush pixel test and its page to
  `tests/e2e/`; it remains a direct GPU incremental-vs-full and committed-CPU-byte check.
- **A2:** added the empty Rust `measurement` feature. `write_matrix_result` is compiled and registered only with
  that feature. The WebView matrix and A4c frontend modules are dynamic imports emitted only when
  `VITE_FERNWORK_MEASUREMENT=1`; a standard Tauri frontend build contains neither chunk.
- **A3:** removed automatic font/ICC startup probes from the frontend. The explicit `FERNWORK_HOST_SMOKE` Rust path
  remains.
- **A4:** removed dead archive worker/client exports, dead encoded-asset helpers, the obsolete subject download
  cache and URL aliases, unused canvas-operation result wrappers, and unused translation entries. `rg` finds no
  remaining references to the removed names in `src` or `tests`.
- **A5:** removed `LayerCommon.locked`. Live layers now have only `locks.all`; the v1 and `.comp` readers still map
  their legacy `locked` field into `locks.all`, and v1 serialization still projects it back for compatibility.
- **A6:** added `src/core/pixel/color.ts` as the single RGBA8 premultiply/unpremultiply and sRGB transfer module;
  blend, adjustments, content fill, healing, and wand code now consume it.
- **A7:** deleted the main-thread session wrappers that existed only for tests. Unit coverage calls pure engines or
  the real operations worker, and the UI test now verifies crop/canvas-size undo through product controls.
- **A8:** Tauri associations and native filters now include PSD/PSB and the supported AVIF/GIF paths.
- **A9:** removed the stale “Not yet available in the browser port” fallback and translations that had no source or
  test references.
- **A10:** moved `canvasops.benchmark.test.ts` from unit tests to `tests/performance`.
- **A11:** removed the unused Python WebKitGTK fallback.
- **A12:** rewrote the README product name/API/architecture summary and brought the Tauri and HEIC documents in
  line with versioned capabilities, streaming saves, the opt-in HEIC path, and measurement builds.

### Defect merges (B)

- **B2:** `ModelHost` is the sole persistent model-byte cache. It returns checksum-verified bytes to
  `modelInference`, which transfers them in `SubjectWorkerRequest`; deprecated URL override/download APIs and the
  worker byte cache were deleted. The worker retains only the ONNX session and recent inference masks.
- **B3:** current saves and recovery copies already use `writeArchiveStreaming` directly, so the reported double
  encode had been fixed after the original audit. The now-unreferenced archive worker/client and their encoded-byte
  cache bridge were removed.

### Notices (C11)

`npm run notices` regenerates `THIRD_PARTY_NOTICES.md` from `npm ls --omit=dev --all` and the locked, active
Rust normal/build graph for the current Linux release target. The generated inventory contains **44 npm packages**
and **317 Rust crates**, followed by curated notices for native codecs, models, fonts, copied kernels, and
development-only fixtures. Generation fails if an installed package has no declared licence.

The About text now names libwebp, libavif, dav1d, libaom, libjpeg-turbo, lcms/Little CMS, and opt-in libheif. The
inventory exposes the existing MPL-2.0 and Unicode-3.0 transitive crates; per M13 no dependency or release policy
was changed, and Tauri remains internal pending legal advice. Running `cargo deny check licenses` without a
repository policy file rejects every licence by default, so it is not used as a green gate; the generator consumes
Cargo's locked metadata directly.

## Verification and measurements

- TypeScript: `npx tsc --noEmit -p .` — clean (no output).
- Unit: an earlier full run passed **78 files / 657 tests** in **25.43 s**. The final full rerun under load
  32.41/30.95/28.26 finished **76 files / 655 tests passed** with two unchanged timeout failures: the 4000×3000
  TIFF benchmark and `BrushIntersectionTests accumulationDependsOnDistanceNotEventCount`. As required, both were
  rerun alone without raising a limit: TIFF passed **17/17** in **25.80 s** and brush passed **13/13** in **11.67 s**.
- Rust default check: finished successfully in **0.87 s**; measurement-feature check in **2.71 s**.
- Rust tests: **6 passed, 0 failed**; main/doc tests **0 failed**.
- Web build: `npm run build` passed, 1,012 modules transformed in **2.93 s**.
- Tauri frontend: standard and `VITE_FERNWORK_MEASUREMENT=1` builds both passed. Only the flagged build emitted
  `matrix` (3.74 KB gzip) and `largeDocumentAcceptance` (2.22 KB gzip) chunks.
- Startup gzip (`node scripts/export-start-size.mjs dist`): **584.38 KB before** at load 7.53/8.43/8.43;
  **583.86 KB after** at load 4.25/4.96/5.76, a **0.52 KB reduction**. The A10 limit of 400 KB is still missed by
  **183.86 KB**; this pass does not conceal that existing failure with a raised limit.
- Full Chromium at port 5971 and `/tmp/pw-out-cleanup`: **319 passed, 16 skipped, 1 failed** in **57.8 min**. Initial
  load was 13.68/10.60/7.96. The moved dirty-brush test and all subject-model tests passed. The sole failure was the
  pre-existing `qa-fwimg.spec.ts` canvas-drop race: it observed the original `Layer 1`, `Layer 2`, `Gezogen`
  document instead of the legacy ZIP. An exact isolated rerun failed identically at load 33.36/31.44/27.34. The
  test's first wait checks for `Gezogen`, which exists before the first drop, so it can dispatch the second drop
  while the first asynchronous project open is pending. No timeout/assertion was changed and no skip was added.

## Decision items deliberately left unchanged

The task text says the C1–C13 table is reproduced, but it supplies only C11; the definitions for C1–C10, C12, and
C13 are absent from both the prompt and the repository. I therefore did not invent an identifier mapping. The
current decision-bearing/open states found in `artifacts/roadmap-status.md`, `artifacts/handoff.md`, and the binding
plan remain untouched:

- `.comp` writing remains implemented for compatibility tests but absent from the product menu.
- Grid/smart guides and the non-destructive crop tool remain partial.
- Brush presets/ABR and Liquify/generative fill remain Phase-3 work.
- Mesh warp/perspective/straighten remain Phase-3 work.
- Native PSD read fidelity remains 201/300 (67%); PSD write and RAW remain missing.
- PDF placement remains behind a host capability because the Fernwork PDFium build is not release-approved.
- The A9 user test remains owner-deferred; 7/20 core tasks remain red for Phase-3 capabilities (PSD write, CMYK,
  RAW, recipes/batch, text on path, mesh warp, and the disk-heavy 200 MP/30-layer run).
- The 400 KB startup budget, WebKitGTK brush budget, 200 MP latency gates, and idle-machine 46 MP export timing
  remain open performance decisions.
- MPL-2.0/Unicode-3.0 legal approval remains open under M13; dependencies were not changed.

## Deviations and shared files

No new dependency, network path, telemetry, format change, or upstream behaviour was introduced. Shared product
files changed minimally where required: layer/document/session types, project compatibility, host capability types,
controller/About strings, Tauri configuration/entry, and their direct tests. Historical measurement reports were
not rewritten; consequently `artifacts/roadmap-status.md` still names the dirty-brush test's old `tests/webview`
location, while the executable test now lives in `tests/e2e` as required.
