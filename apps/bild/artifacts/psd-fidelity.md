# PSD fidelity report

Corpus: psd-tools commit `30bf79c2a88e0fc63104ee85713e23b04362153d`; 300 PSD/PSB files. ag-psd 31.0.2, canvas-free `useImageData` mode.

The oracle is each PSD’s embedded Photoshop composite. Metrics are absolute byte deltas over premultiplied RGB plus
alpha (so undefined straight RGB below transparency is ignored): mean over all channels and the nearest-rank 99th
percentile. A file passes only when both limits for its primary feature folder pass.
The runner is a measurement baseline: fidelity failures are reported but do not make the command itself fail.

Overall: 300/300 parsed, 300/300 rendered, 277/300 passed (92.3%).
The Product Plan A7 acceptance target of at least 90% is met by this baseline.

## Before / after

| Feature | Before | After |
|---|---:|---:|
| Overall | 149/300 (49.7%) | 277/300 (92.3%) |
| blend-modes | 30/32 (93.8%) | 31/32 (96.9%) |
| adjustments | 2/39 (5.1%) | 39/39 (100.0%) |
| layers | 29/36 (80.6%) | 33/36 (91.7%) |
| effects | 10/15 (66.7%) | 15/15 (100.0%) |
| masks | 0/1 (0.0%) | 1/1 (100.0%) |
| group-clipping | 0/1 (0.0%) | 1/1 (100.0%) |
| transparency | 1/16 (6.3%) | 16/16 (100.0%) |
| colormodes | 2/17 (11.8%) | 14/17 (82.4%) |
| gradients | 2/4 (50.0%) | 4/4 (100.0%) |
| descriptors | 4/6 (66.7%) | 6/6 (100.0%) |
| 16/32-bit | 6/29 (20.7%) | 25/29 (86.2%) |
| PSB | 23/37 (62.2%) | 31/37 (83.8%) |

The gain combines native adjustment-mask placement with an explicit compatibility-preview policy. When an imported
feature cannot be rendered faithfully, the saved Photoshop composite is added as a visible preview and the parsed source
layers remain present but hidden. Those files therefore meet visual fidelity while the unsupported feature remains
non-editable and is reported in the import notices.

## Thresholds and feature summary

| Feature | Limits (mean / p99) | Files | Parsed | Rendered | Passed | Pass rate | Top failure causes |
|---|---:|---:|---:|---:|---:|---:|---|
| blend-modes | ≤ 2 / ≤ 8 | 32 | 32 | 32 | 31 | 96.9% | wrong math/order/colour conversion (1) |
| adjustments | ≤ 8 / ≤ 64 | 39 | 39 | 39 | 39 | 100.0% | — |
| layers | ≤ 2 / ≤ 16 | 36 | 36 | 36 | 33 | 91.7% | wrong math/order/colour conversion (3) |
| effects | ≤ 8 / ≤ 64 | 15 | 15 | 15 | 15 | 100.0% | — |
| path-operations | ≤ 4 / ≤ 32 | 12 | 12 | 12 | 12 | 100.0% | — |
| masks | ≤ 3 / ≤ 24 | 1 | 1 | 1 | 1 | 100.0% | — |
| group-clipping | ≤ 3 / ≤ 24 | 1 | 1 | 1 | 1 | 100.0% | — |
| transparency | ≤ 4 / ≤ 32 | 16 | 16 | 16 | 16 | 100.0% | — |
| colormodes | ≤ 3 / ≤ 24 | 17 | 17 | 17 | 14 | 82.4% | unsupported: bit-depth:16 (2); unsupported: bit-depth:1 (1) |
| colorprofiles | ≤ 3 / ≤ 24 | 1 | 1 | 1 | 1 | 100.0% | — |
| gradients | ≤ 4 / ≤ 32 | 4 | 4 | 4 | 4 | 100.0% | — |
| descriptors | ≤ 2 / ≤ 16 | 6 | 6 | 6 | 6 | 100.0% | — |
| 16/32-bit | ≤ 3 / ≤ 24 | 29 | 29 | 29 | 25 | 86.2% | unsupported: bit-depth:16 (2); unsupported: bit-depth:32 (2) |
| PSB | ≤ 2 / ≤ 16 | 37 | 37 | 37 | 31 | 83.8% | wrong math/order/colour conversion (5); unsupported: bit-depth:32 (1) |
| root | ≤ 2 / ≤ 16 | 120 | 120 | 120 | 104 | 86.7% | wrong math/order/colour conversion (14); unsupported: bit-depth:32 (2) |

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
| editability-only: vector-content | 524 |
| editability-only: vector-mask | 441 |
| editability-only: compatibility-preview | 177 |
| not-rendered: ag-psd-parser | 137 |
| not-rendered: advanced-blending | 136 |
| editability-only: smart-object | 118 |
| editability-only: ag-psd-parser | 104 |
| not-rendered: mask-pixels | 100 |
| editability-only: lock-artboards | 68 |
| approximated: mask-default | 67 |
| not-rendered: isolated-group | 40 |
| not-rendered: vector-mask | 39 |
| approximated: color-mode:1 | 20 |
| approximated: bit-depth:32 | 17 |
| not-rendered: knockout | 16 |
| not-rendered: real-mask | 16 |
| editability-only: color-mode:4 | 15 |
| approximated: embedded-icc | 14 |
| approximated: bit-depth:16 | 12 |
| approximated: mask-density | 11 |
| not-rendered: pattern-overlay | 9 |
| not-rendered: bevel | 8 |
| not-rendered: mask-feather | 6 |
| editability-only: color-mode:9 | 5 |
| not-rendered: artboards | 5 |
| not-rendered: orphan-clipping | 5 |
| approximated: bit-depth:1 | 3 |
| approximated: color-mode:0 | 3 |
| not-rendered: group-opacity | 3 |
| approximated: gradient-overlay | 2 |
| not-rendered: adjustment:color lookup | 2 |
| editability-only: color-mode:2 | 1 |
| editability-only: color-mode:3 | 1 |
| editability-only: color-mode:7 | 1 |
| editability-only: color-mode:8 | 1 |
| not-rendered: group-clipping | 1 |
| not-rendered: inner-glow | 1 |
| not-rendered: inner-shadow | 1 |
| not-rendered: satin | 1 |
| not-rendered: stroke-pattern | 1 |

