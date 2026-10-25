# berg:work PDF corpus suite

Seeded combinations of the editor's editing operations, run over a public PDF corpus of about 1,000 files. Each
result is checked with independent readers. The suite drives the editor's own engine and model code directly,
without clicking through the UI, so a typical small PDF takes 1–5 s for a complete edit/undo/redo/save/verify cycle.
A thin UI smoke test (`ui-smoke.mjs`) covers the wiring in between.

| Path | What it is |
| --- | --- |
| `corpus/manifest.json` | The corpus: per file the URL (pinned), sha256, size, page count, PDF version, password, licence, tags and facts. No PDFs are committed. |
| `corpus/fetch-corpus.mjs` | Downloads missing files into the corpus root and verifies them by sha256 (`--verify-only`, `--source`, `--tags`, `--limit`). |
| `corpus/tag-corpus.py` | Recomputes the tags/facts in the manifest with qpdf, poppler and pikepdf (`python3 -I corpus/tag-corpus.py`). |
| `corpus/SOURCES.md` | Sources, pinned revisions, licences and terms. |
| `run-corpus.mjs` | The runner: selects files for a tier, plans operations per file from a seed, runs them in headless pages, runs the Node-side checks, writes the reports. |
| `harness/entry.js` | The in-page harness (bundled by `harness/build-harness.mjs` into `.build/`). |
| `lib/plan.mjs` | Tiers, the stratified file selection and the seeded plans. |
| `lib/oracles.mjs` | qpdf and poppler checks. |
| `lib/report.mjs` | `report.json`, `summary.md`, `coverage.csv`. |
| `lib/server.mjs` | Static server: `dist/` at `/`, the harness, the corpus, the upload endpoint for outputs. |
| `ui-smoke.mjs` | Opens PDFs in the real page, rotates, undoes, redoes and saves them, then checks the download. |

## Prerequisites

From the repository root:

```sh
npm install
npm run sync:install                       # pinned editor build in apps/pdf/upstream/
npm run build:web -w @bergwork/pdf         # apps/pdf/dist/
```

The tests need the following, none of which `npx playwright install` should be run for:

- **Playwright.** It comes from `apps/image`'s dependencies, so `apps/image/node_modules` must be installed. The suite uses the local headless Chromium (WebKit is selectable with `--browser webkit`).
- **qpdf and poppler** (`pdfinfo`, `pdftotext`) for the outside checks. If a tool is missing, its checks are skipped.

Rebuild `dist/` after changing the editor fork. The harness itself is rebuilt on every run (`--no-build` skips that); it bundles the fork in its current working-tree state.

## Corpus

```sh
npm run test:corpus:fetch -w @bergwork/pdf                  # everything, ≈1.2 GB, ≈17 min (arXiv crawl delay)
node apps/pdf/tests/corpus/fetch-corpus.mjs --verify-only   # ≈4 s
```

- **Location.** Files go to `~/AgentWork/bergwork-pdf-corpus/` by default. Set `BERGWORK_PDF_CORPUS` to change it, or pass `--root` to the runner.
- **Missing files.** If only part of the corpus is present, the runner uses the files that are there.
- **Sources.** The corpus combines test corpora (pdf.js, PDFium, qpdf, veraPDF/Isartor, pdf20examples, PDFBox, pdfcpu, pypdf, pikepdf, pdf-lib, SafeDocs) with public documents (arXiv, IRS forms, NASA NTRS, USGS maps, Wikimedia Commons, OHCHR UDHR translations, govdocs1, ZUGFeRD invoices). `corpus/SOURCES.md` lists them.

## Testing another checkout (Fernwork engine fixes)

Engine fixes are made in Fernwork and ported into the fork. To check them before porting, point the runner at a
Fernwork worktree: `BERGWORK_PDF_EDITOR_SRC` is its editor source (`vendor/build/src`), `BERGWORK_PDF_DIST` its root,
whose `tools/vendor/` is the built worker (`cd vendor/build && node build.mjs pdf-tools` there first). Each source tree
gets its own harness build under `.build/src-<hash>/`; pass `--out` so parallel runs keep apart.

```sh
BERGWORK_PDF_EDITOR_SRC=~/source/fw-x/vendor/build/src BERGWORK_PDF_DIST=~/source/fw-x \
  node apps/pdf/tests/run-corpus.mjs --tier sample --file pdfjs/tracemonkey.pdf --ops page.move,text.font --out /tmp/f7
```

