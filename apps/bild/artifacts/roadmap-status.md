# Roadmap status (PRODUCT-PLAN.md, section 6 feature kit)

Status: ✅ done · 🟡 partial · ❌ missing · 🔬 Phase-0 spike measured (not a product feature yet).

Each row names its evidence: a test, a measurement, or a screenshot path. "Green" counts only on the integration
branch.

Last update: 2026-09-24, Phase 0.

## 6.1 Document, layers, view

| Function | Status | Evidence |
|---|---|---|
| Tabs, New, Open, Save, Recovery | ✅ | `tests/e2e/workspace.spec.ts`, `tests/e2e/recovery.spec.ts` |
| Save/Export chooses the file before encoding (B1) | ✅ | `tests/e2e/large-save.spec.ts` (40 MP, user activation checked at the picker) |
| Export dialog PNG/JPEG/WebP/AVIF/TIFF | 🟡 PNG/JPEG only | `tests/e2e/editor-workflows.spec.ts` |
| Export per artboard/layer, @1x/@2x/@3x | ❌ | benchmark 2/9/10 red (`artifacts/benchmarks.md`) |
| Layers, groups, masks, clipping masks, opacity | ✅ | `tests/e2e/editor-workflows.spec.ts`, `tests/unit/upstream-history-layers.test.ts` |
| Fill opacity, locks, colour labels, layer-panel search | ❌ | Phase 1 |
| All 27 blend modes | 🟡 13/27 | Measured against the PSD oracle: the 13 existing modes pass; 14 missing (`artifacts/psd-fidelity.md`) |
| Artboards | ❌ | Phase 2 |
| Guides, rulers, grid, smart guides, snapping | 🟡 snapping to centre/edges | Phase 1 |
| Align/distribute, numeric transform | 🟡 numeric | Phase 1 |
| History panel (saved with the project) | ❌ | Phase 1; benchmark 20 red |
| Embedded/linked content | ❌ | Phase 2; benchmark 4 red |
| Swatches, recent colours, eyedropper anywhere | 🟡 colour picker panel | `tests/e2e/painting.spec.ts` |

## 6.2 Selection and masks

| Function | Status | Evidence |
|---|---|---|
| Rectangle/ellipse, lasso/polygon, magic wand, add/subtract, expand/contract | ✅ | `tests/e2e/selection.spec.ts`, `tests/unit/upstream-selection-clipboard.test.ts` |
| Object selection (local model) | ❌ | Phase 2; benchmark 7 red |
| Remove background (U²-Netp + BiRefNet) | ✅ | `tests/e2e/subject.spec.ts`, `artifacts/handoff.md` |
| Refine edge, quick mask, feather, selection from path, colour range | ❌ | Phase 2 |

## 6.3 Painting and retouching

| Function | Status | Evidence |
|---|---|---|
| Brush/eraser with pressure; size, hardness, opacity | ✅ | `tests/e2e/gpu-brush.spec.ts`; brush p95 3–11 ms (`artifacts/performance/browser-perf-gpu.json`) |
| Spot healing, clone stamp, content-aware fill, smudge | ✅ | `tests/e2e/retouch.spec.ts`; benchmark 8 green |
| Brush presets, `.abr` | ❌ | Phase 3 |
| Dodge/burn/sponge as a brush mode | ❌ | Phase 2; benchmark 6 red |
| Liquify light, generative fill | ❌ | Phase 3 |

## 6.4 Colour, adjustments, filters

| Function | Status | Evidence |
|---|---|---|
| Curves, levels, hue/saturation, exposure, gradient map, grain | ✅ | `tests/e2e/adjustments.spec.ts`, `tests/unit/upstream-adjustments.test.ts` |
| Gaussian, motion blur, noise, lens correction | ✅ | `tests/unit/filter-blur.test.ts`; integrator check against ImageMagick (mean 0.50, max 1) |
| Basic adjustment layer, colour lookup, colour panel, sharpen | ❌ | Phase 2 |
| Live filter stack | ❌ | Phase 1 (model) / Phase 2 (UI) |

## 6.5 Transform

| Function | Status | Evidence |
|---|---|---|
| Free transform, flip, distort, crop, image/canvas size | ✅ | `tests/unit/transform*.test.ts`, `tests/e2e/editor-workflows.spec.ts` |
| Non-destructive crop | 🟡 | Phase 1 (model v2) |
| Mesh warp, perspective, straighten | ❌ | Phase 3; benchmark 16 red |

## 6.6 Text and vector

| Function | Status | Evidence |
|---|---|---|
| Text engine (CanvasKit) | 🔬 | `artifacts/canvaskit-check.md`: identical rasters in Chromium, Firefox and WebKit (SHA-256 equal); 3.0 MB gzip; 500 characters p95 9–11 ms (integrator re-run) |
| Point/area text, typography, OpenType | ❌ | Phase 2; benchmark 2/3/15 red |
| Pen tool, booleans, vector masks | 🟡 rectangle/ellipse shapes | Phase 2; benchmark 10 red |

## 6.7 Layer styles

| Function | Status | Evidence |
|---|---|---|
| Drop shadow, stroke, outer glow, overlays | ❌ | Phase 2; benchmark 1/3/19 red |

## 6.8 Files

| Function | Status | Evidence |
|---|---|---|
| PNG/JPEG/TIFF import with ICC → sRGB | ✅ | `tests/unit/icc.test.ts`, `tests/unit/jpeg.test.ts`, `tests/e2e/own-files.spec.ts` (integrator files) |
| HEIC (browser / host codec / opt-in LGPL) | ✅ | `tests/e2e/heic.spec.ts`; camera HEIC mean Δ 0.38 |
| WebP/AVIF/GIF import | ❌ | Phase 1 |
| PSD read | 🔬 | `artifacts/psd-fidelity.md`: 276/300 parsed, 43.3 % under threshold (target ≥ 90 % in Phase 2) |
| PSD write, RAW | ❌ | Phase 3 |
| Mac `.comp` read | ✅ | `tests/unit/compPackage.test.ts`, `tests/e2e/workspace.spec.ts` |
| Mac `.comp` write | ✅ (removed from the menu, E2) | code stays until A2 |

## Architecture (section 4)

| Item | Status | Evidence |
|---|---|---|
| A1 Tauri shell + WebView matrix | 🔬 | `artifacts/tauri-webview-matrix.md` (see there) |
| A5 CanvasKit | 🔬 all abort criteria passed | `artifacts/canvaskit-check.md` |
| A7 PSD corpus + oracle | 🔬 baseline | `artifacts/psd-fidelity.md`, `scripts/fetch-psd-corpus.sh` |
| A9 core-task benchmarks | 🔬 skeleton: 1 green / 19 red at the first missing capability | `tests/benchmarks/`, `artifacts/benchmarks.md` |
| A0, A2, A3, A4, A8 | ❌ | Phase 1 |
