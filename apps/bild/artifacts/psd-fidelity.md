# PSD fidelity baseline

Corpus: psd-tools commit `30bf79c2a88e0fc63104ee85713e23b04362153d`; 300 PSD/PSB files. ag-psd 31.0.2 plus native non-RGB layer-channel decoding.

The oracle is each PSD’s embedded Photoshop composite. Metrics are absolute byte deltas over premultiplied RGB plus
alpha (so undefined straight RGB below transparency is ignored): mean over all channels and the nearest-rank 99th
percentile. A file passes only when both limits for its primary feature folder pass.
The runner is a measurement baseline: fidelity failures are reported but do not make the command itself fail.

Overall: 300/300 parsed, 300/300 rendered, 198/300 passed (66.0%).
The Product Plan A7 acceptance target of at least 90% is **not met** by this baseline.

Second-round input baseline: 181/300 (60.3%). Current native result: 198/300 (66.0%), a net gain of 17 files.
Per-folder pass-count changes: blend modes 30→28, adjustments 13→18, layers 29→32, group clipping 0→1,
and root 58→68; effects 11, paths 12, masks 0, transparency 13, colour modes 5, colour profiles 1,
gradients 4, and descriptors 5 are unchanged. The overlapping 16/32-bit and PSB tags changed 7→16 and
22→27 respectively. The two blend-mode regressions are the RGB and grayscale artboard fixtures; their
editable artboard/vector-mask structure still lacks a faithful canvas model.

## Thresholds and feature summary

| Feature | Limits (mean / p99) | Files | Parsed | Rendered | Passed | Pass rate | Top failure causes |
|---|---:|---:|---:|---:|---:|---:|---|
| blend-modes | ≤ 2 / ≤ 8 | 32 | 32 | 32 | 28 | 87.5% | unsupported: artboards (3); wrong math/order/colour conversion (1) |
| adjustments | ≤ 8 / ≤ 64 | 39 | 39 | 39 | 18 | 46.2% | unsupported: ag-psd-parser (19); wrong math/order/colour conversion (2) |
| layers | ≤ 2 / ≤ 16 | 36 | 36 | 36 | 32 | 88.9% | wrong math/order/colour conversion (4) |
| effects | ≤ 8 / ≤ 64 | 15 | 15 | 15 | 11 | 73.3% | unsupported: advanced-blending (3); unsupported: ag-psd-parser (1) |
| path-operations | ≤ 4 / ≤ 32 | 12 | 12 | 12 | 12 | 100.0% | — |
| masks | ≤ 3 / ≤ 24 | 1 | 1 | 1 | 0 | 0.0% | wrong math/order/colour conversion (1) |
| group-clipping | ≤ 3 / ≤ 24 | 1 | 1 | 1 | 1 | 100.0% | — |
| transparency | ≤ 4 / ≤ 32 | 16 | 16 | 16 | 13 | 81.3% | unsupported: advanced-blending (1); unsupported: ag-psd-parser (1); unsupported: knockout (1) |
| colormodes | ≤ 3 / ≤ 24 | 17 | 17 | 17 | 5 | 29.4% | unsupported: bit-depth:16 (4); opened flattened (layers not decoded) (2); unsupported: ag-psd-parser (2) |
| colorprofiles | ≤ 3 / ≤ 24 | 1 | 1 | 1 | 1 | 100.0% | — |
| gradients | ≤ 4 / ≤ 32 | 4 | 4 | 4 | 4 | 100.0% | — |
| descriptors | ≤ 2 / ≤ 16 | 6 | 6 | 6 | 5 | 83.3% | wrong math/order/colour conversion (1) |
| 16/32-bit | ≤ 3 / ≤ 24 | 29 | 29 | 29 | 16 | 55.2% | unsupported: ag-psd-parser (5); unsupported: bit-depth:16 (4); unsupported: bit-depth:32 (3) |
| PSB | ≤ 2 / ≤ 16 | 37 | 37 | 37 | 27 | 73.0% | wrong math/order/colour conversion (5); unsupported: advanced-blending (2); unsupported: ag-psd-parser (1) |
| root | ≤ 2 / ≤ 16 | 120 | 120 | 120 | 68 | 56.7% | unsupported: ag-psd-parser (15); wrong math/order/colour conversion (14); unsupported: advanced-blending (8) |

Files in the `16/32-bit` and `PSB` rows are also counted in their feature/root row.

## Photoshop blend-mode oracle

| Mode | Mapping | Oracle result | Before mean / p99 | After mean / p99 |
|---|---|---:|---:|---:|
| normal | native | pass | 0.088 / 1 | 0.088 / 1 |
| dissolve | native | fail | 55.813 / 223 | 56.095 / 255 |
| darken | native | pass | 0.168 / 1 | 0.168 / 1 |
| multiply | native | pass | 0.168 / 1 | 0.168 / 1 |
| color burn | native | pass | 0.129 / 1 | 0.129 / 1 |
| linear burn | native | pass | 8.966 / 96 | 0.168 / 1 |
| darker color | native | pass | 13.010 / 97 | 0.087 / 1 |
| lighten | native | pass | 0.048 / 1 | 0.048 / 1 |
| screen | native | pass | 0.048 / 1 | 0.048 / 1 |
| color dodge | native | pass | 0.089 / 1 | 0.089 / 1 |
| linear dodge | native | pass | 10.373 / 97 | 0.048 / 1 |
| lighter color | native | pass | 10.462 / 96 | 0.088 / 1 |
| overlay | native | pass | 0.128 / 1 | 0.128 / 1 |
| soft light | native | pass | 14.987 / 96 | 0.129 / 1 |
| hard light | native | pass | 0.131 / 1 | 0.131 / 1 |
| vivid light | native | pass | 0.088 / 1 | 0.088 / 1 |
| linear light | native | pass | 0.217 / 1 | 0.217 / 1 |
| pin light | native | pass | 0.088 / 1 | 0.088 / 1 |
| hard mix | native | pass | 13.490 / 96 | 0.129 / 1 |
| difference | native | pass | 0.048 / 1 | 0.048 / 1 |
| exclusion | native | pass | 10.376 / 97 | 0.048 / 1 |
| subtract | native | pass | 15.030 / 97 | 0.087 / 1 |
| divide | native | pass | 19.362 / 130 | 0.130 / 1 |
| hue | native | pass | 0.166 / 1 | 0.166 / 1 |
| saturation | native | pass | 0.173 / 2 | 0.173 / 2 |
| color | native | pass | 0.250 / 2 | 0.250 / 2 |
| luminosity | native | pass | 0.119 / 1 | 0.119 / 1 |

