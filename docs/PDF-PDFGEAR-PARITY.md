# berg:work PDF compared with PDFgear

Snapshot of 2026-10-30. berg:work: `origin/main` `f8fdac9`, Fernwork pin `9c70a1ae`, plus the branches
`fix/pdf-image-input` (`fd51d18`) and `feat/pdf-desktop-windows` (`e85ddb8`, which is about app windows, not the
Windows OS). PDFgear: desktop 3.0.1 (2026-10-22), iOS 2.29 (2026-09-24), Android store listing of 2026-10-22.

**PDFgear was not run.** No machine here can install it, so every PDFgear statement comes from a source. Nothing below
was timed against it, and no document was uploaded to it. berg:work was not rebuilt for this comparison; its facts come
from the repository, the audit in `docs/PDF-TODO.md` and the HTTP headers of the live page.

Marks in the last column of the tables:

- **repo:** read in this repository.
- **audit:** our own hands-on review or measurement (`docs/PDF-TODO.md`, `PDF-DESKTOP-VORTEILE.md`).
- **live:** seen on bergwork.app or in the public store listing today.
- **vendor:** PDFgear's own pages, changelog, privacy policy or store text. Includes staff replies in its forum.
- **third:** independent or competing review, tracker or user report. Competitors are named as such.
- **none found:** I searched and found nothing. That is not proof of absence.

`[n]` is a source at the end. Effort is in person-days (PD), my estimate unless another document gave it first.

## 1. Short conclusion

**berg:work is the deeper editor. PDFgear is the wider product.** PDFgear does most of what ordinary users want from a
PDF program, on every platform they own, for free, in eleven languages. berg:work beats it where the work is real
document work: objects, paths, redaction, comparing, measuring, comments, archiving, automation, and a privacy promise
the browser enforces. It loses on everything around the editor.

The gaps that decide the comparison are five:

1. **Office conversion.** PDFgear does it in both directions, berg:work not at all.
2. **Reach.** PDFgear has signed apps on Windows, macOS, iOS and Android, with 3.7 million Android installs [12]. berg:work
   is a web page and an internal Linux build.
3. **AI.** PDFgear has chat, summary, translation and commands, over the cloud. berg:work has nothing in the app.
4. **Language.** PDFgear ships eleven UI languages including German [10]. berg:work is English only.
5. **Reading and small tools.** Two-page view, slide show, read aloud, image export, links, attachments: each is small,
   together they make berg:work look unfinished next to a free app.

### The iOS questions

| Question | Answer | Why |
|---|---|---|
| Does PDFgear edit text on iOS? | **Yes, since 2.9 of 2024-08-06.** | App Store version history [10], vendor guide with the steps [8] |
| Does it edit images on iOS? | **Yes, since 2.12 of 2024-11-13.** | Version history [10]. Adding, moving and removing are confirmed hands-on on Android only [15] |
| Paragraphs on iOS? | Partly. 2.27 of 2026-09-04 adds adjustable paragraph width. | Version history [10]; user reports of breakage below |
| Why did sources disagree? | The old reviews are stale. TechRadar found no text editing on mobile, but was published on 2024-02-06, before 2.9 [16]. SwifDoo still says so in a page updated 2026-04-27 [17]; it is a competitor and contradicts the store. | Dates |
| Is it really free on mobile? | **Today yes, as far as anyone can see.** No in-app purchases on either store, no ads listed [10][12][13]. | Stores, tracker |
| Will it stay free? | **No promise.** The vendor says most features stay free, and that AI, high-accuracy OCR and complex conversions may become paid, with notice [4][5]. On Android it warns of future charges [9]. | Vendor |
| Does mobile run offline? | Mostly. AI needs the network [9], and "some mobile tasks" run on servers, which ones is not said [4]. | Vendor |

**What mobile lacks.** In February 2026 PDFgear's staff confirmed that Android has no password protection, no watermark
and no flatten or redact tool, and said some would come in future updates [6]. The iOS version history shows none of these
either [10]. Whether mobile has OCR is disputed: UPDF, a competitor, tested in July 2026 and found none in mobile v2.23 [18];
a vendor page of 2026-10-06 says the iOS app converts with OCR [22]; MakeUseOf lists OCR on Android [15]; the store text
does not mention it.

## 2. Better, worse, equal

### Where berg:work is better

- **Editing depth.** Vector paths by point, fill and stroke; objects with layers, grouping, locking, stacking order; snapping,
  equal-spacing guides; multi-selection with shared fields; an edit model that works on PDFium objects and refuses what
  it cannot do, with no whiteout fallback for native object edits. For PDFgear I found none of this, and a hands-on
  reviewer missed alignment and spacing controls [14].
- **Editing in the browser.** PDFgear says itself that only the desktop app changes existing text; its web editor only
  adds content [23]. berg:work has the same editor on the web.
