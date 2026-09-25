# PSD native-fidelity report — eighth round

Corpus: psd-tools commit `30bf79c2a88e0fc63104ee85713e23b04362153d`; 300 PSD/PSB files. ag-psd 31.0.2 plus native non-RGB layer-channel decoding.

The oracle is each PSD’s embedded Photoshop composite. Metrics are absolute byte deltas over premultiplied RGB plus
alpha (so undefined straight RGB below transparency is ignored): mean over all channels and the nearest-rank 99th
percentile. A file passes only when both limits for its primary feature folder pass.
The runner is a measurement baseline: fidelity failures are reported but do not make the command itself fail.

Overall: 300/300 parsed, 300/300 rendered, 239/300 passed (79.7%).
The Product Plan A7 acceptance target of at least 90% is **not met** by this baseline.

Eighth-round input: 235/300 (78.3%). Current native result: 239/300 (79.7%), a net gain of 4 files.
Primary-folder changes are: blend modes 28→28, adjustments 36→36, layers 32→32, effects 11→12,
path operations 12→12, masks 0→0, group clipping 1→1, transparency 16→16, colour modes 10→10, colour profiles
1→1, gradients 4→4, descriptors 5→5, and root 79→82. The overlapping 16/32-bit and PSB tags changed
26→26 and 30→30 respectively. No primary-folder pass count regressed.

| Newly passing file | Before mean / p99 | After mean / p99 | Native change |
|---|---:|---:|---|
| effects/stroke-composite.psd | 12.004 / 255 | 1.791 / 43 | PSD Blend Clipped Layers as Group effect clipping |
| mask-density-layermask.psd | 16.537 / 191 | 0.000 / 0 | density-adjusted outside-mask coverage |
| mask-density-vectormask.psd | 22.361 / 191 | 0.000 / 0 | density-adjusted outside-mask coverage |
| mask-vector-density.psd | 22.361 / 191 | 0.000 / 0 | density-adjusted outside-mask coverage |

## Thresholds and feature summary

| Feature | Limits (mean / p99) | Files | Parsed | Rendered | Passed | Pass rate | Top failure causes |
|---|---:|---:|---:|---:|---:|---:|---|
| blend-modes | ≤ 2 / ≤ 8 | 32 | 32 | 32 | 28 | 87.5% | wrong math/order/colour conversion (4) |
| adjustments | ≤ 8 / ≤ 64 | 39 | 39 | 39 | 36 | 92.3% | wrong math/order/colour conversion (3) |
| layers | ≤ 2 / ≤ 16 | 36 | 36 | 36 | 32 | 88.9% | wrong math/order/colour conversion (3); unsupported: text-path (1) |
| effects | ≤ 8 / ≤ 64 | 15 | 15 | 15 | 12 | 80.0% | wrong math/order/colour conversion (3) |
| path-operations | ≤ 4 / ≤ 32 | 12 | 12 | 12 | 12 | 100.0% | — |
| masks | ≤ 3 / ≤ 24 | 1 | 1 | 1 | 0 | 0.0% | wrong math/order/colour conversion (1) |
| group-clipping | ≤ 3 / ≤ 24 | 1 | 1 | 1 | 1 | 100.0% | — |
| transparency | ≤ 4 / ≤ 32 | 16 | 16 | 16 | 16 | 100.0% | — |
| colormodes | ≤ 3 / ≤ 24 | 17 | 17 | 17 | 10 | 58.8% | unsupported: bit-depth:1 (3); opened flattened (layers not decoded) (2); unsupported: bit-depth:16 (1) |
| colorprofiles | ≤ 3 / ≤ 24 | 1 | 1 | 1 | 1 | 100.0% | — |
| gradients | ≤ 4 / ≤ 32 | 4 | 4 | 4 | 4 | 100.0% | — |
| descriptors | ≤ 2 / ≤ 16 | 6 | 6 | 6 | 5 | 83.3% | wrong math/order/colour conversion (1) |
| 16/32-bit | ≤ 3 / ≤ 24 | 29 | 29 | 29 | 26 | 89.7% | opened flattened (layers not decoded) (1); unsupported: bit-depth:16 (1); unsupported: bit-depth:32 (1) |
| PSB | ≤ 2 / ≤ 16 | 37 | 37 | 37 | 30 | 81.1% | wrong math/order/colour conversion (5); unsupported: mask-default (1); unsupported: text-path (1) |
| root | ≤ 2 / ≤ 16 | 120 | 120 | 120 | 82 | 68.3% | wrong math/order/colour conversion (13); unsupported: mask-default (9); opened flattened (layers not decoded) (4) |

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
| editability-only: ag-psd-parser | 247 |
| approximated: mask-default | 96 |
| editability-only: lock-artboards | 72 |
| editability-only: generated-fill-cache | 43 |
| approximated: text-path | 40 |
| editability-only: mask-density | 23 |
| editability-only: color-mode:1 | 20 |
| approximated: bit-depth:32 | 17 |
| approximated: knockout | 16 |
| editability-only: color-mode:4 | 15 |
| approximated: bit-depth:16 | 12 |
| approximated: vector-fill:pattern | 10 |
| editability-only: compatibility-preview | 10 |
| editability-only: mask-feather | 7 |
| editability-only: artboards | 6 |
| editability-only: flattened-composite | 6 |
| approximated: color-mode:9 | 5 |
| not-rendered: orphan-clipping | 5 |
| approximated: embedded-icc | 4 |
| approximated: bit-depth:1 | 3 |
| approximated: color-mode:0 | 3 |
| not-rendered: ag-psd-parser | 3 |
| approximated: gradient-overlay | 2 |
| not-rendered: adjustment:color lookup | 2 |
| approximated: color-mode:8 | 1 |
| editability-only: color-mode:2 | 1 |
| editability-only: color-mode:3 | 1 |
| editability-only: color-mode:7 | 1 |

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