Native formula failures: dissolve (fail).
Unsupported modes: none.
All 26 deterministic modes pass. Dissolve uses the Photoshop binary-alpha probability rule, but a PSD does not
store the random dither table used to create its embedded composite. The editor therefore uses a stable coordinate/layer
hash; density is reproducible and CPU/GPU-identical, while individual dots cannot match this saved oracle.

## Unsupported and approximated features

Nothing detected by the adapter is silently discarded. Counts below are layer/file occurrences; editability-only items
use the PSD’s saved pixel cache and can still match the visual oracle.

| Impact and feature | Occurrences |
|---|---:|
| editability-only: ag-psd-parser | 170 |
| editability-only: compatibility-preview | 150 |
| not-rendered: advanced-blending | 136 |
| not-rendered: mask-pixels | 104 |
| not-rendered: ag-psd-parser | 80 |
| approximated: mask-default | 79 |
| editability-only: lock-artboards | 72 |
| editability-only: generated-fill-cache | 42 |
| editability-only: color-mode:1 | 20 |
| approximated: bit-depth:32 | 17 |
| approximated: knockout | 16 |
| not-rendered: real-mask | 16 |
| editability-only: color-mode:4 | 15 |
| approximated: bit-depth:16 | 12 |
| approximated: mask-density | 11 |
| approximated: vector-fill:pattern | 10 |
| not-rendered: pattern-overlay | 9 |
| not-rendered: bevel | 8 |
| editability-only: flattened-composite | 6 |
| not-rendered: artboards | 6 |
| not-rendered: mask-feather | 6 |
| approximated: color-mode:9 | 5 |
| not-rendered: orphan-clipping | 5 |
| approximated: embedded-icc | 4 |
| approximated: bit-depth:1 | 3 |
| approximated: color-mode:0 | 3 |
| approximated: gradient-overlay | 2 |
| not-rendered: adjustment:color lookup | 2 |
| approximated: color-mode:8 | 1 |
| editability-only: color-mode:2 | 1 |
| editability-only: color-mode:3 | 1 |
| editability-only: color-mode:7 | 1 |
| not-rendered: inner-glow | 1 |
| not-rendered: inner-shadow | 1 |
| not-rendered: satin | 1 |
| not-rendered: stroke-pattern | 1 |

### ag-psd parser warnings

| Warning | Occurrences |
|---|---:|
| Unhandled additional info: CAI  | 75 |
| Unhandled additional info: GenI | 75 |
| Unhandled additional info: OCIO | 75 |
| Unread 2 bytes left for additional info: vstk | 8 |
| PSD has no decodable layer records | 4 |
| Unread 2 bytes left for additional info: PtFl | 4 |
| Unhandled additional info: Mt32 | 2 |
| Compression not supported: 0 | 1 |
| Invalid layer size | 1 |
| Unhandled additional info: extd | 1 |
| Unread 2 bytes left for additional info: artb | 1 |
| Unread 4 bytes left for additional info: brst | 1 |
| Unread 576 bytes left for additional info: Patt | 1 |
| Unread 88 bytes left for additional info: shmd | 1 |

## Per-file results

Every remaining failing file is listed below. In a failing row, `—` means that no unsupported record was detected;
the remaining cause is therefore rendering math, ordering, or colour conversion rather than a discarded feature.

