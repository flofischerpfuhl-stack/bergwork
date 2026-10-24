# Artboards and the single export pipeline (Phase 2, lane `p2-export`)

Engine only (no React/UI). PRODUCT-PLAN 6.1 (export row, per-artboard/layer @1x/@2x/@3x, artboards with
Social/Web/Print presets), P4 (one way per task), A3 (16-bit, ICC), A6 (export budget), A10 (lazy encoders).

## What exists now

| Module | Role |
|---|---|
| `src/core/artboardPresets.ts` | Preset data: Social (Instagram post 1080², portrait 1080×1350, story 1080×1920, Facebook cover 851×315, LinkedIn banner 1584×396), Web (1920×1080, 1440×900, 1280×720, mobile 390×844), Print at 300 ppi (A3 3508×4961, A4 2480×3508, A5 1748×2480, US Letter 2550×3300). |
| `src/core/artboards.ts` | Membership rule, content bounds, hit testing, canvas fitting, reader normalisation. Pure functions. |
| `src/core/artboardCommands.ts` | Undoable commands on an `EditorSession` (one history step each). |
| `src/io/exportPlan.ts` | Request model, validation, naming, regions, pixel sizes. Synchronous, stays in the start chunk. |
| `src/io/exportPipeline.ts` | Render (bands, float for 16-bit), artboard backgrounds, matte, encode, file-size preview. Lazy chunk. |
| `src/io/exportEncode.ts` | PNG (band-parallel, 8/16-bit, RGB/RGBA), JPEG, WebP, AVIF, TIFF encoders + metadata. Lazy chunk / worker. |
| `src/io/tiffEncode.ts`, `src/io/exportMetadata.ts`, `src/io/iccProfile.ts`, `src/io/deflateJoin.ts` | New TIFF writer, EXIF/ICC/JPEG-APPn/WebP-chunk writers, built-in sRGB ICC v2.1 profile, deflate-stream joiner. |
| `src/workers/exportWorker.ts`, `src/workers/exportClient.ts` | Worker pool, cancellation (terminate on abort), parallel PNG bands. |
| `src/io/export.ts` | Reduced to the remembered JPEG settings (`JpegOptions`); `pngBlob`/`jpegBlob`/`flattenOnMatte` removed (no second path). |

### Artboard API

```ts
// src/core/artboardCommands.ts — all undoable, return false/null on refusal (reason in lastArtboardError)
createArtboard(session, { preset?: string; rect?: Partial<Rect>; name?: string; background?: ArtboardBackground; colorLabel?: ColorLabel }): string | null
renameArtboard(session, id, name): boolean
moveArtboard(session, id, dx, dy): boolean            // moves the artboard and its content
resizeArtboard(session, id, rect: Rect): boolean      // content stays where it is
setArtboardBackground(session, id, { red, green, blue, alpha }): boolean   // alpha 0 = transparent
setArtboardColorLabel(session, id, label): boolean
reorderArtboard(session, id, index): boolean
duplicateArtboard(session, id, name?): string | null  // copies content (new ids, remapped parent/clip), placed right of the rightmost artboard
deleteArtboard(session, id, { contents?: 'delete' | 'keep' }): boolean

// src/core/artboards.ts
artboardUnits(document, bounds?) / artboardMembership(document) / artboardLayerIds(document, id)
artboardAt(document, point) / layerContentBounds(layer) / normalizeArtboards(records)
ARTBOARD_PRESETS, artboardPreset(id), artboardPresetsIn(category)   // src/core/artboardPresets.ts
```

### Export API

