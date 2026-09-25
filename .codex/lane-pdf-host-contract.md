# Lane: host contract for the PDF editor (design only, no code changes)

You work for berg:work, the Tauri spin-off of Fernwork's PDF editor. Write in English.

## Context

- Fernwork repo (read-only for you): `/home/oem/Dokumente/003_Projekte/17_fernwork`. Another session has uncommitted
  work there. Do not edit, stage, stash or commit anything in it.
- The PDF editor source: `vendor/build/src/pdf-tools-shell.jsx` (~37k lines), `vendor/build/src/pdf-editor/**`,
  `vendor/build/src/pdfium-worker.js`, build in `vendor/build/build.mjs`, page loader `tools/js/pdf-tools-shell.js`
  (calls `bundle.mount(element)`). The committed bundle is `tools/vendor/pdf-tools/oo-pdf-tools.js`.
- berg:work pins that bundle (`/home/oem/Dokumente/003_Projekte/21_bergwork/upstream.lock.json`,
  `docs/ARCHITECTURE.md`). berg:work never edits editor code; everything platform-specific goes through a host
  object that the editor receives at mount time. Fernwork's browser behaviour must stay identical.
- Model to follow: the image editor already has such a contract. Read
  `/home/oem/.local/share/fernwork-compositor-lab/workspaces/claude/src/platform/hosts/types.ts` and `index.ts`
  (versioned capabilities, `getCapability`/`hasCapability`, legacy adapter) and `src/platform/browserHost.ts`.
- Targets: Tauri 2 desktop (Windows WebView2, Linux WebKitGTK), Tauri 2 Android on Googlebooks (Android WebView,
  Storage Access Framework `content://` URIs, intent filters for `application/pdf`). Native OCR and ONNX models
  are bundled there instead of downloaded.
- Googlebook desktop quality guidelines to map: File_Handlers, File_Picker, File_Management_Basics,
  Printing_Support, Multi-Instance, Drag_Drop_Support, Drag_Drop_Batch, Keyboard_Parity, Custom_Cursors,
  Offline_Support (https://developer.android.com/docs/quality-guidelines/adaptive-app-quality/experiences/desktop).

## Task

1. Inventory every platform touchpoint of the PDF editor with `file:line`, current behaviour and why it matters
   outside a browser tab. At least: file open (input, drop, paste, `launchQueue`), save and save-as
   (`showSaveFilePicker`, download anchors, the save coordinator in `pdf-editor/persistence`), session storage
   (IndexedDB, `tools/js/pdf-tools-shell.js`), absolute asset URLs (`/tools/vendor/...` for pdfium, qpdf,
   fallback fonts, pdf-runtime cmaps/standard fonts, `pdf-editor/ocr/runtime.js` with `OCR_ASSET_ROOT`), workers
   and WASM loading, OCR engine and language data, fonts (system/local fonts), digital signatures and
   certificates (`tools/js/pdf-digital-signature.js` if used by the bundle), clipboard, printing, window title and
   unsaved-changes prompts, external links, network requests, imports from Fernwork's `assets/` (toast, icons,
   utils, file-paste).
2. Propose the contract: `mount(element, { host })` with a default browser host that reproduces today's
   behaviour exactly. Give TypeScript-style interface definitions per capability (versioned like the image
   editor), which capabilities are required vs optional, and the fallback for each. Reuse the image editor's
   shapes where they fit (`FileSystemHost`, `ModelHost`, `ComputeHost`, `FontHost`) so one Tauri host can serve
   both editors; name differences explicitly.
3. Migration plan in small steps that can each land in Fernwork on their own with unchanged browser behaviour:
   what moves, which existing tests guard it (look in `test/unit/pdf-editor/` and `test/e2e/`), which new
   contract tests are needed. Order the steps by value for berg:work: asset base and OCR first, then file
   open/save and file handlers, then the rest.
4. List open questions for the owner.

## Output

Write the document to `/home/oem/Dokumente/003_Projekte/21_bergwork/docs/PDF-HOST-CONTRACT.md`. Do not touch any
other file in either repo. Do not run git commands that change state. Finish with a short summary of the
document in your last message.
