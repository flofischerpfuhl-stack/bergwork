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

The committed suite generates all raster inputs procedurally at run time. This includes the Adobe RGB TIFF: its pixels and embedded ICC profile are generated locally. No benchmark makes a network request for an input or model.

Future photographic cases may use only the upstream project's own official-site examples in:

```text
/home/oem/Dokumente/003_Projekte/17_fernwork/research/compositor-port/references/official-site
```

If those files are used, the spec must fail clearly when the pinned reference checkout is absent; it must not silently skip. Third-party photos or unlicensed fixtures must not be added.

## Status meaning

- `green`: the whole core task currently completes and its final output is asserted.
- `red — expected missing capability`: completed UI steps passed and `missing()` identified the first unavailable step.
- `red — regression`: the test failed before its documented `missing()` line. This is not an expected skeleton failure and must be investigated.

The maintained per-task inventory and last observed run are in `artifacts/benchmarks.md`.
