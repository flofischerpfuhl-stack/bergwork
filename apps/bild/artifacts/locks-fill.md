# P1-LK — layer locks, Fill opacity, colour labels, and layer search

## Implementation

### Model, project format, and PSD import

- `Layer.locks`, `Layer.fillOpacity`, and `Layer.colorLabel` are the authoritative live fields. The legacy
  `Layer.locked` property remains only as a derived compatibility projection of `locks.all`, because existing
  v1-facing core consumers still construct `Partial<Layer>` values. It is never consulted as lock state.
- The v1 `.comp` writer emits `locked: layer.locks.all`; the v1 reader maps `locked` back to `locks.all`.
  Format v2 serializes and restores all four lock flags, Fill opacity, and colour label losslessly.
- The PSD reader imports `opacity` and `fillOpacity` independently, `transparencyProtected` / protection bits,
  and ag-psd's eight supported layer colour labels. Unknown colour values and the unsupported artboard lock are
  reported through the existing import-issue mechanism.
- PSD does not distinguish “Lock All” from all three protection bits being enabled. Such a file is imported as
  `locks.all = true` and the three individual flags false, preserving its effective editability but not that UI
  distinction.

### Exported engine API

- `effectiveLayerLocks(document: CanvasDocument, id: string): LayerLocks`
- `layerLockBlocker(document: CanvasDocument, id: string, kind: LayerEditKind): LayerLockBlocker | null`
- `preserveLayerTransparency(before: Raster, beforeTransform: LayerTransform, after: Raster, afterTransform: LayerTransform): Raster`
- `EditorSession.lockState(id: string): LayerLocks`
- `EditorSession.editBlocker(id: string, kind: LayerEditKind): LayerLockBlocker | null`
- `EditorSession.refuseLayerEdit(id: string, kind: LayerEditKind): boolean`
- `EditorSession.setLayerLocks(ids: Iterable<string>, partial: Partial<LayerLocks>): void`
- `EditorSession.setFillOpacity(ids: Iterable<string>, value: number): void`
- `EditorSession.beginFillOpacityEdit(ids?: Iterable<string>): boolean`
- `EditorSession.finishFillOpacityEdit(): void`
- `EditorSession.setColorLabel(ids: Iterable<string>, label: ColorLabel): void`
- `filterLayers(document: CanvasDocument, query: LayerSearchQuery): LayerSearchResult`

`LayerLockBlocker` contains the stable machine codes `layer-lock-all`, `layer-lock-pixels`, or
`layer-lock-position`, an English fallback message, the edited layer id, and the id of the locking layer/group.
Search returns separate `matchingIds` and `ancestorIds` sets and folds case, combining accents, German umlauts,
and `ß`/`ss` for names.

### Lock behavior

Group locks are inherited by all descendants. Multi-layer commands are atomic: if one requested target is missing
or blocked, no target changes. Lock changes themselves are always allowed, so a fully locked layer or group can be
unlocked.

- Lock Transparency preserves the exact pre-edit alpha byte in document space for painting, fill, gradient,
  retouch/heal, destructive filters/adjustments, and other raster replacements. Newly expanded pixels outside the
  old raster remain transparent. RGB may change only where the old alpha is nonzero.
- Lock Pixels rejects raster and mask edits, clear/fill/invert, brush/eraser, retouch/heal/content fill, destructive
  filters/adjustments, subject removal, merge, and resampling transforms. Translation remains allowed.
- Lock Position rejects move/nudge, free transform, flip, align, distribute, and whole-canvas flips that would move
  the layer.
- Lock All has the Pixels, Position, and Transparency effects and additionally rejects blend mode, opacity, Fill
  opacity, mask enable/link, and live-mask appearance changes. Rename and deletion remain allowed, matching the
  requested Photoshop behavior. Visibility, colour labels, reordering, and changing lock flags remain allowed.

