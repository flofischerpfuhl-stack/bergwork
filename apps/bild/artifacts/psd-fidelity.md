# PSD fidelity baseline

Corpus: psd-tools commit `30bf79c2a88e0fc63104ee85713e23b04362153d`; 300 PSD/PSB files. ag-psd 31.0.2, canvas-free `useImageData` mode.

The oracle is each PSD’s embedded Photoshop composite. Metrics are absolute byte deltas over premultiplied RGB plus
alpha (so undefined straight RGB below transparency is ignored): mean over all channels and the nearest-rank 99th
percentile. A file passes only when both limits for its primary feature folder pass.
The runner is a measurement baseline: fidelity failures are reported but do not make the command itself fail.

Overall: 276/300 parsed, 276/300 rendered, 130/300 passed (43.3%).
The Product Plan A7 acceptance target of at least 90% is **not met** by this baseline.

## Thresholds and feature summary

| Feature | Limits (mean / p99) | Files | Parsed | Rendered | Passed | Pass rate | Top failure causes |
|---|---:|---:|---:|---:|---:|---:|---|
| blend-modes | ≤ 2 / ≤ 8 | 32 | 31 | 31 | 19 | 59.4% | parse: Error: Color mode not supported: CMYK (1); unsupported: artboards (1); unsupported: blend-mode:darker color (1) |
| adjustments | ≤ 8 / ≤ 64 | 39 | 31 | 31 | 1 | 2.6% | unsupported: ag-psd-parser (27); parse: Error: Color mode not supported: CMYK (8); unsupported: adjustment:brightness/contrast (1) |
| layers | ≤ 2 / ≤ 16 | 36 | 36 | 36 | 29 | 80.6% | unsupported: mask-pixels (3); wrong math/order/colour conversion (3); unsupported: vector-mask (1) |
| effects | ≤ 8 / ≤ 64 | 15 | 15 | 15 | 2 | 13.3% | unsupported: ag-psd-parser (7); unsupported: layer-effects (6) |
| path-operations | ≤ 4 / ≤ 32 | 12 | 12 | 12 | 12 | 100.0% | — |
| masks | ≤ 3 / ≤ 24 | 1 | 1 | 1 | 0 | 0.0% | unsupported: vector-mask (1) |
| group-clipping | ≤ 3 / ≤ 24 | 1 | 1 | 1 | 0 | 0.0% | unsupported: group-clipping (1) |
| transparency | ≤ 4 / ≤ 32 | 16 | 16 | 16 | 1 | 6.3% | unsupported: ag-psd-parser (12); unsupported: layer-effects (2); unsupported: isolated-group (1) |
| colormodes | ≤ 3 / ≤ 24 | 17 | 10 | 10 | 2 | 11.8% | parse: Error: Color mode not supported: CMYK (2); parse: Error: Color mode not supported: lab (2); unsupported: ag-psd-parser (2) |
| colorprofiles | ≤ 3 / ≤ 24 | 1 | 1 | 1 | 1 | 100.0% | — |
| gradients | ≤ 4 / ≤ 32 | 4 | 2 | 2 | 2 | 50.0% | parse: Error: Color mode not supported: CMYK (1); parse: Error: Color mode not supported: lab (1) |
| descriptors | ≤ 2 / ≤ 16 | 6 | 4 | 4 | 4 | 66.7% | parse: Error: Color mode not supported: lab (2) |
| 16/32-bit | ≤ 3 / ≤ 24 | 29 | 25 | 25 | 6 | 20.7% | unsupported: bit-depth:32 (11); unsupported: ag-psd-parser (6); parse: Error: Color mode not supported: CMYK (2) |
| PSB | ≤ 2 / ≤ 16 | 37 | 37 | 37 | 24 | 64.9% | wrong math/order/colour conversion (5); unsupported: bit-depth:32 (4); unsupported: layer-effects (2) |
| root | ≤ 2 / ≤ 16 | 120 | 116 | 116 | 57 | 47.5% | unsupported: ag-psd-parser (22); wrong math/order/colour conversion (12); unsupported: bit-depth:32 (9) |

Files in the `16/32-bit` and `PSB` rows are also counted in their feature/root row.

## Photoshop blend-mode oracle

| Mode | Current mapping | Oracle result | Mean | p99 |
|---|---|---:|---:|---:|
| normal | native | pass | 0.088 | 1 |
| dissolve | fallback to normal | unsupported (pixel fail) | 55.813 | 223 |
| darken | native | pass | 0.168 | 1 |
| multiply | native | pass | 0.168 | 1 |
| color burn | native | pass | 0.129 | 1 |
| linear burn | fallback to normal | unsupported (pixel fail) | 8.966 | 96 |
| darker color | fallback to normal | unsupported (pixel fail) | 13.010 | 97 |
| lighten | native | pass | 0.048 | 1 |
| screen | native | pass | 0.048 | 1 |
| color dodge | native | pass | 0.089 | 1 |
| linear dodge | fallback to normal | unsupported (pixel fail) | 10.373 | 97 |
| lighter color | fallback to normal | unsupported (pixel fail) | 10.462 | 96 |
| overlay | native | pass | 0.128 | 1 |
| soft light | fallback to normal | unsupported (pixel fail) | 14.987 | 96 |
| hard light | fallback to normal | unsupported (pixel pass) | 0.131 | 1 |
| vivid light | fallback to normal | unsupported (pixel pass) | 0.088 | 1 |
| linear light | fallback to normal | unsupported (pixel pass) | 0.217 | 1 |
| pin light | fallback to normal | unsupported (pixel pass) | 0.088 | 1 |
| hard mix | fallback to normal | unsupported (pixel fail) | 13.490 | 96 |
| difference | native | pass | 0.048 | 1 |
| exclusion | fallback to normal | unsupported (pixel fail) | 10.376 | 97 |
| subtract | fallback to normal | unsupported (pixel fail) | 15.030 | 97 |
| divide | fallback to normal | unsupported (pixel fail) | 19.362 | 130 |
| hue | native | pass | 0.166 | 1 |
| saturation | native | pass | 0.173 | 2 |
| color | native | pass | 0.250 | 2 |
| luminosity | native | pass | 0.119 | 1 |

Native formula failures: none.
Unsupported modes whose fallback fails the oracle: dissolve (fail), linear burn (fail), darker color (fail), linear dodge (fail), lighter color (fail), soft light (fail), hard mix (fail), exclusion (fail), subtract (fail), divide (fail).
Unsupported modes whose particular fixture happens to pass under the normal fallback: hard light, vivid light, linear light, pin light.
Those coincidental pixel passes do not count as implementation support and all 14 unsupported modes remain A8 work.

## Unsupported and approximated features

Nothing detected by the adapter is silently discarded. Counts below are layer/file occurrences; editability-only items
use the PSD’s saved pixel cache and can still match the visual oracle.

