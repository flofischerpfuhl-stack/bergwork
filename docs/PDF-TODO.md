# berg:work PDF: TODO

Snapshot of 2026-10-29 (`origin/main` `bdaca2b`, Fernwork pin `c46ed765`, the state live on bergwork.app), from a
hands-on review: the web build and the Linux Tauri release build, driven headless (Chromium 147, desktop 1440×900
and a 390×844 touch phone; the app under Xvfb), on a Google Docs export, a 117-page book, a form and a scan.
Timings come from software rendering on a loaded laptop and are upper bounds; the patterns hold.

This list holds what berg:work owns: the source fork's berg:work additions (islands chrome, mini toolbar, shortcut
overview), the host and the apps. Editor core issues and missing editor features belong to Fernwork and are listed
in Fernwork's `docs/pdf/TODO-editor-feel-and-features.md`. They are fixed there and ported here (see the
`bergwork-pdf-sync` skill).

Status: `[ ]` open · `[~]` in progress · `[x]` done and checked on screen. Effort in person-days (PD).

## Fork UI (berg:work additions in `apps/pdf/editor/`)

berg:work's UI is ahead of Fernwork's (islands, mini toolbar, shortcut overview), so interaction and UI work lands in
the fork, kept to small `berg:work:` hunks; Fernwork gets engine and worker fixes. Work branch:
`feat/pdf-native-feel`.

- [x] **Floating bars avoid what they float over** (in part). The object's mini toolbar follows its object after a
  move, undo, nudge or Properties change and clears the top islands instead of a fixed 64 px. Still open: the
  comment colour bar can lie over a neighbouring object; a shared collision rule for all floating bars. 2–3 PD.
- [x] **Status line is readable.** The applying-change pill sits under the top right island.
- [x] **Zoom popover is not clipped.** It opens from the bottom-left island's edge.
- [x] **Shortcut overview lists everything.** View keys (fit, 100 %, Space-drag) and the one-letter tools.
- [x] **The context menu closes** on an outside click and on Escape. It used to miss the click whenever the mini
  toolbar was open (it re-subscribed during that very pointerdown).
- [ ] **Edit as paragraph is not on `main`.** It lives on `feat/pdf-paragraph-edit` (`9a0124f`), but the sync skill
  describes it as present. Either finish and merge it, or hand it to Fernwork (the Fernwork TODO asks for semantic
  lines and paragraphs, which would replace it). Then correct the skill.

## Direct manipulation compared with Figma, Canva and PowerPoint (second review, 2026-10-29)

A 40-point checklist driven against the app, next to a catalogue of the three products' micro-interactions from
their help pages. **Needs OK** marks changes that alter the UI visibly; they wait for Florian.

Selection and transform:
- [x] **Snapping on by default** (remembered; Alt moves freely). The Guides button lights up only for visible guides
  or rulers.
- [x] **Live size and angle at the pointer** while resizing, rotating and drawing (W × H pt, degrees).
- [x] **Click beside the pages deselects** (mouse and touch).
- [x] **A second click on selected text edits it at the click** (PowerPoint, Canva); overlapping objects still cycle.
- [x] **Shape tools:** a click places a 100 × 100 pt shape (arrow 120 pt); drawing tools show a crosshair.
- [ ] **Alt-drag duplicates; Ctrl+D repeats the last offset** (Figma, Canva). Today Alt-drag moves the original.
  1–2 PD.
- [x] **Undo selects what it changed:** with nothing selected, Undo/Redo select the object whose frame moved or that
  came back, and scroll to it; a kept selection stays as before.
- [x] **Rotate from just outside a corner** (approved): four rotate zones with a rotate cursor; the round handle is
  hidden for mice (still in the tab order) and stays on touch. Touch: two-finger rotate and scale on the selected
  object (approved, branch `feat/pdf-pages-touch`).
