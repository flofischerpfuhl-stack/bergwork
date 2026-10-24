# Vector engine report

## Scope and implementation

The engine-only Phase-2 vector slice is implemented without UI or runtime network access. It reuses the existing lazy
`loadTextEngine()` CanvasKit instance; no second CanvasKit loader and no dependency were added.

Model and persistence:

- `src/core/model/types.ts` and `contracts-v2.ts` now carry schema-versioned cubic paths, point kind, fill rule, parametric
  Rectangle/Ellipse/Polygon/Star/Line data, complete stroke settings and vector-mask density/feather.
- `src/io/project.ts` writes and validates those fields in Fernwork Image v2. Early v2 paths/styles/masks without version,
  point-kind or fill-rule fields migrate to version 1 defaults. The unit suite round-trips the complete record.
- Existing Rectangle/Ellipse `sourceShape` records retain their preview raster and legacy fields. The pre-existing shape
  pixel tests remain unchanged and green.
- `src/io/psd/reader.ts` imports ag-psd `vmsk` knots as editable cubic paths and `vstk` colour/gradient, width, alignment,
  cap, join and dash data. PSD vector-mask enable/invert/density/feather are retained. Unsupported noise/pattern vector
  paint keeps the saved preview and is reported as approximated.

Geometry and commands (`src/core/vector/**`):

- `rectanglePath`, `ellipsePath`, `polygonPath`, `starPath`, `linePath`, `primitivePaths`
- `pathToSvg`, `pathsToSvg`, `svgToPaths`, `normalizedPath`, `vectorBounds`
- `hitTestPaths(paths, point, tolerance): VectorHit | null`
- `booleanPaths(engine, first, second, operation)` and `combinePathSets(...)`, backed only by CanvasKit/Skia PathOps
- `pathsToSelection(...)` and `selectionToPaths(selection, tolerance)`; tracing uses the stored 50% coverage boundary and
  Ramer-Douglas-Peucker simplification
- `renderVector(...)`, `renderVectorMask(...)`, `VectorRasterCache`, and
  `vectorCompositeHooks(cache, base): CompositeHooks` for both the software and WebGL compositors
- `createParametricShape`, `createPathLayer`, `editVectorPaths`, `addAnchor`, `moveAnchor`, `deleteAnchor`,
  `setAnchorKind`, `dragHandle`, `setVectorStyle`, `applyBoolean`, `mergeVectorLayers`, `setVectorMask`,
  `rasterizeVectorLayer`, `paintVectorToRaster`, and `paintPathOnPixelLayer`
- `beginVectorLiveEdit`, `finishVectorLiveEdit`, and `cancelVectorLiveEdit` make handle/style previews one undo transaction.

Public API signatures (defaults are described by the TypeScript declarations):

```ts
rectanglePath(width, height, radii): VectorPath
ellipsePath(width, height): VectorPath
polygonPath(width, height, sides, cornerRadius?): VectorPath
starPath(width, height, points, innerRatio, cornerRadius?): VectorPath
linePath(width, height): VectorPath
pathToSvg(path, scale?, offset?): string
svgToPaths(svg): VectorPath[]
vectorBounds(paths): Rect | null
hitTestPaths(paths, point, tolerance): VectorHit | null
hitTestVectorLayer(layer, documentPoint, tolerance): VectorHit | null
booleanPaths(engine, first, second, operation): readonly VectorPath[]
combinePathSets(engine, sets, operation): readonly VectorPath[]
pathsToSelection(engine, paths, bounds, antialiased?): DocumentSelection
selectionToPaths(selection, tolerance?): readonly VectorPath[]
renderVector(engine, paths, style, width, height, pixelsPerDocumentPixel?): Raster
renderVectorMask(engine, mask, width, height, pixelsPerDocumentPixel?): Raster
vectorCompositeHooks(cache, base?): CompositeHooks
createParametricShape(session, shape, rect, style): string | null
createPathLayer(session, paths, style, transform, name?): string | null
editVectorPaths(session, layerId, paths, name?): boolean
addAnchor/moveAnchor/deleteAnchor/setAnchorKind/dragHandle(...): boolean
setVectorStyle(session, layerId, style, live?): boolean
applyBoolean(session, engine, layerId, first, second, operation): boolean
mergeVectorLayers(session, layerIds, name?): string | null
setVectorMask(session, layerId, mask): boolean
rasterizeVectorLayer(session, engine, layerId, scale?): boolean
paintVectorToRaster(base, engine, paths, style): Raster
paintPathOnPixelLayer(session, engine, layerId, paths, style): boolean
```

`VectorRasterCache.prepare(layers, pixelsPerDocumentPixel)` is the synchronous pre-compositor cache step. Existing
session transform commands now accept raster-free vector layers and resize their editable path and vector-mask geometry.

Rendering uses CanvasKit's CPU surface for host-identical antialiasing. The cache key includes vector data, style, target
pixel density and layer size. A zoom/transform density change therefore renders a new target-sized raster rather than
upsampling the previous one. Cached immutable path sets retain at most three render variants and only cache outputs up to
4 Mpx. Solid/linear-gradient fills, solid/linear-gradient strokes, centre/inside/outside alignment, butt/round/square caps,
miter/round/bevel joins with miter limits, even dash arrays and offsets, and none/arrow/open-arrow/circle/square line-end markers are covered.
Raster and vector masks are multiplied in layer space; differently placed raster masks are bilinearly sampled.

