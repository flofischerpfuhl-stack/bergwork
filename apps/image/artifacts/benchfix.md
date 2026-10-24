# Phase 2 benchmark fixes

This pass fixes the eleven product defects recorded by the Phase 2 core-task benchmarks. Benchmark assertions were not weakened or removed. Task 5 still stops at its existing, deliberate `PSD write` missing-capability marker after the repaired text import checks pass; tasks 11–16 retain their documented missing-capability stops.

## Root causes and fixes

1. **Align/Distribute omitted non-raster layers.** `alignUnits` discarded every layer without `raster`, even when the session had a displayed text, vector, or embedded cache. It now builds units from displayed bounds supplied by `EditorSession`; groups still move as one unit. A unit test aligns a rasterless vector layer and checks the resulting transform.
2. **Single-layer artboard alignment targeted the canvas.** `alignLayers` always chose the document rectangle when no selection existed. It now uses `artboardMembership` and targets the containing artboard for a single unit; multiple units retain union alignment. Movement also preserves the exact fractional offset needed to center odd-size bounds. The benchmark's five-format export and a focused unit test cover this.
3. **Text/vector/embedded effects used cache pixels as document pixels.** Effect distances were applied directly to oversampled derived rasters. `documentWithLayerEffects` derives the cache-to-document resolution, scales stroke/glow/shadow distances, and aligns effect padding to that resolution so mip selection does not erode the result. CPU and GPU consume the same generated passes. A unit test checks a 4x cache and benchmark task 3 checks the visible stroke.
4. **Selection masks used the macOS source polarity.** The upstream `Compositor/Document/LayerMask.swift` command hides an active selection. By binding product decision, normal Add Layer Mask now reveals selected pixels and Alt/Option-click hides them. The Layer menu exposes Reveal/Hide Selection explicitly. Stored/imported masks are unchanged. Unit and Chromium/Firefox/WebKit interaction tests verify both polarities.
5. **Inside stroke depended on a fill pass.** The vector renderer only produced the path coverage used to clip an inside stroke when fill was enabled. It now computes that coverage for inside strokes independently, leaving fill transparent. A CanvasKit pixel test checks the visible interior stroke and transparent center/outside.
6. **Warp quads were stored but ignored after PSD import.** The CPU compositor now inverse-maps document samples through the quad homography; the WebGL compositor passes the same inverse projective matrix to its layer shader and renders the quad's document bounds. Synthetic effect passes inherit the expanded projective quad, export uses the CPU compositor, affine moves/flips carry corners, and Free Transform Distort updates the same `WarpQuad` for embedded layers. New exports are `inverseHomography(corners): (point) => Point`, `inverseHomographyMatrix(corners): Float32Array`, and `distortBounds(corners): Rect`. Unit and three-browser E2E tests compare real CPU/GPU pixels within 1/255.
7. **Fonts were indexed only by family.** Bundled, embedded, local, and system font records now register normalized aliases for family, full name, and PostScript name. `NotoSans-Regular` therefore resolves to the bundled Noto Sans face. A unit test covers the PostScript lookup.
8. **Reduce Noise was limited to a fixed 3x3 filter.** `denoise(raster, luminanceStrength, colourStrength, detailPreservation = 50): Raster` now uses a radius-scaled bilateral filter in luminance/chroma space. Strength controls the blend and detail preservation controls the range kernel; alpha is unchanged. Filter settings, project decoding, and the adjustment UI expose the new detail parameter. A deterministic ±30-level grain test requires at least a 50% sigma reduction while retaining a 90-level edge; benchmark task 17 also passes.
9. **Lite size rejection had no dialog feedback.** New Canvas now validates profile side/pixel limits before submission, disables Create, and explains Lite's 100 MP limit and Pro's 300 MP limit. The controller remains the enforcement boundary. A focused workspace E2E test checks the message and disabled action.
10. **Effects forced all source layers through a half-float target.** This introduced an unnecessary premultiplication/unpremultiplication round trip and changed unrelated translucent source pixels. The GPU compositor now keeps normal RGBA8 source passes exact and uses half-float only for generated effect passes (plus blend modes that genuinely require wide intermediates). The E2E test verifies the source byte is unchanged and checks CPU/GPU effect parity in all three browsers.
11. **PSD point text without an area box used invalid fallback geometry.** The PSD reader now derives the baseline from the text transform and estimates logical width/height from runs, font size, leading, resolution, and line breaks. That yields a valid top-left transform and a shapeable visible layer. Unit tests cover both imported geometry and actual raster visibility.

