# berg:work PDF agent CLI and MCP server

`bergwork-pdf-cli` runs the berg:work PDF editor's own engine without its UI, for scripts and AI agents. Every
operation goes through the code the app uses: the PDFium editing session (`PdfEngineSessionOrchestrator` over the
pinned worker), the semantic kernel that journals each edit, and the document helpers of `pdf-tools-shell.jsx`
(open, Save pipeline, forms, compression, encryption, OCR). It sends the same commands the shell sends for the same
action. `bergwork-pdf-cli mcp` offers the same operations as tools of an MCP server over stdio.

## Setup

From the repository root:

```sh
npm ci
npm run sync:install                      # pinned editor build in apps/pdf/upstream/
npm run build:web -w @bergwork/pdf        # apps/pdf/dist/
npm ci --prefix apps/image                # Playwright (headless Chromium) comes from apps/image
```

The CLI uses the Chromium headless shell in `~/.cache/ms-playwright`. Do not run `npx playwright install`. If the
revision that Playwright expects is not there, the newest `chromium_headless_shell-*` in the cache is used, or the
executable named by `BERGWORK_PDF_CHROMIUM`. The page bundle (`cli/.build/`, gitignored) is rebuilt automatically
whenever one of its sources changes.

```sh
npm run cli -w @bergwork/pdf -- info document.pdf      # relative paths are relative to your directory
node apps/pdf/cli/bin/bergwork-pdf-cli.mjs info document.pdf
```

The package also declares a `bergwork-pdf-cli` bin entry.

## Commands

All commands accept `--json` and `--timeout <seconds>` (default 300). With `--json`, the CLI prints exactly one line:
`{"ok": true, "command", "result"}` or `{"ok": false, "command", "error": {"code", "message", "details"?}}`. Outputs
are written with `-o`. An existing file is only overwritten with `--force`. Pages are 1-based: `1-3,5`, `8-`, `last`,
`odd`, `even`, `all`. Passwords can be given as `--password-file`, `--owner-password-file` and `--user-password-file`,
which keeps them out of the process list.

| Command | What it does (editor feature) |
| --- | --- |
| `info <file>` | Page count, page sizes and rotation, text characters per page (0 usually means a scan), PDF version, encryption, metadata, XMP, bookmarks, form fields, XFA, signatures, whether a native editing session can be opened |
| `text <file> [-p] [--engine pdfium\|pdfjs] [-o file.txt]` | Page text from PDFium with line breaks, or from PDF.js as the editor's Extract text produces it |
| `render <file> [-p 1] [--dpi 150] -o page.png` | PNG per page from PDFium, the editor's renderer. With several pages the output is `page-<n>.png`, a `%d` pattern or a directory. |
| `ocr <file> [-p] [--lang eng] [-o searchable.pdf]` | Tesseract OCR as the editor runs it. Prints the text; with `-o` it also adds the invisible text layer (Make searchable, `ocr.insert`). Languages: eng, deu, fra, spa, ita, por. |
| `redact <file> --term T … [--regex R] [--case-sensitive] [--whole-word] [-p] [--scrub-metadata] -o out.pdf` | Find & redact: matches on PDFium's glyphs become redaction marks. On save, the engine removes the glyphs, images and annotations under them. The saved file is reopened and checked to make sure no match is left. Matches in metadata, bookmarks and XMP are reported. `--scrub-metadata` removes them from the document properties. |
| `replace-text <file> --find F --replace R [--case-sensitive] [-p] [--partial] [--keep-fonts] -o out.pdf` | Retypes native text runs that contain the text, using `text.replace` with a snapshot inverse, as the inline text editor does. See the limits below. |
| `form-fields <file>` | AcroForm fields with name, type, value, options and read-only flag |
| `fill-form <file> --values '{"name": "value"}' [--flatten] -o out.pdf` | Fills the fields: check boxes take `true` or `false`, radio buttons and choices take the export value. Values can come from JSON text, `@file.json` or `-` for stdin. Unknown or read-only fields fail. Values are read back afterwards. |
| `pages rotate <file> [-p] [--angle 90] -o` | `page.rotate` |
| `pages delete <file> -p … -o` | `page.delete` |
| `pages move <file> -p … --to N -o` | `page.move`. The selected pages keep their order and the first one lands at position N. |
| `pages extract <file> -p … -o` | Export range (the Save pipeline with a page subset, in the given order) |
| `pages split <file> [--every N \| --ranges "1-3;4-"] -o dir/` | Export range once per part |
| `merge <a.pdf> <b.pdf> … [--passwords …] -o` (also `pages merge`) | Inserts the pages of the other PDFs at the end (`page.import`) |
| `optimize <file> [--profile lossless\|images\|raster-220\|raster-150\|raster-105] [--dpi] [--quality] -o` | The editor's optimiser. `images` recompresses images and keeps text and vectors. The raster profiles make an image copy, so text is lost (reported as `textPreserved: false`). |
| `protect <file> --owner-password P [--user-password U] [--restrict print,edit,copy,annotate] -o` | AES-256 through qpdf, one switch per permission (Security panel) |
| `unlock <file> --password P -o` | Security > Unlock: decrypts the file with qpdf. Permissions-only PDFs need no password. |
| `metadata <file> [--set field=value …] [--strip] [-o]` | Shows the document properties. `--set` writes title, author, subject, keywords, creator or producer. `--strip` removes the Info dictionary and XMP. |
| `mcp` | MCP server over stdio |

