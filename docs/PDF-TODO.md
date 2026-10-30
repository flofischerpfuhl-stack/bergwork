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
- [x] **Edit as paragraph** merged from `feat/pdf-paragraph-edit` (Florian's OK, 2026-10-29), together with the text
  marks that follow their text (both join the same transaction and its snapshot inverse). Checked: four single lines
  in one font become one reflowing box; mixed fonts are refused with a reason. Semantic paragraphs in Fernwork
  (part A2) would later replace it.

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
- [x] **Alt-drag duplicates; Ctrl+D repeats the last offset** (Figma; approved 2026-10-29). Releasing a move with
  Alt cancels it and pastes a copy at that offset (one Undo step, the copy selected, the original stays); Ctrl+D on
  that copy repeats the step. **Ctrl/⌘ now moves and measures without snapping** (was Alt). Fixed on the way: a
  pasted or duplicated image was not selected afterwards.
- [x] **Undo selects what it changed:** with nothing selected, Undo/Redo select the object whose frame moved or that
  came back, and scroll to it; a kept selection stays as before.
- [x] **Rotate from just outside a corner** (approved): four rotate zones with a rotate cursor; the round handle is
  hidden for mice (still in the tab order) and stays on touch. Touch: two-finger rotate and scale on the selected
  object (approved, branch `feat/pdf-pages-touch`).
- [x] **Resize cursors follow the frame's rotation.**
- [x] **Equal-spacing snaps** with pink gap markers (between two neighbours, or repeating a neighbour's gap); an
  option of `resolveMoveSnap` that the gesture runtime turns on, so Fernwork's 23 move-snapping unit tests still pass.
- [x] **Alt-hover distances** (Figma): with a selection, holding Alt shows red distance lines in pt to the object
  under the pointer, or to the page edges over the page itself (`bergwork-alt-distances.js`, a DOM overlay).
- [x] **Select the object below** was already in the context menu when objects are stacked.
- [x] **Context menu** (approved): Paste here (at the right-clicked point), Bring forward / Send backward one step
  (Ctrl+] / [, with Shift to front/back), Lock / Unlock; grouped into clipboard, arrange, properties/delete. Group
  stays in the multi-selection bar (a right-click selects one object, by design).
- [x] **Copy / paste style** (Ctrl+Alt+C / V and the context menu): fill, stroke, width, opacity between drawn shapes
  and PDF paths, type settings between text boxes. Open: text from the PDF (goes through the rich-text path). 1–2 PD.

Text:
- [x] **Readable font names** in the picker: "Arial (from the PDF)" instead of "Original PDF font · AAAAAA+ArialMT";
  the duplicate caption under the picker is gone.
- [x] **Font preview on hover** in the font list (pointer or arrow keys), on the selected PDF text (Figma): the text
  is left out of the page raster, as a hidden layer is, and drawn in that font above it; nothing is committed and
  Undo is untouched; Escape or leaving the list restores it, a chosen font stays until the committed page shows.
  Entries also show in their own font. Not for turned text, fonts from the PDF (no browser face), several styles
  in one run (previewed in one style), or text being typed in.
- [x] **The selection frame grows while typing**, with its handles, and returns to its own size when editing ends.

Panels and fields:
- [x] **Number fields scrub on their label and take arithmetic** (210/2, 72+12, decimal comma).
- [x] **Properties without duplicates:** one Keep proportions (next to Width/Height), Rotate by only where there is
  no Angle field.
- [x] **Readable layer names:** Line, Shape, Image instead of "Path #1064", "img_p0_6".
- [x] **Hovering a layer row outlines the object on the page.**
- [x] **Layers: double-click a name to rename** (Properties tab; in Layers a click opens Properties). Dragging rows to
  reorder already worked (grip, mouse after 6 px, touch after a press).
- [x] **Recent colours and eyedropper** in the colour wells (recent row remembered across sessions; eyedropper where
  the browser has one, Chrome/Edge). Document colours (colours already used in the PDF) still open. 1 PD.
- [x] **"Mixed" in fields of a multi-selection** (approved 2026-10-30): an "All selected" group above the objects in
  Properties with X, Y, Width, Height and Angle; differing values show Mixed. A value applies to every object, and
  in a Mixed field +10, -10, *2, /2 change each object by that amount (arrow keys too). X/Y/W/H are one undo step
  (per-object offsets and scales through the multi-selection transaction); Angle is one step for images, shapes and
  marks, one per object when PDF text is selected (the one-transaction turn leaves a text's hit area upright).
  Open: opacity, colours and stroke width for all (no multi-object property transaction yet; Fernwork). 1–2 PD.

Clipboard and drop:
- [x] **Images dropped on a page are placed at the pointer**; the page is outlined while dragging.
- [x] **Paste lands where you look:** pasted text at the pointer over a page, else the middle of the visible part of
  the page; pasted image files (screenshots) become images there.
- [x] **Drop an image onto an image to replace it** (Canva frames): one image file over a PDF image or an inserted
  image outlines that image (dashed, follows its turn) instead of the page; the drop cuts the picture to the
  frame's proportions (Canva's fill), keeps position, size and turn, one undo step. Hit-tested from the PDFium
  inspection, so unselected images and Pan work too; several files, or a drop beside images, are still placed. The
  first replacement of a PDF image takes the pre-edit document as its inverse, so Undo brings back the original
  image stream (`pdfimages -list`: old 128×128 gone after the save, back after Undo).

Navigation:
- [x] **Space-drag hand** (Space no longer pages down), **Shift+1 / Ctrl+0 fit, Shift+0 / Ctrl+1 100 %**, a gentler
  wheel step (1.2× per notch instead of 1.43×).
- [x] **Shift+2 zooms to the selection.**
- [x] **Arrow keys pan when nothing is selected** (40 px, Shift 200 px).

Feedback and discovery:
- [x] **No help text in the panels** (Florian, 2026-10-30: few apps show running help). A hint about one control is
  its tooltip; what a panel is for sits behind an (i) by its title (`PanelHint` and the explanation of `PanelEmpty`
  portal there); switch hints are tooltips. Status lines, warnings and empty-state titles stay visible. New UI follows
  the same rule.
- [x] **Command palette (Ctrl+K)** (approved): file, edit, tools, panels, view and page actions by name, recently used
  first, group and shortcut per row.
- [x] **Toast with Undo after deleting pages** (all pages of a multi-delete come back, selected).
- [x] ~~Toasts with Undo after the other destructive actions~~ — not needed: deleting an object is undone in place with
  Ctrl+Z and the toolbar (Figma and Canva show no toast there either; one per delete would be noise), and flatten
  only applies to an exported copy, never to the open document.
- [x] **Undo back to the saved state clears the unsaved dot** (also back to the opened state; one more step sets it
  again). Compared by a fingerprint of the editable state, taken at the first edit after opening or saving.
- [ ] **"Saved" / "Unsaved changes" as text** by the file name instead of only the dot. Optional, **needs OK** (more
  text in the top bar). 0.5 PD.

Touch:
- [x] **Bottom context bar on phones** (approved): the mini toolbar docks above the bottom bar (above the keyboard
  when it is open) instead of covering the text.
- [x] **Larger touch targets for handles:** resize handles take a tap within 48 px, drawn as before (the rotate handle
  already is 44 px on touch). On phones the mini toolbar still covers the lower handles' hit area by a few px.
- [x] **Pages: Shift-click a range, Ctrl/⌘-click single pages;** move, duplicate, delete, rotate and export act on all
  of them. Dragging shows an insertion line and moves the whole selection; the moved pages stay selected and in view.
  **Touch:** a 350 ms press lifts a page, the panel scrolls at its edges. Fixed on the way: thumbnails showed the old
  order after a move, delete or duplicate.
- [ ] **Multi-page actions in one step** (Fernwork): PDFium takes one page-topology command per transaction, so N
  pages are N transactions, N full snapshots and N Undo steps (the toast's Undo takes all). GeoTopo (117 pages):
  deleting 1 page 1 s, 5 pages 11 s, Undo of the 5 15 s. Needs several page commands per transaction in the worker.
- [x] **Two fingers on the selected object scale and turn it** (Canva): first finger on the object or within 16 px of
  its frame, proportional scale about the centre, snapping at 0/45/90/… (±4°), live readout, one Undo step. Elsewhere
  two fingers zoom the page as before. Text only turns (its resize reflows); locked objects and text being edited
  stay. Checked with CDP multi-touch headless; the feel on a real phone (and iOS Safari) still needs a try.

Forms:
- [x] **Fields that read the same are told apart** (own field name where it says something, else a number); radio
  groups prefer a meaningful field name over their first option's caption.

## Features compared with PDF-XChange (Fernwork TODO part B, built in the fork)

- [x] **Measure tools with scale** (distance, area, perimeter, calibration, CSV), merged from
  `feat/pdf-measure-comments`. Approved by Florian 2026-10-29 (Markup menu sections, option bars, Comments panel).
- [x] **Comment workflow** (text box, callout, line, polygon, cloud, stamps, comment list, XFDF), same branch. Open
  details in the section "Measuring and comments" below.
- [x] **Headers, footers and Bates numbers** in the Page numbers panel: text with {page}, {pages}, {date}, {file},
  start number, zero-padded digits, six positions picked on the preview page; header and footer coexist.
  Approved by Florian 2026-10-29.
- [x] **Page tools** (branch `feat/pdf-page-tools`), all with Undo where the document changes:
  - Blank page before/after a page (its size) from the thumbnail menu (right-click) and the palette; Add pages asks
    where to insert (after/before the current page, at the end).
  - PDFs and images dropped between thumbnails are inserted at the insertion line; several files are merged by qpdf
    first, so they are one import and one Undo step.
  - *Crop & resize pages* (Document tools): CropBox by margins, a draggable area on a preview, *Fit to content* or
    each page's white margins; new page size (A3–A5, Letter, Legal, custom) with the content scaled to fit or kept
    centred, annotations and form widgets follow. Current, selected or all pages; rotated pages crop as seen.
  - *Export or split* in Pages: every N pages, at the top-level bookmarks (named after them) or by size, one zip.
  - No engine change: crop/resize is a pdf-lib pass committed as a snapshot transaction (like page stamps); GeoTopo
    (117 pages) crops one page in 2.8 s, white margins of all pages in 15 s, Undo 1–4 s.
  - Approved by Florian 2026-10-30: the thumbnail context menu, the *Crop & resize pages* panel (new Document tools entry), the
    *Export or split* row (mode select in front of the range field) and the placement select in Add pages.
  - [ ] Later (Fernwork): a native `page.set-boxes` command (`FPDFPage_SetCropBox`/`SetMediaBox` are in the build)
    would make a crop instant instead of a full-document snapshot round trip.
  - [ ] Split: save the parts into a chosen folder (`showDirectoryPicker`, a Tauri command) instead of a zip.
- [x] **PDF/A save** (branch `feat/pdf-pdfa-ocr`): *Save as PDF/A…* in the Save menu and the palette, PDF/A-2b
  (-3b automatically when the PDF has attachments), in the fork's `pdf-editor/persistence/bergwork-pdfa.js`, no
  engine change. Fonts embedded (metric-compatible subsets, Symbol/ZapfDingbats from DejaVu Sans at the original
  widths, other fonts with widths as Liberation look-alikes), sRGB OutputIntent, DefaultCMYK for CMYK content, XMP,
  actions/XFA/transfer functions removed, annotations printable with appearances. Checked with veraPDF 1.30.3
  (portable JRE in `~/AgentWork/bergwork-pdf-pdfa/`): of 300 random corpus files 287 converted (9 encrypted or
  broken, 3 with missing fonts without widths refused), 255 of them compliant; the rest are mostly veraPDF/TWG
  "fail" test files and fuzzed PDFs. The app path (qpdf WASM) gives a compliant file for google-doc-document.pdf.
  - Approved by Florian 2026-10-30: the Save menu entry and the toasts.
  - [ ] Open: widths of *embedded* fonts that disagree with their program (6.2.11.5), `.notdef` references
    (6.2.11.8), push buttons with a stream appearance (6.3.3), signed PDFs (refused), PDF/A-1 and level A/U
    (tags), a CMYK profile closer to print than the plain conversion, refusing before the save dialog opens.
- [x] **OCR** (same branch), all in the fork (Tesseract.js runs in the page, no Fernwork change):
  - 40 more languages (Latin, Greek, Cyrillic scripts: the text layer font is Noto Sans) downloaded from jsDelivr on
    first use, pinned by size and SHA-256, cached in Tesseract's IndexedDB; CSP `connect-src` allows jsDelivr.
  - Deskew before recognition (projection profile, 0.3–6°); the invisible text follows the skewed lines. A scan
    rotated by 4° reads like the straight one (Tesseract alone loses the paragraph and garbles the numbers).
  - *Only an area*: a marked area of the current page (Crop pages preview), rendered at up to 216 dpi.
  - Approved by Florian 2026-10-30: language list with "Downloaded when first used", the *Only an area* switch and preview.
  - [ ] Open: perspective correction, straightening the page image itself, other scripts (Arabic, CJK, Devanagari
    need their fonts in the text layer), several languages in one run.

## Measuring and comments compared with PDF-XChange (Fernwork TODO part B, items 1 and 2)

Branch `feat/pdf-measure-comments`. Everything is in the fork's own files (`pdf-editor/model/pdf-measure.js`,
`pdf-editor/engine/measure-annotations.js`, `markup-annotations.js`, `comment-index.js`, `xfdf.js`,
`pdf-editor/interaction/measure-layer.jsx`, `comment-tools.jsx`, `comment-list.jsx`) plus small `berg:work:` hunks in
the shell. The pinned worker cannot write `/Measure`, `/Vertices`, `/VP`, `/IRT`, `/CL` or stamps, so these changes
are written into a checkpoint with pdf-lib and committed as one snapshot transaction (as page stamps do). Node tests:
`npm run test:unit -w @bergwork/pdf`. Approved by Florian (2026-10-29) for the whole UI (Markup › Comment / Measure, the options bars,
the chip over a selected measurement, the Comments panel); screenshots in
`AgentWork/bergwork-pdf-analyse/audit/measure-comments/`.

- [x] **Distance, perimeter, area** as standard measurement annotations (Line /LineDimension, PolyLine
  /PolyLineDimension, Polygon /PolygonDimension, `/Measure` Subtype RL, own appearance with caption); value at the
  pointer while drawing; snapping to corners and line ends of PDF paths and other measurements, Shift 45°, Alt free.
- [x] **Scale per page:** calibrate with two points and a known length (m, cm, mm, km, ft, in) or type a ratio;
  stored as a page viewport (`/VP`); CAD viewports are read, the last one containing the point wins; without a
  scale it measures 1:1 in mm and says so.
- [x] **Edit measurements** in Edit PDF: drag a corner or the whole measurement, Delete; Undo is exact.
- [x] **CSV** of all measurements (semicolon and decimal comma where the locale uses them).
- [x] **Text box and typewriter** (native FreeText through the worker), **callout** (FreeText /FreeTextCallout with
  `/CL`), **line** (Arrow without tips), **polyline, polygon, cloud** (`/BE` cloudy), **stamps** (Approved, Draft,
  Confidential, Reviewed, Rejected with date and name, or an own image).
- [x] **Comments panel** (Document tools › Comments): type, author and status filters, replies, review status
  (Acrobat's `/IRT` replies and `/State` … `/StateModel /Review`), jump to the comment; author name for new comments.
- [x] **XFDF export and import** with geometry, replies, states, measurements, cloudy borders and callout lines;
  imported annotations get appearances.
- [ ] **Each measure or markup change takes about 1.3 s** (checkpoint, pdf-lib, snapshot restore; 1-page plan,
  headless on the laptop), more on big books. Native worker commands would make it instant (see the Fernwork part of
  the report on `feat/pdf-measure-comments`). 3–5 PD in Fernwork.
- [ ] **Callout text cannot be edited in place**: its appearance is berg:work's own, so the shell treats it as a
  custom FreeText (text changes need "replace appearance", which drops the leader line). Needs the worker to draw
  `/CL` when it regenerates a FreeText appearance. 2 PD in Fernwork.
- [ ] **Created FreeText has `/F 0`** (worker): not printed by other viewers. The worker should set the Print flag.
  0.5 PD in Fernwork.
- [ ] **Polygons, polylines and stamps are not in Layers** and have no Properties (colour, width): the worker's
  annotation list leaves out subtypes 7, 8 and 13. 1–2 PD (worker + shell).
- [ ] **Measure captions on rotated pages** follow the page's user space, not the screen. 0.5 PD.
- [ ] **Further measure tools:** angle, count, radius, area in ha, caption styles, measurements in Layers. 3–5 PD.
- [ ] **Stamps:** resize, stamp appearance in XFDF export (Acrobat embeds it), more presets, a stamp library. 2 PD.
- [ ] **Comments:** print a comment summary, sort, edit and delete replies, mark as read (`/StateModel /Marked`).
  2–3 PD.

## Desktop apps (`apps/pdf/src-tauri`, `packages/host-tauri`)

Today: the Linux release build works (5:50 min, 72 MB binary with embedded assets) and has file associations (`pdf`,
`bwpdf`, `fwdoc`), single instance, several windows and native file handling (`src-tauri/src/lib.rs`, `windows.rs`).
`packages/host-tauri` is still empty. What a desktop app can do that a web page cannot, with order and effort:
`PDF-DESKTOP-VORTEILE.md`.

- [ ] **Windows build.** Build `nsis`/`msi`, test WebView2 (cross-origin isolation, WASM threads, memory), paths and
  CRLF. 3–5 PD.
- [ ] **macOS build.** Universal binary, hardened runtime, Developer ID signing and notarisation (99 $/year). 3–5 PD.
- [ ] **Windows code signing.** An OV certificate (150–300 $/year) or Azure Artifact Signing (about 10 $/month; in
  the EU only for organisations). SmartScreen reputation builds up over time; EV no longer skips it. 2–3 PD.
- [ ] **Updates.** Tauri updater with signed manifests: NSIS/MSI, macOS, AppImage; the changelog says deb and rpm too since
  2.1 and 2.10, the guide still names AppImage only, so test them. Plus winget and AUR; Flatpak later and by hand: Flathub
  wants AI material disclosed, no AI content in manifests, no agent-opened submissions, and builds from source. 3–5 PD.
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

### Feel of a desktop app (audit 2026-10-30)

Measured on Linux/WebKitGTK 2.54 only, in the real app under Xvfb with a window manager; Windows (WebView2) and macOS
(WKWebView) have not been run. Compared with Acrobat, PDF-XChange, Okular, Figma Desktop and VS Code. What a desktop app
could do beyond this, with order and effort, is in `PDF-DESKTOP-VORTEILE.md`.

Measured on the release build at `nice 19` on a busy PC, so upper bounds: 0.7 s to the empty window, 2.6 s to a document's
title, about 590 MB (Pss, all processes) with two small documents, and about 220 MB more for a second window.

Done on `feat/pdf-desktop-windows`:

- [x] **Several windows.** Document menu › Open in new window (and the command palette) moves a document with its
  unsaved changes, undo history, page and zoom to a window of its own; Ctrl+Shift+N opens an empty one. Each window has
  its own workspace record (`doc-<id>`, the main window keeps `default`). A window that loses its last document stays
  empty, as in VS Code.
- [x] **Second launch and file association.** A file that is open is shown in its window, a new one opens in the
  window used last; events go to that window only.
- [x] **Crash recovery per window.** After a crash every window comes back with its unsaved changes; an empty main
  window takes over the first one.
- [x] **Close question per window** (Save, Don't save, Cancel), Ctrl+Q for the whole app. Rust decides, so a window whose
  page hangs still closes after 3 s; its workspace is restored on the next start.
- [x] **Window position and size** per window, with the check that the place is still on a monitor. Own small
  implementation in `windows.rs` (the window-state plugin writes on exit only, so a crash would lose the position, and it
  keeps dynamic labels forever).
- [x] **Save writes to the original file** without a dialog, atomically (fsync, rename, permissions kept). Not for
  documents whose opening repaired damage or removed protection: those ask.
- [x] **Changes from outside.** Polling every 3 s and on focus, also on network drives. Clean documents reload at their
  page, documents with unsaved changes ask, Save over a changed file asks, a vanished file shows a notice.
- [x] **Recent files** in the document menu, stored by the app. Paths of the last run stay usable after a restart.
- [x] **Native open dialog** (paths known; a file open in another window is shown there), dialogs parented to their
  window.
- [x] **Drops from other programs.** The native drop arrives with paths and is replayed as a DOM drop at the same place.
  Before, nothing listened for it: Tauri takes file drops away from the DOM.
- [x] **Keys:** Ctrl+W (document, then window), Ctrl+Shift+W, Ctrl+Q, Ctrl+Tab, Ctrl+Shift+N, F11; F5 and Ctrl+R do
  nothing. **WebView menu** gone outside text fields and selections. Appearance follows into the other windows.
- [x] **Several files on the command line.** Only the last one opened: each load cancelled the one before.

Open:

- [ ] **Move a document into an existing window, drag between windows.** Today the move only makes a new window, and
  closing a detached window does not bring the document back. Foxit and VS Code drag tabs out and between windows; Figma has a
  cross-window tab menu. Needs a live "adopt" in the target window (the record move exists) and a real tab strip for
  dragging; the islands chrome has only the dropdown. 3–5 PD, with a tab strip 6–10 PD.
- [ ] **Open in new window for a document that is not shown** opens at page 1: the editor keeps one page and zoom per
  window, not per document. Per-document view state fixes this and tab switches too. Editor core, Fernwork. 1–2 PD.
- [ ] **IPC speed for large files.** `read_file` moves about 15 MB/s under WebKitGTK (157 MB took 10 s, measured at
  `nice 19` on a busy PC, so an upper bound); a plain asset fetch over the app protocol is no faster. Opening large files is
  dominated by this. Measure on an idle machine and under WebView2; a file input or a dedicated URI scheme with streaming may
  beat it. 1–3 PD.
- [ ] **Undo across a reload from disk** is gone: the reload replaces the document. It only happens to clean documents or
  after asking. 2–3 PD if a restore point of the old file is wanted.
- [ ] **WebView2 browser keys.** Windows has what WebKitGTK does not: F5, Ctrl+R, Ctrl+G/H/J/L/U, F12, Print, zoom. Set
  `AreBrowserAcceleratorKeysEnabled=false` (through `tauri-plugin-prevent-default` or the webview handle), keep our own
  handlers. Not testable here. 0.5–1 PD with the Windows build.
- [ ] **macOS file associations.** Files arrive as `RunEvent::Opened`, not in argv; nothing handles it yet, so "Open with"
  would do nothing. Also Cmd+Q ends the app without a close request. 1–2 PD with the macOS build.
- [ ] **Quit on logout or shutdown** is not handled: windows just end, and the workspaces come back on the next start
  without a question. Check on Windows (`WM_QUERYENDSESSION`) and macOS. 1 PD.
- [ ] **Tear down a dead WebView.** A crashed web process leaves a blank window; offer a reload (wry has no hook in
  Tauri yet, check `WebProcessTerminated` on GTK and `ProcessFailed` on WebView2). Unsaved work is safe. 1–2 PD.
- [ ] **Drag out** (page or selection as a file into Explorer or a mail): `tauri-plugin-drag` 2.1 with a temporary file;
  promises only on macOS. 2–4 PD.
- [ ] **Drop feedback.** A native drag sends no DOM `dragover`, so the "Drop to open" overlay and the page highlight stay
  dark. Drive them from Tauri's enter/over/leave events. 0.5 PD.
- [ ] **Native menu bar** deliberately not on Windows and Linux (own title bar, palette). macOS needs a menu anyway
  (Edit for Cmd+C/V, Window, Quit). 1–2 PD with the macOS build.
- [ ] **Screen reader names of the title bar buttons** stay English/German by locale, the editor English only; see German
  user interface.
- [ ] **Shared native file watcher.** Polling is simple and works on SMB. `notify` would make local changes instant (with a
  stamp check on top, because of atomic saves). Only if 3 s turns out too slow. 1 PD.
- [ ] **Saving does not keep hard links or a file's owner:** it replaces the file. Fine for almost everything; Word and
  VS Code offer both ways. Fall back to writing in place for hard links. 0.5 PD.
- [ ] **WASM threads.** `crossOriginIsolated` is true, but WebKitGTK has no `SharedArrayBuffer`: the same in every window
  and before this work. The worker runs without; check whether `JSC_useSharedArrayBuffer=1` is safe if threads are wanted.
- [ ] **Web tabs still share one workspace record.** Two tabs of the web app overwrite each other's `default` record (the
  writer lease protects the journal, not the list). Give each tab an id too; but a tab has no stable label. 1–2 PD.

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
- [x] **Harness check:** `doc.encrypt` passed `{print, copy, …}` while the shell reads `noPrint`/`noCopy`/…, so no
  restriction was ever set. Fixed, and the corpus now checks the saved permissions with `qpdf --show-encryption`
  (`qpdf.permissions`).
- [x] **Open file X at page Y** from scripts and other apps: `bergwork-pdf plan.pdf --page 5` (`--page=5`, or before
  the file) and `plan.pdf#page=5` as in PDF open parameters; also for a second launch into the running app.
  **No custom URL scheme** (`bergwork-pdf://…`): any web page could then make the app open local paths, and the
  command line covers scripts and other apps. Revisit only with a concrete need (e.g. links from berg:work web).

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