## Tiers

```sh
npm run test:corpus:quick -w @bergwork/pdf   # every change: 36 files, ≈2 min (≈3.5 min on a busy machine)
npm run test:corpus -w @bergwork/pdf         # sample: 150 files, ≈14 min
npm run test:corpus:full -w @bergwork/pdf    # nightly: the whole corpus, ≈1 h 45 min with 3 pages
npm run test:corpus:ui -w @bergwork/pdf      # UI smoke: 5 files, ≈40 s
```

| Tier | Files | Per file |
| --- | --- | --- |
| quick | Fixed stratified sample: one file per category first (versions, PDF/A, tagged, scanned, CJK/RTL/Devanagari, Type3/CID/non-embedded fonts, forms, XFA, encrypted, linearized, broken, maps, …). ≤ 6 MB and ≤ 60 pages. | 5 edits, 3 document operations, project round trip on 35 % of files, 45 s budget |
| sample | 150 files, same stratification. ≤ 40 MB and ≤ 400 pages. | 7 edits plus Tesseract on scanned files, 4 document operations, 90 s budget |
| full | Every file. | 8 edits, every document operation including rasterising, project round trip always, 150 s budget |

Options:

- `--jobs N`: pages in parallel, default 3, at most 6. Each page has its own PDFium worker, so keep it ≤ 4 on 16 GB. The full tier reaches 6 GB with 3 pages (scans of 100+ MB); under `MemoryMax=6G`, use `--jobs 2`, or raise the limit to 8 GB.
- `--seed S`: changes every plan and the sample.
- `--limit N`: caps the number of files.
- `--tags a,b` / `--source s`: filters the corpus.
- `--ops op1,op2`: runs exactly these operations, in order, on every selected file.
- `--keep-pdfs`: keeps all outputs. Without it, only the outputs of failing files are kept.
- `--out dir`: the report directory. Default `apps/pdf/tests/.out/<tier>-<time>/`, which is gitignored.

Run long tiers as their own unit, for example
`systemd-run --user --unit=bw-corpus-full --collect -p MemoryMax=6G --working-directory=$PWD -E PATH=$(dirname $(node -p process.execPath)):/usr/bin node apps/pdf/tests/run-corpus.mjs --tier full`.

## What one file goes through

The harness runs in a long-lived headless page and does the following for each file:

1. **Open.** It opens the PDF the way the editor does: first `loadPdfFile`, the PDF.js document model of the shell, then a PDFium session, `PdfEngineSessionOrchestrator` on the pinned `pdfium-worker.js`. All documents of a page share one worker, which is recycled every 20 files or after a timeout or crash.
2. **Baseline.** It inspects pages the way the editor's progressive inspection does: 12, 30 or 40 pages depending on the tier. It records the text and renders the first pages at scale 0.2.
3. **Edits.** It applies the planned operations through `PdfSemanticKernel`, the editor's journal with undo/redo. Each operation sends the same commands, and the same inverse commands, that `pdf-tools-shell.jsx` sends.
4. **Undo and redo.** It undoes everything and compares page count and pixels with the baseline, then redoes everything and compares the page order with the model.
5. **Save.** It saves through the editor's export pipeline: `engine.export` (redactions applied), `repairGeneratedFreeTextAppearances`, then `postprocessPdfiumExportBytes`.
6. **Checks on the saved file.** It reopens the file in PDFium and in PDF.js and checks it against the model the harness kept: page count, rotation, blank-page size, the inserted and edited text in both text extractions, annotation contents, pixel stability of untouched pages, and that no glyph survives inside a redaction.
7. **Project round trip.** It exports the `.bwpdf` project with its native state, loads it with `loadFernworkPdfProjectFile` and materialises it the way an inactive document is exported.
8. **Document operations.** Each runs on the saved bytes and reopens the result.

The runner then checks every output with qpdf (`--check`, page count, encryption) and checks redactions with poppler (no word may be left inside a redacted area).

### Edit operations (`--ops`)

