# Roadmap status (PRODUCT-PLAN.md section 6)

Status: ✅ done · 🟡 partial · ❌ missing. A row is green only when its product path and state/pixel evidence are on the
integration-derived branch. This table follows every row of PRODUCT-PLAN section 6; implementation details do not
silently change the plan. Last updated 2026-09-26 after Phase 3, the performance rounds and UI v0.2.

## 6.1 Document, layers, view

| PRODUCT-PLAN row | Status | Evidence / remaining limit |
|---|---|---|
| Tabs, New, Open, Save, Recovery | ✅ | `tests/e2e/workspace.spec.ts`, `tests/e2e/recovery.spec.ts`, `tests/e2e/large-save.spec.ts` |
| One Export dialog: PNG/JPEG/WebP/AVIF/TIFF, resize, size preview, metadata | ✅ | `tests/e2e/export-dialog.spec.ts`, `tests/e2e/export-performance.spec.ts` |
| Export per artboard/layer, @1x/@2x/@3x | ✅ | `tests/e2e/export-artboards.spec.ts`, `artifacts/export-artboards.md` |
| Layers, groups, masks, clipping masks, opacity | ✅ | `tests/e2e/editor-workflows.spec.ts`, `tests/unit/upstream-history-layers.test.ts` |
| Fill opacity, locks, colour labels, layer-panel search/filter | ✅ | `tests/e2e/layer-panel-locks.spec.ts`, `tests/unit/fill-opacity.test.ts`, `tests/unit/layer-search.test.ts`, `artifacts/locks-fill.md` |
| All 27 blend modes | ✅ | 26 deterministic modes match the Photoshop oracle; Dissolve follows its binary-alpha rule. `tests/unit/blend.test.ts`, `artifacts/psd-fidelity.md` |
| Artboards with Social/Web/Print presets | ✅ | `tests/e2e/artboard-tool.spec.ts`; benchmarks 1, 2 and 9 |
| Guides, rulers, grid, smart guides, snapping | 🟡 | Rulers/guides and snapping to guides/centre/edges are implemented; grid and smart guides are missing. `tests/e2e/guides.spec.ts`, `tests/unit/align-guides.test.ts` |
| Align/distribute, numeric transform | ✅ | `tests/e2e/guides.spec.ts`, `tests/unit/align-guides.test.ts`; benchmark 9 |
| History panel, saved in the project | ✅ | `tests/e2e/history-panel.spec.ts`; benchmark 20 |
| Embedded/linked image, SVG, PDF and project content; Edit/Replace Contents | 🟡 | Image/SVG/project Place, Replace and Edit Contents are green; PDF requires a host capability and Fernwork's PDFium build is not release-approved. `tests/e2e/embedded.spec.ts`, `artifacts/embedded.md`; benchmark 4 |
| Swatches (`.aco`/`.ase`), recent colours, eyedropper everywhere | ✅ | `tests/e2e/colour-panel.spec.ts`, `tests/unit/swatch-files.test.ts`; screen eyedropper is a browser/Tauri host capability (Windows hand-check remains open) |

## 6.2 Selection and masks

| PRODUCT-PLAN row | Status | Evidence / remaining limit |
|---|---|---|
| Rectangle/ellipse, lasso/polygon, magic wand, add/subtract, expand/contract | ✅ | `tests/e2e/selection.spec.ts`, `tests/unit/upstream-selection-clipboard.test.ts` |
| Local object selection | ✅ | SlimSAM, user-initiated download, measured one-click IoU 0.99. `tests/e2e/objsel-ui.spec.ts`, `artifacts/object-selection.md`; benchmark 7 was environment-skipped on 2026-09-26 because its local model files were absent |
| Remove subject/background (U²-Netp; BiRefNet option) | ✅ | `tests/e2e/subject.spec.ts`, `tests/e2e/subject-quality.spec.ts` |
| Refine Edge, Quick Mask, feather, selection from path, Colour Range | ✅ | `tests/e2e/objsel-ui.spec.ts`, `tests/e2e/vector-tools.spec.ts` |