- **Linux.** PDFgear has no Linux version [15][29].
- **Redaction on every surface,** with Find and redact, removal of form fields underneath, and regex through the CLI. PDFgear
  has it on desktop only, in the changelog since 2.1.13 of October 2025 [3][6].
- **Compare.** Visual and text comparison with overlay. PDFgear has none: staff called it "a comprehensive feature" they
  "might try to build" in February 2026 [6], and no changelog entry since adds it [3].
- **Measuring** with scales, calibration and CSV. None found at PDFgear.
- **Comment workflow:** replies, review status, filters, XFDF.
- **PDF/A** with a veraPDF check. None found at PDFgear.
- **Splitting** by bookmarks or size, **Bates numbers.** PDFgear splits by ranges and intervals [1] and its Bates guide
  only describes other products [24].
- **OCR detail:** 46 languages against 30+, deskew, and it demonstrably runs in the page.
- **CLI and MCP server.** Agents can drive the engine with local paths. Nothing comparable found.
- **Privacy that is enforced, not promised.** The live page's CSP allows network access only to its own origin and
  jsDelivr, and the Permissions-Policy turns the camera off. No analytics SDK, no cloud path. See section 4.
- **Inspectable source.** The source is readable under BUSL-1.1. Cure53 could only see the snippets PDFgear chose to
  share [2].

### Where berg:work is worse

- **Office conversion** in both directions: none (section 3).
- **Native apps and stores:** no Windows, macOS, iOS or Android app, no signed installer, no store listing.
- **Files on iOS:** the PWA cannot receive, share into or save back to a file (`PDF-MOBILE-VORTEILE.md`).
- **AI:** none in the app.
- **UI languages:** English only.
- **Reading:** no two-page view, slide show, read aloud or night page colour.
- **Export:** no PDF to image or text in the app (CLI only). Image to PDF as a new document waits on a branch.
- **Links and attachments:** links are read-only; attachments are not shown.
- **Printing:** browser dialog only, no N-up, no virtual printer, no batch print.
- **Scanner input:** none. PDFgear has a scanner path on desktop and a scan app.
- **Batch:** a few steps over open documents; PDFgear also batches conversion, flatten and print.
- **Tabs:** PDFgear got them in 3.0.0; the islands chrome has a dropdown.
- **Several OCR languages in one run:** PDFgear yes [25], berg:work no. Same for CJK and Arabic scripts in the text layer.
- **Business use:** PDFgear is free for companies [1]. berg:work's licence covers individuals, organisations of up to
  three people and education; everyone else needs a commercial licence that has no price yet.
- **Track record:** PDFgear has years of users and bug reports across platforms. berg:work has a corpus, not a user base.

### Where they are about equal

Annotation basics, page organising, merge, watermark, page numbers and headers, bookmarks, metadata, flatten, form filling,
form design for the common field types, draw/type/image signatures, certificate signatures, password protection,
compression, offline use once loaded.

### Where nobody can say yet

- **Text edit quality in hard PDFs.** This is the comparison that matters most, and no source settles it. PDFgear users
  report one word per line after enlarging text [10] and a row moving by itself [11]. berg:work's *Edit as paragraph*
  refuses mixed fonts, which may mean more refusals and fewer breakages. It needs the same PDFs on both.
- **Speed.** PDFgear is native and probably faster on large files, but nothing measures it. Users report slow loads and
  crashes [11]. Our commit latency (1.3 s per markup, 1.6–14 s after release) is a known weakness either way.
- **Certificate signatures.** PDFgear's format, timestamp and LTV support are not documented.
- **Merge.** Our engine refuses PDFs with forms or tags. What PDFgear does with them is unknown.

## 3. Conversion, the largest gap

PDFgear's offer is wide but not as good as its word "lossless":

- Its desktop app converts PDF to Word, Excel, PowerPoint, RTF, TXT, JPG, PNG and back, in batches, locally [1][26]. 3.0.0
  added more Office output options [3]. "Over 30" and "60+" formats are marketing figures I could not check.
- Staff describe the method themselves: compute the coordinates of all objects and put them back, and it "won't always be
  exactly the same", especially with complex layouts [6].
- Results for simple digital PDFs are reported as good [14]. For complex ones reviews advise manual repair [19].
- UPDF, a competitor, reports that a scan through PDFgear's OCR gave Word 80 of 547 words [18]. One file, one test, by
  an interested party.
- The online converter uploads to AWS in the US with a 100 MB limit, and PDFgear's pages give three different deletion
  times [26][27].

The bar is therefore "usable on ordinary documents", not "faithful". Two corrections to our own plans follow:

- **`PDF-TODO.md` calls Office conversion "not feasible in the browser".** That is true of Office to PDF at good fidelity,
  but not of PDF to Word. PDFgear's own description, positioned objects from coordinates, needs no Office engine.
  We already have PDFium inspection, `text/block-detection.js` and JSZip in the page, so a layout-keeping DOCX is ordinary work.
- **Fernwork's Word to PDF** (`tools/js/converters/documents-converter.js`) runs Mammoth into `html2pdf.js` with html2canvas
  (read in the Fernwork checkout). It loses layout and renders through a canvas, so it is not parity. Real fidelity needs a real office
  layout engine: LibreOffice where installed (desktop), or a LibreOffice WASM build such as ZetaOffice in the browser, whose
  download size and licence terms I could not confirm [44].

## 4. Privacy

berg:work promises on its live page: "Files never leave your device." The Content-Security-Policy backs that with
`connect-src 'self' data: blob: https://cdn.jsdelivr.net`, and jsDelivr serves only OCR language data.

| Point | PDFgear | berg:work |
|---|---|---|
| Editing | Local on desktop [1], browser-based web editor [23], "some mobile tasks" on servers [4] | Local everywhere (repo, live) |
| Conversion | Local on desktop by its own account [4]; online tools upload to AWS US [26][27]; a July test found Mac conversion online [18] | Nothing to convert yet |
| AI | PDF content and chat text go to Microsoft Azure OpenAI after consent in the app; retention not stated [7]. A forum reply names OpenAI's policy instead [6]. A user reports uploading by accident through the floating buttons [6] | None |
| Retention of uploads | Immediately after download, 20 minutes after leaving, or on closing the browser, depending on the page [26][27]. The policy gives no period [7] | No uploads |
| Telemetry | Google Analytics and advertising technology in the policy [7]; Firebase on both mobile apps, Snap's ad SDK detected on iOS on 2026-10-17 [12][13]; store label "Usage Data, not linked" [10] | No analytics in `apps/pdf/web` or the shell (repo); the CSP leaves only the own origin and jsDelivr. Crash reports are planned, opt-in |
| Legal | Singapore company, data in the US, no EU representative named, desktop not addressed separately [7] | German licensor; documents reach no server |
| Trust dispute | A malware claim on Reddit, answered by the vendor as a smear campaign [4]. **Cure53 (2026-03-19) found no malicious behaviour, but saw only snippets chosen by PDFgear of v2.1.14 and "cannot testify" about the whole application.** It also reports undocumented COM interfaces and reverse-engineered internals that avoid Windows prompts, and MD5 for update integrity [2] | Source readable |

The dispute should not be overstated. The audit found no malware and I found no evidence of data misuse. But PDFgear's
local processing holds only for parts of the product, and that is the honest difference.

## 5. AI without upload

Parity with PDFgear's AI does not have to mean the cloud. What is possible on the device, by source, not tried here:

| Path | What | Limits |
|---|---|---|
| Chrome built-in AI [41] | Translator, Summarizer, Prompt API, stable since Chrome 138, local after a model download | Chrome on desktop; 22 GB free disk, over 4 GB VRAM or 16 GB RAM with 4 cores. Other browsers and the Tauri WebViews untested |
| Bergamot [42][43] | Local translation in WASM, MPL-2.0, as in Firefox | About 30 MB per direction (third party). Mozilla's bucket sends no CORS headers, so we must host the models; CSP already allows the own origin. No mobile test |
| Local model in the desktop app | `llama.cpp` or ONNX, optional download | Several GB; 10+ PD by `PDF-DESKTOP-VORTEILE.md` |
| System models on phones | Apple Foundation Models, ML Kit GenAI | Few devices; German on Apple unconfirmed (`PDF-MOBILE-VORTEILE.md`) |
| Agents through MCP | Exists. The user's own agent reads the document | Not an end-user feature; where the text goes is the agent's business |

None of these reaches PDFgear's quality on every device. Together they cover translation everywhere and summaries on capable
machines, with the promise intact.

## 6. Feature table

"Ahead" names who leads, or "open" if sources cannot decide.

### Editing