| Impact and feature | Occurrences |
|---|---:|
| editability-only: vector-content | 524 |
| editability-only: vector-mask | 441 |
| not-rendered: ag-psd-parser | 217 |
| not-rendered: layer-effects | 144 |
| approximated: mask-default | 140 |
| not-rendered: advanced-blending | 136 |
| editability-only: smart-object | 118 |
| not-rendered: mask-pixels | 100 |
| editability-only: text | 43 |
| not-rendered: isolated-group | 40 |
| not-rendered: vector-mask | 39 |
| not-rendered: adjustment:curves | 35 |
| approximated: fill-opacity | 23 |
| approximated: color-mode:1 | 20 |
| not-rendered: adjustment:hue/saturation | 20 |
| not-rendered: adjustment:exposure | 18 |
| not-rendered: adjustment:posterize | 18 |
| not-rendered: adjustment:threshold | 18 |
| approximated: bit-depth:32 | 17 |
| not-rendered: knockout | 16 |
| not-rendered: real-mask | 16 |
| not-rendered: adjustment:brightness/contrast | 14 |
| approximated: mask-density | 11 |
| not-rendered: adjustment:levels | 10 |
| not-rendered: blend-mode:linear dodge | 10 |
| not-rendered: blend-mode:exclusion | 9 |
| approximated: bit-depth:16 | 8 |
| not-rendered: blend-mode:dissolve | 7 |
| not-rendered: blend-mode:divide | 7 |
| not-rendered: blend-mode:hard light | 7 |
| not-rendered: blend-mode:hard mix | 7 |
| not-rendered: blend-mode:lighter color | 7 |
| not-rendered: blend-mode:linear burn | 7 |
| not-rendered: blend-mode:linear light | 7 |
| not-rendered: blend-mode:pin light | 7 |
| not-rendered: blend-mode:soft light | 7 |
| not-rendered: blend-mode:subtract | 7 |
| not-rendered: blend-mode:vivid light | 7 |
| not-rendered: mask-feather | 6 |
| not-rendered: adjustment:gradient map | 5 |
| not-rendered: artboards | 5 |
| not-rendered: blend-mode:darker color | 5 |
| not-rendered: orphan-clipping | 5 |
| not-rendered: adjustment:invert | 4 |
| approximated: bit-depth:1 | 3 |
| approximated: color-mode:0 | 3 |
| not-rendered: adjustment:color balance | 3 |
| not-rendered: group-opacity | 3 |
| not-rendered: adjustment:black & white | 2 |
| not-rendered: adjustment:channel mixer | 2 |
| not-rendered: adjustment:color lookup | 2 |
| not-rendered: adjustment:photo filter | 2 |
| not-rendered: adjustment:selective color | 2 |
| not-rendered: adjustment:vibrance | 2 |
| not-rendered: group-clipping | 1 |

### ag-psd parser warnings

