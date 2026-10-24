# Remaining editable layer styles — Phase 3

Date: 2026-09-25. Scope: inner shadow, inner glow, bevel/emboss, satin and pattern overlay in the
shared live-effect engine and Layer Style dialog.

## Implemented model and API

`LayerEffect` and format-v2 `EffectRecordV2` now contain schema-versioned records for:

- `innerShadow`: blend/colour/opacity, local or global-light angle, distance, choke, size and linear contour.
- `innerGlow`: blend/colour/opacity, centre or edge source, choke, size and linear contour.
- `bevelEmboss`: inner/outer bevel, emboss and pillow emboss; smooth/chisel-hard/chisel-soft technique;
  depth, up/down direction, size, soften, local/global angle, altitude, independent highlight/shadow
  blend modes, colours and opacities, and linear gloss contour.
- `satin`: colour, blend, opacity, angle, distance, size, invert and linear contour.
- `patternOverlay`: document-resource ID and dimensions, blend/opacity, scale, angle, link-with-layer and phase.

Pattern resources use the existing `DocumentResource`/format-v2 asset path with role `pattern` and raw RGBA8
bytes (`application/x-fernwork-rgba8`). The dialog supplies three small procedural resources (checker, dots and
diagonal) and accepts an image file through the existing colour-managed image decoder. Cancel restores the original
resource set; OK removes newly introduced unused resources. Copy/paste layer style now carries referenced pattern
resources across documents and remaps the ID if the target already contains different bytes under that ID.

`renderEffectPasses` remains the shared CPU pass generator consumed by both compositors. `EffectPass.stackOrder`
records the fixed Photoshop-style kind stack. `documentWithLayerEffects` resolves pattern resources and merges their
passes into that stack. Its cache key includes immutable pattern-byte identity; unchanged document/raster/resource
identities therefore reuse the expanded document and generated rasters. `renderPsdInnerEffectPasses` remains only as
a deprecated compatibility wrapper that constructs live records and delegates to `renderEffectPasses`; PSD import
does not use a second renderer.

## Rendering and import decisions

Inner effects use the same exact squared Euclidean distance field as existing strokes/glows, clipped by source alpha.
A one-pixel transparent border is included so tightly cropped opaque layer bounds still have an edge. Bevel/emboss
uses the signed-distance normal and light vector to make independent highlight and shadow passes; technique changes
the edge profile. Satin compares two oppositely shifted linear edge ramps. Pattern overlay uses bilinear wrapping in
document coordinates, with optional layer-origin anchoring and rotation.

PSD inner shadow/glow, bevel, satin and pattern-overlay descriptors now map directly to live `LayerEffect` records.
PSD pattern pixels are copied once into a document pattern resource and shared by resource ID. `present`, `enabled`,
the list-wide master switch and layer visibility remain independent. The disabled-pattern regression is covered: a
disabled pattern is retained but produces no pass even when another style on that layer is enabled.

The repository still has no PSD writer, so writer mapping was not added. A future writer should map these live records
to ag-psd `innerShadow`, `innerGlow`, `bevel`, `satin` and `patternOverlay`, and emit referenced document patterns in
the PSD pattern table.

Pinned upstream `a19db90` has no editable layer-style model or formulas to port. The source-alpha, placement, mask,
blend and history behavior continues through the upstream-derived compositor/session paths; these five style
renderers are new product work required by PRODUCT-PLAN 6.7.

## UI

The Layer Style dialog and Layer/fx menus list all ten styles in Photoshop order. The five new panels expose the
requested German terminology: Schatten nach innen, Schein nach innen, Abgeflachte Kante und Relief, Glanz and
Musterüberlagerung; the bevel style/technique/direction/light controls and inner-glow source/choke controls use the
specified labels. Image-pattern import, procedural presets, scale, angle and link-with-layer all preview live in the
same coalesced Layer Style edit.

## Fidelity and performance

The final 300-file psd-tools corpus run parsed and rendered 300/300 and passed 209/300 (69.7%), versus the committed
208/300 (69.3%). No previously passing file became failing; `clipping-mask2.psd` became passing. The effects folder
remained 11/15 passing. Style-heavy files improved: `layer_effects.psd` mean/p99 5.413/69 to 4.845/56,
`layer_comps.psd` 10.856/67 to 8.807/67, `layer_params.psd` 7.209/137 to 6.637/130, and
`effects/stroke-composite.psd` 15.394/255 to 12.004/255. `patterns.psd` remained 4.277/95 and
`transparency/fill-opacity.psd` remained 1.000/27. Start load average was 9.92/13.48/18.70; the run took 232.44 s.
The generated shared `artifacts/psd-fidelity.md` was restored rather than committed.

The final 4096² perf-gpu specification measured median 0.9 ms and p95 1.9 ms with exactly 0 effect regenerations and
0 texture uploads over 60 unchanged frames (start load 12.86/11.72/15.53). The renderer was llvmpipe under Xvfb,
so this is a cache-correctness/software timing observation, not a real-GPU measurement; a real-GPU measurement was
not possible under the required invisible display.

## Verification

- `npx tsc --noEmit -p .`: clean (no output), before and after merging integration.
- Whole unit suite (`--maxWorkers=2`): 86 files passed, 737 tests passed in 72.89 s; start load
  12.63/11.26/15.71. This includes 3 focused files / 37 focused tests for hand-computed pixels, PSD flags/resources
  and format v2.
- PSD fidelity: 2 files passed, 5 tests passed in 232.44 s; metrics above.
- Chromium affected E2E before the integration merge: 6 passed in 1.9 min (GPU/CPU and complete Layer Style dialog
  suite). Final post-merge GPU/CPU rerun: 2 passed in 6.0 s.
- Final post-merge new-panel workflow: Chromium, Firefox and WebKit all passed (3/3 in 56.5 s).
- Final `perf-gpu` effect cache gate: 1 passed in 19.0 s; 0 regenerations/uploads, timing above.

## Known deviations and open work

- Photoshop's proprietary blur/contour kernels are represented by deterministic linear distance profiles; only the
  requested linear contour/gloss contour is modelled. Bevel soften broadens/softens that profile rather than matching
  Photoshop's unknown kernel exactly, and satin uses the documented deterministic two-ramp approximation.
- Bevel texture/contour sub-effects, pattern strokes, noise/jitter and non-linear contours are outside this task.
- Effects on pass-through groups retain the pre-existing limitation: there is no isolated group raster from which to
  derive a style. Complex clipping stacks can therefore still differ from Photoshop.
- No PSD writer exists in this branch; the mapping described above remains future work.
- No new dependency or third-party asset was added.
