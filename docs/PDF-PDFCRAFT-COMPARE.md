# berg:work PDF compared with PdfCraft

Snapshot of 2026-10-30. berg:work: `origin/main` `7dac322`, Fernwork pin `082fd77a`. **PdfCraft:** the product at
https://getartcraft.com/apps/pdfcraft, by ArtCraft, v0.15.0 of 2026-10-28, repository `storytold/pdfcraft` at `fa5f9f8c`. The
vendor writes PdfCraft; people also write PDFCraft.

**PdfCraft was not installed.** No machine here could run it, and it has no hosted version. Every statement comes from its
source code, its documents or third parties. Nothing was timed, and no document went into it. berg:work was not rebuilt; its
facts come from the repository, the audit in `docs/PDF-TODO.md` and the live page's headers.

This is the companion to `PDF-PDFGEAR-PARITY.md`: same yardstick, and facts stated there are not repeated.

Marks in the last column of the tables:

- **code:** read in PdfCraft's source at the commit above.
- **vendor:** its README, docs, changelog, product page or own checklist. The checklist `parity/acrobat-features.toml` [4] is the
  main one: its tool rejects a `shipped` entry whose cited test does not exist, but the file is self-assessment. Its docs define
  `shipped` as "exists and tested", not "as good as Acrobat".
- **live:** a request to a public site, store or API today.
- **third:** independent source or a user's issue.
- **repo, audit:** berg:work, as in the PDFgear document.
- **none found:** I searched and found nothing. That is not proof of absence.

`[n]` is a source at the end. Effort is in person-days (PD), my estimate.

## 1. Short conclusion

| Question | Answer | Basis |
|---|---|---|
| Platform | **Not a Mac app.** macOS 11+ (universal, signed, notarised), Windows x64, x86, ARM64, Linux x86_64 and ARM64, FreeBSD, a self-hosted web build. Mobile: a separate Android repository, nothing on iOS | vendor, code, live [1][3][14] |
| Price | **Free** on every platform | vendor [1] |
| Model | **Neither purchase nor subscription.** Open source, no account, no paid tier, no in-app purchase. The subscriptions on the same site ($8–48 a month, credits) belong to ArtCraft Studio, a separate AI app | vendor [1][2] |
| App Store | **No listing** on the App Store or Mac App Store. Downloads come from the site, GitHub or the ArtCraft Launcher. So it has no store rating | live [13] |
| Stage | **Alpha** by its own account. First commit 2026-09-30, 16 releases in 27 days | vendor, live [1][3][5] |

**berg:work is the better editor. PdfCraft is the better product.** PdfCraft already ships much of what `PDF-TODO.md` still plans:
signed builds, updates, 35 UI languages including German, tabs, native printing, form scripts, an accessibility checker, signing
with OS key stores. On a Mac the comparison is stark: PdfCraft has an installer, and berg:work is a web page.