| Warning | Occurrences |
|---|---:|
| Unhandled additional info: CAI  | 66 |
| Unhandled additional info: GenI | 66 |
| Unhandled additional info: OCIO | 66 |
| Unread 2 bytes left for additional info: vstk | 8 |
| Unread 2 bytes left for additional info: PtFl | 4 |
| Unhandled additional info: Mt32 | 2 |
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
| 2layer_8ele_tblocks.psd | root | yes | yes | no | 191.250 | 255 | 255 | ag-psd-parser, adjustment:hue/saturation, mask-pixels |
| 2layers.psb | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| 2layers.psd | root | yes | yes | yes | 0.058 | 1 | 1 | — |
| 300dpi.psb | root | yes | yes | no | 45.327 | 255 | 255 | bit-depth:32, vector-mask, vector-mask |
| 300dpi.psd | root | yes | yes | no | 45.327 | 255 | 255 | bit-depth:32, vector-mask, vector-mask |
| 32bit.psb | root | yes | yes | no | 21.768 | 245 | 245 | bit-depth:32, vector-mask |
| 32bit.psd | root | yes | yes | no | 21.768 | 245 | 245 | bit-depth:32, vector-mask |
| 32bit5x5.psb | root | yes | yes | yes | 0.000 | 0 | 0 | bit-depth:32 |
| 32bit5x5.psd | root | yes | yes | yes | 0.000 | 0 | 0 | bit-depth:32 |
| adjustment-fillers.psd | root | yes | yes | yes | 0.622 | 0 | 255 | vector-mask, mask-pixels, vector-mask, vector-mask, vector-mask |
| adjustment-mask.psd | root | yes | yes | yes | 0.000 | 0 | 0 | adjustment:brightness/contrast, mask-default |
| adjustments/adjustment_backdrop_test.psd | adjustments | yes | yes | no | 8.368 | 69 | 105 | ag-psd-parser, ag-psd-parser, ag-psd-parser, mask-pixels, mask-pixels, adjustment:curves, mask-pixels, adjustment:curves, mask-default, adjustment:curves, mask-default, adjustment:curves, mask-pixels, adjustment:curves, mask-pixels |
| adjustments/adjustment_clipping.psd | adjustments | yes | yes | no | 31.725 | 96 | 109 | ag-psd-parser, ag-psd-parser, ag-psd-parser, mask-pixels, adjustment:curves, mask-pixels, adjustment:curves, mask-default, adjustment:curves, mask-default, adjustment:curves, mask-pixels, adjustment:curves, mask-pixels |
| adjustments/adjustment_nested_composition_1.psd | adjustments | yes | yes | no | 53.333 | 207 | 226 | ag-psd-parser, ag-psd-parser, ag-psd-parser, mask-pixels, isolated-group, adjustment:curves, mask-pixels, adjustment:curves, mask-pixels, adjustment:exposure, mask-pixels, isolated-group, adjustment:curves, mask-pixels, isolated-group, adjustment:curves, mask-pixels, adjustment:curves, mask-pixels, adjustment:curves, adjustment:curves, mask-pixels, adjustment:curves, mask-pixels |
| adjustments/adjustment_nested_composition_2.psd | adjustments | yes | yes | no | 54.555 | 104 | 106 | ag-psd-parser, ag-psd-parser, ag-psd-parser, mask-pixels, adjustment:curves, mask-pixels |
| adjustments/adjustment_nested_composition_3.psd | adjustments | yes | yes | no | 15.541 | 89 | 90 | ag-psd-parser, ag-psd-parser, ag-psd-parser, mask-pixels, adjustment:curves |
| adjustments/adjustment_nested_composition_4.psd | adjustments | yes | yes | no | 63.213 | 244 | 255 | ag-psd-parser, ag-psd-parser, ag-psd-parser, mask-pixels, mask-default, mask-default, adjustment:curves, mask-pixels, mask-default, adjustment:curves, mask-pixels, mask-default, adjustment:exposure, mask-pixels |
| adjustments/adjustment_nested_composition_5.psd | adjustments | yes | yes | no | 28.044 | 208 | 254 | ag-psd-parser, ag-psd-parser, ag-psd-parser, mask-pixels, mask-default, isolated-group, isolated-group, isolated-group, mask-default, adjustment:curves, mask-pixels, mask-default, adjustment:curves, mask-pixels, mask-default, adjustment:exposure, mask-pixels |
| adjustments/brightnesscontrast_cmyk.psd | adjustments | no | no | no | — | — | — | Error: Color mode not supported: CMYK |
| adjustments/brightnesscontrast_grayscale.psd | adjustments | yes | yes | no | 27.258 | 114 | 115 | ag-psd-parser, ag-psd-parser, ag-psd-parser, color-mode:1, mask-default, mask-default, mask-default, mask-default, adjustment:brightness/contrast, mask-default, adjustment:brightness/contrast, mask-default, adjustment:brightness/contrast, mask-default, adjustment:brightness/contrast, mask-default |
| adjustments/brightnesscontrast_legacy_cmyk.psd | adjustments | no | no | no | — | — | — | Error: Color mode not supported: CMYK |
| adjustments/brightnesscontrast_legacy_grayscale.psd | adjustments | yes | yes | yes | 3.910 | 32 | 56 | color-mode:1, adjustment:brightness/contrast, mask-default |
| adjustments/brightnesscontrast_legacy_rgb.psd | adjustments | yes | yes | no | 13.778 | 88 | 93 | adjustment:brightness/contrast, mask-default |
| adjustments/brightnesscontrast_rgb.psd | adjustments | yes | yes | no | 28.085 | 114 | 115 | ag-psd-parser, ag-psd-parser, ag-psd-parser, mask-default, mask-default, mask-default, mask-default, adjustment:brightness/contrast, mask-default, adjustment:brightness/contrast, mask-default, adjustment:brightness/contrast, mask-default, adjustment:brightness/contrast, mask-default |
| adjustments/curves_cmyk.psd | adjustments | no | no | no | — | — | — | Error: Color mode not supported: CMYK |
| adjustments/curves_grayscale.psd | adjustments | yes | yes | no | 23.271 | 92 | 96 | ag-psd-parser, ag-psd-parser, ag-psd-parser, color-mode:1, mask-default, mask-default, mask-default, mask-default, adjustment:curves, mask-default, adjustment:curves, mask-default, adjustment:curves, mask-default, adjustment:curves, mask-default |
| adjustments/curves_rgb.psd | adjustments | yes | yes | no | 27.348 | 180 | 209 | ag-psd-parser, ag-psd-parser, ag-psd-parser, mask-default, mask-default, mask-default, mask-default, adjustment:curves, mask-default, adjustment:curves, mask-default, adjustment:curves, mask-default, adjustment:curves, mask-default |
| adjustments/exposure_grayscale.psd | adjustments | yes | yes | no | 48.134 | 141 | 147 | ag-psd-parser, ag-psd-parser, ag-psd-parser, color-mode:1, mask-default, mask-default, mask-default, mask-default, adjustment:exposure, mask-default, adjustment:exposure, mask-default, adjustment:exposure, mask-default, adjustment:exposure, mask-default |
| adjustments/exposure_rgb.psd | adjustments | yes | yes | no | 46.091 | 122 | 125 | ag-psd-parser, ag-psd-parser, ag-psd-parser, mask-default, mask-default, mask-default, mask-default, adjustment:exposure, mask-default, adjustment:exposure, mask-default, adjustment:exposure, mask-default, adjustment:exposure, mask-default |
| adjustments/huesaturation_colorize_rgb.psd | adjustments | yes | yes | no | 33.210 | 189 | 255 | ag-psd-parser, ag-psd-parser, ag-psd-parser, adjustment:hue/saturation, mask-default, adjustment:hue/saturation, mask-default, adjustment:hue/saturation, mask-default, adjustment:hue/saturation, mask-default |
| adjustments/huesaturation_lightness_rgb.psd | adjustments | yes | yes | no | 54.861 | 187 | 248 | ag-psd-parser, ag-psd-parser, ag-psd-parser, adjustment:hue/saturation, mask-default, adjustment:hue/saturation, mask-default, adjustment:hue/saturation, mask-default, adjustment:hue/saturation, mask-default |
| adjustments/huesaturation_rgb.psd | adjustments | yes | yes | no | 27.180 | 193 | 255 | ag-psd-parser, ag-psd-parser, ag-psd-parser, adjustment:hue/saturation, mask-default, adjustment:hue/saturation, mask-default, adjustment:hue/saturation, mask-default, adjustment:hue/saturation, mask-default |
| adjustments/huesaturation_saturation_rgb.psd | adjustments | yes | yes | no | 9.929 | 94 | 124 | ag-psd-parser, ag-psd-parser, ag-psd-parser, adjustment:hue/saturation, mask-default, adjustment:hue/saturation, mask-default, adjustment:hue/saturation, mask-default, adjustment:hue/saturation, mask-default |
| adjustments/invert_cmyk.psd | adjustments | no | no | no | — | — | — | Error: Color mode not supported: CMYK |
| adjustments/invert_grayscale.psd | adjustments | yes | yes | no | 50.218 | 231 | 255 | color-mode:1, adjustment:invert, mask-default |
| adjustments/invert_rgb.psd | adjustments | yes | yes | no | 44.710 | 243 | 255 | adjustment:invert, mask-default |
| adjustments/levels_cmyk.psd | adjustments | no | no | no | — | — | — | Error: Color mode not supported: CMYK |
| adjustments/levels_grayscale.psd | adjustments | yes | yes | no | 26.328 | 63 | 67 | ag-psd-parser, ag-psd-parser, ag-psd-parser, color-mode:1, mask-default, mask-default, mask-default, mask-default, adjustment:levels, mask-default, adjustment:levels, mask-default, adjustment:levels, mask-default, adjustment:levels, mask-default |
| adjustments/levels_rgb.psd | adjustments | yes | yes | no | 29.673 | 106 | 114 | ag-psd-parser, ag-psd-parser, ag-psd-parser, mask-default, mask-default, mask-default, mask-default, adjustment:levels, mask-default, adjustment:levels, mask-default, adjustment:levels, mask-default, adjustment:levels, mask-default |
| adjustments/posterize_16bits_cmyk.psd | adjustments | no | no | no | — | — | — | Error: Color mode not supported: CMYK |
| adjustments/posterize_16bits_grayscale.psd | adjustments | yes | yes | no | 18.714 | 116 | 127 | ag-psd-parser, ag-psd-parser, ag-psd-parser, bit-depth:16, color-mode:1, adjustment:posterize, adjustment:posterize, adjustment:posterize, adjustment:posterize |
| adjustments/posterize_16bits_rgb.psd | adjustments | yes | yes | no | 11.370 | 79 | 84 | ag-psd-parser, ag-psd-parser, ag-psd-parser, bit-depth:16, adjustment:posterize, adjustment:posterize, adjustment:posterize, adjustment:posterize |
| adjustments/posterize_cmyk.psd | adjustments | no | no | no | — | — | — | Error: Color mode not supported: CMYK |
| adjustments/posterize_grayscale.psd | adjustments | yes | yes | no | 12.699 | 79 | 85 | ag-psd-parser, ag-psd-parser, ag-psd-parser, color-mode:1, adjustment:posterize, mask-default, adjustment:posterize, mask-default, adjustment:posterize, mask-default, adjustment:posterize, mask-default |
| adjustments/posterize_rgb.psd | adjustments | yes | yes | no | 11.412 | 80 | 85 | ag-psd-parser, ag-psd-parser, ag-psd-parser, adjustment:posterize, mask-default, adjustment:posterize, mask-default, adjustment:posterize, mask-default, adjustment:posterize, mask-default |
| adjustments/threshold_16bits_grayscale.psd | adjustments | yes | yes | no | 86.489 | 241 | 249 | ag-psd-parser, ag-psd-parser, ag-psd-parser, bit-depth:16, color-mode:1, adjustment:threshold, adjustment:threshold, adjustment:threshold, adjustment:threshold |
| adjustments/threshold_16bits_rgb.psd | adjustments | yes | yes | no | 68.963 | 236 | 255 | ag-psd-parser, ag-psd-parser, ag-psd-parser, bit-depth:16, adjustment:threshold, adjustment:threshold, adjustment:threshold, adjustment:threshold |
| adjustments/threshold_cmyk.psd | adjustments | no | no | no | — | — | — | Error: Color mode not supported: CMYK |
| adjustments/threshold_grayscale.psd | adjustments | yes | yes | no | 60.792 | 193 | 231 | ag-psd-parser, ag-psd-parser, ag-psd-parser, color-mode:1, adjustment:threshold, mask-default, adjustment:threshold, mask-default, adjustment:threshold, mask-default, adjustment:threshold, mask-default |
| adjustments/threshold_rgb.psd | adjustments | yes | yes | no | 68.968 | 235 | 255 | ag-psd-parser, ag-psd-parser, ag-psd-parser, adjustment:threshold, mask-default, adjustment:threshold, mask-default, adjustment:threshold, mask-default, adjustment:threshold, mask-default |
| advanced-blending.psd | root | yes | yes | no | 73.646 | 228 | 255 | artboards, isolated-group, layer-effects, fill-opacity, layer-effects, advanced-blending |
| artboard-bgcolor.psd | root | yes | yes | no | 64.513 | 255 | 255 | — |
| artboard.psd | root | yes | yes | no | 67.391 | 255 | 255 | ag-psd-parser |
| background-red-opacity-80.psd | root | yes | yes | yes | 0.000 | 0 | 1 | — |
| blend-and-clipping.psd | root | yes | yes | yes | 0.000 | 0 | 0 | layer-effects, vector-mask, advanced-blending, layer-effects, vector-mask, advanced-blending, layer-effects, vector-mask, layer-effects, vector-mask, advanced-blending, layer-effects, vector-mask, advanced-blending, layer-effects, vector-mask, advanced-blending, layer-effects, vector-mask, layer-effects, vector-mask, advanced-blending |
| blend-modes/cmyk-blend-modes.psd | blend-modes | no | no | no | — | — | — | Error: Color mode not supported: CMYK |
| blend-modes/color-burn.psd | blend-modes | yes | yes | yes | 0.129 | 1 | 1 | — |
| blend-modes/color-dodge.psd | blend-modes | yes | yes | yes | 0.089 | 1 | 2 | — |
| blend-modes/color.psd | blend-modes | yes | yes | yes | 0.250 | 2 | 2 | — |
| blend-modes/darken.psd | blend-modes | yes | yes | yes | 0.168 | 1 | 1 | — |
| blend-modes/darker-color.psd | blend-modes | yes | yes | no | 13.010 | 97 | 98 | blend-mode:darker color, blend-mode:darker color, blend-mode:darker color |
| blend-modes/difference.psd | blend-modes | yes | yes | yes | 0.048 | 1 | 2 | — |
| blend-modes/dissolve.psd | blend-modes | yes | yes | no | 55.813 | 223 | 223 | blend-mode:dissolve, blend-mode:dissolve, blend-mode:dissolve |
| blend-modes/divide.psd | blend-modes | yes | yes | no | 19.362 | 130 | 130 | blend-mode:divide, blend-mode:divide, blend-mode:divide |
| blend-modes/exclusion.psd | blend-modes | yes | yes | no | 10.376 | 97 | 98 | blend-mode:exclusion, blend-mode:exclusion, blend-mode:exclusion |
| blend-modes/gray-blend-modes.psd | blend-modes | yes | yes | no | 9.626 | 181 | 255 | color-mode:1, artboards, isolated-group, blend-mode:hard light, blend-mode:soft light, blend-mode:exclusion, blend-mode:subtract, blend-mode:linear dodge, blend-mode:linear burn, blend-mode:vivid light, blend-mode:linear light, blend-mode:pin light, blend-mode:hard mix, blend-mode:divide, blend-mode:dissolve, isolated-group, blend-mode:hard light, blend-mode:soft light, blend-mode:exclusion, blend-mode:subtract, blend-mode:linear dodge, blend-mode:linear burn, blend-mode:vivid light, blend-mode:linear light, blend-mode:pin light, blend-mode:hard mix, blend-mode:divide, blend-mode:dissolve |
| blend-modes/group-divider-blend-mode.psd | blend-modes | yes | yes | yes | 0.000 | 0 | 0 | — |
| blend-modes/hard-light.psd | blend-modes | yes | yes | yes | 0.131 | 1 | 2 | blend-mode:hard light, blend-mode:hard light, blend-mode:hard light |
| blend-modes/hard-mix.psd | blend-modes | yes | yes | no | 13.490 | 96 | 97 | blend-mode:hard mix, blend-mode:hard mix, blend-mode:hard mix |
| blend-modes/hue.psd | blend-modes | yes | yes | yes | 0.166 | 1 | 1 | — |
| blend-modes/lighten.psd | blend-modes | yes | yes | yes | 0.048 | 1 | 2 | — |
| blend-modes/lighter-color.psd | blend-modes | yes | yes | no | 10.462 | 96 | 97 | blend-mode:lighter color, blend-mode:lighter color, blend-mode:lighter color |
| blend-modes/linear-burn.psd | blend-modes | yes | yes | no | 8.966 | 96 | 97 | blend-mode:linear burn, blend-mode:linear burn, blend-mode:linear burn |
| blend-modes/linear-dodge.psd | blend-modes | yes | yes | no | 10.373 | 97 | 97 | blend-mode:linear dodge, blend-mode:linear dodge, blend-mode:linear dodge |
| blend-modes/linear-light.psd | blend-modes | yes | yes | yes | 0.217 | 1 | 2 | blend-mode:linear light, blend-mode:linear light, blend-mode:linear light |
| blend-modes/luminosity.psd | blend-modes | yes | yes | yes | 0.119 | 1 | 2 | — |
| blend-modes/multiply.psd | blend-modes | yes | yes | yes | 0.168 | 1 | 1 | — |
| blend-modes/normal.psd | blend-modes | yes | yes | yes | 0.088 | 1 | 1 | — |
| blend-modes/overlay.psd | blend-modes | yes | yes | yes | 0.128 | 1 | 1 | — |
| blend-modes/pass-through.psd | blend-modes | yes | yes | yes | 0.088 | 1 | 1 | — |
| blend-modes/pin-light.psd | blend-modes | yes | yes | yes | 0.088 | 1 | 2 | blend-mode:pin light, blend-mode:pin light, blend-mode:pin light |
| blend-modes/rgb-blend-modes.psd | blend-modes | yes | yes | no | 13.395 | 254 | 255 | artboards, isolated-group, blend-mode:hard light, blend-mode:soft light, blend-mode:exclusion, blend-mode:subtract, blend-mode:linear dodge, blend-mode:linear burn, blend-mode:vivid light, blend-mode:linear light, blend-mode:pin light, blend-mode:hard mix, blend-mode:divide, blend-mode:darker color, blend-mode:lighter color, blend-mode:dissolve, isolated-group, blend-mode:hard light, blend-mode:soft light, blend-mode:exclusion, blend-mode:subtract, blend-mode:linear dodge, blend-mode:linear burn, blend-mode:vivid light, blend-mode:linear light, blend-mode:pin light, blend-mode:hard mix, blend-mode:divide, blend-mode:darker color, blend-mode:lighter color, blend-mode:dissolve |
| blend-modes/saturation.psd | blend-modes | yes | yes | yes | 0.173 | 2 | 2 | — |
| blend-modes/screen.psd | blend-modes | yes | yes | yes | 0.048 | 1 | 2 | — |
| blend-modes/soft-light.psd | blend-modes | yes | yes | no | 14.987 | 96 | 97 | blend-mode:soft light, blend-mode:soft light, blend-mode:soft light |
| blend-modes/subtract.psd | blend-modes | yes | yes | no | 15.030 | 97 | 98 | blend-mode:subtract, blend-mode:subtract, blend-mode:subtract |
| blend-modes/vivid-light.psd | blend-modes | yes | yes | yes | 0.088 | 1 | 1 | blend-mode:vivid light, blend-mode:vivid light, blend-mode:vivid light |
| broken-groups.psb | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| broken-groups.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| clip-adjustment.psd | root | yes | yes | no | 3.217 | 160 | 255 | adjustment:hue/saturation, mask-pixels |
| clipping-mask.psb | root | yes | yes | yes | 0.110 | 0 | 60 | — |
| clipping-mask.psd | root | yes | yes | yes | 0.000 | 0 | 1 | — |
| clipping-mask2.psd | root | yes | yes | no | 18.500 | 80 | 86 | layer-effects, advanced-blending, mask-pixels, real-mask, mask-feather, adjustment:brightness/contrast, mask-pixels, adjustment:color balance, mask-pixels |
| clipping-mask3.psd | root | yes | yes | no | 39.221 | 255 | 255 | orphan-clipping |
| clipping-mask4.psd | root | yes | yes | no | 43.828 | 255 | 255 | ag-psd-parser, ag-psd-parser, ag-psd-parser, blend-mode:exclusion, blend-mode:lighter color, orphan-clipping |
| clipping-mask5.psd | root | yes | yes | no | 24.148 | 255 | 255 | ag-psd-parser, ag-psd-parser, ag-psd-parser, mask-default, blend-mode:exclusion, orphan-clipping |
| cmyk-alpha-spot.psd | root | no | no | no | — | — | — | Error: Color mode not supported: CMYK |
| cmyk-gray-ramp.psd | root | no | no | no | — | — | — | Error: Color mode not supported: CMYK |
| cmyk-spot.psd | root | no | no | no | — | — | — | Error: Color mode not supported: CMYK |
| colormodes/100x20_1bit_bitmap_rle.psd | colormodes | yes | yes | no | 176.970 | 255 | 255 | ag-psd-parser, ag-psd-parser, ag-psd-parser, bit-depth:1, color-mode:0 |
| colormodes/20x5_1bit_bitmap.psd | colormodes | yes | yes | no | 182.325 | 255 | 255 | ag-psd-parser, ag-psd-parser, ag-psd-parser, bit-depth:1, color-mode:0 |
| colormodes/4x4_16bit_cmyk.psd | colormodes | no | no | no | — | — | — | Error: Color mode not supported: CMYK |
| colormodes/4x4_16bit_grayscale.psd | colormodes | yes | yes | no | 116.250 | 255 | 255 | bit-depth:16, color-mode:1 |
| colormodes/4x4_16bit_lab.psd | colormodes | no | no | no | — | — | — | Error: Color mode not supported: lab |
| colormodes/4x4_16bit_multichannel.psd | colormodes | no | no | no | — | — | — | Error: Color mode not supported: multichannel |
| colormodes/4x4_16bit_rgb.psd | colormodes | yes | yes | no | 124.063 | 255 | 255 | bit-depth:16 |
| colormodes/4x4_1bit_bitmap.psd | colormodes | yes | yes | no | 123.516 | 255 | 255 | bit-depth:1, color-mode:0 |
| colormodes/4x4_32bit_grayscale.psd | colormodes | yes | yes | no | 95.625 | 255 | 255 | bit-depth:32, color-mode:1, mask-pixels |
| colormodes/4x4_32bit_rgb.psd | colormodes | yes | yes | no | 116.063 | 255 | 255 | bit-depth:32, mask-pixels |
| colormodes/4x4_8bit_cmyk.psd | colormodes | no | no | no | — | — | — | Error: Color mode not supported: CMYK |
| colormodes/4x4_8bit_duotone.psd | colormodes | no | no | no | — | — | — | Error: Color mode not supported: duotone |
| colormodes/4x4_8bit_grayscale.psd | colormodes | yes | yes | yes | 0.328 | 1 | 1 | color-mode:1, mask-pixels |
| colormodes/4x4_8bit_index_color.psd | colormodes | no | no | no | — | — | — | Error: Compression not supported: 0 |
| colormodes/4x4_8bit_lab.psd | colormodes | no | no | no | — | — | — | Error: Color mode not supported: lab |
| colormodes/4x4_8bit_rgb.psd | colormodes | yes | yes | yes | 0.000 | 0 | 0 | mask-pixels |
| colormodes/4x4_8bit_rgba.psd | colormodes | yes | yes | no | 124.063 | 255 | 255 | mask-pixels |
| colorprofiles/north_america_newspaper.psd | colorprofiles | yes | yes | yes | 0.141 | 1 | 1 | mask-pixels |
| descriptors/hsb-color-swatches.psd | descriptors | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser, ag-psd-parser |
| descriptors/lab-color-swatches.psd | descriptors | no | no | no | — | — | — | Error: Color mode not supported: lab |
| descriptors/stroke-color-descriptors-gray.psd | descriptors | yes | yes | yes | 0.001 | 0 | 1 | color-mode:1 |
| descriptors/stroke-color-descriptors-hsb-with-rgb-mode.psd | descriptors | yes | yes | yes | 0.127 | 0 | 88 | ag-psd-parser, ag-psd-parser, ag-psd-parser, ag-psd-parser, ag-psd-parser, ag-psd-parser, ag-psd-parser, ag-psd-parser |
| descriptors/stroke-color-descriptors-lab.psd | descriptors | no | no | no | — | — | — | Error: Color mode not supported: lab |
| descriptors/stroke-color-descriptors-rgb.psd | descriptors | yes | yes | yes | 0.001 | 0 | 1 | — |
| effect-stroke-gradient.psd | root | yes | yes | no | 18.633 | 251 | 255 | layer-effects, advanced-blending, layer-effects, advanced-blending |
| effects/antialiased-stroke-edge.psd | effects | yes | yes | no | 13.020 | 220 | 220 | ag-psd-parser, ag-psd-parser, ag-psd-parser, layer-effects, advanced-blending, layer-effects, advanced-blending, layer-effects, advanced-blending, layer-effects, advanced-blending, layer-effects, advanced-blending, layer-effects, advanced-blending |
| effects/center-stroke-sizes.psd | effects | yes | yes | no | 15.505 | 255 | 255 | ag-psd-parser, ag-psd-parser, ag-psd-parser, layer-effects, advanced-blending, layer-effects, advanced-blending, layer-effects, advanced-blending, layer-effects, advanced-blending, layer-effects, advanced-blending |
| effects/double-stroke-effects.psd | effects | yes | yes | no | 18.721 | 255 | 255 | layer-effects, advanced-blending |
| effects/effects-enabled.psd | effects | yes | yes | yes | 0.000 | 0 | 0 | layer-effects, advanced-blending, layer-effects, advanced-blending, layer-effects, advanced-blending |
| effects/feathered-stroke.psd | effects | yes | yes | no | 21.570 | 215 | 220 | ag-psd-parser, ag-psd-parser, ag-psd-parser, layer-effects, advanced-blending, layer-effects, advanced-blending, layer-effects, advanced-blending, layer-effects, advanced-blending, layer-effects, advanced-blending, layer-effects, advanced-blending |
| effects/group-clips-child-stroke.psd | effects | yes | yes | no | 25.826 | 255 | 255 | ag-psd-parser, ag-psd-parser, ag-psd-parser, isolated-group, layer-effects, advanced-blending, isolated-group, layer-effects, advanced-blending, layer-effects, advanced-blending |
| effects/group-stroke-off-canvas.psd | effects | yes | yes | no | 18.616 | 255 | 255 | ag-psd-parser, ag-psd-parser, ag-psd-parser, layer-effects, advanced-blending, isolated-group, layer-effects, advanced-blending, isolated-group |
| effects/inset-stroke-sizes.psd | effects | yes | yes | no | 11.068 | 255 | 255 | ag-psd-parser, ag-psd-parser, ag-psd-parser, layer-effects, advanced-blending, layer-effects, advanced-blending, layer-effects, advanced-blending, layer-effects, advanced-blending, layer-effects, advanced-blending |
| effects/outside-stroke.psd | effects | yes | yes | no | 27.012 | 255 | 255 | ag-psd-parser, ag-psd-parser, ag-psd-parser, layer-effects, advanced-blending |
| effects/shape-fx.psd | effects | yes | yes | no | 35.104 | 140 | 140 | layer-effects, group-opacity, layer-effects |
| effects/shape-fx2.psd | effects | yes | yes | no | 47.410 | 255 | 255 | layer-effects, advanced-blending, layer-effects, advanced-blending, fill-opacity |
| effects/stroke-composite.psd | effects | yes | yes | no | 16.102 | 255 | 255 | layer-effects, advanced-blending, layer-effects, advanced-blending, layer-effects, advanced-blending, layer-effects, advanced-blending |
| effects/stroke-effect-transparent-shape.psd | effects | yes | yes | no | 30.331 | 153 | 153 | layer-effects, advanced-blending, fill-opacity |
| effects/stroke-effects.psd | effects | yes | yes | no | 28.481 | 255 | 255 | layer-effects, advanced-blending, layer-effects, advanced-blending, layer-effects, advanced-blending, layer-effects, advanced-blending, layer-effects, advanced-blending, layer-effects, advanced-blending, layer-effects, advanced-blending, layer-effects, advanced-blending, layer-effects, advanced-blending, layer-effects, advanced-blending, layer-effects, advanced-blending, layer-effects, advanced-blending, layer-effects, advanced-blending, layer-effects, advanced-blending, layer-effects, advanced-blending |
| effects/stroke-without-vector-mask.psd | effects | yes | yes | yes | 0.000 | 0 | 0 | — |
| empty-group.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| empty-layer.psb | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| empty-layer.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| fill_adjustments.psd | root | yes | yes | no | 64.104 | 245 | 245 | layer-effects, advanced-blending, layer-effects, advanced-blending, layer-effects, advanced-blending, adjustment:brightness/contrast, mask-pixels, adjustment:levels, mask-pixels, adjustment:curves, mask-pixels, adjustment:exposure, mask-pixels, adjustment:vibrance, mask-pixels, adjustment:hue/saturation, mask-pixels, adjustment:color balance, mask-pixels, adjustment:black & white, mask-pixels, adjustment:photo filter, mask-pixels, adjustment:channel mixer, mask-pixels, adjustment:color lookup, mask-pixels, adjustment:invert, mask-pixels, adjustment:posterize, mask-pixels, adjustment:threshold, mask-pixels, adjustment:selective color, mask-pixels, adjustment:gradient map, mask-pixels |
| gradient-fill.psb | root | yes | yes | no | 6.251 | 171 | 245 | bit-depth:32 |
| gradient-fill.psd | root | yes | yes | no | 6.251 | 171 | 245 | bit-depth:32 |
| gradient-sizes.psd | root | yes | yes | yes | 0.183 | 1 | 1 | artboards, isolated-group, isolated-group, isolated-group |
| gradient-styles.psd | root | yes | yes | yes | 0.087 | 1 | 2 | artboards, isolated-group, isolated-group, isolated-group, isolated-group |
| gradients/noise-gradient-cmyk.psd | gradients | no | no | no | — | — | — | Error: Color mode not supported: CMYK |
| gradients/noise-gradient-grayscale.psd | gradients | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser, ag-psd-parser, color-mode:1 |
| gradients/noise-gradient-lab.psd | gradients | no | no | no | — | — | — | Error: Color mode not supported: lab |
| gradients/noise-gradient-rgb.psd | gradients | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, ag-psd-parser, ag-psd-parser |
| gray0.psb | root | yes | yes | yes | 0.000 | 0 | 0 | color-mode:1 |
| gray0.psd | root | yes | yes | yes | 0.000 | 0 | 0 | color-mode:1 |
| gray1.psb | root | yes | yes | yes | 0.036 | 0 | 64 | color-mode:1 |
| gray1.psd | root | yes | yes | yes | 0.000 | 0 | 0 | color-mode:1 |
| group-clipping/group-clipping.psd | group-clipping | yes | yes | no | 13.876 | 255 | 255 | group-clipping, isolated-group |
| group.psb | root | yes | yes | yes | 0.265 | 0 | 64 | — |
| group.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| hidden-groups.psb | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| hidden-groups.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| hidden-layer.psb | root | yes | yes | yes | 0.302 | 0 | 64 | — |
| hidden-layer.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| history.psb | root | yes | yes | no | 81.134 | 255 | 255 | — |
| history.psd | root | yes | yes | no | 81.134 | 255 | 255 | — |
| layer_comps.psb | root | yes | yes | no | 9.354 | 65 | 182 | layer-effects, advanced-blending, layer-effects, advanced-blending, layer-effects, advanced-blending, layer-effects, advanced-blending, layer-effects, advanced-blending, layer-effects, advanced-blending, layer-effects, advanced-blending, layer-effects, advanced-blending, layer-effects, advanced-blending |
| layer_comps.psd | root | yes | yes | no | 9.214 | 63 | 162 | layer-effects, advanced-blending, layer-effects, advanced-blending, layer-effects, advanced-blending, layer-effects, advanced-blending, layer-effects, advanced-blending, layer-effects, advanced-blending, layer-effects, advanced-blending, layer-effects, advanced-blending, layer-effects, advanced-blending |
| layer_effects.psd | root | yes | yes | no | 80.969 | 146 | 191 | ag-psd-parser, ag-psd-parser, layer-effects, advanced-blending, layer-effects, advanced-blending, layer-effects, advanced-blending, layer-effects, advanced-blending, layer-effects, advanced-blending, fill-opacity, layer-effects, advanced-blending, layer-effects, advanced-blending, layer-effects, advanced-blending, layer-effects, advanced-blending, layer-effects, advanced-blending, layer-effects, advanced-blending, layer-effects, advanced-blending |
| layer_mask_data.psb | root | yes | yes | no | 20.857 | 95 | 147 | real-mask, mask-density, mask-feather, real-mask, real-mask, mask-density, mask-feather |
| layer_mask_data.psd | root | yes | yes | no | 20.661 | 94 | 147 | mask-density, mask-feather, real-mask, mask-density, mask-feather |
| layer_params.psb | root | yes | yes | no | 5.525 | 182 | 245 | layer-effects, advanced-blending, layer-effects, advanced-blending |
| layer_params.psd | root | yes | yes | no | 5.525 | 182 | 245 | layer-effects, advanced-blending, layer-effects, advanced-blending |
| layer-name-emoji.psd | root | yes | yes | no | 223.000 | 255 | 255 | blend-mode:linear dodge |
| layers/black-and-white.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | adjustment:black & white, mask-pixels |
| layers/brightness-contrast.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | adjustment:brightness/contrast, mask-pixels |
| layers/channel-mixer.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | adjustment:channel mixer, mask-pixels |
| layers/color-balance.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | adjustment:color balance, mask-pixels |
| layers/color-lookup.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | adjustment:color lookup, mask-pixels |
| layers/curves-with-vectormask.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | adjustment:curves, vector-mask |
| layers/curves.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | adjustment:curves, mask-pixels |
| layers/exposure.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | adjustment:exposure, mask-pixels |
| layers/gradient-fill.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | mask-pixels |
| layers/gradient-map-v3-classic.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | adjustment:gradient map, mask-pixels |
| layers/gradient-map-v3-linear.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | adjustment:gradient map, mask-pixels |
| layers/gradient-map-v3-perceptual.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | adjustment:gradient map, mask-pixels |
| layers/gradient-map.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | adjustment:gradient map, mask-pixels |
| layers/group.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | — |
| layers/hue-saturation.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | adjustment:hue/saturation, mask-pixels |
| layers/invert.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | adjustment:invert, mask-pixels |
| layers/levels.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | adjustment:levels, mask-pixels |
| layers/pattern-fill.psb | layers | yes | yes | yes | 0.000 | 0 | 0 | ag-psd-parser, mask-pixels |
| layers/pattern-fill.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | mask-pixels |
| layers/photo-filter.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | adjustment:photo filter, mask-pixels |
| layers/pixel-layer.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | — |
| layers/posterize.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | adjustment:posterize, mask-pixels |
| layers/selective-color.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | adjustment:selective color, mask-pixels |
| layers/shape-layer.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | — |
| layers/smartobject-layer.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | — |
| layers/solid-color-fill.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | mask-pixels |
| layers/threshold.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | adjustment:threshold, mask-pixels |
| layers/type-layer.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | — |
| layers/vibrance.psd | layers | yes | yes | yes | 0.000 | 0 | 0 | adjustment:vibrance, mask-pixels |
| layers-minimal/gradient-fill.psd | layers | yes | yes | no | 255.000 | 255 | 255 | mask-pixels |
| layers-minimal/pattern-fill.psd | layers | yes | yes | no | 255.000 | 255 | 255 | mask-pixels |
| layers-minimal/pixel-layer.psd | layers | yes | yes | no | 149.202 | 255 | 255 | — |
| layers-minimal/shape-layer.psd | layers | yes | yes | no | 255.000 | 255 | 255 | vector-mask |
| layers-minimal/smartobject-layer.psd | layers | yes | yes | no | 235.451 | 255 | 255 | — |
| layers-minimal/solid-color-fill.psd | layers | yes | yes | no | 255.000 | 255 | 255 | mask-pixels |
| layers-minimal/type-layer.psd | layers | yes | yes | no | 235.451 | 255 | 255 | — |
| mask_parameters.psd | root | yes | yes | no | 84.561 | 255 | 255 | real-mask, mask-density, mask-feather |
| mask-density-layermask.psd | root | yes | yes | no | 16.521 | 191 | 191 | ag-psd-parser, ag-psd-parser, ag-psd-parser, mask-density, mask-default, mask-density, mask-default, mask-density, mask-default |
| mask-density-layervectormask.psd | root | yes | yes | no | 14.312 | 126 | 127 | ag-psd-parser, ag-psd-parser, ag-psd-parser, real-mask, mask-density, mask-default, real-mask, mask-density, real-mask, mask-density, real-mask |
| mask-density-vectormask.psd | root | yes | yes | no | 23.852 | 191 | 191 | ag-psd-parser, ag-psd-parser, ag-psd-parser |
| mask-disabled.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| mask-index.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| mask-vector-density.psd | root | yes | yes | no | 23.852 | 191 | 191 | ag-psd-parser, ag-psd-parser, ag-psd-parser, real-mask |
| mask.psb | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| mask.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| masks/2.psd | masks | yes | yes | no | 213.723 | 255 | 255 | vector-mask |
| masks.psb | root | yes | yes | yes | 0.831 | 15 | 59 | mask-pixels, mask-pixels, layer-effects, advanced-blending, fill-opacity, layer-effects, advanced-blending, layer-effects, advanced-blending, layer-effects, real-mask, advanced-blending |
| masks.psd | root | yes | yes | yes | 0.869 | 16 | 65 | mask-pixels, mask-pixels, layer-effects, advanced-blending, fill-opacity, layer-effects, advanced-blending, layer-effects, advanced-blending, layer-effects, real-mask, advanced-blending |
| masks2.psb | root | yes | yes | yes | 0.108 | 0 | 40 | real-mask |
| masks2.psd | root | yes | yes | yes | 0.108 | 0 | 40 | real-mask |
| masks3.psd | root | yes | yes | no | 14.509 | 142 | 174 | — |
| metadata.psb | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| metadata.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| multichannel-pattern-fill.psd | root | yes | yes | no | 255.000 | 255 | 255 | ag-psd-parser, mask-pixels |
| note.psb | root | yes | yes | yes | 0.254 | 0 | 64 | — |
| note.psd | root | yes | yes | no | 117.349 | 255 | 255 | vector-mask, vector-mask, vector-mask, vector-mask |
| opacity-fill.psd | root | yes | yes | yes | 0.000 | 0 | 0 | fill-opacity, mask-pixels |
| passthrough_blendmodes1.psd | root | yes | yes | no | 9.734 | 133 | 251 | ag-psd-parser, ag-psd-parser, ag-psd-parser, mask-pixels, mask-default, mask-default, mask-default, mask-default |
| passthrough_blendmodes2.psd | root | yes | yes | no | 40.850 | 246 | 255 | ag-psd-parser, ag-psd-parser, ag-psd-parser, mask-pixels, mask-default, mask-default, mask-default, mask-default |
| passthrough_blendmodes3.psd | root | yes | yes | no | 16.119 | 149 | 251 | ag-psd-parser, ag-psd-parser, ag-psd-parser, mask-default, mask-default, mask-default, mask-default |
| passthrough_clipping_mask_adjustment.psd | root | yes | yes | no | 29.729 | 140 | 169 | ag-psd-parser, ag-psd-parser, ag-psd-parser, mask-pixels, mask-default, adjustment:exposure, mask-pixels, mask-default, adjustment:exposure, mask-pixels, orphan-clipping |
| passthrough_clipping_mask_blendmode.psd | root | yes | yes | no | 20.541 | 124 | 125 | ag-psd-parser, ag-psd-parser, ag-psd-parser, mask-pixels, mask-default, blend-mode:linear dodge, mask-default, blend-mode:linear dodge, orphan-clipping |
| passthrough_fill_adjustment.psd | root | yes | yes | no | 9.261 | 127 | 152 | ag-psd-parser, ag-psd-parser, ag-psd-parser, mask-default, fill-opacity, mask-default, adjustment:exposure, mask-pixels |
| passthrough_fill_blendmode.psd | root | yes | yes | no | 14.650 | 120 | 134 | ag-psd-parser, ag-psd-parser, ag-psd-parser, fill-opacity, blend-mode:lighter color |
| passthrough_opacity.psd | root | yes | yes | no | 55.165 | 90 | 125 | ag-psd-parser, ag-psd-parser, ag-psd-parser, mask-default, group-opacity, mask-default, adjustment:exposure, mask-pixels |
| passthrough_vector_mask.psd | root | yes | yes | no | 16.993 | 107 | 194 | ag-psd-parser, ag-psd-parser, ag-psd-parser, mask-pixels, vector-mask, adjustment:exposure, mask-pixels |
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
| patterns.psd | root | yes | yes | no | 9.964 | 105 | 105 | ag-psd-parser, ag-psd-parser, ag-psd-parser, layer-effects, advanced-blending, layer-effects, advanced-blending, layer-effects, advanced-blending, layer-effects, advanced-blending, layer-effects, advanced-blending, layer-effects, advanced-blending |
| pen-text.psb | root | yes | yes | no | 27.460 | 255 | 255 | bit-depth:32, vector-mask, vector-mask |
| pen-text.psd | root | yes | yes | no | 27.442 | 255 | 255 | bit-depth:32, vector-mask, vector-mask |
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
| transparency/clip-opacity.psd | transparency | yes | yes | yes | 0.085 | 1 | 1 | fill-opacity |
| transparency/fill-opacity.psd | transparency | yes | yes | no | 9.542 | 204 | 204 | layer-effects, advanced-blending, fill-opacity, mask-default |
| transparency/knockout-deep-cyanbg.psd | transparency | yes | yes | no | 31.750 | 127 | 127 | ag-psd-parser, ag-psd-parser, ag-psd-parser, layer-effects, knockout, advanced-blending, fill-opacity, isolated-group |
| transparency/knockout-deep-nested-pt.psd | transparency | yes | yes | no | 63.500 | 127 | 127 | ag-psd-parser, ag-psd-parser, ag-psd-parser, layer-effects, knockout, advanced-blending, fill-opacity, isolated-group |
| transparency/knockout-deep-nested.psd | transparency | yes | yes | no | 63.500 | 127 | 127 | ag-psd-parser, ag-psd-parser, ag-psd-parser, isolated-group, layer-effects, knockout, advanced-blending, fill-opacity, isolated-group |
| transparency/knockout-deep-nobg.psd | transparency | yes | yes | no | 63.500 | 127 | 127 | ag-psd-parser, ag-psd-parser, ag-psd-parser, layer-effects, knockout, advanced-blending, fill-opacity, isolated-group |
| transparency/knockout-deep-normal.psd | transparency | yes | yes | no | 63.500 | 127 | 127 | ag-psd-parser, ag-psd-parser, ag-psd-parser, layer-effects, knockout, advanced-blending, fill-opacity, isolated-group |
| transparency/knockout-deep-passthrough.psd | transparency | yes | yes | no | 63.500 | 127 | 127 | ag-psd-parser, ag-psd-parser, ag-psd-parser, layer-effects, knockout, advanced-blending, fill-opacity |
| transparency/knockout-isolated-groups.psd | transparency | yes | yes | no | 20.092 | 204 | 204 | layer-effects, isolated-group, layer-effects, knockout, advanced-blending, layer-effects, knockout, advanced-blending, layer-effects, knockout, advanced-blending, layer-effects, knockout, advanced-blending, layer-effects, isolated-group, layer-effects, layer-effects, knockout, advanced-blending, layer-effects, knockout, advanced-blending, layer-effects, knockout, advanced-blending, layer-effects, knockout, advanced-blending |
| transparency/knockout-none-cyanbg.psd | transparency | yes | yes | no | 63.500 | 127 | 127 | ag-psd-parser, ag-psd-parser, ag-psd-parser, layer-effects, advanced-blending, fill-opacity, isolated-group |
| transparency/knockout-none-nested.psd | transparency | yes | yes | no | 63.500 | 127 | 127 | ag-psd-parser, ag-psd-parser, ag-psd-parser, isolated-group, layer-effects, advanced-blending, fill-opacity, isolated-group |
| transparency/knockout-none-normal.psd | transparency | yes | yes | no | 63.500 | 127 | 127 | ag-psd-parser, ag-psd-parser, ag-psd-parser, layer-effects, advanced-blending, fill-opacity, isolated-group |
| transparency/knockout-none-passthrough.psd | transparency | yes | yes | no | 63.500 | 127 | 127 | ag-psd-parser, ag-psd-parser, ag-psd-parser, layer-effects, advanced-blending, fill-opacity |
| transparency/knockout-shallow-nested-pt.psd | transparency | yes | yes | no | 63.500 | 127 | 127 | ag-psd-parser, ag-psd-parser, ag-psd-parser, layer-effects, knockout, advanced-blending, fill-opacity, isolated-group |
| transparency/knockout-shallow-nested.psd | transparency | yes | yes | no | 63.500 | 127 | 127 | ag-psd-parser, ag-psd-parser, ag-psd-parser, isolated-group, layer-effects, knockout, advanced-blending, fill-opacity, isolated-group |
| transparency/transparency-group.psd | transparency | yes | yes | no | 6.665 | 127 | 127 | isolated-group, group-opacity, isolated-group |
| transparentbg-gimp.psb | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| transparentbg-gimp.psd | root | yes | yes | yes | 0.000 | 0 | 0 | — |
| transparentbg.psb | root | yes | yes | no | 11.285 | 255 | 255 | ag-psd-parser, bit-depth:32, vector-mask |
| transparentbg.psd | root | yes | yes | no | 11.273 | 255 | 255 | ag-psd-parser, bit-depth:32, vector-mask |
| unicode_pathname.psb | root | yes | yes | no | 255.000 | 255 | 255 | — |
| unicode_pathname.psd | root | yes | yes | no | 255.000 | 255 | 255 | — |
| vector-mask-disabled.psd | root | yes | yes | yes | 0.000 | 0 | 0 | bit-depth:32, vector-mask, vector-mask |
| vector-mask.psb | root | yes | yes | yes | 0.000 | 0 | 0 | bit-depth:32, vector-mask, vector-mask |
| vector-mask.psd | root | yes | yes | no | 31.796 | 218 | 218 | bit-depth:32, vector-mask, vector-mask |
| vector-mask2.psd | root | no | no | no | — | — | — | Error: Invalid layer size |
| vector-mask3.psd | root | yes | yes | no | 56.063 | 184 | 184 | vector-mask, real-mask, mask-default, mask-pixels |

## Known deviations and next work

- ag-psd converts non-RGB documents without ICC colour management; embedded profiles are not exposed by this ag-psd version.
- 16/32-bit channels are reduced to the editor’s RGBA8 raster model before compositing.
- PSD adjustment layers, effects, vector masks, smart filters, blend-if, knockouts, isolated groups, and advanced group
  compositing are reported but not evaluated. Text, vector, and smart-object layers use saved pixel caches only.
- A bounded raster mask is mapped to the editor’s placed mask. Outside coverage uses the editor’s edge-majority inference;
  a conflict with the PSD mask default is reported as `mask-default`.
- Missing blend modes fall back to normal solely to keep the diagnostic render complete; their failures are A8 input.

Run `npm run psd:fidelity` after `scripts/fetch-psd-corpus.sh` to regenerate this report.