## Files and API surface

Core behavior changed in `src/core/align.ts`, `session.ts`, `selectionCommands.ts`, `distort.ts`, `composite.ts`, `canvasOps.ts`, `vector/render.ts`, `vector/transform.ts`, `effects/document.ts`, `effects/render.ts`, `filters/*`, `text/fonts.ts`, and `model/types.ts`. GPU projective rendering and precision selection changed in `src/render/gpuCompositor.ts` and `shaders.ts`; PSD/text and project decoding changed in `src/io/psd/reader.ts` and `project.ts`; host font metadata changed in `src/platform/browserHost.ts` and `platform/hosts/types.ts`. The minimal command/UI wiring is in `src/ui/Dialogs.tsx`, `LayersPanel.tsx`, `menus.ts`, `i18n.ts`, and the adjustment control files under `src/app`.

Besides the three homography helpers and expanded `denoise` signature above, existing public entry points retain their signatures. `RenderEffectOptions` gains optional `rasterScale`; denoise filter settings gain `detail`; system font metadata gains optional `fullName`.

## Upstream reference and deviations

The projective math and destructive fallback remain based on upstream `Compositor/Document/Distort.swift` (`homography`, inverse mapping, bounds, and `distortTarget`) and `CompositorTests/DistortTests.swift`. Mask storage/placement continues to follow `Compositor/Document/LayerMask.swift` and its tests. Raster placement and edge sampling follow the existing port of `Compositor/Rendering/LayerRenderer.swift` and `TiledLayerRenderer.swift`.

- Reveal Selection is an intentional product deviation from the macOS command, required for Photoshop muscle memory. It affects command-created masks only, not `.comp` import.
- Browser CanvasKit/WebGL replace Core Graphics/Core Image. The denoiser is a deterministic bilateral implementation because there is no exact portable browser equivalent for the native image-processing APIs.
- PSD point-text geometry is estimated synchronously before CanvasKit shaping becomes available. It honors the PSD transform, run metrics, leading, resolution, and newlines, but exact platform glyph overhang can differ from Photoshop.
- Live projective rendering uses bilinear sampling and the renderer's half-pixel edge ramp. It does not add mesh warp or a new transform-mode UI; those remain separate product capabilities.

## Tests and verification

Focused coverage was added or updated in:

- `tests/unit/align-guides.test.ts`, `effects.test.ts`, `selection.test.ts`, `vector-render.test.ts`, `filters-p2.test.ts`, `distort.test.ts`, `transform-distort.test.ts`, `text.test.ts`, and `adjust-p2.test.ts`.
- `tests/e2e/effects.spec.ts`, `psd-open.spec.ts`, `selection.spec.ts`, and `workspace.spec.ts`.

Verification on the final code:

```text
npx tsc --noEmit -p .
(clean; exit 0)

npx vitest run tests/unit
Test Files  78 passed (78)
Tests       653 passed (653)
```

The complete Chromium benchmark project reported `12 passed, 8 failed (14.8m)`. Seven failures were exactly the documented `missing()` capabilities (tasks 5 and 11–16). Task 20 alone missed its 15-second recovery-save poll after the preceding 5.8-minute artboard scenario; its immediate isolated rerun passed (`1 passed (17.6s)`). Thus the reproducible capability status is **13 green / 7 intentionally red**: tasks 3, 4, 7, 9, 17, and 18 turned green, while task 5 now reaches only PSD write.

The full Chromium E2E run exercised 334 tests and reported `330 passed, 3 skipped, 1 failed (34.9m)`; the sole failure was the old mask-polarity assertion that this task explicitly required changing. After updating that test, the complete Chromium selection spec passed (`6 passed`). The final effects spec passed in Chromium, Firefox, and WebKit (`6 passed`). The other touched Firefox/WebKit specs (PSD open, selection, and New Canvas) passed; one optional PSD corpus case was skipped because its fixture is absent.

## Open issues / not implemented

This fix does not implement the deliberately absent benchmark capabilities: layered PSD write, CMYK/soft-proof workflow, RAW development, non-destructive Camera Raw, batch recipes, typography controls beyond the current text engine, or mesh warp. Projective layer masks remain governed by their existing independent placement model; this task applies the stored `WarpQuad` to embedded/pixel content and its generated effects.
