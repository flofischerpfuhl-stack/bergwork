# PSD/PSB writer

## Delivered surface

- `writePsdDocument(document, options)` returns PSD/PSB bytes, selected format and depth, plus a structured notice list that reuses the PSD import notice contract.
- `psdFormatForName(name, document)` selects PSD, PSB, or the large-document default for host save dispatch.
- PSD v1 is limited to 30,000 px per side. PSB v2 supports the product's Pro document limits. Both contain a CPU-rendered merged image, resolution, guides, global light angle and an ICC profile.
- Pixel layers retain 8-bit or native 16-bit samples. Groups retain pass-through/isolation and knockout state; blend mode, opacity/fill, clipping, raster/vector masks, locks and colour labels are serialized.
- Text carries editable `TySh` engine data and rendered pixels. Shape/vector layers carry vector fill/stroke/path records and rendered pixels. Supported adjustment layers and the requested layer styles use native Photoshop descriptors.
- Embedded content carries placed-layer transform metadata and source bytes through `PlLd`/`SoLd`. Artboards are written as Photoshop artboard groups and document resources.
- File > Save As accepts `.psd`/`.psb` as document formats and remembers the target for later Save. Export As remains image-only. Tauri associations were not changed.

## Decisions and loss reporting

`ag-psd` 31 can read 16-bit data but rejects 16-bit writes. The writer therefore lets it create the descriptor/layer structure at 8 bit and performs a structural post-pass that restores native RGBA16 layer channels and rewrites masks, rasterized caches and the merged image as valid big-endian 16-bit channels. This avoids a fork of the dependency. The generated merged image and transformed caches still come from the product's RGBA8 CPU renderer; every 16-bit write reports that precision limitation.

Features without a lossless Photoshop record are never silently omitted. Unsupported adjustments are replaced with a CPU-rendered pixel appearance and reported. Live-filter parameters, parametric crop/warp, pattern paint without a pattern resource, variable-font axes, vector markers, unavailable placed sources, transformed 16-bit caches, and 16-bit merged-image quantization likewise produce notices with a layer path where applicable.

The merged image is rendered independently by `cpuCompositeRegion`; no reference/composite under test is used to produce its comparison target (M14). Effect-gradient descriptor colours remain floating-point values because rounding them before `ag-psd` writes Photoshop's double descriptors introduced a measurable second-generation delta.

No dependency or bundled model was added, so `THIRD_PARTY_NOTICES.md` is unchanged.

## Verification

- Writer unit coverage: 3 tests for structure/pixels/resources, editable descriptors/source bytes, native 16-bit samples/PSB/notices.
- Pinned `psd-tools` corpus (`30bf79c2a88e0fc63104ee85713e23b04362153d`): 300/300 files accepted, written, reopened and rendered within the native-reader threshold (maximum channel delta ≤ 1). Vitest: 1/1 passed in 991.55s; command elapsed 994.98s. Load average was 23.56/21.54/17.45 before and 25.56/24.56/21.32 after.
- External parser: `psd-tools` 1.20.0 opened and composited generated 16-bit PSD and PSB files without errors; each reported the expected 2×1 canvas, depth 16, one layer and layer name.
- `npx tsc --noEmit -p .`: passed with no diagnostics.
- Writer unit test: 1 file, 3 tests passed. Full unit run: 80 files/661 tests passed; only the documented 4000×3000 TIFF benchmark exceeded the unchanged 30s test timeout while all files ran in parallel. The benchmark passed alone without changing its timeout or assertion: 1/1 passed in 25.48s at load averages 31.29→28.28.
- Save As PSD E2E: Firefox and WebKit 2/2 passed in 32.0s. Chromium's task-specific test passed within the full suite and again on the final controller tree, 1/1 in 10.0s.
- Full Chromium was run once: 319 passed, 15 skipped, 2 unrelated shared-load failures in 1.5h (a Layer Style lock-notice locator and a broad painting workflow timed out). Both exact failed tests passed unchanged when rerun alone, 2/2 in 55.5s. No timeout or assertion was raised.

Photoshop itself is not available in this environment. Compatibility evidence therefore consists of Fernwork read/write/read state and pixel checks, the pinned corpus, raw descriptor assertions, and independent `psd-tools` opening/compositing.

## Known limitations

- The product CPU renderer currently exposes 8-bit merged/transformed caches. Untransformed RGBA16 layer samples remain exact, while transformed 16-bit layers and the merged image are quantized and noticed.
- Features for which neither Photoshop nor `ag-psd` exposes an equivalent editable descriptor are rasterized and noticed; their appearance is retained but editability is not.
- Photoshop application validation remains open because the application is unavailable.
