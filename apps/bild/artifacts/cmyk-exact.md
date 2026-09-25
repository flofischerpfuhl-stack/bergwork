# Exact CMYK transforms (Phase 3 follow-up)

Date: 2026-09-25. Scope: PRODUCT-PLAN A3 / Phase 3, core task 11.

## Result and APIs

- `lcms_create_rgb_to_cmyk_transform(...)` creates a real Little CMS sRGB → selected CMYK-profile transform for
  perceptual or relative-colorimetric intent, with optional black-point compensation. It accepts RGBA8/RGBA16 and
  emits CMYK8/CMYK16.
- `LittleCms.transformRgbToCmykInPlace(...)` streams at most 1,048,576 pixels through two bounded WASM buffers and
  replaces the caller's RGBA storage with CMYK. A 200 MP conversion therefore does not allocate a second 800 MB
  CMYK8 or 1.6 GB CMYK16 image. The export pipeline uses this exact path and hands the same buffer to TIFF/JPEG.
- The planner permits up to 300 MP only when the request is a Pro CMYK export; the existing 100 MP RGB/Lite export
  ceiling is unchanged. A unit test plans a 20,000 × 10,000 CMYK TIFF and rejects the same RGB TIFF.
- `lcms_create_proof_transform(...)` uses `cmsCreateProofingTransform` for sRGB → selected CMYK proof → sRGB.
  It applies the selected intent/BPC flags. Simulate Paper White uses absolute-colorimetric proof intent. A second
  proof transform uses `cmsFLAGS_GAMUTCHECK`; its Little CMS alarm colour becomes the warning channel in the 3D LUT.
- `buildCmykLut(...)` now samples both exact transforms. The compositor still uses a 17³ interpolated display LUT;
  exported pixels do not use that LUT.
- File-loaded profiles are retained exactly. Optional `ColorHost.outputProfiles()` lets the Tauri host enumerate
  local ICC/ICM files whose ICC header declares `CMYK`; browser builds keep the explicit file picker. Enumeration
  happens only after Proof Setup is opened and performs no network access.
- The runtime-created `Generic FOGRA39-like (approximation)` and `Generic SWOP-like (approximation)` profiles remain
  clearly labelled fallbacks. No third-party profile was added.

## Reproducible WASM build

The committed artifact was rebuilt locally with:

```sh
./scripts/build-lcms.sh
```

The script downloads Little CMS 2.19.1 from its official release URL, verifies SHA-256
`bfc54f7bab59fbc921012014a8032e4cba4abd46db47d46b76416a8c0b2815c8`, builds source plus
`src/wasm/lcms/lcms_wrapper.c`, and uses the pinned toolchain:

```text
emcc 6.0.10 (d6c521a7f05449857c76bd99e396895583cf2083)
clang 24.0.0git / LLVM a06d9165905ce89b5ffef2bbb84c886d60a9b8bf
-O3 -msimd128 -DCMS_NO_PTHREADS=1 -sALLOW_MEMORY_GROWTH=1
-ffile-prefix-map=<temporary-source>=/usr/src/lcms2-2.19.1
-ffile-prefix-map=<worktree>=/usr/src/fernwork-bildeditor
```

Committed output hashes after a clean second build:

```text
18d41cb2c65af5bb4e17f70059c1a3dbc983d63856ab8f5e26a4cb76fe48ab12  src/wasm/lcms/lcms.mjs
e75f0aded343d11640ac3904deb3582aa27efc2d13ec92388afd955c708f2034  src/wasm/lcms/lcms.wasm
```

Little CMS remains covered by the existing MIT notice in `THIRD_PARTY_NOTICES.md`; there is no new dependency.

## Independent colour oracle

`tests/unit/cmyk.test.ts` generates a 17³ RGB grid and sends the generated fallback ICC to
`scripts/cmyk-reference.py`. The oracle is Pillow 10.2.0 / Little CMS 2.14, independent of the committed WASM
Little CMS 2.19.1. All 4,913 samples run with perceptual and relative-colorimetric intents, each with BPC off/on.
CMYK results are decoded through the selected output profile and compared in CIEDE2000:

