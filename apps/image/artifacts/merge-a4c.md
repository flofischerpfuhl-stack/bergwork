# MERGE-A4C: tile swapping and streaming integration

## Result

Merged `p1-a4c` into `int-a4c` without dropping the integration branch's strict layer model, text/vector rendering, effects, live filters, precision rendering, artboard export, capability hosts, PSD import, 16-bit paths, or project/history fields.

The merged storage path provides tile residency and hydration, 1/8 navigation copies, eviction, browser and Tauri scratch hosts, granular recovery journals, streamed PNG/ZIP64 project I/O, and Lite/Pro limits. Resident rasters retain their plain tile array until the first real eviction; this preserves the fast render path and avoids a WebKit GPU-readback crash while keeping swapped rasters faulting and lazy.

## Conflict decisions

- `src-tauri/Cargo.toml`, `Cargo.lock`, `src/lib.rs`, and `frontend/host.ts`: kept the A0 file/model/font/colour capability registry and added mmap scratch storage, ranged blob reads, streaming sinks, profile selection, and the A4 Tauri commands.
- `src/core/brush/workerClient.ts`: combined sparse tile updates with native `rgba16` worker buffers.
- `src/core/session.ts`: retained the strict text/vector/effect/filter layer model and added command hydration. Hydration includes stored pixels, displayed/derived text and vector pixels, masks, mask sources, live overrides, selection, and history for saves; brush bounds remain regional.
- `src/io/imageImport.ts` and `src/io/tiff.ts`: retained managed colour decoding, browser codecs, ICC conversion, exact 16-bit TIFF handling, and document limits while allowing streamed archive assets to use the same `decodeImageAsset` path.
- `src/io/project.ts`: combined streamed ZIP64/tile-backed open and save with complete document/history snapshots, guides, artboards, fonts, LUT resources, text/vector/effect/filter fields, and non-PNG archive decoding.
- `src/platform/browserHost.ts`: kept the capability registry and file APIs and added OPFS with IndexedDB fallback plus streaming browser file sinks.
- `src/render/gpuCompositor.ts` and `softwareCompositor.ts`: kept the unified CPU/live-filter/effect/vector-mask path and GPU precision textures while adding residency LODs, regional hydration requests, texture budgets, and swapped-tile guards.
- `src/ui/controller.ts`: kept capability-based import/export, PSD, artboards, profiles, and rich rendering; added scratch management, hydration boundaries, streamed saves, granular recovery, and limits. Recovery publishes only the document snapshot it encoded, preventing stale asynchronous journal commits.
- `src/core/storage/tileCache.ts` owns the engine-side scratch contract; `src/platform/scratchHost.ts` re-exports it so platform implementations do not invert the dependency boundary.
- `src/ui/mountEditor.tsx` raises the development resource-timing buffer to 1,000 entries so lazy HEIC/CanvasKit assertions remain observable after the larger merged module graph loads.

## Exported storage/streaming API

- `TileCache(host: TileScratchHost, byteBudget?: number)` and `RasterResidency(cache: TileCache)` in `src/core/storage`.
- `RasterResidency.manage(raster, evictionClass?)`, `ensureResident(rasters, rect?)`, `ensureResidentRegions(regions)`, `persist(rasters)`, and `restore(stored, reduced?, archivedSource?)`.
- `Zip64StreamWriter.add(name, produce)`, `drain()`, `finish(type?)`, and `readZipEntries(blob)` in `src/io/zipStream.ts`.
- `PngTileStreamDecoder.push(chunk)`, `idle()`, `finish()`, `restoreStreamedPng(...)`, and `convertStreamedPng(...)` in `src/io/pngStream.ts`.
- `writeArchiveStreaming(document, name, activeLayerId, residency?, history?, emitChunk?)` and tile-backed `readArchive(...)` in `src/io/project.ts`.
- `RecoveryStore.putState(record, residency, isCurrent?)` returns `Promise<boolean>` and publishes a granular state only if it is still current.

## Combined-path tests

- Command hydration includes derived text/vector pixels and their effect/filter inputs.
- Streamed save/open round-trips guides, a retained TIFF-origin layer, text, an effect, `rgba16` pixels, resources, and history exactly.
- Granular recovery preserves guides and refuses to publish a stale document snapshot.
- Under-budget rasters stay on resident array storage; the faulting storage is installed on first eviction and exact pixels hydrate again.
- Existing A4 tests cover tile LRU priorities, overlays, `TileNotResidentError`, regional brush hydration, reduced copies, PNG tile decoding, ZIP64, recovery journals, limits, and streaming saves.

## Verification

- `npx tsc --noEmit -p .`: exit 0.
- `npx vitest run tests/unit --maxWorkers=2`: **70 files passed; 590 tests passed** (36.74 s).
- `source ../scripts/tauri-env.sh && cargo check && cargo test`: check passed; **5 passed, 0 failed**; main/doc targets had 0 tests.
- Chromium full suite (`--workers=2`): **289 passed, 1 skipped** (13.3 min).
- Combined Firefox/WebKit one-worker run: Firefox completed without failures; WebKit completed all remaining cases but two browser processes closed under cumulative machine load. Both failed cases passed in a fresh WebKit worker (**2 passed**, 36.5 s).
- Final full WebKit-only run (`--workers=2`): **283 passed, 1 skipped** (9.5 min).
- No `test.fail` markers were added.

## Deviations and open issues

- Browser scratch uses OPFS where available and IndexedDB otherwise; Tauri uses mmap-backed native files. These are the closest platform equivalents to the upstream native storage APIs.
- Browser image/colour/text facilities remain the existing managed codec, LCMS/CanvasKit, and CPU/GPU equivalents where Apple frameworks are unavailable.
- PixiJS still logs its existing warning when a texture source is destroyed while bound to a shader. The warning did not produce a failing final Chromium, Firefox, or WebKit project run; fixing Pixi resource binding is outside this merge.