## 6.3 Painting and retouching

| PRODUCT-PLAN row | Status | Evidence / remaining limit |
|---|---|---|
| Brush/eraser with pressure, size, hardness, opacity | ✅ | `tests/e2e/gpu-brush.spec.ts`, `tests/unit/brush-dabs.test.ts` |
| Brush presets, flow, spacing, scatter, `.abr` tip import | ✅ | Commit `779604a`; `tests/e2e/brush-presets.spec.ts` |
| Spot healing, Clone Stamp, content-aware fill, Smudge | ✅ | `tests/e2e/retouch.spec.ts`; benchmark 8 |
| Dodge/Burn/Sponge as brush modes | ✅ | `tests/e2e/adjust-p2-ui.spec.ts`; benchmark 6 |
| Liquify light and local generative fill/remove | ✅ | Commit `20effa7` and `artifacts/warp.md`; optional local MI-GAN plus built-in content-aware fallback in commit `c4115f6`, `tests/e2e/genai.spec.ts`, `artifacts/genai.md` |

## 6.4 Colour, adjustments and filters

| PRODUCT-PLAN row | Status | Evidence / remaining limit |
|---|---|---|
| Curves, Levels, Hue/Saturation, Exposure, Gradient Map, Grain | ✅ | `tests/e2e/adjustments.spec.ts`, `tests/unit/upstream-adjustments.test.ts` |
| Basic adjustment layer | ✅ | `tests/e2e/adjust-p2-ui.spec.ts`, `tests/unit/adjust-p2.test.ts` |
| Colour Lookup (`.cube`), B&W, Colour Balance/Selective Colour, Invert/Threshold/Posterize | ✅ | `tests/e2e/adjust-p2-ui.spec.ts`, `artifacts/adjustments-p2.md` |
| Live filter stack per layer | ✅ | Smart-filter rows, visibility, reorder and bake: `tests/e2e/adjust-p2-ui.spec.ts` |
| Gaussian/Motion Blur, Add Noise, Lens Correction | ✅ | `tests/unit/filter-blur.test.ts`, `tests/e2e/adjustments.spec.ts` |
| Unsharp Mask/Smart Sharpen, High Pass, Tilt-Shift/Field Blur | 🟡 | Unsharp Mask, Smart Sharpen and High Pass are live/destructive filters; Tilt-Shift and Field Blur are missing. `tests/e2e/adjust-p2-ui.spec.ts`, `tests/unit/filters-p2.test.ts` |
| Local upscale | ✅ | Optional Real-ESRGAN 2x/4x with user-initiated model download; deterministic Lanczos fallback and denoise-strength blend. `tests/e2e/genai.spec.ts`, `artifacts/genai.md`; benchmark 17 |

## 6.5 Transform

| PRODUCT-PLAN row | Status | Evidence / remaining limit |
|---|---|---|
| Free Transform, flip, distort, crop, image/canvas size | ✅ | `tests/unit/transform*.test.ts`, `tests/e2e/editor-workflows.spec.ts` |
| Non-destructive crop parameters | ✅ | Delete Cropped Pixels defaults off; Reveal All, artboard crop and embedded-layer crop. Commit `09699b9`, `tests/e2e/crop.spec.ts`, `artifacts/crop.md` |
| Mesh Warp, Perspective, Straighten | ✅ | Commit `20effa7`; `tests/e2e/warp-tools.spec.ts`, `tests/unit/warp.test.ts`, `artifacts/warp.md`; benchmark 16 |

## 6.6 Text and vector (A5)