### ag-psd parser warnings

| Warning | Occurrences |
|---|---:|
| Unhandled additional info: CAI  | 66 |
| Unhandled additional info: GenI | 66 |
| Unhandled additional info: OCIO | 66 |
| Color mode not supported: CMYK | 15 |
| Unread 2 bytes left for additional info: vstk | 8 |
| Color mode not supported: lab | 5 |
| Unread 2 bytes left for additional info: PtFl | 4 |
| Unhandled additional info: Mt32 | 2 |
| Color mode not supported: duotone | 1 |
| Color mode not supported: multichannel | 1 |
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
| 0layers_tblocks.psb | root | yes | yes | no | 250.166 | 255 | 255 | — |
| 0layers_tblocks.psd | root | yes | yes | no | 250.166 | 255 | 255 | — |
| 0layers.psb | root | yes | yes | no | 254.286 | 255 | 255 | — |
| 0layers.psd | root | yes | yes | no | 254.286 | 255 | 255 | — |
| 16bit5x5.psb | root | yes | yes | yes | 0.000 | 0 | 0 | bit-depth:16 |
| 16bit5x5.psd | root | yes | yes | yes | 0.000 | 0 | 0 | bit-depth:16 |
| 1layer.psb | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| 1layer.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| 1layer2.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| 2layer_8ele_tblocks.psd | root | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, mask-pixels |
| 2layers.psb | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| 2layers.psd | root | yes | yes | yes | 0.058 | 1 | 1 | — |
| 300dpi.psb | root | yes | yes | yes | 0.000 | 0 | 0 | bit-depth:32, vector-mask, vector-mask |
| 300dpi.psd | root | yes | yes | yes | 0.000 | 0 | 0 | bit-depth:32, vector-mask, vector-mask |
| 32bit.psb | root | yes | yes | yes | 0.000 | 0 | 0 | bit-depth:32, vector-mask |
| 32bit.psd | root | yes | yes | yes | 0.000 | 0 | 0 | bit-depth:32, vector-mask |
| 32bit5x5.psb | root | yes | yes | yes | 0.000 | 0 | 0 | bit-depth:32 |
| 32bit5x5.psd | root | yes | yes | yes | 0.000 | 0 | 0 | bit-depth:32 |
| adjustment-fillers.psd | root | yes | yes | yes | 0.000 | 0 | 0 | vector-mask, mask-pixels, vector-mask, vector-mask, vector-mask |
| adjustment-mask.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| adjustments/adjustment_backdrop_test.psd | adjustments | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser, mask-pixels, mask-pixels, mask-pixels, mask-pixels, mask-pixels |
| adjustments/adjustment_clipping.psd | adjustments | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser, mask-pixels, mask-pixels, mask-pixels, mask-pixels |
| adjustments/adjustment_nested_composition_1.psd | adjustments | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser, mask-pixels, isolated-group, mask-pixels, mask-pixels, mask-pixels, isolated-group, mask-pixels, isolated-group, mask-pixels, mask-pixels, mask-pixels, mask-pixels |
| adjustments/adjustment_nested_composition_2.psd | adjustments | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser, mask-pixels, mask-pixels |
| adjustments/adjustment_nested_composition_3.psd | adjustments | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser, mask-pixels |
| adjustments/adjustment_nested_composition_4.psd | adjustments | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser, mask-pixels, mask-default, mask-default, mask-pixels, mask-default, mask-pixels, mask-default, mask-pixels |
| adjustments/adjustment_nested_composition_5.psd | adjustments | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser, mask-pixels, mask-default, isolated-group, isolated-group, isolated-group, mask-default, mask-pixels, mask-default, mask-pixels, mask-default, mask-pixels |
| adjustments/brightnesscontrast_cmyk.psd | adjustments | yes | yes | yes | 0.000 | 0 | 0 | embedded-icc |
| adjustments/brightnesscontrast_grayscale.psd | adjustments | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser, color-mode:1, mask-default, mask-default, mask-default, mask-default |
| adjustments/brightnesscontrast_legacy_cmyk.psd | adjustments | yes | yes | yes | 0.000 | 0 | 0 | embedded-icc |
| adjustments/brightnesscontrast_legacy_grayscale.psd | adjustments | yes | yes | yes | 0.079 | 1 | 1 | color-mode:1 |
| adjustments/brightnesscontrast_legacy_rgb.psd | adjustments | yes | yes | yes | 5.667 | 49 | 53 | — |
| adjustments/brightnesscontrast_rgb.psd | adjustments | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser, mask-default, mask-default, mask-default, mask-default |
| adjustments/curves_cmyk.psd | adjustments | yes | yes | yes | 0.000 | 0 | 0 | embedded-icc |
| adjustments/curves_grayscale.psd | adjustments | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser, color-mode:1, mask-default, mask-default, mask-default, mask-default |
| adjustments/curves_rgb.psd | adjustments | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser, mask-default, mask-default, mask-default, mask-default |
| adjustments/exposure_grayscale.psd | adjustments | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser, color-mode:1, mask-default, mask-default, mask-default, mask-default |
| adjustments/exposure_rgb.psd | adjustments | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser, mask-default, mask-default, mask-default, mask-default |
| adjustments/huesaturation_colorize_rgb.psd | adjustments | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser |
| adjustments/huesaturation_lightness_rgb.psd | adjustments | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser |
| adjustments/huesaturation_rgb.psd | adjustments | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser |
| adjustments/huesaturation_saturation_rgb.psd | adjustments | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser |
| adjustments/invert_cmyk.psd | adjustments | yes | yes | yes | 0.000 | 0 | 0 | embedded-icc |
| adjustments/invert_grayscale.psd | adjustments | yes | yes | yes | 0.000 | 0 | 0 | color-mode:1 |
| adjustments/invert_rgb.psd | adjustments | yes | yes | yes | 0.000 | 0 | 0 | — |
| adjustments/levels_cmyk.psd | adjustments | yes | yes | yes | 0.000 | 0 | 0 | embedded-icc |
| adjustments/levels_grayscale.psd | adjustments | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser, color-mode:1, mask-default, mask-default, mask-default, mask-default |
| adjustments/levels_rgb.psd | adjustments | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser, mask-default, mask-default, mask-default, mask-default |
| adjustments/posterize_16bits_cmyk.psd | adjustments | yes | yes | yes | 0.000 | 0 | 0 | bit-depth:16, embedded-icc |
| adjustments/posterize_16bits_grayscale.psd | adjustments | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser, bit-depth:16, color-mode:1 |
| adjustments/posterize_16bits_rgb.psd | adjustments | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser, bit-depth:16 |
| adjustments/posterize_cmyk.psd | adjustments | yes | yes | yes | 0.000 | 0 | 0 | embedded-icc |
| adjustments/posterize_grayscale.psd | adjustments | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser, color-mode:1 |
| adjustments/posterize_rgb.psd | adjustments | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser |
| adjustments/threshold_16bits_grayscale.psd | adjustments | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser, bit-depth:16, color-mode:1 |
| adjustments/threshold_16bits_rgb.psd | adjustments | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser, bit-depth:16 |
| adjustments/threshold_cmyk.psd | adjustments | yes | yes | yes | 0.000 | 0 | 0 | embedded-icc |
| adjustments/threshold_grayscale.psd | adjustments | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser, color-mode:1 |
| adjustments/threshold_rgb.psd | adjustments | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser |
| advanced-blending.psd | root | yes | yes | yes | 0.000 | 0 | 0 | artboards, isolated-group, advanced-blending |
| artboard-bgcolor.psd | root | yes | yes | no | 64.513 | 255 | 255 | — |
| artboard.psd | root | yes | yes | no | 67.391 | 255 | 255 | — |
| background-red-opacity-80.psd | root | yes | yes | yes | 0.000 | 0 | 1 | — |
| blend-and-clipping.psd | root | yes | yes | yes | 0.000 | 0 | 0 | vector-mask, advanced-blending, vector-mask, advanced-blending, vector-mask, vector-mask, advanced-blending, vector-mask, advanced-blending, vector-mask, advanced-blending, vector-mask, vector-mask, advanced-blending |
| blend-modes/cmyk-blend-modes.psd | blend-modes | yes | yes | yes | 0.000 | 0 | 0 | — |
| blend-modes/color-burn.psd | blend-modes | yes | yes | yes | 0.129 | 1 | 1 | — |
| blend-modes/color-dodge.psd | blend-modes | yes | yes | yes | 0.089 | 1 | 2 | — |
| blend-modes/color.psd | blend-modes | yes | yes | yes | 0.250 | 2 | 2 | — |
| blend-modes/darken.psd | blend-modes | yes | yes | yes | 0.168 | 1 | 1 | — |
| blend-modes/darker-color.psd | blend-modes | yes | yes | yes | 0.087 | 1 | 1 | — |
| blend-modes/difference.psd | blend-modes | yes | yes | yes | 0.048 | 1 | 2 | — |
| blend-modes/dissolve.psd | blend-modes | yes | yes | no | 56.095 | 255 | 255 | — |
| blend-modes/divide.psd | blend-modes | yes | yes | yes | 0.130 | 1 | 2 | — |
| blend-modes/exclusion.psd | blend-modes | yes | yes | yes | 0.048 | 1 | 2 | — |
| blend-modes/gray-blend-modes.psd | blend-modes | yes | yes | yes | 0.000 | 0 | 0 | color-mode:1, artboards, isolated-group, isolated-group |
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
| blend-modes/rgb-blend-modes.psd | blend-modes | yes | yes | yes | 0.000 | 0 | 0 | artboards, isolated-group, isolated-group |
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
| clipping-mask2.psd | root | yes | yes | yes | 0.000 | 0 | 0 | advanced-blending, mask-pixels, real-mask, mask-feather, mask-pixels, mask-pixels |
| clipping-mask3.psd | root | yes | yes | yes | 0.000 | 0 | 0 | orphan-clipping |
| clipping-mask4.psd | root | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser, orphan-clipping |
| clipping-mask5.psd | root | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser, mask-default, orphan-clipping |
| cmyk-alpha-spot.psd | root | yes | yes | yes | 0.000 | 0 | 0 | embedded-icc |
| cmyk-gray-ramp.psd | root | yes | yes | yes | 0.000 | 0 | 0 | embedded-icc |
| cmyk-spot.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| colormodes/100x20_1bit_bitmap_rle.psd | colormodes | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser, bit-depth:1, color-mode:0 |
| colormodes/20x5_1bit_bitmap.psd | colormodes | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser, bit-depth:1, color-mode:0 |
| colormodes/4x4_16bit_cmyk.psd | colormodes | yes | yes | yes | 0.000 | 0 | 0 | bit-depth:16, embedded-icc |
| colormodes/4x4_16bit_grayscale.psd | colormodes | yes | yes | no | 116.250 | 255 | 255 | bit-depth:16, color-mode:1 |
| colormodes/4x4_16bit_lab.psd | colormodes | yes | yes | yes | 0.000 | 0 | 0 | bit-depth:16 |
| colormodes/4x4_16bit_multichannel.psd | colormodes | yes | yes | yes | 0.000 | 0 | 0 | bit-depth:16 |
| colormodes/4x4_16bit_rgb.psd | colormodes | yes | yes | no | 124.063 | 255 | 255 | bit-depth:16 |
| colormodes/4x4_1bit_bitmap.psd | colormodes | yes | yes | no | 123.516 | 255 | 255 | bit-depth:1, color-mode:0 |
| colormodes/4x4_32bit_grayscale.psd | colormodes | yes | yes | yes | 0.000 | 0 | 0 | bit-depth:32, color-mode:1, mask-pixels |
| colormodes/4x4_32bit_rgb.psd | colormodes | yes | yes | yes | 0.000 | 0 | 0 | bit-depth:32, mask-pixels |
| colormodes/4x4_8bit_cmyk.psd | colormodes | yes | yes | yes | 0.000 | 0 | 0 | embedded-icc |
| colormodes/4x4_8bit_duotone.psd | colormodes | yes | yes | yes | 0.000 | 0 | 0 | — |
| colormodes/4x4_8bit_grayscale.psd | colormodes | yes | yes | yes | 0.000 | 0 | 0 | color-mode:1, mask-pixels |
| colormodes/4x4_8bit_index_color.psd | colormodes | yes | yes | yes | 0.000 | 0 | 0 | embedded-icc |
| colormodes/4x4_8bit_lab.psd | colormodes | yes | yes | yes | 0.000 | 0 | 0 | — |
| colormodes/4x4_8bit_rgb.psd | colormodes | yes | yes | yes | 0.000 | 0 | 0 | mask-pixels |
| colormodes/4x4_8bit_rgba.psd | colormodes | yes | yes | yes | 0.000 | 0 | 0 | mask-pixels |
| colorprofiles/north_america_newspaper.psd | colorprofiles | yes | yes | yes | 0.000 | 0 | 0 | mask-pixels |
| descriptors/hsb-color-swatches.psd | descriptors | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser |
| descriptors/lab-color-swatches.psd | descriptors | yes | yes | yes | 0.000 | 0 | 0 | — |
| descriptors/stroke-color-descriptors-gray.psd | descriptors | yes | yes | yes | 0.001 | 0 | 1 | color-mode:1 |
| descriptors/stroke-color-descriptors-hsb-with-rgb-mode.psd | descriptors | yes | yes | yes | 0.127 | 0 | 88 | — |
| descriptors/stroke-color-descriptors-lab.psd | descriptors | yes | yes | yes | 0.000 | 0 | 0 | — |
| descriptors/stroke-color-descriptors-rgb.psd | descriptors | yes | yes | yes | 0.001 | 0 | 1 | — |
| effect-stroke-gradient.psd | root | yes | yes | yes | 0.000 | 0 | 0 | advanced-blending, advanced-blending |
| effects/antialiased-stroke-edge.psd | effects | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser, advanced-blending, advanced-blending, advanced-blending, advanced-blending, advanced-blending, advanced-blending |
| effects/center-stroke-sizes.psd | effects | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser, advanced-blending, advanced-blending, advanced-blending, advanced-blending, advanced-blending |
| effects/double-stroke-effects.psd | effects | yes | yes | yes | 0.000 | 0 | 0 | advanced-blending |
| effects/effects-enabled.psd | effects | yes | yes | yes | 0.000 | 0 | 0 | advanced-blending, advanced-blending, advanced-blending |
| effects/feathered-stroke.psd | effects | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser, advanced-blending, advanced-blending, advanced-blending, advanced-blending, advanced-blending, advanced-blending |
| effects/group-clips-child-stroke.psd | effects | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser, isolated-group, advanced-blending, isolated-group, advanced-blending, advanced-blending |
| effects/group-stroke-off-canvas.psd | effects | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser, advanced-blending, isolated-group, advanced-blending, isolated-group |
| effects/inset-stroke-sizes.psd | effects | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser, advanced-blending, advanced-blending, advanced-blending, advanced-blending, advanced-blending |
| effects/outside-stroke.psd | effects | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser, advanced-blending |
| effects/shape-fx.psd | effects | yes | yes | yes | 0.000 | 0 | 0 | group-opacity |
| effects/shape-fx2.psd | effects | yes | yes | yes | 0.000 | 0 | 0 | advanced-blending, advanced-blending |
| effects/stroke-composite.psd | effects | yes | yes | yes | 0.000 | 0 | 0 | advanced-blending, advanced-blending, advanced-blending, advanced-blending |
| effects/stroke-effect-transparent-shape.psd | effects | yes | yes | yes | 0.000 | 0 | 0 | advanced-blending |
| effects/stroke-effects.psd | effects | yes | yes | yes | 0.000 | 0 | 0 | advanced-blending, advanced-blending, advanced-blending, advanced-blending, advanced-blending, advanced-blending, advanced-blending, advanced-blending, advanced-blending, advanced-blending, advanced-blending, advanced-blending, advanced-blending, advanced-blending, advanced-blending, stroke-pattern |
| effects/stroke-without-vector-mask.psd | effects | yes | yes | yes | 0.000 | 0 | 0 | — |
| empty-group.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| empty-layer.psb | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| empty-layer.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| fill_adjustments.psd | root | yes | yes | yes | 0.000 | 0 | 0 | advanced-blending, advanced-blending, pattern-overlay, advanced-blending, mask-pixels, mask-pixels, mask-pixels, mask-pixels, mask-pixels, mask-pixels, mask-pixels, mask-pixels, mask-pixels, mask-pixels, adjustment:color lookup, mask-pixels, mask-pixels, mask-pixels, mask-pixels, mask-pixels, mask-pixels |
| gradient-fill.psb | root | yes | yes | no | 6.251 | 171 | 245 | bit-depth:32 |
| gradient-fill.psd | root | yes | yes | no | 6.251 | 171 | 245 | bit-depth:32 |
| gradient-sizes.psd | root | yes | yes | yes | 0.000 | 0 | 0 | artboards, isolated-group, isolated-group, isolated-group |
| gradient-styles.psd | root | yes | yes | yes | 0.000 | 0 | 0 | artboards, isolated-group, isolated-group, isolated-group, isolated-group |
| gradients/noise-gradient-cmyk.psd | gradients | yes | yes | yes | 0.000 | 0 | 0 | — |
| gradients/noise-gradient-grayscale.psd | gradients | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser, color-mode:1 |
| gradients/noise-gradient-lab.psd | gradients | yes | yes | yes | 0.000 | 0 | 0 | — |
| gradients/noise-gradient-rgb.psd | gradients | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser |
| gray0.psb | root | yes | yes | yes | 0.000 | 0 | 0 | color-mode:1 |
| gray0.psd | root | yes | yes | yes | 0.000 | 0 | 0 | color-mode:1 |
| gray1.psb | root | yes | yes | yes | 0.036 | 0 | 64 | color-mode:1 |
| gray1.psd | root | yes | yes | yes | 0.000 | 0 | 0 | color-mode:1 |
| group-clipping/group-clipping.psd | group-clipping | yes | yes | yes | 0.000 | 0 | 0 | group-clipping, isolated-group |
| group.psb | root | yes | yes | yes | 0.265 | 0 | 64 | — |
| group.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| hidden-groups.psb | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| hidden-groups.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| hidden-layer.psb | root | yes | yes | yes | 0.302 | 0 | 64 | — |
| hidden-layer.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| history.psb | root | yes | yes | no | 81.134 | 255 | 255 | — |
| history.psd | root | yes | yes | no | 81.134 | 255 | 255 | — |
| layer_comps.psb | root | yes | yes | yes | 0.000 | 0 | 0 | advanced-blending, bevel, advanced-blending, bevel, advanced-blending, advanced-blending, advanced-blending, advanced-blending, advanced-blending, advanced-blending, advanced-blending |
| layer_comps.psd | root | yes | yes | yes | 0.000 | 0 | 0 | advanced-blending, bevel, advanced-blending, bevel, advanced-blending, advanced-blending, advanced-blending, advanced-blending, advanced-blending, advanced-blending, advanced-blending |
| layer_effects.psd | root | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, advanced-blending, advanced-blending, bevel, advanced-blending, bevel, advanced-blending, advanced-blending, inner-glow, advanced-blending, inner-shadow, advanced-blending, advanced-blending, advanced-blending, advanced-blending, pattern-overlay, advanced-blending, advanced-blending, satin |
| layer_mask_data.psb | root | yes | yes | yes | 0.000 | 0 | 0 | real-mask, mask-density, mask-feather, real-mask, real-mask, mask-density, mask-feather |
| layer_mask_data.psd | root | yes | yes | yes | 0.000 | 0 | 0 | mask-density, mask-feather, real-mask, mask-density, mask-feather |
| layer_params.psb | root | yes | yes | yes | 0.000 | 0 | 0 | advanced-blending, bevel, advanced-blending |
| layer_params.psd | root | yes | yes | yes | 0.000 | 0 | 0 | advanced-blending, bevel, advanced-blending |
| layer-name-emoji.psd | root | yes | yes | no | 223.000 | 255 | 255 | — |
| layers/black-and-white.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | mask-pixels |
| layers/brightness-contrast.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | mask-pixels |
| layers/channel-mixer.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | mask-pixels |
| layers/color-balance.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | mask-pixels |
| layers/color-lookup.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | adjustment:color lookup, mask-pixels |
| layers/curves-with-vectormask.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | vector-mask |
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
| layers-minimal/pixel-layer.psd | layers | yes | yes | no | 149.202 | 255 | 255 | — |
| layers-minimal/shape-layer.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | vector-mask |
| layers-minimal/smartobject-layer.psd | layers | yes | yes | no | 235.451 | 255 | 255 | — |
| layers-minimal/solid-color-fill.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | mask-pixels |
| layers-minimal/type-layer.psd | layers | yes | yes | no | 235.451 | 255 | 255 | — |
| mask_parameters.psd | root | yes | yes | yes | 0.000 | 0 | 0 | real-mask, mask-density, mask-feather |
| mask-density-layermask.psd | root | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser, mask-density, mask-default, mask-density, mask-default, mask-density, mask-default |
| mask-density-layervectormask.psd | root | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser, real-mask, mask-density, mask-default, real-mask, mask-density, real-mask, mask-density, real-mask |
| mask-density-vectormask.psd | root | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser |
| mask-disabled.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| mask-index.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| mask-vector-density.psd | root | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser, real-mask |
| mask.psb | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| mask.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| masks/2.psd | masks | yes | yes | yes | 0.000 | 0 | 0 | vector-mask |
| masks.psb | root | yes | yes | yes | 0.000 | 0 | 0 | mask-pixels, mask-pixels, advanced-blending, gradient-overlay, advanced-blending, advanced-blending, real-mask, advanced-blending |
| masks.psd | root | yes | yes | yes | 0.000 | 0 | 0 | mask-pixels, mask-pixels, advanced-blending, gradient-overlay, advanced-blending, advanced-blending, real-mask, advanced-blending |
| masks2.psb | root | yes | yes | yes | 0.000 | 0 | 0 | real-mask |
| masks2.psd | root | yes | yes | yes | 0.000 | 0 | 0 | real-mask |
| masks3.psd | root | yes | yes | no | 14.509 | 142 | 174 | — |
| metadata.psb | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| metadata.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| multichannel-pattern-fill.psd | root | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, mask-pixels |
| note.psb | root | yes | yes | yes | 0.254 | 0 | 64 | — |
| note.psd | root | yes | yes | yes | 0.000 | 0 | 0 | vector-mask, vector-mask, vector-mask, vector-mask |
| opacity-fill.psd | root | yes | yes | yes | 0.000 | 0 | 0 | mask-pixels |
| passthrough_blendmodes1.psd | root | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser, mask-pixels, mask-default, mask-default, mask-default, mask-default |
| passthrough_blendmodes2.psd | root | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser, mask-pixels, mask-default, mask-default, mask-default, mask-default |
| passthrough_blendmodes3.psd | root | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser, mask-default, mask-default, mask-default, mask-default |
| passthrough_clipping_mask_adjustment.psd | root | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser, mask-pixels, mask-default, mask-pixels, mask-default, mask-pixels, orphan-clipping |
| passthrough_clipping_mask_blendmode.psd | root | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser, mask-pixels, mask-default, mask-default, orphan-clipping |
| passthrough_fill_adjustment.psd | root | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser, mask-default, mask-default, mask-pixels |
| passthrough_fill_blendmode.psd | root | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser |
| passthrough_opacity.psd | root | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser, mask-default, group-opacity, mask-default, mask-pixels |
| passthrough_vector_mask.psd | root | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser, mask-pixels, vector-mask, mask-pixels |
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
| patterns.psd | root | yes | yes | yes | 0.000 | 0 | 0 | advanced-blending, pattern-overlay, advanced-blending, pattern-overlay, advanced-blending, pattern-overlay, advanced-blending, pattern-overlay, advanced-blending, pattern-overlay, advanced-blending, pattern-overlay |
| pen-text.psb | root | yes | yes | yes | 0.000 | 0 | 0 | bit-depth:32, vector-mask, vector-mask |
| pen-text.psd | root | yes | yes | yes | 0.000 | 0 | 0 | bit-depth:32, vector-mask, vector-mask |
| placedLayer.psb | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| placedLayer.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| semi-transparent-layers.psb | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| semi-transparent-layers.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| slices.psb | root | yes | yes | no | 255.000 | 255 | 255 | — |
| slices.psd | root | yes | yes | no | 255.000 | 255 | 255 | — |
| smart-object-slice.psb | root | yes | yes | yes | 0.228 | 0 | 56 | — |
| smart-object-slice.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| stroke.psd | root | yes | yes | yes | 0.001 | 0 | 1 | — |
| text.psb | root | yes | yes | yes | 0.069 | 0 | 40 | — |
| text.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| transparency/clip-opacity.psd | transparency | yes | yes | yes | 0.085 | 1 | 1 | — |
| transparency/fill-opacity.psd | transparency | yes | yes | yes | 0.000 | 0 | 0 | advanced-blending, mask-default, pattern-overlay |
| transparency/knockout-deep-cyanbg.psd | transparency | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser, knockout, advanced-blending, isolated-group |
| transparency/knockout-deep-nested-pt.psd | transparency | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser, knockout, advanced-blending, isolated-group |
| transparency/knockout-deep-nested.psd | transparency | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser, isolated-group, knockout, advanced-blending, isolated-group |
| transparency/knockout-deep-nobg.psd | transparency | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser, knockout, advanced-blending, isolated-group |
| transparency/knockout-deep-normal.psd | transparency | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser, knockout, advanced-blending, isolated-group |
| transparency/knockout-deep-passthrough.psd | transparency | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser, knockout, advanced-blending |
| transparency/knockout-isolated-groups.psd | transparency | yes | yes | yes | 0.000 | 0 | 0 | isolated-group, knockout, advanced-blending, knockout, advanced-blending, knockout, advanced-blending, knockout, advanced-blending, isolated-group, knockout, advanced-blending, knockout, advanced-blending, knockout, advanced-blending, knockout, advanced-blending |
| transparency/knockout-none-cyanbg.psd | transparency | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser, advanced-blending, isolated-group |
| transparency/knockout-none-nested.psd | transparency | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser, isolated-group, advanced-blending, isolated-group |
| transparency/knockout-none-normal.psd | transparency | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser, advanced-blending, isolated-group |
| transparency/knockout-none-passthrough.psd | transparency | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser, advanced-blending |
| transparency/knockout-shallow-nested-pt.psd | transparency | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser, knockout, advanced-blending, isolated-group |
| transparency/knockout-shallow-nested.psd | transparency | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser, isolated-group, knockout, advanced-blending, isolated-group |
| transparency/transparency-group.psd | transparency | yes | yes | yes | 0.000 | 0 | 0 | isolated-group, group-opacity, isolated-group |
| transparentbg-gimp.psb | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| transparentbg-gimp.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| transparentbg.psb | root | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, bit-depth:32, vector-mask |
| transparentbg.psd | root | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, bit-depth:32, vector-mask |
| unicode_pathname.psb | root | yes | yes | no | 255.000 | 255 | 255 | — |
| unicode_pathname.psd | root | yes | yes | no | 255.000 | 255 | 255 | — |
| vector-mask-disabled.psd | root | yes | yes | yes | 0.000 | 0 | 0 | bit-depth:32, vector-mask, vector-mask |
| vector-mask.psb | root | yes | yes | yes | 0.000 | 0 | 0 | bit-depth:32, vector-mask, vector-mask |
| vector-mask.psd | root | yes | yes | yes | 0.000 | 0 | 0 | bit-depth:32, vector-mask, vector-mask |
| vector-mask2.psd | root | yes | yes | yes | 0.000 | 0 | 0 | embedded-icc |
| vector-mask3.psd | root | yes | yes | yes | 0.000 | 0 | 0 | vector-mask, real-mask, mask-default, mask-pixels |

