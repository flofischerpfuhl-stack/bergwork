# CanvasKit integration check (A5)

Date: 2026-09-24  
CanvasKit: `canvaskit-wasm` 0.42.0 (BSD-3-Clause)  
Reference machine: Intel Core i7-7820HQ, 4 cores / 8 threads, Linux 6.8; the
CanvasKit surfaces in this check are CPU surfaces and do not use the Intel HD
630 GPU.

## Decision

**Proceed with CanvasKit. No abort criterion failed, so the harfbuzzjs + custom
rasterizer fallback was not measured.** The standard CanvasKit build is the
right build for Fernwork Bildeditor: it contains SkParagraph/HarfBuzz, PathOps,
gradients, and CPU raster surfaces without the extra Skottie code in the
`full` build.

## Abort criteria

| Criterion | Result | Measurement |
|---|---|---|
| Cross-browser raster identity, tolerance <= 1/255/channel | **PASS** | Chromium, Firefox, and WebKit produced the exact same 960x680 RGBA8 bytes: SHA-256 `1349069eba083c0c4618488b7dd7ee560ed1253e4948988cfc5818acc5e3977e`. Maximum channel delta is therefore **0/255**. All three PNGs also have SHA-256 `574d02814ec4fd4b9d6bc500d4c254e752af50fd685de587b8c7159c5fd73dae`. |
| Lazy payload <= 4 MiB gzip | **PASS** | Selected standard build: **2,998,127 bytes gzip** (7,438,222 raw). `full`: 3,352,465 bytes gzip (8,366,618 raw), so it also fits but adds features A5 does not need. CanvasKit was absent from resource timing before `loadTextEngine()` in all browsers. |
| Layout + rasterize 500 characters <= 16 ms p95 over 50 runs | **PASS** | Chromium **9.9 ms p95** (6.5 median, 10.7 max); WebKit **9.0 ms p95** (8 median, 10 max). Firefox, recorded in addition, was 8 ms p95. Five untimed warm-up runs preceded each set. The benchmark includes paragraph construction, HarfBuzz shaping/layout, CPU-surface rasterization, RGBA readback, and conversion to immutable 256 px `Raster` tiles. |
| Quality >= browser text at 12/16/48 px | **PASS (visual assessment)** | The side-by-side plates show intact kerning and `fi` ligatures, smooth diagonals/curves, and no missing glyphs or visible stair-stepping. CanvasKit and Canvas2D differ slightly in grayscale antialiasing/hinting, especially at 12 px, but CanvasKit is not visibly worse. Unlike Canvas2D, the CanvasKit half is identical across hosts. See `artifacts/canvaskit/quality-{chromium,firefox,webkit}.png`. |

The integration sheet covers a wrapped paragraph, Latin kerning/ligatures,
German umlauts and sharp s, Arabic RTL shaping, Devanagari conjuncts, Noto Sans
`wdth`/`wght` variable axes, PathOps union/difference, a linear gradient, and a
dashed round-join/round-cap stroke. `Paragraph.unresolvedCodepoints()` was empty
in all three browsers.

### Transfer-size caveat

The 4 MiB requirement explicitly specifies gzip. The Vite development server
does not compress these responses: the observed development transfer was
7,868,186 bytes (7,317,345 WASM + 550,386 optimized JS + 455 URL wrapper).
Production hosting must enable gzip or Brotli for `.wasm` and `.js`; otherwise
the on-wire payload fails even though the gzip artifact passes. The npm package
does not ship a supported build slimmer than its standard build. Going smaller
would require maintaining a custom Skia/CanvasKit build and is not justified by
this measurement.

## Implementation and API sketch

Files:

- `src/text/index.ts` is the small eager facade. It dynamically imports
  `src/text/engine.ts`, so CanvasKit is not evaluated or fetched until requested.
- `src/text/engine.ts` owns the CanvasKit instance, font provider, paragraph
  allocations, CPU surfaces, PathOps, and straight-alpha RGBA8 readback.
- `src/text/types.ts` is the host-independent API contract.
- `src/text/checkSheet.ts` is the Phase-0 acceptance/benchmark sheet.

Primary exported API:

```ts
loadTextEngine(options?: LoadTextEngineOptions): Promise<TextEngine>

TextEngine.registerFont(registration: FontRegistration): RegisteredFont
TextEngine.layoutParagraph(request: ParagraphRequest): ParagraphLayout
TextEngine.rasterizeParagraph(layout: ParagraphLayout, padding?: number): RasterizedOutput
TextEngine.combinePaths(firstSvg: string, secondSvg: string, operation: PathOperation): string
TextEngine.rasterizePath(request: PathRasterRequest): RasterizedOutput
TextEngine.memoryUsage(): TextEngineMemory
TextEngine.dispose(): void
```

