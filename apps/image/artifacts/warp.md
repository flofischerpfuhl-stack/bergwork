# Phase 3 WARP: mesh warp, perspective, straighten and Liquify light

## Implemented

- Replaced the model's quad-only `warp` field with the schema-versioned `LayerWarp = WarpQuad | WarpMesh` union. A mesh stores bicubic Bezier patch control points in document coordinates, split counts, and an optional preset. The default patch is Photoshop's 4 x 4 control grid; 7 x 7 and 10 x 10 grids are exposed in the UI, while the validated engine format accepts up to eight splits per axis. Pixel, embedded, text and vector layers round-trip through project format v2 with the same non-destructive mesh.
- Added `src/core/meshWarp.ts`: mesh construction and validation, bicubic evaluation, Newton inverse mapping, deterministic presets (`arc`, `flag`, `bulge`, `wave`, `fish`, `rise`, `inflate`, `squeeze`) and forward tessellation. Effects receive a derived mesh over their expanded source bounds, and affine canvas/layer operations move all mesh points with their layer.
- Added format-generic CPU rendering. A warped output pixel is inverted through its Bezier patch and sampled from the native raster with premultiplied Catmull-Rom bicubic interpolation; RGBA16 stays RGBA16 until the existing compositor output boundary.
- Added GPU rendering as a 24 x 24 triangle tessellation per Bezier patch with bicubic texture sampling. The mesh shader retains masks, clipping, fill opacity, blend modes and the backdrop contract. Exports use the same compositors, so exported pixels and layer effects follow the warped silhouette.
- Kept the existing four-corner projective renderer for quad warps. **Edit > Transform > Perspective** enters that renderer with paired-corner axis constraints. **Edit > Transform > Warp** shows the surface grid, Bezier anchors/tangent control points, presets, bend amount, custom grid size and Remove Warp. Drag preview is non-destructive and mouse-up creates one `Warp` history step.
- Added `src/core/straighten.ts`. `detectStraightenAngle()` performs a gradient-weighted Hough search over -45 to +45 degrees. `straightenDocument()` rotates every layer, mask placement and warp around the canvas centre, then crops to the largest axis-aligned rectangle without exposed corners. **Image > Straighten** supports a drawn horizon or automatic detection; each apply is one history step.
- Extended the tiled, format-generic warp brush with push, bloat, pucker and reconstruct modes plus density. **Filter > Liquify** opens a floating workspace with the requested size, pressure and density controls. Strokes accumulate against an isolated working raster; Apply commits the whole session as one `Liquify` step and Cancel restores the source.
- Added German labels for all requested tools and controls: Verkrümmen, Perspektivisch, Gerade ausrichten, Verflüssigen, Vorwärts-krümmen, Aufblasen, Zusammenziehen, Rekonstruieren, Pinselgröße, Druck and Dichte.
- Added PSD mesh descriptor support where `ag-psd` exposes it. The reader maps `customEnvelopeWarp` and quilt slice descriptors into document-space control grids, and maps supported named warp styles to deterministic presets. `meshWarpToPsd()` emits an `ag-psd` custom-envelope/quilt descriptor for a placed layer; its bytes are exercised through the real `ag-psd` writer and reader.
- Advanced PRODUCT-PLAN core task 16 from its missing-capability marker to a complete UI workflow. The benchmark imports a package face, applies the Bulge preset, checks the 16-point mesh and single `Warp` undo step, then asserts the exported centre pixel.

No dependency, model weight, telemetry or runtime network access was added. `contracts.ts` is unchanged; the only contract change is the appended `LayerWarpV2` union in `contracts-v2.ts`.

## Exported engine API

```ts
interface WarpMesh {
  kind: 'mesh';
  schemaVersion: 1;
  splits: { x: number; y: number };
  points: Point[];
  preset?: 'custom' | 'arc' | 'flag' | 'bulge' | 'wave' | 'fish' | 'rise' | 'inflate' | 'squeeze';
}

type LayerWarp = WarpQuad | WarpMesh;

createMeshWarp(transform: LayerTransform, splits?: { x: number; y: number }): WarpMesh;
isValidMeshWarp(value: unknown): value is WarpMesh;
meshPoint(mesh: WarpMesh, unit: Point): Point;
inverseMeshPoint(mesh: WarpMesh, target: Point): MeshInverse | null;
tessellateMesh(mesh: WarpMesh, segmentsPerPatch?: number): MeshTriangles;
meshPreset(transform: LayerTransform, preset: WarpPreset, amount?: number, splits?: MeshSplits): WarpMesh;

sampleRgbaBicubic(raster: Raster, x: number, y: number): readonly [number, number, number, number];

detectStraightenAngle(raster: Raster): number | null;
straightenedCropSize(width: number, height: number, radians: number): { width: number; height: number };
straightenDocument(document: CanvasDocument, horizonDegrees: number): CanvasDocument;

meshWarpToPsd(mesh: WarpMesh, transform: LayerTransform, sourceWidth: number, sourceHeight: number): agPsd.Warp;
```

