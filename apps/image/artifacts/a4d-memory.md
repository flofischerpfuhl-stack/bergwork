# A4D: WebKitGTK memory bound for the 200-MP workflow

Date: 2026-09-25. Branch: `a4d-mem`. Runtime: Linux Tauri release build, WebKitGTK
2.52.6 under Xvfb.

## Result

The complete 20-layer workflow passed in the packaged Linux application: a 20,000 × 10,000
document was created, navigated at fit and 100%, painted on a swapped layer, adjusted, undone and
redone, streamed to a 7,201,409,216-byte `.fwimg`, closed, reopened, and verified at one exact pixel
in each of the 20 raster layers. Peak aggregate RSS of the application process tree was
**4,606,164,992 bytes (4.29 GiB)**, below the 8-GiB acceptance ceiling. Peak aggregate PSS was
4,377,316,352 bytes (4.08 GiB).

The test started with 35,628,552,192 bytes free. Its disk floor was 21,524,602,880 bytes, above the
required 10 GiB. The isolated 6.49-GB scratch file, 7.20-GB archive, cache, and config directory were
deleted by the driver; free space returned to 33 GiB.

## Diagnosis

The A4c generator called `crypto.subtle.encrypt` for every tile. In WebKitGTK 2.52/JSC the returned
large ArrayBuffers survived ordinary collection even after their bytes had been copied into raster
tiles. The old run's Web content process rose from about 2.7 GB, to 4.9 GB at 1.3 GB of scratch, to
16.4–17.0 GB while scratch was still near 2 GB. A later pressure collection reduced it to about
7 GB at 4.2 GB of scratch, but it again reached WebKit's 16,384-MB kill threshold near 6.3 GB of
scratch. This retention, combined with the old 4-GiB tile cache and 4096-pixel texture chunks, was
the primary OOM cause.

The following observations ruled out the other suspected primary causes:

- `performance.memory` is absent in this WebKitGTK build. The replacement measurements are
  once-per-second recursive process RSS/PSS and anonymous/file/shared RSS, plus explicit engine
  tile and WebGL texture counters at every workflow stage.
- There is no separate WebKit GPU child in this configuration (`gpu_rss_bytes` remained zero);
  texture memory is charged to `WebKitWebProcess`.
- The native shell stayed near 200–219 MB while scratch grew beyond 6 GB. Thus mmap file size was
  not being charged as an accumulating resident working set. Removing per-tile synchronous mmap
  flushes reduced dirty-page churn without weakening journal durability: `scratch_flush` still
  syncs data and the index before commit.
- During streamed save, archive growth from zero to 7.20 GB left RSS roughly flat; bounded native
  chunks therefore do not retain the whole Blob or IPC history.
- A diagnostic save failure exposed a separate startup race: recovery garbage collection could
  delete a newly evicted tile because `mountEditor` returned before its initial sweep finished.
  Mount now waits for the sweep, but not for a recovery prompt. Concurrent persistence of the same
  immutable tile is also coalesced.

## Changes

- `src/platform/runtimeMemory.ts` exports
  `webKitGtkMemoryBudgets(userAgent): RuntimeMemoryBudgets | null` and the WebKitGTK constants.
  Linux WebKitGTK uses a 512-MiB decoded-tile cap, 512-MiB texture cap, and 1024-pixel texture
  chunks. Chromium and non-Linux WebKit return `null` and retain their previous defaults.
- `src/platform/scratchHost.ts`, `src/ui/controller.ts`, and `src/render/gpuCompositor.ts` propagate
  the optional texture-chunk setting. Changing chunk size destroys old slots first. On the
  constrained host, viewport refinement is tracked separately from content work so save can begin
  after edit/storage resolution without waiting for unrelated compositor hydration.
- `src/platform/largeDocumentAcceptance.ts` replaces the per-tile WebCrypto generator with one
  64-MiB deterministic xorshift pattern bank. Tiles receive unique headers and repeat only beyond
  PNG's 32-KiB deflate window. It also reports tile, scratch, texture, and optional JS-heap counters
  for each stage.