- [x] **Resize cursors follow the frame's rotation.**
- [x] **Equal-spacing snaps** with pink gap markers (between two neighbours, or repeating a neighbour's gap); an
  option of `resolveMoveSnap` that the gesture runtime turns on, so Fernwork's 23 move-snapping unit tests still pass.
- [ ] **Alt-hover distance measuring** (Figma). Alt already means "move freely"; needs a decision. 1–2 PD.
- [x] **Select the object below** was already in the context menu when objects are stacked.
- [x] **Context menu** (approved): Paste here (at the right-clicked point), Bring forward / Send backward one step
  (Ctrl+] / [, with Shift to front/back), Lock / Unlock; grouped into clipboard, arrange, properties/delete. Group
  stays in the multi-selection bar (a right-click selects one object, by design).
- [x] **Copy / paste style** (Ctrl+Alt+C / V and the context menu): fill, stroke, width, opacity between drawn shapes
  and PDF paths, type settings between text boxes. Open: text from the PDF (goes through the rich-text path). 1–2 PD.

Text:
- [x] **Readable font names** in the picker: "Arial (from the PDF)" instead of "Original PDF font · AAAAAA+ArialMT";
  the duplicate caption under the picker is gone.
- [ ] **Font preview on hover** in the font list, on the selected text (Figma). 2–3 PD.
- [x] **The selection frame grows while typing**, with its handles, and returns to its own size when editing ends.

Panels and fields:
- [x] **Number fields scrub on their label and take arithmetic** (210/2, 72+12, decimal comma).
- [x] **Properties without duplicates:** one Keep proportions (next to Width/Height), Rotate by only where there is
  no Angle field.
- [x] **Readable layer names:** Line, Shape, Image instead of "Path #1064", "img_p0_6".
- [x] **Hovering a layer row outlines the object on the page.**
- [ ] **Layers: drag rows to reorder; double-click to rename** (renaming exists in Properties). 2 PD.
- [ ] **Recent and document colours, eyedropper** in the colour wells. 2 PD.
- [ ] **"Mixed" in fields of a multi-selection** and edits that apply to each object (Figma's Mixed+10). 2–3 PD.

Clipboard and drop:
- [x] **Images dropped on a page are placed at the pointer**; the page is outlined while dragging.
- [x] **Paste lands where you look:** pasted text at the pointer over a page, else the middle of the visible part of
  the page; pasted image files (screenshots) become images there.
- [ ] **Drop an image onto an image to replace it** (Canva frames). 2 PD.

Navigation:
- [x] **Space-drag hand** (Space no longer pages down), **Shift+1 / Ctrl+0 fit, Shift+0 / Ctrl+1 100 %**, a gentler
  wheel step (1.2× per notch instead of 1.43×).
- [x] **Shift+2 zooms to the selection.**
- [x] **Arrow keys pan when nothing is selected** (40 px, Shift 200 px).

Feedback and discovery:
- [x] **Command palette (Ctrl+K)** (approved): file, edit, tools, panels, view and page actions by name, recently used
  first, group and shortcut per row.
- [ ] **Toasts with Undo** after destructive actions (delete page, delete object, flatten). 1 PD.
- [ ] **Saved state visible** ("Saved" / "Unsaved changes" by the file name) instead of only a dot; the dot stays
  after undoing back to the saved state. 1 PD.

Touch:
- [x] **Bottom context bar on phones** (approved): the mini toolbar docks above the bottom bar (above the keyboard
  when it is open) instead of covering the text.
- [ ] **Larger touch targets for handles** (≥ 44 px hit area, drawn smaller). 1 PD.
- [ ] **Pages: reorder by touch, Shift-range selection, the selection follows a moved page.** 2–3 PD.

Forms:
- [x] **Fields that read the same are told apart** (own field name where it says something, else a number); radio
  groups prefer a meaningful field name over their first option's caption.

## Features compared with PDF-XChange (Fernwork TODO part B, built in the fork)

- [ ] **Measure tools with scale** (distance, area, perimeter, calibration, CSV). Branch `feat/pdf-measure-comments`.
- [ ] **Comment workflow** (text box, callout, line, polygon, cloud, stamps, comment list, XFDF). Same branch.
- [x] **Headers, footers and Bates numbers** in the Page numbers panel: text with {page}, {pages}, {date}, {file},
  start number, zero-padded digits, six positions picked on the preview page; header and footer coexist.
  **Needs OK** (panel grew by a text field, two number fields and the position picker).
- [ ] **Page tools:** blank page, crop and resize pages, split by count/bookmarks/size, merge several files by
  drop. 5–10 PD.
- [ ] **PDF/A save** (fonts embedded, XMP, OutputIntent; check with veraPDF). 5–10 PD.
- [ ] **OCR:** more languages on demand, deskew, OCR of a region. 5–8 PD.

## Desktop apps (`apps/pdf/src-tauri`, `packages/host-tauri`)

Today: the Linux release build works (5:50 min, 72 MB binary with embedded assets), opens a PDF passed on the command
line and has file associations (`pdf`, `bwpdf`, `fwdoc`), single instance and native save. The Rust side is 207
lines of file I/O. `packages/host-tauri` is still empty.

- [ ] **Windows build.** Build `nsis`/`msi`, test WebView2 (cross-origin isolation, WASM threads, memory), paths and
  CRLF. 3–5 PD.
- [ ] **macOS build.** Universal binary, hardened runtime, Developer ID signing and notarisation (99 $/year). 3–5 PD.
- [ ] **Windows code signing.** An OV certificate (150–300 $/year) or Azure Artifact Signing (about 10 $/month; in
  the EU only for organisations). SmartScreen reputation builds up over time; EV no longer skips it. 2–3 PD.
- [ ] **Updates.** Tauri updater with signed manifests: NSIS/MSI, macOS, and on Linux AppImage only. Plus winget and
  AUR; Flatpak later (check Flathub's current rules on AI-written code first, unverified). Use a current
  updater-plugin version. 3–5 PD.
- [ ] **Release CI.** All platforms, signing, artefacts, update manifest. 8–15 PD.
- [ ] **Default PDF app, per OS.** 5–8 PD for the three desktops.
  - **Windows:** apps cannot make themselves the default (UCPD protection). Register a ProgID and
    `Capabilities\FileAssociations`, and offer a “Make default” button that opens
    `ms-settings:defaultapps?registeredApp…`.
  - **macOS:** `CFBundleDocumentTypes` with `com.adobe.pdf`; the system asks the user.
  - **Linux:** `.desktop` `MimeType` plus `xdg-mime default`.
- [ ] **Native printing instead of the WebView.**
  - Windows: PDFium into a device context.
  - macOS: PDFKit `printOperation`.
  - Linux: hand the PDF to CUPS.

  3–6 PD per OS.
- [ ] **German user interface.** The editor is English only. Needs Fernwork's string catalogue (see the Fernwork
  TODO) plus native strings: installer, `.desktop`, Info.plist. 5–10 PD.
- [ ] **Crash reports.** Opt-in only; Sentry EU region; JS errors, Rust panics, minidumps; never document content.
  2–3 PD.
- [ ] **System fonts.** List them in Rust (fontdb, DirectWrite, CoreText), pass them to HarfBuzz and PDFium, respect
  embedding permissions. 2–4 PD.
- [ ] **Shell integration** (later). Explorer thumbnails (`IThumbnailProvider`), the Windows 11 context menu (needs
  package identity), jump lists and recent documents. 8–16 PD.
- [ ] **Signing with system certificates** (later). Windows certificate store (CNG), macOS Keychain, PKCS#11 and
  smartcards; timestamp and LTV through the host contract. 15–30 PD.
- [ ] **Office conversion, desktop only** (later). PDF↔Word/Excel and Office→PDF through LibreOffice headless,
  if it is installed. It is not feasible in the browser.

## Agent interface

The corpus harness (`apps/pdf/tests/harness`, `run-corpus.mjs`) already drives the editor's engine without the UI
in a headless page. That is the basis.

- [x] **CLI** `bergwork-pdf-cli` (`apps/pdf/cli/`, branch `feat/pdf-agent-cli`): info, text, form-fields,
  metadata, render, ocr, redact (term/regex, verified after saving), replace-text (only runs the engine reports as
  safe), fill-form (optional flatten), pages rotate/delete/move/extract/split, merge, optimize, protect, unlock.
  `--json`, exit codes 0–5; the shared headless engine page lives in `apps/pdf/headless/`. 14 tests pass; the
  corpus quick run is unchanged (36 files, 888 checks, 0 failed).
- [x] **MCP server** `bergwork-pdf-cli mcp` (stdio, `@modelcontextprotocol/sdk` 1.32.1): the same operations as
  `pdf_*` tools, local paths only.
- [ ] **CLI open items:** a packaged binary next to the app (today `npm run cli` / `node`), merge of PDFs with forms
  or tags (the engine refuses), several OCR languages per run, about 1–2 s Chromium start per call (the MCP server
  keeps its page).
- [ ] **Harness check:** `doc.encrypt` in the harness passes `{print, copy, …}`, the shell expects
  `noPrint`/`noCopy`/…, so the corpus probably never tests restrictions.
- [ ] **URL scheme / deep link.** Open file X at page Y, from scripts and other apps. 1–2 PD.

## Printing to berg:work PDF

- [ ] **Windows: no own printer driver.** Third-party V3/V4 drivers are being retired: no new drivers through Windows
  Update since 2026-01-15, security fixes only from 2027-07-01. Windows Protected Print blocks PDFCreator-style
  drivers. A Print Support App v4 virtual printer (MSIX) receives only OXPS/PostScript, which needs an
  XPS/PS→PDF converter, and the usual ones are AGPL. That is 15–30 PD at high risk. Instead, offer “Open with
  berg:work PDF” after Microsoft Print to PDF, or watch a folder. 2–4 PD; test under Windows Protected Print first.
- [ ] **macOS: PDF Services entry.** An alias in `~/Library/PDF Services` appears under “PDF ▾” in every print
  dialog and receives the PDF. Not possible in the Mac App Store. 1–2 PD.
- [ ] **Linux: CUPS backend** (optional). A cups-pdf-style backend that opens the job in the app (needs root at
  install; not from Flatpak). 2–3 PD.

## Web, Android, phones

- [x] **PWA.** The site manifest declares `file_handlers` (open PDFs/projects from the file manager, via
  `launchQueue`) and a `share_target` (Android "Share → berg:work PDF": the service worker keeps the files and the
  app opens them from `?shared`); the app page on the site links the manifest and registers the service worker.
  Share flow checked headless. Open: check "Open with" and Share on a real Android phone and desktop Chrome/Edge.
- [ ] **Android app for Googlebooks** (as planned in `docs/ARCHITECTURE.md`).
  - The Android WebView has no cross-origin isolation, so no SharedArrayBuffer or WASM threads: PDFium and Tesseract
    need single-thread builds, or native builds through Rust.
  - Intent filters for `application/pdf` with `content://` URIs; save back only with write access, otherwise
    `ACTION_CREATE_DOCUMENT`.
  - Play: target API 36, 16 KB page size for the native libraries.

  10–20 PD, plus the touch work in the Fernwork TODO.
- [ ] **Store presence on phones.** Free mobile apps view and annotate. Editing existing content is paywalled
  (Adobe, Xodo, Foxit, PDF Expert) or limited (PDFgear: text and images, free status unclear). Editing vector paths
  is offered nowhere we know of. The store listing is what makes that lead visible.
  - **Android: Trusted Web Activity** (Bubblewrap). The PWA runs in Chrome, not in the WebView, so it keeps
    cross-origin isolation and WASM threads, and it can be listed on Play. 3–5 PD.
  - **iOS: WKWebView wrapper.** Check SharedArrayBuffer and memory (WebContent is killed at about 2 GB) on a device
    first. 10–20 PD.
  - **Order:** ship only after the touch pass in the Fernwork TODO (taps hit the page background, results lag after
    release). Otherwise store reviews judge the rough edges, not the lead.