| File | Primary feature | Parsed | Rendered | Pass | Mean | p99 | Max | Unsupported (non-editability) / error |
|---|---|---:|---:|---:|---:|---:|---:|---|
| 0layers_tblocks.psb | root | yes | yes | no | 4.834 | 255 | 255 | — |
| 0layers_tblocks.psd | root | yes | yes | no | 4.834 | 255 | 255 | — |
| 0layers.psb | root | yes | yes | yes | 0.714 | 0 | 255 | — |
| 0layers.psd | root | yes | yes | yes | 0.714 | 0 | 255 | — |
| 16bit5x5.psb | root | yes | yes | yes | 0.000 | 0 | 0 | bit-depth:16 |
| 16bit5x5.psd | root | yes | yes | yes | 0.000 | 0 | 0 | bit-depth:16 |
| 1layer.psb | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| 1layer.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| 1layer2.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| 2layer_8ele_tblocks.psd | root | yes | yes | no | 191.250 | 255 | 255 | ag-psd-parser |
| 2layers.psb | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| 2layers.psd | root | yes | yes | yes | 0.058 | 1 | 1 | — |
| 300dpi.psb | root | yes | yes | yes | 0.000 | 0 | 0 | bit-depth:32 |
| 300dpi.psd | root | yes | yes | yes | 0.000 | 0 | 0 | bit-depth:32 |
| 32bit.psb | root | yes | yes | yes | 0.000 | 0 | 0 | bit-depth:32 |
| 32bit.psd | root | yes | yes | yes | 0.000 | 0 | 0 | bit-depth:32 |
| 32bit5x5.psb | root | yes | yes | yes | 0.000 | 0 | 0 | bit-depth:32 |
| 32bit5x5.psd | root | yes | yes | yes | 0.000 | 0 | 0 | bit-depth:32 |
| adjustment-fillers.psd | root | yes | yes | no | 16.930 | 255 | 255 | vector-fill:pattern, text-path |
| adjustment-mask.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| adjustments/adjustment_backdrop_test.psd | adjustments | yes | yes | yes | 0.921 | 17 | 26 | — |
| adjustments/adjustment_clipping.psd | adjustments | yes | yes | no | 22.142 | 33 | 34 | — |
| adjustments/adjustment_nested_composition_1.psd | adjustments | yes | yes | no | 50.727 | 255 | 255 | — |
| adjustments/adjustment_nested_composition_2.psd | adjustments | yes | yes | yes | 0.242 | 1 | 3 | — |
| adjustments/adjustment_nested_composition_3.psd | adjustments | yes | yes | yes | 0.153 | 1 | 2 | — |
| adjustments/adjustment_nested_composition_4.psd | adjustments | yes | yes | yes | 1.483 | 2 | 17 | mask-default, mask-default, mask-default, mask-default |
| adjustments/adjustment_nested_composition_5.psd | adjustments | yes | yes | yes | 0.108 | 1 | 2 | mask-default, mask-default, mask-default, mask-default |
| adjustments/brightnesscontrast_cmyk.psd | adjustments | yes | yes | yes | 2.911 | 21 | 69 | mask-default, mask-default, mask-default, mask-default |
| adjustments/brightnesscontrast_grayscale.psd | adjustments | yes | yes | yes | 5.220 | 26 | 31 | mask-default, mask-default, mask-default, mask-default |
| adjustments/brightnesscontrast_legacy_cmyk.psd | adjustments | yes | yes | yes | 3.278 | 17 | 28 | — |
| adjustments/brightnesscontrast_legacy_grayscale.psd | adjustments | yes | yes | yes | 1.862 | 8 | 12 | — |
| adjustments/brightnesscontrast_legacy_rgb.psd | adjustments | yes | yes | yes | 5.667 | 49 | 53 | — |
| adjustments/brightnesscontrast_rgb.psd | adjustments | yes | yes | yes | 2.279 | 11 | 13 | mask-default, mask-default, mask-default, mask-default |
| adjustments/curves_cmyk.psd | adjustments | yes | yes | yes | 2.195 | 24 | 190 | mask-default, mask-default, mask-default, mask-default |
| adjustments/curves_grayscale.psd | adjustments | yes | yes | yes | 0.097 | 1 | 13 | mask-default, mask-default, mask-default, mask-default |
| adjustments/curves_rgb.psd | adjustments | yes | yes | yes | 0.122 | 1 | 12 | mask-default, mask-default, mask-default, mask-default |
| adjustments/exposure_grayscale.psd | adjustments | yes | yes | yes | 0.234 | 1 | 7 | mask-default, mask-default, mask-default, mask-default |
| adjustments/exposure_rgb.psd | adjustments | yes | yes | yes | 1.093 | 7 | 21 | mask-default, mask-default, mask-default, mask-default |
| adjustments/huesaturation_colorize_rgb.psd | adjustments | yes | yes | yes | 0.374 | 2 | 4 | — |
| adjustments/huesaturation_lightness_rgb.psd | adjustments | yes | yes | yes | 0.264 | 2 | 6 | — |
| adjustments/huesaturation_rgb.psd | adjustments | yes | yes | yes | 2.354 | 34 | 121 | — |
| adjustments/huesaturation_saturation_rgb.psd | adjustments | yes | yes | no | 5.786 | 90 | 111 | — |
| adjustments/invert_cmyk.psd | adjustments | yes | yes | yes | 0.350 | 3 | 26 | — |
| adjustments/invert_grayscale.psd | adjustments | yes | yes | yes | 0.030 | 1 | 9 | — |
| adjustments/invert_rgb.psd | adjustments | yes | yes | yes | 0.000 | 0 | 0 | — |
| adjustments/levels_cmyk.psd | adjustments | yes | yes | yes | 1.191 | 9 | 73 | mask-default, mask-default, mask-default, mask-default |
| adjustments/levels_grayscale.psd | adjustments | yes | yes | yes | 0.379 | 7 | 18 | mask-default, mask-default, mask-default, mask-default |
| adjustments/levels_rgb.psd | adjustments | yes | yes | yes | 0.235 | 2 | 6 | mask-default, mask-default, mask-default, mask-default |
| adjustments/posterize_16bits_cmyk.psd | adjustments | yes | yes | yes | 1.612 | 28 | 255 | bit-depth:16 |
| adjustments/posterize_16bits_grayscale.psd | adjustments | yes | yes | yes | 0.065 | 1 | 255 | bit-depth:16 |
| adjustments/posterize_16bits_rgb.psd | adjustments | yes | yes | yes | 0.060 | 1 | 1 | bit-depth:16 |
| adjustments/posterize_cmyk.psd | adjustments | yes | yes | yes | 1.438 | 21 | 154 | — |
| adjustments/posterize_grayscale.psd | adjustments | yes | yes | yes | 0.816 | 14 | 149 | — |
| adjustments/posterize_rgb.psd | adjustments | yes | yes | yes | 0.819 | 14 | 128 | — |
| adjustments/threshold_16bits_grayscale.psd | adjustments | yes | yes | yes | 0.187 | 0 | 255 | bit-depth:16 |
| adjustments/threshold_16bits_rgb.psd | adjustments | yes | yes | yes | 0.139 | 0 | 255 | bit-depth:16 |
| adjustments/threshold_cmyk.psd | adjustments | yes | yes | yes | 1.805 | 0 | 224 | — |
| adjustments/threshold_grayscale.psd | adjustments | yes | yes | yes | 0.072 | 0 | 255 | — |
| adjustments/threshold_rgb.psd | adjustments | yes | yes | yes | 0.454 | 0 | 255 | — |
| advanced-blending.psd | root | yes | yes | yes | 0.713 | 0 | 255 | — |
| artboard-bgcolor.psd | root | yes | yes | yes | 0.000 | 0 | 1 | — |
| artboard.psd | root | yes | yes | yes | 0.110 | 0 | 40 | text-path |
| background-red-opacity-80.psd | root | yes | yes | yes | 0.000 | 0 | 1 | — |
| blend-and-clipping.psd | root | yes | yes | no | 23.499 | 255 | 255 | text-path, text-path, text-path, text-path |
| blend-modes/cmyk-blend-modes.psd | blend-modes | yes | yes | no | 188.197 | 255 | 255 | — |
| blend-modes/color-burn.psd | blend-modes | yes | yes | yes | 0.129 | 1 | 1 | — |
| blend-modes/color-dodge.psd | blend-modes | yes | yes | yes | 0.089 | 1 | 2 | — |
| blend-modes/color.psd | blend-modes | yes | yes | yes | 0.250 | 2 | 2 | — |
| blend-modes/darken.psd | blend-modes | yes | yes | yes | 0.168 | 1 | 1 | — |
| blend-modes/darker-color.psd | blend-modes | yes | yes | yes | 0.087 | 1 | 1 | — |
| blend-modes/difference.psd | blend-modes | yes | yes | yes | 0.048 | 1 | 2 | — |
| blend-modes/dissolve.psd | blend-modes | yes | yes | no | 56.095 | 255 | 255 | — |
| blend-modes/divide.psd | blend-modes | yes | yes | yes | 0.130 | 1 | 2 | — |
| blend-modes/exclusion.psd | blend-modes | yes | yes | yes | 0.048 | 1 | 2 | — |
| blend-modes/gray-blend-modes.psd | blend-modes | yes | yes | no | 16.733 | 242 | 255 | — |
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
| blend-modes/rgb-blend-modes.psd | blend-modes | yes | yes | no | 1.297 | 27 | 255 | — |
| blend-modes/saturation.psd | blend-modes | yes | yes | yes | 0.173 | 2 | 2 | — |
| blend-modes/screen.psd | blend-modes | yes | yes | yes | 0.048 | 1 | 2 | — |
| blend-modes/soft-light.psd | blend-modes | yes | yes | yes | 0.129 | 1 | 1 | — |
| blend-modes/subtract.psd | blend-modes | yes | yes | yes | 0.087 | 1 | 1 | — |
| blend-modes/vivid-light.psd | blend-modes | yes | yes | yes | 0.088 | 1 | 1 | — |
| broken-groups.psb | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| broken-groups.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| clip-adjustment.psd | root | yes | yes | yes | 0.000 | 0 | 0 | text-path |
| clipping-mask.psb | root | yes | yes | yes | 0.110 | 0 | 60 | — |
| clipping-mask.psd | root | yes | yes | yes | 0.000 | 0 | 1 | — |
| clipping-mask2.psd | root | yes | yes | yes | 1.199 | 5 | 52 | — |
| clipping-mask3.psd | root | yes | yes | no | 39.221 | 255 | 255 | orphan-clipping |
| clipping-mask4.psd | root | yes | yes | no | 6.848 | 255 | 255 | orphan-clipping |
| clipping-mask5.psd | root | yes | yes | no | 24.148 | 255 | 255 | mask-default, orphan-clipping |
| cmyk-alpha-spot.psd | root | yes | yes | no | 0.000 | 0 | 0 | embedded-icc |
| cmyk-gray-ramp.psd | root | yes | yes | no | 0.000 | 0 | 0 | embedded-icc |
| cmyk-spot.psd | root | yes | yes | no | 0.000 | 0 | 0 | — |
| colormodes/100x20_1bit_bitmap_rle.psd | colormodes | yes | yes | no | 78.030 | 255 | 255 | bit-depth:1, color-mode:0 |
| colormodes/20x5_1bit_bitmap.psd | colormodes | yes | yes | no | 72.675 | 255 | 255 | bit-depth:1, color-mode:0 |
| colormodes/4x4_16bit_cmyk.psd | colormodes | yes | yes | no | 1.813 | 30 | 30 | bit-depth:16 |
| colormodes/4x4_16bit_grayscale.psd | colormodes | yes | yes | yes | 1.500 | 7 | 7 | bit-depth:16 |
| colormodes/4x4_16bit_lab.psd | colormodes | yes | yes | yes | 1.469 | 7 | 7 | bit-depth:16, color-mode:9 |
| colormodes/4x4_16bit_multichannel.psd | colormodes | yes | yes | no | 0.000 | 0 | 0 | bit-depth:16 |
| colormodes/4x4_16bit_rgb.psd | colormodes | yes | yes | yes | 0.000 | 0 | 0 | bit-depth:16 |
| colormodes/4x4_1bit_bitmap.psd | colormodes | yes | yes | no | 131.484 | 255 | 255 | bit-depth:1, color-mode:0 |
| colormodes/4x4_32bit_grayscale.psd | colormodes | yes | yes | yes | 2.906 | 13 | 13 | bit-depth:32 |
| colormodes/4x4_32bit_rgb.psd | colormodes | yes | yes | yes | 0.000 | 0 | 0 | bit-depth:32 |
| colormodes/4x4_8bit_cmyk.psd | colormodes | yes | yes | yes | 0.094 | 1 | 1 | — |
| colormodes/4x4_8bit_duotone.psd | colormodes | yes | yes | yes | 0.234 | 1 | 1 | color-mode:8 |
| colormodes/4x4_8bit_grayscale.psd | colormodes | yes | yes | yes | 0.422 | 2 | 2 | — |
| colormodes/4x4_8bit_index_color.psd | colormodes | yes | yes | no | 0.000 | 0 | 0 | embedded-icc |
| colormodes/4x4_8bit_lab.psd | colormodes | yes | yes | yes | 0.000 | 0 | 0 | color-mode:9 |
| colormodes/4x4_8bit_rgb.psd | colormodes | yes | yes | yes | 0.000 | 0 | 0 | — |
| colormodes/4x4_8bit_rgba.psd | colormodes | yes | yes | no | 124.063 | 255 | 255 | — |
| colorprofiles/north_america_newspaper.psd | colorprofiles | yes | yes | yes | 0.141 | 1 | 1 | — |
| descriptors/hsb-color-swatches.psd | descriptors | yes | yes | yes | 0.000 | 0 | 0 | — |
| descriptors/lab-color-swatches.psd | descriptors | yes | yes | yes | 0.000 | 0 | 0 | color-mode:9 |
| descriptors/stroke-color-descriptors-gray.psd | descriptors | yes | yes | no | 0.516 | 20 | 21 | — |
| descriptors/stroke-color-descriptors-hsb-with-rgb-mode.psd | descriptors | yes | yes | yes | 0.127 | 0 | 88 | — |
| descriptors/stroke-color-descriptors-lab.psd | descriptors | yes | yes | yes | 0.180 | 5 | 14 | color-mode:9 |
| descriptors/stroke-color-descriptors-rgb.psd | descriptors | yes | yes | yes | 0.001 | 0 | 1 | — |
| effect-stroke-gradient.psd | root | yes | yes | no | 11.836 | 187 | 255 | text-path, text-path |
| effects/antialiased-stroke-edge.psd | effects | yes | yes | yes | 0.663 | 31 | 104 | — |
| effects/center-stroke-sizes.psd | effects | yes | yes | yes | 0.026 | 0 | 28 | — |
| effects/double-stroke-effects.psd | effects | yes | yes | yes | 0.002 | 0 | 1 | — |
| effects/effects-enabled.psd | effects | yes | yes | no | 14.500 | 49 | 49 | — |
| effects/feathered-stroke.psd | effects | yes | yes | yes | 1.980 | 48 | 89 | — |
| effects/group-clips-child-stroke.psd | effects | yes | yes | yes | 0.079 | 0 | 19 | — |
| effects/group-stroke-off-canvas.psd | effects | yes | yes | no | 18.616 | 255 | 255 | — |
| effects/inset-stroke-sizes.psd | effects | yes | yes | yes | 0.000 | 0 | 0 | — |
| effects/outside-stroke.psd | effects | yes | yes | yes | 0.117 | 0 | 19 | — |
| effects/shape-fx.psd | effects | yes | yes | yes | 0.000 | 0 | 0 | — |
| effects/shape-fx2.psd | effects | yes | yes | yes | 2.141 | 28 | 38 | — |
| effects/stroke-composite.psd | effects | yes | yes | yes | 1.791 | 43 | 255 | — |
| effects/stroke-effect-transparent-shape.psd | effects | yes | yes | yes | 0.000 | 0 | 0 | — |
| effects/stroke-effects.psd | effects | yes | yes | no | 20.403 | 255 | 255 | — |
| effects/stroke-without-vector-mask.psd | effects | yes | yes | yes | 0.000 | 0 | 0 | — |
| empty-group.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| empty-layer.psb | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| empty-layer.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| fill_adjustments.psd | root | yes | yes | no | 12.319 | 127 | 205 | adjustment:color lookup |
| gradient-fill.psb | root | yes | yes | yes | 0.047 | 1 | 2 | bit-depth:32 |
| gradient-fill.psd | root | yes | yes | yes | 0.047 | 1 | 2 | bit-depth:32 |
| gradient-sizes.psd | root | yes | yes | yes | 0.183 | 1 | 1 | — |
| gradient-styles.psd | root | yes | yes | yes | 0.087 | 1 | 2 | — |
| gradients/noise-gradient-cmyk.psd | gradients | yes | yes | yes | 0.000 | 0 | 0 | — |
| gradients/noise-gradient-grayscale.psd | gradients | yes | yes | yes | 0.000 | 0 | 0 | — |
| gradients/noise-gradient-lab.psd | gradients | yes | yes | yes | 0.000 | 0 | 0 | color-mode:9 |
| gradients/noise-gradient-rgb.psd | gradients | yes | yes | yes | 0.000 | 0 | 0 | — |
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
| history.psb | root | yes | yes | no | 173.866 | 255 | 255 | — |
| history.psd | root | yes | yes | no | 173.866 | 255 | 255 | — |
| layer_comps.psb | root | yes | yes | no | 8.876 | 66 | 144 | — |
| layer_comps.psd | root | yes | yes | no | 8.807 | 67 | 183 | — |
| layer_effects.psd | root | yes | yes | no | 4.845 | 56 | 156 | ag-psd-parser, text-path, text-path, text-path, text-path, text-path, text-path, text-path, text-path, text-path, text-path, text-path |
| layer_mask_data.psb | root | yes | yes | no | 21.052 | 100 | 148 | mask-default |
| layer_mask_data.psd | root | yes | yes | no | 11.465 | 65 | 122 | mask-default |
| layer_params.psb | root | yes | yes | no | 6.637 | 130 | 219 | — |
| layer_params.psd | root | yes | yes | no | 6.637 | 130 | 219 | — |
| layer-name-emoji.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| layers/black-and-white.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | — |
| layers/brightness-contrast.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | — |
| layers/channel-mixer.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | — |
| layers/color-balance.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | — |
| layers/color-lookup.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | adjustment:color lookup |
| layers/curves-with-vectormask.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | — |
| layers/curves.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | — |
| layers/exposure.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | — |
| layers/gradient-fill.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | — |
| layers/gradient-map-v3-classic.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | — |
| layers/gradient-map-v3-linear.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | — |
| layers/gradient-map-v3-perceptual.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | — |
| layers/gradient-map.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | — |
| layers/group.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | — |
| layers/hue-saturation.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | — |
| layers/invert.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | — |
| layers/levels.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | — |
| layers/pattern-fill.psb | layers | yes | yes | yes | 0.000 | 0 | 0 | — |
| layers/pattern-fill.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | — |
| layers/photo-filter.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | — |
| layers/pixel-layer.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | — |
| layers/posterize.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | — |
| layers/selective-color.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | — |
| layers/shape-layer.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | — |
| layers/smartobject-layer.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | — |
| layers/solid-color-fill.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | — |
| layers/threshold.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | — |
| layers/type-layer.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | text-path |
| layers/vibrance.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | — |
| layers-minimal/gradient-fill.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | — |
| layers-minimal/pattern-fill.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | — |
| layers-minimal/pixel-layer.psd | layers | yes | yes | no | 35.266 | 255 | 255 | — |
| layers-minimal/shape-layer.psd | layers | yes | yes | no | 34.268 | 255 | 255 | — |
| layers-minimal/smartobject-layer.psd | layers | yes | yes | no | 19.549 | 255 | 255 | — |
| layers-minimal/solid-color-fill.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | — |
| layers-minimal/type-layer.psd | layers | yes | yes | no | 19.549 | 255 | 255 | text-path |
| mask_parameters.psd | root | yes | yes | no | 82.500 | 255 | 255 | mask-default |
| mask-density-layermask.psd | root | yes | yes | yes | 0.000 | 0 | 0 | mask-default, mask-default, mask-default |
| mask-density-layervectormask.psd | root | yes | yes | no | 3.431 | 48 | 62 | mask-default, mask-default, mask-default |
| mask-density-vectormask.psd | root | yes | yes | yes | 0.000 | 0 | 0 | mask-default, mask-default, mask-default |
| mask-disabled.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| mask-index.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| mask-vector-density.psd | root | yes | yes | yes | 0.000 | 0 | 0 | mask-default, mask-default, mask-default |
| mask.psb | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| mask.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| masks/2.psd | masks | yes | yes | no | 48.892 | 192 | 192 | — |
| masks.psb | root | yes | yes | no | 1.635 | 22 | 59 | text-path, gradient-overlay, text-path, text-path, text-path, text-path, mask-default, text-path |
| masks.psd | root | yes | yes | no | 1.673 | 22 | 65 | text-path, gradient-overlay, text-path, text-path, text-path, text-path, mask-default, text-path |
| masks2.psb | root | yes | yes | yes | 0.108 | 0 | 40 | mask-default, text-path |
| masks2.psd | root | yes | yes | yes | 0.108 | 0 | 40 | mask-default, text-path |
| masks3.psd | root | yes | yes | no | 22.417 | 241 | 249 | — |
| metadata.psb | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| metadata.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| multichannel-pattern-fill.psd | root | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser |
| note.psb | root | yes | yes | yes | 0.254 | 0 | 64 | — |
| note.psd | root | yes | yes | no | 90.744 | 255 | 255 | — |
| opacity-fill.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| passthrough_blendmodes1.psd | root | yes | yes | yes | 0.033 | 1 | 1 | mask-default, mask-default, mask-default, mask-default |
| passthrough_blendmodes2.psd | root | yes | yes | yes | 0.061 | 1 | 2 | mask-default, mask-default, mask-default, mask-default |
| passthrough_blendmodes3.psd | root | yes | yes | yes | 0.156 | 1 | 2 | mask-default, mask-default, mask-default, mask-default |
| passthrough_clipping_mask_adjustment.psd | root | yes | yes | no | 33.261 | 146 | 171 | mask-default, mask-default, orphan-clipping |
| passthrough_clipping_mask_blendmode.psd | root | yes | yes | yes | 0.000 | 0 | 0 | mask-default, mask-default, orphan-clipping |
| passthrough_fill_adjustment.psd | root | yes | yes | yes | 0.021 | 1 | 1 | mask-default, mask-default |
| passthrough_fill_blendmode.psd | root | yes | yes | no | 1.974 | 26 | 33 | — |
| passthrough_opacity.psd | root | yes | yes | no | 54.199 | 86 | 86 | mask-default, mask-default |
| passthrough_vector_mask.psd | root | yes | yes | no | 10.554 | 67 | 112 | mask-default |
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
| patterns.psd | root | yes | yes | no | 4.277 | 95 | 104 | vector-fill:pattern, vector-fill:pattern, vector-fill:pattern, vector-fill:pattern, vector-fill:pattern, vector-fill:pattern |
| pen-text.psb | root | yes | yes | yes | 0.426 | 2 | 252 | bit-depth:32, text-path, text-path |
| pen-text.psd | root | yes | yes | yes | 0.408 | 1 | 249 | bit-depth:32 |
| placedLayer.psb | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| placedLayer.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| semi-transparent-layers.psb | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| semi-transparent-layers.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| slices.psb | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| slices.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| smart-object-slice.psb | root | yes | yes | yes | 0.228 | 0 | 56 | — |
| smart-object-slice.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| stroke.psd | root | yes | yes | yes | 0.001 | 0 | 1 | vector-fill:pattern, vector-fill:pattern, vector-fill:pattern |
| text.psb | root | yes | yes | yes | 0.069 | 0 | 40 | text-path |
| text.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| transparency/clip-opacity.psd | transparency | yes | yes | yes | 0.085 | 1 | 1 | — |
| transparency/fill-opacity.psd | transparency | yes | yes | yes | 1.000 | 27 | 74 | text-path, mask-default |
| transparency/knockout-deep-cyanbg.psd | transparency | yes | yes | yes | 0.000 | 0 | 0 | knockout |
| transparency/knockout-deep-nested-pt.psd | transparency | yes | yes | yes | 0.000 | 0 | 0 | knockout |
| transparency/knockout-deep-nested.psd | transparency | yes | yes | yes | 0.000 | 0 | 0 | knockout |
| transparency/knockout-deep-nobg.psd | transparency | yes | yes | yes | 0.000 | 0 | 0 | knockout |
| transparency/knockout-deep-normal.psd | transparency | yes | yes | yes | 0.000 | 0 | 0 | knockout |
| transparency/knockout-deep-passthrough.psd | transparency | yes | yes | yes | 0.000 | 0 | 0 | knockout |
| transparency/knockout-isolated-groups.psd | transparency | yes | yes | yes | 0.120 | 1 | 64 | knockout, knockout, knockout, knockout, knockout, knockout, knockout, knockout |
| transparency/knockout-none-cyanbg.psd | transparency | yes | yes | yes | 0.000 | 0 | 0 | — |
| transparency/knockout-none-nested.psd | transparency | yes | yes | yes | 0.000 | 0 | 0 | — |
| transparency/knockout-none-normal.psd | transparency | yes | yes | yes | 0.000 | 0 | 0 | — |
| transparency/knockout-none-passthrough.psd | transparency | yes | yes | yes | 0.000 | 0 | 0 | — |
| transparency/knockout-shallow-nested-pt.psd | transparency | yes | yes | yes | 0.000 | 0 | 0 | knockout |
| transparency/knockout-shallow-nested.psd | transparency | yes | yes | yes | 0.000 | 0 | 0 | knockout |
| transparency/transparency-group.psd | transparency | yes | yes | yes | 0.011 | 1 | 2 | — |
| transparentbg-gimp.psb | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| transparentbg-gimp.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| transparentbg.psb | root | yes | yes | yes | 0.456 | 15 | 69 | bit-depth:32 |
| transparentbg.psd | root | yes | yes | yes | 0.458 | 15 | 68 | bit-depth:32 |
| unicode_pathname.psb | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| unicode_pathname.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| vector-mask-disabled.psd | root | yes | yes | yes | 0.000 | 0 | 0 | bit-depth:32 |
| vector-mask.psb | root | yes | yes | yes | 0.000 | 0 | 0 | bit-depth:32 |
| vector-mask.psd | root | yes | yes | no | 31.796 | 218 | 218 | bit-depth:32 |
| vector-mask2.psd | root | yes | yes | no | 0.000 | 0 | 0 | embedded-icc |
| vector-mask3.psd | root | yes | yes | no | 77.695 | 255 | 255 | mask-default, mask-default |