```ts
interface ExportRequest {
  targets: readonly ({ kind: 'document' } | { kind: 'artboard'; id } | { kind: 'layer'; id })[];
  format: 'png' | 'jpeg' | 'webp' | 'avif' | 'tiff';
  sizes?: readonly ({ scale } | { width, height? } | { height, width? })[];   // default [{ scale: 1 }]
  quality?: number;            // JPEG/WebP 0.85, AVIF 0.75 by default
  lossless?: boolean;          // WebP only
  bitDepth?: 8 | 16;           // 16: PNG and TIFF only
  compressionLevel?: 0…9;      // PNG/TIFF deflate, default 6
  speed?: 0…10;                // AVIF, default 6
  tiffCompression?: 'deflate' | 'none';
  transparent?: boolean;       // default true where the format has alpha; JPEG always flattens
  matte?: RGB;                 // under transparency when flattening, default white
  metadata?: { colorProfile?: 'embed' | 'strip'; resolution?: boolean; info?: { copyright?, artist?, description?, software? } | null };
  baseName?: string;           // file stem of the document target (project name)
  resolution?: number;         // ppi at 1×, default document.resolution
}

planExport(document, request): ExportPlanItem[]        // sync: { name, target, label, size, region, width, height, dpi }
runExport(document, request, renderer, { signal?, encoder?, onProgress? }): Promise<ExportFile[]>   // { name, mime, bytes, width, height, bitDepth, item, warnings }
estimateExportSize(document, request, renderer, { signal?, exactLimit?, tile?, grid? }): Promise<ExportSizeEstimate[]>  // { item, bytes, exact, sampledPixels }
cpuExportRenderer(): ExportRenderer                     // headless / tests

// EditorController (src/ui/controller.ts)
exportRequest(format, overrides?): ExportRequest        // project name + remembered JPEG settings
planExport(request): ExportPlanItem[]
exportWith(request, options?): Promise<boolean>        // chooses the destination FIRST, then renders+encodes; >1 file → one ZIP
exportFiles(request, options?): Promise<ExportFile[]>  // no saving (previews, EditorHandle.exportImage)
estimateExport(request, options?): Promise<ExportSizeEstimate[]>
exportTo('png' | 'jpeg') / exportBlob(...)             // existing entry points, now thin wrappers over the pipeline
```

Naming: `<stem><suffix>.<ext>`; stem = artboard name / layer name / `baseName`, sanitised for all file systems;
suffix = `''` at 1×, `@2x`, `@3x`, `@0.5x`; explicit sizes `-<w>x<h>`. Collisions get ` 2`, ` 3` before the suffix.
Extensions: `png jpg webp avif tif`. Resolution metadata keeps the physical size (72 ppi @2x → 144 ppi).

## Decisions and reasons

1. **Membership is geometric, not an explicit field.** `docs/format-v2.md` already said membership is
   spatial and not encoded by an artboard parent; keeping that means no format change, full backward
   compatibility (older readers/writers keep the same meaning) and no membership state that every layer
   command of the parallel lanes (text, styles) would have to maintain — new layers from any tool belong
   where they are placed. Rule (also in `docs/format-v2.md`): top-level layer + descendants = unit; a
   top-level layer clipped/live-masked to another unit joins it; unit bounds = union of alpha-trimmed
   content bounds (cached per immutable raster); the unit belongs to the last artboard containing the
   centre; unbounded units (top-level adjustment/fill layers) and units outside every artboard are loose
   and apply wherever they overlap. Photoshop behaviour kept: moving an artboard moves its content,
   resizing does not, duplicate copies content, delete removes content (or keeps it as loose layers).
   Trade-off: a layer straddling two artboards belongs to one (by centre) — same as Photoshop's
   one-parent model, but decided by position instead of panel nesting.
2. **Artboards stay inside the canvas.** Both compositors clip to `0…width × 0…height`; commands grow the
   canvas right/bottom to fit (never shrink, never shift content; refused beyond 30 000 px / 100 MP).
   One undo step includes the growth.
3. **One pipeline, plan before render.** `planExport` is synchronous and in the start chunk so
   `exportWith` asks for the destination while the click still counts (large-save spec keeps passing);
   rendering/encoding code is loaded after that (`import('../io/exportPipeline')`).
