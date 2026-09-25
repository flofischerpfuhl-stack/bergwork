# PSD/PSB writer

## Delivered surface

- `writePsdDocument(document, options)` returns PSD/PSB bytes, selected format and depth, plus a structured notice list that reuses the PSD import notice contract.
- `psdFormatForName(name, document)` selects PSD, PSB, or the large-document default for host save dispatch.
- PSD v1 is limited to 30,000 px per side. PSB v2 supports the product's Pro document limits. Both contain a CPU-rendered merged image, resolution, guides, global light angle and an ICC profile.
- Pixel layers retain 8-bit or native 16-bit samples. Groups retain pass-through/isolation and knockout state; blend mode, opacity/fill, clipping, raster/vector masks, locks and colour labels are serialized.
- Text carries editable `TySh` engine data and rendered pixels. Photoshop's native warp descriptor retains all 15 supported text-warp presets, orientation, bend and both distortions. Text paths are rasterized with a per-layer notice because `ag-psd` exposes `LayerTextData.textPath` as read-only. Shape/vector layers carry vector fill/stroke/path records and rendered pixels.
- All ten live layer styles use native Photoshop descriptors. Inner shadow, inner glow, bevel/emboss and satin retain their complete Phase-3 model parameters. Pattern Overlay additionally writes its referenced raw RGBA8 document resource to the PSD `Patt` table, so the effect's ID resolves after reopening.
- Embedded content carries placed-layer transform metadata and source bytes through `PlLd`/`SoLd`. Artboards are written as Photoshop artboard groups and document resources.
- File > Save As accepts `.psd`/`.psb` as document formats and remembers the target for later Save. Export As remains image-only. Tauri associations were not changed.

## Decisions and loss reporting

`ag-psd` 31 can read 16-bit data but rejects 16-bit writes. The writer therefore lets it create the descriptor/layer structure at 8 bit and performs a structural post-pass that restores native RGBA16 layer channels and rewrites masks, rasterized caches and the merged image as valid big-endian 16-bit channels. This avoids a fork of the dependency. The product CPU renderer now supplies its straight-alpha float composite for transformed RGBA16 layers and the merged image; `floatToRgba16` quantizes that result directly, so neither path passes through RGBA8. Untransformed RGBA16 samples remain copied exactly.

Features without a lossless Photoshop record are never silently omitted. Unsupported adjustments are replaced with a CPU-rendered pixel appearance and reported. Native grayscale Levels/Curves cannot retain their transfer semantics in the RGB PSD emitted by this writer, so they become editable 256-point RGB Curves descriptors with an `adjustment-grayscale-transfer` approximation notice. Live-filter parameters, non-destructive layer crop/warp, unresolved pattern resources, text paths, variable-font axes, vector markers and unavailable placed sources likewise produce notices with a layer path where applicable. A non-destructive crop is rendered into the layer cache; placed-layer mesh/quad warps remain editable and are not incorrectly reported as baked.

Layer-effect descriptor tolerance is the PSD descriptor precision: opacity-like values are integer percentages (at most 0.005 in normalized model units), scale/depth are within 0.5 model percentage point, and angles, distances, sizes, phases and descriptor RGB doubles round-trip to within `1e-9` apart from harmless IEEE-754 tails. Pattern resource IDs are content references and may be remapped on import; dimensions and RGBA8 bytes are exact. The all-style regression verifies every model field under those rules and then compares independent product CPU renders before and after reopening with a maximum channel delta of 1/255.

The merged image is rendered independently by `cpuCompositeRegion`; no reference/composite under test is used to produce its comparison target (M14). Effect-gradient descriptor colours remain floating-point values because rounding them before `ag-psd` writes Photoshop's double descriptors introduced a measurable second-generation delta.

No dependency or bundled model was added, so `THIRD_PARTY_NOTICES.md` is unchanged.

## Verification

- Writer unit coverage: 8 tests, including all ten live styles and pattern resources, text warp/path policy, crop/missing-resource notices, and native transformed-layer/merged-composite precision. Focused result: 1 file/8 tests passed in 1.73 s.
- Pinned `psd-tools` corpus (`30bf79c2a88e0fc63104ee85713e23b04362153d`): 300/300 files accepted, written, reopened and product-rendered within the native-reader threshold (maximum channel delta ≤ 1). Vitest: 1/1 passed in 570.06 s. Load average was 5.69/6.85/8.54 before and 15.49/12.78/10.47 after. The target pixels came from the imported document render, never its saved composite (M14).
- External parser: `psd-tools` 1.20.0 opened and composited generated native 16-bit PSD and PSB files plus an 8-bit Pattern Overlay PSD without errors. The wide files each reported the expected 3×1 canvas, depth 16 and two layers; the pattern file reported 2×1, depth 8 and one layer.
- `npx tsc --noEmit -p .`: passed with no diagnostics.
- Full unit run (`--maxWorkers=2`): 89 files/760 tests passed in 73.38 s; no timeout or retry. Load average was 19.37/15.35/11.77 before and 18.57/16.07/12.30 after.
- Save As PSD E2E: Chromium 1/1 passed in 11.3 s with `E2E_PORT=6097`, one worker and the task-private output directory.
- Full Chromium was run once: 319 passed, 15 skipped, 2 unrelated shared-load failures in 1.5h (a Layer Style lock-notice locator and a broad painting workflow timed out). Both exact failed tests passed unchanged when rerun alone, 2/2 in 55.5s. No timeout or assertion was raised.

Photoshop itself is not available in this environment. Compatibility evidence therefore consists of Fernwork read/write/read state and pixel checks, the pinned corpus, raw descriptor assertions, and independent `psd-tools` opening/compositing.

## Known limitations

- Features for which neither Photoshop nor `ag-psd` exposes an equivalent editable descriptor are rasterized and noticed; their appearance is retained but editability is not.
- Text on a path remains such a rasterized feature until `ag-psd` can write global text-frame path engine data. Non-destructive layer crop has no equivalent PSD layer parameter and is likewise baked.
- Grayscale source documents are written as RGB. Their native grayscale Levels/Curves transfer is approximated by a dense editable RGB Curves descriptor and explicitly noticed; the 300-file pixel round trip remains within 1/255.
- Photoshop application validation remains open because the application is unavailable.