Session commands use one history step with `Set Layer Locks`, `Layer Fill Opacity`, and singular/plural layer-colour
names. The Fill-opacity live-edit API coalesces an arbitrary number of slider updates into one undo step.

### Fill-opacity compositing

CPU and WebGL paths apply ordinary Fill opacity to the layer content before source-over compositing; normal layer
opacity then applies independently, so the ordinary result is their product. Masks remain separate coverage inputs.
The compositor entry point keeps content Fill separate from the effects array, so effects can later be rendered at
normal opacity without Fill scaling.

Photoshop's special Fill kernels are implemented for Color Burn, Linear Burn, Color Dodge, Linear Dodge, Vivid
Light, Linear Light, Hard Mix, and Difference. Their blend kernel changes with Fill instead of merely scaling the
final layer alpha. Integer-calibrated channel formulas are mirrored in TypeScript and GLSL. A browser probe covering
Normal plus all eight modes at opacity 0.73 and Fill 0.41 reported a maximum CPU/GPU difference of 1 byte; all eight
special-mode pixels were byte-identical for the tested opaque source and backdrop.

## Upstream and product references

This feature is new Product Plan section 6.1 work; pinned upstream has no Fill-opacity, colour-label, or granular-lock
model to port. Existing behavior and architecture were retained from:

- `Compositor/Document/EditorSession.swift` (`EditorSession`, layer state and edit lifetimes)
- `Compositor/Document/DocumentHistory.swift` (`begin`, `end`, undo snapshots)
- `Compositor/Rendering/LayerRenderer.swift` (layer coverage and transformed raster drawing)
- `Compositor/Rendering/LiveMaskRenderer.swift` (`prepareStacks`, `drawComposite`, clipping/live-mask order)
- `Compositor/Rendering/SeparableBlend.swift` (`isCoreGraphicsWrong`, separable blend routing)

The eight Fill-specific formulas are product work calibrated against Photoshop-compatible PSD behavior; they do not
replace an upstream implementation.

## Tests

New unit suites:

- `locks.test.ts`: inherited group blockers, structured refusal reasons, Pixel-versus-Position behavior, a real Fill
  preserving alpha bytes, command/history behavior including live Fill drag, atomic multi-layer refusal, full-lock
  rename/delete behavior, and lossless v1-to-v2 migration/round trip.
- `fill-opacity.test.ts`: ordinary opacity × Fill, mask/effects separation, pinned pixels for all eight special modes,
  ordinary opacity after the special kernel, and ag-psd metadata import.
- `layer-search.test.ts`: German accent/case folding, combined kind/label/visibility/lock/blend filters, inherited lock
  matching, ancestor disclosure, and input immutability.

## PSD oracle: files containing non-default Fill opacity

Corpus: psd-tools commit `30bf79c2a88e0fc63104ee85713e23b04362153d`, rendered against each embedded Photoshop
composite. Values are mean / p99 / maximum absolute byte error. “Before” is the checked-in baseline; “after” is the
same fill-tagged subset after this implementation.