4. **Rendering through the canvas compositor at any scale** (`CanvasView.readView/readViewFloat`, same
   hooks as the canvas), in 1024-row bands. @2x/@3x are rendered, not upscaled exports (mip selection
   uses the export scale). 16-bit uses the rgba16float readback (all three browsers had float targets);
   without it the file is written with 8-bit samples and a warning.
5. **Document target with artboards** = the whole canvas composite with every artboard's background
   underneath (no per-artboard clipping). Without artboards it has the same pixels as the old full-canvas export (the PNG now carries an iCCP sRGB profile instead of the `sRGB` chunk by default; `colorProfile: 'strip'` writes neither).
6. **Metadata = Photoshop Export As**: colour profile embed/strip (default embed), resolution on/off,
   creator info none (default) or copyright/artist/description + Software. ICC is a built-in compact sRGB
   ICC **v2.1** profile (2.5 KB; v4 is ignored by some Windows viewers) — verified by Little CMS mapping
   sRGB samples onto themselves. PNG iCCP/pHYs/eXIf, JPEG APP2 ICC_PROFILE/JFIF density/APP1 Exif,
   WebP VP8X+ICCP+EXIF, TIFF 34675/X-YResolution/ASCII tags, AVIF colr(prof).
7. **Band-parallel PNG**: rows split into one band per worker (hardwareConcurrency − 1, max 8); each worker
   filters (min-SAD heuristic scored on every 7th byte) and deflates its band with the browser's native
   zlib (`CompressionStream('deflate')`, level 6); `deflateJoin.openDeflateEnd` re-opens each non-final
   band (clears BFINAL of the last block, appends a sync-flush marker) so the bands form one zlib stream;
   Adler-32 comes from each native trailer and is combined (`adler32Combine`). Non-default levels and
   engines without CompressionStream use fflate with a sync flush (fflate 0.8.3's `flush(true)` writes
   the stored block at a wrong bit offset — worked around in `syncFlush`, covered by a test).
8. **Several files → one ZIP** (`<project> export.zip`, stored entries) through one save dialog; hosts have
   no directory picker yet. `FileSaveKind` gained `webp | avif | tiff | zip` (browser and Tauri pickers).
9. **File-size preview** really encodes, in the export worker, cancellable (abort terminates the worker):
   outputs ≤ 1.5 MP are encoded in full (exact); larger ones as a 4×4 mosaic of full-resolution 256² tiles
   spread over the image, extrapolated by pixel count over the format's fixed overhead (a 1×1 encode with
   the same settings/metadata). Mosaic rather than a downscale, because downscaling changes detail per pixel.

## Measurements

The machine was shared with other lanes' e2e runs and a Rust build the whole time: load average 10–25
on 8 hardware threads. All times are wall-clock under that load; treat them as upper bounds.

**46 MP PNG export (A6: Pro ≤ 3 s, Lite ≤ 8 s)** — `tests/e2e/export-performance.spec.ts`, `perf-gpu`
project (Chromium, ANGLE/GL on the laptop's HD 630), 8256 × 5568 = 45.97 MP, photo-like content (gradients +
grain, incompressible like real sensor noise), 8-bit RGBA, document target, 3 runs each:

| Load avg (1 min) | End to end `exportFiles` | GPU render + readback | PNG encode (7 workers) | Previous path: `encodePng` single thread, same pixels |
|---|---|---|---|---|
| 12 (fflate in workers, first version) | 12.0 / 12.3 / 12.1 s | 0.8–1.2 s | 12.7–13.5 s | 50.6 s |
| 21 (browser zlib in workers) | 19.8 / 17.1 / 12.8 s | 1.7–2.1 s | 10.7–11.3 s | 93.9 s |
| 17 (final) | 13.6 / 11.0 / **10.1 s** | 1.5–1.8 s | 7.9–8.4 s | 71.1 s |

Per band (6.6 MP, one worker, Chromium, load 17–19): filter 0.32 s, browser zlib level 6 3.1–3.4 s,
deflate walk 0.33 s, CRC 0.04 s. fflate level 6 needs 11.7 s for the same band (browser zlib is 3.7×
faster), fflate level 1 1.8 s at +18 % size. File size 46.8 MB (old path 46.9 MB).

