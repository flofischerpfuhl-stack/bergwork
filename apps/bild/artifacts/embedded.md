# P2-EMBED: embedded and linked content

## Implemented

- Added immutable embedded-source commands in `src/core/embedded/commands.ts`. Placement, replacement, shared-source editing, linked refresh/relink, rasterisation, and conversion to an embedded project are EditorSession transactions and therefore undoable. Embedded resources use `embedded-<sha256>` IDs and identical source bytes are stored once.
- Added `EmbeddedRuntime` in `src/core/embedded/runtime.ts`. It is a derived-raster source like the text/vector engines: raster images are decoded from their authoritative original bytes, while SVG/PDF sources are rendered for the current transformed size. Vector caches use power-of-two display resolutions, are capped at 16 Mpx, and never use an earlier resample as input.
- Added source preparation in `src/io/embedded.ts` for raster images, SVG, PDF host adapters, and `.fwimg` projects. Project sources are composited from the source archive for the placement preview.
- Added a deterministic CanvasKit-path SVG renderer in `src/io/svg.ts`; it does not pass SVG images through browser Canvas2D. It supports `path`, `rect` (including rounded rectangles), `circle`, `ellipse`, `line`, `polyline`, `polygon`, nested groups, affine transforms, viewBox with the default xMidYMid/meet behavior, solid CSS colors, opacity, fill rules, stroke width/caps/joins/miter/dashes, and common absolute length units.
- Added the optional, lazy `PdfPlacementHost` boundary in `src/io/pdf.ts` and host capability registry wiring. Invalid PDF signatures/pages are rejected before host invocation.
- Added File/Layer menu wiring, Alt-drop placement, host content pickers, Edit Contents tabs, save interception, Replace Contents, relink/update, Convert to Pixels, and Convert to Embedded in `src/app/embeddedFeature.ts` and the existing controller/menu/host extension points. No React component was added.
- Edit Contents opens image/project content in a separate tab. Saving it replaces the shared hash resource and updates every open instance in the parent as one undo step. SVG/PDF content is explicitly read-only and points the user to Replace Contents.
- Linked content stores the host file reference as its URI plus its last source hash. `EmbeddedRuntime.linkStatus()` reports current/changed/missing/unavailable; refresh is undoable. Browser hosts without a persistent file handle fall back to embedded placement with a notice.
- Extended v2 project validation/round-trip for original dimensions, page, SHA-256, and modified time. Source resources and rendered preview assets remain separate; hash-identical embedded resources have one physical ZIP member.
- PSD import now asks ag-psd for linked-file data and maps placed layers to embedded/linked layers. Embedded source bytes are stored as resources, PlLd/SoLd corner transforms are retained for directly decoded PNG sources, linked paths and PDF page numbers are retained, and the PSD document composite is not used for layer pixels. A decodable embedded PNG uses its source grid rather than Photoshop's transformed layer preview.

Minimal shared-file changes were required in `src/core/model/types.ts`, `src/core/session.ts`, `src/io/project.ts`, `src/io/psd/reader.ts`, `src/platform/browserHost.ts`, `src/platform/hosts/types.ts`, `src-tauri/frontend/host.ts`, `src/app/features.ts`, `src/ui/controller.ts`, `src/ui/menus.ts`, `src/ui/i18n.ts`, and `src/ui/CanvasPane.tsx`. `contracts.ts` and `contracts-v2.ts` were not changed.

No dependency was added and no runtime network call was introduced.

## Exported API

```ts
interface PreparedEmbeddedSource {
  bytes: Uint8Array;
  mime: string;
  mediaType: 'image' | 'svg' | 'pdf' | 'project';
  sourceName: string;
  width: number;
  height: number;
  raster: Raster;
  mode?: 'embedded' | 'linked';
  uri?: string;
  page?: number;
  modifiedAt?: number;
}

placeEmbeddedContent(session: EditorSession, source: PreparedEmbeddedSource, point?: Point | null): string | null;
replaceEmbeddedContents(session: EditorSession, layerId: string, source: PreparedEmbeddedSource): boolean;
updateSharedEmbeddedContents(session: EditorSession, assetId: string, source: PreparedEmbeddedSource): number;
updateLinkedContents(session: EditorSession, layerId: string, source: PreparedEmbeddedSource, name?: string): boolean;
convertEmbeddedToPixels(session: EditorSession, layerId: string, raster?: Raster | null): boolean;
convertLayerToEmbedded(session: EditorSession, layerId: string, source: PreparedEmbeddedSource): boolean;
embeddedResource(document: CanvasDocument, layer: EmbeddedLayer): DocumentResource | null;

class EmbeddedRuntime {
  constructor(options?: EmbeddedRuntimeOptions);
  pixels(session: EditorSession, layer: EmbeddedLayer): { raster: Raster; transform: LayerTransform } | null;
  prepare(session: EditorSession): Promise<void>;
  linkStatus(session: EditorSession, layerId: string): EmbeddedLinkStatus | null;
  refreshLinked(session: EditorSession, layerId?: string): Promise<number>;
}

embeddedMediaType(bytes: Uint8Array, name: string, mime?: string): EmbeddedMediaType;
prepareEmbeddedSource(bytes: Uint8Array, sourceName: string, options?: PrepareEmbeddedOptions): Promise<PreparedEmbeddedSource>;

svgInfo(bytes: Uint8Array): SvgInfo;
renderSvg(bytes: Uint8Array, width: number, height: number, engine: TextEngine): SvgRenderResult;

interface PdfPlacementHost {
  version: 1;
  inspect(bytes: Uint8Array): Promise<{ pages: number; width: number; height: number }>;
  renderPage(bytes: Uint8Array, page: number, width: number, height: number): Promise<Raster>;
}
isPdf(bytes: Uint8Array): boolean;
validatePdfPlacement(bytes: Uint8Array, page: number): void;
```

