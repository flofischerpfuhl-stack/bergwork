# Roadmap status (PRODUCT-PLAN.md, section 6 feature kit)

Status: ✅ done · 🟡 partial · ❌ missing · 🔬 Phase-0 spike measured (not a product feature yet).

Each row names its evidence: a test, a measurement, or a screenshot path. "Green" counts only on the integration
branch.

Last update: 2026-09-25, end of Phase 2 (PSD 90 % and some performance items open).

## 6.1 Document, layers, view

| Function | Status | Evidence |
|---|---|---|
| Tabs, New, Open, Save, Recovery | ✅ | `tests/e2e/workspace.spec.ts`, `tests/e2e/recovery.spec.ts` |
| Save/Export chooses the file before encoding (B1) | ✅ | `tests/e2e/large-save.spec.ts` (40 MP, user activation checked at the picker) |
| Export dialog PNG/JPEG/WebP/AVIF/TIFF | ✅ one Export As pipeline, size preview, metadata choice | `tests/e2e/export-dialog.spec.ts`, `tests/e2e/export-artboards.spec.ts` (all formats decoded in Chromium, Firefox, WebKit) |
| Export per artboard/layer, @1x/@2x/@3x | ✅ | `tests/e2e/export-artboards.spec.ts`, `artifacts/export-artboards.md`; 46-MP PNG budget (Lite ≤ 8 s) not yet measured on an idle machine |
| Layers, groups, masks, clipping masks, opacity | ✅ | `tests/e2e/editor-workflows.spec.ts`, `tests/unit/upstream-history-layers.test.ts` |
| Fill opacity, locks, colour labels, layer-panel search | ✅ | `tests/unit/locks.test.ts`, `tests/unit/fill-opacity.test.ts` (incl. Photoshop's eight special fill modes, GPU = CPU within 1/255), `tests/unit/layer-search.test.ts`, `tests/e2e/layer-panel-locks.spec.ts`; PSD import of all three (`artifacts/locks-fill.md`) |
| All 27 blend modes | ✅ 26/27 exact, dissolve by rule | Photoshop oracle: all 26 deterministic modes pass; dissolve uses Photoshop's binary-alpha rule, which a PSD composite cannot pin pixel-exact (`artifacts/psd-fidelity.md`, `tests/unit/blend.test.ts`); blend-modes folder 93.8 % |
| Artboards | ✅ artboard tool with Social/Web/Print presets; backgrounds drawn in export (canvas shows frame + colour dot) | `tests/e2e/artboard-tool.spec.ts` |
| Guides, rulers, grid, smart guides, snapping | 🟡 rulers, guides (create from ruler, move, delete, numeric, lock, clear, saved in `.fwimg`), snapping to guides/centre/edges; grid and smart guides missing | `tests/e2e/guides.spec.ts`, `tests/unit/align-guides.test.ts` |
| Align/distribute, numeric transform | ✅ | `tests/unit/align-guides.test.ts` (6 edges, 4 distribute modes), `tests/e2e/guides.spec.ts` |
| History panel (saved with the project) | ✅ | `tests/e2e/history-panel.spec.ts` (jump back/forward, saved with the project and undo continues after reopening; option to not save it) |
| Embedded/linked content | ✅ Place/Replace/Edit Contents, SVG; PDF only via host capability (Fernwork PDFium not release-approved) | `tests/e2e/embedded.spec.ts`, `artifacts/embedded.md`; benchmark 4 green |
| Swatches, recent colours, eyedropper anywhere | ✅ colour panel, .aco/.ase, recent colours, screen eyedropper (browser EyeDropper / Tauri host; Windows not yet verified by hand) | `tests/e2e/colour-panel.spec.ts`, `tests/unit/swatch-files.test.ts` |

## 6.2 Selection and masks

| Function | Status | Evidence |
|---|---|---|
| Rectangle/ellipse, lasso/polygon, magic wand, add/subtract, expand/contract | ✅ | `tests/e2e/selection.spec.ts`, `tests/unit/upstream-selection-clipboard.test.ts` |
| Object selection (local model) | ✅ SlimSAM (Apache-2.0), download on user action; one-click IoU 0.99; encoder 14–22 s on single-thread WASM (open) | `tests/e2e/objsel-ui.spec.ts`, `artifacts/object-selection.md`; benchmark 7 green |
| Remove background (U²-Netp + BiRefNet) | ✅ | `tests/e2e/subject.spec.ts`, `artifacts/handoff.md` |
| Refine edge, quick mask, feather, selection from path, colour range | ✅ | `tests/e2e/objsel-ui.spec.ts`, `tests/e2e/vector-tools.spec.ts` (selection from path) |

## 6.3 Painting and retouching

| Function | Status | Evidence |
|---|---|---|
| Brush/eraser with pressure; size, hardness, opacity | ✅ | `tests/e2e/gpu-brush.spec.ts`; brush p95 3–11 ms (`artifacts/performance/browser-perf-gpu.json`) |
| Spot healing, clone stamp, content-aware fill, smudge | ✅ | `tests/e2e/retouch.spec.ts`; benchmark 8 green |
| Brush presets, `.abr` | ❌ | Phase 3 |
| Dodge/burn/sponge as a brush mode | ✅ | `tests/e2e/adjust-p2-ui.spec.ts`; benchmark 6 green |
| Liquify light, generative fill | ❌ | Phase 3 |

## 6.4 Colour, adjustments, filters

| Function | Status | Evidence |
|---|---|---|
| Curves, levels, hue/saturation, exposure, gradient map, grain | ✅ | `tests/e2e/adjustments.spec.ts`, `tests/unit/upstream-adjustments.test.ts` |
| Gaussian, motion blur, noise, lens correction | ✅ | `tests/unit/filter-blur.test.ts`; integrator check against ImageMagick (mean 0.50, max 1) |
| Basic adjustment layer, colour lookup, colour panel, sharpen | ✅ | `tests/e2e/adjust-p2-ui.spec.ts`, `tests/unit/adjust-p2.test.ts`, `artifacts/adjustments-p2.md` |
| Live filter stack | ✅ smart filters with rows in the Layers panel, reorder, bake | `tests/e2e/adjust-p2-ui.spec.ts` |

## 6.5 Transform

| Function | Status | Evidence |
|---|---|---|
| Free transform, flip, distort, crop, image/canvas size | ✅ | `tests/unit/transform*.test.ts`, `tests/e2e/editor-workflows.spec.ts` |
| Non-destructive crop | 🟡 model v2 field present, no tool yet | `src/core/model/types.ts` (`crop`), Phase 2 UI |
| Mesh warp, perspective, straighten | ❌ | Phase 3; benchmark 16 red |

## 6.6 Text and vector

| Function | Status | Evidence |
|---|---|---|
| Text engine (CanvasKit) | ✅ identical pixels in all three browsers; 500-char paragraph p95 15.6 ms | `artifacts/text-engine.md` |
| Point/area text, typography, OpenType | ✅ (baseline shift stored, not drawn; optical kerning = metric) | `tests/e2e/text-tool.spec.ts`; benchmarks 2/3 green |
| Pen tool, booleans, vector masks | ✅ shapes with radii, polygon, star, line with arrowheads, pen, direct selection | `tests/e2e/vector-tools.spec.ts`; benchmark 10 green |

## 6.7 Layer styles

| Function | Status | Evidence |
|---|---|---|
| Drop shadow, stroke, outer glow, overlays | ✅ | `tests/e2e/layer-style-ui.spec.ts`, `tests/e2e/effects.spec.ts` (GPU = CPU ≤ 1/255); benchmarks 1/3/19 green |

## 6.8 Files

| Function | Status | Evidence |
|---|---|---|
| PNG/JPEG/TIFF import with ICC → sRGB | ✅ | `tests/unit/icc.test.ts`, `tests/unit/jpeg.test.ts`, `tests/e2e/own-files.spec.ts` (integrator files) |
| HEIC (browser / host codec / opt-in LGPL) | ✅ | `tests/e2e/heic.spec.ts`; camera HEIC mean Δ 0.38 |
| WebP/AVIF/GIF import | ✅ | `tests/unit/codec-formats.test.ts`, `tests/e2e/own-files.spec.ts` (integrator files android.webp, adobe.webp, example.avif, pal.gif; Chromium, Firefox, WebKit) |
| PSD read | 🟡 native fidelity 82.7 % (248/300, M14); target = all fixable deviations (ceiling 267/300 = 89.0 %, M15); 90 % is a later TODO needing an owner-approved text/effect tolerance (`artifacts/psd-target.md`) | `artifacts/psd-fidelity.md`, `tests/e2e/psd-open.spec.ts` |
| PSD write, RAW | ❌ | Phase 3 |
| Mac `.comp` read | ✅ | `tests/unit/compPackage.test.ts`, `tests/e2e/workspace.spec.ts` |
| Mac `.comp` write | ✅ (removed from the menu, E2) | writer code still present, used by reader tests; removal proposed in the Phase-1 cleanup (needs frozen fixtures) |

## Architecture (section 4)

| Item | Status | Evidence |
|---|---|---|
| A1 Tauri shell + WebView matrix | ✅ Linux + Windows builds; internal only until licence advice (M13) | `artifacts/tauri-webview-matrix.md` |
| A5 CanvasKit | ✅ in product (text + vector) | `artifacts/text-engine.md`, `artifacts/vector-engine.md` |
| A7 PSD corpus + oracle | ✅ harness renders through the product CPU path | `artifacts/psd-fidelity.md` |
| A9 core-task benchmarks | 🟡 Phase 2: 13 green / 7 red (all red need Phase-3 items); user test collected later | `artifacts/benchmarks.md` |
| A2 model v2 + format v2 + migration | ✅ strict discriminated layer union and typed adjustments in the engine; legacy shapes only at the v1/.comp/PSD readers | `tests/unit/model-v2.test.ts`, `tests/unit/model-compat.test.ts`, `tests/unit/format-v2.test.ts` |
| A3 pixel formats, float pipeline | ✅ rgba16 rasters, float compositing on GPU and CPU; ICC for 16-bit sources still at 8-bit precision | `tests/e2e/banding.spec.ts` (Chromium, Firefox, WebKit; incl. semi-transparent 16-bit), `tests/unit/raster16.test.ts` |
| A8 blend modes | ✅ | see 6.1 |
| A4 swap + journal | ✅ 200 MP / 20 layers without OOM in Chromium (6.4 GiB) and Linux Tauri (4.3 GiB), streaming save/reopen exact; latency gates at 200 MP open | `artifacts/a4-storage.md`, `artifacts/a4d-memory.md` |
| A6 WebKitGTK / native compute | ✅ measured and decided: dirty-region brush preview adopted (Chromium p95 12.9 → 5.7 ms, WebKitGTK 32–39 → 25–35 ms), forced SHM and native JPEG not adopted (M10); WebKitGTK brush Pro budget still open | `artifacts/a6-spike.md`, `artifacts/a6b-webkit.md`, `tests/webview/a6b-brush.spec.ts` |
| Windows WebView2 UI (menus, shortcuts, no browser accelerators) | ✅ | real app driven over CDP: all checks pass (`artifacts/tauri-webview-matrix.md`) |
| Offline WebView2 (M8) | ✅ | hardened Windows build: 0 connections in 5 min (`artifacts/tauri-webview-matrix.md`) |
| A0 engine/UI/host separation | ✅ engine boundary test, headless engine test, versioned host capabilities (browser + Tauri; Windows fonts/ICC/single instance verified), Pro/Lite profiles | `tests/unit/engine-boundary.test.ts`, `tests/unit/hosts.test.ts`, `tests/unit/profiles.test.ts`, `artifacts/a0-hosts.md` |