berg:work wins where the work is on the page's content. PdfCraft rates its own content editing at 30 % ready [4]; vector editing,
alignment, rulers and guides are planned. Its OCR reads unaccented English only, so German umlauts come out as "?" (#524) [6], and
its web build has no OCR and no signing. Its pages are drawn by a borrowed renderer. berg:work is also a page you open, with the
promise enforced by the browser.

**The lead has a short shelf life.** PdfCraft went from nothing to v0.15 in a month, built largely by agents, and prices text
editing at 100–180 agent-hours [4]. It also has 1,480 open issues and 1,147 open PRs [6], and says fuzzing still finds crashes [3].
Plan on the depth of editing no longer being a unique lead within months rather than years. What stays ours is PDFium, the
browser promise, and whatever ships first. Reach is the urgent front, not features.

Gaps that matter most and are not yet in `PDF-TODO.md` (details there, under *PDFCraft gaps*):

1. **PDF layers (optional content).** It matters for CAD plans. 3–5 PD.
2. **Multi-page TIFF as input.** Plans and scans come as TIFF. 1–2 PD.
3. **Signature check with chain, trust list and revisions.** 3–5 PD.
4. **Accessibility check and alt text.** 32 rules, report and fixes at PdfCraft. 4–7 PD.
5. **Form calculations and form data exchange.** 8–13 PD together.

The largest gaps remain the planned ones: the macOS and Windows builds, then the German UI. On Office conversion PdfCraft is
hardly ahead: Word export is weak, Office import absent, and it says so.

### Not this product

The name is crowded, so reviews must be read with care. The open-source browser toolkit `PDFCraftTool/pdfcraft` (AGPL-3.0, 9.7k
stars) is unrelated, and its tracker holds reports meant for this product. Its code must not be used here. Its comparison was
removed from this document and stays in the history of this branch (`fe5d216`). Others: `oomol-lab/pdf-craft` (Python, scanned
books), and on the stores "PDF Craft: PDF Converter" (Mac), "PDFCraft" (Varsha Patel), "PDFCraft - PDF sign", "PdfCraft: PDF
Scanner" and more [13]. None is by ArtCraft.

## 2. Better, worse, equal

### Where berg:work is better

- **Object editing.** Path points, object layers, groups, locking, align and distribute, rulers, guides, snapping, multi-selection
  with shared fields. All planned at PdfCraft; multi-selection there moves objects on one page only [4][5].
- **Editing by default.** Our paragraph path refuses what it would damage. PdfCraft says "do not interpret the passing real-file
  checks as a guarantee", substitutes fonts and reports wrong grouping of headings and cells (#1756, #1680) [4].
- **Rendering engine.** PDFium against a vendored `hayro` with 61 local patches that PdfCraft itself calls "borrowed" [3][4].
- **OCR for German and Europe.** 46 languages, deskew, area OCR, in the browser. PdfCraft has one model without accents, no deskew,
  nothing on the web.
- **PDF/A.** Ours is checked with veraPDF. Theirs is partial: 2b and 3b structure, no output intent for CMYK [4].
- **The hosted web app.** Open a page and everything works, on any device with a browser. PdfCraft's web build is a zip to host
  yourself, without OCR, signing or recovery.
- **Several windows.** Planned at PdfCraft [4].
- **Touch.** Two-finger transforms and touch handling exist. PdfCraft lists no touch mode [4]. Neither is proven on devices.

### Where berg:work is worse

- **Reach on every desktop.** Signed installers, portable builds, Flatpak, update prompts, 2.5 million asset downloads, updates
  included [5].
- **UI languages:** 35 against one.
- **Tabs, printing, reading:** tabs, native printing with n-up, booklet and poster, two-page view, full screen, colours.
- **Text editing details:** justified text, mixed styles in one editor, loading a font file, editing recognised text on scans.
- **Forms:** every field type, calculation, sandboxed scripts, XFA in part, data exchange.
- **Signatures:** OS key stores, certification, chain and revision checks, timestamps with a supplied token.
- **Redaction tools:** word lists, patterns, code sets, verification, an audit for fake redactions, hidden information removal.
- **Structure:** PDF layers, page labels, attachments, links, bookmarks from headings, replace pages.
- **Accessibility checker.**
- **Automation:** 141+ tools over CLI and MCP against our set of about a dozen, path confinement, control of the real UI.
- **Saving:** every save appends and leaves the original bytes intact, with undo after saving. Ours is incremental on signed PDFs.
- **Licence:** free for everyone, against BUSL-1.1 with an unpriced commercial licence.
- **Test evidence in public:** 963 of 983 pdf.js files clean, 958 round trips, 0 crashes on that corpus (vendor).

### Where they are about equal

Measuring (distance, perimeter, area, scale, CSV), comment workflow with replies, status and XFDF, compare (text, visual, side by
side), page basics, split, crop, header, footer, Bates, password protection, metadata, flatten, draw, type and image signatures,
local processing. Neither has find and replace in the UI, spell check, read aloud, a scanner, Excel export, Office import, AI in the
app or an iOS app.

### Where nobody can say yet

- **Text edit quality on hard PDFs.** No shared test. Two different approaches, and PdfCraft changes daily.
- **Speed.** Native Rust against WASM PDFium, but its raster is CPU only and users report slow scrolling and blurry text (#3793,
  #730) [4][6]. No measurement compares us.
- **Rendering fidelity.** A median 0.89 % pixel disagreement with Poppler over 229 files, and PdfCraft shows Poppler is often the one
  in the wrong [4]. Nobody compared it with PDFium.
- **Who pays for it, and for how long.** The page names no business model. The same site sells a generative-AI subscription, and a
  reviewer points that out [2][10]. The licence keeps the existing code free, whatever happens.

## 3. On the Mac

PdfCraft's Mac build is real, though not Mac-native in the sense of AppKit.

| Point | PdfCraft | Confidence |
|---|---|---|
| Install | Universal DMG, Developer ID `Learning Machines LLC`, notarised; separate signed CLI; ArtCraft Launcher | vendor [1][3][7] |
| Requirement | macOS 11 (`MACOSX_DEPLOYMENT_TARGET=11.0`). Not stated on the page | code |
| Interface | Rust with egui: drawn by the app, not AppKit. Menus native on macOS since 0.15 | code, vendor [5] |
| System | Keychain signing, CUPS printing, default PDF app, iCloud Drive recognised as a folder | vendor, code [4] |
| Not there | Mac App Store, Homebrew (#81 open), Quick Look extension (none found), pen pressure | live, third, code |
| Open reports | "Apple could not verify" on opening PDFs (#3371), lag on an old NVIDIA GPU (#3073), a Chinese IME (#4687), drag and drop (#354) | third [6] |
| Fixed reports | Crash on close, Cmd+Q without asking (#1136), crash on quitting (#3058), false "file changed" warnings (#3755) | third [6] |

berg:work has no Mac build at all: it runs in a Mac browser, and the entries under *Desktop apps* in `PDF-TODO.md` are open.

## 4. Licence

PdfCraft is MIT OR Apache-2.0 (`Cargo.toml`, `NOTICE`, README) [3]; GitHub's API shows Apache-2.0 only, and the product page says
only "open source". It claims to be a clean-room implementation from ISO 32000.

- **It does not restrict us as AGPL would.** Reuse is allowed with notices. **It is still Florian's decision**, and no code from it
  is in berg:work. It would also need a Rust-to-WASM path that does not exist here.
- **Excluded from the licence:** the ArtCraft name and logos (trademarks). OCR models are CC-BY-SA-4.0, fonts OFL.
- **Agent-written code.** Its docs plan in agent-hours and its rules address agents first. Whether that affects copyright is an open
  legal question, which matters for anyone taking it over.

## 5. Privacy

berg:work: see section 4 of the PDFgear document.

| Point | PdfCraft | Confidence |
|---|---|---|
| Documents | "No account, no telemetry, no cloud"; local processing | vendor [1] |
| Network at run time | Update check with a prompt at start since 0.15, using `craft-update`. Not audited further | vendor, code [5] |
| MCP | Opt-in, stdio, no port; `--root` confines paths | vendor, code [3] |
| UI control channel | Off by default, loopback, random token | vendor [3] |
| Web build | Whoever hosts it sets the CSP | vendor |

So PdfCraft's promise rests on the source being open and the app being native. Ours is enforced by the browser for anyone who opens
the page. Neither has been audited by a third party, as far as I found.

## 6. Feature table

"Ahead" names who leads. Confidence lists the marks for PdfCraft; berg:work.

### Editing

| Feature | PdfCraft | berg:work | Ahead | Confidence |
|---|---|---|---|---|
| Edit existing text | Paragraph editor, Latin solid, own "ready" 30 % | PDFium objects, no whiteout | berg:work, with doubt | vendor; repo, audit |
| Mixed styles in a paragraph | One editor; untouched rows keep their operators | *Edit as paragraph* refuses them | **PdfCraft** | vendor; repo |
| Justified text | Yes, single style | Becomes left-aligned | **PdfCraft** | vendor; repo |
| Letter spacing, scale | Yes | Alignment | PdfCraft | vendor; repo |
| Lists | Planned | None (PowerPoint parity) | equal | vendor; repo |
| Right-to-left | Partial, Arabic and Hebrew | Refused | PdfCraft | vendor; repo |
| Find and replace | Planned | CLI only | berg:work, slightly | vendor; repo |
| Spell check | Planned | None | equal | vendor; repo |
| Fonts | Load a file, installed fonts; a full face completes subsets | PDF fonts, bundled | **PdfCraft** | vendor; repo |
| Editing text on scans | Covers and redraws in the sampled colour | No | PdfCraft | vendor; repo |
| Images | Add, replace, crop, rotate, flip, extract | Add, replace, drop, opacity, rotate | equal | vendor; repo |
| Vector paths | Planned | Points, fill, stroke, opacity | **berg:work** | vendor; repo |
| Object layers, groups, lock | Planned | Yes | **berg:work** | vendor; repo |
| Align, distribute | Planned | Yes | **berg:work** | vendor; repo |
| Multi-selection | Move on one page | Yes, shared fields with Mixed | **berg:work** | vendor; repo |
| Rulers, guides, snapping | Planned | Yes, equal spacing, Alt distances | **berg:work** | vendor; repo |
| Links | Create, edit, from URLs | Read only (PDFgear parity) | **PdfCraft** | vendor; repo |
| Undo | Named steps, also after saving | History back to the saved state | PdfCraft, slightly | vendor; audit |
| Saving | Incremental by default, atomic, autosave each minute, recovery | Atomic in the app, journal, recovery | PdfCraft, slightly | vendor; repo |

### Annotations

| Feature | PdfCraft | berg:work | Ahead | Confidence |
|---|---|---|---|---|
| Markup types | All, with appearances | Yes | equal | vendor; repo |
| Replies, status, XFDF | Yes, also FDF and summaries | Yes | PdfCraft, slightly | vendor; repo |
| Stamps | 12 standard, dynamic, custom | Presets, own image | **PdfCraft** | vendor; repo |
| Pen | Pointer ink, no pressure | Same | equal | vendor; repo |

### Forms

| Feature | PdfCraft | berg:work | Ahead | Confidence |
|---|---|---|---|---|
| Create fields | Every AcroForm type, tab order, styles | Four types | **PdfCraft** | vendor; repo |
| Calculation, formats | Acrobat's AF functions, event order, date picker | None | **PdfCraft** | vendor; repo |
| Scripts | Sandboxed JavaScript (boa), console | None | **PdfCraft** | vendor; repo |
| Form data | XFDF, FDF, XML, CSV, tab-delimited | None found | **PdfCraft** | vendor; repo |
| XFA | Static and dynamic, partial | Warns | **PdfCraft** | vendor; repo |

### Pages

| Feature | PdfCraft | berg:work | Ahead | Confidence |
|---|---|---|---|---|
| Organise, extract, split | Grid, every n, size, bookmarks | Panel, touch, same split modes | equal | vendor; repo |
| Merge with forms and tags | Keeps links, fields, layers, attachments | Engine refuses | **PdfCraft** | vendor; repo |
| Replace, reverse pages | Yes | None | PdfCraft | vendor; repo |
| PDF layers (optional content) | Panel, show, hide | None | **PdfCraft** | vendor; repo |
| Page labels | Read, edit | None | **PdfCraft** | vendor; repo |
| Attachments | Add, delete, open | Not shown (PDFgear parity) | **PdfCraft** | vendor; repo |
| Bookmarks from headings | From tags or text styles | Manual | **PdfCraft** | vendor; repo |
| N-up, booklet, poster | In the print dialog | None (N-up in PDFgear parity) | **PdfCraft** | vendor; repo |
| Crop, resize | Crop, page boxes | Margins, area, content, white, sizes | berg:work, slightly | vendor; repo |
| Headers, numbers, Bates | Yes; Bates on one file | Yes, batch | equal | vendor; repo |
| Watermark, background | Add, update, remove | Add, batch | PdfCraft | vendor; repo |

### Conversion

| Feature | PdfCraft | berg:work | Ahead | Confidence |
|---|---|---|---|---|
| Office to PDF | Planned, as a LibreOffice sidecar | None | equal | vendor; repo |
| PDF to Word | Flowing, loses layout (#773) | None | PdfCraft | vendor; repo |
| PDF to Excel | Planned | None | equal | vendor; repo |
| PDF to PowerPoint | Partial | None | PdfCraft | vendor; repo |
| PDF to RTF, HTML, Markdown | RTF yes, the others partial | None | PdfCraft | vendor; repo |
| PDF to images | PNG, JPEG, TIFF | CLI only (PDFgear parity) | **PdfCraft** | vendor; repo |
| Extract embedded images | Yes, JPEG unchanged | None | **PdfCraft** | vendor; repo |
| Images to PDF | PNG, JPEG, TIFF with pages, GIF, BMP, JPEG 2000 | HEIC, WebP, AVIF, SVG; **no TIFF** | open | vendor; repo |
| Scanner, virtual printer | None | None | equal | vendor; repo |

### OCR

| Feature | PdfCraft | berg:work | Ahead | Confidence |
|---|---|---|---|---|
| Engine | ocrs, ONNX models | Tesseract in the page | open | code; repo |
| Languages | **English alphabet, no accents** | 46; Latin, Greek, Cyrillic | **berg:work** | code, third; repo |
| Deskew | Planned | Yes | **berg:work** | vendor; repo |
| Area | None found | Yes | berg:work | none found; repo |
| In the browser | No (#103) | Yes | **berg:work** | vendor, third; repo |
| Many files | Yes, into a folder | Open documents | PdfCraft | vendor; repo |
| Camera pages | Four-corner straightening, clean-up | Open under OCR | PdfCraft | vendor; repo |

### Signatures

| Feature | PdfCraft | berg:work | Ahead | Confidence |
|---|---|---|---|---|
| Draw, type, image | Yes, one saved signature (#1288 asks for more) | Yes, saved signatures | berg:work, slightly | vendor, third; repo |
| Certificate signature | PAdES B-B, PKCS#12, Keychain, Windows store, certification. Not on web | PKCS#12, PEM, self-signed, detached | **PdfCraft** | vendor; repo |
| Check signatures | Chains, revisions, DocMDP, trust store, view signed version | Integrity, coverage | **PdfCraft** | vendor; repo |
| Timestamp, LTV | With supplied evidence; no timestamp server or online revocation | None | PdfCraft | vendor; repo |
| Smartcard, PKCS#11 | No, outside the Windows store | None | PdfCraft, slightly | vendor; repo |

### Security and redaction

| Feature | PdfCraft | berg:work | Ahead | Confidence |
|---|---|---|---|---|
| Passwords | All levels to AES-256, strength meter | AES-256, verified with qpdf | equal | vendor; repo, audit |
| Redaction | Glyphs, pixels, vectors, annotations, tags; re-read after applying | Glyphs, images, annotations, fields; preview | equal | vendor; repo |
| Word lists, patterns, codes | Yes, also FOIA and Privacy Act | Dialog; regex in the CLI | **PdfCraft** | vendor; repo |
| Audit for fake redactions | Partial | None | PdfCraft | vendor; repo |
| Remove hidden information | Yes, Sanitize | Strip metadata | **PdfCraft** | vendor; repo |
| PDF/A | 2b, 3b; verify and convert; partial, no CMYK | 2b, 3b; veraPDF outside the app | **berg:work** | vendor; audit |
| Accessibility | 32 rules, report, fixes, alt text, partial auto-tag | None | **PdfCraft** | vendor; repo |
| Certificate security | Planned | None | equal | vendor; repo |

### Compare, measure, batch

| Feature | PdfCraft | berg:work | Ahead | Confidence |
|---|---|---|---|---|
| Compare | Text, visual, side by side, PDF report | Text, visual, side by side, overlay | PdfCraft, slightly | vendor; repo |
| Measure | Distance, perimeter, area, scale, CSV | The same | equal | vendor; repo |
| Measure snapping | Ends, **midpoints, intersections**, inside Forms | Corners, line ends | PdfCraft | vendor; repo |
| Batch | Action Wizard, 12 step kinds, folders | A few steps, open documents | **PdfCraft** | vendor; repo |
| CLI, MCP | 141+ tools, resources, `--compact`, `--root`, Rust API | About a dozen, local paths | **PdfCraft** | vendor; repo |
| Agent on the real window | `--control` on loopback with a token | Planned (Step 4) | PdfCraft | vendor; repo |

### AI

| Feature | PdfCraft | berg:work | Ahead | Confidence |
|---|---|---|---|---|
| AI in the app | None; a local provider interface is planned, not started | None; agent panel planned (Step 4) | equal | vendor; repo |

### Reading

| Feature | PdfCraft | berg:work | Ahead | Confidence |
|---|---|---|---|---|
| Two-page view, full screen | Yes | No; F11 in the app (PDFgear parity) | **PdfCraft** | vendor; repo |
| Page colours | Replace document colours, bug reported (#3443) | No | PdfCraft | vendor, third; repo |
| Tabs | Yes | Dropdown | **PdfCraft** | vendor; repo |
| Several windows | Planned | Yes, in the app | **berg:work** | vendor; repo |
| Read aloud | None | None | equal | vendor; repo |
| Search | As you type, results panel, bookmarks filter | Yes | PdfCraft, slightly | vendor; repo |

### Rendering and speed

| Feature | PdfCraft | berg:work | Ahead | Confidence |
|---|---|---|---|---|
| Engine | `hayro` vendored, 61 local patches; own renderer planned | PDFium WASM, 29 Fernwork patches | **berg:work** | vendor; repo |
| Raster | CPU only; 500 pages scroll smoothly by its account | WASM, 1.1–2.2× slower than native PDFium | open | vendor; audit |
| After an edit | Not measured | 1.3 s per markup, 1.6–14 s commit | open | none found; audit |
| Corpus | 963 of 983 clean, 958 round trips, 0 crashes | Harness, 36-file quick run | PdfCraft on evidence | vendor; repo |
| Download | Installers 91–111 MB, web zip 17 MB | `dist/` 124 MB, binary 72 MB | PdfCraft, slightly | live; audit |
| Large files | No lazy loading of GB files | 2 GB WASM cap | open | vendor; audit |

### Platforms

| Feature | PdfCraft | berg:work | Ahead | Confidence |
|---|---|---|---|---|
| macOS | Section 3 | Browser only | **PdfCraft** | vendor; repo |
| Windows | Signed MSI, portable; x64, x86, ARM64 | Configured, not built | **PdfCraft** | vendor; repo |
| Linux | AppImage, Flatpak, deb, rpm, tarball; also ARM64, RISC-V | Internal build | **PdfCraft** | vendor; repo |
| Hosted web app | None, zip to host | Yes | **berg:work** | live; live |
| Web depth | No OCR, signing or recovery; prints as pictures | Everything | **berg:work** | vendor; repo |
| Android | Separate repository, 201 stars, not assessed | PWA with share target | open | live; repo |
| iOS, iPadOS | None | PWA | berg:work, slightly | live; repo |
| Stores | None. Winget and a Gentoo overlay | None | PdfCraft, slightly | third, vendor; repo |
| Updates | Prompt at start, self-update, zsync | None | **PdfCraft** | vendor; repo |

### Price, licence, UI

| Feature | PdfCraft | berg:work | Ahead | Confidence |
|---|---|---|---|---|
| Price, model | Free, no purchase, no subscription | Free for individuals, up to three people, education | **PdfCraft** for companies | vendor; repo |
| Licence | MIT or Apache-2.0 | BUSL-1.1 | PdfCraft | code; repo |
| UI languages | 35 including German; 34 catalogs plus English, native-speaker review still open | English | **PdfCraft** | code; repo |
| UI model | Acrobat-like: tools panel, rail, ⌘K, tool modes | Islands, mini toolbar, Ctrl+K, direct manipulation | berg:work for experts, by audit only | vendor; audit |
| Keyboard, screen reader | Keyboard-only is a planned P0; screen reader partial | Keyboard and ARIA work, no audit | open | vendor; repo |
| Stage, pace | Alpha, a release every two days | Daily, unreleased | PdfCraft on pace | live; repo |
| Documentation | README and project docs; no end-user manual found | README, developer docs | equal | live; repo |

## 7. Ratings and complaints

**There is no store rating, because there is no store listing** [13]. Reviews are thin, so sentiment cannot be weighed as for
PDFgear.

- **AlternativeTo:** 34 likes, two reviews, both five stars: "Works fast and has a lot of editing features on Linux" (2026-10-19), and
  a good first impression, still alpha (2026-10-09) [9].
- **Trustpilot:** nothing on PdfCraft. ArtCraft's site has two reviews, the visible one about VectorCraft [12].
- **Press:** PetaPixel and TweakTown covered the Adobe clone story in October; both refused my fetch, so I know them from search
  excerpts only [11]. A Substack writer tried the Lightroom clone and calls it "alpha software", but does not test PdfCraft [10].
  Gizmodo's page is a download listing [8], and most other coverage is one publisher's translated guide [16]. I found no independent
  hands-on review of PdfCraft and no German press.
- **Its own count,** on 2026-10-10: 23 of 359 issues carry explicit praise, with reports of switching from Adobe Reader and Preview.
  Issue themes: install, launch and GPU 54, rendering 46, editing 41, fonts 41, signing 35, printing 23 [4].
- **Adoption:** 18,755 stars, 7,072 forks, 2.55 million asset downloads over 16 releases. Repeats, updates and checksum files are
  counted, so this is an upper bound [5].

Most discussed issues [6]: Chinese glyph boxes (#826), printers missing or failing (#160, #3032), Windows printing substitutes glyphs
(#3132), umlauts in OCR (#524), OCR on the web (#103), saved signatures (#1288), right-to-left (#2339), crashes on old GPUs (#4134),
scroll speed (#3793), colours reverting (#3443).

## 8. What we deliberately do not match

- **Chasing Acrobat's feature list.** 847 rows is PdfCraft's strategy, and it is cheap for them. Ours is depth on the page.
- **Own renderer.** PDFium stays. PdfCraft's largest open item is one we do not have.
- **Local models or provider interfaces.** Excluded by Step 4 of `PDF-TODO.md`.
- **A "clone of Acrobat" as positioning.** It invites comparison with the original on every row.

## 9. Checks on the real product

Needs one session on a Mac or the Windows PC. Use the five audit PDFs from the PDFgear document. 1 PD.

1. Text edits on both: subset fonts, bold words, enlarging, what the saved file contains (`pdffonts`, `qpdf`).
2. Redaction: are glyphs and image data gone (`pdftotext`, `pdfimages`)?
3. Merge of PDFs with forms and tags, and whether Acrobat opens the result.
4. Timings on GeoTopo and a 500 MB scan.
5. Word export on a table and a two-column layout.
6. Certificate signature in Acrobat, and a network capture of the app at start.
7. Check the Mac: first launch from the DMG, the "could not verify" report (#3371), VoiceOver.

## 10. Corrections to other documents

- `PDF-TODO.md`, *Merge PDFs with forms or tags:* PdfCraft shows that keeping forms, links and layers is possible. The benefit stands.
- `PDF-TODO.md`, *PowerPoint parity, Layout:* align and equal spacing already exist in the Arrange popover (`ARRANGE_SECTIONS`).
  Slide grids remain.
- `PDF-TODO.md`, *Image to PDF, HEIC:* marked in progress, while this `main` already has it in the shell and the README. Check and
  close.
- `PDF-TODO.md`, *Office to PDF, spike:* a side finding from the unrelated toolkit: `@matbee/libreoffice-converter`, MPL-2.0 by its npm
  entry [15], is a second candidate next to ZetaOffice. 77 MB gzipped, web only, because WebKitGTK has no `SharedArrayBuffer`.
  Bundled parts need a licence check. Left unchanged here.
- Fernwork's `docs/pdf/TODO-editor-feel-and-features.md` is not in the local Fernwork checkout at that path, so the new gaps were only
  checked against this repository's documents.
- PdfCraft's own prose lags its data: 57 % and 23 languages in `docs/target-app-parity.md`, against 61 % (my count, 824 rows in scope,
  452 shipped, 102 partial at half) and 35 languages in the repository. The product page still showed 0.14.0 and Rust 1.90.

## Sources

Read on 2026-10-30, by me, without installing anything. Repository figures are from GitHub's public API that day. Issues are known
from titles. PetaPixel and TweakTown answered 403 and Reddit was not read, so those are excerpts or absent.

**PdfCraft, primary**

1. Product page, v0.14.0 at reading: https://getartcraft.com/apps/pdfcraft
2. ArtCraft pricing, which prices only ArtCraft Studio: https://getartcraft.com/pricing
3. Repository, README, `NOTICE`, `Cargo.toml`, `packaging/macos`: https://github.com/storytold/pdfcraft
4. Own assessment in that repository: `docs/target-app-parity.md`, `docs/gaps.md`, `docs/editing-existing-text.md`, `docs/editing-multiple-objects.md`, `docs/hardware-parity.md`, `docs/localization.md`, `parity/acrobat-features.toml`
5. Changelog: https://github.com/storytold/pdfcraft/releases, notes of v0.14.0 and v0.15.0 read in full
6. Issues: https://github.com/storytold/pdfcraft/issues
7. ArtCraft Launcher: https://github.com/storytold/craft-launcher

**Third parties**

8. Gizmodo download listing: https://gizmodo.com/download/pdfcraft
9. AlternativeTo: https://alternativeto.net/software/pdfcraft/about/
10. A. Morganti, 2026-10-10, on the clones, not on PdfCraft: https://anthonymorganti.substack.com/p/i-tried-the-free-photoshop-and-lightroom
11. Excerpts only: https://petapixel.com/2026/10/07/someone-rebuilt-free-open-source-versions-of-photoshop-premiere-and-lightroom-using-ai/ and https://www.tweaktown.com/news/113989/developer-says-software-is-over-after-using-ai-to-recreate-adobes-entire-creative-cloud-suite-for-free/index.html
12. Trustpilot: https://www.trustpilot.com/review/getartcraft.com
13. Apple's search API, terms "pdfcraft" and "artcraft", Mac and iOS: https://itunes.apple.com/search?term=pdfcraft&entity=macSoftware
14. PdfCraft for Android: https://github.com/artcraft-android/pdfcraft-android
15. LibreOffice WASM package: https://www.npmjs.com/package/@matbee/libreoffice-converter
16. Guide by P. Pillitteri, 2026-10-29, secondary: https://pasqualepillitteri.it/en/news/22545/pdfcraft-free-acrobat-alternative-guide