Inputs that are encrypted open with `--password`, through the editor's open path: password unlock, decryption of
permissions-only files, recovery of damaged files. Outputs are saved the way the editor saves them, unencrypted
unless you run `protect`.

### Exit codes

| Code | Meaning | Error codes |
| --- | --- | --- |
| 0 | Done | |
| 1 | The operation failed | `engine-error`, `verification-failed`, `timeout`, `internal` |
| 2 | Usage | `bad-argument`, `output-exists` |
| 3 | Not applied: the engine refused, the operation cannot be done safely, or nothing matched. Nothing was written. | `refused`, `unsupported`, `no-match`, `unknown-field` |
| 4 | Input | `input-unreadable`, `not-pdf`, `password-required`, `wrong-password` |
| 5 | Setup | `setup-missing` |

`refused` comes with the engine's own reason in `engineCode` or `message`, for example
`text-replace-exact-font-required`, or importing pages into a form PDF.

## MCP server

```json
{ "mcpServers": { "bergwork-pdf": { "command": "node", "args": ["/path/to/bergwork/apps/pdf/cli/bin/bergwork-pdf-cli.mjs", "mcp"] } } }
```

The tools are `pdf_info`, `pdf_text`, `pdf_render`, `pdf_ocr`, `pdf_redact`, `pdf_replace_text`, `pdf_form_fields`,
`pdf_fill_form`, `pdf_pages` (with `action`), `pdf_merge`, `pdf_optimize`, `pdf_protect`, `pdf_unlock` and
`pdf_metadata`. Their parameters are the CLI options in camelCase: `file`, `output`, `pages`, `force`, and so on. Each
tool returns the JSON result as text, with `isError` set on failure. `pdf_render` with `inline: true` also returns
the PNGs as image content.

The server takes local paths only. URLs and `file:`/`data:` schemes are refused, and relative paths resolve against
the server's working directory. Nothing is uploaded. The engine page loads `dist/` and the bundle from a server
that listens on 127.0.0.1, and inputs and outputs pass through a private temporary folder that is removed on exit.
One headless page is started on the first call and reused. Calls run one at a time. `BERGWORK_PDF_TIMEOUT_S` sets
the per-call timeout.

## How it works