`RasterizedOutput.raster` is the existing immutable, 256 px tiled, straight-alpha
RGBA8 `Raster`, so it can become a layer raster without a second format adapter.
`ParagraphLayout` exposes line count, baselines, longest line, truncation, and
unresolved code points and must be disposed. Vector boolean operations return
portable SVG path data; solid/gradient fill and dashed stroke requests rasterize
through the same CPU backend.

Fonts are registered from caller-supplied bytes rather than accessed through
DOM font APIs. The bundled test/fallback families are local OFL assets:
Noto Sans, Noto Sans Arabic, and Noto Sans Devanagari. No runtime network call is
made; Vite emits CanvasKit locally and the font helper fetches same-origin files.

## Memory and worker compatibility

- CanvasKit's observed WASM linear heap after the complete sheet was
  **134,217,728 bytes (128 MiB)**.
- Registered font source size was **3,535,716 bytes** for three variable fonts.
  The registry stores only metadata in JS; CanvasKit owns the registered font
  data.
- A 960x680 RGBA sheet is 2,611,200 bytes per contiguous copy. Rasterization
  temporarily has the WASM surface/readback and the tiled JS raster live at the
  same time.
- A real module Worker loaded CanvasKit, registered a font, shaped and
  rasterized text without `window`, `document`, DOM canvas, or OffscreenCanvas.
  Its pixel SHA-256 exactly matched the main thread:
  `96042aa8f83ff9a5bb8328489cb59fbba619f69344ef7e9713f18a6acdb79d9f`.
- Each simultaneous worker has its own 128 MiB WASM heap. Phase 2 should use a
  single long-lived text worker rather than one engine per job.

## Sources, licences, and upstream relationship

This is new PRODUCT-PLAN A5/E4 work; no Swift/C implementation or upstream test
was ported. The behavior exercised here comes from CanvasKit's SkParagraph,
HarfBuzz, Skia CPU rasterizer, and PathOps. CanvasKit 0.42.0 and its exact npm
integrity, plus the pinned Noto font commits/checksums and OFL text, are recorded
in `THIRD_PARTY_NOTICES.md`.

Necessary shared-file changes outside the declared new-module/test/artifact
paths are limited to `package.json` and `package-lock.json` for the explicitly
allowed pinned dependency. The product-plan-requested font assets were added at
`public/fonts/`.

## Tests and commands

- `tests/unit/canvaskit.test.ts`
  - real SkParagraph shaping and tiled pixel output with kerning, ligatures,
    umlauts, and variable axes;
  - PathOps union/difference plus gradient and dashed-stroke pixels;
  - memory reporting and disposed-layout safety.
- `tests/e2e/canvaskit.spec.ts`, executed as the Chromium, Firefox, and WebKit
  projects, asserts the fixed sheet hash, no unresolved code points, lazy load,
  payload budget, 50 benchmark samples, and worker/main pixel identity. It also
  writes the sheet, quality plates, and raw JSON measurements.

Recorded matrix command:

```text
PLAYWRIGHT_BROWSERS_PATH=/home/oem/.local/share/fernwork-compositor-lab/browser-cache \
E2E_PORT=5371 E2E_ALL_BROWSERS=1 \
npx playwright test tests/e2e/canvaskit.spec.ts

3 passed
```

Final required gates:

```text
npx tsc --noEmit -p .
exit 0 (no diagnostics)

npx vitest run tests/unit
Test Files  37 passed (37)
Tests       350 passed (350)
Duration    33.31s
```

`npx vite build` also completed successfully. Its existing browser-external and
large-chunk warnings are unrelated to this isolated spike; because Phase 0 does
not wire the text tool into the app, the CanvasKit lazy chunk is exercised by
the E2E dynamic import rather than included in the main production graph yet.

## Deviations and open issues

- CanvasKit's JS bindings expose shaped glyph IDs/positions but not glyph
  outlines. This spike therefore provides paragraph-to-tiled-raster output and
  SVG path output for vector PathOps, but not text-to-outline conversion. If
  Phase 2 requires editable text outlines, it needs an additional Skia binding
  or a small WASM bridge.
- The CPU path is intentionally used for deterministic pixels. A WebGL surface
  was not tested and must not be substituted for the cross-host reference path.
- The visual-quality verdict is an engineering visual inspection, not a
  perceptual user study. Keep the committed plates as regression references.
- System-font enumeration (`FontHost` / Local Font Access), font persistence,
  rich run editing, caret/hit testing, text layers, and document serialization
  are Phase-2 work and are not implemented here.
- Ensure production `.wasm`/`.js` responses are compressed and cacheable before
  treating the lazy-load budget as a deployment gate.
