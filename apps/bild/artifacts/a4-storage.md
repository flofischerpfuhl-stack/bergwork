# A4b storage, residency, and crash recovery

Date: 2026-09-24. Branch: `p1-a4b`.

## Implemented

- Real raster residency underneath stable immutable `Raster` identities. A managed tile is zero,
  resident, or swapped. Indexing `raster.tiles` for a swapped non-zero tile throws
  `TileNotResidentError`; it never returns a fabricated zero tile.
- `RasterResidency` registers content-addressed immutable tiles, builds an always-resident 1/8
  navigation raster before the first eviction, hydrates a tile rectangle, and returns a pin lease.
- The tile cache invalidates all raster/history bindings for an evicted hash, persists bytes only
  once, and chooses unpinned history tiles before hidden, off-screen, then visible tiles. Shared
  visible content inherits the most protected classification.
- GPU and software compositors use the 1/8 raster while full pixels are swapped. Above 1/8 display
  scale they request asynchronous hydration and redraw. At fit zoom they do not request full pixels.
  WebGL chunk textures have a separately configurable LRU byte cap.
- The controller creates one residency/cache service per host, classifies current and history
  rasters, wraps registered menu commands at one hydration boundary, and queues pointer samples
  from pointer-down until the touched command inputs are hydrated. Rasters remain pinned through
  an open history transaction. `isProjectBusy` is raised only if hydration lasts over 150 ms.
- Journal commits now contain JSON document structure and undo/redo command metadata only. Pixel
  tiles and reduced LOD tiles are immutable `tiles/<format>-<sha256>.bin` assets shared with the swap
  store. Recovery reconstructs the current document and history as lazy swapped rasters. Torn tails
  retain the preceding valid commit. Saving/clean close removes the recovery journal.
- OPFS remains the browser primary store. IndexedDB is now the persistent fallback when OPFS is
  absent, so recovery is not Chromium-only.
- Host-selectable limits are enforced at new-document, raster-import, and `.fwimg` archive entry
  points: Lite 100 MP / 30,000 px; Pro 300 MP / 60,000 px. Direct low-level codec calls retain
  their Lite defaults; profile-aware import/archive callers explicitly pass the Pro ceiling.

## Exported API

- `TileNotResidentError(tileIndex: number)`
- `Raster.tileResidency(index): 'zero' | 'resident' | 'swapped'`
- `Raster.hasSwappedTiles: boolean`
- `Raster.reducedCopy: Raster | null`
- `Raster.makeReducedCopy(factor = 8): Raster`
- `RasterResidency.manage(raster, evictionClass?): Promise<StoredRasterTiles>`
- `RasterResidency.restore(stored, reduced?): Raster`
- `RasterResidency.ensureResident(rasters, rect?): Promise<ResidentLease>`
- `RasterResidency.persist(rasters): Promise<void>`
- `ensureResident(residency, rasters, rect?): Promise<ResidentLease>`
- `TileCache.persist(asset): Promise<void>` and `persistedBytes`
- `EditorSession.rastersForCommand(kind): Raster[]`
- `EditorSession.runHydrated(kind, body, rect?): Promise<T>`
- `RecoveryStore.putState(record, residency): Promise<void>`
- `RecoveryStore.recover(record, residency): Promise<RecoveredProjectState>`
- `readArchive(blob, decoder, limits?): Promise<LoadedProject>`
- `ScratchHostCapability.tileBudgetBytes` / `gpuTextureBudgetBytes`

## Source correspondence

This is product-plan A4/P7 infrastructure and has no upstream Swift/C storage implementation to
port. Existing raster immutability and shared history identity continue to follow
`Rendering/RasterSnapshot.swift`, `Rendering/BrushStroke.swift`, and
`Document/DocumentHistory.swift`. The 1/8 LOD is a new browser/desktop-host equivalent of the
existing renderer downsample cache, not an Apple API substitution.

## Tests and measurements

- Unit coverage includes: swapped-index errors, exact hydration, RGBA16 round trip, eviction
  priority, brush/fill/filter/adjustment/transform/clipboard/export input enumeration, granular
  journal replay, torn tail, continuing undo, and Lite/Pro new/import/archive limits.
- `npx tsc --noEmit -p .`: passed (exit 0).
- `npx vitest run tests/unit`: 47 files passed, 408 tests passed.
- `npx vitest run tests/performance/storage.perf.test.ts`: 1 file passed, 1 test passed.
- Granular Chromium kill/reopen: passed; recovered one pixel tile exactly, restored two layers and
  undo reduced them to one; recorded age remained under 5 seconds.