| Feature | PDFgear | berg:work | Ahead | Confidence |
|---|---|---|---|---|
| Edit existing text | Desktop, iOS, Android, not web; font, size, colour, spacing [1][10][15][23] | All surfaces, on PDFium objects, no whiteout | berg:work on web, else open | vendor, third; repo, audit |
| Paragraph reflow | Text blocks; paragraph width on iOS [10]; reviews say line by line [20] or blocks [15]; breakage reported [10][11] | *Edit as paragraph*: one reflowing box; refuses mixed fonts, bold words, TeX; justified text becomes left-aligned | open | third, vendor; repo |
| Alignment, letter and line spacing | A reviewer missed alignment and spacing [14]; Mac page lists spacing [1] | Alignment on reflowing text | open | third; repo |
| Fonts | "Extensive" list; says formatting stays [28] | Fonts from the PDF, bundled substitutes, preview on hover; no system fonts | open | vendor; repo |
| Find and replace | None found | CLI `replace-text` only | open | none found; repo |
| Images: add, move, resize, replace, delete | Yes on desktop [1], Android [15]; iOS from 2.12 [10] | Yes, plus drop to replace, opacity, rotation | berg:work, slightly | vendor, third; repo, audit |
| Vector paths | None found | Point editing, fill, stroke, width, opacity | **berg:work** | none found; repo, audit |
| Objects: layers, groups, lock, order | None found | Yes | **berg:work** | none found; repo, audit |
| Snapping, guides, rulers | None found | Yes, with equal spacing and Alt distances | **berg:work** | none found; repo, audit |
| Copy and paste style, duplicate step | None found | Yes | **berg:work** | none found; audit |
| Erase content | Direct erase tool since 2.1.13 [3] | Delete the object; no eraser for scans | PDFgear on scans | vendor; repo |
| Links | "Edit … links" [29] | Read only | **PDFgear** | vendor; repo |
| Editing scanned text | No, convert to Word instead [28] | No, invisible text layer | equal | vendor; repo |
| Undo | Not documented | Undo history, back to the saved state, across page changes | berg:work, weakly | none found; audit |

### Annotations

| Feature | PDFgear | berg:work | Ahead | Confidence |
|---|---|---|---|---|
| Highlight, underline, strike, notes, shapes, text box, ink | Yes [13][29] | Yes | equal | vendor; repo |
| Callout, cloud, polygon, polyline | None found | Yes | berg:work | none found; repo |
| Stamps | Custom stamp management since 2.1.13 [3] | Presets and own image; resize and library open | PDFgear, slightly | vendor; repo |
| Comment list | Annotation panel [30] | Panel with filters, author, status | berg:work | vendor; repo |
| Replies, review status, XFDF | None found | Yes | **berg:work** | none found; repo |
| Pen on tablets | Native, Apple Pencil work in 2.8 [10] | A pen acts as a mouse; no pressure | **PDFgear** | vendor; repo |

### Forms

| Feature | PDFgear | berg:work | Ahead | Confidence |
|---|---|---|---|---|
| Fill AcroForm | Yes | Yes, with phone zoom and field navigation | equal | vendor; repo |
| Fill flat forms | Text, tick, cross, shapes [31] | Text tool; no tick or cross | PDFgear, slightly | vendor; repo |
| Create fields | Text, check box, dropdown, radio, on desktop and web [31]. A reviewer finds it limited for complex forms [14] | Text, check box, dropdown, radio | equal | vendor, third; repo |
| Scripts, calculation | None found | None found | equal | none found |
| XFA | None found | Warns, keeps AcroForm only | open | none found; repo |

### Pages

| Feature | PDFgear | berg:work | Ahead | Confidence |
|---|---|---|---|---|
| Reorder, rotate, delete, insert, extract, duplicate | Yes [1]; iOS Tools tab since 2.26 [10] | Yes, multi-selection, touch, undo. N pages are N transactions | equal | vendor; repo, audit |
| Merge | Dedicated tool [1] | Add pages, drop between pages; engine refuses PDFs with forms or tags | open | vendor; repo |
| Split | Ranges, intervals [1] | Ranges, every N, bookmarks, size; zip | berg:work | vendor; repo |
| Crop, resize | Crop with preview and several pages, resize tool [3] | Margins, area, fit to content, white margins, page sizes, keep or scale | berg:work, slightly | vendor; repo |
| Page numbers, header, footer | Yes, odd/even ranges [32] | Yes, tokens, six positions | equal | vendor; repo |
| Bates numbers | Own guide describes other products [24] | Yes | berg:work | vendor; repo |
| Watermark | Add, remove its own [33] | Add, batch; removal by Undo only | PDFgear, slightly | vendor; repo |
| Bookmarks | Yes [10] | Yes | equal | vendor; repo |
| N-up | On desktop print [6] | No | PDFgear | vendor; repo |

### Conversion

