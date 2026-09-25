# RAW / DNG import — Phase 3 evidence

Date: 2026-09-25
Branch: `p3-raw`

## Delivered

- Added the optional `CodecHost.decodeRaw(bytes, options)` v1 capability, plus `rawBackend`, `systemRawEnabled()` and `setSystemRawEnabled()`. `contracts.ts` was not changed.
- Added a browser-capable TypeScript DNG decoder for classic TIFF DNG files with:
  - uncompressed strips/tiles and SOF3 lossless-JPEG strips;
  - 2×2 CFA Bayer (RGGB and other tag-defined orders) and LinearRaw RGB;
  - edge-aware bilinear demosaic, black/white-level normalization, `AsShotNeutral`, `ColorMatrix1`, D50→D65 adaptation and sRGB encoding;
  - exposure, as-shot/auto/custom temperature+tint white balance, basic highlight recovery, and TIFF orientations 1–8;
  - straight-alpha RGBA16 output.
- Added the RAW import dialog. The selected development is committed as a 16-bit pixel layer. Editable/non-destructive RAW development settings after import are intentionally out of scope.
- Added Windows WIC host decoding behind `cfg(windows)`, using `IWICDevelopRaw` and 64-bit RGBA output. This is intended to use Microsoft's separately installed Raw Image Extension.
- Added an opt-in Linux runtime host using `dlopen`/`libloading` for system `libraw.so.23/.22/.21/.20/.so`. It uses camera white balance, AHD, 16-bit linear ProPhoto RGB and then the existing LittleCMS WASM path for conversion to the document's sRGB pixels. The preference is off by default and an absent library produces an installation-oriented error.
- Added a Pro preference labelled **Use system LibRaw (LGPL)**. No LibRaw code or library is bundled. The process retains an enabled library handle for its lifetime because some OpenMP-enabled LibRaw builds retain workers after processing and are unsafe to unload.
- Added generated DNG fixtures and browser, host-boundary, Rust, and benchmark-task-12 coverage. Test inputs are generated independently and are not derived from decoder output.
- Updated `THIRD_PARTY_NOTICES.md` for system-only LibRaw, Windows WIC/Raw Image Extension, and the ISC-licensed `libloading` crate.

## Decisions

- Pure TypeScript handles common DNGs in Lite/browser builds; proprietary camera RAW stays behind the Tauri `CodecHost` boundary.
- Linux LibRaw is explicit opt-in because it is an LGPL/CDDL system capability. Runtime lookup avoids a build-time or distribution dependency.
- LibRaw develops to linear ProPhoto rather than accepting its private sRGB conversion; the existing LittleCMS implementation performs the final 16-bit colour conversion.
- WIC and LibRaw return complete RGBA16 buffers across the IPC boundary. Streaming/tiled native decode was not added because import creates one pixel layer and this phase's common camera files fit the existing import limits.

## Verification

All runs used the lane worktree and the inherited invisible `DISPLAY=:99`. Playwright used `PLAYWRIGHT_BROWSERS_PATH=/home/oem/.local/share/fernwork-compositor-lab/browser-cache`, `E2E_PORT=6081`, private output under `/tmp/pw-out-raw`, and `--workers=1`.

- `npx tsc --noEmit -p .`: passed with no diagnostics.
- `npx vitest run tests/unit --maxWorkers=2`: **88 files passed; 742 tests passed; 0 failed; 69.98 s**.
- Chromium `tests/e2e/raw-dng.spec.ts`: **1 passed; 10.6 s**. It imports a generated lossless-JPEG Bayer DNG through the menu/dialog, applies +0.5 EV, creates an 18×10 `rgba16` layer, and verifies the three rendered colour patches.
- Firefox and WebKit, targeted `tests/e2e/raw-dng.spec.ts` only: **2 passed; 20.5 s**.
- Chromium benchmark task 12 only: **1 passed; 12.4 s**. It develops a generated lossless-JPEG DNG, verifies an `rgba16` layer, exports TIFF, and parses the TIFF tags to confirm 16-bit samples.
- DNG unit assertions: three Bayer colour patches each satisfy CIE76 **ΔE < 3**; LinearRaw satisfies **ΔE < 1**. Lossless-JPEG output is byte-for-byte equal to the independently packed uncompressed development result. Orientation 6 dimensions/pixel placement and exposure sample changes are also asserted.
- `source scripts/tauri-env.sh && cargo check --manifest-path src-tauri/Cargo.toml`: passed; finished in **3.11 s**.
- `source scripts/tauri-env.sh && cargo test --manifest-path src-tauri/Cargo.toml`: **7 passed; 0 failed**. The installed `/usr/lib/x86_64-linux-gnu/libraw.so.23.0.0` decoded a generated 64×64 Bayer DNG and produced independently checked red/green/blue patches.
- Load snapshot after final verification: `load average: 7.45, 10.33, 15.89` (uptime 5:15). Runner durations above are execution records, not performance claims.

Per the integrator's reduced-load instruction, the full Playwright suite and full Firefox/WebKit suites were not run in this lane. The complete unit suite was run once with two workers.

## Deviations and open verification

- The Windows WIC module is `cfg(windows)` and could not be compiled or exercised on this Linux machine. Pure option/IPC/result validation is unit-tested, but the integrator must compile and test WIC with the Microsoft Raw Image Extension on the Windows PC.
- The Linux host currently converts its linear ProPhoto result to sRGB through LittleCMS because imported document pixels use the editor's current sRGB working representation. A selectable Display P3 document working space is not part of this change.
- The Linux runtime test exercises a real installed LibRaw with a generated standards-compliant DNG, not a proprietary camera-vendor sample.
- Real-GPU Tauri measurements were not run under Xvfb, as required.

## Shared files changed

Minimal additive changes were made to `src/platform/hosts/types.ts`, `src/app/features.ts`, the central dialogs/controller/menu/i18n files, `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `THIRD_PARTY_NOTICES.md`, and `tests/benchmarks/scenarios.ts`. `contracts.ts` and `contracts-v2.ts` were not changed.