| File | Before | After |
|---|---:|---:|
| `advanced-blending.psd` | 73.646 / 228 / 255 | 73.646 / 228 / 255 |
| `effects/shape-fx2.psd` | 47.410 / 255 / 255 | 47.410 / 255 / 255 |
| `effects/stroke-effect-transparent-shape.psd` | 30.331 / 153 / 153 | 30.331 / 153 / 153 |
| `layer_effects.psd` | 80.969 / 146 / 191 | 80.969 / 146 / 191 |
| `masks.psb` | 0.831 / 15 / 59 | 0.831 / 15 / 59 |
| `masks.psd` | 0.869 / 16 / 65 | 0.869 / 16 / 65 |
| `opacity-fill.psd` | 0.000 / 0 / 0 | 0.000 / 0 / 0 |
| `passthrough_fill_adjustment.psd` | 9.261 / 127 / 152 | 9.261 / 127 / 152 |
| `passthrough_fill_blendmode.psd` | 10.260 / 120 / 134 | 10.260 / 120 / 134 |
| `transparency/clip-opacity.psd` | 0.085 / 1 / 1 | 0.085 / 1 / 1 |
| `transparency/fill-opacity.psd` | 9.542 / 204 / 204 | 9.542 / 204 / 204 |
| `transparency/knockout-deep-cyanbg.psd` | 31.750 / 127 / 127 | 31.750 / 127 / 127 |
| `transparency/knockout-deep-nested-pt.psd` | 63.500 / 127 / 127 | 63.500 / 127 / 127 |
| `transparency/knockout-deep-nested.psd` | 63.500 / 127 / 127 | 63.500 / 127 / 127 |
| `transparency/knockout-deep-nobg.psd` | 63.500 / 127 / 127 | 63.500 / 127 / 127 |
| `transparency/knockout-deep-normal.psd` | 63.500 / 127 / 127 | 63.500 / 127 / 127 |
| `transparency/knockout-deep-passthrough.psd` | 63.500 / 127 / 127 | 63.500 / 127 / 127 |
| `transparency/knockout-none-cyanbg.psd` | 63.500 / 127 / 127 | 63.500 / 127 / 127 |
| `transparency/knockout-none-nested.psd` | 63.500 / 127 / 127 | 63.500 / 127 / 127 |
| `transparency/knockout-none-normal.psd` | 63.500 / 127 / 127 | 63.500 / 127 / 127 |
| `transparency/knockout-none-passthrough.psd` | 63.500 / 127 / 127 | 63.500 / 127 / 127 |
| `transparency/knockout-shallow-nested-pt.psd` | 63.500 / 127 / 127 | 63.500 / 127 / 127 |
| `transparency/knockout-shallow-nested.psd` | 63.500 / 127 / 127 | 63.500 / 127 / 127 |

The corpus subset is unchanged pixel-for-pixel at the reported precision. Its non-default Fill layers use Normal or
Pass Through, for which the old opacity-folding approximation happened to be pixel-equivalent when effects are not
rendered. The corpus has no non-default-Fill fixture for any of the eight special modes; those modes are therefore
verified by the pinned real-pixel unit cases and the GPU/CPU browser probe. Large remaining errors above come from
already-reported effects, knockout, isolated-group, mask, adjustment, and advanced-blending limitations.

## Deviations and open issues

- Layer effects are retained in the model but are not rendered by the current engine. Fill is deliberately applied
  only at content compositing, ready for future effects to bypass it, but visual Photoshop parity for Fill-zero effect
  layers cannot be reached until effect rendering lands.
- Existing isolated-group, Pass Through, knockout, and advanced-blending limitations remain. In particular, a special
  Fill mode on a clipping-stack base can inherit the current stack-flattening approximation.
- PSD's Lock All versus “three individual locks” distinction is not recoverable from the protection bits, as noted
  above. The unsupported artboard lock is reported, not silently mapped.
- Semi-transparent RGBA8 uploads can differ between CPU and GPU by up to two bytes because the existing WebGL upload
  path quantizes premultiplied texture values. The required Fill-kernel comparison on opaque pixels is within one byte;
  the broader pre-existing compositor suite uses statistical tolerances for this quantization and non-separable ties.
- No UI was changed, no runtime network call was added, and no dependency was added.

## Verification

- `npx tsc --noEmit -p .`: clean (exit 0).
- `npx vitest run tests/unit`: `Test Files 50 passed (50)`; `Tests 411 passed (411)`.
- `PLAYWRIGHT_BROWSERS_PATH=/home/oem/.local/share/fernwork-compositor-lab/browser-cache E2E_PORT=5461 npx playwright test --project=chromium`:
  `1 skipped`; `65 passed (8.8m)`.
- Fill-tagged PSD oracle subset: 23/23 parsed and rendered; per-file measurements above. No corpus metric changed.
- Manual WebGL Fill probe: nine modes, maximum CPU/GPU difference 1 byte on the specified opaque fixture.