| Feature | PDFgear | berg:work | Ahead | Confidence |
|---|---|---|---|---|
| PDF to Word | Yes, Standard and Advanced mode; quality in section 3 | None | **PDFgear** | vendor, third; repo |
| PDF to Excel, PowerPoint | Yes [1] | None | **PDFgear** | vendor; repo |
| PDF to RTF, TXT | Yes [1] | CLI `text`; TXT of an OCR run | **PDFgear** | vendor; repo |
| PDF to JPG, PNG | Yes [1] | CLI `render` only | **PDFgear** | vendor; repo |
| Word, Excel, PowerPoint to PDF | Yes, local on desktop [1][27]. Whether Office must be installed is unclear | None | **PDFgear** | vendor; repo |
| Images to PDF | Yes [1] | Into an open PDF on main. New document and HEIC on `fix/pdf-image-input` | equal once merged | vendor; repo |
| Scanned to Word | Yes [1]; weak result in one competitor test [18] | None | PDFgear, with doubt | vendor, third; repo |
| Virtual printer | Yes [34] | None; own driver rejected in `PDF-TODO.md` | PDFgear | vendor; repo |
| Scanner | Create from scanner and insert pages, 2.1.13 [3]; separate scan app [10] | None | **PDFgear** | vendor; repo |

### OCR

| Feature | PDFgear | berg:work | Ahead | Confidence |
|---|---|---|---|---|
| Runs where | Desktop local by its account; language pack handling unknown | In the page, Tesseract | berg:work on proof | vendor; repo |
| Languages | 30+ on conversion, 10+ for areas [35]; older pages say 20+ | 46 (6 bundled, 40 on demand); Latin, Greek, Cyrillic only | open | vendor; repo |
| Several languages in one run | Yes, more than three slows it [25] | No | **PDFgear** | vendor; repo |
| Searchable PDF | Yes, since 2.1.13 [3] | Yes | equal | vendor; repo, audit |
| Area | Yes [25] | Yes, up to 216 dpi | equal | vendor; repo |
| Deskew | None found | Yes | berg:work | none found; repo |
| Accuracy | Vendor says 98.6 % [28]; "mostly accurate", weak on tables [14] | Tesseract; not benchmarked | open | vendor, third |
| On mobile | Disputed [18][22] | Same as web | open | third, vendor; repo |

### Signatures

| Feature | PDFgear | berg:work | Ahead | Confidence |
|---|---|---|---|---|
| Draw, type, image | Yes [1] | Yes, saved signatures | equal | vendor; repo |
| Same signature on several pages | Yes on Mac [1] | No | PDFgear, slightly | vendor; repo |
| Certificate signature | Since 2.1.13 [3]; the 2.1.16 eSign adds digital certificates | PKCS#12, PEM, create a self-signed one; `adbe.pkcs7.detached`, incremental on signed PDFs | open | vendor; repo |
| Check existing signatures | None found | Integrity and coverage; trust not evaluated | berg:work | none found; repo |
| Timestamp, LTV, smartcard | None found | None; open in `PDF-TODO.md` | equal | none found; repo |
| Request signatures from others | Secure eSign, Request Signature, server-side, since 2026 [3] | None, deliberately (section 7) | PDFgear | vendor; repo |

### Security and redaction

| Feature | PDFgear | berg:work | Ahead | Confidence |
|---|---|---|---|---|
| Passwords | Open and permission passwords [33]; a reviewer found no print restriction [14]; strength not stated | AES-256, owner and user, four permissions, verified with qpdf | berg:work, slightly | vendor, third; repo, audit |
| Redaction | Desktop [36]; not on Android in Feb 2026 [6]; none found on iOS | Everywhere; removal preview; form fields underneath go too | **berg:work** | vendor; repo |
| Find and redact | Via search [36] | Dialog; regex in the CLI, verified after saving | berg:work | vendor; repo |
| Metadata | Edit, clear [36] | Edit, strip | equal | vendor; repo |
| Flatten | Yes, also batch [33]; not on Android [6] | Yes, batch | equal | vendor; repo |
| PDF/A | None found | PDF/A-2b, -3b. 255 of 287 converted corpus files passed veraPDF | **berg:work** | none found; audit |

### Compare, measure, batch

| Feature | PDFgear | berg:work | Ahead | Confidence |
|---|---|---|---|---|
| Compare | No: staff in Feb 2026 [6], no changelog entry since [3] | Visual and text, side by side, overlay | **berg:work** | vendor; repo |
| Measure | None found | Distance, perimeter, area, calibration, page scales, CSV | **berg:work** | none found; repo |
| Batch steps | Convert, compress, flatten, print, merge [1][33] | Lossless, raster, strip metadata, flatten, watermark | **PDFgear** | vendor; repo |
| Batch scope | File lists | Open documents only | PDFgear | vendor; repo |
| Scripting | None found | CLI and MCP server | **berg:work** | none found; repo |

### AI

| Feature | PDFgear | berg:work | Ahead | Confidence |
|---|---|---|---|---|
| Chat with the PDF, summarise, explain | Desktop, mobile; cloud; free today [9][29][37] | None | **PDFgear** | vendor |
| Translate | Tool since 2.1.13 [3], iOS since 2.24 [10] | None | **PDFgear** | vendor |
| Rewrite, proofread | Yes [29] | None | **PDFgear** | vendor |
| Commands in plain language | Copilot: compress, convert, delete pages, go to page [37][38] | Palette without arguments; MCP for outside agents | PDFgear for end users | vendor; repo |
| Stays local | No, Azure OpenAI after consent [7]; can be switched off [6] | Nothing leaves | berg:work | vendor; live |
| Model | Current pages give "ChatGPT-3.5-Turbo" [37] and "GPT-3.5"; likely stale | – | – | vendor |