Three small shared integration changes were necessary outside the primary ownership list: `src/text/types.ts` and
`src/text/engine.ts` expose CanvasKit fill-rule and miter-limit controls through the already shared lazy engine;
`src/core/composite.ts` lets the software compositor recognize vector-only masks. No second CanvasKit instance is created.

## Upstream reference

Existing behaviour was retained from:

- `Compositor/Document/ShapeTool.swift`: `ShapeKind`, `LayerShapeStyle`, `finishShape`, `redrawShape`, `shapeImage`.
- `Compositor/Document/Selection.swift`: `DocumentSelection.coverage`, `SelectionClip`, and `DragBox.rect`.
- `CompositorTests/ShapeToolTests.swift`: rectangle undo/placement/pixels, ellipse corners, cancel, rounded radius and pill
  clamp cases. Those previously ported tests still pass.
- `Compositor/IO/ProjectStore.swift`: validated bounded project loading remains the persistence safety model.

The upstream application has no editable cubic-vector/PathOps/vector-mask engine. PRODUCT-PLAN A5, 6.2, 6.6 and M12 are
therefore the binding specification for the new APIs.

## Verification

Added tests:

- `tests/unit/vector-paths.test.ts`: SVG cubic round trip, multiple subpaths, bounds, polygon/star construction, local and
  document-space anchor/handle/segment hit testing, selection tracing.
- `tests/unit/vector-render.test.ts`: pixel checks for rectangle, ellipse, polygon and star; gradient, alignment, cap, join,
  dash and all markers; unite/subtract/intersect/exclude; fractional path-to-selection placement; invert/density/feather
  masks; raster+vector and vector-only compositor masks; RGBA16 painting; empty paths; 1,000 anchors.
- `tests/unit/vector-commands.test.ts`: creation and path editing undo, raster-free vector transform/undo, layer merging,
  full v2 archive round trip, style and mask undo.
- `tests/unit/vector-psd.test.ts`: ag-psd-written `vmsk`/`vstk` editable shape geometry/style and pixel-layer vector-mask
  density, feather and inversion.
- `tests/e2e/vector-engine.spec.ts`: deterministic raster SHA-256, target-resolution zoom rerasterization, cached
  1,000-anchor p95, and vector-only masks through the WebGL compositor.

Measured results on 2026-09-24:

- Unit suite, exact command: the best final run reached **59 files / 482 tests passed**; the unrelated 4000×3000 TIFF
  benchmark alone hit Vitest's outer 30 s timeout despite reporting a 7.2–13.0 s decoder measurement. A later attempt at
  host load 45–67 reached **58 files / 481 tests passed**; that TIFF case and the unrelated 4000²→8000² canvas-resize
  benchmark exceeded their wall-clock timeouts. All **27 vector tests** and the 40 additional directly affected
  shape/session/transform/text tests pass. See the final handoff for the exact summaries.
- Full Chromium e2e: **81 passed; 1 skipped** (the existing optional test); duration 28.6 min.
- Vector cross-browser e2e: **6 passed** (Chromium, Firefox, WebKit), identical SHA-256
  `a23be007056cc04d679179f3f3090a930681930f33c2d42ba849f75cf7a1e19b`.
- Cached 1,000-anchor Chromium p95: **0.0–0.1 ms** (timer resolution sometimes reports 0.0 ms). A deliberately uncached new
  path-array raster measured **27.3–49.5 ms p95** across the recorded runs; see the performance deviation below.
- PSD command: **1 file passed, 1 skipped; 4 tests passed, 1 skipped**. The 300-file external corpus was not mounted in
  this worktree, so its fidelity table could not be regenerated. The existing baseline already has path-operations
  12/12 passing; editable-import assertions cover the new adapter data.

Final pre-commit checks:

```text
$ npx tsc --noEmit -p .
(no output; exit 0)

$ npx vitest run tests/unit/vector-paths.test.ts tests/unit/vector-render.test.ts \
    tests/unit/vector-commands.test.ts tests/unit/vector-psd.test.ts
Test Files  4 passed (4)
Tests       27 passed (27)
Duration    12.87s
```

The required exact all-unit command was run repeatedly, but was not fully green under the shared machine contention
described above. No vector or directly affected test failed.

## Deviations and open issues

- Pattern and PSD noise vector paints are persisted/imported but cannot be produced by the shared path raster API; a saved
  preview is retained. Solid and linear-gradient paints render live.
- Even-odd path sets combine antialiased CanvasKit coverage with parity math, and self-intersecting individual paths use
  CanvasKit's explicit even-odd fill type. A mixed nonzero/even-odd path set is flattened with nonzero winding.
- The ≤16 ms target is met for normal repeated compositor renders through the immutable cache. A forced cold parse + CPU
  surface allocation/readback of a new 1,000-anchor path identity is 27.3–49.5 ms p95 in Chromium and remains an open
  optimization item. Zoom/transform density changes correctly rerasterize but can incur that cold cost.
- PSD `vogk` parametric descriptors are not reconstructed into `sourceShape`; `vmsk` geometry is editable and `vstk` style
  is retained, but imported Photoshop shapes are generic editable paths.
- PSD non-linear gradient styles and midpoint/offset metadata are approximated by the model's linear angle/stops gradient.
- PSD subpath boolean-operation tags are parsed by ag-psd but are currently imported as subpaths rather than reduced into a
  single PathOps result. The saved preview remains available.
- The external 300-file PSD corpus was unavailable, so no claim is made that the old masks-category fidelity failure is
  fixed. The focused adapter and pixel tests pass.