| Path | Owns |
| --- | --- |
| `bin/bergwork-pdf-cli.mjs` | Entry point |
| `lib/commands.mjs` | The operations, defined once: parameters (CLI flags and the MCP schemas are generated from them), the in-page call, and where outputs go |
| `lib/cli.mjs` | Argument parsing, human or `--json` output, exit codes |
| `lib/mcp.mjs` | MCP server (`@modelcontextprotocol/sdk`, stdio) |
| `lib/engine-host.mjs` | Builds the page bundle when its sources change, starts the server and the browser, runs operations in one page |
| `page/entry.js`, `page/cli.html` | The in-page operations |
| `../headless/` | Shared with the corpus harness: `engine.js` (engine session, shared worker, byte helpers), `bundle.mjs` (esbuild with the shell's internals exported in memory, so the editor sources are never edited), `server.mjs`, `host.mjs` (Playwright and Chromium) |

The bundle exports the same shell helpers as the corpus harness (`SHELL_INTERNALS` in
`tests/harness/build-harness.mjs`), plus `canReturnOriginalPdfBytes` and `materializeCurrentPdfBytes`. Without
those two, an unedited document would not be saved as its source bytes the way the editor saves it.
`BERGWORK_PDF_EDITOR_SRC` and `BERGWORK_PDF_DIST` point the CLI at another checkout, as they do for the corpus suite.

## Limits

- **replace-text.** It only rewrites top-level native text runs that the engine reports as replaceable
  (`editPolicy`). The text to find must lie inside one run. Occurrences that span runs, sit in nested Form XObjects
  or rich text frames, or come from OCR'd images are reported as `notReplaceable`. If the engine refuses a run, for
  example because an exact subset font cannot encode the new text (`text-replace-exact-font-required`), the run is
  listed under `refused`. If any occurrence cannot be replaced, nothing is written unless you pass `--partial`. For
  non-embedded standard fonts, the engine draws characters outside the font's encoding with an embedded fallback
  font (Noto), as the editor does. The CLI reports this as `fontChanges`, and `--keep-fonts` refuses it. The
  replacement must be one line. Reflowing paragraphs is not supported.
- **merge.** The engine refuses to import pages into or from PDFs with forms or tags (`refused`), as the editor
  does.
- **OCR.** One language per run. Recognition renders with PDF.js at the editor's OCR scale (2x, capped for large
  pages).
- **Redaction outside the page content.** Bookmarks and XMP are reported, not changed. Use `metadata --strip` for
  XMP.
- **Left out, because the engine or shell has no clean headless path:** digital signatures (they need the
  certificate UI), watermarks and page numbers (possible through `stampPdfPages`, but not requested), comparing
  documents, `.bwpdf` projects, freely placed text, images and annotations. The corpus harness covers those
  internally.
- **Speed.** Each CLI call starts Chromium and loads the engine, which takes about 1–2 s. The MCP server keeps one
  page open.

## Tests

```sh
npm run test:cli -w @bergwork/pdf
```

There is one `node --test` case per command against `scripts/fixtures/smoke.pdf` and `scanned-page.pdf`. Each case
checks the result with `qpdf --check`, `pdftotext` and `pdfinfo`, not with the engine. The MCP test runs the server
over stdio and calls `tools/list`, `pdf_info`, `pdf_redact` and one refused remote path. The suite takes about
2.5 min and is skipped when `dist/` or Playwright is missing.

## Licences

The CLI is part of berg:work PDF (BUSL-1.1) and uses the editor under the same licence. Its runtime dependencies are
`@modelcontextprotocol/sdk` 1.32.1 (MIT) and `zod` 4.6.7 (MIT). Their transitive dependencies are MIT, ISC,
BSD-2-Clause and BSD-3-Clause. They are not bundled into the app, so `scripts/collect-licenses.mjs` and
`THIRD_PARTY_NOTICES.md` (the app's components) do not list them. Playwright (Apache-2.0) comes from `apps/image`'s
development dependencies.