| Path | Maximum ΔE00 |
|---|---:|
| Exact WASM, RGB8 → CMYK8 | 0.0000 |
| Exact WASM, RGB16 → CMYK16 (normalized for the 8-bit oracle) | 0.0000 |
| Removed 7-step inverse-LUT search | 14.3076 |

The same unit file checks exact 8/16-bit round trips, actual decoded CMYK TIFF/JPEG pixels, ICC embedding, proof
pixels/gamut warning, and an input spanning the 1,048,576-pixel chunk boundary while retaining the original buffer.

## 46 MP Chromium measurement

Command (focused spec, one worker):

```sh
uptime
PLAYWRIGHT_BROWSERS_PATH=/home/oem/.local/share/fernwork-compositor-lab/browser-cache \
E2E_PORT=6095 npx playwright test tests/e2e/cmyk-export-perf.spec.ts \
  --project=chromium --workers=1 --output=/tmp/pw-out-lcms
```

At start: load average `7.10, 8.39, 11.79`. Image: 8,256 × 5,568 = 45,969,408 pixels. Output is a real
four-channel LZW CMYK TIFF with embedded ICC, 258,996,114 bytes.

| Stage | Time |
|---|---:|
| Exact Little CMS conversion | 2,614.86 ms |
| LZW TIFF encode | 16,394.21 ms |
| Exact conversion + encode | 19,009.07 ms |
| Previous warmed-LUT conversion | 11,203.99 ms |
| Previous projected conversion + unchanged encode | 27,598.20 ms |

The comparison is conservative: it excludes the old inverse-LUT construction time. Even so, the exact end-to-end
conversion/encode path is 31.1% faster than today's warmed-LUT path; the requested “no regression greater than 20%”
gate passes. This is headless Chromium CPU/WASM work; no real-GPU claim is made.

## Profile licensing finding

No profile was bundled. A FOGRA39-derived candidate exists in CTAN's `colorprofiles` package:
`FOGRA39L_coated.icc`. Its README records a creator-rights waiver and says the generated profile is free of known
copyright restrictions: <https://ctan.org/tex-archive/support/colorprofiles?lang=en>. The containing package is
presented under LPPL and public-domain/LPPL are not in this project's explicit MIT/BSD/Apache/ISC/OFL/Zlib allowlist,
so this report records the candidate and licence text link without adding it. The commonly distributed Adobe/ECI
FOGRA39 and IDEAlliance GRACoL/SWOP profiles require additional redistribution permission and were also not added.

## Verification and open items

- `npx tsc --noEmit -p .`: exit 0, no diagnostics.
- `npx vitest run tests/unit --maxWorkers=2`: 86 files passed, 742 tests passed, 67.65 s.
- Chromium `cmyk.spec.ts`: 3 passed, 30.7 s. Chromium 46 MP performance: 1 passed, 34.3 s.
- Core-task benchmark 11: 1 passed, 19.0 s.
- Chromium CMYK E2E: proof/gamut, TIFF8/TIFF16/JPEG export and file-loaded profile pass.
- Firefox CMYK E2E: the same three tests pass.
- WebKit: proof/gamut passes. Both CMYK export tests hit the pre-existing generic error “The export worker stopped
  unexpectedly”. The directly affected existing RGB TIFF test reproduces the same error on this integration base
  (`export-artboards.spec.ts`, `exports ... as tiff`), so it is not introduced by the LCMS path. It remains open in
  the existing WebKit export-worker infrastructure.
- Core task benchmark 11 now passes with AdobeRGB TIFF import, exact proof setup and decoded 16-bit CMYK TIFF output.
- `cargo check` could not reach the crate because this machine lacks `glib-2.0.pc`; it stopped in `glib-sys` before
  compiling product Rust. TypeScript covers the Tauri frontend bridge, but the new Rust enumeration command still
  needs a normal Tauri build environment check.
- Real-GPU and Tauri timing were not performed under Xvfb, as required by the task rules.

Shared files changed minimally for the required integration are `src/platform/hosts/types.ts`,
`src-tauri/frontend/host.ts`, `src-tauri/src/host.rs`, `src-tauri/src/lib.rs`, `src/io/exportPipeline.ts` and
`src/io/exportPlan.ts`, `tests/unit/export-pipeline.test.ts` and `tests/benchmarks/scenarios.ts`. `contracts.ts` is unchanged.