- `src-tauri/frontend/host.ts` applies the Linux-WebKit budgets, bounds archive IPC writes to
  256 KiB, supplies the acceptance save target without a native dialog, and supports fail-fast
  acceptance errors. `src-tauri/src/scratch.rs` copies scratch reads directly from temporary mmaps
  into one response allocation and relies on explicit flush for durability.
- `src/core/storage/tileCache.ts` coalesces simultaneous writes for one content hash and reports
  expected and observed lengths on a bad scratch read.
- `src/ui/mountEditor.tsx` and `src/ui/controller.ts` expose/await
  `EditorController.whenRecoveryReady(): Promise<void>` for the destructive startup sweep while
  allowing any recovery dialog to remain asynchronous.
- `tests/performance/large-document-tauri.sh` is the disk-safe release driver. It samples the full
  descendant process tree and process roles to CSV, enforces the 10-GiB disk floor, and removes all
  isolated scratch/archive data on every exit. The existing Chromium driver now explicitly mounts
  the Pro profile.

`src-tauri/frontend/main.ts` and `src-tauri/src/lib.rs` add acceptance-only stage/result plumbing.
No runtime network call, dependency, UI layout, shared contract, or project-format change was added.

## Memory curves

The A4c pre-fix curve did not complete. Its final sampler summed only direct children and therefore
over-counted shared pages; its reported conservative peak was 26,255,628 KiB RSS. The useful
per-process points from the log are shown as approximate Web content RSS:

| A4c pre-fix point | Scratch | Web content RSS | Outcome |
| --- | ---: | ---: | --- |
| early creation | — | 2.7 GB | growing |
| creation | 1.3 GB | 4.9 GB | growing |
| retained WebCrypto buffers | ~2.0 GB | 16.4–17.0 GB | pressure threshold |
| after pressure collection | 4.2 GB | ~7 GB | temporary recovery |
| navigation | ~6.3 GB | >16.6 GB | Web process killed; no save |

The A4D sampler recursively enumerates the entire application process tree and uses `smaps_rollup`
for PSS. Representative post-fix points are:

| Post-fix point | Elapsed | Scratch | Archive | Aggregate RSS | Aggregate PSS |
| --- | ---: | ---: | ---: | ---: | ---: |
| start | 0 s | 0 | 0 | 103,247,872 | 55,234,560 |
| layer 1 | 57 s | 223,674,368 | 0 | 1,609,392,128 | 1,389,349,888 |
| layer 5 | 319 s | 3,434,455,040 | 0 | 2,515,914,752 | 2,302,855,168 |
| layer 20 | 519 s | 5,835,697,152 | 0 | 2,209,517,568 | 1,989,388,288 |
| fit navigation | 541 s | 5,863,156,736 | 0 | 2,992,771,072 | 2,790,975,488 |
| 100% navigation | 581 s | 5,981,915,136 | 0 | 3,038,859,264 | 2,830,355,456 |
| streaming save | 1,026 s | 6,486,913,642 | 4,985,340,544 | 3,010,961,408 | 2,786,320,384 |
| archive complete | 1,258 s | 6,486,913,642 | 7,201,409,216 | 2,888,892,416 | 2,660,019,200 |
| peak, early reopen | 1,290 s | 6,486,913,642 | 7,201,409,216 | **4,606,164,992** | **4,377,316,352** |
| verification complete | 2,121 s | 6,486,913,642 | 7,201,409,216 | 3,524,390,912 | 3,303,301,120 |

At the peak, the native shell was 215,883,776 bytes RSS, Web content 4,337,049,600 bytes, network
53,231,616 bytes, and GPU child zero. The engine counters stayed bounded: decoded tile residency was
about 537 MB; fit navigation used 535,335,260 texture bytes in 82 chunks; final texture residency
was 462,882,672 bytes in 100 chunks. WebKit exposed no JS-heap counter.

## Workflow timing and correctness

