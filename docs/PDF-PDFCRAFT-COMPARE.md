# berg:work PDF compared with PDFCraft

Snapshot of 2026-10-30. berg:work: `origin/main` `7dac322`, Fernwork pin `082fd77a`. **Toolkit** (`PDFCraftTool/pdfcraft`):
commit `e0c324d4` of 2026-10-30, release `v2026.10.29-664f501`. **ArtCraft** (`storytold/pdfcraft`, written PdfCraft): commit
`fa5f9f8c` of 2026-10-30, after v0.15.0.

**Two products carry this name, and this document compares both** (section 1). The rest uses the short names Toolkit and
ArtCraft.

**Neither was run.** Both repositories were read at those commits. The Toolkit's public site got HTTP requests only: no
browser, no document. ArtCraft has no hosted version. berg:work was not rebuilt. So nothing here is a measured result, and
the closest thing to a test is the mark `live`.

This is the companion to `PDF-PDFGEAR-PARITY.md`: same yardstick, and facts stated there are not repeated.

Marks in the last column of the tables:

- **code:** read in the product's own source at the commit above.
- **vendor:** its README, docs, changelog or own checklist. ArtCraft's checklist `parity/acrobat-features.toml` is the main
  one [9]: CI rejects a `shipped` entry whose cited test does not exist, but the file is self-assessment.
- **live:** an HTTP request to the public site or API today (headers, status, HTML).
- **third:** independent source or a user's issue.
- **repo, audit:** berg:work, as in the PDFgear document.
- **none found:** I searched and found nothing. That is not proof of absence.

`[n]` is a source at the end. Effort is in person-days (PD), my estimate.

## 1. Which PDFCraft

The brief assumed the browser toolkit. It fits that description, but it is not the best-known product of the name, so the
assignment cannot be settled from outside. Both are serious, and they answer the question differently.

| Name | What it is | Numbers, licence | Treated as |
|---|---|---|---|
| **PDFCraft** `PDFCraftTool/pdfcraft` | Browser toolkit, 132 tool entries in `src/config/tools.ts`, plus a Direct Editor, a Studio and a Tauri app | 9,721 stars, 2,125 forks, created 2026-01-03, AGPL-3.0 [1] | **Toolkit**, compared |
| **PdfCraft** `storytold/pdfcraft` | Native reader and editor from scratch in Rust, by ArtCraft (Brandon Thomas). Alpha | 18,753 stars, 7,071 forks, created 2026-09-30, MIT or Apache-2.0 [8] | **ArtCraft**, compared |
| PdfCraft for Android `artcraft-android/pdfcraft-android` | Rust Android app of ArtCraft, separate repository | 201 stars, created 2026-10-13, Apache-2.0 [15] | Named only |
| LibrePDF `PDFCraftTool/LibrePDF` | The Toolkit's desktop sister: "53+ tools", Ollama, node workflows | 5 stars, created 2026-10-29, Apache-2.0 by its own label [7] | Named only |
| pdf-craft `oomol-lab/pdf-craft` | Python: scanned books to Markdown or EPUB, not an editor | 6,467 stars, MIT [16] | Name only |
| PDFCraft, PDFCraft Filler Signer | Unrelated iOS apps | App Store [17] | Name only |
| pdfcraftpro.pages.dev and forks | Hosted sites and forks with the Toolkit's text; not examined | [18] | Name only |

**People mix them up.** The Toolkit's tracker holds reports that plainly belong to ArtCraft: #224 reports "PDFCraft 0.9.0"
and a Windows printer list, while the Toolkit's app is version 0.1.0 [1][5]. A third-party guide warns about the same thing [12].

## 2. Short conclusion

**Against the Toolkit, berg:work is the deeper editor and its claims hold up better, and it loses clearly on conversion and
breadth.** The Toolkit does what berg:work cannot: Word, Excel and PowerPoint to and from PDF, inside the browser, for free.
Its Direct Editor is also more serious than "tools per file" suggests: it runs on PDFium and has reflow, lists, justified
text, right-to-left and find and replace. But the width hides thin spots. Its "RFC 3161 timestamp" is a self-signed
certificate made on the spot, and its PDF/A tool produces no PDF/A (section 4).

