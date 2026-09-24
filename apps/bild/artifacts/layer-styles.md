# Layer styles — Phase 2 engine report

Date: 2026-09-24. Scope: engine only; no UI.

## Implemented

The document model and format-v2 contract now carry schema-versioned live records for drop shadow,
inside/centre/outside stroke (solid or gradient), outer glow, colour overlay and linear gradient overlay.
Drop shadow includes blend mode, opacity, local/global angle, distance, spread, size, linear contour,
zero noise and layer knockout. `CanvasDocument.globalLightAngle` defaults to Photoshop's 120° for old
documents and round-trips in `.fwimg` manifests and saved history snapshots.

`src/core/effects/render.ts` exports:

- `renderEffectPasses(alpha, width, height, effects, options?): readonly EffectPass[]`
- `DEFAULT_GLOBAL_LIGHT_ANGLE`

`src/core/effects/document.ts` exports:

- `documentWithLayerEffects(document, hooks): CanvasDocument`

`src/core/effects/validate.ts` exports:

- `isValidLayerEffect(value): value is LayerEffect`

The renderer derives effects from post-layer-mask alpha and before Fill Opacity. It uses a linear-time,
exact squared Euclidean distance transform for spread, size and stroke geometry. Generated immutable
passes enlarge the source placement and are cached by raster identity, effect parameters, mask identity,
mask placement and transform. Both software and WebGL compositors consume those same passes, so all 27
existing blend modes, folder masks and layer opacity remain on the normal compositor paths. Content and
colour/gradient overlays follow Fill Opacity; shadow, glow and stroke do not. Layer opacity scales every
pass.

`EditorSession` adds undoable `addLayerEffect`, `removeLayerEffect`, `setLayerEffectEnabled`,
`reorderLayerEffect`, `setLayerEffectParameters`, `copyLayerStyle`, `pasteLayerStyle`, `clearLayerStyle`
and `setGlobalLightAngle`. `beginLayerEffectEdit`/`finishLayerEffectEdit` and
`beginGlobalLightEdit`/`finishGlobalLightEdit` coalesce live drags to one undo entry.

PSD import maps ag-psd drop shadows, strokes, outer glows, solid fills and linear gradient overlays to
live effects, including document global angle. Pattern strokes and non-linear/noise gradients produce a
per-layer import notice. Inner shadow/glow, bevel/emboss, satin and pattern overlay also produce explicit
not-rendered notices.

## Reference and deviations

Pinned upstream commit `a19db90` has no editable layer-style model or renderer to port. Existing layer
placement, mask, blending and history semantics remain those ported from `LayerTransform.swift`,
`LiveMaskRenderer`, `LayerAppearance.swift` and `EditorSession.swift`; the new style behavior follows
PRODUCT-PLAN 6.7 and the PSD descriptors exposed by ag-psd.

Known deviations from Photoshop:

- Feathering uses a deterministic linear distance contour, not Photoshop's proprietary blur kernel.
  Only the required linear contour and noise 0 are represented.
- Effects are cached CPU-generated raster passes uploaded to WebGL, rather than a native WebGL distance
  transform. Cached GPU frames meet the target, but first-frame generation is CPU work.
- Effects on groups are preserved but not rendered because a group has no isolated raster surface in the
  current pass-through group compositor. Complex clipping-stack ordering can also differ from Photoshop.
- Non-linear/noise PSD gradients are approximated as linear. HSB/Lab effect colours are not converted;
  ordinary RGB/float-RGB/gray/CMYK effect colours are handled.
- The required rasterised fallback for inner shadow, inner glow, bevel/emboss, satin and pattern overlay
  is not implemented. Import reports each one instead of silently dropping it.

## Pixel, persistence and command tests

`tests/unit/effects.test.ts` contains nine tests covering hand-computed drop-shadow/global-light/
knockout pixels, all stroke positions and both fill types, outer-glow contour, colour/gradient overlays,
Fill Opacity and enlarged bounds, undo/live drag/copy/paste/clear/global light, complete format-v2
round-trip, and generated PSD live-effect import.

`tests/e2e/effects.spec.ts` renders all five effect kinds with masks, effect blend modes, Fill Opacity and
layer opacity through WebGL and the independent CPU compositor. Maximum GPU/CPU delta was 1 byte and no
channel exceeded 1/255.

`tests/e2e/effects-performance.spec.ts` measures a 4096² layer with drop-shadow size 50, stroke 10 and
outer-glow size 30 after the first frame. On ANGLE/OpenGL, Intel HD Graphics 630: median 2.3 ms, p95
7.4 ms (target ≤16 ms, 60 measured frames).

## PSD oracle measurement

Method: the same pinned psd-tools corpus and premultiplied-RGBA mean/p99/max calculation documented in
`artifacts/psd-fidelity.md`. “Before” is the committed baseline; “after” renders the imported live passes.

| File | Before mean / p99 / max | After mean / p99 / max |
|---|---:|---:|
| effects/antialiased-stroke-edge.psd | 13.020 / 220 / 220 | 12.893 / 215 / 220 |
| effects/center-stroke-sizes.psd | 15.505 / 255 / 255 | 15.351 / 255 / 255 |
| effects/double-stroke-effects.psd | 18.721 / 255 / 255 | 18.359 / 250 / 250 |
| effects/effects-enabled.psd | 0.000 / 0 / 0 | 14.500 / 49 / 49 |
| effects/feathered-stroke.psd | 21.570 / 215 / 220 | 21.422 / 215 / 220 |
| effects/group-clips-child-stroke.psd | 25.826 / 255 / 255 | 25.578 / 255 / 255 |
| effects/group-stroke-off-canvas.psd | 18.616 / 255 / 255 | 18.616 / 255 / 255 |
| effects/inset-stroke-sizes.psd | 11.068 / 255 / 255 | 10.915 / 255 / 255 |
| effects/outside-stroke.psd | 27.012 / 255 / 255 | 26.762 / 255 / 255 |
| effects/shape-fx.psd | 35.104 / 140 / 140 | 35.104 / 140 / 140 |
| effects/shape-fx2.psd | 47.410 / 255 / 255 | 50.257 / 255 / 255 |
| effects/stroke-composite.psd | 16.102 / 255 / 255 | 17.685 / 255 / 255 |
| effects/stroke-effect-transparent-shape.psd | 30.331 / 153 / 153 | 30.331 / 153 / 153 |
| effects/stroke-effects.psd | 28.481 / 255 / 255 | 28.354 / 255 / 255 |
| effects/stroke-without-vector-mask.psd | 0.000 / 0 / 0 | 0.000 / 0 / 0 |
| layer_effects.psd | 80.969 / 146 / 191 | 7.447 / 124 / 133 |

The general `layer_effects.psd` oracle improves substantially. The specialized effects-folder aggregate
mean regresses from 20.584 to 21.742 because `effects-enabled.psd`, `shape-fx2.psd` and
`stroke-composite.psd` depend on advanced blending/vector/group behavior not represented by the current
pass-through model. Therefore the requested corpus-wide fidelity improvement is not met yet; 9 files
improve, 4 are unchanged and 3 regress.

## Verification

- `npx tsc --noEmit -p .`: clean (no output).
- `npx vitest run tests/unit`: 54 files passed; 430 tests passed.
- Chromium: 69 passed, 1 pre-existing conditional skip, 0 failed (15.5 min).
- Effect performance (`perf-gpu`): 1 passed (18.3 s), p95 7.4 ms.