| Operation | What it does |
| --- | --- |
| `page.rotate` | `page.rotate` with an inverse rotation |
| `page.move`, `page.delete`, `page.insertBlank`, `page.duplicate` | Native page topology with a retained rollback snapshot |
| `page.import` | Appends or merges pages of a small donor PDF from the corpus, or of the file itself |
| `text.add` | `object.insert` of a text frame with a unique marker |
| `text.edit` | `text.replace` of an existing line with its own words rotated, using a semantic or a snapshot inverse |
| `text.font` | Changes a line to a standard font |
| `image.add`, `shape.add` | Insert an RGBA image, a rectangle or an ellipse path |
| `object.move`, `object.delete` | Act on an existing top-level object |
| `annot.markup` | Highlight, underline or strike-out over a text line |
| `annot.shape` | Square, circle, line/arrow or ink annotation |
| `annot.comment` | Sticky note |
| `annot.freetext` | Text box or typed signature |
| `redact.area` | Redaction over a text line |
| `redact.find` | Find and redact a word through the editor's glyph matching |
| `stamp.watermark` | Text or image watermark (`stampPdfPages` plus a snapshot transaction) |
| `stamp.pageNumbers` | Page numbers, the same way |
| `ocr.layer` | Make searchable with synthetic words, through the `ocr.insert` transaction OCR produces |
| `ocr.tesseract` | Real Tesseract OCR of one page, then `ocr.insert`. Sample and full tiers, scanned files only. |

### Document operations

Each runs on the saved bytes.

| Operation | What it does |
| --- | --- |
| `doc.metadata` / `doc.stripMetadata` | Metadata set / stripped |
| `doc.bookmarks` | Outline |
| `doc.split` | Extracts pages with qpdf |
| `doc.compress` / `doc.compressImages` / `doc.rasterize` | `compressEditedPdf` with the lossless / images / small raster profiles |
| `doc.encrypt` | `restrictPdfBytes`. A wrong password must fail and the user password must open the file. |
| `doc.formFill` | AcroForm text fields and checkboxes filled, flattened in 40 % of runs. The values must read back. |

## Statuses and failures

Every step has one of these statuses:

| Status | Meaning |
| --- | --- |
| `ok` | The step succeeded. |
| `refused` | The editor declined the edit with a typed reason (`transaction-rejected`, `unsupported-operation`, …), as it would in the UI. Example: the transparency fidelity gate, or page import into a tagged or form PDF. |
| `n/a` | Nothing to act on, for example no text on the page. |
| `skipped` | The file's time budget ran out. |
| `fail` | Anything else. |

A file fails if any of these happens:

- A step fails.
- A check is false.
- The page crashes or hangs.
- An undo or redo of a committed edit is refused.

Opening may fail without counting only for files whose manifest entry says `expect.open = "fail"`. Outputs of encrypted inputs that stay encrypted are noted as `info.savedStillEncrypted`, not as failures.

Every failure is reproducible from (file, seed, tier). `summary.md` prints the command, for example
`node apps/pdf/tests/run-corpus.mjs --tier quick --seed 1 --file pdfjs/issue6108.pdf`. Add `--keep-pdfs` to keep the outputs. When the pixels of an undo or of an untouched page differ, the before and after renders are written next to them as PNG files.

## Reports

These files are in the `--out` directory:

| File | Contents |
| --- | --- |
| `results.jsonl` | One line per file: plan, steps (op, status, ms, detail/error), checks, outputs, failures, repro. |
| `report.json` | Totals, per-operation statistics, refusals by reason, failures grouped by operation/check with categories and cases, check pass/fail counts, the operation × category coverage matrix and the operation-pair coverage. |
| `summary.md` | A short human-readable version of `report.json`. |
| `coverage.csv` | The full operation × category matrix. |
| `pdf/` | Outputs, and renders of failed pixel checks. A full run keeps about 2 GB of failing outputs. `rm -rf apps/pdf/tests/.out` clears them. |

## Extending

To add an edit operation:

1. Add a function to `OPS` in `harness/entry.js`. It returns `{ status, detail }` and updates `state.model`, so the saved-file checks know what to expect.
2. Add its name to `EDIT_OPS` in `lib/plan.mjs`.

Document operations go into `DOC_OPS` in both files.

Shell helpers that are not exported are listed in `SHELL_INTERNALS` in `harness/build-harness.mjs`. The build appends an `export { … }` list to the fork's shell source in memory, so the editor sources are never edited. If a helper is renamed upstream, the build reports it as missing.
