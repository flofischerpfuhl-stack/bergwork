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
per-layer import notice when enabled. The layer-effects master switch, per-effect `present` and `enabled`
flags, and layer visibility are honoured independently.

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
- PRODUCT-PLAN 6.7 requests a rasterised fallback for inner shadow, inner glow, bevel/emboss, satin and
  pattern overlay. PSD layer channels do not contain those rendered pixels, so that fallback cannot be
  recovered from the PSD. This implementation reports every enabled unsupported effect as `not-rendered`
  instead of silently dropping it; this is an explicit deviation from 6.7.

## Pixel, persistence and command tests

`tests/unit/effects.test.ts` contains fourteen tests covering hand-computed drop-shadow/global-light/
knockout pixels, all stroke positions, coverage-based antialiasing and both fill types, outer-glow
contour, colour/gradient overlays, Fill Opacity and enlarged bounds, undo/live drag/copy/paste/clear/
global light, complete format-v2 round-trip, generated PSD live-effect import, and separate generated
PSD cases for the master switch, `enabled=false`, `present=false`, and a hidden layer.

`tests/e2e/effects.spec.ts` renders all five effect kinds with masks, effect blend modes, Fill Opacity and
layer opacity through WebGL and the independent CPU compositor. Maximum GPU/CPU delta was 1 byte and no
channel exceeded 1/255.

`tests/e2e/effects-performance.spec.ts` measures a 4096² layer with drop-shadow size 50, stroke 10 and
outer-glow size 30 after the first frame. On ANGLE/OpenGL, Intel HD Graphics 630: median 3.4 ms, p95
9.1 ms (target ≤16 ms, 60 measured frames).

## PSD oracle measurement

Method: the same pinned psd-tools corpus and premultiplied-RGBA mean/p99/max calculation documented in
`artifacts/psd-fidelity.md`. “Before” is the committed baseline; “after” renders the imported live passes.

| File | Before mean / p99 / max | After mean / p99 / max |
|---|---:|---:|
| effects/antialiased-stroke-edge.psd | 13.020 / 220 / 220 | 0.663 / 31 / 104 |
| effects/center-stroke-sizes.psd | 15.505 / 255 / 255 | 0.026 / 0 / 28 |
| effects/double-stroke-effects.psd | 18.721 / 255 / 255 | 0.002 / 0 / 1 |
| effects/effects-enabled.psd | 0.000 / 0 / 0 | 14.500 / 49 / 49 |
| effects/feathered-stroke.psd | 21.570 / 215 / 220 | 1.980 / 48 / 89 |
| effects/group-clips-child-stroke.psd | 25.826 / 255 / 255 | 0.079 / 0 / 19 |
| effects/group-stroke-off-canvas.psd | 18.616 / 255 / 255 | 18.616 / 255 / 255 |
| effects/inset-stroke-sizes.psd | 11.068 / 255 / 255 | 0.000 / 0 / 0 |
| effects/outside-stroke.psd | 27.012 / 255 / 255 | 0.117 / 0 / 19 |
| effects/shape-fx.psd | 35.104 / 140 / 140 | 35.104 / 140 / 140 |
| effects/shape-fx2.psd | 47.410 / 255 / 255 | 2.141 / 28 / 38 |
| effects/stroke-composite.psd | 16.102 / 255 / 255 | 15.394 / 255 / 255 |
| effects/stroke-effect-transparent-shape.psd | 30.331 / 153 / 153 | 0.000 / 0 / 0 |
| effects/stroke-effects.psd | 28.481 / 255 / 255 | 20.142 / 255 / 255 |
| effects/stroke-without-vector-mask.psd | 0.000 / 0 / 0 | 0.000 / 0 / 0 |
| layer_effects.psd | 80.969 / 146 / 191 | 6.790 / 103 / 133 |

The original stroke importer divided ag-psd's ratio-valued metadata by 100, turning 3 px strokes into
0.03 px strokes. It also treated normalized gradient stops as 0...4096 values and ratio-valued gradient
scale as percent. Correcting those units, and locating stroke boundaries from fractional alpha coverage,
produces the large stroke gains above. Temporary expected/actual/amplified-difference images were rendered
for `antialiased-stroke-edge.psd`, `shape-fx2.psd`, and `stroke-composite.psd` to verify that the changed
pixels follow the intended stroke or gradient rather than unrelated document content. `shape-fx2.psd`
improves 47.410→2.141; `stroke-composite.psd` improves 16.102→15.394, with its remaining error concentrated
in vector/clipped shape composition that predates live effects.

Descriptor inspection also ruled out a `vstk`-only import problem: the size/alignment fixtures contain
ordinary `lfx2`/`lmfx` stroke effects over cached raster/shape alpha. `shape-fx2.psd` combines a live
gradient overlay on one cached shape with an inset effect stroke on another. `stroke-composite.psd`
combines already-baked vector strokes (`vstk`) with separate live overlay/stroke descriptors; only those
separate descriptors are added by this importer, so the vector stroke is not doubled.

The effects-folder aggregate mean improves from 20.584 to 7.251: 11 files improve, 3 are unchanged, and
only `effects-enabled.psd` differs from its embedded composite. That file's descriptor has one live,
present, enabled colour overlay and the other per-effect/master switches off. The pinned psd-tools source,
`tests/psd_tools/api/test_layers.py::test_has_effects`, explicitly states that Layer 1 draws the overlay;
its independent forced compositor produces `[254,245,206,255]`, while this engine produces
`[255,246,206,255]` (mean 0.5, p99/max 1). The fixture's embedded composite is stale white and is therefore
not a valid visual oracle for this flag case. Suppressing the enabled effect to retain the old 0.000 metric
would contradict both its descriptor and the pinned reference implementation.

## Verification

- `npx tsc --noEmit -p .`: clean (no output).
- `npx vitest run tests/unit --maxWorkers=1`: 54 files passed; 435 tests passed. The default-concurrency
  run passed 434 tests but its unrelated 4000×3000 TIFF benchmark crossed its 30 s wall timeout under
  heavy shared-host contention; the same TIFF file passed 17/17 alone before the bounded full run.
- Chromium: 69 passed, 1 pre-existing conditional skip, 0 failed (22.2 min on a contended shared host).
- Effect performance (`perf-gpu`): 1 passed (29.2 s), p95 9.1 ms.