- Scaled cache transition benchmark (the inherited CI-safe benchmark): logical 20 × 200 MP layer
  dimensions, 80 incompressible RGBA tiles, 1 MiB cache, 50 frames × 12 loads: p95 4.98 ms,
  262,144 resident bytes, 20,971,520 persisted bytes. This is not the required real 200 MP run.
- Disk preflight before large-work consideration: `/` had 26 GiB free. No large scratch data was
  created, so no cleanup was required.
- Tauri Rust scratch tests with `source ../scripts/tauri-env.sh`: 2 passed, 0 failed.
- `E2E_PORT=5451 npx playwright test tests/e2e/journal.spec.ts --project=chromium`: 1 passed.
- The full Chromium suite was executed: 61 passed, 1 skipped, 5 failed. Four failures are the
  integration-base workspace tab-query drift described below; the fifth is the software/GPU pixel
  tolerance described below. A stable focused rerun reproduced that tolerance failure.

## Shared-file hooks

The owned implementation required small coordinated hooks in `src/core/document.ts`,
`src/core/history.ts`, `src/core/session.ts`, and the `src/io/{imageImport,png,tiff,gif,webp,avif,project}.ts`
entry points. They add profile limits, keep swapped tiles out of synchronous history byte accounting,
expose one session hydration boundary, and propagate the selected profile into pre-allocation codec
checks. No React component or shared contract file was changed.

## Deviations and open work

- The required real 20,000 × 10,000, 20-layer Chromium and packaged-Tauri workflow was **not run**.
  Therefore peak RSS/VmHWM, real scratch bytes, fit-zoom p95, stroke hydration latency, adjustment,
  save, and reopen figures are not available. The scaled benchmark must not be treated as proof of
  the 1.5 GiB acceptance target.
- Pointer dispatch currently pins the complete command-input rasters, rather than converting the
  selection/document bounds into each raster's local tile rectangle. This is correct but can make a
  first stroke on a very large swapped layer slower and larger than the product design intends.
- Save/export now enter the same hydration boundary and therefore never mistake swapped tiles for
  zeroes. However, the existing PNG/archive encoders still require contiguous full-raster buffers;
  they are not tile-streaming encoders. A project whose simultaneously encoded inputs exceed the
  RAM budget can therefore exceed the intended working set, another reason the real 200 MP save
  workflow remains unproven.
- The compositor fallback is progressive per raster, not per mixed resident/swapped region: while
  any required tile is absent it draws the 1/8 raster for that raster. This avoids holes and keeps
  fit navigation hydration-free, but temporarily sacrifices sharp already-resident regions.
- Existing synchronous layer thumbnails are outside this lane's React ownership. Recovery pins up
  to 64 MiB for the first thumbnail render; thumbnails for a recovered document with more than
  64 MiB of full-resolution tiles still need a future LOD-aware thumbnail hook.
- The journal shares tile assets globally and removes/compacts commit files on save/clean close, but
  it does not yet garbage-collect content-addressed tile/resource files no longer referenced by any
  journal or live document.
- Firefox and WebKit kill-test execution was attempted, but their Playwright executables are absent
  from this machine. The IndexedDB fallback is unit/type checked but not browser-executed here.
- The integrated branch has pre-existing E2E drift: workspace tests use unscoped `role=tab` queries
  and now count the separately merged Layers/History panel tabs; one software-vs-GPU run also
  exceeded its existing >3-byte ratio tolerance (0.00227 vs 0.001). These files are outside A4b's
  ownership and were not changed.

---

# A4c regional residency, streaming project I/O, and 200-MP acceptance

Date: 2026-09-24. Branch: `p1-a4c`.

## Implemented

