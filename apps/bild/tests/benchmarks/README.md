# Core-task benchmarks

These Playwright tests are the scripted E2E half of the PRODUCT-PLAN.md §7.2 / A9 core-task benchmarks. Each numbered spec drives the mounted editor through its real UI, checks a pixel or document-structure outcome for every completed part, and then either completes or throws at the first unavailable capability.

The deliberate failure helper reports:

```text
MISSING CAPABILITY: <capability> (PRODUCT-PLAN.md §7.2, task <n>).
```

These failures are the backlog signal. They must not be replaced by `test.fail()`, skips, or placeholder assertions. When a capability lands, extend that workflow through the new UI, assert its result, and move or remove the `missing()` call.

## Running

The benchmark project exists only when `E2E_BENCHMARKS=1`, so the normal `chromium` project never discovers this intentionally red suite.

```sh
PLAYWRIGHT_BROWSERS_PATH=/home/oem/.local/share/fernwork-compositor-lab/browser-cache \
E2E_PORT=5381 \
E2E_BENCHMARKS=1 \
npx playwright test --project=benchmarks
```

There is one `.spec.ts` file per plan task. `scenarios.ts` holds the workflows, while `benchmark-helpers.ts` contains only test-fixture generation, UI-driving helpers, result readers, and the intentional failure helper.

## Inputs and network policy

The committed suite generates all raster inputs procedurally at run time. This includes the Adobe RGB TIFF: its pixels and embedded ICC profile are generated locally, and the PSDs of tasks 4 and 5, which are written in Node with the `ag-psd` writer (a Smart Object with an embedded PNG, a point-text layer). No benchmark makes a network request for an input or model.

Task 7 needs the pinned SlimSAM object-selection model. The editor downloads it from huggingface.co only after the user clicks *Download model*; the benchmark answers those requests with local files through `page.route` (from `FERNWORK_SLIMSAM_DIR`, else the first `/tmp/slimsam.*` folder holding `encoder.onnx` and `decoder.onnx`). Without the files the object-selection step is reported as **skipped** (`ENVIRONMENT-SKIPPED` in the skip reason), never as passed.

Future photographic cases may use only the upstream project's own official-site examples in:

```text
/home/oem/Dokumente/003_Projekte/17_fernwork/research/compositor-port/references/official-site
```

If those files are used, the spec must fail clearly when the pinned reference checkout is absent; it must not silently skip. Third-party photos or unlicensed fixtures must not be added.

## Status meaning

- `green`: the whole core task currently completes and its final output is asserted.
- `red — expected missing capability`: completed UI steps passed and `missing()` identified the first unavailable step.
- `red — regression`: the test failed before its documented `missing()` line. This is not an expected skeleton failure and must be investigated.
- `red — product bug`: a capability the task needs exists in the UI but produces a wrong result; the failing assertion carries a message naming the expectation, and the bug is written down with a reproduction in `artifacts/benchmarks.md`. Steps after it stay in the scenario so the task continues once the bug is fixed.
- `skipped — environment`: a step needs a local file that is absent (the SlimSAM model for task 7). Not a pass.

The maintained per-task inventory and last observed run are in `artifacts/benchmarks.md`.