## Known deviations and next work

- CMYK and grayscale layer channels use Little CMS with an embedded profile when present and deterministic default profiles
  otherwise. Lab uses a D50 Lab-to-sRGB conversion; duotone/multichannel use their available channel values because the
  proprietary Photoshop ink curves are not present in the parsed data.
- RGBA16 layer data is retained. Cache-less 16/32-bit reflected fills are generated in their document colour space;
  other 32-bit layer data still clamps floating samples instead of reproducing Photoshop’s document-specific tone map.
- Isolated groups, group opacity/fill, nested group order, and the corpus knockout cases are composited natively on CPU and GPU.
  A bounded native knko parser preserves Photoshop’s shallow/deep selector; shallow knockout restores the containing
  pass-through group’s entry backdrop; ordinary non-group knockout uses the same bounded backdrop model.
- Embedded/default gray and CMYK profiles now provide pre-CMS adjustment transfers for grayscale Invert, Posterize,
  Threshold, Levels, and Curves and CMYK Invert/Posterize/Threshold/Levels/Curves/Brightness-Contrast.
  Non-colorize Hue/Saturation ranges remain mismatched.
- The PSD -2 mask channel is used as Photoshop’s composed vector/user-mask cache; -3 is decoded as the real-mask fallback
  when that cache is absent. Zero-area cache-less masks use their document-wide default. Smart filters and blend-if remain unsupported;
  pattern strokes render from the PSD pattern table, while files whose parser omits that table remain reported.
  Text, vector, and smart-object layers use their layer-owned saved pixel caches; never the document merged composite.
- Bounded raster masks retain the PSD outside-mask default. Density is baked into both stored samples and that outside value;
  feather remains baked into the imported mask cache. Clipped layer effects follow the base layer’s advanced grouping flag.
- Dissolve uses a deterministic local dither because the PSD layer data contains neither Photoshop’s process-local random
  table nor a seed. Its probability/opaque-pixel semantics match, but individual saved-composite dots do not.

Run `npm run psd:fidelity` after `scripts/fetch-psd-corpus.sh` to regenerate this report. For iteration without
rewriting the report, set `PSD_FIDELITY_FILE` to a relative-path substring.