### Reading

| Feature | PDFgear | berg:work | Ahead | Confidence |
|---|---|---|---|---|
| Two-page view | Yes [39]; iOS users miss a separate cover [10] | No | **PDFgear** | vendor, third; repo |
| Slide show | Yes [39] | No; fullscreen in the desktop branch | **PDFgear** | vendor; repo |
| Read aloud | Yes, voice, speed, pitch [40] | No | **PDFgear** | vendor; repo |
| Page colours | Night, eye protection, yellow [39] | Dark UI only, pages stay white | **PDFgear** | vendor; repo |
| Tabs | Since 3.0.0 of 2026-10-12 [3] | Dropdown in the chrome; a real tab strip is open | **PDFgear** | vendor; repo, audit |
| Several windows | Before 3.0 its only way [17] | On `feat/pdf-desktop-windows` | equal | third; repo |
| Search | Yes | Yes | equal | vendor; repo |
| Links clickable, text auto-links | Not documented | Yes | open | repo |

### Rendering and speed

| Feature | PDFgear | berg:work | Ahead | Confidence |
|---|---|---|---|---|
| Engine | Not named. Licensed SDKs mentioned [4]; C# in the snippets of [2] | PDFium in WASM, 29 Fernwork patches | open | vendor, third; repo |
| Native gain | Native | PDFium native renders 1.1–2.2× faster than our WASM | PDFgear likely; size unknown | audit; inference |
| After an edit | Not measured | 1.3 s per markup, 1.6–14 s commit on the audit laptop | open | audit |
| Large files | "No limit" on desktop [27] | 2 GB WASM cap, whole file in memory | **PDFgear** | vendor; audit |
| Reported problems | Slow loads, crashes, text display bugs [11], jerky scrolling [17] | Commit latency, rough touch | open | third; audit |
| Size | iOS 47.5 MB [10], desktop not stated | `dist/` 124 MB, binary 72 MB | PDFgear on mobile | live; audit |

### Platforms

| Feature | PDFgear | berg:work | Ahead | Confidence |
|---|---|---|---|---|
| Windows | 10, 11; signed [4]; default viewer option [1] | Configured, not built | **PDFgear** | vendor; repo |
| macOS | 10.14+, App Store [1] | None | **PDFgear** | vendor; repo |
| Linux | None [15] | Internal Tauri build, plus web | **berg:work** | third; repo, audit |
| Web | Web editor adds content only, 100 MB limit [23]; converters upload | Full editor | **berg:work** | vendor; repo |
| iOS, iPadOS | Native, iOS 15+, Split View, Wi-Fi transfer [10] | PWA without file handling | **PDFgear** | live; `PDF-MOBILE-VORTEILE.md` |
| Android | Native, 3.7M+ installs, default app possible [6][12] | PWA with share target; touch rough | **PDFgear** | third, vendor; repo |
| Editing depth on phones | Text, images, pages, forms; no redact, watermark, flatten [6] | Same editor as desktop, including these | berg:work on depth | vendor; repo |
| Browser extension | Chrome extension [29] | None | PDFgear, little value | vendor |

### Price, licence, UI

| Feature | PDFgear | berg:work | Ahead | Confidence |
|---|---|---|---|---|
| Price today | Free, also for business, no watermark, no account [1][29] | Free for individuals, up to three people, education | **PDFgear** for companies | vendor; repo |
| Future | Freemium announced; AI, OCR, conversion named [4][5]. Paddle appears in the privacy policy [7] | Commercial licence undecided | open | vendor |
| Licence | Proprietary [21] | BUSL-1.1, source readable | berg:work | third; repo |
| UI languages | Eleven including German [10] | English | **PDFgear** | live; repo |
| Discoverability | Ribbon, Copilot; "not drag-and-drop-simple" [16] | Command palette, shortcuts, mini toolbar, modern direct manipulation | berg:work for experts | third; audit |
| Update pace | 3.0.0 and 3.0.1 in October; iOS monthly [3][10] | Daily, not released | open | vendor; repo |
| Accessibility | Not declared on the App Store [10] | Keyboard and ARIA work in the UI; no audit | open | live; repo |
| Reviews | iOS 4.7 [10], Android 4.58 [12], Trustpilot 4.9 of 11,600 [11]; Trustpilot notes no fact-checking | None public | PDFgear | live, third |

