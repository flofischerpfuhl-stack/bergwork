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