| PRODUCT-PLAN row | Status | Evidence / remaining limit |
|---|---|---|
| Point/area text, typography, OpenType, variable fonts | ✅ | `tests/e2e/text-tool.spec.ts`, `artifacts/text-engine.md`; benchmark 15 |
| Pen, Direct Selection, shapes/radii, booleans, stroke options | ✅ | `tests/e2e/vector-tools.spec.ts`, `artifacts/vector-engine.md`; benchmarks 10 and 18 |
| Vector masks | ✅ | `tests/e2e/vector-tools.spec.ts`, `tests/e2e/effects.spec.ts` |
| Text on path and Warp Text | ✅ | Commit `874a20a`; `tests/e2e/text-path.spec.ts`; benchmark 15 |

## 6.7 Layer styles

| PRODUCT-PLAN row | Status | Evidence / remaining limit |
|---|---|---|
| Drop Shadow, Stroke, Outer Glow, colour/gradient overlays | ✅ | `tests/e2e/layer-style-ui.spec.ts`, `tests/e2e/effects.spec.ts`; benchmarks 1, 3 and 19 |
| Inner Shadow and Inner Glow | ✅ | Commit `a1e1150`; `tests/e2e/layer-style-ui.spec.ts`, `artifacts/layer-styles-2.md` |
| Bevel/Emboss, Satin, Pattern Overlay | ✅ | Implemented as editable live styles and PSD descriptors, beyond the plan's rasterized-import minimum. `tests/e2e/layer-style-ui.spec.ts`, `tests/unit/psd-write.test.ts`, `artifacts/layer-styles-2.md` |

## 6.8 Files

| PRODUCT-PLAN row | Status | Evidence / remaining limit |
|---|---|---|
| PNG/JPEG/TIFF import; HEIC | ✅ | `tests/e2e/import-formats.spec.ts`, `tests/e2e/heic.spec.ts`, `tests/unit/icc.test.ts` |
| WebP/AVIF/GIF import | ✅ | `tests/unit/codec-formats.test.ts`, `tests/e2e/import-formats.spec.ts` |
| Place SVG/PDF | 🟡 | SVG is built in; PDF is host-capability-only and the available PDFium runtime is not release-approved. `tests/e2e/embedded.spec.ts`, `artifacts/embedded.md` |
| PSD read/write | 🟡 | Write is delivered (commit `69f74c8`, `tests/e2e/psd-save.spec.ts`, `artifacts/psd-write.md`). Read is 248/300 = 82.7%; M15 target is every fixable deviation, current ceiling 267/300 = 89.0%. `artifacts/psd-fidelity.md`, `artifacts/psd-target.md` |
| RAW | ✅ | Browser DNG plus opt-in host decoding (Windows WIC / system LibRaw); commit `84e581f`, `tests/e2e/raw-dng.spec.ts`, `artifacts/raw.md`; benchmark 12 |
| Read Mac `.comp` | ✅ | `tests/unit/compPackage.test.ts`, `tests/e2e/workspace.spec.ts` |
| Write Mac `.comp` | ✅ plan action completed: removed from product UI | Compatibility writer remains test-only until frozen fixtures permit deletion (E2/M5) |

## 6.9 Automation

| PRODUCT-PLAN row | Status | Evidence / remaining limit |
|---|---|---|
| Batch export (artboards/layers/files) | ✅ | File batch plus existing per-artboard/layer export; commit `ba5f481`, `tests/e2e/batch.spec.ts`; benchmark 14 |
| Recipes for adjustment/filter stacks | ✅ | Commit `ba5f481`; `tests/e2e/batch.spec.ts`, `tests/unit/recipes.test.ts`; benchmark 14 |
| Recorded actions, scripting, plugin API | ❌ | Deliberately Phase 4, pending the required design decision |

## Phase, architecture and cross-cutting gates

