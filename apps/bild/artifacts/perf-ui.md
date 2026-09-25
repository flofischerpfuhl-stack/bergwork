# React UI and main-thread performance audit

Date: 2026-09-25
Scope: `src/ui/**` subscriptions, panels, menus, dialogs, layer thumbnails and pointer-driven UI updates. Pixel/compositor algorithms were not changed.

## Method

`src/ui/performance.ts` adds an opt-in development audit API (`window.__editorUiPerformance`) with counters for named React components, session/workspace notifications, thumbnail renders/draws/cache builds, and `PerformanceObserver` long tasks over 50 ms. It does no work until a test calls `start()`.

`tests/e2e/perf-ui.spec.ts` creates an 80-layer document and measures 24 pan notifications, 20 opacity ticks, 20 brush samples, a tool switch, a menu open, a Layers/History round trip, a project-tab round trip and a dialog open. It waits for the Lite profile's lazy registrations before sampling. The test also checks the resulting opacity and a changed brush pixel; it does not generate an oracle from the pixels it compares.

Runs used one worker, port 6113, `/tmp/pw-out-perfui-*`, and the shared browser cache. The machine was busy: recorded load averages ranged from 6.53 to 16.62. Frame figures are therefore directional; render counts are deterministic. Chromium's ordinary project used SwiftShader. A separate `perf-gpu` run used `ANGLE (Intel, Mesa Intel(R) HD Graphics 630 (KBL GT2), OpenGL ES 3.2)`. Playwright WebKit reported `Apple GPU`; under Xvfb it is used only for relative Linux/WebKit numbers. WebKit does not expose the Long Tasks API.

## Findings ranked by expected user-visible gain

1. **Whole-editor subscription fan-out (implemented).** `ProjectWorkspace` relays every non-view session notification. `EditorRoot`, most shell components and `LayersPanel` subscribed to that relay and/or the same session, so one opacity tick rendered the root, shell, all 80 rows and all 80 thumbnail components. Twenty ticks produced 1,600 row plus 1,600 thumbnail renders. Twenty brush samples produced 1,680 of each (the extra render is stroke setup).
2. **Panel switching remounted thumbnails (implemented).** Returning from History to Layers remounted all 80 canvases. Pixel previews were correctly cached (`80 cache hits, 0 builds`), but all 80 canvases were redrawn.
3. **Project-tab switching remains O(layer count) (open).** Switching away from and back to an 80-layer tab renders 81 rows and 81 thumbnail components. Final measurements were 131 ms in WebKit and 194–316 ms in Chromium depending renderer/load; the real-GPU run recorded two long tasks, max 247 ms.
4. **Renderer work, not React, now dominates continuous input (open outside this lane).** After the fixes, pan and brush samples cause zero tracked shell/list renders. The Intel real-GPU run had zero long tasks for pan, opacity, stroke, tool/menu/panel and dialog actions. SwiftShader still emitted long tasks during continuous compositing. WebKit had occasional p95 outliers even with zero UI renders.
5. **Menus are rebuilt on open and position in a second render (open).** An 80-layer document does not change the menu cost, but WebKit menu-open samples ranged from 48 to 65 ms under load. Caching the menu model and avoiding the second position commit is estimated to save 15–30 ms; effort small/medium.
6. **Adjustment execution is already split correctly (no change).** An adjustment-layer slider synchronously replaces immutable adjustment metadata, then the canvas composites on its scheduled frame; it does not synchronously rasterize the full adjustment in the input handler. Destructive Levels/Hue previews run as cancellable worker jobs and discard superseded results. Live-filter metadata still notifies once per tick; animation-frame coalescing may help large documents but needs a separate pixel/latency study.
7. **Thumbnail pixels are not recomputed per frame (confirmed).** A raster preview is built once per raster in a `WeakMap`. Before the fix, component functions ran on every tick but their effects did not redraw. Panel remounts redrew from the cache. After the fix, pan/slider/stroke/tool/panel-switch samples perform zero thumbnail renders, draws or builds.
8. **Translation lookup is not a current hot path (not implemented).** `translator()` performs an object lookup plus platform-key replacement. The expensive multiplication came from unnecessary tree renders. Memoizing translations would now be a sub-millisecond micro-optimization and would add cache state for little visible gain.

## Before/after

The table reports median next-frame latency in milliseconds. Single-action samples (tool/panel) are one observation per iteration; repeated input uses 20 samples. Counts are for the full sampled action.