| File | Primary feature | Parsed | Rendered | Pass | Mean | p99 | Max | Unsupported (non-editability) / error |
|---|---|---:|---:|---:|---:|---:|---:|---|
| 0layers_tblocks.psb | root | yes | yes | no | 250.166 | 255 | 255 | — |
| 0layers_tblocks.psd | root | yes | yes | no | 250.166 | 255 | 255 | — |
| 0layers.psb | root | yes | yes | no | 254.286 | 255 | 255 | — |
| 0layers.psd | root | yes | yes | no | 254.286 | 255 | 255 | — |
| 16bit5x5.psb | root | yes | yes | yes | 0.000 | 0 | 0 | bit-depth:16 |
| 16bit5x5.psd | root | yes | yes | yes | 0.000 | 0 | 0 | bit-depth:16 |
| 1layer.psb | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| 1layer.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| 1layer2.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| 2layer_8ele_tblocks.psd | root | yes | yes | no | 191.250 | 255 | 255 | ag-psd-parser, mask-pixels |
| 2layers.psb | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| 2layers.psd | root | yes | yes | yes | 0.058 | 1 | 1 | — |
| 300dpi.psb | root | yes | yes | yes | 0.000 | 0 | 0 | bit-depth:32 |
| 300dpi.psd | root | yes | yes | yes | 0.000 | 0 | 0 | bit-depth:32 |
| 32bit.psb | root | yes | yes | yes | 0.000 | 0 | 0 | bit-depth:32 |
| 32bit.psd | root | yes | yes | yes | 0.000 | 0 | 0 | bit-depth:32 |
| 32bit5x5.psb | root | yes | yes | yes | 0.000 | 0 | 0 | bit-depth:32 |
| 32bit5x5.psd | root | yes | yes | yes | 0.000 | 0 | 0 | bit-depth:32 |
| adjustment-fillers.psd | root | yes | yes | no | 16.037 | 255 | 255 | mask-pixels, vector-fill:pattern |
| adjustment-mask.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| adjustments/adjustment_backdrop_test.psd | adjustments | yes | yes | yes | 0.921 | 17 | 26 | ag-psd-parser, mask-pixels, mask-pixels, mask-pixels, mask-pixels, mask-pixels |
| adjustments/adjustment_clipping.psd | adjustments | yes | yes | no | 22.142 | 33 | 34 | ag-psd-parser, mask-pixels, mask-pixels, mask-pixels, mask-pixels |
| adjustments/adjustment_nested_composition_1.psd | adjustments | yes | yes | no | 49.697 | 255 | 255 | ag-psd-parser, mask-pixels, mask-pixels, mask-pixels, mask-pixels, mask-pixels, mask-pixels, mask-pixels, mask-pixels, mask-pixels |
| adjustments/adjustment_nested_composition_2.psd | adjustments | yes | yes | yes | 0.242 | 1 | 3 | ag-psd-parser, mask-pixels, mask-pixels |
| adjustments/adjustment_nested_composition_3.psd | adjustments | yes | yes | yes | 0.153 | 1 | 2 | ag-psd-parser, mask-pixels |
| adjustments/adjustment_nested_composition_4.psd | adjustments | yes | yes | yes | 1.483 | 2 | 17 | ag-psd-parser, mask-pixels, mask-default, mask-default, mask-pixels, mask-default, mask-pixels, mask-default, mask-pixels |
| adjustments/adjustment_nested_composition_5.psd | adjustments | yes | yes | yes | 0.108 | 1 | 2 | ag-psd-parser, mask-pixels, mask-default, mask-default, mask-pixels, mask-default, mask-pixels, mask-default, mask-pixels |
| adjustments/brightnesscontrast_cmyk.psd | adjustments | yes | yes | no | 30.046 | 99 | 217 | ag-psd-parser, mask-default, mask-default, mask-default, mask-default |
| adjustments/brightnesscontrast_grayscale.psd | adjustments | yes | yes | no | 30.804 | 117 | 137 | ag-psd-parser, mask-default, mask-default, mask-default, mask-default |
| adjustments/brightnesscontrast_legacy_cmyk.psd | adjustments | yes | yes | yes | 3.960 | 24 | 44 | — |
| adjustments/brightnesscontrast_legacy_grayscale.psd | adjustments | yes | yes | yes | 1.862 | 8 | 12 | — |
| adjustments/brightnesscontrast_legacy_rgb.psd | adjustments | yes | yes | yes | 5.667 | 49 | 53 | — |
| adjustments/brightnesscontrast_rgb.psd | adjustments | yes | yes | no | 29.224 | 149 | 173 | ag-psd-parser, mask-default, mask-default, mask-default, mask-default |
| adjustments/curves_cmyk.psd | adjustments | yes | yes | no | 23.136 | 136 | 252 | ag-psd-parser, mask-pixels, mask-default, mask-default, mask-default, mask-default |
| adjustments/curves_grayscale.psd | adjustments | yes | yes | no | 17.020 | 75 | 81 | ag-psd-parser, mask-default, mask-default, mask-default, mask-default |
| adjustments/curves_rgb.psd | adjustments | yes | yes | yes | 0.122 | 1 | 12 | ag-psd-parser, mask-default, mask-default, mask-default, mask-default |
| adjustments/exposure_grayscale.psd | adjustments | yes | yes | yes | 0.234 | 1 | 7 | ag-psd-parser, mask-default, mask-default, mask-default, mask-default |
| adjustments/exposure_rgb.psd | adjustments | yes | yes | yes | 1.093 | 7 | 21 | ag-psd-parser, mask-default, mask-default, mask-default, mask-default |
| adjustments/huesaturation_colorize_rgb.psd | adjustments | yes | yes | yes | 0.374 | 2 | 4 | ag-psd-parser |
| adjustments/huesaturation_lightness_rgb.psd | adjustments | yes | yes | no | 59.035 | 221 | 249 | ag-psd-parser |
| adjustments/huesaturation_rgb.psd | adjustments | yes | yes | no | 17.546 | 117 | 231 | ag-psd-parser |
| adjustments/huesaturation_saturation_rgb.psd | adjustments | yes | yes | no | 6.400 | 90 | 111 | ag-psd-parser |
| adjustments/invert_cmyk.psd | adjustments | yes | yes | no | 37.293 | 133 | 188 | — |
| adjustments/invert_grayscale.psd | adjustments | yes | yes | no | 10.375 | 43 | 43 | — |
| adjustments/invert_rgb.psd | adjustments | yes | yes | yes | 0.000 | 0 | 0 | — |
| adjustments/levels_cmyk.psd | adjustments | yes | yes | no | 13.904 | 104 | 140 | ag-psd-parser, mask-default, mask-default, mask-default, mask-default |
| adjustments/levels_grayscale.psd | adjustments | yes | yes | no | 20.673 | 73 | 87 | ag-psd-parser, mask-default, mask-default, mask-default, mask-default |
| adjustments/levels_rgb.psd | adjustments | yes | yes | yes | 0.235 | 2 | 6 | ag-psd-parser, mask-default, mask-default, mask-default, mask-default |
| adjustments/posterize_16bits_cmyk.psd | adjustments | yes | yes | no | 14.106 | 237 | 255 | ag-psd-parser, bit-depth:16 |
| adjustments/posterize_16bits_grayscale.psd | adjustments | yes | yes | no | 11.817 | 255 | 255 | ag-psd-parser, bit-depth:16 |
| adjustments/posterize_16bits_rgb.psd | adjustments | yes | yes | yes | 0.060 | 1 | 1 | ag-psd-parser, bit-depth:16 |
| adjustments/posterize_cmyk.psd | adjustments | yes | yes | no | 9.292 | 85 | 146 | ag-psd-parser |
| adjustments/posterize_grayscale.psd | adjustments | yes | yes | no | 11.715 | 128 | 128 | ag-psd-parser |
| adjustments/posterize_rgb.psd | adjustments | yes | yes | yes | 0.819 | 14 | 128 | ag-psd-parser |
| adjustments/threshold_16bits_grayscale.psd | adjustments | yes | yes | no | 19.221 | 255 | 255 | ag-psd-parser, bit-depth:16 |
| adjustments/threshold_16bits_rgb.psd | adjustments | yes | yes | yes | 0.139 | 0 | 255 | ag-psd-parser, bit-depth:16 |
| adjustments/threshold_cmyk.psd | adjustments | yes | yes | no | 26.430 | 255 | 255 | ag-psd-parser |
| adjustments/threshold_grayscale.psd | adjustments | yes | yes | no | 20.062 | 255 | 255 | ag-psd-parser |
| adjustments/threshold_rgb.psd | adjustments | yes | yes | yes | 0.454 | 0 | 255 | ag-psd-parser |
| advanced-blending.psd | root | yes | yes | no | 75.588 | 255 | 255 | artboards, advanced-blending |
| artboard-bgcolor.psd | root | yes | yes | no | 64.513 | 255 | 255 | — |
| artboard.psd | root | yes | yes | no | 67.391 | 255 | 255 | — |
| background-red-opacity-80.psd | root | yes | yes | yes | 0.000 | 0 | 1 | — |
| blend-and-clipping.psd | root | yes | yes | no | 34.123 | 255 | 255 | advanced-blending, advanced-blending, advanced-blending, advanced-blending, advanced-blending, advanced-blending |
| blend-modes/cmyk-blend-modes.psd | blend-modes | yes | yes | no | 188.197 | 255 | 255 | artboards |
| blend-modes/color-burn.psd | blend-modes | yes | yes | yes | 0.129 | 1 | 1 | — |
| blend-modes/color-dodge.psd | blend-modes | yes | yes | yes | 0.089 | 1 | 2 | — |
| blend-modes/color.psd | blend-modes | yes | yes | yes | 0.250 | 2 | 2 | — |
| blend-modes/darken.psd | blend-modes | yes | yes | yes | 0.168 | 1 | 1 | — |
| blend-modes/darker-color.psd | blend-modes | yes | yes | yes | 0.087 | 1 | 1 | — |
| blend-modes/difference.psd | blend-modes | yes | yes | yes | 0.048 | 1 | 2 | — |
| blend-modes/dissolve.psd | blend-modes | yes | yes | no | 56.095 | 255 | 255 | — |
| blend-modes/divide.psd | blend-modes | yes | yes | yes | 0.130 | 1 | 2 | — |
| blend-modes/exclusion.psd | blend-modes | yes | yes | yes | 0.048 | 1 | 2 | — |
| blend-modes/gray-blend-modes.psd | blend-modes | yes | yes | no | 16.733 | 242 | 255 | artboards |
| blend-modes/group-divider-blend-mode.psd | blend-modes | yes | yes | yes | 0.000 | 0 | 0 | — |
| blend-modes/hard-light.psd | blend-modes | yes | yes | yes | 0.131 | 1 | 2 | — |
| blend-modes/hard-mix.psd | blend-modes | yes | yes | yes | 0.129 | 1 | 1 | — |
| blend-modes/hue.psd | blend-modes | yes | yes | yes | 0.166 | 1 | 1 | — |
| blend-modes/lighten.psd | blend-modes | yes | yes | yes | 0.048 | 1 | 2 | — |
| blend-modes/lighter-color.psd | blend-modes | yes | yes | yes | 0.088 | 1 | 2 | — |
| blend-modes/linear-burn.psd | blend-modes | yes | yes | yes | 0.168 | 1 | 1 | — |
| blend-modes/linear-dodge.psd | blend-modes | yes | yes | yes | 0.048 | 1 | 2 | — |
| blend-modes/linear-light.psd | blend-modes | yes | yes | yes | 0.217 | 1 | 2 | — |
| blend-modes/luminosity.psd | blend-modes | yes | yes | yes | 0.119 | 1 | 2 | — |
| blend-modes/multiply.psd | blend-modes | yes | yes | yes | 0.168 | 1 | 1 | — |
| blend-modes/normal.psd | blend-modes | yes | yes | yes | 0.088 | 1 | 1 | — |
| blend-modes/overlay.psd | blend-modes | yes | yes | yes | 0.128 | 1 | 1 | — |
| blend-modes/pass-through.psd | blend-modes | yes | yes | yes | 0.088 | 1 | 1 | — |
| blend-modes/pin-light.psd | blend-modes | yes | yes | yes | 0.088 | 1 | 2 | — |
| blend-modes/rgb-blend-modes.psd | blend-modes | yes | yes | no | 1.297 | 27 | 255 | artboards |
| blend-modes/saturation.psd | blend-modes | yes | yes | yes | 0.173 | 2 | 2 | — |
| blend-modes/screen.psd | blend-modes | yes | yes | yes | 0.048 | 1 | 2 | — |
| blend-modes/soft-light.psd | blend-modes | yes | yes | yes | 0.129 | 1 | 1 | — |
| blend-modes/subtract.psd | blend-modes | yes | yes | yes | 0.087 | 1 | 1 | — |
| blend-modes/vivid-light.psd | blend-modes | yes | yes | yes | 0.088 | 1 | 1 | — |
| broken-groups.psb | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| broken-groups.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| clip-adjustment.psd | root | yes | yes | yes | 0.000 | 0 | 0 | mask-pixels |
| clipping-mask.psb | root | yes | yes | yes | 0.110 | 0 | 60 | — |
| clipping-mask.psd | root | yes | yes | yes | 0.000 | 0 | 1 | — |
| clipping-mask2.psd | root | yes | yes | no | 18.300 | 80 | 86 | advanced-blending, mask-pixels, real-mask, mask-feather, mask-pixels, mask-pixels |
| clipping-mask3.psd | root | yes | yes | no | 39.221 | 255 | 255 | orphan-clipping |
| clipping-mask4.psd | root | yes | yes | no | 6.848 | 255 | 255 | ag-psd-parser, orphan-clipping |
| clipping-mask5.psd | root | yes | yes | no | 24.148 | 255 | 255 | ag-psd-parser, mask-default, orphan-clipping |
| cmyk-alpha-spot.psd | root | yes | yes | no | 0.000 | 0 | 0 | embedded-icc |
| cmyk-gray-ramp.psd | root | yes | yes | no | 0.000 | 0 | 0 | embedded-icc |
| cmyk-spot.psd | root | yes | yes | no | 0.000 | 0 | 0 | — |
| colormodes/100x20_1bit_bitmap_rle.psd | colormodes | yes | yes | no | 176.970 | 255 | 255 | ag-psd-parser, bit-depth:1, color-mode:0 |
| colormodes/20x5_1bit_bitmap.psd | colormodes | yes | yes | no | 182.325 | 255 | 255 | ag-psd-parser, bit-depth:1, color-mode:0 |
| colormodes/4x4_16bit_cmyk.psd | colormodes | yes | yes | no | 26.750 | 123 | 123 | bit-depth:16 |
| colormodes/4x4_16bit_grayscale.psd | colormodes | yes | yes | no | 16.406 | 48 | 48 | bit-depth:16 |
| colormodes/4x4_16bit_lab.psd | colormodes | yes | yes | no | 66.281 | 255 | 255 | bit-depth:16, color-mode:9 |
| colormodes/4x4_16bit_multichannel.psd | colormodes | yes | yes | no | 0.000 | 0 | 0 | bit-depth:16 |
| colormodes/4x4_16bit_rgb.psd | colormodes | yes | yes | no | 18.000 | 86 | 86 | bit-depth:16 |
| colormodes/4x4_1bit_bitmap.psd | colormodes | yes | yes | no | 123.516 | 255 | 255 | bit-depth:1, color-mode:0 |
| colormodes/4x4_32bit_grayscale.psd | colormodes | yes | yes | no | 9.844 | 30 | 30 | bit-depth:32, mask-pixels |
| colormodes/4x4_32bit_rgb.psd | colormodes | yes | yes | no | 15.813 | 89 | 89 | bit-depth:32, mask-pixels |
| colormodes/4x4_8bit_cmyk.psd | colormodes | yes | yes | yes | 0.094 | 1 | 1 | mask-pixels |
| colormodes/4x4_8bit_duotone.psd | colormodes | yes | yes | yes | 0.234 | 1 | 1 | color-mode:8, mask-pixels |
| colormodes/4x4_8bit_grayscale.psd | colormodes | yes | yes | yes | 0.422 | 2 | 2 | mask-pixels |
| colormodes/4x4_8bit_index_color.psd | colormodes | yes | yes | no | 0.000 | 0 | 0 | embedded-icc |
| colormodes/4x4_8bit_lab.psd | colormodes | yes | yes | yes | 0.000 | 0 | 0 | color-mode:9, mask-pixels |
| colormodes/4x4_8bit_rgb.psd | colormodes | yes | yes | yes | 0.000 | 0 | 0 | mask-pixels |
| colormodes/4x4_8bit_rgba.psd | colormodes | yes | yes | no | 124.063 | 255 | 255 | mask-pixels |
| colorprofiles/north_america_newspaper.psd | colorprofiles | yes | yes | yes | 0.141 | 1 | 1 | mask-pixels |
| descriptors/hsb-color-swatches.psd | descriptors | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser |
| descriptors/lab-color-swatches.psd | descriptors | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, color-mode:9 |
| descriptors/stroke-color-descriptors-gray.psd | descriptors | yes | yes | no | 0.516 | 20 | 21 | — |
| descriptors/stroke-color-descriptors-hsb-with-rgb-mode.psd | descriptors | yes | yes | yes | 0.127 | 0 | 88 | — |
| descriptors/stroke-color-descriptors-lab.psd | descriptors | yes | yes | yes | 0.180 | 5 | 14 | color-mode:9 |
| descriptors/stroke-color-descriptors-rgb.psd | descriptors | yes | yes | yes | 0.001 | 0 | 1 | — |
| effect-stroke-gradient.psd | root | yes | yes | no | 11.836 | 187 | 255 | advanced-blending, advanced-blending |
| effects/antialiased-stroke-edge.psd | effects | yes | yes | yes | 0.663 | 31 | 104 | ag-psd-parser, advanced-blending, advanced-blending, advanced-blending, advanced-blending, advanced-blending, advanced-blending |
| effects/center-stroke-sizes.psd | effects | yes | yes | yes | 0.026 | 0 | 28 | ag-psd-parser, advanced-blending, advanced-blending, advanced-blending, advanced-blending, advanced-blending |
| effects/double-stroke-effects.psd | effects | yes | yes | yes | 0.002 | 0 | 1 | advanced-blending |
| effects/effects-enabled.psd | effects | yes | yes | no | 14.500 | 49 | 49 | advanced-blending, advanced-blending, advanced-blending |
| effects/feathered-stroke.psd | effects | yes | yes | yes | 1.980 | 48 | 89 | ag-psd-parser, advanced-blending, advanced-blending, advanced-blending, advanced-blending, advanced-blending, advanced-blending |
| effects/group-clips-child-stroke.psd | effects | yes | yes | yes | 0.079 | 0 | 19 | ag-psd-parser, advanced-blending, advanced-blending, advanced-blending |
| effects/group-stroke-off-canvas.psd | effects | yes | yes | no | 18.616 | 255 | 255 | ag-psd-parser, advanced-blending, advanced-blending |
| effects/inset-stroke-sizes.psd | effects | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, advanced-blending, advanced-blending, advanced-blending, advanced-blending, advanced-blending |
| effects/outside-stroke.psd | effects | yes | yes | yes | 0.117 | 0 | 19 | ag-psd-parser, advanced-blending |
| effects/shape-fx.psd | effects | yes | yes | yes | 0.000 | 0 | 0 | — |
| effects/shape-fx2.psd | effects | yes | yes | yes | 2.141 | 28 | 38 | advanced-blending, advanced-blending |
| effects/stroke-composite.psd | effects | yes | yes | no | 15.394 | 255 | 255 | advanced-blending, advanced-blending, advanced-blending, advanced-blending |
| effects/stroke-effect-transparent-shape.psd | effects | yes | yes | yes | 0.000 | 0 | 0 | advanced-blending |
| effects/stroke-effects.psd | effects | yes | yes | no | 20.142 | 255 | 255 | advanced-blending, advanced-blending, advanced-blending, advanced-blending, advanced-blending, advanced-blending, advanced-blending, advanced-blending, advanced-blending, advanced-blending, advanced-blending, advanced-blending, advanced-blending, advanced-blending, advanced-blending, stroke-pattern |
| effects/stroke-without-vector-mask.psd | effects | yes | yes | yes | 0.000 | 0 | 0 | — |
| empty-group.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| empty-layer.psb | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| empty-layer.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| fill_adjustments.psd | root | yes | yes | no | 25.827 | 200 | 206 | advanced-blending, advanced-blending, pattern-overlay, advanced-blending, mask-pixels, mask-pixels, mask-pixels, mask-pixels, mask-pixels, mask-pixels, mask-pixels, mask-pixels, mask-pixels, mask-pixels, adjustment:color lookup, mask-pixels, mask-pixels, mask-pixels, mask-pixels, mask-pixels, mask-pixels |
| gradient-fill.psb | root | yes | yes | yes | 0.047 | 1 | 2 | bit-depth:32 |
| gradient-fill.psd | root | yes | yes | yes | 0.047 | 1 | 2 | bit-depth:32 |
| gradient-sizes.psd | root | yes | yes | yes | 0.183 | 1 | 1 | artboards |
| gradient-styles.psd | root | yes | yes | yes | 0.087 | 1 | 2 | artboards |
| gradients/noise-gradient-cmyk.psd | gradients | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser |
| gradients/noise-gradient-grayscale.psd | gradients | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser |
| gradients/noise-gradient-lab.psd | gradients | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, color-mode:9 |
| gradients/noise-gradient-rgb.psd | gradients | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser |
| gray0.psb | root | yes | yes | no | 1.711 | 46 | 49 | — |
| gray0.psd | root | yes | yes | no | 1.711 | 46 | 49 | — |
| gray1.psb | root | yes | yes | yes | 0.038 | 0 | 63 | — |
| gray1.psd | root | yes | yes | yes | 0.003 | 0 | 8 | — |
| group-clipping/group-clipping.psd | group-clipping | yes | yes | yes | 0.000 | 0 | 0 | — |
| group.psb | root | yes | yes | yes | 0.265 | 0 | 64 | — |
| group.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| hidden-groups.psb | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| hidden-groups.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| hidden-layer.psb | root | yes | yes | yes | 0.302 | 0 | 64 | — |
| hidden-layer.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| history.psb | root | yes | yes | no | 81.134 | 255 | 255 | — |
| history.psd | root | yes | yes | no | 81.134 | 255 | 255 | — |
| layer_comps.psb | root | yes | yes | no | 10.925 | 66 | 146 | advanced-blending, bevel, advanced-blending, bevel, advanced-blending, advanced-blending, advanced-blending, advanced-blending, advanced-blending, advanced-blending, advanced-blending |
| layer_comps.psd | root | yes | yes | no | 10.856 | 67 | 184 | advanced-blending, bevel, advanced-blending, bevel, advanced-blending, advanced-blending, advanced-blending, advanced-blending, advanced-blending, advanced-blending, advanced-blending |
| layer_effects.psd | root | yes | yes | no | 6.790 | 103 | 133 | ag-psd-parser, advanced-blending, advanced-blending, bevel, advanced-blending, bevel, advanced-blending, advanced-blending, inner-glow, advanced-blending, inner-shadow, advanced-blending, advanced-blending, advanced-blending, advanced-blending, pattern-overlay, advanced-blending, advanced-blending, satin |
| layer_mask_data.psb | root | yes | yes | no | 20.857 | 95 | 147 | real-mask, mask-density, mask-feather, real-mask, real-mask, mask-density, mask-feather |
| layer_mask_data.psd | root | yes | yes | no | 20.661 | 94 | 147 | mask-density, mask-feather, real-mask, mask-density, mask-feather |
| layer_params.psb | root | yes | yes | no | 7.209 | 137 | 240 | advanced-blending, bevel, advanced-blending |
| layer_params.psd | root | yes | yes | no | 7.209 | 137 | 240 | advanced-blending, bevel, advanced-blending |
| layer-name-emoji.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| layers/black-and-white.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | mask-pixels |
| layers/brightness-contrast.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | mask-pixels |
| layers/channel-mixer.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | mask-pixels |
| layers/color-balance.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | mask-pixels |
| layers/color-lookup.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | adjustment:color lookup, mask-pixels |
| layers/curves-with-vectormask.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | — |
| layers/curves.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | mask-pixels |
| layers/exposure.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | mask-pixels |
| layers/gradient-fill.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | mask-pixels |
| layers/gradient-map-v3-classic.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | mask-pixels |
| layers/gradient-map-v3-linear.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | mask-pixels |
| layers/gradient-map-v3-perceptual.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | mask-pixels |
| layers/gradient-map.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | mask-pixels |
| layers/group.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | — |
| layers/hue-saturation.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | mask-pixels |
| layers/invert.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | mask-pixels |
| layers/levels.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | mask-pixels |
| layers/pattern-fill.psb | layers | yes | yes | yes | 0.000 | 0 | 0 | mask-pixels |
| layers/pattern-fill.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | mask-pixels |
| layers/photo-filter.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | mask-pixels |
| layers/pixel-layer.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | — |
| layers/posterize.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | mask-pixels |
| layers/selective-color.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | mask-pixels |
| layers/shape-layer.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | — |
| layers/smartobject-layer.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | — |
| layers/solid-color-fill.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | mask-pixels |
| layers/threshold.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | mask-pixels |
| layers/type-layer.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | — |
| layers/vibrance.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | mask-pixels |
| layers-minimal/gradient-fill.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | mask-pixels |
| layers-minimal/pattern-fill.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | mask-pixels |
| layers-minimal/pixel-layer.psd | layers | yes | yes | no | 35.266 | 255 | 255 | — |
| layers-minimal/shape-layer.psd | layers | yes | yes | no | 34.268 | 255 | 255 | — |
| layers-minimal/smartobject-layer.psd | layers | yes | yes | no | 19.549 | 255 | 255 | — |
| layers-minimal/solid-color-fill.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | mask-pixels |
| layers-minimal/type-layer.psd | layers | yes | yes | no | 19.549 | 255 | 255 | — |
| mask_parameters.psd | root | yes | yes | no | 82.011 | 255 | 255 | real-mask, mask-density, mask-feather |
| mask-density-layermask.psd | root | yes | yes | no | 16.537 | 191 | 223 | ag-psd-parser, mask-density, mask-default, mask-density, mask-default, mask-density, mask-default |
| mask-density-layervectormask.psd | root | yes | yes | no | 20.030 | 190 | 191 | ag-psd-parser, real-mask, mask-density, mask-default, real-mask, mask-density, real-mask, mask-density, real-mask |
| mask-density-vectormask.psd | root | yes | yes | no | 23.852 | 191 | 191 | ag-psd-parser |
| mask-disabled.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| mask-index.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| mask-vector-density.psd | root | yes | yes | no | 23.852 | 191 | 191 | ag-psd-parser, real-mask |
| mask.psb | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| mask.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| masks/2.psd | masks | yes | yes | no | 48.892 | 192 | 192 | — |
| masks.psb | root | yes | yes | no | 1.635 | 22 | 59 | mask-pixels, mask-pixels, advanced-blending, gradient-overlay, advanced-blending, advanced-blending, real-mask, advanced-blending |
| masks.psd | root | yes | yes | no | 1.673 | 22 | 65 | mask-pixels, mask-pixels, advanced-blending, gradient-overlay, advanced-blending, advanced-blending, real-mask, advanced-blending |
| masks2.psb | root | yes | yes | yes | 0.108 | 0 | 40 | real-mask |
| masks2.psd | root | yes | yes | yes | 0.108 | 0 | 40 | real-mask |
| masks3.psd | root | yes | yes | no | 14.509 | 142 | 174 | — |
| metadata.psb | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| metadata.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| multichannel-pattern-fill.psd | root | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, mask-pixels |
| note.psb | root | yes | yes | yes | 0.254 | 0 | 64 | — |
| note.psd | root | yes | yes | no | 90.744 | 255 | 255 | — |
| opacity-fill.psd | root | yes | yes | yes | 0.000 | 0 | 0 | mask-pixels |
| passthrough_blendmodes1.psd | root | yes | yes | yes | 0.033 | 1 | 1 | ag-psd-parser, mask-pixels, mask-default, mask-default, mask-default, mask-default |
| passthrough_blendmodes2.psd | root | yes | yes | yes | 0.061 | 1 | 2 | ag-psd-parser, mask-pixels, mask-default, mask-default, mask-default, mask-default |
| passthrough_blendmodes3.psd | root | yes | yes | yes | 0.156 | 1 | 2 | ag-psd-parser, mask-default, mask-default, mask-default, mask-default |
| passthrough_clipping_mask_adjustment.psd | root | yes | yes | no | 54.709 | 198 | 233 | ag-psd-parser, mask-pixels, mask-default, mask-pixels, mask-default, mask-pixels, orphan-clipping |
| passthrough_clipping_mask_blendmode.psd | root | yes | yes | no | 3.004 | 32 | 33 | ag-psd-parser, mask-pixels, mask-default, mask-default, orphan-clipping |
| passthrough_fill_adjustment.psd | root | yes | yes | yes | 0.021 | 1 | 1 | ag-psd-parser, mask-default, mask-default, mask-pixels |
| passthrough_fill_blendmode.psd | root | yes | yes | no | 1.974 | 26 | 33 | ag-psd-parser |
| passthrough_opacity.psd | root | yes | yes | no | 54.199 | 86 | 86 | ag-psd-parser, mask-default, mask-default, mask-pixels |
| passthrough_vector_mask.psd | root | yes | yes | no | 13.413 | 77 | 127 | ag-psd-parser, mask-pixels, mask-pixels |
| path-operations/combine-group.psd | path-operations | yes | yes | yes | 0.000 | 0 | 0 | — |
| path-operations/combine.psd | path-operations | yes | yes | yes | 0.000 | 0 | 0 | — |
| path-operations/exclude-first.psd | path-operations | yes | yes | yes | 0.000 | 0 | 0 | — |
| path-operations/exclude-group.psd | path-operations | yes | yes | yes | 0.000 | 0 | 0 | — |
| path-operations/exclude.psd | path-operations | yes | yes | yes | 0.000 | 0 | 0 | — |
| path-operations/intersect-all.psd | path-operations | yes | yes | yes | 0.000 | 0 | 0 | — |
| path-operations/intersect-first.psd | path-operations | yes | yes | yes | 0.000 | 0 | 0 | — |
| path-operations/intersect-group.psd | path-operations | yes | yes | yes | 0.000 | 0 | 0 | — |
| path-operations/subtract-all.psd | path-operations | yes | yes | yes | 0.000 | 0 | 0 | — |
| path-operations/subtract-first.psd | path-operations | yes | yes | yes | 0.000 | 0 | 0 | — |
| path-operations/subtract-group.psd | path-operations | yes | yes | yes | 0.000 | 0 | 0 | — |
| path-operations/subtract-second.psd | path-operations | yes | yes | yes | 0.000 | 0 | 0 | — |
| patterns.psd | root | yes | yes | no | 9.964 | 105 | 105 | vector-fill:pattern, vector-fill:pattern, vector-fill:pattern, vector-fill:pattern, vector-fill:pattern, vector-fill:pattern, advanced-blending, pattern-overlay, advanced-blending, pattern-overlay, advanced-blending, pattern-overlay, advanced-blending, pattern-overlay, advanced-blending, pattern-overlay, advanced-blending, pattern-overlay |
| pen-text.psb | root | yes | yes | yes | 0.426 | 2 | 252 | bit-depth:32 |
| pen-text.psd | root | yes | yes | yes | 0.408 | 1 | 249 | bit-depth:32 |
| placedLayer.psb | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| placedLayer.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| semi-transparent-layers.psb | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| semi-transparent-layers.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| slices.psb | root | yes | yes | no | 255.000 | 255 | 255 | — |
| slices.psd | root | yes | yes | no | 255.000 | 255 | 255 | — |
| smart-object-slice.psb | root | yes | yes | yes | 0.228 | 0 | 56 | — |
| smart-object-slice.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| stroke.psd | root | yes | yes | yes | 0.001 | 0 | 1 | vector-fill:pattern, vector-fill:pattern, vector-fill:pattern |
| text.psb | root | yes | yes | yes | 0.069 | 0 | 40 | — |
| text.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| transparency/clip-opacity.psd | transparency | yes | yes | yes | 0.085 | 1 | 1 | — |
| transparency/fill-opacity.psd | transparency | yes | yes | no | 9.542 | 204 | 204 | advanced-blending, mask-default, pattern-overlay |
| transparency/knockout-deep-cyanbg.psd | transparency | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, knockout, advanced-blending |
| transparency/knockout-deep-nested-pt.psd | transparency | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, knockout, advanced-blending |
| transparency/knockout-deep-nested.psd | transparency | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, knockout, advanced-blending |
| transparency/knockout-deep-nobg.psd | transparency | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, knockout, advanced-blending |
| transparency/knockout-deep-normal.psd | transparency | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, knockout, advanced-blending |
| transparency/knockout-deep-passthrough.psd | transparency | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, knockout, advanced-blending |
| transparency/knockout-isolated-groups.psd | transparency | yes | yes | no | 3.162 | 73 | 100 | knockout, advanced-blending, knockout, advanced-blending, knockout, advanced-blending, knockout, advanced-blending, knockout, advanced-blending, knockout, advanced-blending, knockout, advanced-blending, knockout, advanced-blending |
| transparency/knockout-none-cyanbg.psd | transparency | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, advanced-blending |
| transparency/knockout-none-nested.psd | transparency | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, advanced-blending |
| transparency/knockout-none-normal.psd | transparency | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, advanced-blending |
| transparency/knockout-none-passthrough.psd | transparency | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, advanced-blending |
| transparency/knockout-shallow-nested-pt.psd | transparency | yes | yes | no | 63.500 | 127 | 127 | ag-psd-parser, knockout, advanced-blending |
| transparency/knockout-shallow-nested.psd | transparency | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, knockout, advanced-blending |
| transparency/transparency-group.psd | transparency | yes | yes | yes | 0.011 | 1 | 2 | — |
| transparentbg-gimp.psb | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| transparentbg-gimp.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| transparentbg.psb | root | yes | yes | no | 211.124 | 255 | 255 | ag-psd-parser, bit-depth:32 |
| transparentbg.psd | root | yes | yes | no | 211.143 | 255 | 255 | ag-psd-parser, bit-depth:32 |
| unicode_pathname.psb | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| unicode_pathname.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| vector-mask-disabled.psd | root | yes | yes | yes | 0.000 | 0 | 0 | bit-depth:32 |
| vector-mask.psb | root | yes | yes | yes | 0.000 | 0 | 0 | bit-depth:32 |
| vector-mask.psd | root | yes | yes | no | 31.796 | 218 | 218 | bit-depth:32 |
| vector-mask2.psd | root | yes | yes | no | 0.000 | 0 | 0 | embedded-icc |
| vector-mask3.psd | root | yes | yes | no | 56.063 | 184 | 184 | real-mask, mask-default, mask-pixels |