| Item | Status | Evidence / remaining limit |
|---|---|---|
| Phase 2 exit | 🟡 | Features landed, but M15 PSD read target is not yet met and the A9 user test remains owner-deferred |
| Phase 3 feature scope | ✅ | PSD write, CMYK proof/export, RAW, local remove/upscale, warp/liquify, brushes/ABR, path text, remaining styles, batch and recipes are merged; commits/evidence are listed above |
| Phase 3 exit (core tasks 11–20 + user test) | 🟡 | Current automation: 18 passed, task 13 red, task 7 environment-skipped; task 13 is in the 11–20 exit set. User test remains owner-deferred. `artifacts/benchmarks.md` |
| A0–A8 | ✅/🟡 | A0/A2/A3/A4/A5/A6/A8 are implemented and measured. A7 write is green; A7 read remains at 248/300 against the M15 267/300 ceiling. See `artifacts/a0-hosts.md`, `artifacts/a4d-memory.md`, `artifacts/psd-fidelity.md` |
| A9 core-task automation | 🟡 | 18/20 current passes, 1 genuine red, 1 model-dependent skip; no user study yet. `artifacts/benchmarks.md` |
| A10 Lite start bundle | ✅ | Split gate landed at 263.10 kB gzip (`bdb24c7`); latest recorded production value is 281.26 kB, still below 400 kB. `artifacts/bundle-budget.md`, `artifacts/perf-io.md` |
| Licensing | ✅ inventory / 🟡 release | Commit `e82f033`: 546 entries, 20 full texts, offline searchable UI and checker. MPL-2.0/Unicode-3.0 remain Tauri-runtime-only under M13; Tauri stays internal pending legal advice. `artifacts/licensing.md` |
| Change-relevant E2E sets | ✅ | Smoke, changed, area and capped gate commands; 16-area manifest with unit-enforced complete spec coverage. Commit `ee05a58`, `artifacts/e2e-sets.md` |
| UI v0.2 | ✅ | Full-bleed canvas with floating chrome, theme tokens, host live-theme override and compact layouts. Merge `8d9976b`, `tests/e2e/floating-chrome.spec.ts`, `artifacts/ui-v2.md` |

## Performance rounds (2026-09-25)

| Round | Result | Evidence / remaining limit |
|---|---|---|
| PERF2: worker cap, SlimSAM providers, shared CanvasKit | ✅ | Shared CanvasKit saves 128 MiB heap and 7,317,645 transfer bytes; SlimSAM encoder 5.17–6.17 s in contended WebGPU runs, still above 3 s. Commit `469021e`, `artifacts/perf2.md` |
| PERF3: selected brush/eraser | ✅ | Intel selected-event p95 fell 86–92%; committed pixels byte-identical to independent CPU replay. Commit `430f45d`, `artifacts/perf3-webkit-brush.md` |
| View/cache and LOD | ✅ | Visible texture working set 363.00 → 90.75 MiB; unchanged-frame p95 2.24 → 0.07 ms (Chromium). Commits `a87fea6`, `e085d16`; `artifacts/perf-view.md`, `artifacts/perf-view-2.md` |
| Adjustment and filter preview | ✅ | Compositor/view-space previews remove full-raster worker copies; steady Chromium live-filter p95 5.61 ms and preview/Apply max delta 1/255. Commits `fdade6f`, `ae1497c`; `artifacts/perf-tools.md`, `artifacts/perf-filters.md` |
| React UI isolation | ✅ | Pan/opacity/brush produce zero layer-row or thumbnail renders; commit `6b35fbf`, `artifacts/perf-ui.md` |
| Import/export/PSD I/O | ✅ responsiveness; 🟡 Pro export budget | Background image decode cuts median heartbeat gaps to 10–12 ms; PSD worker gaps fall 85–99%; streamed 46 MP PNG avoids 183,877,632 output bytes. Pro ≤3 s PNG target remains open. Commits `28daa6c`, `76ddb40`; `artifacts/perf-io.md`, `artifacts/perf-io-2.md` |
| Retouch interaction | ✅ | Pointer-event p95 reductions of 98.0–99.99%; Clone commit remains synchronous (~582–630 ms). Commit `0ae302b`, `artifacts/perf-retouch.md` |
| Real Tauri/WebKitGTK GPU | 🟡 | Not remeasured under Xvfb; the existing WebKitGTK brush ≤16 ms Pro budget remains open (M10) |
