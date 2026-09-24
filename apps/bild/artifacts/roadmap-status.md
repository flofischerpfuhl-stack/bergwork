# Roadmap status (PRODUCT-PLAN.md, section 6 feature kit)

Status: ✅ done · 🟡 partial · ❌ missing · 🔬 Phase-0 spike measured (not a product feature yet).

Each row names its evidence: a test, a measurement, or a screenshot path. "Green" counts only on the integration
branch.

Last update: 2026-09-24, end of Phase 1 (A4 swap still in lane A4c).

## 6.1 Document, layers, view

| Function | Status | Evidence |
|---|---|---|
| Tabs, New, Open, Save, Recovery | ✅ | `tests/e2e/workspace.spec.ts`, `tests/e2e/recovery.spec.ts` |
| Save/Export chooses the file before encoding (B1) | ✅ | `tests/e2e/large-save.spec.ts` (40 MP, user activation checked at the picker) |
| Export dialog PNG/JPEG/WebP/AVIF/TIFF | 🟡 PNG/JPEG only | `tests/e2e/editor-workflows.spec.ts` |
| Export per artboard/layer, @1x/@2x/@3x | ❌ | benchmark 2/9/10 red (`artifacts/benchmarks.md`) |
| Layers, groups, masks, clipping masks, opacity | ✅ | `tests/e2e/editor-workflows.spec.ts`, `tests/unit/upstream-history-layers.test.ts` |
| Fill opacity, locks, colour labels, layer-panel search | ✅ | `tests/unit/locks.test.ts`, `tests/unit/fill-opacity.test.ts` (incl. Photoshop's eight special fill modes, GPU = CPU within 1/255), `tests/unit/layer-search.test.ts`, `tests/e2e/layer-panel-locks.spec.ts`; PSD import of all three (`artifacts/locks-fill.md`) |
| All 27 blend modes | ✅ 26/27 exact, dissolve by rule | Photoshop oracle: all 26 deterministic modes pass; dissolve uses Photoshop's binary-alpha rule, which a PSD composite cannot pin pixel-exact (`artifacts/psd-fidelity.md`, `tests/unit/blend.test.ts`); blend-modes folder 93.8 % |
| Artboards | ❌ | Phase 2 |
| Guides, rulers, grid, smart guides, snapping | 🟡 rulers, guides (create from ruler, move, delete, numeric, lock, clear, saved in `.fwimg`), snapping to guides/centre/edges; grid and smart guides missing | `tests/e2e/guides.spec.ts`, `tests/unit/align-guides.test.ts` |
| Align/distribute, numeric transform | ✅ | `tests/unit/align-guides.test.ts` (6 edges, 4 distribute modes), `tests/e2e/guides.spec.ts` |
| History panel (saved with the project) | ✅ | `tests/e2e/history-panel.spec.ts` (jump back/forward, saved with the project and undo continues after reopening; option to not save it) |
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
| Non-destructive crop | 🟡 model v2 field present, no tool yet | `src/core/model/types.ts` (`crop`), Phase 2 UI |
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
| WebP/AVIF/GIF import | ✅ | `tests/unit/codec-formats.test.ts`, `tests/e2e/own-files.spec.ts` (integrator files android.webp, adobe.webp, example.avif, pal.gif; Chromium, Firefox, WebKit) |
| PSD read | 🔬 | `artifacts/psd-fidelity.md`: 276/300 parsed, 43.3 % under threshold (target ≥ 90 % in Phase 2) |
| PSD write, RAW | ❌ | Phase 3 |
| Mac `.comp` read | ✅ | `tests/unit/compPackage.test.ts`, `tests/e2e/workspace.spec.ts` |
| Mac `.comp` write | ✅ (removed from the menu, E2) | writer code still present, used by reader tests; removal proposed in the Phase-1 cleanup (needs frozen fixtures) |

## Architecture (section 4)

| Item | Status | Evidence |
|---|---|---|
| A1 Tauri shell + WebView matrix | 🔬 | `artifacts/tauri-webview-matrix.md` (see there) |
| A5 CanvasKit | 🔬 all abort criteria passed | `artifacts/canvaskit-check.md` |
| A7 PSD corpus + oracle | 🔬 baseline | `artifacts/psd-fidelity.md`, `scripts/fetch-psd-corpus.sh` |
| A9 core-task benchmarks | 🟡 Phase 1: 2 green / 18 red (task 20 crash recovery now green), each red task at its first missing capability; user test with real Photoshop users collected later (owner decision) | `tests/benchmarks/`, `artifacts/benchmarks.md` |
| A2 model v2 + format v2 + migration | ✅ strict discriminated layer union and typed adjustments in the engine; legacy shapes only at the v1/.comp/PSD readers | `tests/unit/model-v2.test.ts`, `tests/unit/model-compat.test.ts`, `tests/unit/format-v2.test.ts` |
| A3 pixel formats, float pipeline | ✅ rgba16 rasters, float compositing on GPU and CPU; ICC for 16-bit sources still at 8-bit precision | `tests/e2e/banding.spec.ts` (Chromium, Firefox, WebKit; incl. semi-transparent 16-bit), `tests/unit/raster16.test.ts` |
| A8 blend modes | ✅ | see 6.1 |
| A4 swap + journal | 🟡 residency, swapping, LOD navigation and granular journal exist on `p1-a4b` but lose brush strokes (3 e2e regressions in all browsers) and the 200-MP run is unproven → lane A4c; not merged | `tests/unit/storage.test.ts`, `tests/e2e/journal.spec.ts` (Chromium) |
| A6 WebKitGTK / native compute | ✅ measured and decided: dirty-region brush preview adopted (Chromium p95 12.9 → 5.7 ms, WebKitGTK 32–39 → 25–35 ms), forced SHM and native JPEG not adopted (M10); WebKitGTK brush Pro budget still open | `artifacts/a6-spike.md`, `artifacts/a6b-webkit.md`, `tests/webview/a6b-brush.spec.ts` |
| Windows WebView2 UI (menus, shortcuts, no browser accelerators) | ✅ | real app driven over CDP: all checks pass (`artifacts/tauri-webview-matrix.md`) |
| Offline WebView2 (M8) | ✅ | hardened Windows build: 0 connections in 5 min (`artifacts/tauri-webview-matrix.md`) |
| A0 engine/UI/host separation | ✅ engine boundary test, headless engine test, versioned host capabilities (browser + Tauri; Windows fonts/ICC/single instance verified), Pro/Lite profiles | `tests/unit/engine-boundary.test.ts`, `tests/unit/hosts.test.ts`, `tests/unit/profiles.test.ts`, `artifacts/a0-hosts.md` |