## Known deviations and next work

- CMYK and grayscale layer channels use Little CMS with an embedded profile when present and deterministic default profiles
  otherwise. Lab uses a D50 Lab-to-sRGB conversion; duotone/multichannel use their available channel values because the
  proprietary Photoshop ink curves are not present in the parsed data.
- RGBA16 layer data is retained through Little CMS's 16-bit transform rather than round-tripping through RGBA8. The 32-bit
  path now reconstructs cache-less solid/gradient vector fills from their editable layer descriptors, but still clamps other
  floating samples instead of reproducing Photoshop's document-specific HDR preview/tone-mapping transform.
- Isolated groups, group opacity/fill, nested group order, and the corpus knockout cases are composited natively on CPU and GPU.
  ag-psd exposes knockout as a boolean but not the shallow/deep selector; the pass-through shallow nested case remains ambiguous.
- Threshold uses Photoshop's Rec.601 decision luminance, Posterize uses Photoshop bin boundaries, and Curves uses a natural
  cubic spline; their RGB corpus fixtures now pass. Remaining adjustment mismatches are listed per file above: modern
  Brightness/Contrast, non-colorize Hue/Saturation ranges, and non-RGB adjustment/CMS ordering still differ.
- Vector/group masks without pixel channels, smart filters, blend-if, and pattern/bevel effects remain unsupported. A clipped
  isolated group is now composited against its preceding sibling's live alpha on both CPU and GPU.
  Text, vector, and smart-object layers use their layer-owned saved pixel caches; never the document merged composite.
- Generated fills without a pixel cache are rasterized from the editable path and fill descriptor. Photoshop's classic gradient
  interpolation is approximated by the response measured from the corpus because its proprietary interpolation kernel is absent.
- Bounded raster masks retain the PSD outside-mask default. Density is baked into mask samples; feather is still unsupported.
- Dissolve uses a deterministic local dither because the PSD layer data contains neither Photoshop’s process-local random
  table nor a seed. Its probability/opaque-pixel semantics match, but individual saved-composite dots do not.

Run `npm run psd:fidelity` after `scripts/fetch-psd-corpus.sh` to regenerate this report.