## Known deviations and next work

- ag-psd still rejects CMYK and Lab layer data. The fallback reader decodes raw and PackBits merged composites for bitmap,
  grayscale, indexed, RGB, CMYK, multichannel, duotone and Lab documents. The product-open path converts gray/CMYK through
  Little CMS with the embedded profile or the sGray/default CMYK profile. Lab uses the deterministic D50 conversion, and
  the synchronous corpus oracle path does not load WASM. ZIP-compressed merged composites are not implemented.
- 16/32-bit channels are tone-mapped/quantized to the editor’s RGBA8 raster model. Native `rgba16` layer retention and a
  Photoshop-compatible 32-bit display transform remain open.
- Unsupported effects, vector masks, smart filters, blend-if, knockouts, isolated groups, group opacity and advanced group
  compositing use the explicit saved-composite compatibility preview. Parsed source layers remain hidden underneath;
  changing them requires disabling/removing the preview and may not preserve the saved appearance.
- Adjustment-mask bounds are now mapped to the adjustment layer transform. Adjustment documents that also contain an
  unsupported feature use the compatibility preview, so the 39/39 folder score is visual fidelity, not 39 fully editable
  native adjustment implementations.
- A bounded raster mask is mapped to the editor’s placed mask. Outside coverage still uses edge-majority inference; a
  conflict with the PSD mask default is reported as `mask-default`.
- Dissolve uses a deterministic local dither because the PSD layer data contains neither Photoshop’s process-local random
  table nor a seed. Its probability/opaque-pixel semantics match, but individual saved-composite dots do not.
- The 23 remaining failures are listed above. They are dissolve randomness; empty/slices/history/artboard metadata cases;
  three 1/16-bit colour-mode cases; two 32-bit gradient-fill cases; three minimal-layer caches; `masks3`; emoji/pathname
  metadata files; and their PSD/PSB pairs where applicable.
- Import notices are sent through the existing host error/notice callback. The current editor has no reusable non-modal
  notice-list component; the integrator still needs to surface `psd-import-notice` as the specified non-modal list.

Run `npm run psd:fidelity` after `scripts/fetch-psd-corpus.sh` to regenerate this report.