| Measurement | Linux Tauri/WebKitGTK post-fix |
| --- | ---: |
| Logical layer pixels | 1,600,000,000 |
| Create/import | 518,640 ms |
| Fit navigation p95 | 1,659 ms |
| 100% navigation p95 | 2,145 ms |
| First-stroke hydration | 166 ms |
| Stroke commit | 7,587 ms |
| Adjustment + undo/redo | 22 ms |
| Streaming save | 663,380 ms |
| Streaming reopen | 864,634 ms |
| Exact reopened samples | 20/20 |

The memory/OOM gate passes. The navigation and stroke timings remain outside the separate Pro
latency gates; A4D does not claim those performance gates are fixed.

## Verification

- `npx tsc --noEmit -p .`: passed, exit 0 (no output).
- `npx vitest run tests/unit`: **79 files passed, 646 tests passed**, 38.06 s.
- Storage/journal E2E (`journal.spec.ts` and `recovery.spec.ts`) with the requested browser cache,
  port 5921, and `/tmp/pw-out-a4d`: **12 passed** across Chromium, Firefox, and WebKit, 56.2 s.
- `cargo test --manifest-path src-tauri/Cargo.toml`: **6 passed, 0 failed**; main/doc targets had
  zero tests and passed.
- `scripts/tauri-build.sh`: release binary plus DEB/RPM bundles built successfully.
- Packaged Tauri acceptance: completed with 20/20 pixel samples and the memory figures above.
- Chromium 200-MP comparison: completed with 20/20 pixel samples, 6,846,148,608-byte peak RSS,
  and automatic deletion of its isolated OPFS profile/archive.

An additional, non-required combined run included `large-save.spec.ts`; its Chromium case completed
the project save but exceeded that spec's 240-second whole-test timeout before opening its export
dialog on the concurrently loaded machine. The focused required storage/journal matrix was then run
cleanly as reported above.

## Source correspondence, deviations, and open issues

This is PRODUCT-PLAN A4/A6 host and storage work with no direct upstream Swift/C implementation to
port. Existing raster, history, brush, PNG, and project semantics were not changed. mmap scratch,
binary Tauri IPC, JSC-aware allocation patterns, and explicit WebGL residency are platform
equivalents for facilities not present in the upstream macOS implementation.

WebKitGTK offers neither Chromium's `performance.memory` nor a usable packaged-app remote heap
endpoint in this environment, so retained JS allocations cannot be split by constructor in the
report. The controlled generator change, process curve, cache counters, and absence of native/mmap
growth identify WebCrypto ArrayBuffer retention as the primary cause, but this is an inference from
those measurements rather than a JSC heap snapshot.

The current deterministic-generator Chromium run completed the same workflow with 20/20 exact
samples. It used 6,846,148,608 bytes peak RSS, 8,253,304,832 bytes summed `VmHWM`, a 1,610,548,480-
byte decoded-tile working set, and a 20,146,180,096-byte disk floor. Chromium's
`performance.memory` reported 116 MB used/123 MB total during creation and 2.06 GB used/total after
save and reopen. Its process-tree peak is 2.24 GB above the optimized Tauri/WebKitGTK peak, primarily
because the browser driver deliberately retains the existing 1.5-GiB decoded-tile budget.

| Runtime/workflow | Peak RSS | High-water/PSS | Completed | Exact pixels |
| --- | ---: | ---: | --- | ---: |
| A4c WebKitGTK, old generator | >16.6 GB Web content; 26,255,628 KiB conservative sum | 26,299,980 KiB conservative summed `VmHWM` | no, killed before save | 0 |
| A4d WebKitGTK, current generator | **4,606,164,992** | **4,377,316,352 PSS** | yes | 20/20 |
| A4d Chromium, current generator | 6,846,148,608 | 8,253,304,832 summed `VmHWM` | yes | 20/20 |
| A4c Chromium, old generator | 6,718,218,240 | 7,961,321,472 summed `VmHWM` | yes | 20/20 |

The current Chromium run shared the machine with other browser workloads. Its memory counters are
isolated to its own process tree, but its timings (456,190-ms creation, 1,004,380-ms save,
477,918-ms reopen) are not suitable for latency comparison. The successful run confirms that the
WebKit-specific product budgets do not alter Chromium defaults or correctness.