### Common complaints about PDFgear

- **Text layout:** enlarging gives "one word on a line" and lines through URLs; a page turning the colour of the text tool
  (2★, iOS, May 2026) [10]; "entire row tend to move by itself" (October 2026) [11].
- **Prompt:** the iOS app demands a review before use (March 2025) [10]. Possibly fixed.
- **Reliability:** crashes, slow loads, text display bugs, in Trustpilot's summary of recent reviews [11].
- **AI pushed too hard:** floating buttons led one user to upload a confidential document by accident [6].
- **Conversion and OCR** of complex or scanned documents [14][18][19].
- **Trust:** the Reddit dispute [2][4].

## 7. What we deliberately do not match

- **Upload-based conversion.** It would be the cheap way to good Office output, and it would break the one promise that makes
  berg:work different. Conversion runs on the device or does not ship.
- **Cloud AI by default.** Same reason. It stays a decision for Florian, with the costs written down in `PDF-TODO.md`.
- **Request signature through a server.** It needs accounts, mail, document storage and legal terms. Local certificate
  signing covers the single signer; a server product is a different business.
- **A format count.** "60+ formats" is not a goal. Word, Excel, PowerPoint and images are.
- **"Lossless" as a claim.** We will say what is kept and what is not.
- **Browser extension.** The PWA and file handlers do the job.
- **Own virtual printer on Windows.** Already rejected in `PDF-TODO.md`.
- **Keyword parity for AI.** A palette that takes "delete page 10" is useful and is not AI. We will not call it that.

## 8. Checks on a real PDFgear

Needs an Android phone, an iPhone and the Windows PC with one online session. Use the same five PDFs as the audit
(Google Docs export, GeoTopo book, form, scan, a plan with vector paths).

1. Text editing on all three: subset fonts, bold words in a paragraph, enlarging text, what the saved file really contains
   (`pdffonts`, `qpdf`), whether it uses whiteout.
2. Are vector paths selectable anywhere?
3. Network capture on iOS and Android for edit, convert and OCR, to learn which "mobile tasks" leave the device.
4. Open, scroll and edit timings on GeoTopo and a 500 MB scan, side by side with berg:work.
5. PDF to Word on the same files, with a table and a two-column layout.
6. Merge of PDFs with forms and tags.
7. Certificate signature: `SubFilter`, timestamp, LTV.
8. Redaction: are the glyphs and image data gone after saving?

## 9. Corrections to other documents

- `PDF-TODO.md`, *Store presence*: "PDFgear: text and images, free status unclear" can read "free today, with paid
  options announced". Left unchanged here because `docs/pdf-mobile-advantages` rewrites that entry.
- `PDF-TODO.md`, *Office conversion*: "not feasible in the browser" holds for Office to PDF only (section 3).
- `PDF-MOBILE-VORTEILE.md` (branch `docs/pdf-mobile-advantages`), corrections and section 9: PDFgear's text editing on iOS is settled,
  and its AI runs on Azure OpenAI by the current policy, not plainly "ChatGPT-based".
- `PDF-DESKTOP-VORTEILE.md` (branch `feat/pdf-desktop-windows`): "Im Web nicht machbar" for Office conversion, same as above.

## Sources

Read on 2026-10-30. Dates are the source's own where it has one. PDFgear's vendor pages vary in age; old ones are marked.
PCMag, Neowin, G2 and Google Play could not be fetched and Reddit threads were not read, so those are known from search
excerpts or not at all; the Reddit claims appear here only through PDFgear's reply. TechRadar [16] is known from a search excerpt only.

**PDFgear, primary**

1. Windows and Mac product pages: https://www.pdfgear.com/pdfgear-for-windows/ and https://www.pdfgear.com/pdfgear-for-mac/
2. Cure53, PDFgear review report PGR-01, 2026-03-19: https://cure53.de/review-report_pdfgear.pdf
3. Version history of PDFgear, to 3.0.1 of 2026-10-22: https://www.pdfgear.com/whats-new/
4. Statement on disinformation, 2026-03-24: https://www.pdfgear.com/reddit-disinformation-statement/
5. Is PDFgear really free, 2024-04-02: https://www.pdfgear.com/insights/is-pdfgear-free.htm
6. PDFgear community, public API, threads of 2026-02-13 to 2026-02-24 (AI, DOCX, watermark, protect, flatten and redact, compare, N-up, default app): https://community.pdfgear.com/
7. Privacy policy, 2026-03-23: https://www.pdfgear.com/privacy/
8. Edit a PDF on iPhone, 2025-05-28: https://www.pdfgear.com/pdf-editor-reader/how-to-edit-pdf-on-iphone.htm
9. PDFgear for Android: https://www.pdfgear.com/pdfgear-for-android/ and for iOS: https://www.pdfgear.com/pdfgear-for-ios/

