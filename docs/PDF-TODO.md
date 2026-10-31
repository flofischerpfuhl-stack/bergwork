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

## Next

- [ ] **Top priority: run the full UI matrix** (`npm run test:ui-matrix:full -w @bergwork/pdf`, up to 10 h). Florian,
  2026-10-31: after the Fernwork integration work pauses to save the Claude limit; this comes first when it resumes.
  The quick run on 2026-10-31 passed with 975 results and no failures, but left 43 cells unrun. Run it as its own unit on
  a free machine; fix what it finds before anything else on this list.
- [ ] **Style chains on Base-14 text fail (Florian, 2026-10-31, sample PDF).** Underline then Italic, Underline then
  Helvetica, part of a word bold then Underline or Helvetica, Underline then Strikethrough then Bold on "North":
  "Color-only editing requires…", "Font file registered, but Liberation Sans … could not be applied", "Base-14 character
  styles require…"; Florian also saw "Rich-text command text must equal…" (not reproduced yet). The full matrix (2 of its
  53 failures) shows the Base-14 message. The other failures: 50 on turned text on a page turned in the editor ("editing
  paused", Undo fails), 1 selection frame 108 px off turned form text.
- [ ] **A test that looks for failures instead of cases (Florian, 2026-10-31: no test fitted to one report).** The matrix
  undoes after each control, so two actions on one object never meet, and the sample PDF is no profile. Random walks of
  actions over objects and files, from a seed, steered to ordered pairs of actions not yet run, with oracles that know no
  scenario: no error toast or console error, Undo and Redo return the same pixels at every step, the model's text stays
  the text on the page, saved and reopened equals the screen. A failing walk shrinks by itself to the shortest sequence
  and becomes a seed to replay. Below the UI the same walks run against the command layer, thousands per minute (random
  rich documents through `createPdfCommand`). A new line in the report: every `throw` in the editor reached and not
  reached; an internal invariant shown to a user as a toast is a failure of its own. Fix the found family first with this
  test red, not with a test for "North".
- [ ] **Edit path bar at the object (Florian, 2026-10-31).** "Edit path" sits below the object and can only be reached by
  zooming out, with Done. It belongs at the object and in the window like the mini toolbar, which itself should go away
  while points are edited.
- [ ] **Take the fixes back from Fernwork** (branch `feat/pdf-adopt-bergwork-ui`, `5d592bdd`, on the next PDF sync). The
  OCR panel crashed without a document (`#ocr`); the islands ran out of the window below about 1,100 px; a handle at the
  page edge deselected; touch handles covered the middle of small objects; rotate zones of multi-selection members took
  clicks; Keep proportions stayed live during a commit; Underline stayed locked after an embedded font changed to
  Helvetica. The port renamed files and the annotation marks (`fernwork-…`, `bergwork-…`): without an adjustment neither
  product treats the other's measures and stamps as its own.

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

## Found by the UI matrix (2026-10-30, `apps/pdf/tests/ui-matrix/`)

Fixed on `fix/pdf-text-edit-matrix` (the worker parts on Fernwork's branch of the same name, live with the next pin):
Justify, hidden on an older worker; the editor and selection of turned text; rich frames edit on the page; a turned
shaped frame keeps its angle when retyped; the underline sits below the baseline; the line a Word PDF draws under a text
moves and turns with it; text on a page rotated in the editor can be edited; a line after a bold run in a Word table can
be edited; Undo of frame edits, of a first annotation turn and of the Fill and Stroke toggles; the crash when an image was
deleted; Ctrl+Z with the focus on a checkbox or slider; Fill and Stroke cannot both go off.

Open:

- [ ] **The separate underline follows only on the drop.** While a text is dragged or turned its Word underline stays
  behind and jumps along at the end. It needs the drag composition overlay to carry a second object. 1 PD.
- [ ] **Deleting a text leaves its separate underline.** The move and turn commands carry it; a delete would need the
  snapshot inverse and a decision about a line that two texts share. 0.5 PD.
- [ ] **Underline does not know the separate line.** Pressing it on a Word heading draws a second line next to the path.
  The button could read as on and remove the path. 1 PD.
- [ ] **Fields stay blocked while a commit lands.** Buttons and checkboxes pressed in that second are pressed afterwards;
  a number typed then is lost. Queueing Inspector gestures like page gestures needs the rich editor's baseline to follow
  the queue. 2 PD.
- [ ] **Undo of an angle on a moved image** leaves the anti-aliased edge pixels of the image different (a one-pixel
  perimeter, the image itself is identical). Partial repaint against full render. 0.5 PD.
- [ ] **The mini toolbar stays away after Properties closes.** It returns with the next selection, not with the panel
  closing over a selected object. 0.5 PD.
- [ ] **UI matrix: more surfaces.** Context menu, multi-selection and the left tool panels are not driven yet. 2 PD.
- [ ] **A retyped line that wraps lands on the next line.** A heading stored as separate lines: a word typed at the end
  of the first wraps inside its own frame and sits on top of the second (`Bezügebeispiele.pdf`, title). The lines of a
  paragraph are not one block, Acrobat reflows them. Fernwork `text-layout`. 2 PD.
- [ ] **Edits on a dense page take 6-7 s.** `pdfjs/bug1978317.pdf` (one page, 1.5 MB, below the corpus's page weight)
  took that per command in the harness; the cause is not measured yet, the UI may differ. `text.rotate` has twice the
  step limit since, so the corpus no longer shows it. 1 PD to measure.


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

## PowerPoint parity (Florian, 2026-10-30; not started)

Goal: a presentation can be created directly in the editor, with everything that belongs to it and makes sense in a
PDF. No animations or transitions. Compare with PowerPoint, Canva and Keynote before scoping; estimates are still open.

- [ ] **Basic image editing:** crop, rotate, flip, brightness, contrast, saturation, corners, border, shadow, remove
  background, on placed images and on images in the PDF.
- [ ] **Tables:** insert, edit cells, add and remove rows and columns, merge cells, styles; also edit existing tables.
- [ ] **Shape library:** many more shapes (arrows, callouts, stars, flowchart, brackets), connectors that stay attached,
  text inside shapes, fill and line styles.
- [ ] **Slides from scratch:** new presentation with page size (16:9, 4:3, A4), slide layouts and templates, master
  page, placeholders, themes (colours, fonts) applied to all slides, slide numbers, reorder and duplicate.
- [ ] **Text for slides:** bullet and numbered lists, levels, columns, text fit, styles.
- [ ] **Layout:** align and distribute, group, snapping to a slide grid, consistent spacing.
- [ ] **Charts and media that make sense in a PDF:** charts from a small data table, icons, picture placeholders.
- [ ] **Present mode:** full screen, next and previous, presenter notes, pointer and drawing, second screen (desktop).
- [ ] **Import and export:** open PPTX as editable slides where possible, export to PDF stays the native format.

## Best-in-class 3D PDF (Florian, 2026-10-30; not started)

Goal: full 3D PDF support, best in class. Compare with Adobe Acrobat first. The engine part belongs in Fernwork.

- [ ] **View:** U3D and PRC in 3D annotations and page-embedded models, with views, orbit, pan, zoom, section planes,
  render modes, lighting, product structure tree, measure in 3D, cross sections, performance on big models.
- [ ] **Create and edit:** insert 3D models (STEP, IFC, glTF, OBJ, STL) as 3D annotations, define views, poster images,
  activation settings; keep existing 3D data intact through every edit and save.
- [ ] **Compatibility and safety:** round trip with Acrobat, JavaScript in 3D annotations stays off or sandboxed,
  printing and export use a correct poster, CLI and MCP access to models and views.

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

Mobile research with sources, comparison of the technology paths and order: `docs/PDF-MOBILE-VORTEILE.md`. In short: a
real iOS/iPadOS app on Tauri, iPad first; Android stays a TWA until that app exists; no native PDFium for now. No store
submission before the legal review in `docs/ARCHITECTURE.md`.

Web first, useful on every platform:
- [ ] **Ask for persistent storage.** Nothing calls `navigator.storage.persist()`, so drafts and the journal are
  best-effort in every browser. WebKit grants it by heuristics such as a Home Screen install. Host page. 0.5 PD.
- [ ] **Pen input.** The editor treats a pen as a mouse: no `pressure`, tilt or coalesced and predicted events, all
  available in Chrome and Safari 18.2+. Pen draws, finger scrolls; filled pressure strokes. Judge the result on an iPad
  before starting native ink. 3–5 PD.
- [ ] **Save on an iOS Home Screen app.** Standalone blob downloads are reported to fail silently and `window.print`
  to be unreliable. Use `navigator.share` with the file, which the editor does not call yet. Check on a device. 1 PD.
- [ ] **Add a page from the camera.** `<input capture>` into Add pages; perspective correction is open under OCR.
  0.5–1 PD.
- [ ] **Device checks.** Android Chrome: `showSaveFilePicker` (Chrome 132 and MDN say yes, caniuse says no), and
  `file_handlers` launches in a WebAPK or TWA. iOS: `persist()`, Scribble in the editor's `textarea`. Test PDFgear on
  both as the free benchmark. 1 PD.

Apps:
- [ ] **Android: Trusted Web Activity on Play** (Bubblewrap). The PWA runs in Chrome with the unchanged engine. Bubblewrap
  has `shareTarget` and `fileHandlers` fields; check them on a device, also with Samsung Internet as default browser.
  New personal Play accounts need a closed test first (12 testers, 14 days). 3–5 PD.
- [ ] **iOS and iPadOS app on Tauri.** Start with a 3 PD spike (open in place, save, print, a 100-page session in
  WKWebView); if it fails, use Capacitor with the same web bundle. No SharedArrayBuffer needed. Real limit:
  WebContent is killed near 2 GB. 25–40 PD in all:
  - Document types, open in place, security scope and file coordination behind the `showSaveFilePicker` shim, share
    extension, "Always Open With" (iOS 26).
  - AirPrint through `PrintHost`, lifecycle flush, keyboard commands, iPadOS menu bar.
  - Drop Liberation Sans Narrow (GPL-2.0 with font exception) from the iOS bundle or clear it in the legal review.
- [ ] **Scanner on iOS.** VisionKit camera, `RecognizeDocumentsRequest` for OCR with tables, Tesseract as fallback.
  3–5 PD.
- [ ] **Native ink on iPad.** PencilKit overlay during a stroke, then `/Ink` through the engine; double tap, squeeze,
  hover. Only if web ink falls short. 10–15 PD.
- [ ] **Android app on Tauri for Googlebooks** (as planned in `docs/ARCHITECTURE.md`), replacing the TWA with the same
  package name and key.
  - PDFium, qpdf, HarfBuzz and Tesseract are already single-threaded, so the WebView needs neither cross-origin
    isolation nor new builds. If that changes: WebView 156 and androidx.webkit 1.18.0 offer
    `Profile#setCrossOriginIsolatedAllowlist` with `Document-Isolation-Policy`.
  - Intent filters for `application/pdf` with `content://` URIs; save back only with write access, otherwise
    `ACTION_CREATE_DOCUMENT`.
  - ML Kit document scanner, Jetpack Ink, `PrintManager`, Google's desktop quality list.
  - Play: target API 36, 16 KB page size for the native libraries.

  22–39 PD, plus the touch work in the Fernwork TODO.
- [ ] **Native PDFium: decide by measurement.** It would not fix commit latency (snapshot round trip, not WASM speed).
  It would help with files WASM cannot hold (2 GB cap, whole file in memory). Measure on devices after the iOS app,
  2 PD; a port costs 40–80 PD.
- [ ] **Store presence on phones.** Free mobile apps view and annotate. Editing existing content is paywalled (Adobe,
  Xodo, Foxit, PDF Expert). PDFgear is the exception: reported free with text and image editing on mobile, to be tested.
  Editing vector paths is offered nowhere we know of. The store listing is what makes that lead visible.
  - **Order:** ship only after the touch pass in the Fernwork TODO (taps hit the page background, results lag after
    release). Otherwise store reviews judge the rough edges, not the lead.

## PDFgear parity

Goal (Florian, 2026-10-30): match PDFgear wherever it is ahead. Evidence, table and sources: `PDF-PDFGEAR-PARITY.md`.
PDFgear was not run, so every entry rests on its documentation or on third parties; the checks below come first where
it matters.

Each entry gives the benefit, the effort in PD and the owner: **fork** (`apps/pdf/editor`), **host** (`apps/pdf/web`,
`src-tauri`), **Fernwork** (engine or worker; add it to Fernwork's TODO too). Steps are the order; within a step, top to
bottom. **[Privacy]** touches the promise that files are not uploaded. New panels and menu entries need Florian's OK as
usual, and follow the no-help-text rule.

Check first:

- [ ] **Run PDFgear on real devices.** Text quality on hard PDFs, paths, network capture on mobile, timings, Word output,
  merge with forms, signature format, redaction (`PDF-PDFGEAR-PARITY.md`, section 8). Decides how much of the rest is
  urgent. Benefit high. 1–2 PD, one online session on the Windows PC and a phone each.

Step 1: small gaps, no decision needed. About 30–50 PD together.

- [~] **Image to PDF, HEIC.** `fix/pdf-image-input`, waits for its Fernwork commit and mirror tag. Benefit high. 0.5 PD. Fork.
- [ ] **Export pages as PNG or JPEG.** Range, dpi, quality, one zip; the engine renders this already (CLI `render`).
  Benefit high. 1–2 PD. Fork.
- [ ] **Extract text** to TXT or the clipboard in Pages or the palette; `extractTextForDoc` exists for Compare. Benefit
  medium. 0.5 PD. Fork.
- [ ] **Two-page view** with an optional separate cover, also what PDFgear's iOS users miss. Benefit high. 3–5 PD. Fork.
- [ ] **Slide show.** Full screen, one page, arrows. Second screen later (`PDF-DESKTOP-VORTEILE.md`). Benefit medium.
  1–2 PD. Fork.
- [ ] **Page colours for reading** (night, sepia), view only, never in the file. Benefit medium. 1 PD. Fork.
- [ ] **Read aloud.** Selection or page through `speechSynthesis`. **[Privacy]** Only voices with `localService`: browsers
  also offer remote voices, which would send the text out. Benefit medium. 2–3 PD. Fork.
- [ ] **Several OCR languages in one run** (`deu+eng`; already open under OCR). Benefit high for mixed documents. 1–2 PD. Fork.
- [ ] **Create and edit links.** To a page or URL, with an outline on the page. Benefit medium. 3–5 PD. Fernwork for
  native annotation commands, a pdf-lib snapshot in the fork as the first step.
- [ ] **Attachments.** List, save, add, remove. Benefit medium. 2–3 PD. Fork, pdf-lib snapshot.
- [ ] **N-up.** Several pages on one sheet as a new PDF, then print. Benefit low to medium. 2–3 PD. Fork.
- [ ] **Tick and cross marks** for flat forms. Benefit medium. 0.5 PD. Fork.
- [ ] **Same signature on several pages** (all, odd, even, range). Benefit medium. 1 PD. Fork.
- [ ] **Stamp library.** Existing entry under measuring and comments. Benefit low to medium. 2 PD. Fork.
- [ ] **Remove a watermark** added here, after the Undo history is gone: mark stamps in the content stream. Benefit low.
  2–3 PD. Fork, with a Fernwork check.
- [ ] **Batch.** Add OCR, page numbers, password, image export; folders in the app (`PDF-DESKTOP-VORTEILE.md`, 3–5 PD).
  Benefit medium. 3–5 PD. Fork, host.
- [ ] **Tab strip** instead of the dropdown, as in PDFgear 3.0. Same entry as the tab strip under the desktop audit on
  `feat/pdf-desktop-windows`. Benefit medium. 6–10 PD with dragging, 2–3 PD without. **Needs OK.** Fork.

Step 2: reach. Existing entries; only the order is new.

- [ ] **German user interface,** then the other nine of PDFgear's languages. Benefit very high in Germany: the strongest
  gap for the effort. 5–10 PD (existing entry) plus about 1 PD per language. Fernwork catalogue, then fork and host.
- [ ] **Windows and macOS.** Builds, signing, updates, release CI, default app: the entries under Desktop apps. Benefit
  very high. About 25–40 PD. Host.
- [ ] **Touch check on real devices,** then the **Android TWA**, then the **iOS app**: see `PDF-MOBILE-VORTEILE.md`. Touch
  is built in the fork (two-finger scale and turn, larger handles, long press to reorder pages, toolbar docked at the
  bottom, tap beside the page deselects) but only tested headless. Fix what a phone and an iPad show; that is smaller
  than the 10–20 PD estimated before these changes.
  Benefit very high. 10–20, 3–5 and 25–40 PD. Fernwork, then host. Legal review first (`ARCHITECTURE.md`).
- [ ] **Scanner.** SANE, WIA, TWAIN in the app, camera scan on phones. Benefit medium to high. 10–20 PD desktop
  (`PDF-DESKTOP-VORTEILE.md`), 3–5 PD iOS. Host.
- [ ] **Printing.** Direct print, batch print: existing entries. Benefit medium. 3–6 PD per OS. Host.
- [ ] **Speed.** Commit latency and parallel workers, already planned in Fernwork. No evidence that PDFgear is faster at
  edits, so judge it after the check above. Benefit high in any case. 15–30 and 5–10 PD. Fernwork.
- [ ] **Merge PDFs with forms or tags.** The engine refuses them. Unknown at PDFgear, a weakness regardless. Benefit high.
  5–10 PD. Fernwork.

Step 3: conversion, on the device only. About 55–85 PD.

- [ ] **PDF to Word, keeping the layout.** Positioned frames from PDFium inspection and block detection, DOCX through JSZip.
  This is what PDFgear's staff describe as their own method. Corpus check in Word and LibreOffice. Benefit very high.
  8–12 PD. Fork, new file.
- [ ] **PDF to Word, flowing.** Paragraphs, headings, lists, tables from rules and alignment, headers and footers. Shares its
  analysis with semantic paragraphs in Fernwork. Benefit high. 15–25 PD. Fernwork for the analysis, fork for the writer.
- [ ] **Scanned PDF to Word** from Tesseract's layout. Benefit medium to high. 3–5 PD. Fork.
- [ ] **PDF to Excel.** Table detection from the step above, one sheet per table or page. Benefit high. 8–12 PD. Fork.
- [ ] **PDF to PowerPoint.** One slide per page with positioned objects. Benefit low to medium. 4–6 PD. Fork.
- [ ] **Office to PDF, spike.** Measure a LibreOffice WASM build (ZetaOffice: size, memory, fonts, licence) on the same
  documents as desktop LibreOffice. Fernwork's Mammoth and html2pdf route is not good enough. Benefit high. 3 PD.
- [ ] **Office to PDF, desktop** through an installed LibreOffice: the existing entry. It corrects "not feasible in the
  browser": that holds for this direction only. Benefit high. 3–5 PD. Host.
- [ ] **Office to PDF, web,** if the spike allows it. Benefit medium to high. 8–15 PD. Fork, loaded on demand.
- [ ] **Batch conversion** once one converter exists. Benefit medium. 2 PD. Fork.

Step 4: AI, decided by Florian on 2026-10-30. **AI in the app's UI works exclusively like T3 Code: the app uses the agent
harnesses already installed on the machine.** No model of our own, no cloud service of ours, no API keys in the app, no
bundled or downloaded local model. This replaces the earlier plan here (Bergamot translation, Chrome built-in AI, a local
model, system models on phones) and the cloud-AI question; those entries are dropped.

- [ ] **Agent panel in the desktop app.** Finds installed harnesses (Claude Code, Codex and others), starts them locally
  with the user's own login and subscription, and shows one conversation with streaming, tool calls and permission
  questions: T3 Code's model of adapting each harness's event stream to one interface. Reuse what HimmelCAD Assembler
  already has (`packages/@himmelcad/agent` for discovery and stream normalising, `apps/assembler/electron/assistantHost.ts`,
  `assembler/AGENT-ASSISTANT.md`): find Claude Code, Codex and OpenCode on `PATH`, spawn without a shell, one run per
  turn, no credentials stored. Host.
- [ ] **Agent panel in the web app, through a local bridge,** as Assembler does. The page starts nothing itself: a small
  bridge on `127.0.0.1`, started by the user or the desktop app, runs the harness (`assistantBridge.ts`: origin allowlist,
  Host check against DNS rebinding, one-time pairing code, bearer token, loopback only, Private Network Access header).
  Needs `connect-src http://127.0.0.1:<port>` in the web CSP, changes the "no external requests" gate and `CLAIMS.md`.
  Safari with HTTPS to loopback is unverified. Fork, host.
- [ ] **The agent works on the open document.** Today `bergwork-pdf-cli mcp` runs its own headless page on files, not
  on what the user sees. The app needs an MCP endpoint into the running window: read pages, selection and comments,
  apply edits as normal transactions with Undo, show what the agent changes. Prepared: the CLI and MCP tools. Missing:
  this connection and all of the UI. Host, fork.
- [ ] **Features on top,** all through the harness: ask about the PDF, summarise, translate (including a translated
  copy, which needs semantic paragraphs), review, fill forms.
- [ ] **[Privacy] Be exact about the promise.** berg:work uploads nothing, but a harness sends what it reads to the
  user's own model provider. Show that in the panel, start nothing without a user action, and word the privacy page
  accordingly.
- [ ] **Microsoft Copilot for Windows offices (Florian, 2026-10-31; research only, nothing decided).** The audience has
  neither a harness nor another subscription. Findings of that day, each to be checked again before building:
  - Copilot Chat API: needs the paid Microsoft 365 Copilot licence, not the free Copilot Chat; preview on Graph beta; a
    GA "Work IQ" endpoint is reported by one blog only. Context comes from OneDrive and SharePoint; no action skills.
    Good for questions about a document, not for edits. Cloud in the customer's tenant, so it needs an exception to the
    rule above. Try it on a real tenant first (sign-in, admin consent, limits on pasted text).
  - Windows on-device AI (Phi Silica, being replaced by Aion Instruct): no subscription and local, but Copilot+ PCs or
    a strong GPU with Developer Mode, experimental SDK, package identity. Small model: summarise and rewrite.
  - Windows On-device Agent Registry: our MCP server as an agent connector. Preview; no evidence yet that the Copilot
    app calls third-party connectors. Cheap to try once the desktop app has its MCP endpoint.
  - Declarative agents reach remote MCP servers only, which would mean uploading the PDF: no.
- [ ] **Palette with arguments** ("delete page 10", "rotate 3–5"). Rules, not AI, and must not be sold as AI. Benefit
  medium. 2–3 PD. Fork.

Decisions for Florian:

- [ ] **Commercial licence.** PDFgear is free for companies. Above three people berg:work needs a licence that has no price
  yet, which matters as soon as the apps ship.

Deliberately not matched (reasons in `PDF-PDFGEAR-PARITY.md`, section 7):

- **Upload-based conversion.** **[Privacy]** Cheap and good, and the end of the promise.
- **Signature requests through a server** (PDFgear's Secure eSign). **[Privacy]** Accounts, mail and document storage are
  a different product.
- **A count of 60 formats.** Word, Excel, PowerPoint and images are what people ask for.
- **Calling conversion "lossless".** It is not, at PDFgear either.
- **Browser extension.** The PWA covers it.
- **Own Windows printer driver.** Already rejected above.

## PDFCraft gaps

Gaps against PdfCraft (ArtCraft, https://getartcraft.com/apps/pdfcraft) that no other section here lists. Evidence, table and
sources: `PDF-PDFCRAFT-COMPARE.md`. PdfCraft was not installed, so these rest on its code and documents. About 50–80 PD together,
top to bottom in the proposed order. The larger gaps are already planned above: macOS and Windows builds, German UI.

PdfCraft is MIT or Apache-2.0, but **no code is taken without Florian's decision.** Owners as under *PDFgear parity*; new panels need
Florian's OK and follow the no-help-text rule. AI stays in Step 4, desktop work stays in berg:work.

- [ ] **PDF layers (optional content).** A panel to show and hide layers, view only, with their state kept on save. CAD plans depend
  on it. Benefit high. 3–5 PD. Fernwork for the render option, berg:work fork for the panel.
- [ ] **Multi-page TIFF as input.** New document and Add pages; 1-bit scans stay 1-bit. Benefit medium to high. 1–2 PD. berg:work fork.
- [ ] **Justified text when editing.** Today it becomes left-aligned, because the pinned worker has no justified layout. Benefit
  medium to high. 2–4 PD. Fernwork.
- [ ] **Remove hidden information.** One step for metadata, attachments, comments, hidden text and layers, scripts. Goes with
  redaction. Benefit medium to high. 2–3 PD. berg:work fork.
- [ ] **Signature check.** Certificate chain, a trust list of the user's, what changed after signing, open the signed revision. Today
  integrity and coverage only. Benefit medium to high. 3–5 PD. berg:work fork.
- [ ] **Accessibility check and alt text.** Checks with a report and jumps to the page, alt text for figures, title and language.
  PdfCraft has 32 rules. Demand grows with the EU accessibility rules. Benefit medium to high. 4–7 PD. berg:work fork, Fernwork for
  keeping tags through edits.
- [ ] **Redaction presets.** Word lists and patterns (e-mail, phone, IBAN) in the dialog, and a check that finds black boxes with
  text still under them. Regex is CLI-only here. Benefit medium. 2–3 PD. berg:work fork.
- [ ] **Extract embedded images.** Originals as files, JPEG unchanged, one zip. Benefit medium. 1 PD. berg:work fork.
- [ ] **Bookmarks from headings.** From tags or from text styles. Benefit medium. 2–3 PD. berg:work fork.
- [ ] **Measure snapping** to midpoints and intersections, inside Form XObjects too. Plans need it. Benefit medium. 1 PD. berg:work fork.
- [ ] **Load a font file** for editing, with embedding permissions respected. Installed fonts are the *System fonts* entry above.
  Benefit medium. 2–3 PD. Fernwork for embedding, berg:work fork for the UI.
- [ ] **More page tools.** Replace pages, reverse, page labels, booklet and poster on top of the N-up entry. Benefit medium. 3–4 PD.
  berg:work fork.
- [ ] **Forms: more field types and data.** List box, push button, signature and date fields, tab order, import and export of field
  data (FDF, XFDF, CSV). Benefit medium. 3–5 PD. berg:work fork.
- [ ] **Form calculations and formats.** Acrobat's number, date and sum functions first, written directly: our CSP has no
  `unsafe-eval`, so general scripts would need a WASM interpreter. Benefit medium. 5–8 PD. Fernwork.
- [ ] **Saved batch recipes.** Named, reusable step lists, as PdfCraft's Action Wizard. Extends the *Batch* entry. Benefit medium. 3–5
  PD. berg:work fork.
- [ ] **CLI and MCP breadth.** Comments, bookmarks, metadata and attachments as tools, a `--root` that confines all paths, a compact
  tool list. PdfCraft has 141+ tools. Separate from the agent on the open document in Step 4. Benefit medium. 2–4 PD. berg:work.
- [ ] **Compare report** as a PDF with counts and every change. Benefit low to medium. 1 PD. berg:work fork.
- [ ] **PDF to Markdown and HTML** on top of the flowing Word entry. Useful for agents. Benefit low to medium. 1–2 PD. berg:work fork.
- [ ] **Right-to-left text editing.** Arabic and Hebrew paragraphs, refused today; partial at PdfCraft. Benefit low to medium in
  Germany. 8–15 PD. Fernwork.
