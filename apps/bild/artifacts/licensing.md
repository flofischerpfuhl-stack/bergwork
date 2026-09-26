# Licensing and dependency transparency

Date: 2026-09-26  
Lane: LIC (`p3-lic`)

## Delivered

- The repository license is Business Source License 1.1 with Fernwork's unchanged Licensor, Additional Use Grant,
  Change Date, Change License, and contact details. `package.json` declares `BUSL-1.1`; the Tauri crate points to the
  repository `LICENSE` with `license-file = "../LICENSE"`.
- `CLA.md` and `LICENSING.md` provide the same contribution and plain-language licensing terms as Fernwork.
- `npm run notices` now generates:
  - `THIRD_PARTY_NOTICES.md` from 44 installed production npm packages, all 483 locked Rust/Tauri crates (including
    target-specific crates), and 19 curated vendored/download/host components;
  - `LICENSES/THIRD_PARTY.md` plus 20 complete applicable licence-text files;
  - `public/licenses.json`, with 546 entries using the requested `bundled`, `optional-download`, `opt-in-host`, and
    `tauri-runtime` categories. Model entries include their immutable download URL and SHA-256 from
    `MODEL_LICENSES.md`.
- `npm run check:licenses` reconstructs the graphs and fails for a missing/stale inventory entry, missing/incomplete
  full text, unknown/disallowed licence expression, misplaced MPL-2.0/Unicode-3.0 dependency, bundled LGPL dependency,
  or unaccounted vendored runtime file.
- Help > About > Licences opens a lazy-loaded, searchable English/German inventory. It shows the Bildeditor's BSL 1.1
  free-tier summary, groups every dependency by category, and lazy-loads the selected full text without network
  access. The existing Preferences surface also links to the same view.

## Decisions

- The Rust inventory uses every package resolved in `Cargo.lock` rather than only the current Linux target. That makes
  Windows/macOS target crates visible before those binaries are produced.
- SPDX `OR` expressions use one permitted licensing path for the displayed full text; `AND` expressions concatenate
  every required full text. The original complete SPDX expression remains visible in notices, JSON, and UI.
- MPL-2.0 and Unicode-3.0 are accepted only for `tauri-runtime`. LGPL-2.1/3.0 is accepted only for the explicitly
  non-bundled `opt-in-host` entries (LibRaw, libheif, libde265).
- Full texts are lazy Vite chunks. `licenses.json` is the only eagerly fetched licensing asset, and it is fetched only
  when the user opens the view.

## Minimal shared-file changes

- `package.json` / `package-lock.json`: root licence metadata and the checker command only.
- `src-tauri/Cargo.toml`: replaced the former MIT declaration with the repository licence file.
- `src/ui/store.ts`, `src/ui/Dialogs.tsx`, `src/ui/controller.ts`: added the two dialog kinds, lazy imports, and open
  methods; the former long About dependency paragraph moved into the generated searchable view.
- `src/app/rawFeature.tsx`: added one Preferences button for the licences view.
- `src/ui/i18n.ts`: appended only new, previously absent keys; no existing key was changed or re-added.
- `tests/e2e/areas.json`: assigned the new spec to `ui-i18n`.

## Differences from Fernwork's source files

There are no differences other than product-name applicability:

- `LICENSE`: the three-line `Licensed Work` value is exactly
  “Fernwork Bildeditor (image editor), including the web application, the desktop applications and all other source
  code in this repository.” The Licensor, grant, Change Date, Change License, and remainder are byte-for-byte the
  Fernwork text.
- `CLA.md`: the common project list adds “Fernwork Bildeditor”.
- `LICENSING.md`: the opening product name and hosted-service example say “Fernwork Bildeditor”.

The copied `LICENSING.md` therefore intentionally retains Fernwork's existing generic third-party-policy paragraph,
including its FFmpeg example; it was not rewritten because the task limited differences to product naming. The
Bildeditor-specific generated inventory and notices are authoritative for its actual libheif/LibRaw opt-in components.

## Verification

Shared-host snapshot before the final unit run: `09:46:24 up 12:32, load average 23.55, 21.43, 19.33`.

- `npm run notices`: 44 npm + 483 Rust + 19 curated entries; 20 full-text files.
- `npm run check:licenses`: `Licence check passed for 546 entries and 20 full licence texts.`
- `npx tsc --noEmit -p .`: passed with no diagnostics.
- `npx vitest run tests/unit --maxWorkers=2`: `Test Files 95 passed (95)`, `Tests 798 passed (798)`, duration 106.69 s.
- Focused licence E2E: 2/2 passed.
- `npm run test:e2e:area -- --area ui-i18n --project=chromium --workers=1`: 13/13 passed.
- `npm run test:e2e:changed -- --project=chromium --workers=1`: 71/71 passed (selected `raw` and `ui-i18n`).
- `npm run test:e2e:smoke -- --project=chromium --workers=1`: 22/22 passed.
- `npm run build`: passed; 1,089 modules transformed. The licensing view is a separate lazy JS/CSS chunk and full
  texts are separate lazy chunks.

Firefox/WebKit were not run because the task requested Chromium for the change-relevant area and the project rule
forbids a full cross-browser suite in a lane. The Tauri application was not started and no real-GPU measurement was
attempted.

## Open work

- No implementation work remains for this task. The integration lane should run its normal centralized full and
  cross-browser suites after merge.