- Brush, eraser, clone/heal, and other pointer dispatch now map each growing dab rectangle (including
  the tool's kernel margin) from document space into every command-input raster's local tile grid.
  Only intersecting tiles are hydrated and pinned. Fill, filters, adjustments, clipboard operations,
  and exports retain their whole-raster or selection-bounds hydration rules.
- Residency registration is atomic and de-duplicated. Rapid worker-backed strokes cannot replace a
  successor's raster with a stale predecessor. Brush worker results are sparse tile overlays, so a
  dab on a swapped 200-MP raster neither clones nor hydrates the untouched tiles.
- PNG encoding consumes one 256-row tile band at a time, filters and deflates it incrementally, and
  releases its lease before the next band. ZIP64 entries and the host file sink receive bounded
  chunks. The matching reader uses the ZIP central directory for exact entry byte ranges and decodes
  PNG scanlines directly into scratch-backed tiles. This avoids both a contiguous raster and an
  in-memory archive, and avoids false data-descriptor matches in incompressible payloads.
- Existing v1/v2 archives remain readable and the archive layout is unchanged. New streamed ZIP64
  archives are standard archives readable by the synchronous compatibility decoder. Document and
  per-asset Pro/Lite limits remain enforced; the canvas pixel limit is no longer incorrectly applied
  to the sum of all streamed layers, which would make the specified 20-layer acceptance file invalid.
- The compositor draws the reduced raster first and overlays every resident full-resolution tile;
  only missing regions stay at reduced resolution. GPU readback/export waits for the controller's
  fully-resolved barrier. Thumbnails use the reduced copy while full tiles are swapped and do not pin
  a 64-MiB full-resolution region.
- Recovery garbage collection retains keys referenced by every journal and live workspace document,
  and removes other content-addressed tile/resource files on start, save, and close.
- Chromium OPFS and Tauri use sequential file sinks for project saves. Tauri project reads expose
  bounded random-access slices backed by 1-MiB native reads. The Tauri release-only acceptance entry
  uses a 4-GiB tile budget and a caller-selected scratch/archive path.

## Exported and extended API

- `Raster.withTileUpdates(updates): Raster`
- `Raster.hasSwappedTilesIn(rect?): boolean`
- `Raster.archivedSource: ArchivedSource | null`
- `Raster.tileOverlay: RasterTileOverlay | null`
- `RasterResidency.ensureResidentRegions(regions: Iterable<RasterRegion>): Promise<ResidentLease>`
- `RasterResidency.referencedKeys(rasters: Iterable<Raster>): Set<string>`
- `EditorSession.rasterRegionsForCommand(kind, documentRect): { raster: Raster; rect: Rect }[]`
- `encodePngBandStream(width, height, channels, readBand, emit, options): Promise<void>`
- `encodePngRasterStream(raster, emit, options): Promise<void>`
- `writeArchiveStreaming(document, name, activeLayerId, residency?, history?, emitChunk?): Promise<{ blob; manifest }>`
- `readArchive(blob, decoder, limits?, residency?): Promise<LoadedProject>`
- `PngTileStreamDecoder`, `restoreStreamedPng`, and `convertStreamedPng`
- `Zip64StreamWriter` and `readZipEntries(blob): AsyncGenerator<StreamedZipEntry>`
- `prepareStreamingSha256(): Promise<() => StreamingSha256>`
- `RecoveryStore.collectGarbage(liveKeys?): Promise<number>`
- `FileTargetHost.openFileSink(target): Promise<FileByteSink> | null`
- `EditorController.isFullyResolved` and `whenFullyResolved(): Promise<void>`
- `runLargeDocumentAcceptance(controller, io): Promise<LargeDocumentMetrics>`

The implementation is in `src/core/{raster,session,storage/rasterTiles}.ts`, the brush/heal and
pointer dispatch modules, `src/io/{png,pngStream,project,sha256,zipStream}.ts`, recovery/browser and
Tauri hosts, both compositors, `src/ui/Thumbnail.tsx`, and the controller. No contract file was
changed. The only UI-owned change is the requested thumbnail data-source selection; it has no visual
layout or styling change.

## Source correspondence

A4/P7 residency, streaming I/O, and recovery are new product-plan requirements and have no direct
upstream storage implementation. Raster immutability and stroke/history transitions continue to
follow upstream `Rendering/RasterSnapshot.swift`, `Rendering/BrushStroke.swift`, and
`Document/DocumentHistory.swift`. Existing brush/heal formulas and C kernels were not replaced.
Incremental PNG/ZIP, OPFS/IndexedDB, and mmap scratch are browser/host equivalents rather than ports
of CoreGraphics/ImageIO APIs.

## Regression and compatibility tests added

- Sparse brush overlays leave untouched source tiles swapped.
- Overlapping residency registration preserves two rapid strokes as ordered undo steps.
- Recovery GC removes only unreferenced content-addressed files.
- A Pro brush starts on a 200-MP canvas without charging unrelated layers.
- The document pixel ceiling applies per canvas/asset, not to the sum of layers.
- A descriptor signature embedded in a stored ZIP asset cannot truncate the entry.
- An incompressible PNG split at 4-MiB input boundaries decodes exact rows and pixels.
- Synchronous old and tile-band new archives open in both compatibility directions.
- Old and new PNG entries open directly into swapped tiles without a contiguous pixel raster.
- Forced IndexedDB kill/recovery has the same under-five-second durability as OPFS.
- The integrator regressions are covered and pass: rapid worker brush strokes, brush followed by
  eraser, and software/WebGL pixel comparison.

## Verification results

- `npx tsc --noEmit -p .`: passed (exit 0, no output).
- `npx vitest run tests/unit`: **48 files passed, 418 tests passed**, duration 20.18 s.
- `npx vitest run tests/performance`: **3 files passed, 10 tests passed**, duration 7.28 s.
- Full Chromium E2E with the required cache, port 5471, and `/tmp/pw-out-a4c`:
  **67 passed, 1 skipped**, duration 3.7 min.
- Firefox + WebKit E2E with `E2E_ALL_BROWSERS=1`: **123 passed, 1 skipped**, duration 6.2 min.
  The kill test passed in Chromium, Firefox, and WebKit; forced-OPFS-off IndexedDB recovery also
  passed in each project.
- `bash scripts/tauri-build.sh --no-bundle`: release build passed; binary produced at
  `src-tauri/target/release/fernwork-bildeditor`.
- `cargo test --manifest-path src-tauri/Cargo.toml`: **2 passed, 0 failed**; main and doc-test targets
  contained zero tests and passed.

## Real 200-MP Chromium measurement

The deterministic generator created five 20,000 × 10,000 incompressible RGBA layers and fifteen
10/20/30%-width layers one at a time, immediately registering/swapping each. Total logical layer
pixels were 1,600,000,000 (6.4 GB raw); no array containing all layers was retained by the generator.
Chromium used OPFS and a 1.5-GiB tile budget. The archive and profile were deleted after the run;
the disk floor stayed above 10 GB.

| Measurement | Result |
| --- | ---: |
| Create/import | 351,303.2 ms |
| Peak summed RSS | 6,718,218,240 bytes |
| Summed `VmHWM` | 7,961,321,472 bytes |
| Scratch bytes | 6,160,000,000 bytes |
| Resident tile bytes | 1,610,466,304 bytes |
| Disk free floor | 26,074,509,312 bytes |
| Fit pan/zoom p95 (8 samples) | 10,792.3 ms |
| 100% pan p95 (8 samples) | 11,247.0 ms |
| First-stroke regional hydration | 48.7 ms |
| Remaining stroke/commit | 71,966.2 ms |
| Adjustment + undo/redo | 30.6 ms |
| Streamed save | 469,666.7 ms |
| Streamed close/reopen | 286,596.0 ms |
| Archive size | 7,201,434,624 bytes |
| Reopened sample verification | 20/20 exact |

The complete create, fit navigation, 100% navigation, swapped-layer stroke, adjustment, undo/redo,
save, close, reopen, and exact pixel verification workflow passed without OOM. **The 33-ms pan/zoom
p95 gate did not pass.** Playwright's headless Chromium used SwiftShader on this host; the measured
fit and 100% p95 values above must not be reported as acceptance passes.

## Packaged Linux Tauri measurement

The release binary was launched under Xvfb with a 4-GiB tile budget and isolated native mmap scratch.
The deterministic document reached a 6.3-GB scratch file and entered navigation, but WebKitGTK killed
its web process before save with:

`Unable to shrink memory footprint of process (16607 MB) below the kill thresold (16384 MB). Killed`

The once-per-second sampler observed a conservative peak of 26,255,628 KiB RSS and 26,299,980 KiB
summed `VmHWM` for the app and its direct WebKit children (including the small network process).
No archive was produced, so Tauri save, reopen, archive-size, and pixel-verification results do not
exist. The isolated scratch/cache and any partial archive were deleted, restoring 37 GB free disk.
Consequently the packaged-Tauri portion of the 200-MP acceptance **failed** on this machine.

## Deviations and open issues

- The implementation passes the requested correctness matrix, but A4c as a whole is not an
  acceptance pass: Chromium misses the 33-ms navigation gate under SwiftShader and Tauri is killed
  by WebKitGTK memory pressure. Hardware-accelerated measurements and WebKit working-set reduction
  remain required.
- PNG uses filter `None` and fflate level 1 so each band can be emitted and released promptly. Pixel
  bytes and the project format are unchanged, but archives can be larger than the old whole-image
  adaptive encoder; the measured incompressible archive is 7.20 GB.
- Direct file targets never create a full archive Blob. Browser engines without a writable file
  target still require a Blob for a download because the public download API has no streaming sink.
- ZIP central-directory metadata is bounded to 64 MiB and held in memory; entry payloads and PNG
  pixels are streamed. This is independent of archive size and bounded by the existing layer/path
  limits.
- A sparse painted overlay inherits its source reduced copy. Until a future reduced-copy refresh,
  a swapped thumbnail or missing compositor region can briefly show the pre-stroke reduced pixel;
  full resident tiles remain exact.
- PixiJS logged warnings when a texture source was evicted while still bound. Pixel-comparison suites
  pass, but cleaning up the binding before destruction would remove the warning and may reduce the
  WebKitGTK peak.
