# RGBA16 engine fixes

## Root causes and fixes

1. **Painting was preview-only on RGBA16 layers.** `beginStroke` and the brush worker rejected `rgba16`; the background worker could also fail before its finish promise existed, so the controller never received the error. Brush coverage/compositing, tile snapshots, worker transfers, clone sampling, Paint/Erase, Dodge/Burn/Sponge, Blur and Smudge now use the raster's native sample type and maximum. Worker failures are retained and reported through `EditorSession.errorMessage`.

2. **Destructive edits crossed an RGBA8 worker boundary.** The adjustment/filter client called `Raster.toPixels()` and the worker reconstructed an implicit `rgba8` raster. Requests and responses now carry `PixelArray` plus `RasterFormat`, use `toPixelsNative()`, and reconstruct with the explicit format. The same native-sample treatment was applied to selection fill/clear, floating selections and pixel moves. The format-generic filter kernels already present are retained end-to-end.

3. **Managed 16-bit import ended in Little CMS `TYPE_RGB_8`.** The WASM bridge now accepts a separate output depth and exposes `transform16(...)`, backed by `TYPE_RGB_16`. ICC-tagged PNG/TIFF and synthesized PNG cHRM/gAMA profiles use it. All three tagged 2048-step QA ramps retain 2048 distinct red samples.

4. **Browser WebP decode destroyed RGB under low alpha through premultiplication.** WebP import now always uses the bundled libwebp WASM straight-alpha decoder. The QA lossless low-alpha corpus is exact in Chromium, Firefox and WebKit: mean RGB error 0.00, maximum RGB error 0, alpha error 0.00.

## Measured results

- Strong Levels export: RGBA8 = 64 distinct values / max step 7; RGBA16 = 254 distinct values / max step 1.
- Curves adjustment-layer export over RGBA16: 256 distinct exported 8-bit values / max step 1.
- Plain, ICC, cHRM/gAMA PNG16 and ICC TIFF16 precision fixtures: 2048 distinct native red samples each.
- Import-format corpus: 44/44 passed in each of Chromium, Firefox and WebKit.
- New `operations16.test.ts`: 38 cases cover all destructive adjustment and filter kinds plus brush modes, Clone Stamp, Blur, Smudge, Spot Healing, Content-Aware Fill, fill/clear, resampled pixel movement and Little CMS 16-bit output.

## Verification

- `npx tsc --noEmit -p .`: clean.
- Unit tests excluding the load-sensitive TIFF benchmark: 61 files, 511/511 tests passed. TIFF alone: 1 file, 17/17 tests passed.
- Corrected 16-bit QA spec in Firefox and WebKit: 22/22 passed. Chromium coverage is included in the full suite.
- Full Chromium end-to-end suite: 155 passed, 1 skipped, 0 failed in 32.1 minutes.

## Upstream references and deviations

- Brush composition and transaction naming follow `Compositor/Document/BrushStroke.swift` (`paintSnapshot`) and `EditorSession+Brush.swift` (`commitPaintSnapshot`). In particular, upstream names an eraser undo item `Erase`, not `Brush Stroke`; the imported QA assertion was corrected to require the exact upstream name for each mode.
- Blur/filter extent and premultiplied convolution follow `Compositor/Document/Filters.swift` (`PixelFilter.run` / `trimmed`).
- Content-aware fill and Spot Healing retain `rgba16` storage, but their bundled upstream C algorithms (`Rendering/ContentFill.c`, `Rendering/HealPixels.c`) remain internally RGBA8. Generated pixels in the affected region therefore have 8-bit source precision expanded to 16-bit; untouched pixels remain bit-exact. A true 16-bit rewrite of those stochastic/iterative kernels remains open.
- Threshold and Posterize intentionally produce fewer than 256 colour levels by definition; tests require RGBA16 output format but do not incorrectly require a continuous ramp from those quantizing commands.