**Against ArtCraft, berg:work wins on the editor and on German OCR, and loses as a product.** ArtCraft already ships much of
what `PDF-TODO.md` still plans: signed installers on every desktop, 35 UI languages including German, tabs, native printing,
form scripts, an accessibility checker, signing with OS key stores. It rates its own content editing at 30 % ready [9], and
vector editing, alignment, rulers and guides are planned rather than built. Its OCR reads unaccented English only, so German
umlauts come out as "?" (#524) [10]. Its web build has no OCR and no signing.

**Our lead over ArtCraft has a short shelf life.** It went from nothing to v0.15 in a month, largely with agents, and prices
editing at 100–180 agent-hours [9]. It is alpha, with 1,480 open issues and 1,147 open PRs [10]. Even so, plan on the
assumption that the depth of editing stops being a unique lead within months, not years. What stays ours is PDFium, a browser
promise enforced by CSP, and whatever we ship before then.

The gaps that matter most, none of them yet in `PDF-TODO.md` (details there, under *PDFCraft gaps*):

1. **Find and replace in the app.** The Toolkit has it with regex; we have it in the CLI only. 2–3 PD.
2. **PDF layers (optional content).** Both show them; we do not. It matters for CAD plans. 3–5 PD.
3. **Multi-page TIFF as input.** Both take it, and plans and scans come as TIFF. 1–2 PD.
4. **Accessibility check and alt text.** ArtCraft has 32 rules, a report and fixes. 4–7 PD.
5. **Form calculations.** ArtCraft runs Acrobat's functions and sandboxed JavaScript. 5–8 PD.

The larger gaps are the ones already planned: Office conversion, German UI, desktop releases. Both rivals sharpen them.

## 3. Better, worse, equal

### Where berg:work is better

- **Object editing, against both.** Path points, object layers, groups, locking. The Toolkit changes a path's stroke and
  stacking order only, as far as the code shows; ArtCraft plans all of it [9].
- **Editing as one workspace.** Several documents, journal, recovery, and one editor for everything. The Toolkit's Direct
  Editor is one file in an iframe with 20 undo steps or 256 MB, saved by download, and its other tools are separate pages.
- **Rendering engine, against ArtCraft.** PDFium against a vendored, patched `hayro` that ArtCraft itself calls "borrowed" [8].
- **Non-destructive redaction, against the Toolkit,** which rasterises every page it redacts, so the rest of the page loses
  its text. ArtCraft's redaction is at least our equal.
- **PDF/A, against both.** Ours is checked with veraPDF. ArtCraft's is partial, without CMYK. The Toolkit's is not PDF/A.
- **OCR for European languages, against ArtCraft,** which has no accents, no deskew and nothing in the browser. Against the
  Toolkit: 46 languages against 12, deskew built in, area OCR, though it has CJK and Arabic and we do not.
- **Comment workflow and measuring, against the Toolkit,** which has neither XFDF nor measuring (none found).
- **Privacy enforced by the browser, against the Toolkit** (section 6). ArtCraft's web build is yours to host, so there the
  CSP is the host's business.
- **Hosted, full web app, against ArtCraft.** Open a page and everything works, on any device with a browser.
- **Multiple windows, against ArtCraft** (planned there [9]).
- **Honest refusals, against the Toolkit.** We refuse what we cannot do; it labels a best-effort result as done (section 4).

### Where berg:work is worse

- **Office conversion, against the Toolkit,** in both directions and in the browser. ArtCraft is weak too, but it has
  flowing Word, RTF, HTML and Markdown export.
- **Everything around the editor, against ArtCraft:** signed builds for Windows (x64, x86, ARM64), macOS and Linux with
  updates, tabs, native printing, 35 UI languages. The Toolkit has 18 UI languages and a desktop build, at 460–550 MB.
- **Text editing details:** justified text, lists (Toolkit), mixed styles in a paragraph, right-to-left, and fonts from a
  file or the system, where one or both are ahead.
- **Find and replace in the UI** (Toolkit).
- **Forms:** calculation, scripts, XFA, more field types (ArtCraft, partly Toolkit).
- **Pages and structure:** PDF layers, page labels, attachments, bookmarks from headings, imposition, background colours,
  interleaving and reversing (both or one).
- **Signatures:** OS key stores, full validation, revisions (ArtCraft); remote signing over CSC (Toolkit).
- **Redaction tools:** word lists, patterns, code sets, an audit for fake redactions, sanitising (ArtCraft).
- **Accessibility checker** (ArtCraft).
- **Batch:** Action Wizard with 12 step kinds, folders (ArtCraft); visual workflows (Toolkit, beta).
- **Licence for companies:** both are free. AGPL or MIT against BUSL-1.1 with an unpriced commercial licence.
- **Reach:** 181,128 downloads of ArtCraft's 0.15.0 assets in two days, MSI alone 86,078, auto-updates included [8]. We have none.

### Where they are about equal

Password protection with AES-256, permissions, metadata, flatten, page basics, split, crop, header and footer, draw/type/image
signatures, local processing of documents, no AI in the app, no scanner, no read aloud.

### Where nobody can say yet

- **Text edit quality on hard PDFs.** Three different approaches, no shared test. The Toolkit's editor may be the strongest
  of the three on paper, and nothing says so in practice. This needs the same files on all three (section 10).
- **Speed.** Native Rust without PDFium against WASM PDFium. ArtCraft reports blurry text and slow scrolling (#730, #3793)
  [9][10], but no measurement compares us.
- **Rendering fidelity.** ArtCraft reads a median 0.89 % pixel disagreement with Poppler over 229 files [9]. Nobody has
  measured all three.
- **The Toolkit's word and spreadsheet conversions.** Open issues report failures (#41, #118) [5]; how often is unknown.

## 4. Claims in the Toolkit that do not hold

The tool count is the wrong measure. These four are from reading the code, so they show what it is written to do. None was
run. A `scratch` folder of 188 one-off scripts and reports suggests much of the repository is generated work (my inference),
and a public complaint calls it a "vibe project" [3].

| Claim | What the code does | Consequence |
|---|---|---|
| "RFC 3161 Trusted Timestamp Proof of Existence", TSA "MeSign" | `timestamp.ts` generates an RSA key in the page, self-signs "PDFCraft Trusted TSA Authority (MeSign)", takes `new Date()` from the local clock and signs with it. No TSA, no RFC 3161 token | It proves nothing about time, and it is labelled as if it did. A misleading feature in a legal context |
| "PDF to PDF/A" (1b, 2b, 3b) | `pdfToPdfa` ignores the options and calls `doc.save(garbage=4, deflate=True)`. The code comment says a real conversion would need an ICC profile and an OutputIntent | The file is named and reported as PDF/A without being PDF/A |
| Spell check in the Direct Editor | It fetches `dict/en.txt.gz`, which is absent from the repository and returns 404 on the live site | Expected to fail with "dictionary not found" |
| "Physically removes" watermarks | A regex over decoded streams, for one literal string directly before `Tj` or `TJ`. The arrays its own comment mentions do not match | Works on simple text watermarks only |

The Toolkit's README also understates it: 8 languages against 18 in `config.ts`, 90 tools against 132 entries.

ArtCraft's self-assessment is the opposite case: it publishes its own weaknesses, and the numbers hold up where I checked
them. Some are stale: its parity document says 23 UI languages, the repository has 34 catalogs plus English.

## 5. Licence

| | Toolkit | ArtCraft |
|---|---|---|
| Licence | AGPL-3.0, since 2026-01-17 ("to comply with upstream") [3][4] | MIT OR Apache-2.0 in `Cargo.toml`, `NOTICE` and the README [8]. GitHub's API shows Apache-2.0 only |
| Origin | "Migrated from BentoPDF" (`tools.ts`). BentoPDF's author, as quoted in [3], accused it of copying without credit. It started as MIT [6], and the maintainer called that relicensing "a mistake" [3] | "Clean-room", from the ISO 32000 specification [8] |
| Parts with other terms | PyMuPDF and MuPDF (AGPL), CoherentPDF, and `editcore.wasm`, a compiled PDFium build labelled `bentopdf-pdfium`, with no source found in `src`, `scripts` or the README | Brand and logos excluded, OCR models CC-BY-SA-4.0, fonts OFL |
| May berg:work take code? | **No.** AGPL would pull the combined work under AGPL, and berg:work is BUSL-1.1 | Allowed by the licence, with notices. **Still Florian's decision**, and it would need a Rust-to-WASM path that does not exist here |

Consequences:

- **No code from either product is in berg:work, and this comparison adds none.** This document describes behaviour only.
- **Whoever builds a gap from this list works from the PDF specification and our own code, not from the Toolkit's source.**
  That is cautious: copyright protects code rather than ideas, but this is not legal advice.
- **LibrePDF's Apache label is unverified.** It comes from the AGPL Toolkit's owner and is one day old. Treat it like the
  Toolkit until someone checks where its code comes from.
- **The Toolkit's LibreOffice route does not depend on the Toolkit.** It uses `@matbee/libreoffice-converter`, which is
  MPL-2.0 by its npm entry [14]. See section 11.

## 6. Privacy

All three keep documents on the device. The difference is what enforces it. berg:work: see section 4 of the PDFgear document.

| Point | Toolkit | ArtCraft |
|---|---|---|
| Document upload | None found in the code. Remote signing sends a hash to a service the user enters (code) | "No account, no telemetry, no cloud" (vendor) |
| CSP on the public site | **None** in today's headers (live) | No public site |
| CSP of the desktop app | Allows scripts from any `https:` host and `unsafe-eval` (code) | Native app, no web page |
| Third-party code at run time | DjVu tool loads `djvu.js.org/assets/dist/djvu.js` without integrity check into the page (code). Fonts from `raw.githack.com`. OCR data from the library's default CDN (inference: `createWorker` sets no `langPath`) | None found. Updates are checked at start since 0.15 (third [13]) |
| Analytics | No code found, none in the live HTML. Its privacy page still says it "may collect anonymous usage statistics" [2] | None found. Not audited |
| Updates | Falls back to `gh-proxy.com` and `mirror.ghproxy.com`, no checksum check found in `updater.ts` | Signed installers, `SHA256SUMS.txt`, AppImage zsync |

The Toolkit's promise is credible but only promised: a page without CSP that loads third-party script next to the user's
document depends on that third party. That is the concrete reason our CSP is worth keeping.

## 7. Feature table

"Ahead" names who leads. Confidence lists the marks in column order: Toolkit; ArtCraft; berg:work.

### Editing

| Feature | Toolkit | ArtCraft | berg:work | Ahead | Confidence |
|---|---|---|---|---|---|
| Edit existing text | Direct Editor on PDFium, paragraph model | Paragraph editor, Latin solid, own "ready" 30 % | PDFium objects, no whiteout | open; ArtCraft last | code; vendor; repo, audit |
| Mixed styles in a paragraph | Runs kept | One editor; untouched rows keep their operators | *Edit as paragraph* refuses them | ArtCraft, Toolkit | code; vendor; repo |
| Justified text | Yes | Yes, single style | Becomes left-aligned | **both** | code; vendor; repo |
| Lists | Bullets, five numbering styles, levels | Planned | None (PowerPoint parity) | **Toolkit** | code; vendor; repo |
| Letter, word spacing, scale, indents | All in the panel | Letter, scale, line spacing | Alignment | Toolkit | code; vendor; repo |
| Right-to-left | Direction control, Arabic shaping | Partial | Refused | **Toolkit** | code; vendor; repo |
| Find and replace | Regex, case, whole word, one or all | Planned | CLI only | **Toolkit** | code; vendor; repo |
| Spell check | UI, dictionary 404 | Planned | None | nobody | code, live; vendor; repo |
| Fonts | PDF fonts, installed fonts in Chromium | File or installed; a full face completes subsets | PDF fonts, bundled | **ArtCraft** | code; vendor; repo |
| Images | Add, replace, rotate, flip, order, alt text | Add, replace, crop, rotate, flip, extract | Add, replace, drop, opacity, rotate | equal | code; vendor; repo |
| Vector paths | Stroke colour and width; no points found | Planned | Points, fill, stroke, opacity | **berg:work** | code; vendor; repo |
| Object layers, groups, lock | Order only; none found | Planned | Yes | **berg:work** | code; vendor; repo |
| Multi-selection, align | Yes, align, distribute | Move on one page; align planned | Yes, plus shared fields with Mixed | berg:work, slightly | code; vendor; repo |
| Snapping, rulers, guides | Smart guides, rulers, guides | Planned | Yes, equal spacing, Alt distances | berg:work, slightly | code; vendor; repo |
| Links | None found in the editor | Create, edit, from URLs | Read only | **ArtCraft** | none found; vendor; repo |
| Undo | 20 steps or 256 MB | Named steps, after saving | History back to the saved state | ArtCraft, berg:work | code; vendor; audit |
| Autosave, recovery | None found | Every minute, recovery | Journal, recovery | ArtCraft, berg:work | none found; vendor; repo |

### Annotations

| Feature | Toolkit | ArtCraft | berg:work | Ahead | Confidence |
|---|---|---|---|---|---|
| Markup basics | pdf.js annotator, "legacy" mode | All types | Yes | ArtCraft, berg:work | code; vendor; repo |
| Replies, status, XFDF | None found | Yes, FDF, summaries | Yes | ArtCraft, slightly | none found; vendor; repo |
| Stamps | Presets, custom | 12 standard, dynamic, custom | Presets, own image | **ArtCraft** | vendor; vendor; repo |

### Forms

| Feature | Toolkit | ArtCraft | berg:work | Ahead | Confidence |
|---|---|---|---|---|---|
| Create fields | Eight types, including date and signature | Every AcroForm type | Four types | ArtCraft, Toolkit | code; vendor; repo |
| Calculation, formats | None found | Acrobat's AF functions, event order | None | **ArtCraft** | none found; vendor; repo |
| Scripts | Injects show, hide and set rules as AcroJS | Sandboxed JavaScript (boa), console | None | **ArtCraft** | code; vendor; repo |
| XFA | None found | Static and dynamic, partial | Warns | **ArtCraft** | none found; vendor; repo |

### Pages

| Feature | Toolkit | ArtCraft | berg:work | Ahead | Confidence |
|---|---|---|---|---|---|
| Merge with forms and tags | `copyPages`: no form or tag handling found | Keeps links, fields, layers, attachments | Engine refuses | **ArtCraft** | code; vendor; repo |
| PDF layers (optional content) | Manager | Panel, show, hide | None | **both** | code; vendor; repo |
| Page labels | Yes | Yes | None | **both** | code; vendor; repo |
| Attachments | Add, extract, edit | Add, delete, open | Not shown (PDFgear parity) | **both** | code; vendor; repo |
| Bookmarks from headings, contents page | Auto generator, contents page | From tags or text styles | Manual | **both** | code; vendor; repo |
| N-up, booklet, poster | Tools | In the print dialog | None (N-up in PDFgear parity) | **both** | code; vendor; repo |
| Reverse, interleave, divide, remove blanks | Yes | Partly; not checked | None | **Toolkit** | code; none found; repo |
| Background, greyscale, invert | Yes | Background | None | Toolkit | code; vendor; repo |
| Split, crop, headers, Bates | Bates: none found | Bates on one file | Yes, all | ArtCraft, berg:work | none found; vendor; repo |
| Remove watermark | Regex (section 4) | Its own marks, update too | Undo only | ArtCraft | code; vendor; repo |

### Conversion

| Feature | Toolkit | ArtCraft | berg:work | Ahead | Confidence |
|---|---|---|---|---|---|
| Word, Excel, PowerPoint to PDF | **In the browser**, LibreOffice WASM, 77 MB gzipped; failures reported | Planned, as a sidecar | None | **Toolkit** | code, third; vendor; repo |
| PDF to Word | pdf2docx on PyMuPDF in Pyodide | Flowing, loses layout (#773) | None | **Toolkit** | code; vendor; repo |
| PDF to Excel | Tables through openpyxl | Planned | None | **Toolkit** | code; vendor; repo |
| PDF to PowerPoint | Yes | Partial | None | Toolkit | code; vendor; repo |
| PDF to images | JPG, PNG, WebP, BMP, TIFF, SVG | PNG, JPEG, TIFF | CLI only (PDFgear parity) | both | code; vendor; repo |
| PDF to Markdown, HTML, RTF | Markdown, JSON | RTF, HTML, Markdown | None | both | code; vendor; repo |
| Extract embedded images | Yes | Yes, JPEG unchanged | None | **both** | code; vendor; repo |
| Images to PDF | Also TIFF, PSD, HEIC | Also multi-page TIFF, JPEG 2000 | HEIC, WebP, AVIF, SVG; **no TIFF** | both on TIFF | code; vendor; repo |
| Ebooks, mail, DjVu, CBZ, XPS | Yes | No | No, on purpose (section 9) | Toolkit | code; vendor; repo |

### OCR

| Feature | Toolkit | ArtCraft | berg:work | Ahead | Confidence |
|---|---|---|---|---|---|
| Languages | 12, with Chinese, Japanese, Korean, Arabic | **English alphabet, no accents** | 46; Latin, Greek, Cyrillic | berg:work for Europe | code; code, third; repo |
| Several in one run | Yes | No | No (PDFgear parity) | **Toolkit** | code; code; repo |
| Deskew | Separate tool | Planned | In the OCR run | **berg:work** | code; vendor; repo |
| Area | None found | None found | Yes | berg:work | none found; none found; repo |
| In the browser | Yes | No (#103) | Yes | Toolkit, berg:work | code; vendor, third; repo |
| Edit recognised text | Through Edit | Covers and redraws | No | ArtCraft | code; vendor; repo |

### Signatures

| Feature | Toolkit | ArtCraft | berg:work | Ahead | Confidence |
|---|---|---|---|---|---|
| Certificate signature | PKCS#12 through zgapdfsigner | PAdES B-B, PKCS#12, Keychain, Windows store. Not on web | PKCS#12, PEM, self-signed, detached | **ArtCraft** | code; vendor; repo |
| Remote signing (CSC API) | Yes, hash only | Planned as a plug-in | None | **Toolkit** | code; vendor; repo |
| Check signatures | Against a certificate the user gives | Chains, revisions, DocMDP, trust store | Integrity, coverage | **ArtCraft** | code; vendor; repo |
| Timestamp | Fake (section 4) | RFC 3161 with a supplied token, no server | None (open in TODO) | **ArtCraft** | code; vendor; repo |
| LTV | None found | Partial, supplied evidence | None | ArtCraft | none found; vendor; repo |

### Security and redaction

| Feature | Toolkit | ArtCraft | berg:work | Ahead | Confidence |
|---|---|---|---|---|---|
| Redaction | **Rasterises the page** at scale 2 as JPEG | Glyphs, pixels, vectors, annotations, tags; verified | Glyphs, images, annotations, fields; preview | ArtCraft, berg:work | code; vendor; repo |
| Word lists, patterns | E-mail, phone, ID patterns | Lists, patterns, FOIA codes | Dialog; regex in the CLI | **ArtCraft** | code; vendor; repo |
| Audit for fake redactions | None found | Partial | None | ArtCraft | none found; vendor; repo |
| Sanitise | Sanitize, Deep Sanitize | Hidden information, Sanitize | Strip metadata | **both** | code; vendor; repo |
| PDF/A | **Not PDF/A** (section 4) | 2b, 3b; no CMYK; partial | 2b, 3b; veraPDF | **berg:work** | code; vendor; audit |
| Accessibility | Alt text on images | 32 rules, report, fixes, alt text, partial auto-tag | None | **ArtCraft** | code; vendor; repo |

### Compare, measure, batch

| Feature | Toolkit | ArtCraft | berg:work | Ahead | Confidence |
|---|---|---|---|---|---|
| Compare | Word diff by page; no pixel compare found | Text, visual, side by side, PDF report | Text, visual, side by side, overlay | ArtCraft, berg:work | code; vendor; repo |
| Measure | None found | Distance, perimeter, area, scale, CSV | The same | equal, berg:work over Toolkit | none found; vendor; repo |
| Measure snapping | – | Ends, **midpoints, intersections**, inside Forms | Corners, line ends | ArtCraft | –; vendor; repo |
| Batch | Multi-file tools; workflow editor, beta, 23 templates | Action Wizard, 12 step kinds, folders | A few steps, open documents | **both** | code; vendor; repo |
| CLI, MCP | None found | CLI, MCP with 141+ tools, Rust API, control of the real UI | CLI, MCP on files | **ArtCraft** | none found; vendor; repo |

### AI

| Feature | Toolkit | ArtCraft | berg:work | Ahead | Confidence |
|---|---|---|---|---|---|
| AI in the app | None; "AI PDF Reflower" is heuristics, no model or key in the code | None; local provider planned | None; agent panel planned (TODO, Step 4) | equal | code; vendor; repo |

### Reading

| Feature | Toolkit | ArtCraft | berg:work | Ahead | Confidence |
|---|---|---|---|---|---|
| Two-page view, full screen | pdf.js viewer | Yes | No; F11 in the app (PDFgear parity) | **both** | code; vendor; repo |
| Page colours | Invert writes into the PDF | Replace colours, reported bug (#3443) | No | ArtCraft | code; vendor, third; repo |
| Tabs | None found | Yes | Dropdown | **ArtCraft** | none found; vendor; repo |
| Several windows | None found | Planned | Yes, in the app | **berg:work** | none found; vendor; repo |

### Rendering and speed

| Feature | Toolkit | ArtCraft | berg:work | Ahead | Confidence |
|---|---|---|---|---|---|
| Engine | pdf.js in tools, PDFium in the editor, MuPDF behind conversion: three engines | `hayro` vendored with 61 local patches, own renderer planned | PDFium WASM | **berg:work** | code; vendor; repo |
| Corpus | None found; 100 test files | 983 pdf.js files: 963 clean, 0 crashes, 958 round trips | Harness, 36-file quick run | ArtCraft on evidence | code; vendor; repo |
| Download | Desktop 462–554 MB [1] | Installers 91–111 MB, web zip 17 MB [8] | `dist/` 124 MB, binary 72 MB | **ArtCraft** | live; live; audit |
| Large files | Tools say no limit, config says 100 MB | No lazy loading of GB files | 2 GB WASM cap | open | code; vendor; audit |

### Platforms

| Feature | Toolkit | ArtCraft | berg:work | Ahead | Confidence |
|---|---|---|---|---|---|
| Hosted web app | Yes | No, self-hosted zip [11] | Yes | Toolkit, berg:work | live; vendor; live |
| Depth on the web | All tools | No OCR, no signing, no recovery | All | Toolkit, berg:work | code; vendor; repo |
| Windows | Tauri, signing not stated | Signed MSI, portable; x64, x86, ARM64 | Configured, not built | **ArtCraft** | live; vendor; repo |
| macOS | dmg, signing not stated | Signed, notarised, universal | None | **ArtCraft** | live; vendor; repo |
| Linux | AppImage, deb | AppImage, Flatpak, deb, rpm, tarball; also ARM64, RISC-V | Internal build | **ArtCraft** | live; vendor; repo |
| Android, iOS | Web only | Android in a separate repository; no iOS | PWA | open | code; live; repo |
| Self-hosting | Docker image, static export | Static web zip | Static `dist/`; licence limits | Toolkit | vendor; vendor; repo |

### Price, licence, UI

| Feature | Toolkit | ArtCraft | berg:work | Ahead | Confidence |
|---|---|---|---|---|---|
| Price | Free | Free | Free up to three people | **both** for companies | vendor; vendor; repo |
| Licence | AGPL-3.0 | MIT or Apache-2.0 | BUSL-1.1 | section 5 | code; code; repo |
| UI languages | 18, including German | 35, including German; quality varies | English | **ArtCraft** | code; code; repo |
| UI model | 132 tool pages, Studio, Direct Editor | Acrobat-like workbench, ⌘K | One editor, islands, Ctrl+K | berg:work, ArtCraft | code; vendor; audit |
| Stage | No stage stated, tools vary | Alpha by its own account | Internal | open | code; vendor; repo |
| Pace | Release every 2–3 days | v0.8 to v0.15 in two weeks | Daily, unreleased | ArtCraft | live; third; repo |
| Open issues | 101 of 178 | 1,480 of 2,465, plus 1,147 open PRs | None public | open | live; live; – |

### Common complaints

**Toolkit** (issue titles [5]): Word to PDF errors (#41), Excel to PDF not working (#118), compression breaks images (#93) or
changes nothing (#29), OCR errors (#125, #132), downloads not reacting (#96), and the attribution dispute (#6). Some of the
tracker is about ArtCraft (section 1), so this list is a floor and not a count.

**ArtCraft** (issues [10], themes from its own count on 2026-10-10 [9]): printing above all (#160, #3032, #3132 replaces glyphs
on Windows), Chinese glyph boxes (#826), umlauts in OCR (#524), OCR on the web (#103), start-up crashes on old GPUs (#4134),
scroll speed (#3793), saved signatures (#1288). Its first releases drew 54 reports about install, launch and GPU.

## 8. What each one teaches us

- **From the Toolkit:** a browser can carry LibreOffice. Our TODO still treats that as a question. Its Direct Editor also
  shows what users expect from paragraph editing: lists, justification, find and replace.
- **From ArtCraft:** a full tool list is cheap now, so breadth is no longer a lead for anyone. Its public checklist with
  cited tests is a good idea to copy for ourselves, and its gap list is a free specification of what Acrobat users miss.

## 9. What we deliberately do not match

- **A tool page per function.** One editor with a palette is the point of berg:work. The gaps belong in that editor.
- **Novelty tools:** passport photo composer, booklet folding simulator, invoice currency stamp, e-ink optimiser, spine
  bookbinder. Many of the Toolkit's 132 entries are of this kind.
- **Ebook, mail, comic, DjVu and PSD input.** Same reason as the format count in the PDFgear document.
- **Python in the browser.** Pyodide with PyMuPDF is a large download and AGPL, and our plan for Word needs neither.
- **Local models, including LibrePDF's Ollama copilot.** Excluded by the decision in Step 4 of `PDF-TODO.md`.
- **A "virtual TSA".** A timestamp comes from a real TSA or not at all.
- **Rasterising as redaction.** Ours keeps the page's other text.

## 10. Checks on the real products

Needs the Windows PC for one online session, not this machine. Use the five audit PDFs from the PDFgear document. 1 PD.

1. Text edits on the Toolkit's Direct Editor, ArtCraft and berg:work: subset fonts, bold words, enlarging, what the saved file
   contains (`pdffonts`, `qpdf`).
2. Does the Toolkit's spell check fail as the code says? Its PDF/A through veraPDF, its timestamp in Acrobat.
3. The Toolkit's Word, Excel and PowerPoint conversion on the same files as PDFgear, with load time and memory.
4. Is ArtCraft's redaction clean (`pdftotext`, `pdfimages`)? Does its merge keep forms?
5. Timings on GeoTopo and a 500 MB scan against berg:work.
6. A network capture of the Toolkit's site during OCR and DjVu.

## 11. Corrections to other documents

- `PDF-TODO.md`, *Office to PDF, spike:* add `@matbee/libreoffice-converter` next to ZetaOffice as a second candidate. MPL-2.0
  by its npm entry, version 2.7.2 [14]; in the Toolkit 29 MB of data and 49 MB of WASM gzipped, 254 MB unpacked by npm. It
  needs COOP, COEP and threads, which our live headers allow on the web; WebKitGTK has no `SharedArrayBuffer`, so the Linux app
  would keep the installed-LibreOffice route. Bundled parts still need a licence check, and failures are reported (#41, #118).
  Left unchanged here because this document only adds its own section.
- `PDF-TODO.md`, *Merge PDFs with forms or tags:* ArtCraft shows that keeping forms, links and layers is possible and what
  users get from it. The benefit stands.
- `PDF-TODO.md`, *Store presence:* "Editing vector paths is offered nowhere we know of" still holds for point editing. The
  Toolkit changes a path's stroke.
- `PDF-TODO.md`, *PowerPoint parity, Layout:* align and equal spacing already exist in the Arrange popover
  (`ARRANGE_SECTIONS`). Slide grids and consistent spacing are what remains.
- `PDF-TODO.md`, *Image to PDF, HEIC:* marked in progress, while this `main` already has it in the shell and the README. Check
  and close.
- Fernwork's `docs/pdf/TODO-editor-feel-and-features.md` is not in the local Fernwork checkout at that path, so the new gaps
  were only checked against this repository's documents.

## Sources

Read on 2026-10-30. Repository figures are from the public GitHub API that day. Code statements were read in shallow clones at
the commits at the top. Issues are known from titles unless cited as read in full. Google Play and Reddit were not consulted.
No independent review of either product turned up: what exists is store listings, directories and one publisher's guides.

**Toolkit**

1. Repository, README, `src/`, `public/`, `src-tauri/`, releases: https://github.com/PDFCraftTool/pdfcraft
2. Public site and privacy page, HEAD and GET requests: https://pdfcraft.devtoolcafe.com/en/ and https://pdfcraft.devtoolcafe.com/en/privacy/
3. Issue #6 with the maintainer's replies, read in full: https://github.com/PDFCraftTool/pdfcraft/issues/6
4. Licence commit `e82c9003`, 2026-01-17: https://github.com/PDFCraftTool/pdfcraft/commit/e82c9003
5. Issues: https://github.com/PDFCraftTool/pdfcraft/issues
6. Launch post, then still calling itself MIT: https://dev.to/devfan/i-built-an-open-source-privacy-first-pdf-toolkit-80-tools-to-replace-adobe-here-is-the-stack-pgp
7. LibrePDF, metadata only: https://github.com/PDFCraftTool/LibrePDF

**ArtCraft**

8. Repository, README, `NOTICE`, `Cargo.toml`, releases: https://github.com/storytold/pdfcraft
9. Own assessment: `docs/target-app-parity.md`, `docs/gaps.md`, `docs/editing-existing-text.md`, `docs/editing-multiple-objects.md`, `docs/localization.md`, `parity/acrobat-features.toml` in the repository above
10. Issues: https://github.com/storytold/pdfcraft/issues
11. Product page, which still showed 0.14.0: https://getartcraft.com/apps/pdfcraft
12. Guide by P. Pillitteri, 2026-10-29, with the name warning: https://pasqualepillitteri.it/en/news/22545/pdfcraft-free-acrobat-alternative-guide
13. Release notes tracker: https://releasebot.io/updates/storytold/pdfcraft and AlternativeTo: https://alternativeto.net/software/pdfcraft/about/

**Other**

14. LibreOffice WASM package: https://www.npmjs.com/package/@matbee/libreoffice-converter
15. PdfCraft for Android: https://github.com/artcraft-android/pdfcraft-android
16. pdf-craft: https://github.com/oomol-lab/pdf-craft
17. App Store: https://apps.apple.com/ee/app/pdfcraft/id6746790039 and https://apps.apple.com/cn/app/pdfcraft-filler-signer-app/id1571443994
18. Hosted site with the same text, not examined: https://pdfcraftpro.pages.dev/en/about