**Stores and trackers**

10. App Store, version 2.29, version history, languages, reviews: https://apps.apple.com/us/app/pdf-gear-pdf-editor-reader/id6465897558 and https://apps.apple.com/at/app/pdf-gear-pdf-editor-reader/id6465897558?l=en-GB
11. Trustpilot, read 2026-10-30: https://www.trustpilot.com/review/pdfgear.com
12. AppGoblin, Android: https://appgoblin.info/apps/com.pdfeditor.pdfeditorandriod
13. AppGoblin, iOS, scanned 2026-10-17: https://appgoblin.info/apps/6465897558

**Reviews**

14. The Business Dive, 2026-09-21, updated 2026-10-07, hands-on: https://thebusinessdive.com/pdfgear-review
15. MakeUseOf, 2026-05-03, hands-on on Android: https://www.makeuseof.com/edit-pdf-on-android-with-pdfgear/
16. TechRadar, 2024-02-06: https://www.techradar.com/pro/software-services/pdfgear-review
17. SwifDoo, competitor, updated 2026-04-27: https://www.swifdoo.com/edit-pdfs/pdfgear-review
18. UPDF, competitor, test of July 2026: https://updf.com/ocr/pdf-to-word-converter-ocr/
19. iTechGuides, 2026-08-12, no own test: https://www.itechguides.com/pdfgear-review-a-capable-free-pdf-editor-with-optional-ai-assistance/
20. Tenorshare, competitor: https://www.tenorshare.com/pdf-editor/pdfgear-review.html
21. Wikipedia: https://en.wikipedia.org/wiki/PDFgear

**PDFgear feature pages** (undated unless noted)

22. Convert PDF to Word on iPhone, 2026-10-06: https://www.pdfgear.com/pdf-converter/how-to-convert-pdf-to-word-on-iphone.htm
23. Online editor: https://www.pdfgear.com/edit-pdf/
24. Bates stamp guide: https://www.pdfgear.com/pdf-editor-reader/how-to-add-bates-stamp-to-pdf.htm
25. OCR, Windows guide and overview: https://www.pdfgear.com/windows-user-guide/ocr-pdf.htm and https://www.pdfgear.com/pdf-editor-reader/how-to-ocr-a-pdf.htm
26. PDF to Word: https://www.pdfgear.com/pdf-to-word/
27. Word to PDF: https://www.pdfgear.com/word-to-pdf/
28. Edit text: https://www.pdfgear.com/edit-pdf-text/
29. Home page and AI editor: https://www.pdfgear.com/ and https://www.pdfgear.com/ai-pdf-editor/
30. Toolbar guide: https://www.pdfgear.com/windows-user-guide/pdfgear-toolbar.htm
31. Forms: https://www.pdfgear.com/pdf-form/
32. Page numbers, header and footer: https://www.pdfgear.com/pdf-editor-reader/how-to-add-page-numbers-to-a-pdf.htm and https://www.pdfgear.com/windows-user-guide/add-header-and-footer-to-pdf.htm
33. Watermark, password, flatten: https://www.pdfgear.com/pdf-editor-reader/add-watermark-to-pdf.htm, https://www.pdfgear.com/windows-user-guide/password-protect-pdf.htm, https://www.pdfgear.com/pdf-editor-reader/how-to-flatten-a-pdf.htm
34. Virtual printer: https://www.pdfgear.com/pdf-printer/
35. OCR overview: https://www.pdfgear.com/ocr-pdf/
36. Redaction, 2026-09-01: https://www.pdfgear.com/pdf-editor-reader/how-to-redact-a-pdf.htm
37. Chat PDF, partly old: https://www.pdfgear.com/chat-pdf/
38. Copilot: https://www.pdfgear.com/pdf-copilot/ and https://www.pdfgear.com/windows-user-guide/pdfgear-pdf-copilot.htm
39. Reading: https://www.pdfgear.com/pdf-editor-reader/how-to-read-pdf-in-dark-mode.htm, https://www.pdfgear.com/pdf-editor-reader/view-pdf-pages-side-by-side.htm, https://www.pdfgear.com/pdf-editor-reader/pdf-full-screen.htm
40. Read aloud: https://www.pdfgear.com/pdf-editor-reader/read-pdf-out-loud.htm

**For the parity plan**

41. Chrome built-in AI, requirements and APIs: https://developer.chrome.com/docs/ai/get-started and https://developer.chrome.com/docs/ai/translator-api
42. Bergamot translator: https://github.com/mozilla/bergamot-translator
43. Firefox Translations models, mirror and CORS note: https://huggingface.co/midudev/firefox-translations
44. ZetaOffice and ZetaJS: https://blog.allotropia.de/2024/11/08/launching-zetaoffice/