Verdict: **7× faster than the old path under identical load, but not measured inside the budget on this
loaded machine** (best 10.1 s vs. Lite 8 s). Encoding is ~80 % of the time and scales with free cores; on an
idle 8-thread machine the per-band numbers suggest ≈ 3–4 s end to end, which is an estimate, not a
measurement — re-run `npx playwright test tests/e2e/export-performance.spec.ts --project perf-gpu` on an
idle machine. Pro ≤ 3 s needs the Tauri ComputeHost (native zlib-ng/libdeflate in Rust threads, A6); the
pipeline's `ExportEncoder` interface is the seam for it.

**Start chunk (A10)** — `npm run build`, main app chunk + its static imports, gzip -9 (script
`node scripts/export-start-size.mjs <outDir>`, Vite's own figure in brackets):

| | Main app chunk | + static imports | Total |
|---|---|---|---|
| before (`integration`) | 362.61 KB [375.11] | geometry, types, runtime, index: 5.26 KB | **367.87 KB** |
| after | 361.76 KB [374.30] | + document 2.90 KB, raster 2.12 KB (split out by Rolldown) | **372.04 KB** |

Encoders did not enter the start chunk: `exportEncode` (5.9 KB gzip, TIFF/EXIF/ICC/deflate joiner),
`exportPipeline` (3.95 KB) and the export worker (29.8 KB) are separate lazy chunks; WebP/AVIF/lcms WASM
stay lazy. The start payload grew by **+4.2 KB gzip** (artboard model, request planning/naming and the
controller glue, which must be synchronous for choose-before-encode); 372 KB is within the 400 KB budget.

**File-size preview accuracy** (estimate / real):

| Image | PNG | JPEG q0.85 | WebP q0.8 | AVIF q0.6 | TIFF deflate |
|---|---|---|---|---|---|
| 3000 × 2000, half grainy photo, half flat checkerboard (Chromium, GPU) | 0.96–0.98 | 0.97 | 1.08 | 1.08 | 0.97 |
| 1600 × 1200 photo-like (Node unit test) | 1.02 | — | 1.01 | 1.00 | 0.98 |

Preview time for the 6 MP image under load 17–25: 1.0–4.3 s (JPEG/WebP/TIFF ≈ 1–2 s, PNG 2.5–4.3 s,
AVIF 2.8–9.8 s); outputs ≤ 1.5 MP are exact. Cancellation rejects with `AbortError` and kills the worker.

## Tests

- `tests/unit/artboards.test.ts` (13): presets, membership (centre rule, alpha-trimmed bounds, topmost on
  overlap, loose adjustment, clipped layer joins base, folders), every command incl. undo/redo, locks,
  duplicate id remapping, canvas growth/limits, format v2 round trip, records without background.
- `tests/unit/export-pipeline.test.ts` (17): naming/scales/explicit sizes/dedupe/validation, artboard
  clip + background + other artboards hidden (PNG @1x/@2x pixels), transparency/matte, document target,
  layer target, PNG16/TIFF16 exact 16-bit samples, ICC in PNG/TIFF/WebP/AVIF (+ Little CMS identity),
  EXIF in PNG/TIFF/WebP and stripping, WebP/AVIF/TIFF decode @1x/@2x, Adler combine, band stitching (fflate
  and native), deflate joiner on stored/fixed/dynamic/Huffman-only streams, preview accuracy and cancel.
- `tests/e2e/export-artboards.spec.ts` (Chromium, Firefox, WebKit): artboard @1x/@2x in PNG/JPEG/WebP/AVIF/TIFF
  through the running editor (GPU renderer, export workers), decoded with the editor's own decoders;
  choose-destination-first for one file and for a ZIP; 16-bit PNG/TIFF keep 64 distinct levels of a
  16-bit ramp; file-size preview accuracy + cancellation (Chromium).
- `tests/e2e/export-performance.spec.ts` (`--project perf-gpu`, opt-in): the 46 MP measurement below.

- `npx tsc --noEmit -p .` clean (also the Tauri frontend host with a temporary tsconfig including `src-tauri/frontend`).
- `npx vitest run tests/unit`: 450 passed, 1 failed — `tiff.test.ts` "decodes a 4000x3000 LZW RGB TIFF within a
  bounded benchmark" timed out at load 17–25 (38–48 s vs. its 30 s limit); it passes alone, with and without
  this lane's changes (decoder untouched). New: artboards 13/13, export pipeline 17/17.
- Full Chromium e2e suite: **76 passed, 1 skipped** (visual tour: reference photos absent), 14.3 min at load ≈ 17–21.
  Includes `large-save.spec.ts` (40 MP save + export pick the file while the key press still counts).
- `tests/e2e/export-artboards.spec.ts` in Chromium, Firefox and WebKit: 25 passed, 2 skipped (preview accuracy
  is Chromium-only by design): every format @1x/@2x, destination-first/ZIP, 16-bit (64 distinct levels in all
  three engines, all had float render targets), 1.5 MP PNG through the parallel band path bit-exact.

## Deviations

- AVIF files carry no EXIF creator fields (the committed libavif bridge has no metadata entry point; the
  file gets a warning). WebP/AVIF have no resolution field.
- JPEG and TIFF are 8/16-bit as specified; 16-bit is refused for JPEG/WebP/AVIF with an `ExportError`.
- The working space is sRGB only (documents have `colorSpace: 'srgb'`); P3/Adobe RGB export profiles
  follow when documents get other working spaces (A3).
- Print presets carry 300 ppi as data, but the document has one resolution: creating a print artboard does
  not change `document.resolution` (exports use it unless the request sets `resolution`).
- PNG `compressionLevel` other than 6 uses the slower fflate path (native zlib has no level option).
- Estimates are ±10 % typical, not exact, above 1.5 MP (see measurements).

## Open UI work for the integrator

- **Export dialog (one dialog, P4):** build an `ExportRequest` from the controls; show
  `controller.planExport(request)` (file names, pixel sizes) live; size preview with
  `controller.estimateExport(request, { signal })` debounced, aborting the previous controller on every
  change (show "≈" when `exact` is false); Export button → `controller.exportWith(request)` directly in the
  click handler (no await before it). Controls: format; sizes as chips (1×/2×/3×, custom width/height);
  quality (JPEG/WebP/AVIF), lossless (WebP), 8/16-bit (PNG/TIFF), transparency + matte colour,
  metadata (embed colour profile, resolution, creator info none/copyright+contact), targets (document,
  artboards checklist, selected layers). Show `ExportFile.warnings`. Translate `ExportError` messages.
  Replace the JPEG dialog and the File > Export PNG/JPEG items with this dialog (they already route
  through the pipeline, so behaviour does not change meanwhile). Menu: "Export As…", plus
  "Export Artboards/Layers…" presets of the same dialog.
- **Artboard tool:** draw → `createArtboard(session, { rect })`; preset picker → `{ preset }` (labels via
  `t(preset.name)`); drag title/handles → `moveArtboard` / `resizeArtboard` (use `session.beginEdit`
  around a drag if live preview is wanted, or call once on release); rename in place →
  `renameArtboard`; context menu: duplicate, delete (ask "delete contents?" → `contents`), background
  colour/transparent → `setArtboardBackground`; panel order → `reorderArtboard`. Hit testing:
  `artboardAt(document, point)`. Layers panel grouping: `artboardMembership(document)`.
- **Canvas rendering:** the compositors do not draw artboard backgrounds, frames or names yet; draw
  backgrounds under the composite and frames/titles in the overlay. Exports already include backgrounds.
- **New document from preset:** `createNewProject(w, h)` then `createArtboard(session, { rect: { x: 0, y: 0, width: w, height: h }, name })`.
- Strings to translate: `Artboard`, preset names, `copy`, the ExportError messages.