## Source correspondence

The pinned macOS source has no smart-object/placed-content implementation, so PRODUCT-PLAN sections 6.1 and 6.8 are authoritative for the new model and commands. Existing behavior was retained from:

- `Compositor/Document/EditorSession.swift` and the command extensions' `beginEdit`/`endEdit` convention: one named history transaction per user command.
- `Compositor/Document/BrushStroke.swift`, `BrushRaster.pixelToDocument`: source pixels remain in their own grid and the layer transform places that grid in document coordinates.
- `Compositor/IO/ProjectStore.swift`: validate before installing a loaded document and keep the previous project intact on decode failure.

The PSD portion follows ag-psd's placed-layer (`PlLd`/`SoLd`) and linked-file records; it does not use the PSD saved document composite as a measured layer result.

## PDFium investigation

The existing Fernwork runtime is in `vendor/pdfium/runtime` in the read-only Fernwork repository. It contains a 4,715,830-byte `pdfium.wasm`, ESM/CJS glue, generated functions, runtime methods, and an index wrapper. Its manifest pins EmbedPDF superproject `2cf7df3b594dfe46de2d85e6973ff50ea447a1ed`, PDFium fork `cb29e78f2ba00c9298714d5f4a8bf7765f1e802f`, and Emscripten 3.1.70. PDFium's retained license is BSD-style and EmbedPDF's is MIT, both compatible with the product allow-list.

The generated ABI exposes the functions needed for placement (`FPDF_InitLibrary`, `FPDF_LoadMemDocument`, page count/size, bitmap creation/buffer access, `FPDF_RenderPageBitmap`, and cleanup). It was not copied into this project because `build-manifest.json` says `releaseApproved: false` and describes it as a native candidate for product validation. Shipping it here would also require an audited app-owned lazy asset/worker package, WASM/CSP loading, memory/error isolation, complete bitmap channel handling and cleanup, retained notices, and an approved manifest. The engine therefore exposes `PdfPlacementHost`; PDF placement remains unavailable with a precise error unless a host supplies that capability. Nothing is added to the startup bundle.

## Tests and measured results

`tests/unit/embedded.test.ts` covers:

- hash-deduplicated placement and undo;
- Replace Contents preserving transform, opacity, effects, live filters, and mask;
- saving shared Edit Contents instances as one undo step;
- CanvasKit SVG sharpness at 4x versus raster resampling from the original 8x8 grid;
- v2 round-trip and one physical resource member;
- linked hash detection, refresh, and undo;
- PDF validation before host use;
- synthetic ag-psd placed-layer source bytes, transform, and independence from the PSD composite/preview.

`tests/e2e/embedded.spec.ts` clicks the real menus to place PNG/SVG, verifies the 4x vector target raster and original PNG grid, replaces SVG content while retaining transform/drop shadow, edits a duplicated shared image, saves both instances, and reopens the v2 archive.

Final commands:

```text
npx tsc --noEmit -p .
(no output; exit 0)

npx vitest run tests/unit
Test Files  71 passed (71)
Tests       580 passed (580)
Duration    46.97s

npm run psd:fidelity
Test Files  2 passed (2)
Tests       5 passed (5)
Duration    177.96s
Corpus      300/300 parsed, 300/300 rendered, 179/300 passed (59.7%)
Placed fixture layers/smartobject-layer.psd: mean/p99/max 0/0/0 (pass)

PLAYWRIGHT_BROWSERS_PATH=/home/oem/.local/share/fernwork-compositor-lab/browser-cache \
E2E_PORT=5851 npx playwright test --project chromium --output=/tmp/pw-out-p2emb
1 skipped
295 passed (30.4m)
```

The PSD command is a measurement harness and intentionally does not fail on fidelity thresholds. Its overall inherited corpus score remains well below the Product Plan's 90% goal; the smart-object fixture itself is exact after decoding its embedded original rather than transforming the saved layer preview twice.

## Deviations and open work

- SVG coverage is the deterministic illustration subset listed above. Gradients/paint servers, patterns, nested SVG viewports, `use`/`symbol`, text, embedded images, CSS selectors, clip paths, masks, and SVG filters are reported as unsupported; unsupported content is not sent to a browser-native SVG renderer. Non-default `preserveAspectRatio` is also reported. Full SVG requires extending the reviewed CanvasKit path translator.
- PDF placement is deliberately behind the host stub because the only located PDFium build is not release-approved. PDF Edit Contents is read-only.
- Linked sources are checked by content hash during render or explicit Update Linked Content. There is no Tauri filesystem watcher or automatic focus refresh yet; modified time is retained only when the host supplies it. Browser handles last for the host session and hosts without durable handles fall back to embedded content.
- PSD embedded PNG smart objects use the original source grid and placed transform immediately. Other embedded image encodings are resolved from original bytes by the lazy runtime in the application, but the synchronous importer keeps ag-psd's saved layer preview/placement until that happens; a standalone CPU consumer without `EmbeddedRuntime` therefore sees that compatibility preview. Nested PSB/project smart-object sources are stored but not recursively decoded by the PSD importer.
- Edit Contents follows this task's explicit new-tab requirement rather than the Product Plan's broader inline/isolation wording. Images and projects are editable; SVG/PDF are read-only.
- Convert to Embedded packages the selected branch as a `.fwimg`; complex nested-group coordinate normalization and an isolation-mode editor are not separately implemented.
- Warp authoring is outside this task. Imported non-affine PSD corner data is retained as a quad where the original source is directly available.