`EditorSession.previewLayerWarp()` and `commitLayerWarp()` provide the live-preview/one-undo authoring boundary. `WarpStroke` now accepts `push`, `bloat`, `pucker` and `reconstruct` in addition to the existing compatibility modes, with `density` and an optional reconstruction source.

## Decisions

- Mesh points live in document space. This matches the existing quad representation, makes text/vector/embedded layers use one contract, and lets canvas operations transform warps without baking pixels.
- CPU rendering uses inverse mapping to avoid holes; GPU rendering uses a dense forward tessellation because WebGL rasterization interpolates stable UVs cheaply. Twenty-four segments per patch made curvature error smaller than the existing RGBA8 compositor tolerance without introducing another runtime dependency.
- Bicubic samples are accumulated in premultiplied space. This prevents colour fringes around transparent warped edges and uses the same sampling rule for 8-bit and 16-bit rasters.
- Liquify is destructive only at workspace Apply. Keeping its preview in an isolated raster allows many strokes and reconstruction while preserving the required single undo step.
- Automatic straighten analyzes the active raster rather than a browser canvas. The result is deterministic, offline, independent of colour-management display state and directly unit-testable.
- These are new PRODUCT-PLAN features; the pinned macOS Compositor source has no mesh-warp, straighten or Liquify workspace to port. Existing session history conventions and the pre-existing free-transform quad path were retained rather than copied as new code.

## Tests and measurements

All inputs in the new pixel tests are generated independently; no measured output is used as its own oracle.

```text
npx tsc --noEmit -p .
(no output; exit 0)

npx vitest run tests/unit
Test Files  81 passed (81)
Tests       666 passed (666)
Duration    43.53s
Host load   15.56, 12.78, 9.13

Focused model/pixel/PSD tests
Test Files  3 passed (3)
Tests       19 passed (19)
Duration    2.56s

Core-task benchmark 16
Tests       1 passed (1)
Duration    31.7s
Host load   21.76, 26.18, 26.92 at start

Full Chromium suite
Tests       321 passed, 16 pre-existing/configuration skips, 0 failed
Duration    1.0h
Host load   12.16, 12.70, 9.42 at start

Focused Firefox + WebKit WARP suite
Tests       4 passed (4)
Duration    45.2s
Host load   25.39, 29.23, 27.88 at start
```

Mesh GPU versus CPU on the generated 16 x 16 curved-gradient fixture (256 opaque output pixels):

| Browser | Mean absolute channel delta | Maximum delta |
|---|---:|---:|
| Chromium | 0.1416015625 | 8 |
| Firefox | 0.025390625 | 1 |
| WebKit | 0.03125 | 1 |

`tests/unit/warp.test.ts` verifies exact identity pixels, known Arc displacement, checkerboard perspective, Hough detection of a generated 12-degree horizon, straighten rotation/crop pixels, push displacement, bloat/pucker and reconstruction. Project tests cover mesh warp on pixel/vector/text/embedded layers and format-v2 round-trip. The PSD test writes and re-reads a custom mesh descriptor through `ag-psd`. The browser spec checks real GPU/CPU pixels and drives all four tool/menu hooks.

## Deviations and open work

- This repository has a PSD reader but no product-level PSD document export pipeline. `meshWarpToPsd()` provides and tests the placed-layer descriptor needed by such a writer; wiring it into a future full PSD exporter remains open.
- PSD import covers custom/quilt control grids and the named presets represented by this editor. Rare Photoshop warp styles and the descriptor's separate perspective scalars are not reconstructed beyond the existing placed-layer quad.
- Effects derive their expanded mesh by sampling the layer mesh at the effect bounds. This keeps the effect attached to the warped silhouette, but extreme multi-patch folds are an approximation rather than an exact analytic Bezier continuation.
- Hough auto-straighten uses the active raster only. A future composited-document detector could include visible vector/text/embedded layers, but would need a bounded-resolution render to retain predictable memory use.
- Meshes are validated and rendered only while non-folded. Deliberately self-intersecting control grids can select one of multiple inverse solutions and are not presented as a supported deformation.
- The full browser run prints PixiJS warnings when test-owned textures are destroyed while still referenced by a bind group. They are existing cleanup diagnostics; all compositor assertions and all new WARP tests passed.
