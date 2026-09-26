# Change-relevant E2E sets

Recorded 2026-09-26 on Linux/Xvfb. The complete `npm run test:e2e` command is unchanged; these commands are the short feedback paths used while the product is still under active development.

## Commands

| Command | Selection |
| --- | --- |
| `npm run test:e2e:smoke -- --workers=2` | Six fixed specs / 22 Chromium tests: application and lazy-feature start-up, import plus project save/reopen, image export, a real brush workflow, live adjustments, layered PSD save, and German export labels. |
| `npm run test:e2e:changed -- --base <ref> --workers=2` | Areas whose source globs or E2E specs match the merge-base-to-`HEAD` diff, tracked working-tree changes, or untracked files. The default ref is `integration`. |
| `npm run test:e2e:area -- --area painting,retouch --workers=2` | One or more explicit named areas. |
| `npm run test:e2e:gate -- --workers=2` | Smoke plus change-selected specs in one Playwright invocation. It always retains all smoke specs and caps the union at 24 files; every omitted file is printed. |

All arguments not consumed by `scripts/e2e-select.mjs` are passed to Playwright, including `--project`, `--workers`, `--grep`, and `--output`. Add `--dry-run` to print the selection without starting Playwright. An unknown area or missing mode exits with status 2. If Git/ref lookup is unavailable, or no changed path maps to an area, changed selection explicitly falls back to smoke.

The versioned manifest is `tests/e2e/areas.json`. Its 16 areas may overlap where a source change has real cross-cutting risk. A unit test requires every `tests/e2e/*.spec.ts` file to belong to at least one area, rejects stale spec entries, and requires every top-level source directory under `src/` to occur in at least one source glob.

## Measurements

Both successful runs used:

```text
PLAYWRIGHT_BROWSERS_PATH=/home/oem/.local/share/fernwork-compositor-lab/browser-cache
E2E_PORT=6135
--project=chromium --workers=2 --output=/tmp/pw-out-e2esets
```

| Set | Result | Wall time | `uptime` load at start |
| --- | --- | ---: | --- |
| Smoke | 22 passed | 160.90 s (2.68 min) | 8.97, 8.81, 4.46 |
| Changed sample (`--base HEAD~1`) | 58 passed, 2 skipped | 465.68 s (7.76 min) | 23.97, 15.46, 7.75 |

The sample diff contained `src/app/features.ts`, `src/render/adjustPrograms.ts`, and `tests/e2e/feature-loading.spec.ts`. It selected `canvas-view`, `adjustments-filters`, and `ui-i18n`: 22 spec files, of which Chromium ran 60 tests and skipped two. This remains below the 12-minute gate budget even under substantial concurrent load. The combined gate was not timed separately; for broad diffs its deterministic 24-file cap bounds the run and reports the skipped tail for a later area/full-suite run.

One initial smoke invocation omitted `PLAYWRIGHT_BROWSERS_PATH`; all 22 browser launches failed before reaching the application in 16.81 s. It is excluded from the successful measurements above.

Firefox/WebKit and the full suite were not run for this infrastructure-only change; central integration runs retain responsibility for those complete matrices.