| Interaction, 80 layers | Chromium before (SwiftShader) | Chromium after (SwiftShader) | WebKit before | WebKit after |
|---|---:|---:|---:|---:|
| Opacity, 20 ticks | 126.4 ms; 1,600 rows + 1,600 thumbs | 48.3 ms under heavier load; 0 + 0 | 69.6 ms; 1,600 + 1,600 | 18.4 ms; 0 + 0 |
| Brush, 20 samples | 108.0 ms; 1,680 rows + 1,680 thumbs | 53.4 ms under heavier load; 0 + 0 | 44.2 ms; 1,680 + 1,680 | 18.9 ms; 0 + 0 |
| Tool switch | 104.0 ms; 80 rows + 80 thumbs | 16.6 ms; 0 + 0 | 48.5 ms; 80 + 80 | 16.2 ms; 0 + 0 |
| History → Layers | 190.4 ms; 80 thumbnail draws | 58.6 ms under heavier load; 0 draws | 88.2 ms; 80 draws | 70.2 ms under heavier load; 0 draws |
| Pan, 24 moves | 2 shell renders/move | 0 shell/list renders | 17.8 ms; 2 renders/move | 17.9 ms; 0 renders |

The final Intel real-GPU run (load average 16.62) measured pan median/p95 17.3/22.3 ms, opacity 17.7/22.3 ms, brush 18.3/48.2 ms, and zero long tasks for those three paths. Tool, menu, panel and dialog also had zero long tasks. Tab switching remained the exception.

A final post-refinement Chromium/SwiftShader gate at load average 9.95–11.67 reconfirmed the deterministic result: pan 24/24, opacity 20/20, brush 20/20 and the panel round trip all produced zero layer-row or thumbnail renders. Its medians were 25.1, 29.4, 28.1 and 62.3 ms respectively; background host contention made the Long Tasks readings unsuitable for comparison.

## Implemented changes

- Added `useSessionSelector` and `useWorkspaceSelector`. Components subscribe to the smallest visual snapshot they need; workspace structure changes still switch every consumer to the correct session.
- Removed the workspace relay from the editor root hot path. A small registered-panel host tracks lazy module registration, preserving asynchronously installed panels and the text/vector lazy UI.
- Split the side-panel chrome from the layer tree. History stays mounted and Layers is hidden with `display: none`/`contents`, so toggling tabs does not reconcile or remount the tree.
- Kept lazy vector/text invalidations explicit. Vector masks, derived vector thumbnails, lazy tool icons and text panels still refresh when their feature module arrives.
- Added a stable measurement/regression spec with real document-state assertions and deterministic render/thumbnail limits.

## Further work

| Finding | Estimated gain | Effort / risk |
|---|---:|---|
| Virtualize the layer list and/or retain a per-tab panel subtree | 70–250 ms on tab switch and much larger wins above a few hundred layers | Medium/high; selection, drag/drop, accessibility tree and thumbnail lifetime need coverage |
| Cache menu models and position without a second React commit | 15–30 ms on WebKit menu open | Small/medium |
| Coalesce live-filter/adjustment metadata changes to one animation-frame update | 5–15 ms on large documents; fewer compositor invalidations | Medium; must preserve final slider value and one undo step |
| Profile WebKitGTK's compositor/presentation after UI isolation | Removes remaining continuous-input p95 outliers if actionable | Other performance lane; high platform risk |
| Cache translated platform-key strings | <1 ms in current steady-state interactions | Small, but intentionally deferred as a micro-optimization |

No new dependency, network behavior, translation key or licence notice was added. Real Tauri/WebKitGTK and real-GPU app measurements were not possible on Xvfb; Playwright WebKit and Chromium `perf-gpu` are the stated proxies.

## Verification

- `npx tsc --noEmit -p .`: clean (no diagnostics).
- `npx vitest run tests/unit --maxWorkers=2`: **91 files passed, 774 tests passed**, duration 62.98 s.
- `perf-ui.spec.ts`: Chromium, WebKit and the Intel `perf-gpu` project each passed with real opacity/brush state assertions and the render-count gates above.
- Directly affected workflows: History, layer locks/fill/search, painting/color picker, and Hue/Saturation adjustment-layer editing passed in Chromium and WebKit. Focused Chromium text creation and vector-mask/thumbnail tests also passed after the final lazy-registration refinement. The first Chromium batch exposed the registered-panel lazy-load regression; the panel host was fixed and the failed color-picker case passed on rerun.
- No full E2E or full cross-browser suite was run in this lane, per the shared-machine test-load rule.
